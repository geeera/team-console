import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { budgetMoneyOf, budgetMonthOf } from '@console/entities/team-run';
import { intlLocaleOf, localDayOf, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Callout } from '@console/shared/ui';
import type { TeamBudgetMonthDto } from '@shared/contracts';

/** A waived month (#737): "Resume this month" was chosen, so `waivedAt` is set and the month has a budget. */
export type WaivedMonthDto = TeamBudgetMonthDto & { readonly budgetUsd: number; readonly waivedAt: string };

/** The first day of the UTC month after `month` (`YYYY-MM`), when the budget caps the team again; `null` if malformed. */
export function waiverEndOf(month: string): Date | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (match === null) {
    return null;
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]), 1));
}

/** "1 декабря" / "1 December" of a UTC instant, in UTC: the month ends at UTC midnight, wherever the owner is. */
export function utcDayOf(at: Date, lang: string): string {
  return new Intl.DateTimeFormat(intlLocaleOf(lang), { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(at);
}

const capitalised = (text: string): string => text.charAt(0).toLocaleUpperCase() + text.slice(1);

/**
 * The waived month in Settings › Team › Limits (#688 from #737): the owner chose "Resume this month", so the budget no
 * longer stops the team this month, and a changed budget ends the waiver at once. Read from `GET …/team/status`
 * `budget.waivedAt`, never decided here.
 */
@Component({
  selector: 'tc-waived-month',
  imports: [Callout, TranslocoPipe],
  template: `
    <section tc-callout tone="warning" data-testid="team-waived" aria-labelledby="tc-team-waived-title">
      <h3 tc-callout-title id="tc-team-waived-title">{{ 'teamConfig.budget.waivedTitle' | transloco: { month: words().month } }}</h3>
      <p class="waived__text" data-testid="team-waived-body">{{ 'teamConfig.budget.waivedBody' | transloco: words() }}</p>
      <p class="waived__text waived__ends" data-testid="team-waived-ends">{{ 'teamConfig.budget.waivedEnds' | transloco }}</p>
    </section>
  `,
  styles: `
    .waived__text {
      margin: 0;
    }

    .waived__ends {
      margin-top: var(--space-2);
      color: var(--text-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WaivedMonth {
  private readonly transloco = inject(TranslocoService);
  private readonly lang = toSignal(this.transloco.langChanges$, { initialValue: this.transloco.getActiveLang() });

  readonly month = input.required<WaivedMonthDto>();

  protected readonly words = computed(() => {
    const month = this.month();
    const lang = this.lang();
    const end = waiverEndOf(month.month);
    return {
      month: capitalised(budgetMonthOf(month.month, lang)),
      date: localDayOf(month.waivedAt, lang),
      spent: budgetMoneyOf(month.spentUsd, lang),
      budget: budgetMoneyOf(month.budgetUsd, lang),
      until: end === null ? month.month : utcDayOf(end, lang),
    };
  });
}
