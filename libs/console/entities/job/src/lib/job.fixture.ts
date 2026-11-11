import type { JobDto, JobEventDto } from '@shared/contracts';

/** Fixed ids for specs and stories: ULIDs, so the contracts guard accepts them. */
export const JOB_FIXTURE_IDS = {
  first: '01M6YSNJ00000000000000J001',
  second: '01M6YSNJ00000000000000J002',
  third: '01M6YSNJ00000000000000J003',
  runner: '01M6YSNJ000000000000000R01',
} as const;

/** A `slot-dev` job of team-console that the owner's Mac is running; override what a case needs. */
export function jobFixture(overrides: Partial<JobDto> = {}): JobDto {
  return {
    id: JOB_FIXTURE_IDS.first,
    projectSlug: 'team-console',
    kind: 'slot-dev',
    role: 'orchestrator',
    state: 'running',
    items: [],
    priority: 1,
    requestedBy: 'owner',
    needsLocal: false,
    dispatch: 'pull',
    runnerId: JOB_FIXTURE_IDS.runner,
    attempt: 1,
    maxMinutes: 90,
    createdAt: '2026-11-11T09:00:00.000Z',
    claimedAt: '2026-11-11T09:00:05.000Z',
    leaseUntil: '2026-11-11T09:05:05.000Z',
    startedAt: '2026-11-11T09:00:06.000Z',
    finishedAt: null,
    result: null,
    ...overrides,
  };
}

/** A queued job: no runner, no lease, nothing started. */
export function queuedJobFixture(overrides: Partial<JobDto> = {}): JobDto {
  return jobFixture({
    state: 'queued',
    runnerId: null,
    claimedAt: null,
    leaseUntil: null,
    startedAt: null,
    ...overrides,
  });
}

export function jobEventFixture(seq: number, overrides: Partial<JobEventDto> = {}): JobEventDto {
  return {
    seq,
    at: `2026-11-11T09:0${String(Math.min(seq, 9))}:10.000Z`,
    level: 'info',
    kind: 'log',
    payload: { line: `line ${String(seq)}` },
    ...overrides,
  };
}
