import {
  OIDC_EXCHANGE_CLAIMS,
  OIDC_TOKEN_MAX_LENGTH,
  isOidcExchangeResponse,
  isProblemDetails,
  problemSlugOf,
  type OidcExchangeClaim,
  type OidcExchangeInput,
  type OidcExchangeResponse,
} from '@shared/contracts';
import { RunnerApiError, jsonOf, type FetchLike } from './runner-client';

/**
 * The two calls an Actions run makes before it has a runner identity (#669; architect note on #573): GitHub's OIDC
 * token request (`ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN`, with the console's runner audience), then
 * `POST /api/v1/runner/oidc-exchange` with that token, the job id and the VM's in-memory public key. Neither the
 * request token, the OIDC token nor any answer body ever reaches an error message: a refusal names the HTTP status,
 * the problem slug and, for the exchange, the claim the console named.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const JOB_TOKEN = /^tcj_[A-Za-z0-9_-]{43}$/;
/** A JWS in compact form: three base64url segments, the signature non-empty (GitHub signs RS256). */
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** A failure of the run's own setup (env, GitHub's token endpoint), told in plain words with no secret in them. */
export class ActionsRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionsRunError';
  }
}

/**
 * GitHub's token request URL, or `null`: `https` (plain `http` only on a loopback host, for the local stack), no
 * credentials or fragment. It carries a query (`api-version`), kept as given.
 */
export function idTokenRequestUrlOf(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Not a URL: an answer (`null`), the caller names the variable.
    return null;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  return secure && url.username === '' && url.password === '' && url.hash === '' ? url : null;
}

export interface IdTokenRequest {
  readonly url: URL;
  /** `ACTIONS_ID_TOKEN_REQUEST_TOKEN`: sent as the bearer to GitHub's endpoint only. */
  readonly token: string;
  readonly audience: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The run's OIDC token for `audience`, from GitHub's endpoint; never logged, never part of an error. */
export async function requestActionsIdToken(request: IdTokenRequest, fetchImpl: FetchLike): Promise<string> {
  const url = new URL(request.url);
  url.searchParams.set('audience', request.audience);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${request.token}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    if (error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')) {
      throw new ActionsRunError('GitHub’s OIDC token endpoint could not be reached.');
    }
    throw error;
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new ActionsRunError(
      `GitHub refused the OIDC token request (${String(response.status)}); the workflow needs permissions: id-token: write.`,
    );
  }
  let body: unknown;
  try {
    body = await jsonOf(response);
  } catch (error: unknown) {
    if (error instanceof RunnerApiError) {
      throw new ActionsRunError('GitHub’s OIDC token endpoint answered with a body that is not JSON.');
    }
    throw error;
  }
  const value = isRecord(body) ? body['value'] : undefined;
  if (typeof value !== 'string' || value.length > OIDC_TOKEN_MAX_LENGTH || !COMPACT_JWS.test(value)) {
    throw new ActionsRunError('GitHub’s OIDC token endpoint did not answer a token.');
  }
  return value;
}

const isExchangeClaim = (value: unknown): value is OidcExchangeClaim =>
  (OIDC_EXCHANGE_CLAIMS as readonly unknown[]).includes(value);

/** The exchange's refusal: the problem slug and, when the console named one of its claims, that claim. */
async function exchangeErrorOf(response: Response): Promise<RunnerApiError> {
  let slug: string | null = null;
  let claim: OidcExchangeClaim | null = null;
  try {
    const body = await jsonOf(response);
    if (isProblemDetails(body)) {
      slug = problemSlugOf(body.type);
      const named = (body as unknown as Record<string, unknown>)['claim'];
      claim = isExchangeClaim(named) ? named : null;
    }
  } catch (error: unknown) {
    if (!(error instanceof RunnerApiError)) {
      throw error;
    }
  }
  const detail = [slug, claim === null ? null : `claim ${claim}`].filter((part) => part !== null).join(', ');
  return new RunnerApiError(
    response.status,
    slug,
    `the console answered ${String(response.status)}${detail === '' ? '' : ` (${detail})`}`,
  );
}

/**
 * `POST /api/v1/runner/oidc-exchange`. Its body carries the OIDC token by design, so, like `enrol`'s, it does not go
 * through the redactor; it goes to the console's origin only and redirects are never followed.
 */
export async function postOidcExchange(
  apiUrl: string,
  input: OidcExchangeInput,
  fetchImpl: FetchLike,
): Promise<OidcExchangeResponse> {
  const response = await fetchImpl(`${apiUrl}/api/v1/runner/oidc-exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(input),
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    throw await exchangeErrorOf(response);
  }
  const body = await jsonOf(response);
  if (!isOidcExchangeResponse(body) || !JOB_TOKEN.test(body.jobToken) || body.job.id !== input.jobId) {
    throw new RunnerApiError(response.status, null, 'oidc exchange: unexpected answer');
  }
  return body;
}
