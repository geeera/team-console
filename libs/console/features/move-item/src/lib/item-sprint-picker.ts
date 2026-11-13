import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { FailedWrite } from '@console/entities/item';
import { TranslocoService } from '@console/shared/i18n';
import { PickerButton } from '@console/shared/ui';
import type { ItemDto } from '@shared/contracts';
import { ItemMover } from './item-mover';

/**
 * Sprint ▾ on the task screen (#409 §2.2): the Move menu of `ItemMover` — First / Up / Down in the lane (#456), every
 * open sprint and the backlog, a move that applies at once, Undo on the toast. A move keeps the status. Focus stays
 * on Sprint ▾ (the task does not leave this screen).
 */
@Component({
  selector: 'tc-item-sprint-picker',
  imports: [PickerButton],
  template: `
    <button
      #button
      tc-picker
      type="button"
      data-testid="pick-sprint"
      [field]="label()"
      [value]="value()"
      [expanded]="isOpen()"
      [off]="isOff()"
      [attr.aria-describedby]="off() !== null ? 'tc-task-off' : null"
      (click)="open()"
    >
      <i aria-hidden="true"></i>
    </button>
  `,
  styles: ':host { display: contents; }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ItemSprintPicker {
  private readonly mover = inject(ItemMover);
  private readonly transloco = inject(TranslocoService);
  private readonly button = viewChild.required('button', { read: ElementRef<HTMLButtonElement> });
  private isDestroyed = false;

  readonly slug = input.required<string>();
  readonly item = input.required<ItemDto>();
  /** The sprint as the screen shows it ("Sprint 03 — current", "Backlog"). */
  readonly value = input.required<string>();
  readonly off = input<string | null>(null);
  readonly changed = output<ItemDto>();
  readonly failed = output<FailedWrite>();

  /** The menu is open or its move is on its way: a second press waits. */
  protected readonly isOpen = signal(false);
  protected readonly isOff = computed(() => this.off() !== null);
  protected readonly label = computed(() => this.transloco.translate('item.sprint'));

  constructor() {
    // Undo can run from the toast after the screen is gone; there is nobody to tell then.
    inject(DestroyRef).onDestroy(() => {
      this.isDestroyed = true;
    });
  }

  async open(): Promise<void> {
    if (this.isOpen() || this.isOff()) {
      return;
    }
    this.isOpen.set(true);
    try {
      await this.mover.open(this.button().nativeElement, this.slug(), this.item(), {
        moved: ({ item }) => this.onChanged(item),
        reordered: (item) => this.onChanged(item),
        failed: (failed) => {
          if (!this.isDestroyed) {
            this.failed.emit(failed);
          }
        },
      });
    } finally {
      this.isOpen.set(false);
    }
  }

  /** The task stays on this screen after a move or a reorder: the ledger follows, focus comes back here. */
  private onChanged(item: ItemDto): void {
    if (!this.isDestroyed) {
      this.changed.emit(item);
      this.button().nativeElement.focus();
    }
  }
}
