import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Tab, TabBar } from './tab-bar';

@Component({
  imports: [TabBar, Tab],
  template: `
    <nav tc-tab-bar [bottom]="bottom()" aria-label="Sections">
      <a tc-tab href="#questions" [current]="section() === 'questions'">Questions</a>
      <a tc-tab href="#chat" [current]="section() === 'chat'">Chat</a>
    </nav>
  `,
})
class Host {
  readonly section = signal('questions');
  readonly bottom = signal(false);
}

describe('TabBar', () => {
  async function render() {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      root,
      nav: root.querySelector('nav') as HTMLElement,
      tabs: Array.from(root.querySelectorAll('a')),
    };
  }

  it('is a labelled nav of links with exactly one current page', async () => {
    const { nav, tabs } = await render();

    expect(nav.getAttribute('aria-label')).toBe('Sections');
    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual(['page', null]);
  });

  it('moves aria-current with the section', async () => {
    const { fixture, tabs } = await render();

    fixture.componentInstance.section.set('chat');
    await fixture.whenStable();

    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual([null, 'page']);
  });

  it('switches to the bottom-bar layout on demand', async () => {
    const { fixture, nav } = await render();
    expect(nav.classList.contains('tc-tab-bar--bottom')).toBe(false);

    fixture.componentInstance.bottom.set(true);
    await fixture.whenStable();

    expect(nav.classList.contains('tc-tab-bar--bottom')).toBe(true);
  });
});
