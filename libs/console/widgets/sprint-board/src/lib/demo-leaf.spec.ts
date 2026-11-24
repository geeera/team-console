import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DEMO_LEAF_STORAGE, DemoLeaf, resetDemoLeafSession } from './demo-leaf';

const LINE_3 = 'Демо 16 октября · через 3 дня';
const LINE_4 = 'Демо 16 октября · через 4 дня';

@Component({
  imports: [DemoLeaf],
  template: `<tc-demo-leaf [due]="'2026-10-16'" [days]="days()" [line]="line()" />`,
})
class Host {
  readonly days = signal(3);
  readonly line = signal(LINE_3);
}

describe('DemoLeaf', () => {
  let stored: string | null;

  async function render() {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        {
          provide: DEMO_LEAF_STORAGE,
          useValue: {
            read: () => stored,
            write: (value: string) => {
              stored = value;
            },
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const leaf = (fixture.nativeElement as HTMLElement).querySelector('tc-demo-leaf') as HTMLElement;
    return { fixture, leaf };
  }

  beforeEach(() => {
    stored = null;
    resetDemoLeafSession();
  });

  it('shows the words and remembers them', async () => {
    const { leaf } = await render();

    expect(leaf.textContent).toBe(LINE_3);
    expect(leaf.classList).not.toContain('tc-demo-leaf--tearing');
    expect(JSON.parse(stored ?? 'null')).toEqual({ due: '2026-10-16', days: 3, line: LINE_3 });
  });

  it('tears the previous day’s leaf once, keeping its words out of the text', async () => {
    stored = JSON.stringify({ due: '2026-10-16', days: 4, line: LINE_4 });
    const { fixture, leaf } = await render();

    expect(leaf.classList).toContain('tc-demo-leaf--tearing');
    expect(leaf.getAttribute('data-torn')).toBe(LINE_4);
    expect(leaf.textContent).toBe(LINE_3);

    // jsdom has no AnimationEvent; the component reads only `animationName`.
    leaf.dispatchEvent(Object.assign(new Event('animationend'), { animationName: 'tc-leaf-tear' }));
    await fixture.whenStable();
    expect(leaf.classList).not.toContain('tc-demo-leaf--tearing');
  });

  it('marks the demo day with the accent leaf', async () => {
    const { fixture, leaf } = await render();

    fixture.componentInstance.days.set(0);
    await fixture.whenStable();

    expect(leaf.classList).toContain('tc-demo-leaf--today');
  });

  it('treats a damaged memory as a first visit', async () => {
    stored = '{not json';
    const { leaf } = await render();

    expect(leaf.classList).not.toContain('tc-demo-leaf--tearing');
  });
});
