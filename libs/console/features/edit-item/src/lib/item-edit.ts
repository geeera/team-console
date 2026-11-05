import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  OnInit,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  ItemsApi,
  newIdempotencyKey,
  TrackerFailureBlock,
  type TrackerFailure,
} from '@console/entities/item';
import { LocalTimePipe, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { PersistedStateStore } from '@console/shared/persisted-state';
import { Button, Field, FieldControl, Sheet } from '@console/shared/ui';
import { ITEM_BODY_MAX_LENGTH, ITEM_TITLE_MAX_LENGTH, type ItemDto } from '@shared/contracts';

/** The counter appears from this share of the cap (#107's rule). */
const COUNTER_FROM = 0.8;

function lengthOf(text: string): number {
  return [...text].length;
}

/** One save as sent: a retry repeats exactly this, key included, so it is never applied twice. */
interface PendingSave {
  readonly title: string;
  readonly body: string;
  readonly version: number;
  readonly key: string;
}

/**
 * Edit a task's title and details together (#409 §2.1): Save (⌘↩ / Ctrl+↩) or Cancel, which asks first when
 * something changed. What is typed is kept on the device per task (`PersistedStateStore.setTaskDraft`), so an Access
 * re-login or an iOS eviction never loses it, and a restored draft says when it was typed. The save is a `PATCH`
 * with `If-Match` on the version the edit started from: a newer version is a conflict that keeps the owner's text in
 * the fields, offers their version to read and "Save mine over it" (a new write on their version).
 */
@Component({
  selector: 'tc-item-edit',
  imports: [Button, Field, FieldControl, LocalTimePipe, TrackerFailureBlock, TranslocoPipe],
  templateUrl: './item-edit.html',
  styleUrl: './item-edit.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-item-edit' },
})
export class ItemEdit implements OnInit {
  private readonly api = inject(ItemsApi);
  private readonly drafts = inject(PersistedStateStore);
  private readonly sheet = inject(Sheet);
  private readonly transloco = inject(TranslocoService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');
  private readonly bodyInput = viewChild<ElementRef<HTMLTextAreaElement>>('bodyInput');

  readonly slug = input.required<string>();
  readonly item = input.required<ItemDto>();
  /** Why the owner cannot save now ("You're offline"); `null` when they can. */
  readonly off = input<string | null>(null);
  /** The item as saved: the screen shows it and moves focus to its title. */
  readonly saved = output<ItemDto>();
  /** Closed without saving (Cancel, Discard): the screen moves focus back to Edit. */
  readonly closed = output<void>();

  protected readonly titleMax = ITEM_TITLE_MAX_LENGTH;
  protected readonly bodyMax = ITEM_BODY_MAX_LENGTH;
  protected readonly title = signal('');
  protected readonly body = signal('');
  /** When the restored draft was typed; `null` without one. */
  protected readonly draftAt = signal<string | null>(null);
  protected readonly isSaving = signal(false);
  protected readonly failure = signal<TrackerFailure | null>(null);
  /** The newer version a save ran into, shown read-only under the fields on request. */
  protected readonly theirs = signal<ItemDto | null>(null);
  protected readonly isTheirsShown = signal(false);
  protected readonly fieldError = signal<'title' | 'body' | null>(null);
  private baseVersion = 0;
  private pending: PendingSave | null = null;

  protected readonly titleLength = computed(() => lengthOf(this.title()));
  protected readonly bodyLength = computed(() => lengthOf(this.body()));
  protected readonly titleError = computed(() => {
    const t = (key: string, params?: Record<string, unknown>): string =>
      this.transloco.translate(key, params);
    if (this.titleLength() > this.titleMax) {
      return t('item.tooLong', { max: this.titleMax, n: this.titleLength() - this.titleMax });
    }
    return this.fieldError() === 'title'
      ? t(this.title().trim() === '' ? 'item.titleEmpty' : 'item.err.invalid.message')
      : '';
  });
  protected readonly bodyError = computed(() => {
    if (this.bodyLength() > this.bodyMax) {
      return this.transloco.translate('item.tooLong', {
        max: this.bodyMax,
        n: this.bodyLength() - this.bodyMax,
      });
    }
    return this.fieldError() === 'body' ? this.transloco.translate('item.err.invalid.message') : '';
  });
  protected readonly showTitleCounter = computed(() => this.titleLength() >= this.titleMax * COUNTER_FROM);
  protected readonly showBodyCounter = computed(() => this.bodyLength() >= this.bodyMax * COUNTER_FROM);

  ngOnInit(): void {
    const item = this.item();
    const draft = this.drafts.taskDraftOf(this.slug(), item.number)?.edit;
    if (draft !== undefined && (draft.title !== item.title || draft.body !== item.body)) {
      this.title.set(draft.title);
      this.body.set(draft.body);
      this.baseVersion = draft.baseVersion;
      this.draftAt.set(this.drafts.taskDraftOf(this.slug(), item.number)?.savedAt ?? null);
    } else {
      this.title.set(item.title);
      this.body.set(item.body);
      this.baseVersion = item.version;
    }
    afterNextRender(() => this.titleInput()?.nativeElement.focus(), { injector: this.injector });
  }

  protected setTitle(value: string): void {
    this.title.set(value);
    this.keepDraft();
  }

  protected setBody(value: string): void {
    this.body.set(value);
    this.keepDraft();
  }

  protected dropDraft(): void {
    const item = this.item();
    this.drafts.setTaskDraft(this.slug(), item.number, { edit: null });
    this.title.set(item.title);
    this.body.set(item.body);
    this.baseVersion = item.version;
    this.draftAt.set(null);
    this.titleInput()?.nativeElement.focus();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void this.save();
    }
  }

  async save(): Promise<void> {
    if (this.isSaving() || this.off() !== null) {
      return;
    }
    const title = this.title().trim();
    if (title === '' || this.titleLength() > this.titleMax) {
      this.fieldError.set('title');
      this.titleInput()?.nativeElement.focus();
      return;
    }
    if (this.bodyLength() > this.bodyMax) {
      this.fieldError.set('body');
      this.bodyInput()?.nativeElement.focus();
      return;
    }
    await this.send({ title, body: this.body(), version: this.baseVersion, key: newIdempotencyKey() });
  }

  /** "Save mine over it": the owner's text again, on the version they have now seen. */
  protected async saveMine(): Promise<void> {
    const theirs = this.theirs();
    if (theirs === null) {
      return;
    }
    this.baseVersion = theirs.version;
    this.keepDraft();
    await this.send({
      title: this.title().trim(),
      body: this.body(),
      version: theirs.version,
      key: newIdempotencyKey(),
    });
  }

  protected async retry(): Promise<void> {
    if (this.pending !== null) {
      await this.send(this.pending);
    }
  }

  protected toggleTheirs(): void {
    this.isTheirsShown.update((shown) => !shown);
  }

  async cancel(): Promise<void> {
    const item = this.item();
    const changed = this.title() !== item.title || this.body() !== item.body;
    if (!changed) {
      this.drafts.setTaskDraft(this.slug(), item.number, { edit: null });
      this.closed.emit();
      return;
    }
    const t = (key: string): string => this.transloco.translate(key);
    const isDiscarded = await this.sheet.confirm({
      title: t('item.discard.title'),
      message: t('item.discard.message'),
      confirmLabel: t('item.discard.ok'),
      cancelLabel: t('item.discard.keep'),
      tone: 'danger',
    });
    if (!isDiscarded) {
      this.titleInput()?.nativeElement.focus();
      return;
    }
    this.drafts.setTaskDraft(this.slug(), item.number, { edit: null });
    this.closed.emit();
  }

  private keepDraft(): void {
    this.fieldError.set(null);
    this.drafts.setTaskDraft(this.slug(), this.item().number, {
      edit: { title: this.title(), body: this.body(), baseVersion: this.baseVersion },
    });
  }

  private async send(save: PendingSave): Promise<void> {
    this.pending = save;
    this.isSaving.set(true);
    this.failure.set(null);
    const result = await this.api.update(
      this.slug(),
      this.item().number,
      save.version,
      { title: save.title, body: save.body },
      save.key,
    );
    this.isSaving.set(false);
    if (result.ok) {
      this.pending = null;
      this.theirs.set(null);
      this.drafts.setTaskDraft(this.slug(), this.item().number, { edit: null });
      this.saved.emit(result.value);
      return;
    }
    const failure = result.failure;
    if (failure.kind === 'conflict') {
      await this.showConflict();
      return;
    }
    if (failure.kind === 'invalid' && (failure.field === 'title' || failure.field === 'body')) {
      this.fieldError.set(failure.field);
      (failure.field === 'title' ? this.titleInput() : this.bodyInput())?.nativeElement.focus();
      return;
    }
    this.failure.set(failure);
  }

  /** Reads the version the save ran into; the owner's text stays in the fields. */
  private async showConflict(): Promise<void> {
    const read = await this.api.item(this.slug(), this.item().number);
    if (!read.ok) {
      this.failure.set({ kind: 'conflict', field: null, retryAfter: null });
      return;
    }
    this.theirs.set(read.value);
    this.isTheirsShown.set(false);
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLElement>('[data-testid="conflict-mine"]')?.focus(),
      { injector: this.injector },
    );
  }
}
