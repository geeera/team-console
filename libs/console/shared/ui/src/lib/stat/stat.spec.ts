import { Component, signal, viewChildren } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { IconName } from '../icon/icon';
import { Stat, Stats, StatTone } from './stat';

@Component({
  imports: [Stat, Stats],
  template: `
    <dl tc-stats [columns]="columns()">
      <div tc-stat label="Done" [sub]="sub()">3 of 9</div>
      <div
        tc-stat
        label="CI"
        [tone]="tone()"
        [icon]="icon()"
        [actionLabel]="action()"
        (activate)="activated = activated + 1"
      >
        1 PR failed
      </div>
    </dl>
  `,
})
class Host {
  readonly tone = signal<StatTone>('neutral');
  readonly sub = signal<string | null>(null);
  readonly action = signal<string | null>(null);
  readonly icon = signal<IconName | null>(null);
  readonly columns = signal<number | null>(null);
  private readonly tiles = viewChildren(Stat);
  ci(): Stat {
    return this.tiles()[1] as Stat;
  }
  activated = 0;
}

describe('Stats and Stat', () => {
  async function render() {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      root,
      settle: () => fixture.whenStable(),
      stats: () => [...root.querySelectorAll<HTMLElement>('div[tc-stat]')],
    };
  }

  it('is a description list whose children are dt/dd groups only', async () => {
    const { root } = await render();
    const list = root.querySelector('dl') as HTMLElement;

    expect([...list.children].map((child) => child.tagName)).toEqual(['DIV', 'DIV']);
    const first = list.children[0] as HTMLElement;
    expect([...first.children].map((child) => child.tagName)).toEqual(['DT', 'DD']);
    expect(first.querySelector('dt')?.textContent).toBe('Done');
    expect(first.querySelector('dd')?.textContent?.trim()).toBe('3 of 9');
  });

  it('marks the tone on the group so the value can be coloured', async () => {
    const { fixture, stats, settle } = await render();
    const stat = stats()[1] as HTMLElement;
    expect(stat.className).not.toContain('tc-stat--danger');

    fixture.componentInstance.tone.set('danger');
    await settle();

    expect(stat.classList.contains('tc-stat--danger')).toBe(true);
  });

  it('shows the sub line inside the value, under it', async () => {
    const { fixture, stats, settle } = await render();
    const done = stats()[0] as HTMLElement;
    expect(done.querySelector('.tc-stat__sub')).toBeNull();

    fixture.componentInstance.sub.set('6 still open');
    await settle();

    expect(done.querySelector('dd .tc-stat__sub')?.textContent).toBe('6 still open');
    expect(done.querySelector('dd .tc-stat__text')?.textContent?.trim()).toBe('3 of 9');
  });

  it('is plain text until it has an action label, then a named button in the dd that emits activate', async () => {
    const { fixture, stats, settle } = await render();
    const ci = stats()[1] as HTMLElement;
    expect(ci.querySelector('button')).toBeNull();
    expect(ci.classList.contains('tc-stat--action')).toBe(false);

    fixture.componentInstance.action.set('CI: 1 PR failed. Open PRs');
    await settle();

    const button = ci.querySelector('dd > button') as HTMLButtonElement;
    expect(ci.classList.contains('tc-stat--action')).toBe(true);
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('CI: 1 PR failed. Open PRs');
    expect(button.textContent?.trim()).toBe('1 PR failed');
    // The › ends the label row, so the value has the tile's whole width; it is decoration, the name says it all.
    expect(button.querySelector('tc-icon')).toBeNull();
    const chevron = ci.querySelector('dt .tc-stat__chevron') as HTMLElement;
    expect(chevron.getAttribute('aria-hidden')).toBe('true');
    expect(chevron.previousElementSibling?.textContent).toBe('CI');

    button.click();
    expect(fixture.componentInstance.activated).toBe(1);
  });

  it('focuses its button on request, and does nothing when it has none', async () => {
    const { fixture, settle } = await render();
    expect(() => fixture.componentInstance.ci().focus()).not.toThrow();

    fixture.componentInstance.action.set('CI: open PRs');
    await settle();
    fixture.componentInstance.ci().focus();

    expect(document.activeElement?.classList.contains('tc-stat__action')).toBe(true);
  });

  it('puts the state glyph before the label, hidden from assistive tech, and the label text after it', async () => {
    const { fixture, stats, settle } = await render();
    const ci = stats()[1] as HTMLElement;
    expect(ci.querySelector('.tc-stat__icon')).toBeNull();

    fixture.componentInstance.icon.set('x');
    await settle();

    const label = ci.querySelector('dt') as HTMLElement;
    expect(label.firstElementChild?.classList.contains('tc-stat__icon')).toBe(true);
    expect(label.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(label.textContent?.trim()).toBe('CI');
    expect(ci.querySelector('dd tc-icon')).toBeNull();
  });

  it('fits as many columns as there is room for, or exactly the columns asked for', async () => {
    const { fixture, root, settle } = await render();
    const list = root.querySelector('dl') as HTMLElement;
    expect(list.style.gridTemplateColumns).toBe('');

    fixture.componentInstance.columns.set(4);
    await settle();
    expect(list.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');

    fixture.componentInstance.columns.set(0);
    await settle();
    expect(list.style.gridTemplateColumns).toBe('');
  });
});
