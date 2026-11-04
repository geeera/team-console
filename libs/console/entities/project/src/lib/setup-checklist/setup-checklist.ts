import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { LocalTimePipe, TranslocoPipe } from '@console/shared/i18n';
import { Button, CopyCode, Icon, IconName } from '@console/shared/ui';
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
  // Ticks itself after the first event (#205): a clock, not a step number the owner would read as a to-do.
  waiting: 'clock',
  unknown: 'help',
};

let nextChecklistId = 0;

/**
 * The five-step setup checklist (#24) shared by New project and the setup page. Each step says its state in words
 * (the icon is decorative); a missing step has a one-line fix and a "How to fix" disclosure. A waiting step needs
 * nothing from the owner, so it has neither.
 */
@Component({
  selector: 'tc-setup-checklist',
  imports: [Button, CopyCode, Icon, LocalTimePipe, TranslocoPipe],
  templateUrl: './setup-checklist.html',
  styleUrl: './setup-checklist.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SetupChecklist {
  readonly steps = input.required<readonly SetupStep[]>();
  readonly context = input.required<SetupChecklistContext>();

  protected readonly id = `tc-setup-${nextChecklistId++}`;
  protected readonly open = signal<ReadonlySet<string>>(new Set());

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
}
