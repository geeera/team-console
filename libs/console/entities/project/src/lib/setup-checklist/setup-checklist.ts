import { LiveAnnouncer } from '@angular/cdk/a11y';
import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { LocalTimePipe, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Icon, IconName } from '@console/shared/ui';
import { routineSecretName } from '@shared/contracts';
import type { SetupStep, SetupStepState } from '../project-setup';

/** What the step copy names; every value comes from the Worker or the owner's own input, never a client constant. */
export interface SetupChecklistContext {
  readonly repo: string;
  readonly slug: string;
  /** `team-console-<env>` from the connection status; the copy falls back to "the app" wording without it. */
  readonly appName: string | null;
  /** The install page from the Worker (#83), only while step 1 is missing. */
  readonly installUrl: string | null;
  /** The connected account. */
  readonly login: string | null;
  /** The repository owner as GitHub spells it, once the Worker read it. */
  readonly repoOwner: string | null;
  readonly lastEventAt: string | null;
  /** The Worker environment for the `wrangler secret put` command; `<env>` until known. */
  readonly environment: string | null;
}

const MARKS: Readonly<Partial<Record<SetupStepState, IconName>>> = {
  done: 'check',
  missing: 'alert',
  unknown: 'help',
};

let nextChecklistId = 0;

/**
 * The five-step setup checklist (#24) shared by New project and the setup page. Each step says its state in words
 * (the icon is decorative); a missing step has a one-line fix and a "How to fix" disclosure.
 */
@Component({
  selector: 'tc-setup-checklist',
  imports: [Button, Icon, LocalTimePipe, TranslocoPipe],
  templateUrl: './setup-checklist.html',
  styleUrl: './setup-checklist.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SetupChecklist {
  private readonly announcer = inject(LiveAnnouncer);
  private readonly transloco = inject(TranslocoService);
  private readonly clipboard = inject(DOCUMENT).defaultView?.navigator.clipboard ?? null;

  readonly steps = input.required<readonly SetupStep[]>();
  readonly context = input.required<SetupChecklistContext>();

  protected readonly id = `tc-setup-${nextChecklistId++}`;
  protected readonly open = signal<ReadonlySet<string>>(new Set());
  protected readonly copied = signal(false);
  protected readonly copyFailed = signal(false);

  protected readonly secretName = computed(() => routineSecretName(this.context().slug));
  protected readonly command = computed(
    () => `npx wrangler secret put ${this.secretName()} --env ${this.context().environment ?? '<env>'}`,
  );
  protected readonly params = computed(() => {
    const context = this.context();
    return {
      repo: context.repo,
      app: context.appName ?? 'team-console',
      login: context.login ?? '',
      repoOwner: context.repoOwner ?? context.repo.split('/')[0] ?? '',
      secret: this.secretName(),
    };
  });

  protected markOf(state: SetupStepState): IconName | null {
    return MARKS[state] ?? null;
  }

  protected stateKey(step: SetupStep): string {
    return step.state === 'waiting' ? 'settings.step.waiting' : `settings.step.${step.state}`;
  }

  protected isOpen(id: string): boolean {
    return this.open().has(id);
  }

  protected toggle(id: string): void {
    const next = new Set(this.open());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.open.set(next);
  }

  protected async copyCommand(): Promise<void> {
    this.copyFailed.set(false);
    try {
      if (this.clipboard === null) {
        throw new Error('clipboard unavailable');
      }
      await this.clipboard.writeText(this.command());
    } catch {
      // Denied permission or no clipboard (an insecure origin): say so and leave the command selectable.
      this.copyFailed.set(true);
      return;
    }
    this.copied.set(true);
    await this.announcer.announce(this.transloco.translate('settings.common.copied'), 'polite');
  }
}
