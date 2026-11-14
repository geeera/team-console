import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A few mutually exclusive values side by side (#107: Feature / Bug / Chore), drawn as inked segments over a native
 * radio group: the browser keeps the semantics — one Tab stop, arrow keys move the choice, the legend names the
 * group. An optional `[tc-segmented-hint]` line under the segments says what the chosen value means; point each
 * input's `aria-describedby` at it.
 *
 * ```html
 * <fieldset tc-segmented [legend]="t('task.kind')">
 *   <label tc-segment><input type="radio" name="kind" value="feature" checked /> Feature</label>
 *   <label tc-segment><input type="radio" name="kind" value="bug" /> Bug</label>
 *   <p tc-segmented-hint id="kind-hint">Something new, or a change to what is there.</p>
 * </fieldset>
 * ```
 */
@Component({
  selector: 'fieldset[tc-segmented]',
  template: `
    <legend class="tc-segmented__legend">{{ legend() }}</legend>
    <div class="tc-segmented__options"><ng-content select="[tc-segment]" /></div>
    <ng-content select="[tc-segmented-hint]" />
  `,
  styleUrl: './segmented.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-segmented' },
})
export class SegmentedRadio {
  readonly legend = input.required<string>();
}

/** One segment: a native radio, visually hidden but focusable, and its words; the whole segment is the tap target. */
@Component({
  selector: 'label[tc-segment]',
  template: `<ng-content select="input" /><span class="tc-segment__text"><ng-content /></span>`,
  styleUrl: './segment.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-segment' },
})
export class Segment {}
