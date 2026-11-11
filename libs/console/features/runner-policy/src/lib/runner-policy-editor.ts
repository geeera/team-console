import { LiveAnnouncer } from '@angular/cdk/a11y';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import {
  RunnersApi,
  liveRunnersOf,
  runnerFailureKeyOf,
  type RunnerFailure,
  type RunnerPolicyScope,
} from '@console/entities/runner';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import {
  Banner,
  Button,
  Choice,
  ChoiceGroup,
  Field,
  FieldControl,
  Icon,
  IconButton,
  StateBlock,
} from '@console/shared/ui';
import {
  RUNNER_POLICY_OFFLINE_MAX_SECONDS,
  RUNNER_POLICY_OFFLINE_MIN_SECONDS,
  type RunnerDto,
  type RunnerPolicy,
  type RunnerPolicyDto,
} from '@shared/contracts';
import {
  moveFallback,
  policyFormOf,
  policyOfForm,
  type PolicyForm,
  type PolicyFormError,
  type PolicyMode,
} from './runner-policy-form';

type EditorStatus = 'loading' | 'ready' | 'error';

let nextEditorId = 0;

/**
 * Placement for one scope (#464, ADR 0008 decision 12): which runners may claim the jobs — `any` allowed runner,
 * `pinned` to one, or `failover` (the preferred one while it heartbeats, then the fallbacks in order once it has been
 * silent for `offline_after_seconds`); a project may also follow the account default. Read with `GET …/runner-policy`,
 * saved with `PUT`; the change applies at the runner's next claim, with no re-enrolment and no new job token.
 */
@Component({
  selector: 'tc-runner-policy-editor',
  imports: [Banner, Button, Choice, ChoiceGroup, Field, FieldControl, Icon, IconButton, StateBlock, TranslocoPipe],
  templateUrl: './runner-policy-editor.html',
  styleUrl: './runner-policy-editor.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RunnerPolicyEditor {
  private readonly api = inject(RunnersApi);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);

  readonly scope = input.required<RunnerPolicyScope>();
  /** Every runner of the account (revoked ones only to name them in a stored policy). */
  readonly runners = input.required<readonly RunnerDto[]>();
  /** Bumped by the parent when something this policy falls back to changed (the account default): read it again. */
  readonly revision = input(0);
  /** The policy as the Worker stored it after a save. */
  readonly saved = output<RunnerPolicyDto>();

  protected readonly id = `tc-runner-policy-${nextEditorId++}`;
  protected readonly offlineMin = RUNNER_POLICY_OFFLINE_MIN_SECONDS;
  protected readonly offlineMax = RUNNER_POLICY_OFFLINE_MAX_SECONDS;
  protected readonly status = signal<EditorStatus>('loading');
  protected readonly loadFailure = signal<RunnerFailure | null>(null);
  protected readonly stored = signal<RunnerPolicyDto | null>(null);
  protected readonly form = signal<PolicyForm>(policyFormOf(null, false));
  protected readonly saving = signal(false);
  protected readonly saveFailure = signal<string | null>(null);
  protected readonly isSaved = signal(false);
  protected readonly formError = signal<PolicyFormError | null>(null);

  protected readonly canInherit = computed(() => this.scope().kind === 'project');
  protected readonly live = computed(() => liveRunnersOf(this.runners()));
  protected readonly canPin = computed(() => this.live().length > 0);
  protected readonly canFailover = computed(() => this.live().length > 1);
  protected readonly fallbackChoices = computed(() => {
    const { preferred, fallback } = this.form();
    return this.live().filter((runner) => runner.id !== preferred && !fallback.includes(runner.id));
  });
  protected readonly loadFailureText = computed(() => {
    const failure = this.loadFailure();
    return failure === null ? '' : this.t(runnerFailureKeyOf(failure));
  });
  protected readonly effectiveText = computed(() => {
    const dto = this.stored();
    if (dto === null) {
      return '';
    }
    const summary = this.summaryOf(dto.effective);
    return dto.policy === null && this.canInherit()
      ? this.t('runners.policy.effectiveInherited', { summary })
      : this.t('runners.policy.effective', { summary });
  });

  /** By value, so a parent that rebuilds the scope object does not reload the same policy. */
  private readonly scopeKey = computed(() => {
    const scope = this.scope();
    return scope.kind === 'account' ? `account:${scope.accountId}` : `project:${scope.slug}`;
  });

  constructor() {
    effect(() => {
      this.scopeKey();
      untracked(() => void this.load(this.scope()));
    });
    // A new revision changes what the policy falls back to, not the owner's own edits: refresh the summary only.
    effect(() => {
      if (this.revision() > 0) {
        untracked(() => void this.refreshEffective());
      }
    });
  }

  private async refreshEffective(): Promise<void> {
    const key = this.scopeKey();
    if (this.status() !== 'ready') {
      return;
    }
    const result = await this.api.policy(this.scope());
    // A failed refresh keeps the last summary; the next save or visit reads it again.
    if (result.ok && this.scopeKey() === key) {
      this.stored.set(result.value);
    }
  }

  protected retry(): void {
    void this.load(this.scope());
  }

  protected setMode(mode: PolicyMode): void {
    this.patch({ mode });
  }

  protected setPinned(runner: string): void {
    this.patch({ pinned: runner });
  }

  protected setPreferred(runner: string): void {
    this.patch({ preferred: runner, fallback: this.form().fallback.filter((id) => id !== runner) });
  }

  protected addFallback(runner: string): void {
    if (runner !== '') {
      this.patch({ fallback: [...this.form().fallback, runner] });
    }
  }

  protected removeFallback(index: number): void {
    this.patch({ fallback: this.form().fallback.filter((_, at) => at !== index) });
  }

  protected moveFallback(index: number, by: -1 | 1): void {
    this.patch({ fallback: moveFallback(this.form().fallback, index, by) });
  }

  protected setOfflineAfter(value: string): void {
    this.patch({ offlineAfter: value });
  }

  /** Whether a stored id is still a live runner (a revoked one is listed apart, so the owner sees why it fails). */
  protected canPinTo(runnerId: string): boolean {
    return this.live().some((runner) => runner.id === runnerId);
  }

  protected nameOf(runnerId: string): string {
    const runner = this.runners().find((entry) => entry.id === runnerId);
    if (runner === undefined) {
      return this.t('runners.policy.unknownRunner');
    }
    return runner.revokedAt === null ? runner.name : this.t('runners.policy.revokedRunner', { name: runner.name });
  }

  protected errorOf(field: PolicyFormError): string {
    return this.formError() === field ? this.t(`runners.policy.err.${field}`) : '';
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) {
      return;
    }
    const check = policyOfForm(this.form());
    if (!check.ok) {
      this.formError.set(check.error);
      return;
    }
    this.formError.set(null);
    this.saving.set(true);
    this.saveFailure.set(null);
    this.isSaved.set(false);
    const key = this.scopeKey();
    const result = await this.api.setPolicy(this.scope(), check.policy);
    this.saving.set(false);
    if (this.scopeKey() !== key) {
      return;
    }
    if (!result.ok) {
      this.saveFailure.set(this.t(runnerFailureKeyOf(result.failure)));
      return;
    }
    this.apply(result.value);
    this.isSaved.set(true);
    this.saved.emit(result.value);
    void this.announcer.announce(this.t('runners.policy.saved'), 'polite');
  }

  private patch(change: Partial<PolicyForm>): void {
    this.form.update((form) => ({ ...form, ...change }));
    this.formError.set(null);
    this.isSaved.set(false);
  }

  private async load(scope: RunnerPolicyScope): Promise<void> {
    const key = this.scopeKey();
    this.status.set('loading');
    this.isSaved.set(false);
    this.saveFailure.set(null);
    this.formError.set(null);
    const result = await this.api.policy(scope);
    if (this.scopeKey() !== key) {
      // Another scope was picked while this one loaded; its own load answers for it.
      return;
    }
    if (!result.ok) {
      this.loadFailure.set(result.failure);
      this.status.set('error');
      return;
    }
    this.loadFailure.set(null);
    this.apply(result.value);
    this.status.set('ready');
  }

  private apply(dto: RunnerPolicyDto): void {
    this.stored.set(dto);
    this.form.set(policyFormOf(dto.policy, this.canInherit()));
  }

  private summaryOf(policy: RunnerPolicy): string {
    switch (policy.mode) {
      case 'any':
        return this.t('runners.policy.summary.any');
      case 'pinned':
        return this.t('runners.policy.summary.pinned', { runner: this.nameOf(policy.runner) });
      case 'failover':
        return this.t('runners.policy.summary.failover', {
          runner: this.nameOf(policy.preferred),
          fallback: policy.fallback.map((id) => this.nameOf(id)).join(', '),
          seconds: policy.offline_after_seconds,
        });
    }
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }
}
