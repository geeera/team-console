import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  forwardRef,
  input,
  signal,
} from '@angular/core';
import { NG_VALUE_ACCESSOR, type ControlValueAccessor } from '@angular/forms';
import { Icon } from '../icon/icon';

/**
 * An on/off control drawn as a sliding pill (#688 UX spec): a native `button` carrying `role="switch"`, so Space
 * and Enter toggle it for free — no keydown handler to get wrong — and a screen reader hears "switch, on" or
 * "switch, off". The value is a boolean through `ControlValueAccessor`, so it works with `[(ngModel)]` or a
 * reactive form control like `DatePicker`, the kit's other form-integrated primitive.
 *
 * `off` (after `Button`/`PickerButton`'s rule, #107) is unavailable with a reason: it stays focusable and
 * readable, carries `aria-disabled="true"` and ignores a click or a key, but keeps whatever `aria-checked` the
 * value says — the caller points `aria-describedby` at the visible reason itself, the same as those two; a native
 * `disabled` switch would hide the reason from keyboard and screen-reader users.
 *
 * `locked` is always on and never toggles (team-console#630: the roles that can never be turned off) — it draws a
 * lock in the thumb and reads `aria-checked="true"` no matter what the bound value says, so a stray `false` never
 * contradicts the lock. Like `off`, the caller supplies the reason and points `aria-describedby` at it.
 *
 * The clickable box is the kit's 44 px touch target even though the pill itself (`--switch-w`/`--switch-h`) is
 * smaller; the thumb's slide and the track's colour change use the duration tokens, so reduced motion collapses
 * them like every other control.
 *
 * ```html
 * <button tc-switch type="button" aria-label="UI designer" [ngModel]="enabled()" (ngModelChange)="enabled.set($event)" />
 * <button tc-switch type="button" aria-label="Security" locked aria-describedby="sec-why" [ngModel]="true" />
 * <p id="sec-why">Always on: needed to check access.</p>
 * ```
 */
@Component({
  selector: 'button[tc-switch]',
  imports: [Icon],
  template: `
    <span class="tc-switch__track" aria-hidden="true">
      <span class="tc-switch__thumb">
        @if (locked()) {
          <tc-icon class="tc-switch__lock" name="lock" size="sm" />
        }
      </span>
    </span>
  `,
  styleUrl: './switch.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => Switch), multi: true }],
  host: {
    class: 'tc-switch',
    role: 'switch',
    type: 'button',
    '[class.tc-switch--locked]': 'locked()',
    '[attr.aria-checked]': 'isChecked() ? "true" : "false"',
    '[attr.aria-disabled]': 'isInert() ? "true" : null',
    '[disabled]': 'formDisabled()',
    '(click)': 'onClick()',
  },
})
export class Switch implements ControlValueAccessor {
  /** Unavailable with a reason; see the class doc. The caller supplies the reason and points `aria-describedby`. */
  readonly off = input(false, { transform: booleanAttribute });
  /** Always on, never toggles, draws a lock in the thumb; the caller supplies the reason the same way as `off`. */
  readonly locked = input(false, { transform: booleanAttribute });

  private readonly value = signal(false);
  private readonly formDisabled = signal(false);

  protected readonly isChecked = computed(() => this.locked() || this.value());
  protected readonly isInert = computed(() => this.off() || this.locked());

  private onChange: (checked: boolean) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  writeValue(value: unknown): void {
    this.value.set(value === true);
  }

  registerOnChange(fn: (checked: boolean) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.formDisabled.set(isDisabled);
  }

  protected onClick(): void {
    if (this.isInert() || this.formDisabled()) {
      return;
    }
    const next = !this.value();
    this.value.set(next);
    this.onChange(next);
    this.onTouched();
  }
}
