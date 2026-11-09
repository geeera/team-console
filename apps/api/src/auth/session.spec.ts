import { env } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID, isProblemDetails, problemSlugOf } from '@shared/contracts';
import {
  OWNER,
  accessEnv,
  createSigningKey,
  fetchApi,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
} from '../testing/access-kit';
import {
  seedAccountProject,
  seedMembership,
  seedSession,
  seedSessionUser,
  seedUser,
  sendAsSession,
} from '../testing/session-kit';
import { SESSION_COOKIE } from './session';

// #466 (ADR 0008 decision 3): the console's own session is a door of the auth seam. A live cookie names a user and
// its memberships, read from D1 per request; anything else grants nothing and the request goes on to Access.

async function slugOf(response: Response): Promise<string | null> {
  const body: unknown = await response.clone().json();
  return isProblemDetails(body) ? problemSlugOf(body.type) : null;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the session door', () => {
  it('admits a live session as a user of its memberships and logs the kind only', async () => {
    const user = await seedSessionUser('owner');
    const project = await seedAccountProject(user.account, { tracker: 'console' });
    const lines: string[] = [];

    const response = await sendAsSession(user, 'GET', `/api/v1/projects/${project.slug}/items`, undefined, {
      logSink: (line) => lines.push(line),
    });

    expect(response.status).toBe(200);
    const log = lines.join('\n');
    expect(log).toContain('"identity":"user"');
    expect(log).not.toContain(user.cookie);
    expect(log).not.toContain(user.userId);
  });

  it.each([
    ['malformed', 'not-a-session-id'],
    ['unknown', 'A'.repeat(43)],
  ])('grants nothing on a %s cookie and asks Access instead (401 access-missing)', async (_, cookie) => {
    const response = await sendAsSession({ cookie }, 'GET', '/api/v1/projects');
    expect(response.status).toBe(401);
    expect(await slugOf(response)).toBe('access-missing');
  });

  it('grants nothing on an expired or a revoked session', async () => {
    const userId = await seedUser('stale');
    const expired = await seedSession(userId, { expiresAt: '2020-01-01T00:00:00.000Z' });
    const revoked = await seedSession(userId, { revokedAt: '2026-11-10T00:00:00.000Z' });
    for (const cookie of [expired, revoked]) {
      const response = await sendAsSession({ cookie }, 'GET', '/api/v1/projects');
      expect(response.status).toBe(401);
    }
  });

  it('reads the memberships per request, so a role change takes effect at once', async () => {
    const user = await seedSessionUser('member');
    const path = `/api/v1/accounts/${user.account.id}/settings`;
    expect((await sendAsSession(user, 'GET', path)).status).toBe(403);
    await env.DB.prepare('UPDATE account_members SET role = ?3 WHERE account_id = ?1 AND user_id = ?2')
      .bind(user.account.id, user.userId, 'owner')
      .run();
    expect((await sendAsSession(user, 'GET', path)).status).toBe(200);
  });

  it('a session user is no member of the owner account by email or by anything else', async () => {
    const user = await seedSessionUser('owner');
    const response = await sendAsSession(user, 'GET', `/api/v1/accounts/${OWNER_ACCOUNT_ID}/settings`);
    expect(response.status).toBe(404);
  });

  it('a cookie-borne write still needs the same-origin rule (CSRF)', async () => {
    const user = await seedSessionUser('owner');
    const project = await seedAccountProject(user.account, { tracker: 'console' });
    const response = await fetchApi(`/api/v1/projects/${project.slug}/items`, accessEnv(uniqueTeamDomain()), {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE}=${user.cookie}`,
        'Sec-Fetch-Site': 'cross-site',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('csrf');
  });
});

describe('the Access owner', () => {
  async function asOwner(path: string, subject: string): Promise<Response> {
    const jwks = stubJwksServer();
    const teamDomain = uniqueTeamDomain();
    const key = await createSigningKey();
    jwks.set(teamDomain, { keys: [key.publicJwk] });
    const token = await signAccessToken(key, teamDomain, { claims: { email: OWNER }, subject });
    return fetchApi(path, accessEnv(teamDomain), { headers: { 'Cf-Access-Jwt-Assertion': token } });
  }

  it('owns the owner account by construction, before any link exists', async () => {
    const response = await asOwner(`/api/v1/accounts/${OWNER_ACCOUNT_ID}/settings`, 'unlinked-sub');
    expect(response.status).toBe(200);
  });

  it('gains the memberships of the user row its Access subject was explicitly linked to, never by email', async () => {
    const linked = await seedUser('linked');
    const account = (await seedSessionUser('owner')).account;
    await seedMembership(account.id, linked, 'owner');
    await env.DB.prepare('UPDATE users SET access_subject = ?2, email = ?3 WHERE id = ?1')
      .bind(linked, 'owner-sub-linked', OWNER)
      .run();
    const byEmailOnly = await seedUser('by-email');
    const emailAccount = (await seedSessionUser('owner')).account;
    await seedMembership(emailAccount.id, byEmailOnly, 'owner');
    await env.DB.prepare('UPDATE users SET email = ?2 WHERE id = ?1').bind(byEmailOnly, OWNER).run();

    expect((await asOwner(`/api/v1/accounts/${account.id}/settings`, 'owner-sub-linked')).status).toBe(200);
    expect((await asOwner(`/api/v1/accounts/${OWNER_ACCOUNT_ID}/settings`, 'owner-sub-linked')).status).toBe(
      200,
    );
    expect((await asOwner(`/api/v1/accounts/${emailAccount.id}/settings`, 'owner-sub-linked')).status).toBe(
      404,
    );
    expect((await asOwner(`/api/v1/accounts/${account.id}/settings`, 'some-other-sub')).status).toBe(404);
  });
});
