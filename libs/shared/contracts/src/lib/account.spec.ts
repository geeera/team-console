import {
  AUDIT_EVENT_KINDS,
  OWNER_ACCOUNT_ID,
  OWNER_ACCOUNT_SLUG,
  OWNER_USER_ID,
  PLAN_ENTITLEMENTS,
  entitlementsOf,
  isAccountDto,
  isAccountMemberDto,
  isAuditEventDto,
  isAuditEventKind,
  isAuditEventListDto,
  isEntitlementsOverride,
  isMemberRole,
  isUlid,
} from './account';
import { isReservedSlug, isValidSlug } from './project-slug';

describe('isUlid', () => {
  it.each([OWNER_ACCOUNT_ID, OWNER_USER_ID, '01ARZ3NDEKTSV4RRFFQ69G5FAV'])('accepts %s', (id) => {
    expect(isUlid(id)).toBe(true);
  });

  it.each([
    '',
    '01ARZ3NDEKTSV4RRFFQ69G5FA',
    '01ARZ3NDEKTSV4RRFFQ69G5FAVX',
    '01arz3ndektsv4rrffq69g5fav',
    '01ARZ3NDEKTSV4RRFFQ69G5FAI',
    7,
  ])('refuses %j', (id) => {
    expect(isUlid(id)).toBe(false);
  });
});

describe('the owner account', () => {
  it('has a valid slug no one else can create', () => {
    expect(isValidSlug(OWNER_ACCOUNT_SLUG)).toBe(true);
    expect(isReservedSlug(OWNER_ACCOUNT_SLUG)).toBe(true);
  });
});

describe('isMemberRole', () => {
  it('knows owner and member only', () => {
    expect(isMemberRole('owner')).toBe(true);
    expect(isMemberRole('member')).toBe(true);
    expect(isMemberRole('admin')).toBe(false);
  });
});

describe('audit event kinds', () => {
  it('fit the shape the audit_events CHECK enforces', () => {
    for (const kind of AUDIT_EVENT_KINDS) {
      expect(kind).toMatch(/^[a-z][a-z.-]{0,63}$/);
    }
    expect(new Set(AUDIT_EVENT_KINDS).size).toBe(AUDIT_EVENT_KINDS.length);
  });

  it('refuses an unknown kind', () => {
    expect(isAuditEventKind('account.created')).toBe(true);
    expect(isAuditEventKind('account.deleted-quietly')).toBe(false);
  });
});

describe('isEntitlementsOverride', () => {
  it.each([
    {},
    { max_projects: 10 },
    { hosted_runner: true, spend_cap_usd_month: 12.5 },
    { max_concurrency: 0 },
  ])('accepts %j', (value) => {
    expect(isEntitlementsOverride(value)).toBe(true);
  });

  it.each<unknown>([
    null,
    [],
    'max_projects',
    { unknown: 1 },
    { max_projects: -1 },
    { max_projects: 1.5 },
    { max_projects: '10' },
    { max_members: 0 },
    { max_concurrency: 33 },
    { hosted_runner: 'yes' },
    { spend_cap_usd_month: -1 },
    { spend_cap_usd_month: Number.POSITIVE_INFINITY },
    { spend_cap_usd_month: 100_001 },
    { constructor: 1 },
  ])('refuses %j', (value) => {
    expect(isEntitlementsOverride(value)).toBe(false);
  });
});

describe('entitlementsOf', () => {
  it('gives the plan defaults without an override', () => {
    expect(entitlementsOf({ plan: 'free', entitlements: {} })).toEqual(PLAN_ENTITLEMENTS.free);
    expect(entitlementsOf({ plan: 'team', entitlements: {} })).toEqual(PLAN_ENTITLEMENTS.team);
  });

  it('puts the override on top of the plan', () => {
    expect(entitlementsOf({ plan: 'team', entitlements: { max_projects: 7, hosted_runner: true } })).toEqual({
      ...PLAN_ENTITLEMENTS.team,
      maxProjects: 7,
      hostedRunner: true,
    });
  });

  it('keeps hosted runners off on every plan by default', () => {
    expect(PLAN_ENTITLEMENTS.free.hostedRunner).toBe(false);
    expect(PLAN_ENTITLEMENTS.team.hostedRunner).toBe(false);
  });

  it('falls back to the free tier for an unknown plan, even with a valid override', () => {
    expect(entitlementsOf({ plan: 'enterprise', entitlements: { max_projects: 999 } })).toEqual(
      PLAN_ENTITLEMENTS.free,
    );
  });

  it('falls back to the free tier for an override that fails the guard', () => {
    expect(entitlementsOf({ plan: 'team', entitlements: { max_projects: 999, extra: true } })).toEqual(
      PLAN_ENTITLEMENTS.free,
    );
    expect(entitlementsOf({ plan: 'team', entitlements: null })).toEqual(PLAN_ENTITLEMENTS.free);
  });
});

describe('DTO guards', () => {
  const account = {
    id: OWNER_ACCOUNT_ID,
    slug: 'owner',
    name: 'Owner',
    plan: 'team',
    entitlements: PLAN_ENTITLEMENTS.team,
    createdAt: '2026-11-09T00:00:00.000Z',
    suspendedAt: null,
  };

  it('accepts an account and refuses one with a bad field', () => {
    expect(isAccountDto(account)).toBe(true);
    expect(isAccountDto({ ...account, id: 'owner' })).toBe(false);
    expect(isAccountDto({ ...account, plan: 'gold' })).toBe(false);
    expect(isAccountDto({ ...account, entitlements: { maxProjects: 1 } })).toBe(false);
    expect(isAccountDto({ ...account, suspendedAt: 'later' })).toBe(false);
  });

  it('accepts a member and refuses an unknown role', () => {
    const member = {
      userId: OWNER_USER_ID,
      login: 'geeera',
      avatarUrl: null,
      role: 'owner',
      joinedAt: '2026-11-09T00:00:00.000Z',
    };
    expect(isAccountMemberDto(member)).toBe(true);
    expect(isAccountMemberDto({ ...member, role: 'admin' })).toBe(false);
  });

  it('accepts an audit page and refuses an event of an unknown kind', () => {
    const event = {
      id: 1,
      at: '2026-11-09T00:00:00.000Z',
      actorKind: 'system',
      actor: 'migration',
      kind: 'account.created',
      target: 'owner',
      details: {},
    };
    expect(isAuditEventListDto({ events: [event], nextCursor: null })).toBe(true);
    expect(isAuditEventListDto({ events: [event], nextCursor: 1.5 })).toBe(false);
    expect(isAuditEventDto({ ...event, kind: 'edited' })).toBe(false);
    expect(isAuditEventDto({ ...event, actorKind: 'owner' })).toBe(false);
  });
});
