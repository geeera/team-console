import { NgTemplateOutlet } from '@angular/common';
import { booleanAttribute, ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

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
 * One row: leading slot, title, subtitle, an unclamped detail line, trailing slot and trailing text. With `link`
 * (router commands) or `href` the whole row is a link, with `button` it is a button; otherwise it is static. The
 * interactive element is inside the list item so the list keeps its semantics and the row keeps the browser's.
 *
 * A control in the `tc-row-action` slot (pin, archive…) renders **beside** the surface, not
 * inside it, so an interactive row never nests another control; give it its own `aria-label`.
 *
 * `tc-row-trailing-text` is a word at the end of the row instead of a control ("Project ›", "Archived", #194):
 * accent ink, or secondary ink on a `muted` row — still AA, never greyed below 4.5:1.
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
  imports: [NgTemplateOutlet, RouterLink],
  templateUrl: './list-row.html',
  styleUrl: './list-row.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-list-row',
    role: 'listitem',
    '[class.tc-list-row--interactive]': 'isInteractive()',
    '[class.tc-list-row--current]': 'current()',
    '[class.tc-list-row--muted]': 'muted()',
  },
})
export class ListRow {
  /** Router commands for an in-app link row: navigates without a reload, unlike `href`. */
  readonly link = input<string | readonly unknown[] | null>(null);
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
  /** Secondary ink for a row the user cannot act on (an archived project); its text stays AA. */
  readonly muted = input(false, { transform: booleanAttribute });
  /** Already translated: the accessible name of a link or button row when its visible text says less. */
  readonly label = input('');

  protected isInteractive(): boolean {
    return this.button() || this.href() !== '' || this.link() !== null;
  }
}
