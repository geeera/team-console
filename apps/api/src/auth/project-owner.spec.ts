import { env } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID, isProblemDetails, problemSlugOf } from '@shared/contracts';
import { ApiGitHub } from '../github';
import {
  OWNER,
  accessEnv,
  createSigningKey,
  fetchApi,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
} from '../testing/access-kit';
import { json, stubGitHub } from '../testing/github-kit';
import { seedAccountProject, seedMembership, seedSessionUser, seedUser } from '../testing/session-kit';
import { seedTrackerProject } from '../testing/tracker-kit';

// #482 security review item 6: the owner-grade project writes need the `owner` role in the project's account —
// `isOwnerIdentity` alone is not enough once the Access owner is linked (decision 3) to a user row that is merely a
// `member` of another account. Through the real auth seam: an Access JWT whose `sub` is linked to such a user.
// The bodies are valid where a route validates the body before it looks the project up.

const OWNER_ROUTES: readonly (readonly [string, string, unknown])[] = [
  ['PATCH', '/api/v1/projects/:slug', { displayName: 'Renamed' }],
  ['POST', '/api/v1/projects/:slug/archive', undefined],
  ['POST', '/api/v1/projects/:slug/team/pause', {}],
  ['POST', '/api/v1/projects/:slug/team/resume', {}],
  ['POST', '/api/v1/projects/:slug/runs', {}],
  ['POST', '/api/v1/projects/:slug/sprint/demo-date', { due: '2026-12-01', expectedDue: '2026-11-24' }],
  ['POST', '/api/v1/projects/:slug/sprint/next', { due: '2026-12-15', expectedCurrent: null }],
  ['PUT', '/api/v1/projects/:slug/notifications/snooze', { until: null, allowsUrgent: true }],
  ['DELETE', '/api/v1/projects/:slug/notifications/snooze', undefined],
  ['POST', '/api/v1/projects/:slug/answers/batch', {}],
  ['POST', '/api/v1/projects/:slug/issues/1/answer', {}],
  ['POST', '/api/v1/projects/:slug/issues/1/answer/lookup', {}],
  ['POST', '/api/v1/projects/:slug/issues/1/request', {}],
];

async function slugOf(response: Response): Promise<string | null> {
  if (!(response.headers.get('content-type') ?? '').includes('json')) {
    return null;
  }
  const body: unknown = await response.clone().json();
  return isProblemDetails(body) ? problemSlugOf(body.type) : null;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the owner-grade project writes need the owner role in the project’s account', () => {
  let memberAccount: { id: string; slug: string };

  async function asLinkedOwner(method: string, path: string, body?: unknown): Promise<Response> {
    const jwks = stubJwksServer();
    const teamDomain = uniqueTeamDomain();
    const key = await createSigningKey();
    jwks.set(teamDomain, { keys: [key.publicJwk] });
    const token = await signAccessToken(key, teamDomain, {
      claims: { email: OWNER },
      subject: 'linked-member-sub',
    });
    return fetchApi(path, accessEnv(teamDomain), {
      method,
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        'Sec-Fetch-Site': 'same-origin',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'Idempotency-Key': `po-${crypto.randomUUID()}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      github: new ApiGitHub({ fetch: stubGitHub(() => json(404, { message: 'Not Found' })).fetch }),
    });
  }

  beforeAll(async () => {
    const linked = await seedUser('linked');
    const other = await seedSessionUser('owner');
    await seedMembership(other.account.id, linked, 'member');
    await env.DB.prepare('UPDATE users SET access_subject = ?2 WHERE id = ?1')
      .bind(linked, 'linked-member-sub')
      .run();
    memberAccount = other.account;
  });

  it.each(OWNER_ROUTES)(
    '%s %s answers 403 account-owner-only on a project of an account it is a member of, writing nothing',
    async (method, pattern, body) => {
      const project = await seedAccountProject(memberAccount);
      const response = await asLinkedOwner(method, pattern.replace(':slug', project.slug), body);
      expect(response.status).toBe(403);
      expect(await slugOf(response)).toBe('account-owner-only');
      const row = await env.DB.prepare(
        'SELECT display_name, archived_at, snoozed_at FROM projects WHERE slug = ?1',
      )
        .bind(project.slug)
        .first();
      expect(row).toEqual({ display_name: project.slug, archived_at: null, snoozed_at: null });
    },
  );

  it.each(OWNER_ROUTES)(
    '%s %s is neither account-owner-only nor project-not-found on the owner account’s project',
    async (method, pattern, body) => {
      const project = await seedTrackerProject();
      const response = await asLinkedOwner(method, pattern.replace(':slug', project.slug), body);
      const slug = await slugOf(response);
      expect(slug).not.toBe('account-owner-only');
      expect(slug).not.toBe('project-not-found');
    },
  );

  it('keeps the owner account’s role for the linked Access owner (sanity)', async () => {
    const response = await asLinkedOwner('GET', `/api/v1/accounts/${OWNER_ACCOUNT_ID}/settings`);
    expect(response.status).toBe(200);
    const member = await asLinkedOwner('GET', `/api/v1/accounts/${memberAccount.id}/settings`);
    expect(member.status).toBe(403);
    expect(await slugOf(member)).toBe('account-owner-only');
  });
});
