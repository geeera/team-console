import { inject, Injectable } from '@angular/core';
import { ProjectsStore } from '@console/entities/project';
import { TeamStatusStore } from '@console/entities/team-run';
import { TranslocoService } from '@console/shared/i18n';
import { Sheet } from '@console/shared/ui';
import type { SnoozeDto, SnoozeRequest } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';
import { SnoozeClient, type SnoozeFailure } from './snooze.client';
import { SnoozeDialog, type SnoozeDialogData } from './snooze-dialog';
import { snoozeWhenOf } from './snooze-until';

/** Which project: its slug and the name the owner reads. */
export interface SnoozeTarget {
  readonly slug: string;
  readonly name: string;
}

/** The panel's result note; the same shape as a team command's, so it shares the note and its live region. */
export interface SnoozeOutcome {
  readonly tone: 'positive' | 'warning';
  readonly verb: string;
  readonly detail: string | null;
  readonly runLogUrl: null;
  /** ISO 8601. */
  readonly at: string;
}

/**
 * Snooze and Turn back on (#221). Snoozing is a plain dialog with no confirmation; turning back on is one tap with
 * no dialog at all. What the Worker stored reaches the sidebar and the panel at once (`applySnooze` on both stores).
 */
@Injectable({ providedIn: 'root' })
export class SnoozeCommands {
  private readonly sheet = inject(Sheet);
  private readonly client = inject(SnoozeClient);
  private readonly projects = inject(ProjectsStore);
  private readonly status = inject(TeamStatusStore);
  private readonly transloco = inject(TranslocoService);
  /** The clock of the options and the messages; a seam for specs. */
  now: () => number = () => Date.now();

  /** The outcome once stored, or `null` when the owner closed the dialog. */
  async snooze(target: SnoozeTarget): Promise<SnoozeOutcome | null> {
    // Written by the dialog's save; a holder, so the type is not narrowed to its initial null.
    const saved: { snooze: SnoozeDto | null } = { snooze: null };
    const data: SnoozeDialogData = {
      now: () => new Date(this.now()),
      save: async (request: SnoozeRequest) => {
        const result = await this.client.snooze(target.slug, request);
        if (!result.ok) {
          return this.failureText(result.failure);
        }
        saved.snooze = result.snooze;
        this.apply(target.slug, result.snooze);
        return null;
      },
    };
    const ref = this.sheet.open<boolean, SnoozeDialogData>(SnoozeDialog, {
      title: this.t('commands.snooze.dialog.title', { name: target.name }),
      data,
      autoFocus: 'input[type=radio]:checked',
    });
    const isDone = (await firstValueFrom(ref.closed)) === true;
    return isDone && saved.snooze !== null ? this.snoozedOutcome(target, saved.snooze) : null;
  }

  /** One tap: no dialog. A failure is the note too — nothing changed, the snooze stays shown. */
  async turnBackOn(target: SnoozeTarget): Promise<SnoozeOutcome> {
    const result = await this.client.turnBackOn(target.slug);
    if (result.ok) {
      this.apply(target.slug, result.snooze);
      return this.outcome('positive', this.t('commands.snooze.result.back', { name: target.name }));
    }
    return this.outcome(
      'warning',
      this.t(
        result.failure === 'offline'
          ? 'commands.snooze.result.backOffline'
          : 'commands.snooze.result.backFailed',
        { name: target.name },
      ),
    );
  }

  /** "today 13:00", "tomorrow 09:00", "12 October, 09:00" in the active language. */
  untilText(until: string): string {
    const when = snoozeWhenOf(until, this.transloco.getActiveLang(), this.now());
    return this.t(when.key, when.params);
  }

  private apply(slug: string, snooze: SnoozeDto): void {
    this.projects.applySnooze(slug, snooze);
    this.status.applySnooze(slug, snooze);
  }

  private snoozedOutcome(target: SnoozeTarget, snooze: SnoozeDto): SnoozeOutcome {
    const until = snooze.snoozed ? snooze.until : null;
    return this.outcome(
      'positive',
      until === null
        ? this.t('commands.snooze.result.doneForever', { name: target.name })
        : this.t('commands.snooze.result.done', { name: target.name, until: this.untilText(until) }),
    );
  }

  private failureText(failure: SnoozeFailure): string {
    return this.t(failure === 'offline' ? 'commands.snooze.dialog.offline' : 'commands.snooze.dialog.err');
  }

  private outcome(tone: SnoozeOutcome['tone'], verb: string): SnoozeOutcome {
    return { tone, verb, detail: null, runLogUrl: null, at: new Date(this.now()).toISOString() };
  }

  private readonly t = (key: string, params?: Record<string, unknown>): string =>
    this.transloco.translate(key, params);
}
