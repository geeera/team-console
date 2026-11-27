import type { KeyObject } from 'node:crypto';
import {
  JOB_EVENTS_MAX_PER_BATCH,
  isJobDto,
  isProblemDetails,
  isRunnerCheckClaimResponse,
  isRunnerReleaseDto,
  isRunnerScopeDto,
  isRunnerSelfDto,
  isUlid,
  problemSlugOf,
  type ClaimRunnerInput,
  type FinishJobInput,
  type FinishRunnerCheckInput,
  type HeartbeatResponse,
  type JobDto,
  type JobEventInput,
  type JobEventsResponse,
  type PauseRunnerInput,
  type RunnerCheckClaimDto,
  type RunnerReleaseDto,
  type RunnerScopeDto,
  type RunnerSelfDto,
} from '@shared/contracts';
import { redactedJsonBody } from './redact';
import { mintRunnerJwt } from './runner-jwt';

/**
 * The runner's side of `/api/v1/runner/*` (#467's door; architect note on #468, PR 1): every call carries a freshly
 * minted runner JWT, every body passes the redactor, redirects are never followed (a `Location` could carry the JWT
 * to another host), and every answer is narrowed by its contract guard before the runner acts on it.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The header a job's proxied call carries the runner JWT in (`apps/api/src/auth/runner-auth.ts`). */
export const RUNNER_JWT_HEADER = 'X-Runner-Jwt';
const REQUEST_TIMEOUT_MS = 30_000;

export class RunnerApiError extends Error {
  constructor(
    readonly status: number,
    /** The console's problem slug (`runner-jwt-replayed`, `job-lease-expired`, …), or `null` for another answer. */
    readonly problem: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'RunnerApiError';
  }
}

export interface RunnerClientOptions {
  readonly apiUrl: string;
  readonly runnerId: string;
  readonly audience: string;
  readonly privateKey: KeyObject;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
}

export type ClaimOutcome =
  | {
      readonly kind: 'job';
      readonly job: JobDto;
      readonly jobToken: string;
      readonly leaseSeconds: number;
      /**
       * The claim's `teamConfig` as sent, unjudged: the job is already held, so a bad view must reach `runJob`, which
       * refuses the launch and finishes the job (`team-config-invalid`) instead of leaving it to the lease.
       * `undefined` when the console sent none.
       */
      readonly teamConfig?: unknown;
      /**
       * The runner's scope as this claim applied it (#775): what the runner holds itself to from here on. `undefined`
       * when the console sent none (an older console) or something that is not a scope; the loop then keeps the last
       * scope it had.
       */
      readonly scope?: RunnerScopeDto;
    }
  /**
   * A runner check the console picked up for this runner (#1059): its id, a kind this claim declared, and the server's
   * display deadline. What to run for it is the runner's own table (`jobs/run-check.ts`), never the answer.
   */
  | { readonly kind: 'check'; readonly check: RunnerCheckClaimDto }
  | { readonly kind: 'idle'; readonly retryAfterSeconds: number };

/** A job's request as the proxy forwards it: the path already routed, headers already narrowed, body redacted. */
export interface ForwardRequest {
  readonly method: string;
  readonly pathAndQuery: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface ForwardResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

/** Response headers a job may see; cookies and anything hop-by-hop stay with the runner. */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'retry-after',
  'etag',
  'location',
  'x-request-id',
] as const;
const JOB_TOKEN = /^tcj_[A-Za-z0-9_-]{43}$/;
const DEFAULT_RETRY_AFTER_SECONDS = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ClaimBody =
  | { readonly kind: 'job'; readonly body: { job: JobDto; jobToken: string; leaseSeconds: number } }
  | { readonly kind: 'check'; readonly check: RunnerCheckClaimDto };

function isJobClaimBody(value: unknown): value is { job: JobDto; jobToken: string; leaseSeconds: number } {
  return (
    isRecord(value) &&
    // A body that carries a check beside a job is neither (`isClaimResponse` in the contracts).
    !Object.hasOwn(value, 'check') &&
    isJobDto(value['job']) &&
    typeof value['jobToken'] === 'string' &&
    JOB_TOKEN.test(value['jobToken']) &&
    typeof value['leaseSeconds'] === 'number' &&
    Number.isInteger(value['leaseSeconds']) &&
    value['leaseSeconds'] > 0
  );
}

/**
 * The claim's 200 answer (S2): a job as before, or exactly `{check: {id, kind, deadlineSeconds}}` with a ULID id and a
 * kind this claim declared; `null` for anything else. An extra key (`command`, `argv`, `env`, `path`, …), an unknown
 * kind, a path-shaped id or a deadline past the runner's own limit is an unexpected answer, and nothing is run.
 */
function claimBodyOf(value: unknown, declared: readonly string[]): ClaimBody | null {
  if (isRecord(value) && Object.hasOwn(value, 'check')) {
    return isRunnerCheckClaimResponse(value) && declared.includes(value.check.kind)
      ? { kind: 'check', check: value.check }
      : null;
  }
  return isJobClaimBody(value) ? { kind: 'job', body: value } : null;
}

function isHeartbeatResponse(value: unknown): value is HeartbeatResponse {
  return isRecord(value) && typeof value['leaseUntil'] === 'string';
}

function isJobEventsResponse(value: unknown): value is JobEventsResponse {
  return isRecord(value) && Number.isSafeInteger(value['lastSeq']) && typeof value['capped'] === 'boolean';
}

function retryAfterOf(response: Response): number {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isInteger(seconds) && seconds > 0 && seconds <= 3600 ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
}

function assertJobId(jobId: string): void {
  // The id is interpolated into a path: a ULID has no `/`, `.` or `%`.
  if (!isUlid(jobId)) {
    throw new TypeError('not a job id');
  }
}

export async function jsonOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RunnerApiError(
      response.status,
      null,
      `the console answered ${String(response.status)} with a body that is not JSON`,
    );
  }
}

/** The problem slug of an error answer; the body's text is never copied into the error (it is the console's). */
export async function apiErrorOf(response: Response, what: string): Promise<RunnerApiError> {
  let slug: string | null = null;
  try {
    const body = await jsonOf(response);
    slug = isProblemDetails(body) ? problemSlugOf(body.type) : null;
  } catch (error: unknown) {
    if (!(error instanceof RunnerApiError)) {
      throw error;
    }
  }
  return new RunnerApiError(
    response.status,
    slug,
    `${what}: the console answered ${String(response.status)}${slug === null ? '' : ` (${slug})`}`,
  );
}

export class RunnerClient {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(private readonly options: RunnerClientOptions) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? (() => new Date());
  }

  /** A new JWT per call: the console refuses a `jti` it has seen. */
  runnerJwt(): string {
    return mintRunnerJwt({
      privateKey: this.options.privateKey,
      runnerId: this.options.runnerId,
      audience: this.options.audience,
      now: this.now(),
    });
  }

  async release(): Promise<RunnerReleaseDto> {
    const response = await this.send('GET', '/api/v1/runner/release', undefined);
    if (response.status !== 200) {
      throw await apiErrorOf(response, 'release');
    }
    const body = await jsonOf(response);
    if (!isRunnerReleaseDto(body)) {
      throw new RunnerApiError(response.status, null, 'release: unexpected answer');
    }
    return body;
  }

  /** The runner's own row and the projects its scope serves now (#775), to hold itself to without a restart. */
  async self(): Promise<RunnerSelfDto> {
    const response = await this.send('GET', '/api/v1/runner/self', undefined);
    if (response.status !== 200) {
      throw await apiErrorOf(response, 'self');
    }
    const body = await jsonOf(response);
    if (!isRunnerSelfDto(body)) {
      throw new RunnerApiError(response.status, null, 'self: unexpected answer');
    }
    return body;
  }

  /** `input` is the declaration of what the credential serves (#775); `{}` declares nothing, as before. */
  async claim(input: ClaimRunnerInput = {}): Promise<ClaimOutcome> {
    const response = await this.send('POST', '/api/v1/runner/jobs/claim', input);
    if (response.status === 204) {
      return { kind: 'idle', retryAfterSeconds: retryAfterOf(response) };
    }
    if (response.status !== 200) {
      throw await apiErrorOf(response, 'claim');
    }
    const answer = claimBodyOf(await jsonOf(response), input.checks ?? []);
    if (answer === null) {
      throw new RunnerApiError(response.status, null, 'claim: unexpected answer');
    }
    if (answer.kind === 'check') {
      const { id, kind, deadlineSeconds } = answer.check;
      return { kind: 'check', check: { id, kind, deadlineSeconds } };
    }
    const { body } = answer;
    const scope = (body as Record<string, unknown>)['scope'];
    return {
      kind: 'job',
      job: body.job,
      jobToken: body.jobToken,
      leaseSeconds: body.leaseSeconds,
      ...(Object.hasOwn(body, 'teamConfig')
        ? { teamConfig: (body as Record<string, unknown>)['teamConfig'] }
        : {}),
      ...(isRunnerScopeDto(scope) ? { scope } : {}),
    };
  }

  async heartbeat(jobId: string): Promise<HeartbeatResponse> {
    assertJobId(jobId);
    const response = await this.send('POST', `/api/v1/runner/jobs/${jobId}/heartbeat`, {});
    if (response.status !== 200) {
      throw await apiErrorOf(response, 'heartbeat');
    }
    const body = await jsonOf(response);
    if (!isHeartbeatResponse(body)) {
      throw new RunnerApiError(response.status, null, 'heartbeat: unexpected answer');
    }
    return body;
  }

  /** Posts events in batches the console accepts (≤ 50); the answer of the last batch. */
  async events(jobId: string, events: readonly JobEventInput[]): Promise<JobEventsResponse> {
    assertJobId(jobId);
    if (events.length === 0) {
      throw new RangeError('events: nothing to send');
    }
    let last: JobEventsResponse | null = null;
    for (let start = 0; start < events.length; start += JOB_EVENTS_MAX_PER_BATCH) {
      const batch = events.slice(start, start + JOB_EVENTS_MAX_PER_BATCH);
      const response = await this.send('POST', `/api/v1/runner/jobs/${jobId}/events`, { events: batch });
      if (response.status !== 201) {
        throw await apiErrorOf(response, 'events');
      }
      const body = await jsonOf(response);
      if (!isJobEventsResponse(body)) {
        throw new RunnerApiError(response.status, null, 'events: unexpected answer');
      }
      last = body;
    }
    if (last === null) {
      throw new RangeError('events: nothing was sent');
    }
    return last;
  }

  async finish(jobId: string, input: FinishJobInput): Promise<void> {
    assertJobId(jobId);
    const response = await this.send('POST', `/api/v1/runner/jobs/${jobId}/finish`, input);
    if (response.status !== 200) {
      throw await apiErrorOf(response, 'finish');
    }
    await response.body?.cancel();
  }

  /** Reports a runner check (#1059): 204 on the runner's own running check, one 404 for anything else. */
  async finishCheck(checkId: string, input: FinishRunnerCheckInput): Promise<void> {
    if (!isUlid(checkId)) {
      throw new TypeError('not a check id');
    }
    const response = await this.send('POST', `/api/v1/runner/checks/${checkId}/finish`, input);
    if (response.status !== 204 && response.status !== 200) {
      throw await apiErrorOf(response, 'check finish');
    }
    await response.body?.cancel();
  }

  /** Mirrors the runner's local pause (#571): the console's claim skips this runner until `until`. */
  async pause(input: PauseRunnerInput): Promise<void> {
    const response = await this.send('POST', '/api/v1/runner/pause', input);
    if (response.status !== 200) {
      throw await apiErrorOf(response, 'pause');
    }
    await response.body?.cancel();
  }

  /** Lifts the mirrored pause once the local one has ended. */
  async resume(): Promise<void> {
    const response = await this.send('POST', '/api/v1/runner/resume', {});
    if (response.status !== 200) {
      throw await apiErrorOf(response, 'resume');
    }
    await response.body?.cancel();
  }

  /** A job's call to its own project: its token as the Bearer, this runner's JWT beside it (R4). */
  async forwardForProject(jobToken: string, request: ForwardRequest): Promise<ForwardResponse> {
    return this.forward(request, {
      Authorization: `Bearer ${jobToken}`,
      [RUNNER_JWT_HEADER]: this.runnerJwt(),
    });
  }

  /** A job's call to its own run log or heartbeat (the plugin's `runlog` port): the runner JWT is the credential. */
  async forwardForRunnerJob(request: ForwardRequest): Promise<ForwardResponse> {
    return this.forward(request, { Authorization: `Bearer ${this.runnerJwt()}` });
  }

  private async forward(
    request: ForwardRequest,
    credentials: Record<string, string>,
  ): Promise<ForwardResponse> {
    const response = await this.fetchImpl(`${this.options.apiUrl}${request.pathAndQuery}`, {
      method: request.method,
      headers: { ...request.headers, ...credentials },
      ...(request.body === null ? {} : { body: request.body }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) {
        headers[name] = value;
      }
    }
    return { status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) };
  }

  private async send(method: 'GET' | 'POST', path: string, body: unknown): Promise<Response> {
    return this.fetchImpl(`${this.options.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.runnerJwt()}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: redactedJsonBody(body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
}
