import type { StreamResult } from '../claude/stream-json';
import {
  BACKOFF_MINUTES,
  LIMIT_PATTERNS,
  MAX_PAUSE_MS,
  backoffMinutes,
  detectOutcome,
  resetTimeOf,
} from './detect';

/** ADR 0008 decision 9: every limit shape, the exit codes, the back-off, and unknown failures never retried. */

const now = new Date('2026-11-13T12:00:00.000Z');
const minutes = (n: number): string => new Date(now.getTime() + n * 60_000).toISOString();
const errorResult = (text: string): StreamResult => ({
  isError: true,
  subtype: 'success',
  text,
  costUsd: 0.1,
  turns: 2,
  durationMs: 10,
});
const ok: StreamResult = { ...errorResult('done'), isError: false };

describe('usage-limit detection', () => {
  it.each<[string, string, 'usage-limit' | 'rate-limit']>([
    ['usage-limit-reached', 'Claude AI usage limit reached|1763038800', 'usage-limit'],
    ['hit-your-limit', "You've hit your limit · resets 3pm (Europe/Kyiv)", 'usage-limit'],
    ['window-limit-reached', '5-hour limit reached ∙ resets 5pm', 'usage-limit'],
    ['subscription-disabled', 'Your organization has disabled Claude subscription access', 'usage-limit'],
    ['rate-limit-error', '{"type":"error","error":{"type":"rate_limit_error"}}', 'rate-limit'],
    ['http-429', 'API Error: 429 Too Many Requests', 'rate-limit'],
    ['overloaded', 'API Error: 529 {"type":"overloaded_error"}', 'rate-limit'],
  ])('row %s matches %j', (id, text, reason) => {
    expect(LIMIT_PATTERNS.some((row) => row.id === id)).toBe(true);
    const outcome = detectOutcome({ exitCode: 1, result: null, texts: [text], limitStreak: 0, now });
    expect(outcome).toMatchObject({ kind: 'limit', reason, pattern: id });
  });

  it('has a spec row for every pattern', () => {
    expect(LIMIT_PATTERNS.map((row) => row.id)).toEqual([
      'usage-limit-reached',
      'hit-your-limit',
      'window-limit-reached',
      'subscription-disabled',
      'rate-limit-error',
      'http-429',
      'overloaded',
    ]);
  });

  it('reads the shape from an error result as well as from stderr', () => {
    const outcome = detectOutcome({
      exitCode: 1,
      result: errorResult('Claude AI usage limit reached|1763038800'),
      texts: [],
      limitStreak: 0,
      now,
    });
    expect(outcome).toMatchObject({ kind: 'limit', reason: 'usage-limit' });
  });

  it('takes retryAt from the CLI’s reset time when it gives one', () => {
    const reset = Math.floor(now.getTime() / 1000) + 3600;
    expect(
      detectOutcome({
        exitCode: 1,
        result: null,
        texts: [`Claude AI usage limit reached|${String(reset)}`],
        limitStreak: 3,
        now,
      }),
    ).toMatchObject({
      retryAt: new Date(reset * 1000),
    });
    expect(resetTimeOf('limit hit, resets at 2026-11-13T15:30:00Z')).toEqual(
      new Date('2026-11-13T15:30:00Z'),
    );
    expect(resetTimeOf("You've hit your limit · resets 3pm")).toBeNull();
  });

  it('clamps a reset more than 24 h ahead and backs off from a reset in the past', () => {
    const far = Math.floor(now.getTime() / 1000) + 3 * 86_400;
    const clamped = detectOutcome({
      exitCode: 1,
      result: null,
      texts: [`usage limit reached|${String(far)}`],
      limitStreak: 0,
      now,
    });
    expect(clamped).toMatchObject({ retryAt: new Date(now.getTime() + MAX_PAUSE_MS) });
    const past = Math.floor(now.getTime() / 1000) - 60;
    const backedOff = detectOutcome({
      exitCode: 1,
      result: null,
      texts: [`usage limit reached|${String(past)}`],
      limitStreak: 0,
      now,
    });
    expect(backedOff).toMatchObject({ retryAt: new Date(minutes(5)) });
  });

  it.each([
    [0, 5],
    [1, 10],
    [2, 20],
    [3, 60],
    [9, 60],
  ])('backs off %i limit hits in a row to %i minutes', (streak, expected) => {
    expect(backoffMinutes(streak)).toBe(expected);
    const outcome = detectOutcome({
      exitCode: 1,
      result: null,
      texts: ['API Error: 429'],
      limitStreak: streak,
      now,
    });
    expect(outcome).toMatchObject({ retryAt: new Date(minutes(expected)) });
  });

  it('caps the back-off table at 60 minutes', () => {
    expect(BACKOFF_MINUTES).toEqual([5, 10, 20, 60]);
  });

  it('is a success only on exit 0 with a result that is not an error', () => {
    expect(
      detectOutcome({
        exitCode: 0,
        result: ok,
        texts: ['rate_limit_error in an old log line'],
        limitStreak: 2,
        now,
      }),
    ).toEqual({ kind: 'success' });
    expect(detectOutcome({ exitCode: 0, result: null, texts: [], limitStreak: 0, now })).toEqual({
      kind: 'failed',
      exitCode: 0,
    });
    expect(
      detectOutcome({ exitCode: 0, result: errorResult('max turns'), texts: [], limitStreak: 0, now }),
    ).toEqual({ kind: 'failed', exitCode: 0 });
  });

  it.each([1, 2, 3, 127, null])(
    'fails an unknown failure with the exit code (%s) and never pauses',
    (exitCode) => {
      expect(
        detectOutcome({ exitCode, result: null, texts: ['boom', 'TypeError: x'], limitStreak: 0, now }),
      ).toEqual({ kind: 'failed', exitCode });
    },
  );
});
