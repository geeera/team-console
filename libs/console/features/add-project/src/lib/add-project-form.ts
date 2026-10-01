import { LiveAnnouncer } from '@angular/cdk/a11y';
import { HttpClient } from '@angular/common/http';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DeploymentStore } from '@console/entities/app-info';
import { ConnectGitHubButton, GitHubConnectionStore } from '@console/entities/github-connection';
import {
  isProjectDtoList,
  normalizeRepoInput,
  pendingSetupSteps,
  PROJECTS_URL,
  ProjectsStore,
  SetupChecklist,
  type SetupChecklistContext,
} from '@console/entities/project';
import { httpProblemOf, NetworkStatus } from '@console/shared/api';
import { LocalTimePipe, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Callout, Field, FieldControl, Icon } from '@console/shared/ui';
import type { ProjectDto } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';
import { addOutcomeOf, type AddOutcome } from './add-outcome';

/** History state the setup page reads to say "Project added" instead of "N steps missing". */
export const JUST_ADDED_STATE = 'tcJustAdded';

function isProjectDto(value: unknown): value is ProjectDto {
  return isProjectDtoList([value]);
}

/**
 * New project (#24): one `owner/repo` field, checked on submit only. Steps 1–3 run on the Worker before anything
 * is saved; a refusal shows the checklist with "Nothing was saved" and Check again re-submits the same value. Not
 * connected → it says to connect first and sends nothing.
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
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly transloco = inject(TranslocoService);
  private readonly injector = inject(Injector);
  private readonly projects = inject(ProjectsStore);
  private readonly deployment = inject(DeploymentStore);

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

    let created: unknown;
    try {
      created = await firstValueFrom(this.http.post<unknown>(PROJECTS_URL, { repo: input.repo }));
    } catch (error: unknown) {
      await this.showRefusal(addOutcomeOf(httpProblemOf(error)), input.repo, input.slug);
      return;
    } finally {
      this.busy.set(false);
    }
    if (isProjectDto(created)) {
      this.projects.upsert(created);
    } else {
      // A 201 whose body we cannot read: the project is saved, so the Worker's list is the truth.
      await this.projects.load();
    }
    const slug = isProjectDto(created) ? created.slug : input.slug;
    await this.router.navigate(['/settings/projects', slug], { state: { [JUST_ADDED_STATE]: true } });
  }

  private async showRefusal(outcome: AddOutcome, repo: string, slug: string): Promise<void> {
    if (outcome.kind === 'invalid') {
      this.outcome.set(null);
      this.fieldError.set(this.transloco.translate('settings.add.invalid.format', { value: repo }));
      this.input().nativeElement.focus();
      return;
    }
    if (outcome.kind === 'not-connected') {
      this.connection.noteNotConnected();
    }
    this.outcome.set(outcome.kind === 'exists' ? await this.registeredOutcome(repo, slug) : outcome);
    afterNextRender(() => this.result()?.nativeElement.focus(), { injector: this.injector });
  }

  /** 409 `project-exists`: the Worker's list says whether it is on the list (link to its setup) or archived. */
  private async registeredOutcome(repo: string, slug: string): Promise<AddOutcome> {
    try {
      const project = await this.projects.findRegistered(repo, slug);
      if (project === null) {
        // Gone between the 409 and this read: nothing to link to; the owner can simply check again.
        return { kind: 'unavailable', reason: 'github' };
      }
      return project.archivedAt === null ? { kind: 'duplicate', slug: project.slug } : { kind: 'archived' };
    } catch (error: unknown) {
      return addOutcomeOf(httpProblemOf(error));
    }
  }
}
