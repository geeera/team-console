import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { BudgetResume, budgetMoneyOf, budgetMonthOf } from '@console/entities/team-run';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Callout, Icon } from '@console/shared/ui';
import type { TeamBudgetMonthDto } from '@shared/contracts';

/** A month the budget stopped: it has a budget, so the figures always read "spent of budget". */
export type StoppedMonth = TeamBudgetMonthDto & { readonly budgetUsd: number };

/**
 * "Budget used up" at the top of Settings › Team (#688, UX spec §4 "Budget stopped"): the Needs-you row's figures and
 * its two actions. `Resume this month` is the shared `BudgetResume` of `@console/entities/team-run` — the same one-line
 * confirm and toast as the Needs-you row; `Raise budget` hands back to the page, which unfolds Limits and focuses the
 * monthly budget so the raise is an ordinary edit, reviewed and saved. A member sees the figures only.
 */
@Component({
  selector: 'tc-budget-callout',
  imports: [Button, Callout, Icon, TranslocoPipe],
  template: `
    <section tc-callout tone="danger" data-testid="team-budget-stop" aria-labelledby="tc-team-budget-title">
      <h2 tc-callout-title id="tc-team-budget-title" class="budget__title">
        <tc-icon name="pause" size="sm" />{{ 'teamConfig.budget.title' | transloco }}
      </h2>
      <p class="budget__body" data-testid="team-budget-body">{{ 'budget.stop.body' | transloco: figures() }}</p>
      @if (canManage()) {
        <div class="budget__actions">
          <button
            tc-button
            variant="primary"
            type="button"
            data-testid="team-budget-resume"
            (click)="resume()"
          >
            {{ 'budget.stop.resume' | transloco }}
          </button>
          <button tc-button type="button" data-testid="team-budget-raise" (click)="raise.emit()">
            {{ 'budget.stop.raise' | transloco }}
          </button>
        </div>
      } @else {
        <p class="budget__body budget__readonly" data-testid="team-budget-readonly">{{ 'budget.stop.readonly' | transloco }}</p>
      }
    </section>
  `,
  styles: `
    .budget__title {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }

    .budget__body {
      margin: 0;
    }

    .budget__readonly {
      margin-top: var(--space-3);
    }

    .budget__actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BudgetCallout {
  private readonly budgetResume = inject(BudgetResume);
  private readonly transloco = inject(TranslocoService);
  private readonly lang = toSignal(this.transloco.langChanges$, { initialValue: this.transloco.getActiveLang() });

  readonly slug = input.required<string>();
  readonly projectName = input.required<string>();
  readonly month = input.required<StoppedMonth>();
  readonly canManage = input(false);
  /** The team runs again for the rest of the month: the page reads the status again. */
  readonly resumed = output<void>();
  /** The owner chose to raise the budget: the page takes them to the field. */
  readonly raise = output<void>();

  /** The confirm is open: a second press does not stack another. */
  private readonly busy = signal(false);
  protected readonly figures = computed(() => {
    const month = this.month();
    const lang = this.lang();
    return {
      spent: budgetMoneyOf(month.spentUsd, lang),
      budget: budgetMoneyOf(month.budgetUsd, lang),
      month: budgetMonthOf(month.month, lang),
    };
  });

  protected async resume(): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    try {
      const isDone = await this.budgetResume.confirmResume({
        slug: this.slug(),
        projectName: this.projectName(),
        budgetUsd: this.month().budgetUsd,
      });
      if (isDone) {
        this.resumed.emit();
      }
    } finally {
      this.busy.set(false);
    }
  }
}
