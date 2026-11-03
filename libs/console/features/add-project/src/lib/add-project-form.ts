import { LiveAnnouncer } from '@angular/cdk/a11y';
import {
  afterNextRender,
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DeploymentStore } from '@console/entities/app-info';
import { ConnectGitHubButton, GitHubConnectionStore } from '@console/entities/github-connection';
import {
  normalizeRepoInput,
  pendingSetupSteps,
  projectSetupRouteOf,
  SetupChecklist,
  type SetupChecklistContext,
} from '@console/entities/project';
import { NetworkStatus } from '@console/shared/api';
import { LocalTimePipe, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Callout, Field, FieldControl, Icon } from '@console/shared/ui';
import type { AddOutcome } from './add-outcome';
import { AddProject, type AddRefusal, type AddResult } from './add-project';

/** History state the setup page reads to say "Project added" instead of "N steps missing". */
export const JUST_ADDED_STATE = 'tcJustAdded';

/**
 * Add by name (#24): one `owner/repo` field, checked on submit only. Steps 1–3 run on the Worker before anything
 * is saved; a refusal shows the checklist with "Nothing was saved" and Check again re-submits the same value. Not
 * connected → it says to connect first and sends nothing. `embedded` (All projects, #194) drops the Cancel link:
 * the disclosure around it collapses instead.
 */
@Component({
  selector: 'tc-add-project-form',
  imports: [
    Button,
    Callout,
    ConnectGitHubButton,
    Field,
    FieldControl,
    Icon,
    LocalTimePipe,
    RouterLink,
    SetupChecklist,
    TranslocoPipe,
  ],
  templateUrl: './add-project-form.html',
  styleUrl: './add-project-form.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddProjectForm {
  private readonly router = inject(Router);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly transloco = inject(TranslocoService);
  private readonly injector = inject(Injector);
  private readonly adder = inject(AddProject);
  private readonly deployment = inject(DeploymentStore);

  /** Inside All projects' "Add by name" disclosure: no Cancel link (#194). */
  readonly embedded = input(false, { transform: booleanAttribute });

  protected readonly connection = inject(GitHubConnectionStore);
  protected readonly network = inject(NetworkStatus);

  protected readonly value = signal('');
  protected readonly fieldError = signal('');
  protected readonly busy = signal(false);
  protected readonly outcome = signal<AddOutcome | null>(null);
  /** The repository and slug of the last check, for the result copy. */
  protected readonly checked = signal<{ repo: string; slug: string } | null>(null);
  protected readonly connectRefused = signal(false);

  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('repoInput');
  private readonly result = viewChild<ElementRef<HTMLElement>>('result');

  /** The address the project will get, shown while the value is valid ("/p/{slug}"); also names its secret. */
  protected readonly previewSlug = computed(() => {
    const input = normalizeRepoInput(this.value());
    return input.ok ? input.slug : null;
  });
  /** Saving needs the owner connection: with none (or a lost one) the form sends nothing (#24 AC). */
  protected readonly needsConnect = computed(() => {
    const view = this.connection.view();
    return view === 'not-connected' || view === 'lost';
  });
  protected readonly isBlocked = computed(() => this.busy() || !this.network.online() || this.needsConnect());

  protected readonly checklistContext = computed<SetupChecklistContext | null>(() => {
    const checked = this.checked();
    const outcome = this.outcome();
    if (checked === null || outcome === null) {
      return null;
    }
    const refused = outcome.kind === 'refused' ? outcome : null;
    return {
      repo: checked.repo,
      slug: checked.slug,
      appName: this.connection.appName(),
      installUrl: refused?.installUrl ?? null,
      login: refused?.login ?? this.connection.login(),
      repoOwner: refused?.repoOwner ?? null,
      lastEventAt: null,
      environment: this.deployment.environment(),
    };
  });
  protected readonly pending = pendingSetupSteps();
  protected readonly retryAt = computed(() => {
    const outcome = this.outcome();
    return outcome?.kind === 'unavailable' && outcome.reason === 'rate' ? outcome.retryAt : null;
  });
  protected readonly refusedSteps = computed(() => {
    const outcome = this.outcome();
    return outcome?.kind === 'refused' ? outcome.steps : [];
  });
  protected readonly unavailableReason = computed(() => {
    const outcome = this.outcome();
    return outcome?.kind === 'unavailable' ? outcome.reason : null;
  });
  protected readonly duplicateSlug = computed(() => {
    const outcome = this.outcome();
    return outcome?.kind === 'duplicate' ? outcome.slug : null;
  });

  constructor() {
    void this.connection.ready();
    void this.deployment.ensureLoaded();
    // The field is the only thing on the page: focus starts there and its label and hint are read (UX spec §5).
    afterNextRender(() => this.input().nativeElement.focus());
  }

  protected setupRoute(slug: string | null): readonly string[] | null {
    return slug === null ? null : projectSetupRouteOf(slug);
  }

  protected onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
    // A new value makes the previous check stale: its inline error or result block must not linger (#124 item 3).
    this.fieldError.set('');
    this.outcome.set(null);
  }

  protected onConnectRefused(): void {
    this.connectRefused.set(true);
  }

  protected async submit(event?: Event): Promise<void> {
    event?.preventDefault();
    if (this.isBlocked()) {
      return;
    }
    const input = normalizeRepoInput(this.value());
    if (!input.ok) {
      this.fieldError.set(
        input.reason === 'empty'
          ? this.transloco.translate('settings.add.invalid.empty')
          : this.transloco.translate('settings.add.invalid.format', { value: this.value().trim() }),
      );
      this.input().nativeElement.focus();
      return;
    }
    this.fieldError.set('');
    this.value.set(input.repo);
    this.checked.set({ repo: input.repo, slug: input.slug });
    this.busy.set(true);
    this.outcome.set({ kind: 'checking' });
    void this.announcer.announce(
      this.transloco.translate('settings.add.checkingLive', { repo: input.repo }),
      'polite',
    );

    let result: AddResult;
    try {
      result = await this.adder.add(input.repo, input.slug);
    } finally {
      this.busy.set(false);
    }
    if (result.kind === 'refused') {
      this.showRefusal(result.outcome, input.repo);
      return;
    }
    await this.router.navigate(projectSetupRouteOf(result.slug), { state: { [JUST_ADDED_STATE]: true } });
  }

  private showRefusal(outcome: AddRefusal, repo: string): void {
    if (outcome.kind === 'invalid') {
      this.outcome.set(null);
      this.fieldError.set(this.transloco.translate('settings.add.invalid.format', { value: repo }));
      this.input().nativeElement.focus();
      return;
    }
    this.outcome.set(outcome);
    afterNextRender(() => this.result()?.nativeElement.focus(), { injector: this.injector });
  }
}
