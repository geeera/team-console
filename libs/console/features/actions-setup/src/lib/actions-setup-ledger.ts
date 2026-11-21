import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  firstMissingStepOf,
  itemOf,
  linkOf,
  missingStepsOf,
  stepStateOf,
  subCheckToneOf,
  type ActionsCheckedStepId,
  type ActionsStepState,
  type SubCheckTone,
} from '@console/entities/actions-setup';
import type { ActionsFirstJob } from '@console/entities/job';
import { spaceUrlOf } from '@console/entities/project';
import { LocalTimePipe, TranslocoPipe } from '@console/shared/i18n';
import { Button, CopyCode, focusAfterRender, Icon, type IconName } from '@console/shared/ui';
import {
  ACTIONS_ENVIRONMENT,
  ACTIONS_INFERENCE_KEY_SECRET,
  isGitHubUiUrl,
  type ActionsSetupDto,
  type ActionsSetupItemId,
  type ProjectDispatchDto,
} from '@shared/contracts';
import { ActionsSwitchOn } from './switch-on';
import { WorkflowStep } from './workflow-step';

interface SubCheck {
  readonly id: ActionsSetupItemId;
  readonly key: string;
  readonly tone: SubCheckTone;
}

const SUB_CHECK_KEYS: Readonly<Record<string, string>> = {
  environment: 'environment',
  'branch-policy': 'branch',
  'protection-rules': 'rules',
  secret: 'secret',
};

const TONE_ICONS: Readonly<Record<SubCheckTone, IconName>> = {
  ok: 'check',
  missing: 'alert',
  warning: 'alert',
  unknown: 'minus',
};

/**
 * The Actions setup ledger (#759 UX spec §2–§3): five numbered steps (a sixth, the first job, once it is on) in the project setup's checklist pattern,
 * grouped by where the customer acts, each with its state word, its fix line and a «Как сделать» disclosure with the
 * exact GitHub page and Copy for every exact string. The first step that is not done is open. Before the first
 * answer only the titles show. Only the fixed names `team-console` and `TC_INFERENCE_API_KEY` ever appear.
 */
@Component({
  selector: 'tc-actions-setup-ledger',
  imports: [ActionsSwitchOn, Button, CopyCode, Icon, LocalTimePipe, RouterLink, TranslocoPipe, WorkflowStep],
  templateUrl: './actions-setup-ledger.html',
  styleUrl: './actions-setup-ledger.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActionsSetupLedger {
  private readonly injector = inject(Injector);

  readonly slug = input.required<string>();
  readonly repo = input.required<string>();
  readonly projectName = input.required<string>();
  /** `null` before the first answer. */
  readonly setup = input.required<ActionsSetupDto | null>();
  readonly branch = input<string | null>(null);
  readonly branchLabel = input.required<string>();
  /** Settings › Team of this project, for step 1 and the switch's `access-source-hosted` refusal. */
  readonly teamUrl = input<string | null>(null);
  /** Step 6's signal, from the jobs the page already reads; `null` while unknown (a member, a failed read). */
  readonly firstJob = input<ActionsFirstJob | null>(null);

  readonly recheck = output<void>();
  readonly switched = output<ProjectDispatchDto>();

  private readonly titles = viewChildren<ElementRef<HTMLElement>>('stepTitle');

  protected readonly environmentName = ACTIONS_ENVIRONMENT;
  protected readonly secretName = ACTIONS_INFERENCE_KEY_SECRET;
  private static nextId = 0;
  protected readonly id = `tc-actions-ledger-${ActionsSetupLedger.nextId++}`;
  private readonly opened = signal<ReadonlySet<string>>(new Set());

  protected readonly spaceUrl = computed(() => spaceUrlOf(this.slug(), undefined));
  protected readonly params = computed(() => ({ repo: this.repo(), branch: this.branchLabel() }));
  protected readonly firstMissing = computed(() => firstMissingStepOf(this.setup()));
  protected readonly missingCount = computed(() => {
    const setup = this.setup();
    return setup === null ? 0 : Math.max(setup.ready ? 0 : 1, missingStepsOf(setup).length);
  });

  protected readonly subChecks = computed<readonly SubCheck[]>(() => {
    const setup = this.setup();
    if (setup === null) {
      return [];
    }
    return (['environment', 'branch-policy', 'protection-rules', 'secret'] as const).map((id) => {
      const tone = subCheckToneOf(itemOf(setup, id));
      return { id, key: `actions.env.${SUB_CHECK_KEYS[id]}.${tone === 'warning' ? 'warning' : tone}`, tone };
    });
  });

  /** Step 3's one link: the Environment page GitHub named, else the repository's environments list. */
  protected readonly environmentLink = computed(() => {
    const setup = this.setup();
    const named = setup === null ? null : linkOf(itemOf(setup, 'environment')) ?? linkOf(itemOf(setup, 'branch-policy'));
    if (named !== null) {
      return named;
    }
    const isMissing = setup !== null && itemOf(setup, 'environment').status === 'missing';
    const url = `https://github.com/${this.repo()}/settings/environments${isMissing ? '/new' : ''}`;
    return isGitHubUiUrl(url) ? url : null;
  });
  protected readonly isEnvironmentMissing = computed(() => {
    const setup = this.setup();
    return setup !== null && itemOf(setup, 'environment').status === 'missing';
  });
  protected readonly permissionsLink = computed(() => {
    const setup = this.setup();
    return setup === null ? null : linkOf(itemOf(setup, 'app-permissions'));
  });
  protected readonly rulesetLink = computed(() => {
    const url = `https://github.com/${this.repo()}/settings/rules`;
    return isGitHubUiUrl(url) ? url : null;
  });

  constructor() {
    // A new answer opens its first missing step; what the customer opened by hand stays open.
    effect(() => {
      const first = this.firstMissing();
      if (first !== null) {
        untracked(() => this.opened.update((open) => new Set([...open, first])));
      }
    });
  }

  protected toneIcon(tone: SubCheckTone): IconName {
    return TONE_ICONS[tone];
  }

  protected stateOf(step: ActionsCheckedStepId): ActionsStepState {
    return stepStateOf(this.setup(), step);
  }

  protected isOpen(key: string): boolean {
    return this.opened().has(key);
  }

  protected toggle(key: string): void {
    this.opened.update((open) => {
      const next = new Set(open);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  }

  /** «Включить» was pressed while not ready (UX spec §9): focus the first step that is not done. */
  protected focusFirstMissing(): void {
    const first = this.firstMissing();
    if (first === null) {
      return;
    }
    focusAfterRender(() => this.titles().find((title) => title.nativeElement.dataset['step'] === first), {
      injector: this.injector,
    });
  }
}
