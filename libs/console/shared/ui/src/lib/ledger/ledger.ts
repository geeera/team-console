import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A field ledger (#409): a `dl` of labelled rows, labels in small caps on the left, each value a plain text or a
 * control (a `PickerButton`). One row per `tc-ledger-row`; the label is already translated by the caller.
 *
 * ```html
 * <dl tc-ledger>
 *   <div tc-ledger-row [label]="t('item.status')"><button tc-picker …></button></div>
 *   <div tc-ledger-row [label]="t('item.tier')">{{ tier }}</div>
 * </dl>
 * ```
 */
@Component({
  selector: 'dl[tc-ledger]',
  template: '<ng-content />',
  styleUrl: './ledger.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-ledger' },
})
export class Ledger {}

@Component({
  selector: 'div[tc-ledger-row]',
  template: `
    <dt class="tc-ledger__label">{{ label() }}</dt>
    <dd class="tc-ledger__value"><ng-content /></dd>
  `,
  styleUrl: './ledger-row.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-ledger__row' },
})
export class LedgerRow {
  readonly label = input.required<string>();
}
