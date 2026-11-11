import { isJobKind } from '@shared/contracts';
import {
  currentJobsOf,
  JOB_TEXT_MAX_LENGTH,
  jobEventTextOf,
  jobSummaryOf,
  jobsTileOf,
  recentJobsOf,
  RUN_NOW_KINDS,
  runnerLabelOf,
} from './job.model';
import { JOB_FIXTURE_IDS, jobEventFixture, jobFixture, queuedJobFixture } from './job.fixture';

const { first, second, third, runner } = JOB_FIXTURE_IDS;

describe('job model', () => {
  it('offers only kinds the Worker accepts from the kind alone', () => {
    expect(RUN_NOW_KINDS.every(isJobKind)).toBe(true);
    expect(RUN_NOW_KINDS).not.toContain('review');
    expect(RUN_NOW_KINDS).not.toContain('chat');
  });

  it('lists held jobs first, then the queue oldest first; ended jobs newest first', () => {
    const queuedLater = queuedJobFixture({ id: third, createdAt: '2026-11-11T09:20:00.000Z' });
    const queuedEarlier = queuedJobFixture({ id: second, createdAt: '2026-11-11T09:10:00.000Z' });
    const running = jobFixture({ id: first });
    expect(currentJobsOf([queuedLater, running, queuedEarlier]).map((job) => job.id)).toEqual([
      first,
      second,
      third,
    ]);

    const failed = jobFixture({ id: second, state: 'failed', finishedAt: '2026-11-11T09:30:00.000Z' });
    const finished = jobFixture({ id: first, state: 'finished', finishedAt: '2026-11-11T09:20:00.000Z' });
    expect(recentJobsOf([finished, running, failed]).map((job) => job.id)).toEqual([second, first]);
    expect(recentJobsOf([finished, failed], 1).map((job) => job.id)).toEqual([second]);
  });

  describe('jobsTileOf', () => {
    it('is none before any job', () => {
      expect(jobsTileOf([])).toEqual({ state: 'none', kind: null, count: 0 });
    });

    it('is running while a runner holds a job, whatever waits behind it', () => {
      const tile = jobsTileOf([
        queuedJobFixture({ id: second, kind: 'slot-qa' }),
        jobFixture({ state: 'claimed' }),
      ]);
      expect(tile).toEqual({ state: 'running', kind: 'slot-dev', count: 1 });
    });

    it('is queued with the queue length when nothing is held', () => {
      const tile = jobsTileOf([
        queuedJobFixture({ id: second }),
        queuedJobFixture({ id: third, kind: 'audit' }),
      ]);
      expect(tile.state).toBe('queued');
      expect(tile.count).toBe(2);
    });

    it('is the newest ended job otherwise: lost reads as failed, cancelled as finished', () => {
      expect(jobsTileOf([jobFixture({ state: 'lost' })]).state).toBe('failed');
      expect(jobsTileOf([jobFixture({ state: 'cancelled' })]).state).toBe('finished');
      const tile = jobsTileOf([
        jobFixture({ id: first, state: 'failed' }),
        jobFixture({ id: second, state: 'finished', kind: 'digest' }),
      ]);
      expect(tile).toEqual({ state: 'finished', kind: 'digest', count: 1 });
    });
  });

  it('reads an event as one plain line from its first text member', () => {
    expect(jobEventTextOf(jobEventFixture(1))).toBe('line 1');
    expect(jobEventTextOf(jobEventFixture(2, { kind: 'started', payload: { skill: 'slot-dev' } }))).toBe(
      'slot-dev',
    );
    expect(jobEventTextOf(jobEventFixture(3, { payload: { claimed: true } }))).toBeNull();
    expect(jobEventTextOf(jobEventFixture(4, { payload: { line: 42 } }))).toBeNull();
    // Bidi controls and zero-width characters are dropped; whitespace runs collapse to one line.
    expect(jobEventTextOf(jobEventFixture(5, { payload: { line: 'a‮​b\n\n  c' } }))).toBe('ab c');
    const long = jobEventTextOf(
      jobEventFixture(6, { payload: { line: 'x'.repeat(JOB_TEXT_MAX_LENGTH + 10) } }),
    );
    expect(long?.length).toBe(JOB_TEXT_MAX_LENGTH);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('prefers the earliest text member in TEXT_MEMBERS order when several carry text', () => {
    expect(
      jobEventTextOf(jobEventFixture(1, { payload: { line: 'from line', message: 'from message' } })),
    ).toBe('from line');
    expect(
      jobEventTextOf(
        jobEventFixture(2, { payload: { message: 'from message', summary: 'from summary' } }),
      ),
    ).toBe('from message');
    expect(
      jobEventTextOf(jobEventFixture(3, { payload: { reason: 'from reason', skill: 'from skill' } })),
    ).toBe('from reason');
  });

  it('falls back to the next text member when an earlier one is not text', () => {
    expect(jobEventTextOf(jobEventFixture(4, { payload: { line: 42, message: 'from message' } }))).toBe(
      'from message',
    );
    expect(
      jobEventTextOf(jobEventFixture(5, { payload: { line: '', message: '   ', summary: 'from summary' } })),
    ).toBe('from summary');
  });

  it("reads an ended job's summary, or the Worker's reason for a lost one", () => {
    expect(jobSummaryOf(jobFixture({ result: { summary: 'Merged #12' } }))).toBe('Merged #12');
    expect(jobSummaryOf(jobFixture({ state: 'lost', result: { reason: 'lost' } }))).toBe('lost');
    expect(jobSummaryOf(jobFixture())).toBeNull();
  });

  it('prefers summary over reason when both are present', () => {
    expect(jobSummaryOf(jobFixture({ result: { summary: 'Merged #12', reason: 'lost' } }))).toBe(
      'Merged #12',
    );
  });

  it('names a runner it knows, and a short id otherwise', () => {
    expect(runnerLabelOf(runner, new Map([[runner, 'Mac']]))).toBe('Mac');
    expect(runnerLabelOf(runner, new Map())).toBe(`…${runner.slice(-6)}`);
  });
});
