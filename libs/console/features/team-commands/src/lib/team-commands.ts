import { inject, Injectable } from '@angular/core';
import { TeamStatusStore, slotOf } from '@console/entities/team-run';
import { localTimeOf, TranslocoService } from '@console/shared/i18n';
import { ConfirmFailure, Sheet, type ConfirmOptions } from '@console/shared/ui';
import type { RunResponse, SlotLock, TeamCommandResponse, TeamSlot } from '@shared/contracts';
import { TeamCommandsClient, textOf, type CommandFailure, type CommandResult } from './team-commands.client';

/** Which project a command is for: its slug and the name the owner reads. */
export interface CommandTarget {
  readonly slug: string;
  readonly name: string;
}

/**
 * The result note at the top of the panel (a margin note, like an answered card): moss when done, grey when nothing
 * changed, ochre when nobody knows yet whether the run started.
 */
export interface CommandOutcome {
  readonly tone: 'positive' | 'neutral' | 'warning';
  readonly verb: string;
  readonly detail: string | null;
  /** The run log, where the owner checks what happened. */
  readonly runLogUrl: string | null;
  /** ISO 8601. */
  readonly at: string;
}

/** When `Retry-After` is missing: the routine's cap is per hour, the Worker's default is ten minutes. */
const DEFAULT_RETRY_AFTER_S = 600;

/**
 * Pause, resume and Run now with one confirmation each (#114). The dialog stays open on a refusal, with the reason
 * and Try again (the same request again); an answer that changes nothing ("already paused", "a run is in progress")
 * or one nobody can confirm ("no answer") closes it and becomes the result note. After every command the team status
 * takes the Worker's answer at once and is read again from the run log.
 */
@Injectable({ providedIn: 'root' })
export class TeamCommands {
  private readonly sheet = inject(Sheet);
  private readonly client = inject(TeamCommandsClient);
  private readonly store = inject(TeamStatusStore);
  private readonly transloco = inject(TranslocoService);
  /** The clock the messages use; a seam for specs. */
  now: () => number = () => Date.now();

  /** The outcome, or `null` when the owner backed out. */
  async pause(target: CommandTarget): Promise<CommandOutcome | null> {
    const t = this.t;
    return this.confirmed(
      {
        title: t('commands.dialog.pauseTitle', { name: target.name }),
        message: '',
        items: [t('commands.dialog.pause1'), t('commands.dialog.pause2'), t('commands.dialog.pause3')],
        input: { label: t('commands.dialog.reason'), hint: t('commands.dialog.reasonHint'), maxLength: 300 },
        confirmLabel: t('commands.dialog.pauseOk'),
      },
      async (reason) => this.pauseOutcome(target, await this.client.pause(target.slug, reason)),
    );
  }

  async resume(target: CommandTarget): Promise<CommandOutcome | null> {
    const t = this.t;
    const pausedItself = this.store.status()?.state === 'paused-by-team';
    return this.confirmed(
      {
        title: t('commands.dialog.resumeTitle', { name: target.name }),
        message: t('commands.dialog.resumeBody'),
        ...(pausedItself ? { warning: t('commands.dialog.resumeTeam') } : {}),
        confirmLabel: t('commands.dialog.resumeOk'),
      },
      async () => this.resumeOutcome(target, await this.client.resume(target.slug)),
    );
  }

  async run(target: CommandTarget, slot: TeamSlot): Promise<CommandOutcome | null> {
    const t = this.t;
    return this.confirmed(
      {
        title: t('commands.dialog.runTitle', { slot: t(`commands.slot.${slot}L`) }),
        message: t(`commands.dialog.run_${slot}`),
        note: t('commands.dialog.quota'),
        confirmLabel: t('commands.dialog.runOk'),
      },
      async () => this.runOutcome(slot, await this.client.run(target.slug, slot)),
    );
  }

  private readonly t = (key: string, params?: Record<string, unknown>): string =>
    this.transloco.translate(key, params);

  private time(iso: string | number): string {
    return localTimeOf(iso, this.transloco.getActiveLang());
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
          // Whatever happened, the run log is read again: the next press must see the current state.
          void this.store.refresh();
        }
      },
    });
    return isDone ? outcome : null;
  }

  private outcome(tone: CommandOutcome['tone'], verb: string, detail: string | null = null): CommandOutcome {
    return {
      tone,
      verb,
      detail,
      runLogUrl: this.store.status()?.runLogUrl ?? null,
      at: new Date(this.now()).toISOString(),
    };
  }

  private pauseOutcome(target: CommandTarget, result: CommandResult<TeamCommandResponse>): CommandOutcome {
    if (result.ok) {
      this.store.applyState('paused-by-owner', new Date(this.now()).toISOString());
      return this.outcome('positive', this.t('commands.result.paused', { name: target.name }));
    }
    if (result.failure.kind === 'already-paused') {
      const pausedAt = textOf(result.failure, 'pausedAt');
      return this.outcome(
        'neutral',
        pausedAt === null
          ? this.t('commands.result.alreadyPaused', { name: target.name })
          : this.t('commands.result.alreadyPausedSince', { name: target.name, time: this.time(pausedAt) }),
      );
    }
    throw this.refusal(result.failure, null);
  }

  private resumeOutcome(target: CommandTarget, result: CommandResult<TeamCommandResponse>): CommandOutcome {
    if (result.ok || result.failure.kind === 'not-paused') {
      this.store.applyState('running', null);
      return result.ok
        ? this.outcome('positive', this.t('commands.result.resumed', { name: target.name }))
        : this.outcome('neutral', this.t('commands.result.alreadyRunning', { name: target.name }));
    }
    throw this.refusal(result.failure, null);
  }

  private runOutcome(slot: TeamSlot, result: CommandResult<RunResponse>): CommandOutcome {
    const name = this.t(`commands.slot.${slot}`);
    if (result.ok) {
      this.store.applyLock(slot, {
        kind: 'requested',
        since: result.value.requestedAt,
        until: result.value.lockedUntil,
      });
      return this.outcome(
        'positive',
        this.t('commands.result.requested', { slot: this.t(`commands.slot.${slot}N`) }),
        this.t('commands.result.requestedDetail'),
      );
    }
    const failure = result.failure;
    const since = textOf(failure, 'since') ?? new Date(this.now()).toISOString();
    const until = textOf(failure, 'until') ?? since;
    switch (failure.kind) {
      case 'run-in-progress': {
        const lock: SlotLock = { kind: 'started', runId: textOf(failure, 'runId') ?? '', since, until };
        this.store.applyLock(slot, lock);
        return this.outcome(
          'neutral',
          this.t('commands.result.overlap', { slot: name, time: this.time(since) }),
        );
      }
      case 'run-requested':
        this.store.applyLock(slot, {
          kind: textOf(failure, 'lock') === 'unknown' ? 'unknown' : 'requested',
          since,
          until,
        });
        return this.outcome(
          'neutral',
          this.t('commands.result.requestedAlready', {
            slot: name,
            time: this.time(since),
            until: this.time(until),
          }),
        );
      case 'routine-unknown': {
        const at = new Date(this.now()).toISOString();
        this.store.applyLock(slot, { kind: 'unknown', since: at, until });
        return this.outcome('warning', this.t('commands.result.timeout', { time: this.time(until) }));
      }
      default:
        throw this.refusal(failure, slot);
    }
  }

  /** The dialog's alert for a refusal, in words the owner can act on. */
  private refusal(failure: CommandFailure, slot: TeamSlot | null): ConfirmFailure {
    const t = this.t;
    const slotName = slot === null ? '' : t(`commands.slot.${slot}`);
    const status = this.store.status();
    const secrets = slot === null || status === null ? null : slotOf(status, slot).secrets;
    const retryAt = this.time(this.now() + (failure.retryAfter ?? DEFAULT_RETRY_AFTER_S) * 1000);
    const messages: Partial<Record<CommandFailure['kind'], string>> = {
      'rate-limited': t('commands.error.rate', { time: retryAt }),
      'routine-paused': t('commands.error.routinePaused', { slot: slotName }),
      'bad-token': t('commands.error.badToken', { slot: slotName, secret: secrets?.token ?? '' }),
      'bad-routine': t('commands.error.badRoutine', { slot: slotName, secret: secrets?.routine ?? '' }),
      'not-configured': t('commands.error.notConfigured', { slot: slotName }),
      'run-paused': t('commands.error.runPaused'),
      service: t('commands.error.service'),
      github: t('commands.error.github'),
      'github-rate-limited': t('commands.error.githubRate', { time: retryAt }),
      'not-connected': t('commands.error.connect'),
      'no-run-log': t('commands.error.noLog'),
      offline: t('commands.error.offline'),
    };
    return new ConfirmFailure(messages[failure.kind] ?? t('commands.error.unknown'));
  }
}
