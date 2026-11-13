import { LiveAnnouncer } from '@angular/cdk/a11y';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { NetworkStatus } from '@console/shared/api';
import { ItemMover, type MovableItem } from '@console/features/move-item';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Icon, IconButton } from '@console/shared/ui';
import { BoardMoves } from './board-moves';

let nextId = 0;

/**
 * ⋯ on a board row (#558, #409 §8): its own tab stop after the row's link, opening the Move menu. Offline it stays
 * focusable but `aria-disabled`, and says why instead of opening.
 */
@Component({
  selector: 'tc-board-move-button',
  imports: [Icon, IconButton, TranslocoPipe],
  template: `
    <button
      tc-icon-button
      type="button"
      class="board-move"
      data-testid="move-item"
      aria-haspopup="menu"
      [attr.data-move]="item().number"
      [attr.aria-expanded]="isOpen()"
      [attr.aria-label]="'plan.moveAria' | transloco: { key: item().key, title: item().title }"
      [attr.aria-disabled]="isOffline() ? 'true' : null"
      [attr.aria-describedby]="isOffline() ? offlineId : null"
      (click)="open($event)"
    >
      <tc-icon name="more" />
    </button>
    @if (isOffline()) {
      <span class="tc-sr-only" [id]="offlineId">{{ 'item.offlineReason' | transloco }}</span>
    }
  `,
  styles: `
    :host {
      display: contents;
    }

    /* #558: 44 px on every screen, not only the phone. */
    .board-move {
      width: var(--control-h-touch);
      height: var(--control-h-touch);
    }

    .board-move[aria-disabled='true'] {
      cursor: default;
      opacity: var(--disabled-opacity);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardMoveButton {
  private readonly mover = inject(ItemMover);
  private readonly moves = inject(BoardMoves);
  private readonly network = inject(NetworkStatus);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);

  readonly slug = input.required<string>();
  readonly item = input.required<MovableItem>();

  protected readonly offlineId = `tc-board-move-offline-${String(nextId++)}`;
  protected readonly isOpen = signal(false);
  protected readonly isOffline = computed(() => !this.network.online());

  protected async open(event: MouseEvent): Promise<void> {
    if (this.isOffline()) {
      void this.announcer.announce(this.transloco.translate('item.offlineReason'), 'polite');
      return;
    }
    if (this.isOpen() || !(event.currentTarget instanceof HTMLElement)) {
      return;
    }
    this.isOpen.set(true);
    try {
      await this.mover.open(event.currentTarget, this.slug(), this.item(), this.moves.handlers);
    } finally {
      this.isOpen.set(false);
    }
  }
}
