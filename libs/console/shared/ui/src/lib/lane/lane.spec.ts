import { BreakpointObserver } from '@angular/cdk/layout';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { Lane, LaneHeadingLevel, Lanes } from './lane';

@Component({
  imports: [Lane, Lanes],
  template: `
    <tc-lanes aria-label="Issues by status">
      <tc-lane heading="In progress" [count]="2" [level]="level()"><ul><li>a</li><li>b</li></ul></tc-lane>
      <tc-lane heading="QA" [count]="0"><p>Nothing here</p></tc-lane>
    </tc-lanes>
  `,
})
class Host {
  readonly level = signal<LaneHeadingLevel>(3);
}

describe('Lanes and Lane', () => {
  async function render(phone: boolean) {
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
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    return { fixture, root, lanes: root.querySelector('tc-lanes') as HTMLElement };
  }

  it('is a named group of lanes, each a group named by its heading and count', async () => {
    const { root, lanes } = await render(false);
    const [first] = [...root.querySelectorAll<HTMLElement>('tc-lane')];
    const heading = first?.querySelector('[role="heading"]') as HTMLElement;

    expect(lanes.getAttribute('role')).toBe('group');
    expect(first?.getAttribute('role')).toBe('group');
    expect(first?.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(heading.getAttribute('aria-level')).toBe('3');
    expect(heading.textContent?.replace(/\s+/g, ' ').trim()).toBe('In progress 2');
    expect(first?.querySelectorAll('li')).toHaveLength(2);
  });

  it('gives every lane its own heading id and follows the requested heading level', async () => {
    const { fixture, root } = await render(false);
    fixture.componentInstance.level.set(2);
    await fixture.whenStable();
    const headings = [...root.querySelectorAll('[role="heading"]')];

    expect(new Set(headings.map((heading) => heading.id)).size).toBe(2);
    expect(headings[0]?.getAttribute('aria-level')).toBe('2');
  });

  it('takes keyboard focus only on the phone, where the row scrolls sideways', async () => {
    expect((await render(false)).lanes.hasAttribute('tabindex')).toBe(false);
    TestBed.resetTestingModule();
    expect((await render(true)).lanes.getAttribute('tabindex')).toBe('0');
  });
});
