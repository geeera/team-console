import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  isAccountMemberDto,
  isAccountMembershipListDto,
  isEnrolmentCodeDto,
  isEnrolmentIntentCreatedDto,
  isEnrolmentIntentDto,
  isRunnerDto,
  isRunnerListDto,
  isRunnerPolicyDto,
  isProjectDispatchDto,
  isRecord,
  type AccountMemberDto,
  type AccountMembershipDto,
  type CreateEnrolmentCodeInput,
  type CreateEnrolmentIntentInput,
  type EnrolmentCodeDto,
  type EnrolmentIntentCreatedDto,
  type EnrolmentIntentDto,
  type ProjectDispatch,
  type ProjectDispatchDto,
  type RunnerDto,
  type RunnerListDto,
  type RunnerPolicy,
  type RunnerPolicyDto,
  type UpdateRunnerInput,
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

/**
 * `…/runners/enrolment-intents/:intent` (#634 PR 4): the id sits in the path of the owner's own calls only, never in a
 * query string, a page URL or a log line of ours.
 */
export function enrolmentIntentUrl(accountId: string, intentId: string): string {
  return `${runnersUrl(accountId)}/enrolment-intents/${encodeURIComponent(intentId)}`;
}

export function projectRunnerPolicyUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/runner-policy`;
}

export function projectDispatchUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/dispatch`;
}

/** Where a placement policy is read and written: the account default or one project's own. */
export type RunnerPolicyScope =
  | { readonly kind: 'account'; readonly accountId: string }
  | { readonly kind: 'project'; readonly slug: string };

function policyUrlOf(scope: RunnerPolicyScope): string {
  return scope.kind === 'account'
    ? `${accountUrl(scope.accountId)}/runner-policy`
    : projectRunnerPolicyUrl(scope.slug);
}

/** A 204: HttpClient reads the empty body as `null`. */
const isNoContent = (value: unknown): value is null => value === null;

const isMemberList = (value: unknown): value is { readonly members: readonly AccountMemberDto[] } =>
  isRecord(value) && Array.isArray(value['members']) && value['members'].every(isAccountMemberDto);

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
  createEnrolmentCode(
    accountId: string,
    input: CreateEnrolmentCodeInput,
  ): Promise<RunnerResult<EnrolmentCodeDto>> {
    return this.call(
      this.http.post<unknown>(`${runnersUrl(accountId)}/enrolment-code`, input),
      isEnrolmentCodeDto,
    );
  }

  /** How many owners the account has (#634 PR 4, D3): the wizard words the scope for several owners. */
  async ownerCount(accountId: string): Promise<RunnerResult<number>> {
    const read = await this.call(this.http.get<unknown>(`${accountUrl(accountId)}/members`), isMemberList);
    return read.ok
      ? { ok: true, value: read.value.members.filter((member) => member.role === 'owner').length }
      : read;
  }

  /**
   * An enrolment intent (#634 PR 3): an id and the API's own command text, no credential. The wizard keeps the id in
   * its memory only.
   */
  createEnrolmentIntent(
    accountId: string,
    input: CreateEnrolmentIntentInput,
  ): Promise<RunnerResult<EnrolmentIntentCreatedDto>> {
    const body: CreateEnrolmentIntentInput = {
      name: input.name,
      projectScope: input.projectScope,
      allowedProjects: input.projectScope === 'all' ? [] : input.allowedProjects,
      isolation: input.isolation,
    };
    return this.call(
      this.http.post<unknown>(`${runnersUrl(accountId)}/enrolment-intents`, body),
      isEnrolmentIntentCreatedDto,
    );
  }

  enrolmentIntent(accountId: string, intentId: string): Promise<RunnerResult<EnrolmentIntentDto>> {
    return this.call(this.http.get<unknown>(enrolmentIntentUrl(accountId, intentId)), isEnrolmentIntentDto);
  }

  /** Compare-and-set (R-INT-1): `fingerprint` is the one the owner was shown, never one read again. */
  approveEnrolmentIntent(
    accountId: string,
    intentId: string,
    fingerprint: string,
  ): Promise<RunnerResult<EnrolmentIntentDto>> {
    const url = `${enrolmentIntentUrl(accountId, intentId)}/approve`;
    return this.call(this.http.post<unknown>(url, { fingerprint }), isEnrolmentIntentDto);
  }

  /**
   * Answered 204; a request that is already gone is 404 `enrolment-not-found`. `keepalive` lets the call outlive the
   * page, for the wizard's withdraw on `pagehide` (#878).
   */
  withdrawEnrolmentIntent(
    accountId: string,
    intentId: string,
    { keepalive = false }: { readonly keepalive?: boolean } = {},
  ): Promise<RunnerResult<null>> {
    const url = `${enrolmentIntentUrl(accountId, intentId)}/withdraw`;
    return this.call(this.http.post<unknown>(url, {}, keepalive ? { keepalive } : {}), isNoContent);
  }

  /** The runner's scope (#775): `all`, or `selected` with its list; `allowedProjects` is `[]` under `all`. */
  setScope(accountId: string, runnerId: string, scope: UpdateRunnerInput): Promise<RunnerResult<RunnerDto>> {
    const body: UpdateRunnerInput = {
      projectScope: scope.projectScope,
      allowedProjects: scope.projectScope === 'all' ? [] : scope.allowedProjects,
    };
    return this.call(this.http.patch<unknown>(runnerUrl(accountId, runnerId), body), isRunnerDto);
  }

  revoke(accountId: string, runnerId: string): Promise<RunnerResult<RunnerDto>> {
    return this.call(this.http.post<unknown>(`${runnerUrl(accountId, runnerId)}/revoke`, {}), isRunnerDto);
  }

  /** #827: the sole owner records themselves as the enroller of a runner from before that was recorded. */
  claimEnroller(accountId: string, runnerId: string): Promise<RunnerResult<RunnerDto>> {
    return this.call(
      this.http.post<unknown>(`${runnerUrl(accountId, runnerId)}/claim-enroller`, {}),
      isRunnerDto,
    );
  }

  clearSuspect(accountId: string, runnerId: string): Promise<RunnerResult<RunnerDto>> {
    return this.call(
      this.http.post<unknown>(`${runnerUrl(accountId, runnerId)}/clear-suspect`, {}),
      isRunnerDto,
    );
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

  /** How the project's jobs reach a runner (#670): `pull`, or a GitHub Actions run per job. */
  dispatch(slug: string): Promise<RunnerResult<ProjectDispatchDto>> {
    return this.call(this.http.get<unknown>(projectDispatchUrl(slug)), isProjectDispatchDto);
  }

  /** The owner's switch; the Worker reads the default branch from GitHub itself. */
  setDispatch(slug: string, dispatch: ProjectDispatch): Promise<RunnerResult<ProjectDispatchDto>> {
    return this.call(this.http.put<unknown>(projectDispatchUrl(slug), { dispatch }), isProjectDispatchDto);
  }

  private async call<T>(
    request: Observable<unknown>,
    is: (value: unknown) => value is T,
  ): Promise<RunnerResult<T>> {
    try {
      const body = await firstValueFrom(request.pipe(timeout(RUNNER_CALL_TIMEOUT_MS)));
      return is(body) ? { ok: true, value: body } : MALFORMED;
    } catch (error: unknown) {
      return { ok: false, failure: runnerFailureOf(error) };
    }
  }
}
