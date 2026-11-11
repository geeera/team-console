import {
  isJobDto,
  isJobEventDto,
  isJobEventListDto,
  isJobListDto,
  type JobDto,
  type JobEventDto,
} from './job';

const JOB: JobDto = {
  id: '01M6YSNJ00000000000000J001',
  projectSlug: 'team-console',
  kind: 'slot-dev',
  role: 'orchestrator',
  state: 'running',
  items: [12],
  priority: 1,
  requestedBy: 'owner',
  needsLocal: false,
  dispatch: 'pull',
  runnerId: '01M6YSNJ000000000000000R01',
  attempt: 1,
  maxMinutes: 90,
  createdAt: '2026-11-11T09:00:00.000Z',
  claimedAt: '2026-11-11T09:00:05.000Z',
  leaseUntil: '2026-11-11T09:05:05.000Z',
  startedAt: '2026-11-11T09:00:06.000Z',
  finishedAt: null,
  result: null,
};

const EVENT: JobEventDto = {
  seq: 1,
  at: '2026-11-11T09:00:06.000Z',
  level: 'info',
  kind: 'started',
  payload: {},
};

describe('job guards', () => {
  it('accepts a job as the Worker answers it, queued or finished', () => {
    expect(isJobDto(JOB)).toBe(true);
    expect(
      isJobDto({
        ...JOB,
        state: 'queued',
        runnerId: null,
        claimedAt: null,
        leaseUntil: null,
        startedAt: null,
      }),
    ).toBe(true);
    expect(
      isJobDto({
        ...JOB,
        state: 'finished',
        finishedAt: '2026-11-11T09:30:00.000Z',
        result: { summary: 'ok' },
      }),
    ).toBe(true);
  });

  it.each([
    ['an unknown kind', { kind: 'shell' }],
    ['an unknown state', { state: 'paused' }],
    ['a runner id that is no ULID', { runnerId: 'mac' }],
    ['items that are not numbers', { items: ['12'] }],
    ['a missing createdAt', { createdAt: undefined }],
    ['a result that is no object', { result: 'ok' }],
  ])('refuses a job with %s', (_name, change) => {
    expect(isJobDto({ ...JOB, ...change })).toBe(false);
  });

  it('checks every job of a list and its cursor', () => {
    expect(isJobListDto({ jobs: [JOB], nextCursor: null })).toBe(true);
    expect(isJobListDto({ jobs: [JOB], nextCursor: JOB.id })).toBe(true);
    expect(isJobListDto({ jobs: [{ ...JOB, dispatch: 'cron' }], nextCursor: null })).toBe(false);
    expect(isJobListDto({ jobs: [] })).toBe(false);
  });

  it('checks events: level, kind, a payload object and a numeric cursor', () => {
    expect(isJobEventDto(EVENT)).toBe(true);
    expect(isJobEventDto({ ...EVENT, level: 'debug' })).toBe(false);
    expect(isJobEventDto({ ...EVENT, kind: 'shell' })).toBe(false);
    expect(isJobEventDto({ ...EVENT, payload: 'line' })).toBe(false);
    expect(isJobEventListDto({ events: [EVENT], nextCursor: 1 })).toBe(true);
    expect(isJobEventListDto({ events: [EVENT], nextCursor: '1' })).toBe(false);
  });
});
