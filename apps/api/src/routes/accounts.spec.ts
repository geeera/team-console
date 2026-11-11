import { env } from 'cloudflare:test';
import {
  OWNER_ACCOUNT_ID,
  isAccountDto,
  isAccountMemberDto,
  isAccountMembershipListDto,
  isAuditEventListDto,
  isProblemDetails,
  problemSlugOf,
  type AccountMembershipListDto,
} from '@shared/contracts';
import { AuditRepo } from '@worker/db';
import {
  seedMembership,
  seedSession,
  seedSessionUser,
  seedUser,
  sendAsSession,
  type SessionUser,
} from '../testing/session-kit';
import { jobActor, send, sendAsService } from '../testing/tracker-kit';

// `GET /api/v1/accounts/:id/{settings,members,audit}` (T-2, #466): owner-of-account only; a non-member is told the
// account does not exist (threat model C9: nothing behind an account is enumerable).

async function slugOf(response: Response): Promise<string | null> {
  const body: unknown = await response.clone().json();
  return isProblemDetails(body) ? problemSlugOf(body.type) : null;
}

const ROUTES = ['settings', 'members', 'audit'] as const;

describe('GET /api/v1/accounts/:id/*', () => {
  let owner: SessionUser;
  let member: SessionUser;
  let stranger: SessionUser;

  beforeAll(async () => {
    owner = await seedSessionUser('owner');
    const memberUser = await seedUser('member');
    await seedMembership(owner.account.id, memberUser, 'member');
    member = { userId: memberUser, cookie: await seedSession(memberUser), account: owner.account };
    stranger = await seedSessionUser('owner');
    await new AuditRepo(env.DB).append({
      accountId: owner.account.id,
      at: '2026-11-10T01:00:00.000Z',
      actorKind: 'user',
      actor: owner.userId,
      kind: 'invite.created',
      target: 'invite-1',
      details: { role: 'member' },
    });
  });

  it('settings: the account with its entitlements, for its owner', async () => {
    const response = await sendAsSession(owner, 'GET', `/api/v1/accounts/${owner.account.id}/settings`);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(isAccountDto(body)).toBe(true);
    expect(body).toMatchObject({
      id: owner.account.id,
      slug: owner.account.slug,
      plan: 'free',
      entitlements: { maxProjects: 3, hostedRunner: false },
      suspendedAt: null,
    });
  });

  it('members: owners first, each with its login and role', async () => {
    const response = await sendAsSession(owner, 'GET', `/api/v1/accounts/${owner.account.id}/members`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { members: unknown[] };
    expect(body.members.every(isAccountMemberDto)).toBe(true);
    expect(body.members.map((row) => (row as { role: string }).role)).toEqual(['owner', 'member']);
  });

  it('audit: the account’s rows newest first, paged by cursor', async () => {
    const response = await sendAsSession(owner, 'GET', `/api/v1/accounts/${owner.account.id}/audit?limit=1`);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(isAuditEventListDto(body)).toBe(true);
    const page = body as { events: { kind: string; details: unknown }[]; nextCursor: number | null };
    expect(page.events.map((event) => event.kind)).toEqual(['invite.created']);
    expect(page.events[0]?.details).toEqual({ role: 'member' });
    expect(page.nextCursor).toBeNull();
  });

  it('audit: refuses a cursor or a limit that is not a number', async () => {
    for (const query of ['?before=x', '?limit=0', '?limit=1000']) {
      const response = await sendAsSession(
        owner,
        'GET',
        `/api/v1/accounts/${owner.account.id}/audit${query}`,
      );
      expect(response.status).toBe(400);
      expect(await slugOf(response)).toBe('query-invalid');
    }
  });

  it.each(ROUTES)('%s: a member of the account is refused with 403 account-owner-only', async (route) => {
    const response = await sendAsSession(member, 'GET', `/api/v1/accounts/${owner.account.id}/${route}`);
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('account-owner-only');
  });

  it.each(ROUTES)('%s: an owner of another account is told the account does not exist', async (route) => {
    const crossAccount = await sendAsSession(
      stranger,
      'GET',
      `/api/v1/accounts/${owner.account.id}/${route}`,
    );
    const unknown = await sendAsSession(
      stranger,
      'GET',
      `/api/v1/accounts/01M6YSNJ00000000000000N0PE/${route}`,
    );
    const malformed = await sendAsSession(stranger, 'GET', `/api/v1/accounts/not-an-id/${route}`);
    for (const response of [crossAccount, unknown, malformed]) {
      expect(response.status).toBe(404);
      expect(await slugOf(response)).toBe('account-not-found');
    }
    expect(await crossAccount.text()).not.toContain(owner.account.slug);
  });

  it.each(ROUTES)('%s: the service identity is no member of any account', async (route) => {
    const response = await sendAsService('GET', `/api/v1/accounts/${OWNER_ACCOUNT_ID}/${route}`);
    expect(response.status).toBe(404);
    expect(await slugOf(response)).toBe('account-not-found');
  });

  it.each(ROUTES)('%s: the environment owner owns the owner account by construction', async (route) => {
    const response = await send('GET', `/api/v1/accounts/${OWNER_ACCOUNT_ID}/${route}`);
    expect(response.status).toBe(200);
    expect(
      await sendAsSession(owner, 'GET', `/api/v1/accounts/${OWNER_ACCOUNT_ID}/${route}`).then(
        (r) => r.status,
      ),
    ).toBe(404);
  });
});

// #464: Settings › Runners finds the accounts it may address from the caller's memberships alone.
describe('GET /api/v1/accounts', () => {
  it('lists a session user’s own memberships with the role in each, and no other account', async () => {
    const owner = await seedSessionUser('owner');
    const other = await seedSessionUser('owner');
    await seedMembership(other.account.id, owner.userId, 'member');
    const unrelated = await seedSessionUser('owner');

    const response = await sendAsSession(owner, 'GET', '/api/v1/accounts');
    expect(response.status).toBe(200);
    const text = await response.text();
    const body: unknown = JSON.parse(text);
    expect(isAccountMembershipListDto(body)).toBe(true);
    const { accounts } = body as AccountMembershipListDto;
    expect(accounts).toHaveLength(2);
    expect(accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: owner.account.id, slug: owner.account.slug, role: 'owner' }),
        expect.objectContaining({ id: other.account.id, role: 'member' }),
      ]),
    );
    expect(text).not.toContain(unrelated.account.id);
    expect(text).not.toContain(OWNER_ACCOUNT_ID);
  });

  it('gives the environment owner the owner account by construction', async () => {
    const response = await send('GET', '/api/v1/accounts');
    expect(response.status).toBe(200);
    expect(((await response.json()) as AccountMembershipListDto).accounts).toEqual([
      expect.objectContaining({ id: OWNER_ACCOUNT_ID, slug: 'owner', role: 'owner' }),
    ]);
  });

  it('names no account to the service identity, which is no member of any', async () => {
    const response = await sendAsService('GET', '/api/v1/accounts');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accounts: [] });
  });

  it('refuses a job before any account is read', async () => {
    const response = await send('GET', '/api/v1/accounts', undefined, { job: jobActor('pm') });
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('owner-only');
  });
});
