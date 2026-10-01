import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Stat, Stats, StatTone } from './stat';

@Component({
  imports: [Stat, Stats],
  template: `
    <dl tc-stats>
      <div tc-stat label="Done">3 of 9</div>
      <div tc-stat label="CI" [tone]="tone()">red</div>
    </dl>
  `,
})
class Host {
  readonly tone = signal<StatTone>('neutral');
}

describe('Stats and Stat', () => {
  async function render() {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('is a description list whose children are dt/dd groups only', async () => {
    const { root } = await render();
    const list = root.querySelector('dl') as HTMLElement;

    expect([...list.children].map((child) => child.tagName)).toEqual(['DIV', 'DIV']);
    const first = list.children[0] as HTMLElement;
    expect([...first.children].map((child) => child.tagName)).toEqual(['DT', 'DD']);
    expect(first.querySelector('dt')?.textContent).toBe('Done');
    expect(first.querySelector('dd')?.textContent).toBe('3 of 9');
  });

  it('marks the tone on the group so the value can be coloured', async () => {
    const { fixture, root } = await render();
    const stat = root.querySelectorAll('div[tc-stat]')[1] as HTMLElement;
    expect(stat.className).not.toContain('tc-stat--danger');

    fixture.componentInstance.tone.set('danger');
    await fixture.whenStable();

    expect(stat.classList.contains('tc-stat--danger')).toBe(true);
  });
});
