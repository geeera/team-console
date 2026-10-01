import { BreakpointObserver } from '@angular/cdk/layout';
import { ChangeDetectionStrategy, Component, inject, input, numberAttribute } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { BREAKPOINTS } from '../../tokens/breakpoints';

let nextLaneId = 0;

export type LaneHeadingLevel = 2 | 3 | 4;

/**
 * Lanes of a board: stacked on wider screens, a row of swipeable lanes (each most of the width, snapping) on the
 * phone. Give it an accessible name (`aria-label`). On the phone the row scrolls sideways, so it takes keyboard
 * focus there and arrow keys scroll it.
 *
 * ```html
 * <tc-lanes aria-label="Issues by status">
 *   <tc-lane heading="In progress" [count]="2"><tc-list>…</tc-list></tc-lane>
 * </tc-lanes>
 * ```
 */
@Component({
  selector: 'tc-lanes',
  template: '<ng-content />',
  styleUrl: './lanes.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-lanes',
    role: 'group',
    '[attr.tabindex]': 'scrolls() ? 0 : null',
  },
})
export class Lanes {
  private readonly breakpoints = inject(BreakpointObserver);

  protected readonly scrolls = toSignal(
    this.breakpoints.observe(BREAKPOINTS.phone).pipe(map((result) => result.matches)),
    { initialValue: this.breakpoints.isMatched(BREAKPOINTS.phone) },
  );
}

/**
 * One titled group of a board: a heading with the item count, then the caller's content (usually a `tc-list`, or
 * a compact empty `tc-state-block`). The heading level fits the page outline (3 by default).
 */
@Component({
  selector: 'tc-lane',
  template: `
    <div class="tc-lane__head" role="heading" [attr.aria-level]="level()" [id]="headingId">
      <!-- &ngsp; keeps one space so the heading reads "In progress 2", not "In progress2". -->
      <span class="tc-lane__title">{{ heading() }}</span>&ngsp;<span class="tc-lane__count">{{ count() }}</span>
    </div>
    <ng-content />
  `,
  styleUrl: './lane.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-lane', role: 'group', '[attr.aria-labelledby]': 'headingId' },
})
export class Lane {
  readonly heading = input.required<string>();
  readonly count = input.required({ transform: numberAttribute });
  readonly level = input<LaneHeadingLevel>(3);

  protected readonly headingId = `tc-lane-heading-${nextLaneId++}`;
}
