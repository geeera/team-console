import type { AccountMembershipDto } from '@shared/contracts';
import { d3RunnerOf, projectAccountRoleOf, runnerNameOf } from './runner.model';
import { RUNNER_FIXTURE_IDS, runnerFixture } from './runner.fixture';

const SLUG = 'storify';

/** A subscription runner under `all` that D3 keeps off `storify`: it serves another project only. */
const held = (overrides: Parameters<typeof runnerFixture>[0] = {}) =>
  runnerFixture({
    projectScope: 'all',
    allowedProjects: [],
    capabilities: { local: true, maxConcurrency: 1, accessSources: ['subscription'] },
    servedProjects: [{ slug: 'team-console', accessSource: 'subscription', fit: true }],
    ...overrides,
  });

describe('d3RunnerOf', () => {
  it('finds a subscription runner under all that does not serve the project', () => {
    expect(d3RunnerOf([held()], SLUG)?.id).toBe(RUNNER_FIXTURE_IDS.mac);
  });

  it('counts a runner that declares no access sources as subscription-capable', () => {
    expect(d3RunnerOf([held({ capabilities: { local: true, maxConcurrency: 1 } })], SLUG)).not.toBeNull();
  });

  it('prefers the caller’s own runner, which the caller can fix by hand', () => {
    const theirs = held();
    const mine = held({ id: RUNNER_FIXTURE_IDS.vps, name: 'VPS', enrolledByYou: true });
    expect(d3RunnerOf([theirs, mine], SLUG)?.id).toBe(RUNNER_FIXTURE_IDS.vps);
  });

  it.each([
    ['serves the project already', { servedProjects: [{ slug: SLUG, accessSource: 'subscription', fit: true }] }],
    ['is on a selected list', { projectScope: 'selected', allowedProjects: ['team-console'] }],
    ['declares an API key only', { capabilities: { local: true, maxConcurrency: 1, accessSources: ['api_key'] } }],
    ['is revoked', { revokedAt: '2026-11-11T00:00:00.000Z' }],
    ['is hosted', { hosted: true }],
    ['is an Actions identity', { isolation: 'actions-ephemeral' }],
  ] as const)('skips a runner that %s', (_name, overrides) => {
    expect(d3RunnerOf([held(overrides)], SLUG)).toBeNull();
  });
});

describe('projectAccountRoleOf (#759, #848)', () => {
  const account = (id: string, role: AccountMembershipDto['role']): AccountMembershipDto => ({ id, slug: id, name: id, role });

  it('is the one role every account gives', () => {
    expect(projectAccountRoleOf([account('a', 'owner')])).toBe('owner');
    expect(projectAccountRoleOf([account('a', 'member')])).toBe('member');
    expect(projectAccountRoleOf([account('a', 'owner'), account('b', 'owner')])).toBe('owner');
  });

  it('cannot tell with no account, or when owning one account and only belonging to another', () => {
    expect(projectAccountRoleOf([])).toBe('unknown');
    expect(projectAccountRoleOf([account('a', 'owner'), account('b', 'member')])).toBe('unknown');
  });

  it('reads the project’s own account when the project names it, roles mixed or not (#870)', () => {
    const mixed = [account('a', 'owner'), account('b', 'member')];
    expect(projectAccountRoleOf(mixed, 'a')).toBe('owner');
    expect(projectAccountRoleOf(mixed, 'b')).toBe('member');
    expect(projectAccountRoleOf([account('a', 'owner')], 'a')).toBe('owner');
  });

  it('cannot tell when the project’s account is not among the caller’s, even if every account is owned (#870)', () => {
    expect(projectAccountRoleOf([account('a', 'owner'), account('b', 'owner')], 'c')).toBe('unknown');
    expect(projectAccountRoleOf([], 'a')).toBe('unknown');
  });
});

describe('runnerNameOf', () => {
  it('reads a name as one trimmed line', () => {
    expect(runnerNameOf('  Mac\n mini ')).toBe('Mac mini');
    expect(runnerNameOf(' \t ')).toBe('');
  });
});
