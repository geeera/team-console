import { booleanAttribute, ChangeDetectionStrategy, Component, input, model } from '@angular/core';

/**
 * A row of a `tc-list` the user ticks or unticks: a native checkbox and its label as one 44 px tap target, so the
 * browser keeps the semantics (Space toggles, the label names the box). The title and an optional quieter line are
 * projected and must stay text.
 *
 * ```html
 * <tc-list aria-label="Questions to approve">
 *   <tc-check-row [(checked)]="isPicked">
 *     <span tc-check-title>#72 Plan for the demo</span>
 *     <span tc-check-detail>Team recommends: start as planned</span>
 *   </tc-check-row>
 * </tc-list>
 * ```
 */
@Component({
  selector: 'tc-check-row',
  template: `
    <label class="tc-check-row__label">
      <input
        type="checkbox"
        class="tc-check-row__box"
        [checked]="checked()"
        [disabled]="disabled()"
        (change)="checked.set($any($event.target).checked)"
      />
      <span class="tc-check-row__text">
        <span class="tc-check-row__title"><ng-content select="[tc-check-title]" /></span>
        <span class="tc-check-row__detail"><ng-content select="[tc-check-detail]" /></span>
      </span>
    </label>
  `,
  styleUrl: './check-row.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-check-row', role: 'listitem' },
})
export class CheckRow {
  readonly checked = model(false);
  readonly disabled = input(false, { transform: booleanAttribute });
}
