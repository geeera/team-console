import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PaperNote } from './paper-note';

@Component({
  imports: [PaperNote],
  template: `<tc-paper-note [leaving]="leaving()" (left)="lefts.set(lefts() + 1)">Updated</tc-paper-note>`,
})
class Host {
  readonly leaving = signal(false);
  readonly lefts = signal(0);
}

describe('PaperNote', () => {
  async function setup() {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const sheet = (fixture.nativeElement as HTMLElement).querySelector('.tc-paper-note') as HTMLElement;
    return { fixture, sheet };
  }

  it('shows its content on a sheet', async () => {
    const { sheet } = await setup();
    expect(sheet.textContent?.trim()).toBe('Updated');
    expect(sheet.classList.contains('tc-paper-note--leaving')).toBe(false);
  });

  it('ignores the end of its entrance', async () => {
    const { fixture, sheet } = await setup();
    sheet.dispatchEvent(new Event('animationend'));
    expect(fixture.componentInstance.lefts()).toBe(0);
  });

  it('says it has left once the exit has played', async () => {
    const { fixture, sheet } = await setup();
    fixture.componentInstance.leaving.set(true);
    await fixture.whenStable();
    expect(sheet.classList.contains('tc-paper-note--leaving')).toBe(true);

    sheet.dispatchEvent(new Event('animationend'));
    expect(fixture.componentInstance.lefts()).toBe(1);
  });
});
