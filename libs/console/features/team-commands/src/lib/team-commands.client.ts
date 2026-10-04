import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { httpProblemOf } from '@console/shared/api';
import type { PauseRequest, RunResponse, TeamCommandResponse, TeamSlot } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';

export function teamCommandUrl(slug: string, command: 'pause' | 'resume'): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/team/${command}`;
}

export function runUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/runs`;
}

/** Why a command did not do what was asked, as the panel words it. Each maps to `commands.*` copy. */
export type CommandFailureKind =
  // nothing changed: the run log already says so
  | 'already-paused'
  | 'not-paused'
  | 'run-in-progress'
  | 'run-requested'
  // nobody knows yet
  | 'routine-unknown'
  // refused, the dialog stays open
  | 'rate-limited'
  | 'routine-paused'
  | 'bad-token'
  | 'bad-routine'
  | 'not-configured'
  | 'run-paused'
  | 'service'
  | 'github'
  | 'github-rate-limited'
  | 'not-connected'
  | 'no-run-log'
  | 'pause-unreliable'
  | 'offline'
  | 'unknown';

export interface CommandFailure {
  readonly kind: CommandFailureKind;
  /** Seconds from `Retry-After`, when the answer carried one. */
  readonly retryAfter: number | null;
  /** Still untrusted: read with `textOf`. */
  readonly extensions: Readonly<Record<string, unknown>>;
}

export type CommandResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: CommandFailure };

const BY_PROBLEM: Readonly<Record<string, CommandFailureKind>> = {
  'team-already-paused': 'already-paused',
  'team-not-paused': 'not-paused',
  'team-command-in-progress': 'github',
  'run-in-progress': 'run-in-progress',
  'run-requested': 'run-requested',
  'routine-unknown': 'routine-unknown',
  'routine-rate-limited': 'rate-limited',
  'routine-paused': 'routine-paused',
  'routine-unavailable': 'service',
  'run-paused': 'run-paused',
  'run-log-missing': 'no-run-log',
  'pause-unreliable': 'pause-unreliable',
  'github-owner-not-connected': 'not-connected',
  'github-owner-mismatch': 'not-connected',
  'github-rate-limit': 'github-rate-limited',
  'github-unavailable': 'github',
  'github-unexpected': 'github',
  'github-auth': 'github',
};

/** A string extension member, or `null` (the client never assumes a problem's shape). */
export function textOf(failure: CommandFailure, name: string): string | null {
  const value = failure.extensions[name];
  return typeof value === 'string' ? value : null;
}

/** The failure behind an error of a command request; branches on the problem `type` only. */
export function commandFailureOf(error: unknown): CommandFailure {
  if (!(error instanceof HttpErrorResponse)) {
    return { kind: 'unknown', retryAfter: null, extensions: {} };
  }
  const problem = httpProblemOf(error);
  if (problem.status === 0) {
    return { kind: 'offline', retryAfter: null, extensions: {} };
  }
  let kind: CommandFailureKind = (problem.slug !== null ? BY_PROBLEM[problem.slug] : undefined) ?? 'unknown';
  if (problem.slug === 'routine-not-configured') {
    const step = problem.extensions['step'];
    kind = step === 'token' ? 'bad-token' : step === 'routine' ? 'bad-routine' : 'not-configured';
  }
  return { kind, retryAfter: problem.retryAfterSeconds, extensions: problem.extensions };
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
