import { BreakpointObserver } from '@angular/cdk/layout';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { BREAKPOINTS, type Breakpoint } from '../../tokens/breakpoints';
import { Lane, LaneHeadingLevel, Lanes } from './lane';

interface LaneData {
  readonly key: string;
  readonly heading: string;
  readonly count: number;
}

const BOARD: readonly LaneData[] = [
  { key: 'approved', heading: 'Approved', count: 0 },
  { key: 'in-progress', heading: 'In progress', count: 2 },
  { key: 'qa', heading: 'QA', count: 0 },
  { key: 'blocked', heading: 'Blocked', count: 3 },
  { key: 'done', heading: 'Done', count: 1 },
];

@Component({
  imports: [Lane, Lanes],
  template: `
    <tc-lanes
      label="Issues by status"
      [compactBelow]="compactBelow()"
      [preferred]="preferred()"
      [(selected)]="selected"
    >
      @for (lane of lanes(); track lane.key) {
        <tc-lane [key]="lane.key" [heading]="lane.heading" [count]="lane.count" [level]="level()">
          @if (lane.key === 'done') {
            <button tc-lane-action type="button">Show</button>
          }
          @if (lane.count > 0) {
            <ul>
              <li><a href="#a">a</a></li>
            </ul>
          } @else {
            <p>Nothing here</p>
          }
        </tc-lane>
      }
    </tc-lanes>
  `,
})
class Host {
  readonly level = signal<LaneHeadingLevel>(3);
  readonly lanes = signal<readonly LaneData[]>(BOARD);
  readonly selected = signal<string | null>(null);
  readonly compactBelow = signal<Breakpoint>('phone');
  readonly preferred = signal<readonly string[]>([]);
}

@Component({
  imports: [Lane, Lanes],
  template: `
    <tc-lanes label="Issues by status">
      <tc-lane heading="In progress" [count]="2"><p>a</p></tc-lane>
      <tc-lane heading="QA" [count]="0"><p>b</p></tc-lane>
    </tc-lanes>
  `,
})
class KeylessHost {}

/** The screen the fake `BreakpointObserver` reports: a phone also matches the tablet query, as in a browser. */
type Screen = 'wide' | 'tablet' | 'phone';

function breakpointsFor(screen: Screen) {
  const matches = (query: string): boolean =>
    (screen === 'phone' && (query === BREAKPOINTS.phone || query === BREAKPOINTS.tablet)) ||
    (screen === 'tablet' && query === BREAKPOINTS.tablet);
  return {
    isMatched: (query: string) => matches(query),
    observe: (query: string) => of({ matches: matches(query), breakpoints: {} }),
  };
}

describe('Lanes and Lane', () => {
  async function render(
    screen: Screen,
    lanes: readonly LaneData[] = BOARD,
    setup: (host: Host) => void = () => undefined,
  ) {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [{ provide: BreakpointObserver, useValue: breakpointsFor(screen) }],
    }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.lanes.set(lanes);
    setup(fixture.componentInstance);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const settle = async () => {
      await fixture.whenStable();
    };
    return {
      fixture,
      root,
      settle,
      lanes: root.querySelector('tc-lanes') as HTMLElement,
      cells: () => [...root.querySelectorAll<HTMLButtonElement>('.tc-lanes__cell')],
      panels: () => [...root.querySelectorAll<HTMLElement>('tc-lane')],
      shown: () =>
        [...root.querySelectorAll<HTMLElement>('tc-lane')]
          .filter((lane) => !lane.hidden)
          .map((lane) => lane.id),
      pressed: () => root.querySelector<HTMLButtonElement>('.tc-lanes__cell[aria-pressed="true"]'),
    };
  }

  const nameOf = (element: Element | null | undefined): string =>
    element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  describe('on wider screens', () => {
    it('is a named group of lanes, each a group named by its heading and count', async () => {
      const { lanes, panels } = await render('wide');
      const first = panels()[1] as HTMLElement;
      const heading = first.querySelector('[role="heading"]') as HTMLElement;

      expect(lanes.getAttribute('role')).toBe('group');
      expect(lanes.getAttribute('aria-label')).toBe('Issues by status');
      expect(first.getAttribute('role')).toBe('group');
      expect(first.getAttribute('aria-labelledby')).toBe(heading.id);
      expect(heading.getAttribute('aria-level')).toBe('3');
      expect(heading.classList.contains('tc-sr-only')).toBe(false);
      expect(nameOf(heading)).toBe('In progress 2');
    });

    it('keeps every lane in view, with no switcher and no tab stop of its own', async () => {
      const { lanes, panels, cells } = await render('wide');

      expect(cells()).toHaveLength(0);
      expect(lanes.hasAttribute('tabindex')).toBe(false);
      expect(panels().every((lane) => !lane.hidden && !lane.hasAttribute('tabindex'))).toBe(true);
    });

    it('gives every lane its own heading id and follows the requested heading level', async () => {
      const { fixture, root, settle } = await render('wide');
      fixture.componentInstance.level.set(2);
      await settle();
      const headings = [...root.querySelectorAll('[role="heading"]')];

      expect(new Set(headings.map((heading) => heading.id)).size).toBe(BOARD.length);
      expect(headings[0]?.getAttribute('aria-level')).toBe('2');
    });

    it("puts a lane's action beside its heading, outside the heading's name", async () => {
      const { panels } = await render('wide');
      const done = panels()[4] as HTMLElement;
      const heading = done.querySelector('[role="heading"]') as HTMLElement;

      expect(heading.querySelector('button')).toBeNull();
      expect(heading.parentElement?.querySelector(':scope > button[tc-lane-action]')?.textContent).toBe('Show');
    });
  });

  describe('on the phone', () => {
    it('names a group of toggle buttons, one per lane with its name above its count', async () => {
      const { lanes, root, cells, panels } = await render('phone');
      const group = root.querySelector('.tc-lanes__switch') as HTMLElement;

      expect(lanes.hasAttribute('role')).toBe(false);
      expect(lanes.hasAttribute('aria-label')).toBe(false);
      expect(group.getAttribute('role')).toBe('group');
      expect(group.getAttribute('aria-label')).toBe('Issues by status');
      // The name reads "Blocked, 3": the comma is visually hidden.
      expect(cells().map(nameOf)).toEqual([
        'Approved, 0',
        'In progress, 2',
        'QA, 0',
        'Blocked, 3',
        'Done, 1',
      ]);
      expect(cells().every((cell) => cell.type === 'button' && !cell.hasAttribute('role'))).toBe(true);
      const [cell, panel] = [cells()[1] as HTMLButtonElement, panels()[1] as HTMLElement];
      expect(cell.getAttribute('aria-controls')).toBe(panel.id);
      expect(panel.getAttribute('role')).toBe('group');
      // The heading stays for heading navigation, visually hidden: the cell already shows it.
      expect(panel.querySelector('[role="heading"]')?.classList.contains('tc-sr-only')).toBe(true);
    });

    it('opens on the first lane with items, and every cell is its own Tab stop', async () => {
      const { cells, shown, panels, pressed } = await render('phone');

      expect(nameOf(pressed())).toContain('In progress');
      expect(shown()).toEqual([panels()[1]?.id]);
      expect(cells().map((cell) => cell.tabIndex)).toEqual([0, 0, 0, 0, 0]);
    });

    it('opens on the first preferred lane that has items', async () => {
      const preferBlocked = await render('phone', BOARD, (host) =>
        host.preferred.set(['qa', 'blocked', 'in-progress']),
      );
      // QA is empty, so it is skipped for Blocked.
      expect(nameOf(preferBlocked.pressed())).toContain('Blocked');
      expect(preferBlocked.shown()).toEqual([preferBlocked.panels()[3]?.id]);
    });

    it('falls back from an empty preferred lane to the next preference', async () => {
      const noBlockers = BOARD.map((lane) => (lane.key === 'blocked' ? { ...lane, count: 0 } : lane));
      const { pressed } = await render('phone', noBlockers, (host) =>
        host.preferred.set(['blocked', 'in-progress']),
      );
      expect(nameOf(pressed())).toContain('In progress');
    });

    it('opens on the first lane when every lane is empty', async () => {
      const empty = BOARD.map((lane) => ({ ...lane, count: 0 }));
      const { pressed, shown, panels } = await render('phone', empty);

      expect(nameOf(pressed())).toContain('Approved');
      expect(shown()).toEqual([panels()[0]?.id]);
    });

    it('dims an empty lane and keeps it a focusable button that shows its lane', async () => {
      const { cells, shown, panels, settle } = await render('phone');
      const qa = cells()[2] as HTMLButtonElement;

      expect(qa.classList.contains('tc-lanes__cell--empty')).toBe(true);
      expect((cells()[1] as HTMLButtonElement).classList.contains('tc-lanes__cell--empty')).toBe(false);
      expect(qa.disabled).toBe(false);
      qa.click();
      await settle();
      expect(shown()).toEqual([panels()[2]?.id]);
    });

    it('switches lanes on a tap, keeping aria-pressed and the visible lane in step', async () => {
      const { fixture, cells, shown, panels, settle } = await render('phone');

      cells()[4]?.click();
      await settle();

      expect(cells().map((cell) => cell.getAttribute('aria-pressed'))).toEqual([
        'false',
        'false',
        'false',
        'false',
        'true',
      ]);
      expect(shown()).toEqual([panels()[4]?.id]);
      expect(fixture.componentInstance.selected()).toBe('done');
    });

    it('slides the incoming lane in from the side moved towards, never on the first render', async () => {
      const { cells, panels, settle } = await render('phone');
      const motion = (lane: HTMLElement | undefined) =>
        [...(lane?.classList ?? [])].filter((name) => name.startsWith('tc-lane--enter'));

      expect(panels().flatMap(motion)).toEqual([]);
      cells()[4]?.click();
      await settle();
      expect(motion(panels()[4])).toEqual(['tc-lane--enter-forward']);

      cells()[0]?.click();
      await settle();
      expect(motion(panels()[0])).toEqual(['tc-lane--enter-backward']);
      expect(motion(panels()[4])).toEqual([]);
    });

    it('keeps a selection the parent holds when the lanes render anew, and falls back when that lane is gone', async () => {
      const { fixture, pressed, settle } = await render('phone');

      fixture.componentInstance.selected.set('qa');
      await settle();
      expect(nameOf(pressed())).toContain('QA');

      fixture.componentInstance.lanes.set([...BOARD.map((lane) => ({ ...lane }))]);
      await settle();
      expect(nameOf(pressed())).toContain('QA');

      fixture.componentInstance.lanes.set(BOARD.filter((lane) => lane.key !== 'qa'));
      await settle();
      expect(nameOf(pressed())).toContain('In progress');
    });

    it('shows a single lane stacked, with its heading and no switcher', async () => {
      const { root, cells, panels } = await render('phone', [BOARD[1] as LaneData]);

      expect(cells()).toHaveLength(0);
      expect(root.querySelector('tc-lanes')?.getAttribute('role')).toBe('group');
      expect(panels()[0]?.getAttribute('role')).toBe('group');
      expect(panels()[0]?.hidden).toBe(false);
      expect(root.querySelector('[role="heading"]')?.classList.contains('tc-sr-only')).toBe(false);
    });

    it('keys lanes by their heading when no key is given', async () => {
      await TestBed.configureTestingModule({
        imports: [KeylessHost],
        providers: [{ provide: BreakpointObserver, useValue: breakpointsFor('phone') }],
      }).compileComponents();
      const fixture = TestBed.createComponent(KeylessHost);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      const lanes = [...root.querySelectorAll<HTMLElement>('tc-lane')];

      (root.querySelectorAll<HTMLButtonElement>('.tc-lanes__cell')[1] as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(lanes.map((lane) => lane.hidden)).toEqual([true, false]);
    });
  });

  describe('compact below a wider breakpoint', () => {
    it('stays stacked on a tablet by default, and switches there when asked to', async () => {
      const stacked = await render('tablet');
      expect(stacked.cells()).toHaveLength(0);
      TestBed.resetTestingModule();

      const compact = await render('tablet', BOARD, (host) => host.compactBelow.set('tablet'));
      expect(compact.cells()).toHaveLength(BOARD.length);
      expect(compact.shown()).toHaveLength(1);
    });
  });
});
