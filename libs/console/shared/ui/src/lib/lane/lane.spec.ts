import { BreakpointObserver } from '@angular/cdk/layout';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
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
  { key: 'done', heading: 'Done', count: 1 },
];

@Component({
  imports: [Lane, Lanes],
  template: `
    <tc-lanes label="Issues by status" [(selected)]="selected">
      @for (lane of lanes(); track lane.key) {
        <tc-lane [key]="lane.key" [heading]="lane.heading" [count]="lane.count" [level]="level()">
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

describe('Lanes and Lane', () => {
  async function render(phone: boolean, lanes: readonly LaneData[] = BOARD) {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        {
          provide: BreakpointObserver,
          useValue: { isMatched: () => phone, observe: () => of({ matches: phone, breakpoints: {} }) },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.lanes.set(lanes);
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
      tabs: () => [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')],
      panels: () => [...root.querySelectorAll<HTMLElement>('tc-lane')],
      shown: () =>
        [...root.querySelectorAll<HTMLElement>('tc-lane')]
          .filter((lane) => !lane.hidden)
          .map((lane) => lane.id),
      selectedTab: () => root.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]'),
    };
  }

  function key(target: HTMLElement, name: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  describe('on wider screens', () => {
    it('is a named group of lanes, each a group named by its heading and count', async () => {
      const { lanes, panels } = await render(false);
      const first = panels()[1] as HTMLElement;
      const heading = first.querySelector('[role="heading"]') as HTMLElement;

      expect(lanes.getAttribute('role')).toBe('group');
      expect(lanes.getAttribute('aria-label')).toBe('Issues by status');
      expect(first.getAttribute('role')).toBe('group');
      expect(first.getAttribute('aria-labelledby')).toBe(heading.id);
      expect(heading.getAttribute('aria-level')).toBe('3');
      expect(heading.classList.contains('tc-sr-only')).toBe(false);
      expect(heading.textContent?.replace(/\s+/g, ' ').trim()).toBe('In progress 2');
    });

    it('keeps every lane in view, with no tab list and no tab stop of its own', async () => {
      const { lanes, panels, tabs } = await render(false);

      expect(tabs()).toHaveLength(0);
      expect(lanes.hasAttribute('tabindex')).toBe(false);
      expect(panels().every((lane) => !lane.hidden && !lane.hasAttribute('tabindex'))).toBe(true);
    });

    it('gives every lane its own heading id and follows the requested heading level', async () => {
      const { fixture, root, settle } = await render(false);
      fixture.componentInstance.level.set(2);
      await settle();
      const headings = [...root.querySelectorAll('[role="heading"]')];

      expect(new Set(headings.map((heading) => heading.id)).size).toBe(BOARD.length);
      expect(headings[0]?.getAttribute('aria-level')).toBe('2');
    });
  });

  describe('on the phone', () => {
    it('names a tab list of lanes with their counts and shows the selected lane as its tab panel', async () => {
      const { lanes, root, tabs, panels } = await render(true);
      const tablist = root.querySelector('[role="tablist"]') as HTMLElement;

      expect(lanes.hasAttribute('role')).toBe(false);
      expect(lanes.hasAttribute('aria-label')).toBe(false);
      expect(tablist.getAttribute('aria-label')).toBe('Issues by status');
      expect(tabs().map((tab) => tab.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
        'Approved 0',
        'In progress 2',
        'QA 0',
        'Done 1',
      ]);
      const [tab, panel] = [tabs()[1] as HTMLButtonElement, panels()[1] as HTMLElement];
      expect(tab.getAttribute('aria-controls')).toBe(panel.id);
      expect(panel.getAttribute('role')).toBe('tabpanel');
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
      // The heading stays for heading navigation, visually hidden: the pill already shows it.
      expect(panel.querySelector('[role="heading"]')?.classList.contains('tc-sr-only')).toBe(true);
    });

    it('opens on the first lane with items and is one Tab stop', async () => {
      const { tabs, shown, panels, selectedTab } = await render(true);

      expect(selectedTab()?.textContent).toContain('In progress');
      expect(shown()).toEqual([panels()[1]?.id]);
      expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, 0, -1, -1]);
    });

    it('opens on the first lane when every lane is empty', async () => {
      const empty = BOARD.map((lane) => ({ ...lane, count: 0 }));
      const { selectedTab, shown, panels } = await render(true, empty);

      expect(selectedTab()?.textContent).toContain('Approved');
      expect(shown()).toEqual([panels()[0]?.id]);
    });

    it('lets an empty panel take focus, and only an empty one', async () => {
      const { tabs, panels, settle } = await render(true);

      expect(panels()[1]?.hasAttribute('tabindex')).toBe(false);
      tabs()[2]?.click();
      await settle();
      expect(panels()[2]?.getAttribute('tabindex')).toBe('0');
    });

    it('switches lanes on a tap, keeping aria-selected, the Tab stop and the visible panel in step', async () => {
      const { fixture, tabs, shown, panels, settle } = await render(true);

      tabs()[3]?.click();
      await settle();

      expect(tabs().map((tab) => tab.getAttribute('aria-selected'))).toEqual([
        'false',
        'false',
        'false',
        'true',
      ]);
      expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, -1, -1, 0]);
      expect(shown()).toEqual([panels()[3]?.id]);
      expect(fixture.componentInstance.selected()).toBe('done');
    });

    it('moves focus and selection with the arrow keys (wrapping), Home and End', async () => {
      const { tabs, selectedTab, shown, panels, settle } = await render(true);
      const press = async (name: string) => {
        const event = key(selectedTab() as HTMLButtonElement, name);
        await settle();
        return event;
      };
      const at = () => tabs().indexOf(selectedTab() as HTMLButtonElement);

      expect((await press('ArrowRight')).defaultPrevented).toBe(true);
      expect(at()).toBe(2);
      await press('ArrowRight');
      expect(at()).toBe(3);
      await press('ArrowRight');
      expect(at()).toBe(0);
      await press('ArrowLeft');
      expect(at()).toBe(3);
      await press('Home');
      expect(at()).toBe(0);
      await press('End');
      expect(at()).toBe(3);
      expect(document.activeElement).toBe(tabs()[3]);
      expect(shown()).toEqual([panels()[3]?.id]);
      expect((await press('Enter')).defaultPrevented).toBe(false);
      expect(at()).toBe(3);
    });

    it('slides the incoming lane in from the side moved towards, never on the first render', async () => {
      const { tabs, panels, settle } = await render(true);
      const motion = (lane: HTMLElement | undefined) =>
        [...(lane?.classList ?? [])].filter((name) => name.startsWith('tc-lane--enter'));

      expect(panels().flatMap(motion)).toEqual([]);
      tabs()[3]?.click();
      await settle();
      expect(motion(panels()[3])).toEqual(['tc-lane--enter-forward']);
      tabs()[0]?.click();
      await settle();
      expect(motion(panels()[0])).toEqual(['tc-lane--enter-backward']);
      expect(motion(panels()[3])).toEqual([]);
    });

    it('keeps a selection the parent holds when the lanes render anew, and falls back when that lane is gone', async () => {
      const { fixture, selectedTab, settle } = await render(true);
      fixture.componentInstance.selected.set('qa');
      await settle();
      expect(selectedTab()?.textContent).toContain('QA');

      fixture.componentInstance.lanes.set([...BOARD.map((lane) => ({ ...lane }))]);
      await settle();
      expect(selectedTab()?.textContent).toContain('QA');

      fixture.componentInstance.lanes.set(BOARD.filter((lane) => lane.key !== 'qa'));
      await settle();
      expect(selectedTab()?.textContent).toContain('In progress');
    });

    it('shows a single lane stacked, with its heading and no switcher', async () => {
      const { root, tabs, panels } = await render(true, [BOARD[1] as LaneData]);

      expect(tabs()).toHaveLength(0);
      expect(root.querySelector('tc-lanes')?.getAttribute('role')).toBe('group');
      expect(panels()[0]?.getAttribute('role')).toBe('group');
      expect(panels()[0]?.hidden).toBe(false);
      expect(root.querySelector('[role="heading"]')?.classList.contains('tc-sr-only')).toBe(false);
    });

    it('keys lanes by their heading when no key is given', async () => {
      await TestBed.configureTestingModule({
        imports: [KeylessHost],
        providers: [
          {
            provide: BreakpointObserver,
            useValue: { isMatched: () => true, observe: () => of({ matches: true, breakpoints: {} }) },
          },
        ],
      }).compileComponents();
      const fixture = TestBed.createComponent(KeylessHost);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      const lanes = [...root.querySelectorAll<HTMLElement>('tc-lane')];

      (root.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1] as HTMLButtonElement).click();
      await fixture.whenStable();
      expect(lanes.map((lane) => lane.hidden)).toEqual([true, false]);
    });
  });
});
