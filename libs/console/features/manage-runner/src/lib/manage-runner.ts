import { inject, Injectable } from '@angular/core';
import { RunnersApi, runnerFailureKeyOf, type RunnerProjectOption } from '@console/entities/runner';
import { TranslocoService } from '@console/shared/i18n';
import { ConfirmFailure, Sheet } from '@console/shared/ui';
import type { RunnerDto } from '@shared/contracts';
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

/**
 * A runner's own actions on Settings › Runners (#464): which projects it may serve, and revoke. Revoking is final
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

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }
}
