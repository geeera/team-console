import { Component, ElementRef, inject, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { BreakpointObserver } from '@angular/cdk/layout';
import { Menu, type MenuSpec } from './menu';

@Component({
  selector: 'tc-menu-host',
  template: `<button #opener type="button">Open</button>`,
})
class MenuHost {
  readonly menu = inject(Menu);
  readonly opener = viewChild.required<ElementRef<HTMLButtonElement>>('opener');
}

const SPEC: MenuSpec = {
  label: 'Move TC-408',
  title: 'TC-408 · where to move it',
  groups: [
    {
      label: 'Sprints',
      items: [
        { id: 'here', label: 'To Sprint 03 — current', off: "It's here now" },
        { id: 's4', label: 'To Sprint 04', hint: '5 tasks · demo Nov 27' },
        { id: 's5', label: 'To Sprint 05', hint: 'Already 9 tasks', hintTone: 'warning' },
      ],
    },
    { items: [{ id: 'backlog', label: 'To the backlog' }] },
  ],
};

function setup(isPhone = false) {
  TestBed.configureTestingModule({
    providers: [
      provideConsoleI18n(),
      {
        provide: BreakpointObserver,
        useValue: { isMatched: () => isPhone, observe: () => ({ pipe: () => null }) },
      },
    ],
  });
  const fixture = TestBed.createComponent(MenuHost);
  fixture.detectChanges();
  return fixture;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  TestBed.tick();
}

function items(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.tc-menu__item'));
}

function key(target: Element, name: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
}

describe('Menu', () => {
  afterEach(() => {
    document.querySelectorAll('.cdk-overlay-container').forEach((node) => node.remove());
  });

  it('opens a role=menu popover with focus on the first item that can be picked', async () => {
    const fixture = setup();
    const opened = fixture.componentInstance.menu.open(
      fixture.componentInstance.opener().nativeElement,
      SPEC,
    );
    await settle();
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.getAttribute('aria-label')).toBe('Move TC-408');
    expect(items().map((item) => item.getAttribute('role'))).toEqual([
      'menuitem',
      'menuitem',
      'menuitem',
      'menuitem',
    ]);
    expect(document.activeElement).toBe(items()[1]);
    key(items()[1] as HTMLElement, 'Escape');
    await expect(opened).resolves.toBeNull();
    expect(document.activeElement).toBe(fixture.componentInstance.opener().nativeElement);
  });

  it('keeps an off item focusable, says why when it is picked, and never resolves with it', async () => {
    const fixture = setup();
    const opened = fixture.componentInstance.menu.open(
      fixture.componentInstance.opener().nativeElement,
      SPEC,
    );
    await settle();
    const here = items()[0] as HTMLElement;
    expect(here.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(here.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      "It's here now",
    );
    here.click();
    await settle();
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain("It's here now");
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    (items()[3] as HTMLElement).click();
    await expect(opened).resolves.toBe('backlog');
  });

  it('moves with the arrows, Home and End, wrapping at the ends', async () => {
    const fixture = setup();
    void fixture.componentInstance.menu.open(fixture.componentInstance.opener().nativeElement, SPEC);
    await settle();
    const list = items();
    key(list[1] as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(list[2]);
    key(list[2] as HTMLElement, 'End');
    expect(document.activeElement).toBe(list[3]);
    key(list[3] as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(list[0]);
    key(list[0] as HTMLElement, 'ArrowUp');
    expect(document.activeElement).toBe(list[3]);
    key(list[3] as HTMLElement, 'Home');
    expect(document.activeElement).toBe(list[0]);
  });

  it('a picker is menuitemradio with focus on the checked value', async () => {
    const fixture = setup();
    void fixture.componentInstance.menu.open(fixture.componentInstance.opener().nativeElement, {
      label: 'Status TC-408',
      radio: true,
      groups: [
        {
          items: [
            { id: 'proposed', label: 'Proposed' },
            { id: 'approved', label: 'Approved', checked: true },
          ],
        },
      ],
    });
    await settle();
    expect(items().map((item) => [item.getAttribute('role'), item.getAttribute('aria-checked')])).toEqual([
      ['menuitemradio', 'false'],
      ['menuitemradio', 'true'],
    ]);
    expect(document.activeElement).toBe(items()[1]);
  });
});
