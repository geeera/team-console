import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { commandFailureOf, type CommandFailure, type CommandResult } from '@console/entities/team-run';
import {
  isOwnerRequest,
  isOwnerRequestState,
  type IssueRequestDto,
  type OwnerRequestBody,
  type OwnerRequestResponse,
  type OwnerRequestStatusDto,
  type RequestIssueDto,
  type RequestIssuesDto,
  type SprintRefDto,
} from '@shared/contracts';
import { firstValueFrom } from 'rxjs';

export function issueRequestUrl(slug: string, number: number): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/issues/${number}/request`;
}

export function requestIssuesUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/requests`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isNumber = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function isSprintRefOrNull(value: unknown): value is SprintRefDto | null {
  return (
    value === null ||
    (isRecord(value) &&
      Number.isSafeInteger(value['number']) &&
      isText(value['title']) &&
      isText(value['due']))
  );
}

export function isRequestStatus(value: unknown): value is OwnerRequestStatusDto {
  if (!isRecord(value)) {
    return false;
  }
  const { state, requestedAt, url, handledAt, ...request } = value;
  return (
    isOwnerRequestState(state) &&
    isText(requestedAt) &&
    isText(url) &&
    isTextOrNull(handledAt) &&
    isOwnerRequest(request)
  );
}

export function isIssueRequestDto(value: unknown): value is IssueRequestDto {
  return (
    isRecord(value) &&
    isNumber(value['number']) &&
    isText(value['title']) &&
    (value['state'] === 'open' || value['state'] === 'closed') &&
    isTextOrNull(value['milestone']) &&
    isSprintRefOrNull(value['current']) &&
    isSprintRefOrNull(value['next']) &&
    typeof value['freezeNow'] === 'boolean' &&
    (value['request'] === null || isRequestStatus(value['request']))
  );
}

function isRequestIssue(value: unknown): value is RequestIssueDto {
  return (
    isRecord(value) &&
    isNumber(value['number']) &&
    isText(value['title']) &&
    (value['request'] === null || isRequestStatus(value['request']))
  );
}

export function isRequestIssuesDto(value: unknown): value is RequestIssuesDto {
  return isRecord(value) && Array.isArray(value['items']) && value['items'].every(isRequestIssue);
}

export function isOwnerRequestResponse(value: unknown): value is OwnerRequestResponse {
  return (
    isRecord(value) &&
    isNumber(value['commentId']) &&
    isText(value['url']) &&
    isText(value['requestedAt']) &&
    typeof value['replayed'] === 'boolean'
  );
}

/**
 * The request endpoints (#219). Never throws: every outcome is a `CommandResult`. A repeat of the same send within
 * 60 s is answered from the Worker's replay, so Try again is safe inside that window.
 */
@Injectable({ providedIn: 'root' })
export class RequestChangeClient {
  private readonly http = inject(HttpClient);

  issues(slug: string): Promise<CommandResult<RequestIssuesDto>> {
    return this.call(() => this.http.get<unknown>(requestIssuesUrl(slug)), isRequestIssuesDto);
  }

  issue(slug: string, number: number): Promise<CommandResult<IssueRequestDto>> {
    return this.call(() => this.http.get<unknown>(issueRequestUrl(slug, number)), isIssueRequestDto);
  }

  send(slug: string, number: number, body: OwnerRequestBody): Promise<CommandResult<OwnerRequestResponse>> {
    return this.call(
      () => this.http.post<unknown>(issueRequestUrl(slug, number), body),
      isOwnerRequestResponse,
    );
  }

  private async call<T>(
    request: () => ReturnType<HttpClient['get']>,
    guard: (value: unknown) => value is T,
  ): Promise<CommandResult<T>> {
    let answer: unknown;
    try {
      answer = await firstValueFrom(request());
    } catch (error: unknown) {
      const failure: CommandFailure = commandFailureOf(error);
      return { ok: false, failure };
    }
    return guard(answer) ? { ok: true, value: answer } : { ok: false, failure: commandFailureOf(null) };
  }
}
