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
import { ActionsSetupStatuses, missingStepsOf, notReadyMessageOf } from '@console/entities/actions-setup';
import { projectActionsRouteOf, ProjectsStore } from '@console/entities/project';
import { RunnersApi, runnerFailureKeyOf, type RunnerFailure } from '@console/entities/runner';
import { RouterLink } from '@angular/router';
import { TranslocoPipe, TranslocoPluralPipe, TranslocoService } from '@console/shared/i18n';
import {
  Banner,
  Button,
  Choice,
  ChoiceGroup,
  focusAfterRender,
  Icon,
  injectRetryFocus,
  StateBlock,
} from '@console/shared/ui';
import { ACTIONS_NOT_READY, type ProjectDispatch, type ProjectDispatchDto } from '@shared/contracts';

type EditorStatus = 'loading' | 'ready' | 'error';

let nextEditorId = 0;

/**
 * Where one project's jobs run (#670): on the account's runners (`pull`) or on GitHub Actions in the project's own
 * repository, the console starting a workflow run per job. Read with `GET …/dispatch`, saved with `PUT`; the Worker
 * refuses Actions for a subscription project or a pinned/failover placement, and reads the default branch from
 * GitHub itself. States plainly that the Actions minutes are the customer's own spend. Owner-only, as its page.
 *
 * #759: choosing «На GitHub Actions» shows a readiness line (one check through the `actions-setup` entity, never for
 * `pull`) with «Подготовить репозиторий». The radio never navigates (WCAG 3.2.2); Save is `aria-disabled` while the
 * repository is known not to be ready, and activating it then moves focus to that link. The server's 422
 * `actions-not-ready` names the items that hold it back.
 */
@Component({
  selector: 'tc-project-dispatch-editor',
  imports: [
    Banner,
    Button,
    Choice,
    ChoiceGroup,
    Icon,
    RouterLink,
    StateBlock,
    TranslocoPipe,
    TranslocoPluralPipe,
  ],
  templateUrl: './project-dispatch-editor.html',
  styleUrl: './project-dispatch-editor.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectDispatchEditor {
  private readonly api = inject(RunnersApi);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly restoreRetryFocus = injectRetryFocus();
  private readonly injector = inject(Injector);
  private readonly actionsStatuses = inject(ActionsSetupStatuses);
  private readonly projects = inject(ProjectsStore);
  private readonly prepareLink = viewChild<ElementRef<HTMLElement>>('prepareLink');

  readonly slug = input.required<string>();
  /** Settings › Team of this project (#688): linked from an `access-source-hosted` refusal; none hides the link. */
  readonly teamUrl = input<string | null>(null);
  /** The dispatch as the Worker stored it after a save. */
  readonly saved = output<ProjectDispatchDto>();

  protected readonly id = `tc-project-dispatch-${nextEditorId++}`;
  protected readonly status = signal<EditorStatus>('loading');
  protected readonly loadFailure = signal<RunnerFailure | null>(null);
  protected readonly stored = signal<ProjectDispatchDto | null>(null);
  protected readonly choice = signal<ProjectDispatch>('pull');
  protected readonly saving = signal(false);
  protected readonly saveFailure = signal<string | null>(null);
  /** The last save was refused for the project's access source (`access-source-hosted`): Team is where it changes. */
  protected readonly isAccessSourceRefusal = signal(false);
  protected readonly isSaved = signal(false);
  /** The last save was refused with `actions-not-ready`: the refusal links the setup page. */
  protected readonly isNotReadyRefusal = signal(false);

  protected readonly actionsRoute = computed(() => projectActionsRouteOf(this.slug()));
  /** The readiness of the project's repository, asked only once «На GitHub Actions» is the choice. */
  private readonly readiness = computed(() =>
    this.choice() === 'actions' ? this.actionsStatuses.of(this.slug()) : null,
  );
  protected readonly readinessLine = computed(() => {
    const readiness = this.readiness();
    if (readiness === null) {
      return null;
    }
    const snapshot = readiness.snapshot();
    if (snapshot !== null && readiness.state() !== 'loading') {
      return snapshot.ready
        ? ({ kind: 'ok' } as const)
        : ({ kind: 'missing', n: Math.max(1, missingStepsOf(snapshot).length) } as const);
    }
    return readiness.state() === 'error' ? ({ kind: 'failed' } as const) : ({ kind: 'checking' } as const);
  });
  /** Known not ready: Save would only be refused. A failed check leaves Save to the server. */
  protected readonly isSaveBlocked = computed(() => this.readinessLine()?.kind === 'missing');

  protected readonly loadFailureText = computed(() => {
    const failure = this.loadFailure();
    return failure === null ? '' : this.t(runnerFailureKeyOf(failure));
  });

  constructor() {
    effect(() => {
      const slug = this.slug();
      untracked(() => void this.load(slug));
    });
    effect(() => {
      const readiness = this.readiness();
      if (readiness !== null) {
        untracked(() => void readiness.ensureLoaded());
      }
    });
  }

  protected async retry(): Promise<void> {
    await this.load(this.slug());
    this.restoreRetryFocus();
  }

  protected choose(dispatch: ProjectDispatch): void {
    this.choice.set(dispatch);
    this.isSaved.set(false);
    this.saveFailure.set(null);
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) {
      return;
    }
    if (this.choice() === 'actions' && this.isSaveBlocked()) {
      focusAfterRender(() => this.prepareLink(), { injector: this.injector });
      return;
    }
    const slug = this.slug();
    this.saving.set(true);
    this.saveFailure.set(null);
    this.isAccessSourceRefusal.set(false);
    this.isNotReadyRefusal.set(false);
    this.isSaved.set(false);
    const result = await this.api.setDispatch(slug, this.choice());
    this.saving.set(false);
    if (this.slug() !== slug) {
      return;
    }
    if (!result.ok) {
      const isNotReady = result.failure.slug === ACTIONS_NOT_READY;
      this.saveFailure.set(
        isNotReady
          ? notReadyMessageOf(result.failure.items ?? [], this.projectName(), (key, params) =>
              this.t(key, params),
            )
          : this.t(runnerFailureKeyOf(result.failure)),
      );
      this.isAccessSourceRefusal.set(result.failure.slug === 'access-source-hosted');
      this.isNotReadyRefusal.set(isNotReady);
      if (isNotReady) {
        // The check this screen holds is stale: the server just judged otherwise.
        void this.actionsStatuses.of(slug).load();
      }
      return;
    }
    this.apply(result.value);
    this.isSaved.set(true);
    this.saved.emit(result.value);
    void this.announcer.announce(this.t('runners.dispatch.saved'), 'polite');
  }

  private async load(slug: string): Promise<void> {
    this.status.set('loading');
    this.isSaved.set(false);
    this.saveFailure.set(null);
    const result = await this.api.dispatch(slug);
    if (this.slug() !== slug) {
      // Another project was picked while this one loaded; its own load answers for it.
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

  private projectName(): string {
    return this.projects.bySlug(this.slug())?.displayName ?? this.slug();
  }

  private apply(dto: ProjectDispatchDto): void {
    this.stored.set(dto);
    this.choice.set(dto.dispatch);
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }
}
