import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A set of radio options under one legend (#221: how long to snooze), drawn as one bordered list with the chosen
 * row tinted. The options are `label[tc-choice]` rows holding a native radio, so the keyboard and screen readers
 * get the browser's own radio group.
 *
 * ```html
 * <fieldset tc-choice-group [legend]="t('snooze.when')">
 *   <label tc-choice><input type="radio" name="when" value="hour" checked /> For an hour</label>
 *   <label tc-choice><input type="radio" name="when" value="week" /> For a week</label>
 * </fieldset>
 * ```
 */
@Component({
  selector: 'fieldset[tc-choice-group]',
  template: `
    <legend class="tc-choice-group__legend">{{ legend() }}</legend>
    <div class="tc-choice-group__options"><ng-content /></div>
  `,
  styleUrl: './choice-group.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-choice-group' },
})
export class ChoiceGroup {
  readonly legend = input.required<string>();
}

/**
 * One option: a native radio or checkbox, its words, and an optional quieter line (`[tc-choice-hint]`, give it an
 * id and point the input's `aria-describedby` at it). Standalone it is a checkbox row; inside a `tc-choice-group` a
 * row of the list. The whole row is the tap target (at least the touch control height).
 */
@Component({
  selector: 'label[tc-choice]',
  template: `
    <ng-content select="input" />
    <span class="tc-choice__text">
      <ng-content />
      <ng-content select="[tc-choice-hint]" />
    </span>
  `,
  styleUrl: './choice.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-choice' },
})
export class Choice {}
