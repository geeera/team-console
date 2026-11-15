import { LiveAnnouncer } from '@angular/cdk/a11y';
import { BreakpointObserver } from '@angular/cdk/layout';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  calendarTodayOf,
  freezeDaysOrDefault,
  isRetryable,
  ItemsApi,
  newIdempotencyKey,
  textCapOf,
  type TrackerFailure,
} from '@console/entities/item';
import { quickTaskSprintOptionsOf, type QuickTaskSprintOption } from '@console/entities/sprint';
import { localCalendarDayOf, LocalTimePipe, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { PersistedStateStore } from '@console/shared/persisted-state';
import {
  BREAKPOINTS,
  Button,
  Card,
  Chip,
  Choice,
  ChoiceGroup,
  DIALOG_DATA,
  DialogRef,
  Field,
  FieldControl,
  Icon,
  Segment,
  SegmentedRadio,
  Sheet,
  SheetFooter,
} from '@console/shared/ui';
import {
  ITEM_BODY_MAX_LENGTH,
  ITEM_TITLE_MAX_LENGTH,
  type ItemDto,
  type ProjectDto,
  type SprintTarget,
} from '@shared/contracts';
import {
  BACKLOG_ONLY,
  chosenTargetOf,
  hasCommandLine,
  isQuickTaskKind,
  QUICK_TASK_KINDS,
  sprintOf,
  withRefusedSprints,
  type QuickTaskKind,
} from './quick-task.model';

export interface QuickTaskData {
  /** The active projects on the console tracker, in the registry's order. */
  readonly projects: readonly ProjectDto[];
  /** The project the form opens on: the draft's, else the one the owner is in, else the first. */
  readonly slug: string;
  /** The sheet's subtitle («в team-console»): the form keeps it in step with the project picker. */
  readonly into: WritableSignal<string>;
}

type SprintRead = 'loading' | 'error' | 'ready';

let nextFormId = 0;

/**
 * New task (#107): project, title, details, kind, sprint — one `POST …/items` as the owner with the sprint set
 * directly (`proposed`, the API default). Everything typed is the device's one draft (`quickTaskDraft`), written at
 * once and kept through a project switch, a close and an iOS eviction, with one `Idempotency-Key` for the draft's
 * life, so a double tap or a retry after a drop creates one item. A refusal keeps the text and says why; a frozen
 * sprint offers Next or Backlog in one tap; a sprint that closed meanwhile reloads the list. Created: the item as a
 * stamped card with a link to its task screen.
 */
@Component({
  selector: 'tc-quick-task-sheet',
  imports: [
    Button,
    Card,
    Chip,
    Choice,
    ChoiceGroup,
    Field,
    FieldControl,
    Icon,
    LocalTimePipe,
    RouterLink,
    Segment,
    SegmentedRadio,
    SheetFooter,
    TranslocoPipe,
  ],
  templateUrl: './quick-task-sheet.html',
  styleUrl: './quick-task-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-quick-task', '(keydown)': 'onKeydown($event)' },
})
export class QuickTaskSheet {
  protected readonly data = inject<QuickTaskData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<ItemDto>>(DialogRef);
  private readonly api = inject(ItemsApi);
  private readonly drafts = inject(PersistedStateStore);
  private readonly sheet = inject(Sheet);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** The frame chose its presentation the same way when it opened (`Sheet.open`). */
  protected readonly isPhone = inject(BreakpointObserver).isMatched(BREAKPOINTS.phone);
  protected readonly formId = `tc-quick-task-${nextFormId++}`;
  protected readonly kinds = QUICK_TASK_KINDS;
  protected readonly targets: readonly SprintTarget[] = ['current', 'next', 'backlog'];

  protected readonly slug = signal(this.data.slug);
  protected readonly title = signal('');
  protected readonly body = signal('');
  protected readonly kind = signal<QuickTaskKind>('feature');
  /** What the owner picked; `null` until then, so the default (Next, else Backlog) applies. */
  private readonly wantedTarget = signal<SprintTarget | null>(null);
  /** When the restored draft was last typed; `null` for a fresh form. */
  protected readonly draftAt = signal<string | null>(null);
  private key = newIdempotencyKey();

  protected readonly sprintRead = signal<SprintRead>('loading');
  private readonly readOptions = signal(BACKLOG_ONLY);
  /** Sprints the server refused as frozen (409): never offered again in this form. */
  private readonly refusedFrozen = signal<ReadonlySet<number>>(new Set());

  protected readonly running = signal(false);
  protected readonly failure = signal<TrackerFailure | null>(null);
  /** The sprint a 409 `sprint-frozen` named, for its copy. */
  protected readonly frozenTitle = signal('');
  protected readonly showErrors = signal(false);
  protected readonly created = signal<ItemDto | null>(null);
  /** The sprint the created item landed in, by name; `null` for the backlog. */
  protected readonly createdSprint = signal<string | null>(null);

  protected readonly project = computed(() => this.data.projects.find((p) => p.slug === this.slug()) ?? null);
  protected readonly projectName = computed(() => this.project()?.displayName ?? this.slug());
  protected readonly options = computed(() => withRefusedSprints(this.readOptions(), this.refusedFrozen()));
  protected readonly target = computed(() => chosenTargetOf(this.options(), this.wantedTarget()));

  protected readonly titleCap = computed(() => textCapOf(this.title(), ITEM_TITLE_MAX_LENGTH));
  protected readonly bodyCap = computed(() => textCapOf(this.body(), ITEM_BODY_MAX_LENGTH));
  protected readonly titleError = computed((): string => {
    const cap = this.titleCap();
    if (cap.overBy > 0) {
      return this.t('item.tooLong', { max: cap.max, n: cap.overBy });
    }
    return this.showErrors() && this.title().trim() === '' ? this.t('item.titleEmpty') : '';
  });
  protected readonly bodyError = computed((): string => {
    const cap = this.bodyCap();
    return cap.overBy > 0 ? this.t('item.tooLong', { max: cap.max, n: cap.overBy }) : '';
  });
  protected readonly hasCommand = computed(() => hasCommandLine(this.title()) || hasCommandLine(this.body()));
  protected readonly isDraftForOther = computed(
    () => this.draftAt() !== null && this.data.slug !== this.slug() && this.created() === null,
  );

  constructor() {
    const draft = this.drafts.quickTaskDraft();
    if (draft !== undefined && this.data.projects.some((p) => p.slug === draft.slug)) {
      this.slug.set(draft.slug);
      this.title.set(draft.title);
      this.body.set(draft.body);
      this.kind.set(isQuickTaskKind(draft.kind) ? draft.kind : 'feature');
      this.wantedTarget.set(draft.sprintTarget);
      this.key = draft.idempotencyKey;
      this.draftAt.set(draft.savedAt);
    }
    effect(() => {
      const name = this.projectName();
      untracked(() => this.data.into.set(this.t('quickTask.into', { name })));
    });
    effect(() => {
      const slug = this.slug();
      untracked(() => void this.loadSprints(slug));
    });
  }

  protected setProject(slug: string): void {
    this.slug.set(slug);
    this.refusedFrozen.set(new Set());
    this.keepDraft();
  }

  protected setTitle(value: string): void {
    this.title.set(value);
    this.keepDraft();
  }

  protected setBody(value: string): void {
    this.body.set(value);
    this.keepDraft();
  }

  protected setKind(kind: QuickTaskKind): void {
    this.kind.set(kind);
    this.keepDraft();
  }

  protected setTarget(target: SprintTarget): void {
    this.wantedTarget.set(target);
    this.keepDraft();
  }

  protected optionOf(target: SprintTarget): QuickTaskSprintOption {
    return this.options()[target];
  }

  /** The quieter line under a sprint option: its name and demo day, or why it cannot be chosen. */
  protected hintOf(option: QuickTaskSprintOption): string {
    if (option.target === 'backlog') {
      return this.t('quickTask.sprint.backlogHint');
    }
    const sprint = option.sprint;
    if (sprint === null) {
      if (this.sprintRead() !== 'ready') {
        return this.t(
          this.sprintRead() === 'loading' ? 'quickTask.sprint.loading' : 'quickTask.sprint.error',
        );
      }
      return this.t(option.target === 'current' ? 'quickTask.sprint.noCurrent' : 'quickTask.sprint.noNext');
    }
    const date =
      sprint.dueOn === null ? null : localCalendarDayOf(sprint.dueOn, this.transloco.getActiveLang());
    if (option.disabledReason === 'frozen') {
      return date === null
        ? this.t('quickTask.sprint.frozenNoDate', { sprint: sprint.title })
        : this.t('quickTask.sprint.frozen', { sprint: sprint.title, date });
    }
    return date === null
      ? this.t('quickTask.sprint.noDate', { sprint: sprint.title })
      : this.t('quickTask.sprint.hint', { sprint: sprint.title, date });
  }

  protected async clearDraft(): Promise<void> {
    const confirmed = await this.sheet.confirm({
      title: this.t('quickTask.clear.title'),
      message: this.t('quickTask.clear.message'),
      confirmLabel: this.t('quickTask.clear.ok'),
      cancelLabel: this.t('quickTask.clear.cancel'),
      tone: 'danger',
    });
    if (!confirmed) {
      return;
    }
    this.reset();
    this.focus('[data-testid="quick-task-title"]');
  }

  /** ⌘↩ / Ctrl+↩ sends from anywhere in the form. */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && this.created() === null) {
      event.preventDefault();
      void this.send();
    }
  }

  protected submit(event: Event): void {
    event.preventDefault();
    void this.send();
  }

  /** One tap after a frozen sprint: the other target, sent at once with the draft's key. */
  protected async sendTo(target: SprintTarget): Promise<void> {
    this.setTarget(target);
    await this.send();
  }

  protected async send(): Promise<void> {
    if (this.running()) {
      return;
    }
    this.showErrors.set(true);
    if (this.titleError() !== '' || this.bodyError() !== '') {
      this.focus('[aria-invalid="true"]');
      return;
    }
    const slug = this.slug();
    const target = this.target();
    const sprint = sprintOf(this.options(), target);
    this.running.set(true);
    this.failure.set(null);
    // aria-disabled, not disabled: the focused button keeps focus while the write runs.
    this.ref.disableClose = true;
    const result = await this.api.createItem(
      slug,
      { title: this.title().trim(), body: this.body(), kind: this.kind(), sprint: sprint?.number ?? null },
      this.key,
    );
    this.running.set(false);
    this.ref.disableClose = false;
    if (result.ok) {
      this.drafts.clearQuickTaskDraft();
      this.createdSprint.set(sprint?.title ?? null);
      this.created.set(result.value);
      void this.announcer.announce(
        this.t('quickTask.done.announce', { key: result.value.key, name: this.projectName() }),
        'polite',
      );
      this.focus('[data-testid="quick-task-done"]');
      return;
    }
    const failure = result.failure;
    if (failure.kind === 'frozen' && sprint !== null) {
      this.frozenTitle.set(sprint.title);
      this.refusedFrozen.update((before) => new Set(before).add(sprint.number));
    }
    if (failure.kind === 'invalid' && failure.field === 'sprint') {
      // The sprint closed or disappeared since the form read it: read the list again, the text stays.
      void this.loadSprints(slug);
    }
    this.failure.set(failure);
    this.focus('[data-testid="quick-task-failure"]');
  }

  /**
   * The only place a new key is minted for a draft that already tried to send: the owner has seen that the first send
   * may have landed and chose to file this text anyway. Editing alone never re-keys (it could duplicate).
   */
  protected async sendAsNew(): Promise<void> {
    if (this.running()) {
      return;
    }
    this.key = newIdempotencyKey();
    this.keepDraft();
    await this.send();
  }

  /** «Ещё задача»: the same project and kind, a fresh draft with its own key. */
  protected another(): void {
    this.created.set(null);
    this.showErrors.set(false);
    this.reset();
    this.focus('[data-testid="quick-task-title"]');
  }

  protected isRetry(): boolean {
    const failure = this.failure();
    return failure !== null && isRetryable(failure);
  }

  protected failureCopy(failure: TrackerFailure): { readonly title: string; readonly message: string } {
    const name = this.projectName();
    switch (failure.kind) {
      case 'frozen':
        return {
          title: this.t('quickTask.err.frozen.title', { sprint: this.frozenTitle() }),
          message: this.t('quickTask.err.frozen.message'),
        };
      case 'invalid':
        return failure.field === 'sprint'
          ? {
              title: this.t('quickTask.err.sprintGone.title'),
              message: this.t('quickTask.err.sprintGone.message'),
            }
          : {
              title: this.t('quickTask.err.invalid.title'),
              message: this.t('quickTask.err.invalid.message', {
                field: this.t(`quickTask.field.${this.fieldOf(failure.field)}`),
              }),
            };
      case 'key-reused':
        return {
          title: this.t('quickTask.err.keyReused.title'),
          message: this.t('quickTask.err.keyReused.message'),
        };
      case 'not-found':
        return {
          title: this.t('quickTask.err.notFound.title', { name }),
          message: this.t('quickTask.err.notFound.message'),
        };
      case 'forbidden':
        return {
          title: this.t('quickTask.err.forbidden.title'),
          message: this.t('quickTask.err.forbidden.message'),
        };
      case 'timeout':
        return {
          title: this.t('quickTask.err.timeout.title'),
          message: this.t('quickTask.err.timeout.message'),
        };
      default:
        return {
          title: this.t('quickTask.err.network.title'),
          message: this.t('quickTask.err.network.message'),
        };
    }
  }

  private fieldOf(field: string | null): 'title' | 'body' | 'kind' | 'sprint' | 'other' {
    return field === 'title' || field === 'body' || field === 'kind' || field === 'sprint' ? field : 'other';
  }

  private reset(): void {
    this.title.set('');
    this.body.set('');
    this.draftAt.set(null);
    this.failure.set(null);
    this.showErrors.set(false);
    this.key = newIdempotencyKey();
    this.drafts.clearQuickTaskDraft();
  }

  private async loadSprints(slug: string): Promise<void> {
    this.sprintRead.set('loading');
    this.readOptions.set(BACKLOG_ONLY);
    const [read, freeze] = await Promise.all([this.api.sprints(slug), this.api.freezeDays(slug)]);
    if (this.slug() !== slug) {
      return;
    }
    if (!read.ok) {
      this.sprintRead.set('error');
      return;
    }
    this.readOptions.set(
      quickTaskSprintOptionsOf(read.value, calendarTodayOf(new Date()), freezeDaysOrDefault(freeze)),
    );
    this.sprintRead.set('ready');
  }

  /** Written at once (iOS may evict a backgrounded PWA); a form with no words left is no draft. */
  private keepDraft(): void {
    if (this.title().trim() === '' && this.body().trim() === '') {
      this.drafts.clearQuickTaskDraft();
      return;
    }
    this.drafts.setQuickTaskDraft({
      slug: this.slug(),
      title: this.title(),
      body: this.body(),
      kind: this.kind(),
      sprintTarget: this.wantedTarget() ?? this.target(),
      idempotencyKey: this.key,
      savedAt: new Date().toISOString(),
    });
  }

  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }
}
