import { problem, type WorkerContext } from '@worker/core';
import { IdempotencyKeysRepo, type IdempotencyRef, type IdempotentResultKind } from '@worker/db';
import type { Identity } from '../auth/auth.types';
import type { ApiEnv } from '../env';

type Context = WorkerContext<ApiEnv>;

/** ADR 0006: a write's key is the client's, kept 24 h. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a key stays claimed by a write in flight; long enough for one D1 batch, short enough to retry. */
const CLAIM_HOLD_MS = 30_000;
// A UUID fits; anything that could smuggle a path or a separator does not.
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * One tracker write as received: the client's key, the key row it claims, a hash binding the key to exactly this
 * request, and the parsed body.
 */
export interface TrackerWrite {
  /** The `Idempotency-Key` as the client sent it (an owner decision records it). */
  readonly key: string;
  /**
   * The key row's primary key: the caller's scope and the client's key (#462, ADR 0008 row 2-0). Keys are per
   * identity, so a job reusing the owner's key (or another job's) makes a fresh request, never a replay of theirs.
   */
  readonly claimKey: string;
  readonly requestHash: string;
  /** The JSON body, `undefined` when there is none or it is not JSON (the route's check then refuses it). */
  readonly body: unknown;
}

/** Completes the claimed key inside the write's own batch, so the key is done exactly when the rows exist. */
export type CompleteKey = (
  status: number,
  kind: IdempotentResultKind,
  ref: IdempotencyRef,
) => D1PreparedStatement;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Who a key belongs to: the identity kind and the owner's login, or a job's project, role and job id (#471 security
 * review: a job id alone would let two tokens naming the same id share replays). Hashed before it is stored, so no
 * email lands in the key table.
 */
function scopeOf(identity: Identity): string {
  switch (identity.kind) {
    case 'user':
      // The door and the user row; the Access owner before the link is one principal (`access-owner`).
      return `user\n${identity.door}\n${identity.userId ?? 'access-owner'}`;
    case 'local':
      return 'local';
    case 'service':
      return `service\n${identity.commonName}`;
    case 'job':
      return `job\n${identity.projectSlug}\n${identity.role}\n${identity.jobId}`;
    case 'runner':
      return `runner\n${identity.runnerId}`;
    case 'enrolment':
      // Never reaches a tracker write (the route scope refuses it); a key of its own keeps the switch exhaustive.
      return 'enrolment';
  }
}

/** Reads the `Idempotency-Key` and the body once; 400 `idempotency-key` without a usable key. */
export async function trackerWriteOf(c: Context): Promise<TrackerWrite | Response> {
  const key = c.req.header('Idempotency-Key') ?? '';
  if (!KEY_PATTERN.test(key)) {
    return problem(c, {
      type: 'idempotency-key',
      title: 'Idempotency-Key required',
      status: 400,
      detail: 'Every tracker write carries an Idempotency-Key header of 8 to 128 letters, digits, - or _',
    });
  }
  const raw = await c.req.text();
  let body: unknown;
  try {
    body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    // Malformed JSON is the client's input, answered by the route's check; the parser's message is dropped.
    body = undefined;
  }
  const scope = scopeOf(c.get('identity'));
  const requestHash = await sha256Hex(
    [scope, c.req.method, new URL(c.req.url).pathname, c.req.header('If-Match') ?? '', raw].join('\n'),
  );
  // 32 hex characters (128 bits) of the scope keep the row's key short; `.` never occurs in a client key.
  const claimKey = `${(await sha256Hex(scope)).slice(0, 32)}.${key}`;
  return { key, claimKey, requestHash, body };
}

/**
 * Runs `write` once per key. A repeat of a completed request answers `replay(ref)` with the first status and writes
 * nothing; a repeat while the first is in flight is 409 `idempotency-in-flight`; the key on a different request is
 * 422 `idempotency-key-reused`. A refusal (any non-2xx) or a thrown error releases the claim, so the client may
 * fix the request and send it again under the same key.
 */
export async function idempotent(
  c: Context,
  request: TrackerWrite,
  replay: (ref: string, status: number) => Promise<Response>,
  write: (complete: CompleteKey) => Promise<Response>,
): Promise<Response> {
  const keys = new IdempotencyKeysRepo(c.env.DB);
  const now = Date.now();
  const claim = await keys.claim(request.claimKey, request.requestHash, now, CLAIM_HOLD_MS);
  switch (claim.state) {
    case 'mismatch':
      return problem(c, {
        type: 'idempotency-key-reused',
        title: 'Idempotency-Key already used',
        status: 422,
        detail: 'This key was used for a different request; send a new key',
      });
    case 'in-flight':
      return problem(c, {
        type: 'idempotency-in-flight',
        title: 'The same request is still being written',
        status: 409,
        retryAfter: 1,
      });
    case 'done': {
      c.get('logger').info('tracker write replayed', { kind: claim.kind });
      const response = await replay(claim.ref, claim.status);
      response.headers.set('Idempotent-Replayed', 'true');
      return response;
    }
    case 'claimed':
      break;
  }
  const complete: CompleteKey = (status, kind, ref) =>
    keys.completeStatement(
      request.claimKey,
      request.requestHash,
      { status, kind, ref },
      now + IDEMPOTENCY_TTL_MS,
    );
  let response: Response;
  try {
    response = await write(complete);
  } catch (error: unknown) {
    await keys.release(request.claimKey, request.requestHash);
    throw error;
  }
  if (!response.ok) {
    await keys.release(request.claimKey, request.requestHash);
  }
  return response;
}
