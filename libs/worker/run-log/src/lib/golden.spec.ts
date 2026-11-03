import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import commands from '../../fixtures/commands.json';
import ownerPause from '../../fixtures/owner-pause.json';
import runState from '../../fixtures/run-state.json';
import { PAUSED_LABEL, pauseCommentBody, resumeCommentBody } from './commands';
import {
  PLUGIN_COUNTS_OWNER_PAUSE,
  consolePauseHolds,
  pauseMarkerAuthorsOf,
  pausedSinceOf,
  resumedAfterPause,
} from './owner-pause';
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
    ['owner-pause.json', ownerPause.plugin],
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

describe.each(ownerPause.cases)('#141 reproduction, $name: `runlog start slot-dev`', (row) => {
  const comments = (row.comments as RawComment[]).map(commentOf);
  const { trusted } = partitionTeamComments(comments, [row.logAuthor, row.owner, ...row.bots]);
  const pausedSince = pausedSinceOf(trusted, pauseMarkerAuthorsOf(row.logAuthor, row.owner, row.bots));
  // The owner's `/resume` comments (`commands.parse`); the fixture writes the command as the whole body.
  const ownerResumeAt = trusted
    .filter((comment) => comment.author === row.owner && comment.body.trim() === '/resume')
    .reduce(
      (latest, comment) => ((comment.createdAt ?? '') > latest ? (comment.createdAt ?? '') : latest),
      '',
    );

  it('the console pause guard agrees with the plugin (else: flip PLUGIN_COUNTS_OWNER_PAUSE in owner-pause.ts)', () => {
    expect({ PLUGIN_COUNTS_OWNER_PAUSE, holds: consolePauseHolds(row.logAuthor, row.owner) }).toEqual({
      PLUGIN_COUNTS_OWNER_PAUSE,
      holds: row.decision === 'paused',
    });
  });

  it('works out the same `paused_since`, so the console knows when the next start lifts the label', () => {
    expect(row.labels).toContain(PAUSED_LABEL);
    expect(resumedAfterPause(pausedSince, ownerResumeAt)).toBe(row.labelRemoved);
  });
});
