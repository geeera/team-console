import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  Directive,
  inject,
  input,
} from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';

let nextFieldId = 0;

/**
 * Label, control, hint and error wired together: the label points at the control, the
 * hint and the error are its `aria-describedby`, and an error also sets `aria-invalid`.
 * The control is the native `input`, `textarea` or `select` carrying `tcInput`. `note` is a third line that
 * stays under both (a preview of the value) and is part of the description too.
 *
 * ```html
 * <tc-field [label]="t('repo.label')" [hint]="t('repo.hint')" [error]="repoError()" required>
 *   <input tcInput type="text" [(ngModel)]="repo" autocomplete="off" />
 * </tc-field>
 * ```
 */
@Component({
  selector: 'tc-field',
  imports: [TranslocoPipe],
  templateUrl: './field.html',
  styleUrl: './field.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-field',
    '[class.tc-field--invalid]': 'error() !== ""',
  },
})
export class Field {
  readonly label = input.required<string>();
  readonly hint = input<string>('');
  readonly error = input<string>('');
  /** A live line under the control that also describes it, e.g. a preview of what the value becomes. */
  readonly note = input<string>('');
  readonly required = input(false, { transform: booleanAttribute });

  readonly id = `tc-field-${nextFieldId++}`;
  readonly controlId = `${this.id}-control`;
  readonly hintId = `${this.id}-hint`;
  readonly errorId = `${this.id}-error`;
  readonly noteId = `${this.id}-note`;

  /** The error replaces the hint in the template, so only one of them describes the control; the note adds to it. */
  readonly describedBy = computed(() => {
    const ids: string[] = [];
    if (this.error()) {
      ids.push(this.errorId);
    } else if (this.hint()) {
      ids.push(this.hintId);
    }
    if (this.note()) {
      ids.push(this.noteId);
    }
    return ids.length === 0 ? null : ids.join(' ');
  });
}

@Directive({
  selector: 'input[tcInput], textarea[tcInput], select[tcInput]',
  host: {
    class: 'tc-input',
    '[id]': 'field?.controlId ?? null',
    '[attr.aria-describedby]': 'field?.describedBy() ?? null',
    '[attr.aria-invalid]': 'field?.error() ? "true" : null',
    '[attr.aria-required]': 'field?.required() ? "true" : null',
  },
})
export class FieldControl {
  protected readonly field = inject(Field, { optional: true });
}
