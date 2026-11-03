import runState from '../../fixtures/run-state.json';
import { recentRunsOf, shownStateOf } from './recent-runs';
import { parseRuns, timeOf, type RunLogComment } from './run-state';
import { partitionTeamComments } from './trust';

// The board's provenance rule (#132) over the plugin's own golden cases: what `runstate` marks untrusted is shown
// `unknown`, never `failed`; what it trusts is shown as its effective state.

interface RawComment {
  readonly id: number;
  readonly body: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly user: { readonly login: string };
}

const commentOf = (raw: RawComment): RunLogComment => ({
  id: raw.id,
  body: raw.body,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
  author: raw.user.login,
});

const SHOWN: Readonly<Record<string, string>> = {
  started: 'running',
  finished: 'finished',
  failed: 'failed',
};

describe.each(runState.cases)('golden case "$name"', (row) => {
  const now = timeOf(row.now);
  const { trusted, untrusted } = partitionTeamComments((row.comments as RawComment[]).map(commentOf), [
    row.issueAuthor,
  ]);
  const runs = parseRuns(trusted, untrusted);

  it('shows an untrusted run unknown and a trusted one as the plugin reads it', () => {
    const byId = new Map(row.runs.map((expected) => [expected.id, expected]));
    for (const run of runs) {
      const expected = byId.get(run.id);
      const shown = shownStateOf(run, now);
      expect({ id: run.id, shown }).toEqual({
        id: run.id,
        shown: expected?.trusted === false ? 'unknown' : SHOWN[expected?.effective ?? ''],
      });
    }
  });
});

describe('an edited entry on the board', () => {
  const NOW = Date.parse('2026-10-01T12:00:00Z');
  const at = (hoursAgo: number, minutes = 0): string =>
    new Date(NOW - hoursAgo * 3_600_000 + minutes * 60_000).toISOString();
  let nextId = 1;
  const entry = (
    id: string,
    state: string,
    createdAt: string,
    extra: Partial<RunLogComment> = {},
  ): RunLogComment => ({
    id: nextId++,
    body: `<!-- pt-run id=${id} slot=slot-dev state=${state} -->\n**slot-dev** ${state}`,
    createdAt,
    updatedAt: createdAt,
    author: 'geeera',
    ...extra,
  });
  const read = (comments: readonly RunLogComment[]) => {
    const { trusted, untrusted } = partitionTeamComments(comments, ['geeera']);
    return recentRunsOf(parseRuns(trusted, untrusted), NOW, 5);
  };

  it('an edited "failed" is unknown, not failed, while the start is recent', () => {
    const started = at(1);
    const failed = at(1, 20);
    expect(
      read([entry('a', 'started', started), entry('a', 'failed', failed, { updatedAt: at(0) })]),
    ).toEqual([{ id: 'a', slot: 'slot-dev', state: 'unknown', at: started }]);
  });

  it('an edited "failed" stays unknown after the 3-hour window, where an unfinished run would read as failed', () => {
    const started = at(5);
    const runs = read([
      entry('a', 'started', started),
      entry('a', 'failed', at(5, 10), { updatedAt: at(4) }),
    ]);
    expect(runs.map((run) => run.state)).toEqual(['unknown']);
  });

  it('an outsider\'s "failed" never touches a team run', () => {
    const runs = read([
      entry('a', 'started', at(2)),
      entry('a', 'finished', at(1)),
      entry('a', 'failed', at(0), { author: 'outsider' }),
    ]);
    expect(runs.map((run) => run.state)).toEqual(['finished']);
  });

  it('a team "failed" that nobody edited is failed, timed at its end', () => {
    const failed = at(1);
    expect(read([entry('a', 'started', at(2)), entry('a', 'failed', failed)])).toEqual([
      { id: 'a', slot: 'slot-dev', state: 'failed', at: failed },
    ]);
  });
});

describe('recentRunsOf', () => {
  const NOW = Date.parse('2026-10-01T12:00:00Z');
  const comments: RunLogComment[] = Array.from({ length: 7 }, (_, index) => {
    const createdAt = new Date(NOW - (7 - index) * 3_600_000).toISOString();
    return {
      id: index + 1,
      body: `<!-- pt-run id=r${index} slot=slot-qa state=finished -->`,
      createdAt,
      updatedAt: createdAt,
      author: 'geeera',
    };
  });
  const runs = parseRuns(comments);

  it('lists the latest runs newest first, at most the limit', () => {
    expect(recentRunsOf(runs, NOW, 5).map((run) => run.id)).toEqual(['r6', 'r5', 'r4', 'r3', 'r2']);
  });

  it('lists nothing for a limit of 0 and all runs for a limit past their number', () => {
    expect(recentRunsOf(runs, NOW, 0)).toEqual([]);
    expect(recentRunsOf(runs, NOW, 50)).toHaveLength(7);
  });

  it('shows a running run at its start', () => {
    const started = new Date(NOW - 600_000).toISOString();
    const [run] = recentRunsOf(
      parseRuns([
        {
          id: 1,
          body: '<!-- pt-run id=x slot=slot-dev state=started -->',
          createdAt: started,
          updatedAt: started,
          author: 'geeera',
        },
      ]),
      NOW,
      5,
    );
    expect(run).toEqual({ id: 'x', slot: 'slot-dev', state: 'running', at: started });
  });

  it('shows a state the console does not know as unknown', () => {
    const at = new Date(NOW - 600_000).toISOString();
    const [run] = recentRunsOf(
      parseRuns([
        {
          id: 1,
          body: '<!-- pt-run id=y slot=slot-dev state=started -->',
          createdAt: at,
          updatedAt: at,
          author: 'a',
        },
        {
          id: 2,
          body: '<!-- pt-run id=y slot=slot-dev state=skipped -->',
          createdAt: at,
          updatedAt: at,
          author: 'a',
        },
      ]),
      NOW,
      5,
    );
    expect(run?.state).toBe('unknown');
  });
});
