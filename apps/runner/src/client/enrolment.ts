import {
  isRunnerId,
  isUlid,
  isValidSlug,
  type EnrolRunnerInput,
  type EnrolRunnerResponse,
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
    Array.isArray(value['allowedProjects']) &&
    value['allowedProjects'].every((slug) => typeof slug === 'string' && isValidSlug(slug)) &&
    typeof value['pollSeconds'] === 'number' &&
    Number.isInteger(value['pollSeconds'])
  );
}

export async function postEnrolment(
  apiUrl: string,
  input: EnrolRunnerInput,
  fetchImpl: FetchLike,
): Promise<EnrolRunnerResponse> {
  const response = await fetchImpl(`${apiUrl}/api/v1/runner/enrol`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(input),
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status !== 201) {
    throw await apiErrorOf(response, 'enrol');
  }
  const body = await jsonOf(response);
  if (!isEnrolRunnerResponse(body)) {
    throw new RunnerApiError(response.status, null, 'enrol: unexpected answer');
  }
  return body;
}
