import { LiveAnnouncer } from '@angular/cdk/a11y';
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
  viewChild,
} from '@angular/core';
import {
  ActionsSetupApi,
  canOpenPrOf,
  workflowStepOf,
  type WorkflowPrRefusal,
} from '@console/entities/actions-setup';
import { NetworkStatus } from '@console/shared/api';
import { LocalTimePipe, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Banner, Button, CopyCode, focusAfterRender, Icon } from '@console/shared/ui';
import type { ActionsSetupDto, ActionsSetupPrDto } from '@shared/contracts';
import { WORKFLOW_FILE_PATH, WorkflowFile } from './workflow-file';

/** What step 4 shows (UX spec §3.4), after the check and whatever the last «Открыть PR» answered. */
type WorkflowStepShown =
  | 'ok'
  | 'leftover'
  | 'missing'
  | 'outdated'
  | 'modified'
  | 'unknown'
  | 'pr-open'
  | 'pr-foreign';

/**
 * Step 4 of the Actions setup page: the workflow file on the default branch, the console's PR, and the Copy path
 * beside it. «Открыть PR» calls `POST …/workflow-pr` with no body; every answer of that route has its own words
 * (#759 PR 5 scope), and the page and its other steps stay usable whatever it says. While the app lacks the
 * permissions or the operator switched the PR path off, «Показать файл» is the primary action.
 */
@Component({
  selector: 'tc-workflow-step',
  imports: [Banner, Button, CopyCode, Icon, LocalTimePipe, TranslocoPipe, WorkflowFile],
  templateUrl: './workflow-step.html',
  styleUrl: './workflow-step.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowStep {
  private readonly api = inject(ActionsSetupApi);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly transloco = inject(TranslocoService);
  private readonly injector = inject(Injector);
  protected readonly network = inject(NetworkStatus);

  readonly slug = input.required<string>();
  readonly repo = input.required<string>();
  readonly setup = input.required<ActionsSetupDto>();
  readonly branch = input<string | null>(null);
  readonly branchLabel = input.required<string>();
  /** The route said the file is already current, or a PR just opened: the page checks again. */
  readonly recheck = output<void>();

  private readonly prLink = viewChild('prLink', { read: ElementRef<HTMLElement> });

  protected readonly path = WORKFLOW_FILE_PATH;
  protected readonly opening = signal(false);
  protected readonly refusal = signal<WorkflowPrRefusal | null>(null);
  /** The PR this page just opened or was told about; a fresh check replaces it with what GitHub says. */
  protected readonly knownPr = signal<ActionsSetupPrDto | null>(null);
  /** The operator's kill switch answered once: the Copy path leads from then on. */
  protected readonly isPrPathOff = signal(false);
  protected readonly isFileOpen = signal(false);

  protected readonly view = computed(() => workflowStepOf(this.setup()));
  protected readonly pr = computed(() => this.knownPr() ?? this.view().pr);
  protected readonly shown = computed<WorkflowStepShown>(() => {
    const known = this.knownPr();
    if (known !== null && this.view().kind !== 'ok' && this.view().kind !== 'leftover') {
      return known.provenance === 'console' ? 'pr-open' : 'pr-foreign';
    }
    return this.view().kind;
  });
  protected readonly canOpenPr = computed(() => canOpenPrOf(this.setup()) && !this.isPrPathOff());
  protected readonly action = computed(() => (this.knownPr() === null ? this.view().action : null));
  /** The Copy path leads when no PR can be opened from here. */
  protected readonly isCopyPrimary = computed(() => this.action() !== null && !this.canOpenPr());

  constructor() {
    // A new answer from GitHub is the truth again: what the last click said no longer applies.
    effect(() => {
      this.setup();
      untracked(() => {
        this.knownPr.set(null);
        if (this.refusal()?.kind !== 'write-disabled') {
          this.refusal.set(null);
        }
      });
    });
  }

  protected toggleFile(): void {
    this.isFileOpen.update((open) => !open);
  }

  protected async openPr(): Promise<void> {
    if (this.opening() || !this.network.online() || !this.canOpenPr()) {
      return;
    }
    const slug = this.slug();
    this.opening.set(true);
    this.refusal.set(null);
    const result = await this.api.openWorkflowPr(slug);
    this.opening.set(false);
    if (this.slug() !== slug) {
      return;
    }
    if (result.ok) {
      this.knownPr.set({ number: result.value.number, url: result.value.url, provenance: 'console' });
      this.focusPrLink();
      await this.announce('actions.pr.openedLive', { n: result.value.number });
      return;
    }
    this.onRefusal(result.problem);
  }

  private onRefusal(refusal: WorkflowPrRefusal): void {
    switch (refusal.kind) {
      case 'pr-open':
        if (refusal.pr !== null) {
          this.knownPr.set(refusal.pr);
          this.focusPrLink();
          void this.announce('actions.pr.alreadyLive', { n: refusal.pr.number });
          return;
        }
        // An open PR the answer did not name: the check finds it.
        this.recheck.emit();
        return;
      case 'ready':
        this.refusal.set(refusal);
        this.recheck.emit();
        return;
      case 'write-disabled':
        this.isPrPathOff.set(true);
        this.isFileOpen.set(true);
        this.refusal.set(refusal);
        return;
      case 'tampered':
      case 'branch-exists':
        this.isFileOpen.set(true);
        this.refusal.set(refusal);
        return;
      default:
        this.refusal.set(refusal);
    }
  }

  /** The words of the last refusal, or null when it has its own block (or none). */
  protected readonly refusalText = computed(() => {
    const refusal = this.refusal();
    if (refusal === null) {
      return null;
    }
    const branch = this.branchLabel();
    switch (refusal.kind) {
      case 'permission-missing':
        return refusal.permissions.length === 0
          ? this.t('actions.pr.err.permissionBare')
          : this.t('actions.pr.err.permission', { permissions: refusal.permissions.join(', ') });
      case 'branch-exists':
        return this.t('actions.pr.err.branchExists');
      case 'tampered':
        return this.t('actions.pr.err.tampered');
      case 'ready':
        return this.t('actions.pr.err.ready');
      case 'downgrade':
        return refusal.pins.length === 0
          ? this.t('actions.pr.err.downgradeBare', { branch })
          : this.t('actions.pr.err.downgrade', { branch, pins: refusal.pins.join(', ') });
      case 'write-disabled':
        return null;
      case 'misconfigured':
        return this.t('actions.file.misconfigured');
      case 'unverified':
        return this.t('actions.pr.err.unverified');
      case 'rate':
        return null;
      case 'offline':
        return this.t('actions.pr.err.offline');
      case 'forbidden':
        return this.t('runners.err.forbidden');
      case 'pr-open':
      case 'not-found':
      case 'failed':
        return this.t('actions.pr.err.failed');
    }
  });

  /** A GitHub link that goes with the refusal: the installation, or the branches page. */
  protected readonly refusalLink = computed(() => {
    const refusal = this.refusal();
    if (refusal?.kind === 'permission-missing' && refusal.link !== null) {
      return { url: refusal.link, key: 'actions.perm.link' };
    }
    if (refusal?.kind === 'branch-exists' && refusal.link !== null) {
      return { url: refusal.link, key: 'actions.pr.err.branchLink' };
    }
    return null;
  });

  protected readonly retryAt = computed(() => {
    const refusal = this.refusal();
    return refusal?.kind === 'rate' ? refusal.retryAt : null;
  });

  private focusPrLink(): void {
    focusAfterRender(() => this.prLink(), { injector: this.injector });
  }

  private async announce(key: string, params: Record<string, unknown>): Promise<void> {
    await this.announcer.announce(this.t(key, params), 'polite');
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }
}
