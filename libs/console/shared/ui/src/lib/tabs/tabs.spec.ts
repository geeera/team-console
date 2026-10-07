import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TabPanel, Tabs } from './tabs';

interface PanelData {
  readonly key: string;
  readonly label: string;
}

const SECTIONS: readonly PanelData[] = [
  { key: 'tasks', label: 'Tasks 20' },
  { key: 'pulls', label: 'PR 4' },
  { key: 'runs', label: 'Runs 5' },
];

@Component({
  imports: [Tabs, TabPanel],
  template: `
    <tc-tabs label="Board sections" [enabled]="enabled()" [(selected)]="selected">
      @for (panel of panels(); track panel.key) {
        <tc-tab-panel [key]="panel.key" [label]="panel.label">
          <a href="#{{ panel.key }}">{{ panel.key }} link</a>
        </tc-tab-panel>
      }
    </tc-tabs>
  `,
})
class Host {
  readonly enabled = signal(true);
  readonly panels = signal<readonly PanelData[]>(SECTIONS);
  readonly selected = signal<string | null>(null);
  readonly tabs = viewChild.required(Tabs);
}

describe('Tabs and TabPanel', () => {
  async function render(setup: (host: Host) => void = () => undefined) {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    setup(fixture.componentInstance);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    return {
      fixture,
      root,
      settle: () => fixture.whenStable(),
      tablist: () => root.querySelector<HTMLElement>('[role="tablist"]'),
      tabs: () => [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')],
      panels: () => [...root.querySelectorAll<HTMLElement>('tc-tab-panel')],
      shown: () => [...root.querySelectorAll<HTMLElement>('tc-tab-panel')].filter((panel) => !panel.hidden),
      selectedTab: () => root.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]'),
    };
  }

  function press(target: HTMLElement, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is a named tab list whose tabs control their panels', async () => {
    const { tablist, tabs, panels } = await render();

    expect(tablist()?.getAttribute('aria-label')).toBe('Board sections');
    expect(tabs().map((tab) => tab.textContent?.trim())).toEqual(['Tasks 20', 'PR 4', 'Runs 5']);
    tabs().forEach((tab, index) => {
      const panel = panels()[index] as HTMLElement;
      expect(tab.getAttribute('aria-controls')).toBe(panel.id);
      expect(panel.getAttribute('role')).toBe('tabpanel');
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
      // Focusable from a script (a jump), never a Tab stop of its own: Tab goes to its links.
      expect(panel.getAttribute('tabindex')).toBe('-1');
    });
  });

  it('opens on the first panel and is one Tab stop', async () => {
    const { tabs, shown, panels, selectedTab } = await render();

    expect(selectedTab()?.textContent?.trim()).toBe('Tasks 20');
    expect(shown()).toEqual([panels()[0]]);
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
  });

  it('opens on the selection the parent holds, and on the first panel when that key is unknown', async () => {
    const held = await render((host) => host.selected.set('runs'));
    expect(held.selectedTab()?.textContent?.trim()).toBe('Runs 5');
    TestBed.resetTestingModule();

    const unknown = await render((host) => host.selected.set('chat'));
    expect(unknown.selectedTab()?.textContent?.trim()).toBe('Tasks 20');
  });

  it('switches on a tap, keeping aria-selected, the Tab stop, the visible panel and the model in step', async () => {
    const { fixture, tabs, shown, panels, settle } = await render();

    tabs()[1]?.click();
    await settle();

    expect(tabs().map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    expect(shown()).toEqual([panels()[1]]);
    expect(fixture.componentInstance.selected()).toBe('pulls');
  });

  it('moves focus and selection with the arrow keys (wrapping), Home and End', async () => {
    const { tabs, selectedTab, settle } = await render();
    const at = () => tabs().indexOf(selectedTab() as HTMLButtonElement);
    const key = async (name: string) => {
      const event = press(selectedTab() as HTMLButtonElement, name);
      await settle();
      return event;
    };

    expect((await key('ArrowRight')).defaultPrevented).toBe(true);
    expect(at()).toBe(1);
    await key('ArrowRight');
    await key('ArrowRight');
    expect(at()).toBe(0);
    await key('ArrowLeft');
    expect(at()).toBe(2);
    await key('Home');
    expect(at()).toBe(0);
    await key('End');
    expect(at()).toBe(2);
    expect(document.activeElement).toBe(tabs()[2]);
    expect((await key('Enter')).defaultPrevented).toBe(false);
  });

  it('selects a panel from a script and moves focus into it, as a jump from a tile does', async () => {
    const { fixture, panels, shown, settle } = await render();

    fixture.componentInstance.tabs().select('runs', { focusPanel: true });
    await settle();

    expect(shown()).toEqual([panels()[2]]);
    expect(document.activeElement).toBe(panels()[2]);
  });

  it('ignores a key no panel has', async () => {
    const { fixture, selectedTab, settle } = await render();

    fixture.componentInstance.tabs().select('chat', { focusPanel: true });
    await settle();

    expect(selectedTab()?.textContent?.trim()).toBe('Tasks 20');
    expect(fixture.componentInstance.selected()).toBeNull();
  });

  it('turned off, shows every panel as a plain block with no tab list, and keeps the selection', async () => {
    const { fixture, tablist, panels, shown, settle } = await render((host) => host.selected.set('pulls'));

    fixture.componentInstance.enabled.set(false);
    await settle();

    expect(tablist()).toBeNull();
    expect(shown()).toEqual(panels());
    expect(panels().every((panel) => !panel.hasAttribute('role') && !panel.hasAttribute('tabindex'))).toBe(true);

    fixture.componentInstance.enabled.set(true);
    await settle();
    expect(shown()).toEqual([panels()[1]]);
  });

  it('needs no tab list for a single panel', async () => {
    const { tablist, shown } = await render((host) => host.panels.set([SECTIONS[1] as PanelData]));

    expect(tablist()).toBeNull();
    expect(shown()).toHaveLength(1);
  });
});
