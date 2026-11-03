import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { List, ListRow } from './list';

@Component({
  imports: [List, ListRow],
  template: `
    <tc-list aria-label="Projects">
      <tc-list-row button [current]="current()" (click)="clicks = clicks + 1">
        <span tc-row-title>Team Console</span>
        <span tc-row-subtitle>Sprint 01</span>
        <button tc-row-action type="button" aria-label="Pin Team Console" (click)="pins = pins + 1">P</button>
      </tc-list-row>
      <tc-list-row href="/settings">
        <span tc-row-title>Settings</span>
      </tc-list-row>
      <tc-list-row>
        <span tc-row-title>Version</span>
      </tc-list-row>
      <tc-list-row href="https://github.com/o/r/issues/1" external>
        <span tc-row-title>#1 on GitHub</span>
      </tc-list-row>
    </tc-list>
  `,
})
class Host {
  readonly current = signal(false);
  clicks = 0;
  pins = 0;
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
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.getAttribute('role') === 'listitem')).toBe(true);
  });

  it('renders a native button, an anchor or a plain surface depending on the row', async () => {
    const { rows } = await render();

    expect(rows[0]?.querySelector('button.tc-list-row__surface')).not.toBeNull();
    expect(rows[1]?.querySelector('a.tc-list-row__surface')?.getAttribute('href')).toBe('/settings');
    expect(rows[2]?.querySelector('div.tc-list-row__surface')).not.toBeNull();
  });

  it('opens an external row in a new tab without an opener; internal links stay in place', async () => {
    const { rows } = await render();
    const external = rows[3]?.querySelector('a') as HTMLAnchorElement;
    const internal = rows[1]?.querySelector('a') as HTMLAnchorElement;

    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');
    expect(internal.hasAttribute('target')).toBe(false);
    expect(internal.hasAttribute('rel')).toBe(false);
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

    (rows[0]?.querySelector('button.tc-list-row__surface') as HTMLButtonElement).click();

    expect(fixture.componentInstance.clicks).toBe(1);
  });

  it('renders a row action beside the surface, never inside it', async () => {
    const { fixture, rows } = await render();
    const row = rows[0] as HTMLElement;
    const action = row.querySelector('[tc-row-action]') as HTMLButtonElement;

    expect(action.closest('.tc-list-row__surface')).toBeNull();
    expect(row.querySelector('button.tc-list-row__surface')?.contains(action)).toBe(false);

    action.click();
    expect(fixture.componentInstance.pins).toBe(1);
  });
});

@Component({
  imports: [List, ListRow],
  template: `
    <tc-list aria-label="Repositories">
      <tc-list-row [link]="['/settings/projects', 'storify']">
        <span tc-row-title>storify</span>
        <span tc-row-trailing-text>Project</span>
      </tc-list-row>
      <tc-list-row muted>
        <span tc-row-title>old-landing</span>
        <span tc-row-trailing-text>Archived</span>
      </tc-list-row>
      <tc-list-row>
        <span tc-row-title>fieldnote</span>
        <span tc-row-detail>Not added: step 3 is missing <button type="button">See why</button></span>
      </tc-list-row>
    </tc-list>
  `,
})
class RepositoryRows {}

describe('ListRow variants (#194)', () => {
  async function render() {
    await TestBed.configureTestingModule({
      imports: [RepositoryRows],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(RepositoryRows);
    await fixture.whenStable();
    return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('tc-list-row'));
  }

  it('makes a router-link row one in-app anchor with the trailing text inside it', async () => {
    const [project] = await render();
    const anchor = project?.querySelector('a.tc-list-row__surface');
    expect(anchor?.getAttribute('href')).toBe('/settings/projects/storify');
    expect(anchor?.getAttribute('target')).toBeNull();
    expect(anchor?.querySelector('.tc-list-row__trailing-text')?.textContent?.trim()).toBe('Project');
    expect(project?.classList).toContain('tc-list-row--interactive');
  });

  it('marks a muted row and keeps it static', async () => {
    const [, archived] = await render();
    expect(archived?.classList).toContain('tc-list-row--muted');
    expect(archived?.querySelector('a, button')).toBeNull();
  });

  it('projects the detail line under the title, inside the static surface', async () => {
    const [, , addable] = await render();
    const detail = addable?.querySelector('.tc-list-row__text .tc-list-row__detail');
    expect(detail?.querySelector('button')?.textContent).toBe('See why');
  });
});
