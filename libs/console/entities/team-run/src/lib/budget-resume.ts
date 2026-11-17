import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { httpProblemOf } from '@console/shared/api';
import { intlLocaleOf, localUsdOf, TranslocoService } from '@console/shared/i18n';
import { ConfirmFailure, Sheet, Toaster } from '@console/shared/ui';
import { firstValueFrom } from 'rxjs';

/** Why a budget action did not happen, in the terms its dialog words it by (`budget.error.*`). */
export type BudgetActionFailure = 'forbidden' | 'stale' | 'offline' | 'failed';

export type BudgetActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: BudgetActionFailure };

export function teamResumeUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/team/resume`;
}

/** Dollars in the language's own form (`201,50 $`, `$201.50`); whole dollars without cents. */
export function budgetMoneyOf(usd: number, lang: string): string {
  return localUsdOf(usd, lang);
}

/** The UTC month `YYYY-MM` by name (`ноябрь`, `November`); the month string itself when it is not one. */
export function budgetMonthOf(month: string, lang: string): string {
  const at = new Date(`${month}-01T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}$/.test(month) || Number.isNaN(at.getTime())) {
    return month;
  }
  return new Intl.DateTimeFormat(intlLocaleOf(lang), { month: 'long', timeZone: 'UTC' }).format(at);
}

export function budgetFailureOf(error: unknown): BudgetActionFailure {
  const problem = httpProblemOf(error);
  if (problem.status === 0) {
    return 'offline';
  }
  if (problem.status === 403) {
    return 'forbidden';
  }
  return problem.status === 412 || problem.slug === 'team-config-stale' ? 'stale' : 'failed';
}

/** The labels every budget dialog shares: Cancel, Try again, the busy line and the generic failure. */
export function budgetDialogLabelsOf(t: (key: string) => string): {
  readonly cancelLabel: string;
  readonly retryLabel: string;
  readonly busyLabel: string;
  readonly errorMessage: string;
} {
  return {
    cancelLabel: t('budget.cancel'),
    retryLabel: t('budget.retry'),
    busyLabel: t('budget.sending'),
    errorMessage: t('budget.error.failed'),
  };
}

/** A refusal keeps a budget dialog open with its reason and Try again. */
export function throwIfBudgetFailed(result: BudgetActionResult, t: (key: string) => string): void {
  if (!result.ok) {
    throw new ConfirmFailure(t(`budget.error.${result.failure}`));
  }
}

/** The stop "Resume this month" is about: whose team, and the budget the spend may now pass. */
export interface BudgetResumeTarget {
  readonly slug: string;
  readonly projectName: string;
  readonly budgetUsd: number;
}

/**
 * "Resume this month" (#684, #733), the one place that sends `POST …/team/resume {waiveBudget: true}`: it lifts the
 * stop and waives the budget for the rest of the UTC month once the month has reached it. Shared by the Needs-you row
 * and the Settings › Team callout (#688), so both ask the same one line first — "Spending may exceed {budget}." —
 * and say "Team resumed." the same way.
 */
@Injectable({ providedIn: 'root' })
export class BudgetResume {
  private readonly http = inject(HttpClient);
  private readonly sheet = inject(Sheet);
  private readonly toaster = inject(Toaster);
  private readonly transloco = inject(TranslocoService);

  /** Never throws for an HTTP failure. */
  async resume(slug: string): Promise<BudgetActionResult> {
    try {
      await firstValueFrom(this.http.post<unknown>(teamResumeUrl(slug), { waiveBudget: true }));
      return { ok: true };
    } catch (error: unknown) {
      // Resumed meanwhile (another device, or a raised budget): what the owner asked for already holds.
      return httpProblemOf(error).slug === 'team-not-paused' ? { ok: true } : { ok: false, failure: budgetFailureOf(error) };
    }
  }

  /** Asks the one-line confirm, resumes, and toasts "Team resumed."; `false` when the owner backed out. */
  async confirmResume(target: BudgetResumeTarget): Promise<boolean> {
    const lang = this.transloco.getActiveLang();
    const isDone = await this.sheet.confirm({
      title: this.t('budget.resume.title', { project: target.projectName }),
      message: this.t('budget.resume.message', { budget: budgetMoneyOf(target.budgetUsd, lang) }),
      confirmLabel: this.t('budget.resume.confirm'),
      ...budgetDialogLabelsOf(this.t),
      action: async () => throwIfBudgetFailed(await this.resume(target.slug), this.t),
    });
    if (isDone) {
      this.toaster.show(this.t('budget.resumed'));
    }
    return isDone;
  }

  private readonly t = (key: string, params?: Record<string, unknown>): string => this.transloco.translate(key, params);
}
