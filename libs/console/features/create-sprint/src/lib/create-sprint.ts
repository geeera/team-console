import { LiveAnnouncer } from '@angular/cdk/a11y';
import { inject, Injectable } from '@angular/core';
import {
  calendarTodayOf,
  ItemsApi,
  latestSprintOf,
  TRACKER_FREEZE_DAYS,
  newIdempotencyKey,
  nextSprintTitleOf,
  type TrackerFailure,
} from '@console/entities/item';
import { localCalendarDayOf, localCalendarRangeOf, TranslocoService } from '@console/shared/i18n';
import { ConfirmFailure, Sheet, type ConfirmCheck } from '@console/shared/ui';
import {
  NEXT_SPRINT_DEFAULT_DAYS,
  addDays,
  freezeOf,
  isCalendarDate,
  type TrackerSprintDto,
} from '@shared/contracts';

export interface CreateSprintTarget {
  readonly slug: string;
}

/**
 * Create a sprint in the console tracker (#409 §2.3), from the board and from Commands: one dialog, the demo date
 * prefilled 14 days after the latest demo, the hint saying when it starts and when its freeze is, and the refusals
 * checked as the owner types (empty, past, not after the latest demo). A new sprint always goes after the latest;
 * the server numbers and names it (`Sprint NN`), so the name is shown, not typed. The write carries one idempotency
 * key for the whole dialog, so Try again after a drop never creates two sprints.
 */
@Injectable({ providedIn: 'root' })
export class CreateSprint {
  private readonly api = inject(ItemsApi);
  private readonly sheet = inject(Sheet);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);
  /** The clock; a seam for specs. */
  now: () => Date = () => new Date();

  /** The created sprint, or `null` when the owner backed out or the sprints could not be read. */
  async open(target: CreateSprintTarget): Promise<TrackerSprintDto | null> {
    const read = await this.api.sprints(target.slug);
    if (!read.ok) {
      await this.sheet.confirm({
        title: this.t('sprintNew.title'),
        message: this.t(read.reason === 'offline' ? 'item.err.network.message' : 'item.error.hint'),
        confirmLabel: this.t('ui.close'),
      });
      return null;
    }
    const sprints = read.value;
    const latest = latestSprintOf(sprints);
    const today = calendarTodayOf(this.now());
    const name = nextSprintTitleOf(sprints);
    const after = latest?.dueOn ?? null;
    const start = after !== null && after >= today ? after : today;
    const key = newIdempotencyKey();
    const created: { sprint: TrackerSprintDto | null } = { sprint: null };
    const check = (value: string): ConfirmCheck => {
      if (!isCalendarDate(value)) {
        return { error: this.t('sprintNew.errEmpty') };
      }
      if (value < today) {
        return { error: this.t('sprintNew.errPast') };
      }
      if (after !== null && latest !== null && value <= after) {
        return {
          error: this.t('sprintNew.errBefore', { sprint: name, prev: latest.title, date: this.day(after) }),
        };
      }
      const freeze = freezeOf(value, TRACKER_FREEZE_DAYS);
      return {
        hint:
          latest !== null && after !== null
            ? this.t('sprintNew.hint', {
                prev: latest.title,
                date: this.day(after),
                freeze: this.range(freeze.from, freeze.to),
              })
            : this.t('sprintNew.hintFirst', { freeze: this.range(freeze.from, freeze.to) }),
        confirmLabel: this.t('sprintNew.ok', { sprint: name }),
      };
    };
    const isCreated = await this.sheet.confirm({
      title: this.t('sprintNew.titleNamed', { sprint: name }),
      message: this.t('sprintNew.after'),
      input: {
        label: this.t('sprintNew.date'),
        type: 'date',
        value: addDays(start, NEXT_SPRINT_DEFAULT_DAYS),
        min: today,
        check,
      },
      confirmLabel: this.t('sprintNew.ok', { sprint: name }),
      busyLabel: this.t('sprintNew.busy'),
      action: async (dueOn: string) => {
        const result = await this.api.createSprint(target.slug, dueOn, key);
        if (!result.ok) {
          throw new ConfirmFailure(this.failureText(result.failure));
        }
        created.sprint = result.value;
      },
    });
    const sprint = created.sprint;
    if (!isCreated || sprint === null) {
      return null;
    }
    const done = this.t('sprintNew.done', { sprint: sprint.title, date: this.day(sprint.dueOn ?? '') });
    void this.announcer.announce(done, 'polite');
    return sprint;
  }

  private failureText(failure: TrackerFailure): string {
    switch (failure.kind) {
      case 'forbidden':
        return `${this.t('item.err.forbidden.title')}. ${this.t('item.err.forbidden.message')}`;
      case 'timeout':
        return this.t('item.err.timeout.message');
      case 'invalid':
        return this.t('sprintNew.errInvalid');
      default:
        return this.t('item.err.network.message');
    }
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }

  private day(day: string): string {
    return localCalendarDayOf(day, this.transloco.getActiveLang());
  }

  private range(from: string, to: string): string {
    return localCalendarRangeOf(from, to, this.transloco.getActiveLang());
  }
}
