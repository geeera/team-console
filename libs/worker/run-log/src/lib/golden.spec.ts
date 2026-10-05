import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import commands from '../../fixtures/commands.json';
import runState from '../../fixtures/run-state.json';
import { PAUSED_LABEL, pauseCommentBody, resumeCommentBody } from './commands';
import { activeOwnerPause, decide, effectiveState, parseRuns, timeOf, type RunLogComment } from './run-state';
import { partitionTeamComments } from './trust';

// Golden fixtures written by the vendored plugin itself (fixtures/generate.py runs the real `runlog` and
// `runstate`); the port must agree with every row.

const ROOT = resolve(import.meta.dirname, '../../../../..');
const PLUGIN = resolve(ROOT, '.claude/product-team');

interface RawComment {
  readonly id: number;
  readonly body: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly user: { readonly login: string };
}

function commentOf(raw: RawComment): RunLogComment {
  return {
    id: raw.id,
    body: raw.body,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    author: raw.user.login,
  };
}

describe('fixtures match the vendored plugin', () => {
  it.each([
    ['run-state.json', runState.plugin],
    ['commands.json', commands.plugin],
  ])(
    '%s was generated from the vendored plugin as it is now (else: regenerate the fixtures)',
    (_, plugin) => {
      const manifest = JSON.parse(readFileSync(resolve(PLUGIN, '.claude-plugin/plugin.json'), 'utf8')) as {
        version: string;
      };
      expect(plugin.version).toBe(manifest.version);
      for (const [path, digest] of Object.entries(plugin.sources)) {
        const actual = createHash('sha256')
          .update(readFileSync(resolve(PLUGIN, path)))
          .digest('hex');
        expect({ path, digest: actual }).toEqual({ path, digest });
      }
    },
  );
});

describe.each(runState.cases)('run log "$name" read like `runlog` (REST-only)', (row) => {
  const now = timeOf(row.now);
  const { trusted, untrusted } = partitionTeamComments((row.comments as RawComment[]).map(commentOf), [
    row.issueAuthor,
  ]);
  const runs = parseRuns(trusted, untrusted);

  it('parses the same runs with the same effective state', () => {
    expect(
      runs.map((run) => ({
        id: run.id,
        slot: run.slot,
        state: run.state,
        at: run.at,
        commentId: run.commentId,
        metrics: run.metrics,
        acted: run.acted,
        trusted: run.trusted,
        finishedAt: run.finishedAt,
        effective: effectiveState(run, now),
      })),
    ).toEqual(row.runs);
  });

  it('finds the same active owner pause', () => {
    const pause = activeOwnerPause(trusted);
    expect(pause === null ? null : { record: pause.record, pausedAt: pause.pausedAt }).toEqual(
      row.ownerPause,
    );
  });

  it('decides like `runlog start` for every slot', () => {
    for (const [key, expected] of Object.entries(row.decisions)) {
      const [slot = '', mode = ''] = key.split(' ');
      const result =
        mode === 'after'
          ? decide(runs, slot, now, false, row.resetAt)
          : decide(runs, slot, now, mode === 'paused');
      expect({ key, decision: result.decision, reason: result.reason }).toEqual({
        key,
        decision: expected.decision,
        reason: expected.reason,
      });
    }
  });
});

describe('the comments `runlog pause` / `runlog resume` post', () => {
  const now = Date.parse(commands.now);

  it.each(commands.pause)(
    'pause with reason $reason: the label first, then the same body',
    ({ reason, requests }) => {
      expect(requests.map((request) => request.method)).toEqual(['POST', 'POST']);
      expect(requests[0]?.fields).toEqual({ labels: [PAUSED_LABEL] });
      expect(requests[1]?.fields).toEqual({
        body: pauseCommentBody({ reason, source: 'team-console' }, now),
      });
    },
  );

  it('resume: the label off, then the same body', () => {
    expect(commands.resume.map((request) => request.method)).toEqual(['DELETE', 'POST']);
    expect(commands.resume[0]?.path).toMatch(/\/labels\/team%3Apaused$/);
    expect(commands.resume[1]?.fields).toEqual({ body: resumeCommentBody(now) });
  });
});
