import { LiveAnnouncer } from '@angular/cdk/a11y';
import {
  afterNextRender,
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
} from '@angular/core';
import {
  currentSprintOf,
  githubNumberOf,
  githubSourceUrlOf,
  historyOf,
  isClosedAsNotNeeded,
  ItemsApi,
  queuePositionOf,
  TrackerFailureBlock,
  type FailedWrite,
  type HistoryEntry,
} from '@console/entities/item';
import { SprintTierIcon } from '@console/entities/sprint';
import { ItemComment } from '@console/features/comment-item';
import { ItemEdit, ItemFieldPicker, ItemReopen } from '@console/features/edit-item';
import { NetworkStatus } from '@console/shared/api';
import { LocalDayPipe, LocalTimePipe, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Chip, Icon, IconButton, Ledger, LedgerRow } from '@console/shared/ui';
import type { AskDto, ItemDto, ItemSummaryDto, TrackerSprintDto } from '@shared/contracts';
import { decisionItemOf, TaskDecision } from './task-decision';
import { TaskHistory } from './task-history';
import { TaskNames } from './task-names';
import { TaskState, type TaskLoadState } from './task-state';

export type TaskScreenPresentation = 'pane' | 'page';

type LoadState = TaskLoadState | 'ready';

/**
 * The task screen (#409 §2.1, §3, §5): `/p/:slug/t/:n`, a pane beside the board on a Mac and a page on the iPhone.
 * Title (h1, focused on open) with Edit; the field ledger with Status ▾ and Kind ▾ (pick saves), sprint, queue,
 * tier, labels, author and the old GitHub link; Details; History (events and comments, oldest first, newest last)
 * and the comment box. Offline after load it keeps what it showed with a stale note, and every write control says
 * why it is off. A failed write is a block at the top with Try again (same idempotency key).
 */
@Component({
  selector: 'tc-task-screen',
  imports: [
    Button,
    Chip,
    Icon,
    IconButton,
    ItemComment,
    ItemEdit,
    ItemFieldPicker,
    ItemReopen,
    Ledger,
    LedgerRow,
    LocalDayPipe,
    LocalTimePipe,
    SprintTierIcon,
    TaskDecision,
    TaskHistory,
    TaskState,
    TrackerFailureBlock,
    TranslocoPipe,
  ],
  templateUrl: './task-screen.html',
  styleUrl: './task-screen.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-task-screen',
    '[class.tc-task-screen--pane]': 'presentation() === "pane"',
    '[attr.aria-label]': 'presentation() === "pane" ? paneLabel() : null',
    '[attr.role]': 'presentation() === "pane" ? "region" : null',
    'data-testid': 'task-screen',
  },
})
export class TaskScreen {
  private readonly api = inject(ItemsApi);
  private readonly network = inject(NetworkStatus);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly slug = input.required<string>();
  readonly number = input.required<number>();
  readonly projectName = input.required<string>();
  readonly presentation = input<TaskScreenPresentation>('page');
  /** Back (the page) or Close (the pane). */
  readonly closed = output<void>();

  protected readonly state = signal<LoadState>('loading');
  protected readonly item = signal<ItemDto | null>(null);
  protected readonly history = signal<readonly HistoryEntry[]>([]);
  protected readonly sprints = signal<readonly TrackerSprintDto[]>([]);
  protected readonly asks = signal<readonly AskDto[]>([]);
  protected readonly peers = signal<readonly ItemSummaryDto[]>([]);
  protected readonly loadedAt = signal<string | null>(null);
  protected readonly isEditing = signal(false);
  protected readonly failedWrite = signal<FailedWrite | null>(null);

  protected readonly names = new TaskNames(this.transloco, () => this.sprints());
  protected readonly loadState = computed<TaskLoadState | null>(() => {
    const state = this.state();
    return state === 'ready' ? null : state;
  });
  protected readonly key = computed(() => this.item()?.key ?? `#${String(this.number())}`);
  protected readonly paneLabel = computed(() =>
    this.transloco.translate('item.paneLabel', { key: this.key() }),
  );
  /** Why a write control is off right now; the stale note carries the same reason under `tc-task-off`. */
  protected readonly off = computed(() =>
    this.network.online() ? null : this.transloco.translate('item.offlineReason'),
  );
  /** A decision waits on the task: the comment box then points at Approve / Reject. */
  protected readonly isDecisionWaiting = computed(() => {
    const item = this.item();
    return (
      item !== null &&
      decisionItemOf({ slug: this.slug(), name: this.projectName() }, item, this.asks()) !== null
    );
  });
  protected readonly isClosed = computed(() => {
    const item = this.item();
    return item !== null && isClosedAsNotNeeded(item);
  });
  protected readonly currentSprint = computed(() => currentSprintOf(this.sprints()));
  protected readonly sprintLabel = computed(() => {
    const item = this.item();
    if (item === null || item.sprint === null) {
      return this.transloco.translate('item.noSprint');
    }
    const sprint = this.sprints().find((entry) => entry.number === item.sprint);
    const title = sprint?.title ?? `Sprint ${String(item.sprint).padStart(2, '0')}`;
    return this.currentSprint()?.number === item.sprint
      ? this.transloco.translate('item.sprintCurrent', { sprint: title })
      : title;
  });
  protected readonly queue = computed(() => {
    const item = this.item();
    return item === null ? null : queuePositionOf(item, this.peers());
  });
  protected readonly githubUrl = computed(() => {
    const item = this.item();
    return item === null ? null : githubSourceUrlOf(item);
  });
  protected readonly githubNumber = computed(() => {
    const item = this.item();
    return item === null ? null : githubNumberOf(item);
  });

  constructor() {
    effect(() => {
      const slug = this.slug();
      const number = this.number();
      untracked(() => void this.load(slug, number, true));
    });
  }

  /** Reads the task and everything around it; `focus` moves focus to the h1 once it shows (open, Refresh). */
  async load(slug = this.slug(), number = this.number(), focus = false): Promise<void> {
    this.state.set('loading');
    this.failedWrite.set(null);
    this.isEditing.set(false);
    if (!Number.isSafeInteger(number) || number < 1) {
      this.item.set(null);
      this.state.set('not-found');
      return;
    }
    const [read, sprints] = await Promise.all([this.api.item(slug, number), this.api.sprints(slug)]);
    if (slug !== this.slug() || number !== this.number()) {
      return;
    }
    if (!read.ok) {
      this.item.set(null);
      this.state.set(read.reason === 'session-expired' ? 'error' : read.reason);
      if (focus) {
        this.focusAfterRender('[data-focus="task-title"]');
      }
      return;
    }
    this.item.set(read.value);
    this.sprints.set(sprints.ok ? sprints.value : []);
    this.loadedAt.set(new Date().toISOString());
    this.state.set('ready');
    if (focus) {
      this.focusAfterRender('[data-focus="task-title"]');
    }
    await Promise.all([this.loadHistory(), this.loadPeers()]);
  }

  private async loadHistory(): Promise<void> {
    const slug = this.slug();
    const number = this.number();
    const [events, comments, decisions, asks] = await Promise.all([
      this.api.events(slug, number),
      this.api.comments(slug, number),
      this.api.decisions(slug, number),
      this.api.asks(slug, number),
    ]);
    this.asks.set(asks.ok ? asks.value : []);
    if (events.ok && comments.ok) {
      this.history.set(historyOf(events.value, comments.value, decisions.ok ? decisions.value : []));
    }
  }

  private async loadPeers(): Promise<void> {
    const item = this.item();
    if (item === null || item.state === 'closed') {
      this.peers.set([]);
      return;
    }
    const read = await this.api.items(this.slug(), {
      state: 'open',
      status: item.status,
      sprint: item.sprint === null ? 'none' : String(item.sprint),
    });
    this.peers.set(read.ok ? read.value : []);
  }

  protected startEdit(): void {
    if (this.off() !== null) {
      return;
    }
    this.failedWrite.set(null);
    this.isEditing.set(true);
  }

  protected onSaved(item: ItemDto): void {
    this.isEditing.set(false);
    this.applyChange(item);
    this.focusAfterRender('[data-focus="task-title"]');
    void this.announcer.announce(this.transloco.translate('item.saved'), 'polite');
  }

  protected onEditClosed(): void {
    this.isEditing.set(false);
    this.focusAfterRender('[data-testid="item-edit"]');
  }

  /** A write landed: show the item as the server answered and read History again for its new line. */
  protected applyChange(item: ItemDto): void {
    const before = this.item();
    this.failedWrite.set(null);
    this.item.set(item);
    void this.loadHistory();
    if (
      before === null ||
      before.status !== item.status ||
      before.sprint !== item.sprint ||
      before.state !== item.state
    ) {
      void this.loadPeers();
    }
  }

  /** A decision was recorded: read the task again in place, so the receipt keeps focus. */
  protected async onDecided(): Promise<void> {
    const read = await this.api.item(this.slug(), this.number());
    if (read.ok) {
      this.applyChange(read.value);
    }
  }

  protected onCommented(): void {
    this.failedWrite.set(null);
    void this.loadHistory();
  }

  protected onFailed(failed: FailedWrite): void {
    this.failedWrite.set(failed);
  }

  protected async retryWrite(): Promise<void> {
    const failed = this.failedWrite();
    if (failed !== null) {
      this.failedWrite.set(null);
      await failed.retry();
    }
  }

  protected close(): void {
    this.closed.emit();
  }

  private focusAfterRender(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }
}
