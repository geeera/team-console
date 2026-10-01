import { NgTemplateOutlet } from '@angular/common';
import { booleanAttribute, ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A vertical list of rows on one paper surface. Give it an accessible name
 * (`aria-label` or `aria-labelledby`) when the screen has more than one list.
 */
@Component({
  selector: 'tc-list',
  template: '<ng-content />',
  styleUrl: './list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-list',
    role: 'list',
    '[class.tc-list--plain]': 'plain()',
  },
})
export class List {
  /** No surface or border: rows sit directly on the page, as in the sidebar. */
  readonly plain = input(false, { transform: booleanAttribute });
}

/**
 * One row: leading slot, title, subtitle, trailing slot. With `href` the whole row is a link,
 * with `button` it is a button; otherwise it is static. The interactive element is inside the
 * list item so the list keeps its semantics and the row keeps the browser's.
 *
 * A control in the `tc-row-action` slot (pin, archive…) renders **beside** the surface, not
 * inside it, so an interactive row never nests another control; give it its own `aria-label`.
 *
 * ```html
 * <tc-list-row button [current]="isActive" (click)="open()">
 *   <tc-icon tc-row-leading name="inbox" />
 *   <span tc-row-title>Needs you</span>
 *   <span tc-row-subtitle>3 questions</span>
 *   <tc-chip tc-row-trailing tone="accent">3</tc-chip>
 * </tc-list-row>
 * ```
 */
@Component({
  selector: 'tc-list-row',
  imports: [NgTemplateOutlet],
  templateUrl: './list-row.html',
  styleUrl: './list-row.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-list-row',
    role: 'listitem',
    '[class.tc-list-row--interactive]': 'isInteractive()',
    '[class.tc-list-row--current]': 'current()',
  },
})
export class ListRow {
  readonly href = input<string>('');
  readonly button = input(false, { transform: booleanAttribute });
  /** Marks the row the user is on (`aria-current="true"`), e.g. the open project. */
  readonly current = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });
  /**
   * With `href`: the link opens in a new tab without an opener (GitHub pages). Say so in the row's text for
   * screen readers; the kit does not add copy of its own.
   */
  readonly external = input(false, { transform: booleanAttribute });

  protected isInteractive(): boolean {
    return this.button() || this.href() !== '';
  }
}
