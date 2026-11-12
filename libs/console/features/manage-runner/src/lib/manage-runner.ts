import { inject, Injectable } from '@angular/core';
import {
  RunnersApi,
  runnerFailureKeyOf,
  type RunnerFailureKind,
  type RunnerProjectOption,
} from '@console/entities/runner';
import { TranslocoService } from '@console/shared/i18n';
import { ConfirmFailure, Sheet } from '@console/shared/ui';
import type { PendingEnrolmentDto, RunnerDto } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';
import { RunnerProjectsDialog, type RunnerProjectsData } from './runner-projects-dialog';

export interface ManagedRunnerTarget {
  readonly accountId: string;
  readonly runner: RunnerDto;
}

/** How a revoke ended: the runner as the Worker answered it, or why it was not revoked. */
export type RevokeOutcome =
  | { readonly kind: 'revoked'; readonly runner: RunnerDto }
  /** Someone revoked it meanwhile (409 `runner-revoked`): the list is stale and should be read again. */
  | { readonly kind: 'stale' }
  | { readonly kind: 'cancelled' };

export type ClearSuspectOutcome =
  | { readonly kind: 'cleared'; readonly runner: RunnerDto }
  /** The mark was cleared, the runner revoked or gone meanwhile: the list should be read again. */
  | { readonly kind: 'stale' }
  | { readonly kind: 'cancelled' };

export type WithdrawOutcome =
  | { readonly kind: 'withdrawn' }
  /** The code was used, expired or withdrawn meanwhile: the list should be read again. */
  | { readonly kind: 'stale' }
  | { readonly kind: 'cancelled' };

const STALE_KINDS: readonly RunnerFailureKind[] = ['not-suspect', 'revoked', 'not-found'];

/**
 * A runner's own actions on Settings › Runners (#464): which projects it may serve, clearing its suspect mark and
 * withdrawing a pending enrolment code (#492), and revoke. Revoking is final
 * (threat model C4: a revoked key is never trusted again) and cancels the jobs it holds, so it asks first with a
 * danger confirmation; a refusal keeps the dialog open with the reason and Try again.
 */
@Injectable({ providedIn: 'root' })
export class ManageRunner {
  private readonly api = inject(RunnersApi);
  private readonly sheet = inject(Sheet);
  private readonly transloco = inject(TranslocoService);

  /** The runner after the change, or `null` when the owner backed out. */
  async editProjects(
    target: ManagedRunnerTarget & { readonly projects: readonly RunnerProjectOption[] },
  ): Promise<RunnerDto | null> {
    const ref = this.sheet.open<RunnerDto, RunnerProjectsData>(RunnerProjectsDialog, {
      title: this.t('runners.projects.title'),
      width: 'wide',
      data: { accountId: target.accountId, runner: target.runner, projects: target.projects },
    });
    return (await firstValueFrom(ref.closed)) ?? null;
  }

  async revoke(target: ManagedRunnerTarget): Promise<RevokeOutcome> {
    // Written by the confirm's action, read once the dialog closed.
    const seen: { revoked: RunnerDto | null; stale: boolean } = { revoked: null, stale: false };
    const confirmed = await this.sheet.confirm({
      title: this.t('runners.revoke.title', { name: target.runner.name }),
      message: this.t('runners.revoke.message'),
      items: [this.t('runners.revoke.itemKey'), this.t('runners.revoke.itemJobs'), this.t('runners.revoke.itemAgain')],
      confirmLabel: this.t('runners.revoke.confirm'),
      busyLabel: this.t('runners.revoke.busy'),
      tone: 'danger',
      action: async () => {
        const result = await this.api.revoke(target.accountId, target.runner.id);
        if (!result.ok) {
          seen.stale = result.failure.kind === 'revoked' || result.failure.kind === 'not-found';
          throw new ConfirmFailure(this.t(runnerFailureKeyOf(result.failure)));
        }
        seen.revoked = result.value;
      },
    });
    if (confirmed && seen.revoked !== null) {
      return { kind: 'revoked', runner: seen.revoked };
    }
    return seen.stale ? { kind: 'stale' } : { kind: 'cancelled' };
  }

  /**
   * Clears a runner's suspect mark (#492) after a confirmation that says what the mark meant: only for calls the
   * owner recognises; otherwise revoke. `stale` when the mark or the runner changed meanwhile.
   */
  async clearSuspect(target: ManagedRunnerTarget): Promise<ClearSuspectOutcome> {
    const seen: { cleared: RunnerDto | null; stale: boolean } = { cleared: null, stale: false };
    const confirmed = await this.sheet.confirm({
      title: this.t('runners.suspect.title', { name: target.runner.name }),
      message: this.t('runners.suspect.message'),
      items: [this.t('runners.suspect.itemYours'), this.t('runners.suspect.itemAgain'), this.t('runners.suspect.itemRevoke')],
      confirmLabel: this.t('runners.suspect.confirm'),
      busyLabel: this.t('runners.suspect.busy'),
      action: async () => {
        const result = await this.api.clearSuspect(target.accountId, target.runner.id);
        if (!result.ok) {
          seen.stale = STALE_KINDS.includes(result.failure.kind);
          throw new ConfirmFailure(this.t(runnerFailureKeyOf(result.failure)));
        }
        seen.cleared = result.value;
      },
    });
    if (confirmed && seen.cleared !== null) {
      return { kind: 'cleared', runner: seen.cleared };
    }
    return seen.stale ? { kind: 'stale' } : { kind: 'cancelled' };
  }

  /** Withdraws a pending enrolment code (#492). `stale` when it was used, expired or withdrawn meanwhile. */
  async withdrawEnrolment(accountId: string, enrolment: PendingEnrolmentDto): Promise<WithdrawOutcome> {
    const seen: { withdrawn: boolean; stale: boolean } = { withdrawn: false, stale: false };
    const confirmed = await this.sheet.confirm({
      title: this.t('runners.pending.withdrawTitle', { name: enrolment.name }),
      message: this.t('runners.pending.withdrawMessage'),
      confirmLabel: this.t('runners.pending.withdrawConfirm'),
      busyLabel: this.t('runners.pending.withdrawBusy'),
      tone: 'danger',
      action: async () => {
        const result = await this.api.withdrawEnrolment(accountId, enrolment.id);
        if (!result.ok) {
          seen.stale = result.failure.kind === 'not-found';
          throw new ConfirmFailure(this.t(runnerFailureKeyOf(result.failure)));
        }
        seen.withdrawn = true;
      },
    });
    if (confirmed && seen.withdrawn) {
      return { kind: 'withdrawn' };
    }
    return seen.stale ? { kind: 'stale' } : { kind: 'cancelled' };
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }
}
