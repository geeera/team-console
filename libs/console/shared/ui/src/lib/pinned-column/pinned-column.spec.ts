import { Component } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { PinnedColumn } from './pinned-column';

@Component({
  imports: [PinnedColumn],
  template: `<aside tcPinnedColumn>pane</aside>`,
})
class Host {}

const SCREEN = 800;

describe('PinnedColumn', () => {
  let top = 0;
  let frames: FrameRequestCallback[] = [];

  /** Runs the animation frames the directive asked for, as the browser would on the next paint. */
  function paint(): void {
    const due = frames;
    frames = [];
    due.forEach((callback) => callback(0));
  }

  beforeEach(() => {
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(SCREEN);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ top, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: top }) as DOMRect,
    );
    frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function render(): Promise<ComponentFixture<Host>> {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  const maxHeightOf = (fixture: ComponentFixture<Host>): string =>
    (fixture.nativeElement as HTMLElement)
      .querySelector('aside')
      ?.style.getPropertyValue('--tc-pinned-max-h') ?? '';

  it('ends the column at the screen edge when it starts below a header', async () => {
    top = 81;
    const fixture = await render();

    expect(maxHeightOf(fixture)).toBe('719px');
  });

  it('takes the whole screen once the column is pinned at the top', async () => {
    top = 81;
    const fixture = await render();

    top = 0;
    window.dispatchEvent(new Event('scroll'));
    paint();
    fixture.detectChanges();

    expect(maxHeightOf(fixture)).toBe(`${SCREEN}px`);
  });

  it('never leaves a fractional pixel past the edge', async () => {
    top = 90.6;
    const fixture = await render();

    expect(maxHeightOf(fixture)).toBe('709px');
  });

  it('stops following the scroll once destroyed', async () => {
    top = 50;
    const fixture = await render();
    const remove = vi.spyOn(window, 'removeEventListener');
    fixture.destroy();

    const removed = remove.mock.calls.map(([type]) => type);
    expect(removed).toEqual(expect.arrayContaining(['scroll', 'resize']));
  });
});
