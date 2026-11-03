/**
 * Fires a Claude Code routine through its API trigger (ADR 0001 decision 12, architect note on #114 §3). The
 * endpoint is experimental, so everything about it lives here: the URL, the pinned `anthropic-version` (no beta
 * header), the 10 s deadline and the reading of its answers. One attempt, never retried — the endpoint has no
 * idempotency key and every accepted request starts a session.
 */

/** The only host a trigger token is ever sent to. */
export const ROUTINES_API_ORIGIN = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ROUTINE_FIRE_DEADLINE_MS = 10_000;
/** When a 429 names no wait: the per-routine cap is per hour, so a short wait would only be refused again. */
export const DEFAULT_RETRY_AFTER_S = 600;
const MAX_RETRY_AFTER_S = 3600;
/** The `text` is inert context for the run; a cap keeps a misbehaving caller from sending a novel. */
const MAX_TEXT_LENGTH = 1000;

/** `trig_…` from the trigger URL; nothing else may be put into the path. */
const ROUTINE_ID = /^trig_[A-Za-z0-9]{1,64}$/;
/** The bearer must look like a trigger token before it goes anywhere; its value is never logged or returned. */
const TOKEN_SHAPE = /^sk-ant-[A-Za-z0-9_-]{8,512}$/;
const SESSION_URL = /^https:\/\/claude\.ai\/[A-Za-z0-9/_?=&.-]{1,300}$/;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface FireRequest {
  readonly routineId: string;
  /** Read from `SLOT_TOKEN_<SLUG>_<SLOT>`; the caller never logs it. */
  readonly token: string;
  readonly text: string;
}

export type FireOutcome =
  | { readonly kind: 'fired'; readonly sessionId: string | null; readonly sessionUrl: string | null }
  | { readonly kind: 'rate-limited'; readonly retryAfter: number }
  /** The routine is switched off in Claude Code (400 "routine is paused"). */
  | { readonly kind: 'paused' }
  /** 401: the token was regenerated or never matched. */
  | { readonly kind: 'unauthorized' }
  /** 404: no routine with this id for this token. */
  | { readonly kind: 'not-found' }
  /** Certainly refused before a session started: 403, another 4xx, 5xx. */
  | { readonly kind: 'unavailable'; readonly status: number }
  /** No answer within the deadline or a network failure: a session may or may not have started. */
  | { readonly kind: 'unknown' };

export class InvalidRoutineConfigError extends Error {
  constructor(readonly part: 'token' | 'routine') {
    super(`the routine ${part} is not in the expected shape`);
    this.name = 'InvalidRoutineConfigError';
  }
}

export function isRoutineId(value: string): boolean {
  return ROUTINE_ID.test(value);
}

export function isTriggerTokenShape(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function retryAfterOf(headers: Headers): number {
  const raw = headers.get('retry-after')?.trim() ?? '';
  if (/^\d{1,6}$/.test(raw)) {
    return Math.min(Number(raw), MAX_RETRY_AFTER_S);
  }
  return DEFAULT_RETRY_AFTER_S;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether a 400 says the routine is switched off. Only checked, never echoed: the text is the upstream's. */
async function isPausedRefusal(response: Response): Promise<boolean> {
  const body = await readJson(response);
  const error = isRecord(body) && isRecord(body['error']) ? body['error'] : body;
  const message = isRecord(error) && typeof error['message'] === 'string' ? error['message'] : '';
  return /\b(paused|disabled)\b/i.test(message);
}

async function firedOf(response: Response): Promise<FireOutcome> {
  const body = await readJson(response);
  const sessionId =
    isRecord(body) &&
    typeof body['claude_code_session_id'] === 'string' &&
    body['claude_code_session_id'].length <= 200
      ? body['claude_code_session_id']
      : null;
  const url = isRecord(body) ? body['claude_code_session_url'] : undefined;
  return {
    kind: 'fired',
    sessionId,
    sessionUrl: typeof url === 'string' && SESSION_URL.test(url) ? url : null,
  };
}

export interface RoutinesClientOptions {
  readonly deadlineMs?: number;
}

export class RoutinesClient {
  private readonly deadlineMs: number;

  /** `fetch` is injected like `GitHubClient`'s; pass `(input, init) => fetch(input, init)` in a Worker. */
  constructor(
    private readonly fetcher: FetchLike,
    options: RoutinesClientOptions = {},
  ) {
    this.deadlineMs = options.deadlineMs ?? ROUTINE_FIRE_DEADLINE_MS;
  }

  /** Throws `InvalidRoutineConfigError` before sending anything when the id or token is malformed. */
  async fire(request: FireRequest): Promise<FireOutcome> {
    if (!isRoutineId(request.routineId)) {
      throw new InvalidRoutineConfigError('routine');
    }
    if (!isTriggerTokenShape(request.token)) {
      throw new InvalidRoutineConfigError('token');
    }
    const url = `${ROUTINES_API_ORIGIN}/v1/claude_code/routines/${request.routineId}/fire`;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${request.token}`,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: request.text.slice(0, MAX_TEXT_LENGTH) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.deadlineMs),
      });
    } catch {
      // Dropped on purpose: the error may quote the request, and "no answer" is all the caller needs.
      return { kind: 'unknown' };
    }
    if (response.ok) {
      return firedOf(response);
    }
    const status = response.status;
    if (status === 429) {
      await response.body?.cancel();
      return { kind: 'rate-limited', retryAfter: retryAfterOf(response.headers) };
    }
    if (status === 400 && (await isPausedRefusal(response))) {
      return { kind: 'paused' };
    }
    await response.body?.cancel().catch(() => undefined);
    if (status === 401) {
      return { kind: 'unauthorized' };
    }
    if (status === 404) {
      return { kind: 'not-found' };
    }
    if (status === 504 || status === 524) {
      // A gateway timeout may hide a session that did start.
      return { kind: 'unknown' };
    }
    return { kind: 'unavailable', status };
  }
}
