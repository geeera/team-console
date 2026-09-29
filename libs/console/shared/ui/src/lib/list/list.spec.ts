import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { List, ListRow } from './list';

@Component({
  imports: [List, ListRow],
  template: `
    <tc-list aria-label="Projects">
      <tc-list-row button [current]="current()" (click)="clicks = clicks + 1">
        <span tc-row-title>Team Console</span>
        <span tc-row-subtitle>Sprint 01</span>
      </tc-list-row>
      <tc-list-row href="/settings">
        <span tc-row-title>Settings</span>
      </tc-list-row>
      <tc-list-row>
        <span tc-row-title>Version</span>
      </tc-list-row>
    </tc-list>
  `,
})
class Host {
  readonly current = signal(false);
  clicks = 0;
}

describe('List', () => {
  async function render() {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    return { fixture, root, rows: Array.from(root.querySelectorAll('tc-list-row')) };
  }

  it('is a list of list items', async () => {
    const { root, rows } = await render();

    expect(root.querySelector('tc-list')?.getAttribute('role')).toBe('list');
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.getAttribute('role') === 'listitem')).toBe(true);
  });

  it('renders a native button, an anchor or a plain surface depending on the row', async () => {
    const { rows } = await render();

    expect(rows[0]?.querySelector('button.tc-list-row__surface')).not.toBeNull();
    expect(rows[1]?.querySelector('a.tc-list-row__surface')?.getAttribute('href')).toBe('/settings');
    expect(rows[2]?.querySelector('div.tc-list-row__surface')).not.toBeNull();
  });

  it('projects title and subtitle into the button so it is its accessible name', async () => {
    const { rows } = await render();
    const button = rows[0]?.querySelector('button') as HTMLButtonElement;

    expect(button.textContent).toContain('Team Console');
    expect(button.textContent).toContain('Sprint 01');
  });

  it('marks the current row with aria-current', async () => {
    const { fixture, rows } = await render();
    const button = rows[0]?.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-current')).toBeNull();

    fixture.componentInstance.current.set(true);
    await fixture.whenStable();

    expect(button.getAttribute('aria-current')).toBe('true');
  });

  it('bubbles the click to the host', async () => {
    const { fixture, rows } = await render();

    (rows[0]?.querySelector('button') as HTMLButtonElement).click();

    expect(fixture.componentInstance.clicks).toBe(1);
  });
});
