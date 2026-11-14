import {
  afterRenderEffect,
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
} from '@angular/core';

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
 *
 * `off` (#107) is unavailable with a reason: the input stays focusable and in the radio group's arrow order, carries
 * `aria-disabled="true"`, and a click or an arrow key never checks it — so the reason in the hint is still read,
 * which a `disabled` input would hide. Its words stay at `--text-2`, readable (AA), not faded.
 *
 * ```html
 * <label tc-choice off>
 *   <input type="radio" name="sprint" value="current" aria-describedby="current-why" />
 *   In the current sprint
 *   <small tc-choice-hint id="current-why">Frozen until the demo on 16 October.</small>
 * </label>
 * ```
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
  host: { class: 'tc-choice', '[class.tc-choice--off]': 'off()', '(click)': 'onClick($event)' },
})
export class Choice {
  readonly off = input(false, { transform: booleanAttribute });

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    afterRenderEffect(() => {
      const control = this.host.nativeElement.querySelector('input');
      if (this.off()) {
        control?.setAttribute('aria-disabled', 'true');
      } else {
        control?.removeAttribute('aria-disabled');
      }
    });
  }

  /** A click on the row and an arrow key in the group both arrive as a click; cancelling it keeps the old choice. */
  protected onClick(event: Event): void {
    if (this.off()) {
      event.preventDefault();
    }
  }
}
