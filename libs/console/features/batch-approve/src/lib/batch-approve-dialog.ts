import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AnsweredItems, NeedsYouCounts } from '@console/entities/project';
import { plainAskOf, type BatchLeftOut, type QuestionItem } from '@console/entities/question';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Banner, Button, CheckRow, Chip, DIALOG_DATA, DialogRef, Icon, List } from '@console/shared/ui';
import { BATCH_ANSWER_MAX } from '@shared/contracts';
import {
  BatchApproveClient,
  batchFailureKindOf,
  itemSlugOf,
  type BatchFailureKind,
} from './batch-approve.client';

/**
 * What one opening of the dialog recorded, read by the opener once it closes — a Cancel after a partial batch
 * included, so the items GitHub did take still leave Needs you.
 */
export class BatchSession {
  readonly approved = signal<readonly QuestionItem[]>([]);
  /** Items the server refused because they changed meanwhile: the list is read again. */
  readonly changed = signal<readonly QuestionItem[]>([]);
}

export interface BatchApproveData {
  readonly candidates: readonly QuestionItem[];
  readonly leftOut: readonly BatchLeftOut[];
  readonly session: BatchSession;
}

function keyOf(item: QuestionItem): string {
  return `${item.project.slug}#${item.number}`;
}

/** Ticked items per project, in list order, in requests of at most `BATCH_ANSWER_MAX`. */
function requestsOf(items: readonly QuestionItem[]): { slug: string; items: QuestionItem[] }[] {
  const requests: { slug: string; items: QuestionItem[] }[] = [];
  for (const item of items) {
    const open = requests.find(
      (request) => request.slug === item.project.slug && request.items.length < BATCH_ANSWER_MAX,
    );
    if (open === undefined) {
      requests.push({ slug: item.project.slug, items: [item] });
    } else {
      open.items.push(item);
    }
  }
  return requests;
}

/**
 * "Approve team recommendations" (#220, design #29): the safe questions ticked, what was left out and why, one
 * confirmation. Each project is one request; the owner's words are fixed at the first press, so Try again sends the
 * same body and the Worker replays whatever it already wrote. Failed items stay ticked with Try again; items that
 * changed meanwhile leave the batch to be answered one by one.
 */
@Component({
  selector: 'tc-batch-approve-dialog',
  imports: [Banner, Button, CheckRow, Chip, Icon, List, TranslocoPipe],
  templateUrl: './batch-approve-dialog.html',
  styleUrl: './batch-approve-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BatchApproveDialog {
  protected readonly data = inject<BatchApproveData>(DIALOG_DATA);
  private readonly ref = inject<DialogRef<void>>(DialogRef);
  private readonly client = inject(BatchApproveClient);
  private readonly transloco = inject(TranslocoService);
  private readonly answeredItems = inject(AnsweredItems);
  private readonly counts = inject(NeedsYouCounts);

  protected readonly items = signal<readonly QuestionItem[]>(this.data.candidates);
  private readonly checked = signal<ReadonlySet<string>>(new Set(this.data.candidates.map(keyOf)));
  protected readonly running = signal(false);
  protected readonly failure = signal<string | null>(null);
  /** After a partial batch only the failed items are shown, without the intro and the left-out list. */
  protected readonly isRetrying = signal(false);
  private ownerSaid: string | null = null;

  protected readonly showProject = new Set(this.data.candidates.map((item) => item.project.slug)).size > 1;
  protected readonly checkedCount = computed(
    () => this.items().filter((item) => this.checked().has(keyOf(item))).length,
  );
  protected readonly said = computed(
    () => this.ownerSaid ?? this.transloco.translate('commands.batch.ownerSaid', { n: this.checkedCount() }),
  );

  protected isChecked(item: QuestionItem): boolean {
    return this.checked().has(keyOf(item));
  }

  protected toggle(item: QuestionItem, isOn: boolean): void {
    const next = new Set(this.checked());
    if (isOn) {
      next.add(keyOf(item));
    } else {
      next.delete(keyOf(item));
    }
    this.checked.set(next);
  }

  protected recOf(item: QuestionItem): string {
    const plain = plainAskOf(item.ask);
    if (plain === null) {
      return '';
    }
    return plain.kind === 'text' ? plain.text : this.transloco.translate(`answer.command.${plain.command}`);
  }

  protected reasonOf(left: BatchLeftOut): string {
    return this.transloco.translate(`commands.batch.why.${left.reason}`);
  }

  protected keyOf(item: QuestionItem): string {
    return keyOf(item);
  }

  protected cancel(): void {
    if (!this.running()) {
      this.ref.close();
    }
  }

  protected async confirm(): Promise<void> {
    const chosen = this.items().filter((item) => this.checked().has(keyOf(item)));
    if (this.running() || chosen.length === 0) {
      return;
    }
    const ownerSaid: string =
      this.ownerSaid ?? this.transloco.translate<string>('commands.batch.ownerSaid', { n: chosen.length });
    this.ownerSaid = ownerSaid;
    this.running.set(true);
    this.failure.set(null);
    this.ref.disableClose = true;
    const failed: QuestionItem[] = [];
    const changed: QuestionItem[] = [];
    let worst: BatchFailureKind | null = null;
    try {
      for (const request of requestsOf(chosen)) {
        const answer = await this.client.submit(request.slug, {
          numbers: request.items.map((item) => item.number),
          ownerSaid,
        });
        if (!answer.ok) {
          failed.push(...request.items);
          worst ??= answer.failure;
          continue;
        }
        answer.results.forEach((result, index) => {
          const item = request.items[index];
          if (item === undefined) {
            return;
          }
          if (result.ok) {
            this.record(item, result.url);
            return;
          }
          const kind = batchFailureKindOf(itemSlugOf(result));
          if (kind === 'changed') {
            changed.push(item);
          } else {
            failed.push(item);
            worst ??= kind;
          }
        });
      }
    } finally {
      this.running.set(false);
      this.ref.disableClose = false;
    }
    if (changed.length > 0) {
      this.data.session.changed.update((items) => [...items, ...changed]);
    }
    if (failed.length === 0 && changed.length === 0) {
      void this.counts.refresh();
      this.ref.close();
      return;
    }
    void this.counts.refresh();
    this.showFailed(failed, changed, worst);
  }

  private record(item: QuestionItem, url: string): void {
    this.answeredItems.record({
      slug: item.project.slug,
      number: item.number,
      command: 'approve',
      url,
      answeredAt: new Date().toISOString(),
      batch: true,
    });
    this.data.session.approved.update((items) => [...items, item]);
  }

  private showFailed(
    failed: readonly QuestionItem[],
    changed: readonly QuestionItem[],
    worst: BatchFailureKind | null,
  ): void {
    const t = (key: string, params?: Record<string, unknown>): string =>
      this.transloco.translate(key, params);
    const ids = (items: readonly QuestionItem[]): string => items.map((item) => `#${item.number}`).join(', ');
    const messages: string[] = [];
    if (failed.length > 0) {
      const approved = this.data.session.approved().length;
      messages.push(
        approved > 0 && (worst === 'github' || worst === null)
          ? t('commands.batch.partial', { ok: approved, n: approved + failed.length, ids: ids(failed) })
          : t(`commands.batch.error.${worst ?? 'github'}`),
      );
    }
    if (changed.length > 0) {
      messages.push(t('commands.batch.error.changed', { ids: ids(changed) }));
    }
    this.items.set(failed);
    this.checked.set(new Set(failed.map(keyOf)));
    this.isRetrying.set(true);
    this.failure.set(messages.join(' '));
  }
}
