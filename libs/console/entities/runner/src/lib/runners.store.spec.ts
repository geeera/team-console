import { TestBed } from '@angular/core/testing';
import { OWNER_ACCOUNT_ID, type AccountMembershipDto, type RunnerListDto } from '@shared/contracts';
import type { RunnerResult } from './runner-failure';
import { RUNNER_FIXTURE_IDS, runnerFixture } from './runner.fixture';
import { liveRunnersOf, managedAccountOf, projectPauseOf, runnerPresenceOf, runnersInDisplayOrder } from './runner.model';
import { RunnersApi } from './runners.api';
import { RunnersStore } from './runners.store';

const OWNER: AccountMembershipDto = { id: OWNER_ACCOUNT_ID, slug: 'owner', name: 'Owner', role: 'owner' };
const MEMBER: AccountMembershipDto = { id: '01M6YSNJ0000000000000000A2', slug: 'acme', name: 'Acme', role: 'member' };
const RELEASE = { version: '0.3.0', minimumVersion: '0.2.0' };

describe('RunnersStore', () => {
  function setup(
    accounts: RunnerResult<readonly AccountMembershipDto[]>,
    list: () => RunnerResult<RunnerListDto> = () => ({ ok: true, value: { runners: [runnerFixture()], pendingEnrolments: [], release: RELEASE } }),
  ) {
    const api = { accounts: vi.fn(async () => accounts), list: vi.fn(async () => list()) };
    TestBed.configureTestingModule({ providers: [{ provide: RunnersApi, useValue: api }] });
    return { store: TestBed.inject(RunnersStore), api };
  }

  it("reads the first owned account's runners and the release", async () => {
    const { store, api } = setup({ ok: true, value: [MEMBER, OWNER] });
    await store.load();
    expect(api.list).toHaveBeenCalledWith(OWNER_ACCOUNT_ID);
    expect(store.status()).toBe('ready');
    expect(store.account()).toEqual(OWNER);
    expect(store.runners()).toEqual([runnerFixture()]);
    expect(store.release()).toEqual(RELEASE);
    expect(store.isEmpty()).toBe(false);
  });

  it('is empty, not an error, for an account with no runners', async () => {
    const { store } = setup({ ok: true, value: [OWNER] }, () => ({
      ok: true,
      value: { runners: [], pendingEnrolments: [], release: RELEASE },
    }));
    await store.load();
    expect([store.status(), store.isEmpty()]).toEqual(['ready', true]);
  });

  it('is forbidden for a member of accounts only, and for no account at all, without reading runners', async () => {
    const member = setup({ ok: true, value: [MEMBER] });
    await member.store.load();
    expect([member.store.status(), member.store.forbidden()]).toEqual(['forbidden', 'member']);
    expect(member.api.list).not.toHaveBeenCalled();

    TestBed.resetTestingModule();
    const none = setup({ ok: true, value: [] });
    await none.store.load();
    expect([none.store.status(), none.store.forbidden()]).toEqual(['forbidden', 'none']);
  });

  it('is forbidden when the Worker refuses the account (403 or 404)', async () => {
    for (const kind of ['forbidden', 'not-found'] as const) {
      TestBed.resetTestingModule();
      const { store } = setup({ ok: true, value: [OWNER] }, () => ({
        ok: false,
        failure: { kind, slug: null, field: null },
      }));
      await store.load();
      expect(store.status()).toBe('forbidden');
    }
  });

  it('is an error with the failure for a failed read, and a retry recovers', async () => {
    let failing = true;
    const { store } = setup({ ok: true, value: [OWNER] }, () =>
      failing
        ? { ok: false, failure: { kind: 'offline', slug: null, field: null } }
        : { ok: true, value: { runners: [], pendingEnrolments: [], release: RELEASE } },
    );
    await store.load();
    expect([store.status(), store.failure()?.kind]).toEqual(['error', 'offline']);
    failing = false;
    await store.load();
    expect([store.status(), store.failure()]).toEqual(['ready', null]);
  });

  it('is an error when the accounts cannot be read', async () => {
    const { store, api } = setup({ ok: false, failure: { kind: 'timeout', slug: null, field: null } });
    await store.load();
    expect(store.status()).toBe('error');
    expect(api.list).not.toHaveBeenCalled();
  });

  it('shares one read between callers and replaces a changed runner in place', async () => {
    const { store, api } = setup({ ok: true, value: [OWNER] });
    await Promise.all([store.ready(), store.ready(), store.load()]);
    expect(api.accounts).toHaveBeenCalledTimes(1);
    store.apply(runnerFixture({ allowedProjects: [] }));
    expect(store.runners()[0]?.allowedProjects).toEqual([]);
  });
});

describe('runner model', () => {
  it.each([
    [runnerFixture({ revokedAt: '2026-11-11T00:00:00.000Z', suspect: { at: 'x', reason: 'new-country' } }), 'revoked'],
    [runnerFixture({ suspect: { at: '2026-11-11T00:00:00.000Z', reason: 'two-pollers' } }), 'suspect'],
    [runnerFixture({ suspect: { at: '2026-11-11T00:00:00.000Z', reason: 'two-pollers' }, pause: { reason: 'manual', until: '2026-11-11T05:00:00.000Z' } }), 'suspect'],
    [runnerFixture({ online: false, pause: { reason: 'usage-limit', until: '2026-11-11T05:00:00.000Z' } }), 'paused'],
    [runnerFixture({ pause: { reason: 'rate-limit', until: '2026-11-11T05:00:00.000Z' } }), 'paused'],
    [runnerFixture({ lastSeenAt: null, online: false }), 'never-seen'],
    [runnerFixture({ online: false }), 'offline'],
    [runnerFixture(), 'online'],
  ])('reads the presence of %#', (runner, presence) => {
    expect(runnerPresenceOf(runner)).toBe(presence);
  });

  it('lists live runners first and offers only those to a policy', () => {
    const old = runnerFixture({ id: RUNNER_FIXTURE_IDS.old, revokedAt: '2026-11-01T00:00:00.000Z' });
    const vps = runnerFixture({ id: RUNNER_FIXTURE_IDS.vps, name: 'VPS' });
    expect(runnersInDisplayOrder([old, runnerFixture(), vps]).map((runner) => runner.id)).toEqual([
      RUNNER_FIXTURE_IDS.mac,
      RUNNER_FIXTURE_IDS.vps,
      RUNNER_FIXTURE_IDS.old,
    ]);
    expect(liveRunnersOf([old, vps])).toEqual([vps]);
  });

  // #571: the board's tile says "paused" only while no runner that may serve the project is free.
  it('holds a project back only when every live runner allowed for it is paused, until the first one resumes', () => {
    const early = { reason: 'rate-limit' as const, until: '2026-11-11T05:00:00.000Z' };
    const late = { reason: 'usage-limit' as const, until: '2026-11-11T09:00:00.000Z' };
    const mac = runnerFixture({ pause: late });
    const vps = runnerFixture({ id: RUNNER_FIXTURE_IDS.vps, pause: early });
    const free = runnerFixture({ id: RUNNER_FIXTURE_IDS.vps });
    const elsewhere = runnerFixture({ id: RUNNER_FIXTURE_IDS.vps, allowedProjects: ['storify'] });
    const revoked = runnerFixture({ id: RUNNER_FIXTURE_IDS.old, revokedAt: '2026-11-01T00:00:00.000Z' });

    expect(projectPauseOf([mac, vps], 'team-console')).toEqual(early);
    expect(projectPauseOf([mac, free], 'team-console')).toBeNull();
    // A runner of another project or a revoked one neither frees nor holds this project.
    expect(projectPauseOf([mac, elsewhere, revoked], 'team-console')).toEqual(late);
    expect(projectPauseOf([], 'team-console')).toBeNull();
    expect(projectPauseOf([elsewhere], 'team-console')).toBeNull();
  });

  it('manages the first owned account', () => {
    expect(managedAccountOf([MEMBER, OWNER])).toEqual({ kind: 'owner', account: OWNER });
    expect(managedAccountOf([MEMBER])).toEqual({ kind: 'member' });
    expect(managedAccountOf([])).toEqual({ kind: 'none' });
  });
});
