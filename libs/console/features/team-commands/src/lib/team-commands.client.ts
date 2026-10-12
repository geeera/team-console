import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { commandFailureOf, type CommandResult } from '@console/entities/team-run';
import type { PauseRequest, RunResponse, TeamCommandResponse, TeamSlot } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';

export function teamCommandUrl(slug: string, command: 'pause' | 'resume'): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/team/${command}`;
}

export function runUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/runs`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCommandResponse(value: unknown): value is TeamCommandResponse {
  return (
    isRecord(value) &&
    (value['state'] === 'running' ||
      value['state'] === 'paused-by-owner' ||
      value['state'] === 'paused-by-team') &&
    typeof value['runLogUrl'] === 'string' &&
    typeof value['commentUrl'] === 'string' &&
    typeof value['replayed'] === 'boolean'
  );
}

function isRunResponse(value: unknown): value is RunResponse {
  return (
    isRecord(value) &&
    typeof value['slot'] === 'string' &&
    typeof value['requestedAt'] === 'string' &&
    typeof value['lockedUntil'] === 'string' &&
    (value['runLogUrl'] === null || typeof value['runLogUrl'] === 'string')
  );
}

/**
 * The team-command endpoints (#114). Never throws: every outcome is a `CommandResult`. A repeat of pause or resume is
 * safe (the Worker replays it within 60 s); a repeat of Run now is refused by the request lock, never fired twice.
 */
@Injectable({ providedIn: 'root' })
export class TeamCommandsClient {
  private readonly http = inject(HttpClient);

  pause(slug: string, reason: string): Promise<CommandResult<TeamCommandResponse>> {
    const body: PauseRequest = reason === '' ? {} : { reason };
    return this.post(teamCommandUrl(slug, 'pause'), body, isCommandResponse);
  }

  resume(slug: string): Promise<CommandResult<TeamCommandResponse>> {
    return this.post(teamCommandUrl(slug, 'resume'), {}, isCommandResponse);
  }

  run(slug: string, slot: TeamSlot): Promise<CommandResult<RunResponse>> {
    return this.post(runUrl(slug), { slot }, isRunResponse);
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
    // A 2xx we cannot read: the status read that follows tells what happened.
    return guard(answer) ? { ok: true, value: answer } : { ok: false, failure: commandFailureOf(null) };
  }
}
