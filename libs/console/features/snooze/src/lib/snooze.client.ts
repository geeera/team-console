import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { httpProblemOf } from '@console/shared/api';
import { isSnoozeDto, type SnoozeDto, type SnoozeRequest } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';

export function snoozeUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/notifications/snooze`;
}

/**
 * Why a snooze change did not happen. The Worker refuses nothing the dialog can send except by a bug or a clock far
 * off, and a 403/404 means the same to the owner as an outage: nothing changed.
 */
export type SnoozeFailure = 'offline' | 'server';

export type SnoozeResult =
  { readonly ok: true; readonly snooze: SnoozeDto } | { readonly ok: false; readonly failure: SnoozeFailure };

function failureOf(error: unknown): SnoozeFailure {
  return httpProblemOf(error).status === 0 ? 'offline' : 'server';
}

/**
 * `PUT` / `DELETE …/notifications/snooze` (#221). Every HTTP outcome is a `SnoozeResult` (anything else is a bug and
 * is thrown on); both calls are idempotent, so Try again repeats safely.
 */
@Injectable({ providedIn: 'root' })
export class SnoozeClient {
  private readonly http = inject(HttpClient);

  async snooze(slug: string, request: SnoozeRequest): Promise<SnoozeResult> {
    try {
      return this.resultOf(await firstValueFrom(this.http.put<unknown>(snoozeUrl(slug), request)));
    } catch (error: unknown) {
      return { ok: false, failure: failureOf(error) };
    }
  }

  async turnBackOn(slug: string): Promise<SnoozeResult> {
    try {
      return this.resultOf(await firstValueFrom(this.http.delete<unknown>(snoozeUrl(slug))));
    } catch (error: unknown) {
      return { ok: false, failure: failureOf(error) };
    }
  }

  private resultOf(body: unknown): SnoozeResult {
    return isSnoozeDto(body) ? { ok: true, snooze: body } : { ok: false, failure: 'server' };
  }
}
