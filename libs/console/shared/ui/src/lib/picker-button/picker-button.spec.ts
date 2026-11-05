import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Ledger, LedgerRow } from '../ledger/ledger';
import { PickerButton } from './picker-button';

@Component({
  imports: [Ledger, LedgerRow, PickerButton],
  template: `
    <dl tc-ledger>
      <div tc-ledger-row label="Status">
        <button tc-picker type="button" field="Status" [value]="value()" [expanded]="open()" [off]="off()">
          <i aria-hidden="true"></i>
        </button>
      </div>
      <div tc-ledger-row label="Tier">standard</div>
    </dl>
  `,
})
class Host {
  readonly value = signal('Approved');
  readonly open = signal(false);
  readonly off = signal(false);
}

describe('PickerButton in a Ledger', () => {
  it('names itself by field and value, says it opens a menu, and reflects open and off', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const button = root.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Status: Approved');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.hasAttribute('aria-disabled')).toBe(false);

    fixture.componentInstance.value.set('QA');
    fixture.componentInstance.open.set(true);
    fixture.componentInstance.off.set(true);
    fixture.detectChanges();
    expect(button.getAttribute('aria-label')).toBe('Status: QA');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // Off is aria-disabled, never disabled: it keeps focus and its reason.
    expect(button.disabled).toBe(false);
  });

  it('renders the ledger as dt/dd pairs inside one dl', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(Array.from(root.querySelectorAll('dl > div > dt')).map((dt) => dt.textContent?.trim())).toEqual([
      'Status',
      'Tier',
    ]);
    expect(root.querySelectorAll('dl > div > dd')).toHaveLength(2);
  });
});
