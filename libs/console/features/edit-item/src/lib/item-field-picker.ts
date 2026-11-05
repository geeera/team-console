import { LiveAnnouncer } from '@angular/cdk/a11y';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  ItemsApi,
  newIdempotencyKey,
  shownStatusOf,
  type FailedWrite,
  type ShownStatus,
} from '@console/entities/item';
import { TranslocoService } from '@console/shared/i18n';
import { Menu, PickerButton, type MenuItem } from '@console/shared/ui';
import { ITEM_KINDS, ITEM_STATUSES, type ItemDto, type UpdateItemInput } from '@shared/contracts';

export type ItemPickerField = 'status' | 'kind';

const STATUS_OPTIONS: readonly ShownStatus[] = [...ITEM_STATUSES, 'closed'];

/** The change a picked status makes: `closed` is "not needed" (closed as not planned), leaving it reopens. */
export function statusChangeOf(item: ItemDto, to: ShownStatus): UpdateItemInput | null {
  const from = shownStatusOf(item);
  if (from === to) {
    return null;
  }
  if (to === 'closed') {
    return { state: 'closed', closedReason: 'not-planned' };
  }
  return from === 'closed' ? { state: 'open', status: to } : { status: to };
}

/**
 * Status ▾ or Kind ▾ on the task screen (#409 §2.1, §5): a `PickerButton` that opens a `Menu` of the values with
 * their hints, the current one checked; a pick saves at once (`PATCH` with `If-Match` and its own idempotency key),
 * focus is back on the button and "Status changed: QA" is announced. Escape closes without a change. A failure goes
 * to the screen with a retry of exactly that write.
 */
@Component({
  selector: 'tc-item-field-picker',
  imports: [PickerButton],
  template: `
    <button
      #button
      tc-picker
      type="button"
      [attr.data-testid]="'pick-' + field()"
      [field]="label()"
      [value]="valueLabel()"
      [expanded]="isOpen()"
      [off]="isOff()"
      [changed]="isChanged()"
      [attr.aria-describedby]="off() !== null ? offId() : null"
      (click)="open()"
    >
      @if (field() === 'status') {
        <i class="tc-item-field-picker__dot" [attr.data-status]="current()" aria-hidden="true"></i>
      }
    </button>
  `,
  styleUrl: './item-field-picker.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-item-field-picker' },
})
export class ItemFieldPicker {
  private readonly api = inject(ItemsApi);
  private readonly menu = inject(Menu);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly button = viewChild.required('button', { read: ElementRef<HTMLButtonElement> });

  readonly slug = input.required<string>();
  readonly item = input.required<ItemDto>();
  readonly field = input.required<ItemPickerField>();
  /** Why it cannot be used now; shown by the screen under the id `offId`. */
  readonly off = input<string | null>(null);
  readonly offId = input('tc-task-off');
  readonly changed = output<ItemDto>();
  readonly failed = output<FailedWrite>();

  protected readonly isOpen = signal(false);
  protected readonly isSaving = signal(false);
  protected readonly isChanged = signal(false);
  protected readonly isOff = computed(() => this.off() !== null || this.isSaving());
  protected readonly current = computed<string>(() =>
    this.field() === 'status' ? shownStatusOf(this.item()) : this.item().kind,
  );
  protected readonly label = computed(() => this.transloco.translate(`item.${this.field()}`));
  protected readonly valueLabel = computed(() => this.nameOf(this.current()));

  private nameOf(value: string): string {
    return this.transloco.translate(
      this.field() === 'status' ? `board.status.${value}` : `board.kind.${value}`,
    );
  }

  async open(): Promise<void> {
    if (this.isOpen() || this.isOff()) {
      return;
    }
    const t = (key: string, params?: Record<string, unknown>): string =>
      this.transloco.translate(key, params);
    const item = this.item();
    const isStatus = this.field() === 'status';
    const values: readonly string[] = isStatus ? STATUS_OPTIONS : ITEM_KINDS;
    const items: MenuItem[] = values.map((value) => ({
      id: value,
      label: this.nameOf(value),
      hint: t(isStatus ? `item.statusHint.${value}` : `item.kindHint.${value}`),
      checked: value === this.current(),
    }));
    this.isOpen.set(true);
    const picked = await this.menu.open(this.button().nativeElement, {
      label: t(isStatus ? 'item.pickerStatus' : 'item.pickerKind', { key: item.key }),
      title: t(isStatus ? 'item.pickerStatus' : 'item.pickerKind', { key: item.key }),
      radio: true,
      groups: [{ items }],
    });
    this.isOpen.set(false);
    if (picked === null || picked === this.current()) {
      return;
    }
    const change = isStatus
      ? statusChangeOf(item, picked as ShownStatus)
      : { kind: picked as ItemDto['kind'] };
    if (change !== null) {
      await this.write(change, item.version, newIdempotencyKey(), picked);
    }
  }

  private async write(change: UpdateItemInput, version: number, key: string, picked: string): Promise<void> {
    this.isSaving.set(true);
    const result = await this.api.update(this.slug(), this.item().number, version, change, key);
    this.isSaving.set(false);
    if (!result.ok) {
      this.failed.emit({ failure: result.failure, retry: () => this.write(change, version, key, picked) });
      return;
    }
    this.changed.emit(result.value);
    this.isChanged.set(false);
    queueMicrotask(() => this.isChanged.set(true));
    this.button().nativeElement.focus();
    void this.announcer.announce(
      this.transloco.translate('item.changed', { field: this.label(), to: this.nameOf(picked) }),
      'polite',
    );
  }
}
