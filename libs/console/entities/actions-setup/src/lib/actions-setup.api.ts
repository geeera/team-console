import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ErrorHandler, inject, Injectable } from '@angular/core';
import {
  isActionsSetupDto,
  isActionsWorkflowDto,
  isActionsWorkflowPrDto,
  type ActionsSetupDto,
  type ActionsWorkflowDto,
  type ActionsWorkflowPrDto,
} from '@shared/contracts';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import {
  actionsCheckProblemOf,
  workflowPrRefusalOf,
  type ActionsCheckProblem,
  type WorkflowPrRefusal,
} from './actions-setup-problems';

export function actionsSetupUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/actions-setup`;
}

/**
 * A check makes up to a dozen GitHub calls (UX spec §6 says up to 10 s); past this the answer is treated as failed.
 * The PR route makes three writes and a revoke, so it gets the same budget.
 */
export const ACTIONS_CALL_TIMEOUT_MS = 30_000;

export type ActionsResult<T, P> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: P };

/** An answer outside its contract is not shown: it reads as a failed call. */
class UnexpectedActionsAnswer extends Error {
  constructor(url: string) {
    super(`unexpected response shape from ${url}`);
    this.name = 'UnexpectedActionsAnswer';
  }
}

/**
 * The HTTP surface of the Actions setup page (#759): the readiness check, this console's rendering of the workflow
 * file (the Copy path), and the PR route. Never throws: every answer is checked by its contract guard first.
 */
@Injectable({ providedIn: 'root' })
export class ActionsSetupApi {
  private readonly http = inject(HttpClient);
  private readonly errors = inject(ErrorHandler);

  check(slug: string): Promise<ActionsResult<ActionsSetupDto, ActionsCheckProblem>> {
    return this.call(actionsSetupUrl(slug), 'GET', isActionsSetupDto, actionsCheckProblemOf);
  }

  workflow(slug: string): Promise<ActionsResult<ActionsWorkflowDto, ActionsCheckProblem>> {
    return this.call(`${actionsSetupUrl(slug)}/workflow`, 'GET', isActionsWorkflowDto, actionsCheckProblemOf);
  }

  /** No body: the server decides what the PR holds; nothing of the client steers it. */
  openWorkflowPr(slug: string): Promise<ActionsResult<ActionsWorkflowPrDto, WorkflowPrRefusal>> {
    return this.call(
      `${actionsSetupUrl(slug)}/workflow-pr`,
      'POST',
      isActionsWorkflowPrDto,
      workflowPrRefusalOf,
    );
  }

  private async call<T, P>(
    url: string,
    method: 'GET' | 'POST',
    guard: (value: unknown) => value is T,
    problemOf: (error: unknown) => P,
  ): Promise<ActionsResult<T, P>> {
    try {
      const request = method === 'GET' ? this.http.get<unknown>(url) : this.http.post<unknown>(url, null);
      const body = await firstValueFrom(request.pipe(timeout(ACTIONS_CALL_TIMEOUT_MS)));
      if (!guard(body)) {
        throw new UnexpectedActionsAnswer(url);
      }
      return { ok: true, value: body };
    } catch (error: unknown) {
      // A contract break or a bug is worth reporting; an HTTP refusal or a timeout is an ordinary answer.
      if (!(error instanceof HttpErrorResponse) && !(error instanceof TimeoutError)) {
        this.errors.handleError(error);
      }
      return { ok: false, problem: problemOf(error) };
    }
  }
}
