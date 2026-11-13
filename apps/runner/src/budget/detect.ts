import type { StreamResult } from '../claude/stream-json';

/**
 * Usage-budget detection (ADR 0008 decision 9; #446 items 8–9): the runner enforces, the console records. One table
 * of the CLI's limit shapes over its stream-json text, stderr and exit, read only when the run did not succeed; a
 * hit pauses claiming until `retryAt`. Anything the table does not know is a plain `failed` with the exit code and is
 * never retried: the shapes change, and a silent retry loop would burn the quota it is meant to protect.
 */

export type LimitReason = 'usage-limit' | 'rate-limit';

export interface LimitPattern {
  readonly id: string;
  readonly reason: LimitReason;
  readonly pattern: RegExp;
}

export const LIMIT_PATTERNS: readonly LimitPattern[] = [
  { id: 'usage-limit-reached', reason: 'usage-limit', pattern: /usage limit reached/i },
  {
    id: 'hit-your-limit',
    reason: 'usage-limit',
    pattern: /\b(?:you've|you have) (?:hit|reached) your (?:[\w-]+ )?limit\b/i,
  },
  {
    id: 'window-limit-reached',
    reason: 'usage-limit',
    pattern: /\b(?:5-hour|weekly|session|opus|sonnet) limit reached\b/i,
  },
  {
    id: 'subscription-disabled',
    reason: 'usage-limit',
    pattern: /organization has disabled claude subscription access/i,
  },
  { id: 'rate-limit-error', reason: 'rate-limit', pattern: /\brate_limit_error\b/i },
  { id: 'http-429', reason: 'rate-limit', pattern: /\bAPI Error:? 429\b|\b429 Too Many Requests\b/i },
  { id: 'overloaded', reason: 'rate-limit', pattern: /\boverloaded_error\b|\bAPI Error:? 529\b/i },
];

/** Back-off when the CLI names no reset time: 5 → 10 → 20 → 60 minutes, capped; reset after a successful job. */
export const BACKOFF_MINUTES = [5, 10, 20, 60] as const;
/** The console accepts a pause at most 24 h ahead (2-B-4); a later reset time is clamped to it. */
export const MAX_PAUSE_MS = 24 * 60 * 60 * 1000;

export type RunOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'limit'; readonly reason: LimitReason; readonly pattern: string; readonly retryAt: Date }
  | { readonly kind: 'failed'; readonly exitCode: number | null };

export interface RunEvidence {
  readonly exitCode: number | null;
  readonly result: StreamResult | null;
  /** Assistant/result text and stderr lines of the run (the tail the runner kept). */
  readonly texts: readonly string[];
  /** Limit hits in a row before this run (`state.json`). */
  readonly limitStreak: number;
  readonly now: Date;
}

export function backoffMinutes(limitStreak: number): number {
  const index = Math.min(Math.max(0, Math.trunc(limitStreak)), BACKOFF_MINUTES.length - 1);
  return BACKOFF_MINUTES[index] ?? 60;
}

/** The reset time the CLI printed: `…|<epoch seconds>` or an ISO 8601 instant after "reset(s)"; else `null`. */
export function resetTimeOf(text: string): Date | null {
  const epoch = /limit reached\|(\d{10})\b/i.exec(text)?.[1];
  if (epoch !== undefined) {
    return new Date(Number(epoch) * 1000);
  }
  const iso =
    /\bresets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))/i.exec(
      text,
    )?.[1];
  if (iso !== undefined) {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  return null;
}

export function detectOutcome(evidence: RunEvidence): RunOutcome {
  const { exitCode, result, now } = evidence;
  if (exitCode === 0 && result !== null && !result.isError) {
    return { kind: 'success' };
  }
  const texts = [...evidence.texts, result?.text ?? ''];
  for (const row of LIMIT_PATTERNS) {
    const text = texts.find((candidate) => row.pattern.test(candidate));
    if (text === undefined) {
      continue;
    }
    const reset = resetTimeOf(text);
    const fallback = new Date(now.getTime() + backoffMinutes(evidence.limitStreak) * 60_000);
    const retryAt =
      reset === null || reset.getTime() <= now.getTime()
        ? fallback
        : new Date(Math.min(reset.getTime(), now.getTime() + MAX_PAUSE_MS));
    return { kind: 'limit', reason: row.reason, pattern: row.id, retryAt };
  }
  return { kind: 'failed', exitCode };
}
