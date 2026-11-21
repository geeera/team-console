import {
  isPollEnrolmentPendingDto,
  isRunnerId,
  isStartEnrolmentResponse,
  isRunnerProjectScopeDto,
  isUlid,
  isValidSlug,
  type EnrolRunnerInput,
  type EnrolRunnerResponse,
  type PollEnrolmentInput,
  type StartEnrolmentInput,
  type StartEnrolmentResponse,
} from '@shared/contracts';
import { RunnerApiError, apiErrorOf, jsonOf, type FetchLike } from './runner-client';

/**
 * `POST /api/v1/runner/enrol`: the one call without a runner JWT (the runner has no id yet). Its body carries the
 * one-time code by design, so it is the one body that does not go through the redactor; the code is never logged
 * or written anywhere by the runner.
 */

const REQUEST_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isEnrolRunnerResponse(value: unknown): value is EnrolRunnerResponse {
  return (
    isRecord(value) &&
    isRunnerId(value['runnerId']) &&
    isUlid(value['accountId']) &&
    typeof value['name'] === 'string' &&
    typeof value['audience'] === 'string' &&
    isRunnerProjectScopeDto(value) &&
    value['allowedProjects'].every((slug) => isValidSlug(slug)) &&
    typeof value['pollSeconds'] === 'number' &&
    Number.isInteger(value['pollSeconds'])
  );
}

async function postDoor(apiUrl: string, path: string, body: unknown, fetchImpl: FetchLike): Promise<Response> {
  return await fetchImpl(`${apiUrl}/api/v1/runner/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * `POST /api/v1/runner/enrol/start` (#634): binds this host's public key to the owner's enrolment intent. Its body
 * holds an identifier and the public key, no secret; the poll token in the answer is kept in memory only.
 */
export async function startEnrolment(
  apiUrl: string,
  input: StartEnrolmentInput,
  fetchImpl: FetchLike,
): Promise<StartEnrolmentResponse> {
  const response = await postDoor(apiUrl, 'enrol/start', input, fetchImpl);
  if (response.status !== 200) {
    throw await apiErrorOf(response, 'enrol start');
  }
  const body = await jsonOf(response);
  if (!isStartEnrolmentResponse(body)) {
    throw new RunnerApiError(response.status, null, 'enrol start: unexpected answer');
  }
  return body;
}

export type PollOutcome =
  | { readonly kind: 'pending'; readonly intervalSeconds: number }
  | { readonly kind: 'enrolled'; readonly enrolment: EnrolRunnerResponse };

/** `POST /api/v1/runner/enrol/poll`: 202 while the owner has not approved, 429 `slow-down` too early, 200 once. */
export async function pollEnrolment(
  apiUrl: string,
  input: PollEnrolmentInput,
  fetchImpl: FetchLike,
): Promise<PollOutcome> {
  const response = await postDoor(apiUrl, 'enrol/poll', input, fetchImpl);
  if (response.status === 202) {
    const body = await jsonOf(response);
    if (!isPollEnrolmentPendingDto(body)) {
      throw new RunnerApiError(response.status, null, 'enrol poll: unexpected answer');
    }
    return { kind: 'pending', intervalSeconds: body.intervalSeconds };
  }
  if (response.status !== 200) {
    throw await apiErrorOf(response, 'enrol poll');
  }
  const body = await jsonOf(response);
  if (!isEnrolRunnerResponse(body)) {
    throw new RunnerApiError(response.status, null, 'enrol poll: unexpected answer');
  }
  return { kind: 'enrolled', enrolment: body };
}

export async function postEnrolment(
  apiUrl: string,
  input: EnrolRunnerInput,
  fetchImpl: FetchLike,
): Promise<EnrolRunnerResponse> {
  const response = await postDoor(apiUrl, 'enrol', input, fetchImpl);
  if (response.status !== 201) {
    throw await apiErrorOf(response, 'enrol');
  }
  const body = await jsonOf(response);
  if (!isEnrolRunnerResponse(body)) {
    throw new RunnerApiError(response.status, null, 'enrol: unexpected answer');
  }
  return body;
}
