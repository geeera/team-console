import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { QuestionBudgetStop } from '@console/entities/question';
import {
  BudgetResume,
  budgetDialogLabelsOf,
  budgetMoneyOf,
  budgetMonthOf,
  throwIfBudgetFailed,
} from '@console/entities/team-run';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Callout, Sheet, Toaster, type ConfirmCheck } from '@console/shared/ui';
import { TEAM_CONFIG_BOUNDS } from '@shared/contracts';
import { BudgetStopClient } from './budget-stop.client';

export { budgetMoneyOf, budgetMonthOf } from '@console/entities/team-run';

/** An in-app address with its query, for a router link the caller builds (the row never knows the page behind it). */
export interface BudgetStopLink {
  readonly path: string;
  readonly queryParams: Readonly<Record<string, string>>;
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
 * month` (`BudgetResume`, shared with Settings › Team, #688) asks one line first, "Spending may exceed {budget}." (team
 * decision on #630), then resumes the team, which waives the budget for the rest of the UTC month. "Open limits" is
 * the caller's `limitsLink` (Settings › Team at the budget). `Raise budget` asks for the new monthly budget, with the overshoot
 * bound under the field, and saves it; a budget above the spend lifts the stop. Both end in `resolved`, so the list
 * reads Needs you again; the toast after a successful raise says "Team resumed" only when nothing else holds the
 * team paused (#739) — beside an owner's own pause (`stoppedAt === null` and `stop().paused`) it says the pause
 * stays, since raising the budget never touches it. `canManage` is `false` for a project member (#735, the read-only
 * rule of the Settings › Team UX spec, #630): the row then shows the figures only, with neither action, since both
 * write as the project's owner and would refuse with "Это может сделать только владелец проекта." anyway.
 */
@Component({
  selector: 'tc-budget-stop',
  imports: [Button, Callout, RouterLink, TranslocoPipe],
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
          @if (limitsLink(); as link) {
            <a
              tc-button
              variant="quiet"
              data-testid="budget-open-limits"
              [routerLink]="link.path"
              [queryParams]="link.queryParams"
            >
              {{ 'budget.stop.openLimits' | transloco }}
            </a>
          }
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
  private readonly budgetResume = inject(BudgetResume);
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
  /** Settings › Team at Limits for this project (#688, "Open limits"); none when the caller has no such page. */
  readonly limitsLink = input<BudgetStopLink | null>(null);
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
    const isDone = await this.budgetResume.confirmResume({
      slug: stop.project.slug,
      projectName: stop.project.name,
      budgetUsd: stop.budgetUsd,
    });
    if (isDone) {
      this.resolved.emit();
    }
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
      ...budgetDialogLabelsOf(this.t),
      action: async (value: string) =>
        throwIfBudgetFailed(await this.client.raise(stop.project.slug, Number(value)), this.t),
    });
    // Raise never touches a pause set for another reason (#739): the toast must not claim it did.
    this.done(isDone, staysPaused ? 'budget.raise.savedStillPaused' : 'budget.resumed');
  }

  private done(isDone: boolean, toastKey: string): void {
    if (isDone) {
      this.toaster.show(this.t(toastKey));
      this.resolved.emit();
    }
  }

  private readonly t = (key: string, params?: Record<string, unknown>): string =>
    this.transloco.translate(key, params);
}
