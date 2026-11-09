import { inject, Injectable } from '@angular/core';
import {
  calendarTodayOf,
  freezeDaysOrDefault,
  ItemsApi,
  latestSprintOf,
  newIdempotencyKey,
  nextSprintTitleOf,
} from '@console/entities/item';
import { TranslocoService } from '@console/shared/i18n';
import { Sheet } from '@console/shared/ui';
import { NEXT_SPRINT_DEFAULT_DAYS, addDays, type TrackerSprintDto } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';
import { CreateSprintDialog, type CreateSprintData } from './create-sprint-dialog';

export interface CreateSprintTarget {
  readonly slug: string;
}

/**
 * Create a sprint in the console tracker (#409 §2.3), from the board and from Commands: one dialog with the name
 * (the next `Sprint NN`, editable, #457) and the demo date prefilled 14 days after the latest demo, its freeze from the
 * project's own `sprint.freeze_days`. A new sprint always goes after the latest.
 */
@Injectable({ providedIn: 'root' })
export class CreateSprint {
  private readonly api = inject(ItemsApi);
  private readonly sheet = inject(Sheet);
  private readonly transloco = inject(TranslocoService);
  /** The clock; a seam for specs. */
  now: () => Date = () => new Date();

  /** The created sprint, or `null` when the owner backed out or the sprints could not be read. */
  async open(target: CreateSprintTarget): Promise<TrackerSprintDto | null> {
    const [read, freeze] = await Promise.all([
      this.api.sprints(target.slug),
      this.api.freezeDays(target.slug),
    ]);
    if (!read.ok) {
      await this.sheet.confirm({
        title: this.t('sprintNew.title'),
        message: this.t(read.reason === 'offline' ? 'item.err.network.message' : 'item.error.hint'),
        confirmLabel: this.t('ui.close'),
      });
      return null;
    }
    const sprints = read.value;
    const today = calendarTodayOf(this.now());
    const after = latestSprintOf(sprints)?.dueOn ?? null;
    const start = after !== null && after >= today ? after : today;
    const ref = this.sheet.open<TrackerSprintDto, CreateSprintData>(CreateSprintDialog, {
      title: this.t('sprintNew.title'),
      data: {
        slug: target.slug,
        sprints,
        suggestedName: nextSprintTitleOf(sprints),
        today,
        dueOn: addDays(start, NEXT_SPRINT_DEFAULT_DAYS),
        freezeDays: freezeDaysOrDefault(freeze),
        idempotencyKey: newIdempotencyKey(),
      },
    });
    return (await firstValueFrom(ref.closed)) ?? null;
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }
}
