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
import { RunnersApi, runnerFailureKeyOf, type RunnerFailure } from '@console/entities/runner';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Banner, Button, Choice, ChoiceGroup, Icon, StateBlock } from '@console/shared/ui';
import type { ProjectDispatch, ProjectDispatchDto } from '@shared/contracts';

type EditorStatus = 'loading' | 'ready' | 'error';

let nextEditorId = 0;

/**
 * Where one project's jobs run (#670): on the account's runners (`pull`) or on GitHub Actions in the project's own
 * repository, the console starting a workflow run per job. Read with `GET …/dispatch`, saved with `PUT`; the Worker
 * refuses Actions for a subscription project or a pinned/failover placement, and reads the default branch from
 * GitHub itself. States plainly that the Actions minutes are the customer's own spend. Owner-only, as its page.
 */
@Component({
  selector: 'tc-project-dispatch-editor',
  imports: [Banner, Button, Choice, ChoiceGroup, Icon, StateBlock, TranslocoPipe],
  templateUrl: './project-dispatch-editor.html',
  styleUrl: './project-dispatch-editor.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectDispatchEditor {
  private readonly api = inject(RunnersApi);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);

  readonly slug = input.required<string>();
  /** The dispatch as the Worker stored it after a save. */
  readonly saved = output<ProjectDispatchDto>();

  protected readonly id = `tc-project-dispatch-${nextEditorId++}`;
  protected readonly status = signal<EditorStatus>('loading');
  protected readonly loadFailure = signal<RunnerFailure | null>(null);
  protected readonly stored = signal<ProjectDispatchDto | null>(null);
  protected readonly choice = signal<ProjectDispatch>('pull');
  protected readonly saving = signal(false);
  protected readonly saveFailure = signal<string | null>(null);
  protected readonly isSaved = signal(false);

  protected readonly loadFailureText = computed(() => {
    const failure = this.loadFailure();
    return failure === null ? '' : this.t(runnerFailureKeyOf(failure));
  });

  constructor() {
    effect(() => {
      const slug = this.slug();
      untracked(() => void this.load(slug));
    });
  }

  protected retry(): void {
    void this.load(this.slug());
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
    const slug = this.slug();
    this.saving.set(true);
    this.saveFailure.set(null);
    this.isSaved.set(false);
    const result = await this.api.setDispatch(slug, this.choice());
    this.saving.set(false);
    if (this.slug() !== slug) {
      return;
    }
    if (!result.ok) {
      this.saveFailure.set(this.t(runnerFailureKeyOf(result.failure)));
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

  private apply(dto: ProjectDispatchDto): void {
    this.stored.set(dto);
    this.choice.set(dto.dispatch);
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }
}
