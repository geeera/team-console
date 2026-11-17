import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { intlLocaleOf, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Callout, ConfirmFailure, Sheet, Toaster, type ConfirmCheck } from '@console/shared/ui';
import type { QuestionBudgetStop } from '@console/entities/question';
import { TEAM_CONFIG_BOUNDS } from '@shared/contracts';
import { BudgetStopClient, type BudgetActionResult } from './budget-stop.client';

/** Dollars in the language's own form (`201,50 $`, `$201.50`); whole dollars without cents. */
export function budgetMoneyOf(usd: number, lang: string): string {
  return new Intl.NumberFormat(intlLocaleOf(lang), {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: Number.isInteger(usd) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(usd);
}

/** The UTC month `YYYY-MM` by name (`ноябрь`, `November`); the month string itself when it is not one. */
export function budgetMonthOf(month: string, lang: string): string {
  const at = new Date(`${month}-01T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}$/.test(month) || Number.isNaN(at.getTime())) {
    return month;
  }
  return new Intl.DateTimeFormat(intlLocaleOf(lang), { month: 'long', timeZone: 'UTC' }).format(at);
}

/** A new monthly budget as typed: whole dollars inside the schema's bound, and above what the month already spent. */
export function budgetInputErrorOf(
  value: string,
  spentUsd: number,
): { readonly key: string; readonly params: Record<string, unknown> } | null {
  const { min, max } = TEAM_CONFIG_BOUNDS.monthlyUsd;
  const text = value.trim();
  const usd = Number(text);
  if (!/^\d{1,6}$/.test(text) || !Number.isSafeInteger(usd) || usd < min || usd > max) {
    return { key: 'budget.raise.invalid', params: { min, max } };
  }
  return usd > spentUsd ? null : { key: 'budget.raise.tooLow', params: {} };
}

let nextBudgetStopId = 0;

/**
 * The Needs-you row "Budget used up" (#684; UX spec on #630): the figures of the stop and its two actions. `Resume this
 * month` asks one line first, "Spending may exceed {budget}." (team decision on #630), then resumes the team, which
 * waives the budget for the rest of the UTC month. `Raise budget` asks for the new monthly budget, with the overshoot
 * bound under the field, and saves it; a budget above the spend lifts the stop. Both end in `resolved`, so the list
 * reads Needs you again; the toast after a successful raise says "Team resumed" only when nothing else holds the
 * team paused (#739) — beside an owner's own pause (`stoppedAt === null` and `stop().paused`) it says the pause
 * stays, since raising the budget never touches it. `canManage` is `false` for a project member (#735, the read-only
 * rule of the Settings › Team UX spec, #630): the row then shows the figures only, with neither action, since both
 * write as the project's owner and would refuse with "Это может сделать только владелец проекта." anyway.
 */
@Component({
  selector: 'tc-budget-stop',
  imports: [Button, Callout, TranslocoPipe],
  template: `
    <section
      tc-callout
      tone="warning"
      class="budget-stop"
      data-testid="budget-stop"
      [attr.data-project]="stop().project.slug"
      [attr.aria-labelledby]="titleId"
    >
      <h2 tc-callout-title [id]="titleId">
        {{ 'budget.stop.title' | transloco: { project: stop().project.name } }}
      </h2>
      <p class="budget-stop__body" data-testid="budget-stop-body">
        {{ 'budget.stop.body' | transloco: figures() }}
      </p>
      @if (canManage()) {
        <div class="budget-stop__actions">
          <button tc-button variant="primary" type="button" data-testid="budget-resume" (click)="resume()">
            {{ 'budget.stop.resume' | transloco }}
          </button>
          <button tc-button type="button" data-testid="budget-raise" (click)="raise()">
            {{ 'budget.stop.raise' | transloco }}
          </button>
        </div>
      } @else {
        <p class="budget-stop__readonly" data-testid="budget-stop-readonly">
          {{ 'budget.stop.readonly' | transloco }}
        </p>
      }
    </section>
  `,
  styles: `
    .budget-stop__body,
    .budget-stop__readonly {
      margin: 0;
    }

    .budget-stop__readonly {
      margin-top: var(--space-3);
      color: var(--text-2);
    }

    .budget-stop__actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BudgetStop {
  private readonly client = inject(BudgetStopClient);
  private readonly sheet = inject(Sheet);
  private readonly toaster = inject(Toaster);
  private readonly transloco = inject(TranslocoService);
  private readonly lang = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });

  readonly stop = input.required<QuestionBudgetStop>();
  /**
   * Whether this identity may use the two actions (#735): `false` for a project member, who sees the figures only.
   * Defaults to `true` so every caller that does not yet carry the owner/member signal keeps today's behaviour.
   */
  readonly canManage = input<boolean>(true);
  /** The stop was lifted from this row: the caller reads Needs you again. */
  readonly resolved = output<void>();

  protected readonly titleId = `tc-budget-stop-${String(nextBudgetStopId++)}`;
  protected readonly figures = computed(() => {
    const stop = this.stop();
    const lang = this.lang();
    return {
      spent: budgetMoneyOf(stop.spentUsd, lang),
      budget: budgetMoneyOf(stop.budgetUsd, lang),
      month: budgetMonthOf(stop.month, lang),
    };
  });
  /** A non-budget pause holds beside this row (#739): raising the budget will not start the team again. */
  protected readonly staysPaused = computed(() => {
    const stop = this.stop();
    return stop.stoppedAt === null && stop.paused;
  });

  protected async resume(): Promise<void> {
    const stop = this.stop();
    const isDone = await this.sheet.confirm({
      title: this.t('budget.resume.title', { project: stop.project.name }),
      message: this.t('budget.resume.message', { budget: this.figures().budget }),
      confirmLabel: this.t('budget.resume.confirm'),
      ...this.dialogLabels(),
      action: async () => this.settled(await this.client.resume(stop.project.slug)),
    });
    this.done(isDone);
  }

  protected async raise(): Promise<void> {
    const stop = this.stop();
    const { spent, month } = this.figures();
    const staysPaused = this.staysPaused();
    const isDone = await this.sheet.confirm({
      title: this.t('budget.raise.title', { project: stop.project.name }),
      message: this.t(staysPaused ? 'budget.raise.messagePaused' : 'budget.raise.message', { spent, month }),
      note: this.t('budget.overshoot'),
      input: {
        label: this.t('budget.raise.label'),
        hint: this.t('budget.raise.hint'),
        value: String(stop.budgetUsd),
        maxLength: 6,
        check: (value: string): ConfirmCheck => {
          const error = budgetInputErrorOf(value, stop.spentUsd);
          return error === null ? {} : { error: this.t(error.key, { spent, ...error.params }) };
        },
      },
      confirmLabel: this.t('budget.raise.confirm'),
      ...this.dialogLabels(),
      action: async (value: string) =>
        this.settled(await this.client.raise(stop.project.slug, Number(value))),
    });
    // Raise never touches a pause set for another reason (#739): the toast must not claim it did.
    this.done(isDone, staysPaused ? 'budget.raise.savedStillPaused' : 'budget.resumed');
  }

  private dialogLabels(): {
    cancelLabel: string;
    retryLabel: string;
    busyLabel: string;
    errorMessage: string;
  } {
    return {
      cancelLabel: this.t('budget.cancel'),
      retryLabel: this.t('budget.retry'),
      busyLabel: this.t('budget.sending'),
      errorMessage: this.t('budget.error.failed'),
    };
  }

  /** A refusal keeps the dialog open with its reason and Try again. */
  private settled(result: BudgetActionResult): void {
    if (!result.ok) {
      throw new ConfirmFailure(this.t(`budget.error.${result.failure}`));
    }
  }

  private done(isDone: boolean, toastKey = 'budget.resumed'): void {
    if (isDone) {
      this.toaster.show(this.t(toastKey));
      this.resolved.emit();
    }
  }

  private readonly t = (key: string, params?: Record<string, unknown>): string =>
    this.transloco.translate(key, params);
}
