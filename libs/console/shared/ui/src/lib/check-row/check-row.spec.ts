import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { List } from '../list/list';
import { CheckRow } from './check-row';

@Component({
  imports: [CheckRow, List],
  template: `
    <tc-list aria-label="Questions">
      <tc-check-row [(checked)]="first" [disabled]="busy()">
        <span tc-check-title>#72 Plan</span>
        <span tc-check-detail>Team recommends: start</span>
      </tc-check-row>
      <tc-check-row [(checked)]="second">
        <span tc-check-title>#81 Export</span>
      </tc-check-row>
    </tc-list>
  `,
})
class Host {
  readonly first = signal(true);
  readonly second = signal(false);
  readonly busy = signal(false);
}

describe('CheckRow', () => {
  async function render() {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const boxes = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    return { fixture, root, boxes };
  }

  it('is a list item whose label names its native checkbox', async () => {
    const { root, boxes } = await render();
    const rows = root.querySelectorAll('tc-check-row');
    expect([...rows].map((row) => row.getAttribute('role'))).toEqual(['listitem', 'listitem']);
    expect(boxes[0]?.closest('label')?.textContent).toContain('#72 Plan');
    expect(boxes[0]?.closest('label')?.textContent).toContain('Team recommends: start');
  });

  it('reflects and updates the two-way checked state', async () => {
    const { fixture, boxes } = await render();
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);

    boxes[1]?.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.second()).toBe(true);

    boxes[0]?.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.first()).toBe(false);
  });

  it('cannot be toggled while disabled', async () => {
    const { fixture, boxes } = await render();
    fixture.componentInstance.busy.set(true);
    await fixture.whenStable();
    expect(boxes[0]?.disabled).toBe(true);
    boxes[0]?.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.first()).toBe(true);
  });
});
