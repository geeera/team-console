import { inject, Injectable } from '@angular/core';
import {
  TeamStatusStore,
  textOf,
  type CommandFailure,
  type CommandOutcome,
  type CommandTarget,
} from '@console/entities/team-run';
import {
  localCalendarDayOf,
  localCalendarRangeOf,
  localTimeOf,
  TranslocoService,
} from '@console/shared/i18n';
import { ConfirmFailure, Sheet, type ConfirmCheck, type ConfirmOptions } from '@console/shared/ui';
import {
  NEXT_SPRINT_DEFAULT_DAYS,
  addDays,
  freezeOf,
  isCalendarDate,
  isInFreeze,
  type TeamStatusDto,
} from '@shared/contracts';
import { SprintControlsClient } from './sprint-controls.client';

/** When `Retry-After` is missing on GitHub's rate limit. */
const DEFAULT_RETRY_AFTER_S = 60;

/**
 * Move the demo and start the next sprint (#218), one confirmation each: the dialog is the form — a date with the
 * freeze it means shown as it changes, the refusals the Worker would give checked before sending, Try again on a
 * failure, and a conflict that refills the date with the live one. The Worker decides on a live read; the checks
 * here only save a round trip. After each command the team status is read again, so the card shows the new sprint.
 */
@Injectable({ providedIn: 'root' })
export class SprintControls {
  private readonly sheet = inject(Sheet);
  private readonly client = inject(SprintControlsClient);
  private readonly store = inject(TeamStatusStore);
  private readonly transloco = inject(TranslocoService);
  /** The clock the messages use; a seam for specs. */
  now: () => number = () => Date.now();

  /** The outcome, or `null` when the owner backed out. */
  async moveDemo(target: CommandTarget): Promise<CommandOutcome | null> {
    const status = await this.statusOf(target.slug);
    const sprint = status?.sprint ?? null;
    const calendar = status?.calendar ?? null;
    if (status === null || sprint === null || calendar === null) {
      return this.outcome('warning', this.t('commands.sprint.unavailable'));
    }
    if (!status.ownerConnected) {
      return this.outcome('warning', this.t('commands.sprint.noperm'));
    }
    const { today, freezeDays } = calendar;
    const next = sprint.next;
    // The live due after a conflict: what the next send must expect, and what "unchanged" means.
    let currentDue = sprint.due;
    const check = (value: string): ConfirmCheck => {
      if (!isCalendarDate(value)) {
        return { error: this.t('commands.demo.empty') };
      }
      if (value < today) {
        return { error: this.t('commands.demo.past') };
      }
      if (next !== null && value >= next.due) {
        return { error: this.t('commands.demo.afterNext', { next: next.title, date: this.day(next.due) }) };
      }
      const freeze = freezeOf(value, freezeDays);
      const hint = this.t('commands.demo.freeze', { range: this.range(freeze.from, freeze.to) });
      if (value === currentDue) {
        return { hint, confirmLabel: this.t('commands.demo.same'), isBlocked: true };
      }
      return {
        hint,
        confirmLabel: this.t('commands.demo.ok', { date: this.day(value) }),
        ...(isInFreeze(today, freeze) ? { warning: this.t('commands.demo.freezeNow') } : {}),
      };
    };
    return this.confirmed(
      {
        title: this.t('commands.demo.title', { sprint: sprint.title }),
        message: this.t('commands.demo.body', {
          date: this.day(sprint.due),
          range: this.range(sprint.freeze.from, sprint.freeze.to),
        }),
        input: {
          label: this.t('commands.demo.field'),
          type: 'date',
          value: sprint.due,
          min: today,
          ...(next === null ? {} : { max: addDays(next.due, -1) }),
          check,
        },
        confirmLabel: this.t('commands.demo.btn'),
      },
      async (due) => {
        const result = await this.client.moveDemo(target.slug, { due, expectedDue: currentDue });
        if (result.ok) {
          const { sprint: moved, freeze, freezeStartsNow } = result.value;
          return this.outcome(
            freezeStartsNow ? 'warning' : 'positive',
            this.t('commands.demo.done', { sprint: moved.title, date: this.day(moved.due) }),
            this.t(freezeStartsNow ? 'commands.demo.doneFreezeNow' : 'commands.demo.doneDetail', {
              range: this.range(freeze.from, freeze.to),
            }),
          );
        }
        const failure = result.failure;
        switch (failure.kind) {
          case 'sprint-changed': {
            const live = textOf(failure, 'due');
            if (live === due) {
              // A repeat of a move that already happened (a retry after a lost answer): nothing left to do.
              return this.outcome('neutral', this.t('commands.demo.already', { date: this.day(due) }));
            }
            if (live === null || !isCalendarDate(live)) {
              throw new ConfirmFailure(this.t('commands.demo.changedUnknown'));
            }
            currentDue = live;
            throw new ConfirmFailure(this.t('commands.demo.conflict', { date: this.day(live) }), live);
          }
          case 'sprint-unchanged':
            return this.outcome('neutral', this.t('commands.demo.already', { date: this.day(due) }));
          case 'sprint-none':
            return this.outcome('neutral', this.t('commands.demo.none'));
          case 'sprint-date-past':
            throw new ConfirmFailure(this.t('commands.demo.past'));
          case 'sprint-date-after-next':
            throw new ConfirmFailure(
              this.t('commands.demo.afterNext', {
                next: textOf(failure, 'nextTitle') ?? '',
                date: this.day(textOf(failure, 'nextDue') ?? ''),
              }),
            );
          default:
            throw this.refusal(failure);
        }
      },
    );
  }

  /** The outcome, or `null` when the owner backed out. */
  async startNext(target: CommandTarget): Promise<CommandOutcome | null> {
    const status = await this.statusOf(target.slug);
    const calendar = status?.calendar ?? null;
    if (status === null || calendar === null) {
      return this.outcome('warning', this.t('commands.sprint.unavailable'));
    }
    if (!status.ownerConnected) {
      return this.outcome('warning', this.t('commands.sprint.noperm'));
    }
    const { today, freezeDays, nextTitle } = calendar;
    let current = status.sprint;
    if (current?.next) {
      return this.outcome(
        'neutral',
        this.t('commands.next.exists', { sprint: current.next.title, date: this.day(current.next.due) }),
      );
    }
    // The day the new demo must come after: the current demo, or yesterday when no sprint runs.
    const afterOf = (): string => current?.due ?? addDays(today, -1);
    const check = (value: string): ConfirmCheck => {
      if (!isCalendarDate(value)) {
        return { error: this.t('commands.demo.empty') };
      }
      if (value <= afterOf()) {
        return {
          error:
            current === null
              ? this.t('commands.demo.past')
              : this.t('commands.next.early', { sprint: nextTitle, date: this.day(current.due) }),
        };
      }
      const freeze = freezeOf(value, freezeDays);
      return {
        hint: this.t('commands.next.hint', { range: this.range(freeze.from, freeze.to) }),
        confirmLabel: this.t('commands.next.ok', { sprint: nextTitle }),
      };
    };
    return this.confirmed(
      {
        title: this.t('commands.next.title', { sprint: nextTitle }),
        message:
          current === null
            ? this.t('commands.next.now', { sprint: nextTitle })
            : this.t('commands.next.after', {
                sprint: nextTitle,
                cur: current.title,
                date: this.day(current.due),
              }),
        input: {
          label: this.t('commands.next.field', { sprint: nextTitle }),
          type: 'date',
          value: addDays(current?.due ?? today, NEXT_SPRINT_DEFAULT_DAYS),
          min: addDays(afterOf(), 1),
          check,
        },
        confirmLabel: this.t('commands.next.btn'),
      },
      async (due) => {
        const expectedCurrent = current?.title ?? null;
        const result = await this.client.startNext(target.slug, { due, expectedCurrent });
        if (result.ok) {
          const { sprint: created, becomesCurrentAfter } = result.value;
          return this.outcome(
            'positive',
            this.t('commands.next.done', { sprint: created.title }),
            becomesCurrentAfter === null || current === null
              ? this.t('commands.next.doneNow', { date: this.day(created.due) })
              : this.t('commands.next.doneLater', {
                  cur: current.title,
                  after: this.day(becomesCurrentAfter),
                  date: this.day(created.due),
                }),
          );
        }
        const failure = result.failure;
        switch (failure.kind) {
          case 'sprint-exists': {
            const title = textOf(failure, 'nextTitle') ?? nextTitle;
            const existingDue = textOf(failure, 'nextDue');
            return this.outcome(
              'neutral',
              existingDue === null || !isCalendarDate(existingDue)
                ? this.t('commands.next.existsRace', { sprint: title })
                : this.t('commands.next.exists', { sprint: title, date: this.day(existingDue) }),
            );
          }
          case 'sprint-changed': {
            const title = textOf(failure, 'currentTitle');
            const liveDue = textOf(failure, 'currentDue');
            current =
              title === null || liveDue === null || !isCalendarDate(liveDue)
                ? null
                : { number: 0, title, due: liveDue, freeze: freezeOf(liveDue, freezeDays), next: null };
            const refill = addDays(current?.due ?? today, NEXT_SPRINT_DEFAULT_DAYS);
            throw new ConfirmFailure(
              current === null
                ? this.t('commands.next.changedNone')
                : this.t('commands.next.changed', { cur: current.title, date: this.day(current.due) }),
              refill,
            );
          }
          case 'sprint-date-early':
            throw new ConfirmFailure(
              current === null
                ? this.t('commands.demo.past')
                : this.t('commands.next.early', { sprint: nextTitle, date: this.day(current.due) }),
            );
          default:
            throw this.refusal(failure);
        }
      },
    );
  }

  private readonly t = (key: string, params?: Record<string, unknown>): string =>
    this.transloco.translate(key, params);

  private day(day: string): string {
    return localCalendarDayOf(day, this.transloco.getActiveLang());
  }

  private range(from: string, to: string): string {
    return localCalendarRangeOf(from, to, this.transloco.getActiveLang());
  }

  /** The team status of `slug`, read first when the store holds another project's (the board opens it cold). */
  private async statusOf(slug: string): Promise<TeamStatusDto | null> {
    if (this.store.slug() !== slug || this.store.status() === null) {
      await this.store.load(slug);
    }
    return this.store.slug() === slug ? this.store.status() : null;
  }

  private async confirmed(
    options: Omit<ConfirmOptions, 'action' | 'cancelLabel' | 'retryLabel' | 'busyLabel'>,
    act: (input: string) => Promise<CommandOutcome>,
  ): Promise<CommandOutcome | null> {
    let outcome: CommandOutcome | null = null;
    const isDone = await this.sheet.confirm({
      ...options,
      cancelLabel: this.t('commands.dialog.cancel'),
      retryLabel: this.t('commands.dialog.retry'),
      busyLabel: this.t('commands.dialog.sending'),
      action: async (input: string) => {
        try {
          outcome = await act(input);
        } finally {
          // Whatever happened, the sprint is read again: the card and the next press must see the live one.
          void this.store.refresh();
        }
      },
    });
    return isDone ? outcome : null;
  }

  private outcome(tone: CommandOutcome['tone'], verb: string, detail: string | null = null): CommandOutcome {
    return { tone, verb, detail, runLogUrl: null, at: new Date(this.now()).toISOString() };
  }

  /** The dialog's alert for a refusal that is not about the sprint, in words the owner can act on. */
  private refusal(failure: CommandFailure): ConfirmFailure {
    const retryAt = localTimeOf(
      this.now() + (failure.retryAfter ?? DEFAULT_RETRY_AFTER_S) * 1000,
      this.transloco.getActiveLang(),
    );
    const messages: Partial<Record<CommandFailure['kind'], string>> = {
      github: this.t('commands.error.github'),
      'github-rate-limited': this.t('commands.error.githubRate', { time: retryAt }),
      'not-connected': this.t('commands.error.connect'),
      offline: this.t('commands.error.offline'),
    };
    return new ConfirmFailure(messages[failure.kind] ?? this.t('commands.error.unknown'));
  }
}
