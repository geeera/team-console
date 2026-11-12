import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  isAccountMembershipListDto,
  isEnrolmentCodeDto,
  isRunnerDto,
  isRunnerListDto,
  isRunnerPolicyDto,
  type AccountMembershipDto,
  type CreateEnrolmentCodeInput,
  type EnrolmentCodeDto,
  type RunnerDto,
  type RunnerListDto,
  type RunnerPolicy,
  type RunnerPolicyDto,
} from '@shared/contracts';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import { RUNNER_CALL_TIMEOUT_MS, runnerFailureOf, type RunnerResult } from './runner-failure';

export const ACCOUNTS_URL = '/api/v1/accounts';

/** `/api/v1/accounts/:id/…`: the id comes from `GET /accounts` and is encoded; nothing else reaches the path. */
export function accountUrl(accountId: string): string {
  return `${ACCOUNTS_URL}/${encodeURIComponent(accountId)}`;
}

export function runnersUrl(accountId: string): string {
  return `${accountUrl(accountId)}/runners`;
}

export function runnerUrl(accountId: string, runnerId: string): string {
  return `${runnersUrl(accountId)}/${encodeURIComponent(runnerId)}`;
}

export function projectRunnerPolicyUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/runner-policy`;
}

/** Where a placement policy is read and written: the account default or one project's own. */
export type RunnerPolicyScope =
  | { readonly kind: 'account'; readonly accountId: string }
  | { readonly kind: 'project'; readonly slug: string };

function policyUrlOf(scope: RunnerPolicyScope): string {
  return scope.kind === 'account' ? `${accountUrl(scope.accountId)}/runner-policy` : projectRunnerPolicyUrl(scope.slug);
}

/** A 204: HttpClient reads the empty body as `null`. */
const isNoContent = (value: unknown): value is null => value === null;

/** An answer of the wrong shape is not shown: it reads as `error`, like a failed call. */
const MALFORMED = { ok: false, failure: { kind: 'error', slug: null, field: null } } as const;

/**
 * The HTTP surface of Settings › Runners (#464) over the routes of #467: the caller's accounts, the account's runners
 * (enrolment code, list, allowed projects, revoke) and placement per account and per project. Never throws: every
 * call is a `RunnerResult`, every answer is checked by its guard before a screen sees it.
 */
@Injectable({ providedIn: 'root' })
export class RunnersApi {
  private readonly http = inject(HttpClient);

  async accounts(): Promise<RunnerResult<readonly AccountMembershipDto[]>> {
    const read = await this.call(this.http.get<unknown>(ACCOUNTS_URL), isAccountMembershipListDto);
    return read.ok ? { ok: true, value: read.value.accounts } : read;
  }

  list(accountId: string): Promise<RunnerResult<RunnerListDto>> {
    return this.call(this.http.get<unknown>(runnersUrl(accountId)), isRunnerListDto);
  }

  /** The code is in the answer once; the caller shows it and keeps it nowhere else. */
  createEnrolmentCode(accountId: string, input: CreateEnrolmentCodeInput): Promise<RunnerResult<EnrolmentCodeDto>> {
    return this.call(this.http.post<unknown>(`${runnersUrl(accountId)}/enrolment-code`, input), isEnrolmentCodeDto);
  }

  setAllowedProjects(
    accountId: string,
    runnerId: string,
    allowedProjects: readonly string[],
  ): Promise<RunnerResult<RunnerDto>> {
    return this.call(this.http.patch<unknown>(runnerUrl(accountId, runnerId), { allowedProjects }), isRunnerDto);
  }

  revoke(accountId: string, runnerId: string): Promise<RunnerResult<RunnerDto>> {
    return this.call(this.http.post<unknown>(`${runnerUrl(accountId, runnerId)}/revoke`, {}), isRunnerDto);
  }

  clearSuspect(accountId: string, runnerId: string): Promise<RunnerResult<RunnerDto>> {
    return this.call(this.http.post<unknown>(`${runnerUrl(accountId, runnerId)}/clear-suspect`, {}), isRunnerDto);
  }

  /** `id` is a pending code's `PendingEnrolmentDto.id` (its hash); the Worker answers 204. */
  withdrawEnrolment(accountId: string, id: string): Promise<RunnerResult<null>> {
    const url = `${runnersUrl(accountId)}/enrolment-codes/${encodeURIComponent(id)}/withdraw`;
    return this.call(this.http.post<unknown>(url, {}), isNoContent);
  }

  policy(scope: RunnerPolicyScope): Promise<RunnerResult<RunnerPolicyDto>> {
    return this.call(this.http.get<unknown>(policyUrlOf(scope)), isRunnerPolicyDto);
  }

  /** `null` clears a project's own policy (it falls back to the account default) or the account default (`any`). */
  setPolicy(scope: RunnerPolicyScope, policy: RunnerPolicy | null): Promise<RunnerResult<RunnerPolicyDto>> {
    // HttpClient sends no body for `null`; the route reads the JSON literal `null` as "clear".
    const body = policy === null ? 'null' : JSON.stringify(policy);
    const headers = new HttpHeaders({ 'Content-Type': 'application/json' });
    return this.call(this.http.put<unknown>(policyUrlOf(scope), body, { headers }), isRunnerPolicyDto);
  }

  private async call<T>(request: Observable<unknown>, is: (value: unknown) => value is T): Promise<RunnerResult<T>> {
    try {
      const body = await firstValueFrom(request.pipe(timeout(RUNNER_CALL_TIMEOUT_MS)));
      return is(body) ? { ok: true, value: body } : MALFORMED;
    } catch (error: unknown) {
      return { ok: false, failure: runnerFailureOf(error) };
    }
  }
}
