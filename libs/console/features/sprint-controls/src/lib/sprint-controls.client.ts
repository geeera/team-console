import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { commandFailureOf, type CommandResult } from '@console/entities/team-run';
import {
  isCalendarDate,
  type MoveDemoRequest,
  type MoveDemoResponse,
  type NextSprintRequest,
  type NextSprintResponse,
  type SprintRefDto,
} from '@shared/contracts';
import { firstValueFrom } from 'rxjs';

export function moveDemoUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/sprint/demo-date`;
}

export function nextSprintUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/sprint/next`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSprintRef(value: unknown): value is SprintRefDto {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value['number']) &&
    typeof value['title'] === 'string' &&
    isCalendarDate(value['due'])
  );
}

export function isMoveDemoResponse(value: unknown): value is MoveDemoResponse {
  return (
    isRecord(value) &&
    isSprintRef(value['sprint']) &&
    isRecord(value['freeze']) &&
    isCalendarDate(value['freeze']['from']) &&
    isCalendarDate(value['freeze']['to']) &&
    typeof value['freezeStartsNow'] === 'boolean'
  );
}

export function isNextSprintResponse(value: unknown): value is NextSprintResponse {
  return (
    isRecord(value) &&
    isSprintRef(value['sprint']) &&
    (value['becomesCurrentAfter'] === null || isCalendarDate(value['becomesCurrentAfter']))
  );
}

/**
 * The sprint-command endpoints (#218). Never throws: every outcome is a `CommandResult`. A repeat is safe — the
 * Worker decides on the live milestones, so a second press finds the state the first one wrote and refuses it.
 */
@Injectable({ providedIn: 'root' })
export class SprintControlsClient {
  private readonly http = inject(HttpClient);

  moveDemo(slug: string, request: MoveDemoRequest): Promise<CommandResult<MoveDemoResponse>> {
    return this.post(moveDemoUrl(slug), request, isMoveDemoResponse);
  }

  startNext(slug: string, request: NextSprintRequest): Promise<CommandResult<NextSprintResponse>> {
    return this.post(nextSprintUrl(slug), request, isNextSprintResponse);
  }

  private async post<T>(
    url: string,
    body: unknown,
    guard: (value: unknown) => value is T,
  ): Promise<CommandResult<T>> {
    let answer: unknown;
    try {
      answer = await firstValueFrom(this.http.post<unknown>(url, body));
    } catch (error: unknown) {
      return { ok: false, failure: commandFailureOf(error) };
    }
    // A 2xx we cannot read: the status read that follows shows what happened.
    return guard(answer) ? { ok: true, value: answer } : { ok: false, failure: commandFailureOf(null) };
  }
}
