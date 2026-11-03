import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Tooltip } from './tooltip';

@Component({
  imports: [Tooltip],
  template: `
    <a href="#row" data-testid="row">
      Row title
      <span class="mark" data-testid="anchor">*<tc-tooltip>Tier: heavy</tc-tooltip></span>
    </a>
  `,
})
class Host {}

describe('Tooltip', () => {
  const realMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  async function render(canHover: boolean) {
    window.matchMedia = ((query: string) =>
      ({
        matches: query === '(hover: hover)' && canHover,
        media: query,
      }) as MediaQueryList) as typeof window.matchMedia;
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const tooltip = root.querySelector('tc-tooltip') as HTMLElement;
    return {
      root,
      tooltip,
      anchor: root.querySelector('[data-testid="anchor"]') as HTMLElement,
      row: root.querySelector('[data-testid="row"]') as HTMLAnchorElement,
      shown: async () => {
        await fixture.whenStable();
        return tooltip.classList.contains('tc-tooltip--shown');
      },
    };
  }

  function pointer(target: HTMLElement, type: 'pointerenter' | 'pointerleave', pointerType = 'mouse'): void {
    const event = new Event(type) as Event & { pointerType: string };
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    target.dispatchEvent(event);
  }

  function escape(): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  it('is hidden from assistive tech and the link keeps its own name', async () => {
    const { tooltip, shown } = await render(true);

    expect(tooltip.getAttribute('aria-hidden')).toBe('true');
    expect(await shown()).toBe(false);
  });

  it('shows while its anchor is hovered with a mouse, and hides when the pointer leaves', async () => {
    const { anchor, shown } = await render(true);

    pointer(anchor, 'pointerenter');
    expect(await shown()).toBe(true);
    pointer(anchor, 'pointerleave');
    expect(await shown()).toBe(false);
  });

  it('does not show for a touch, or on a device without hover', async () => {
    const touch = await render(true);
    pointer(touch.anchor, 'pointerenter', 'touch');
    expect(await touch.shown()).toBe(false);

    TestBed.resetTestingModule();
    const noHover = await render(false);
    pointer(noHover.anchor, 'pointerenter');
    expect(await noHover.shown()).toBe(false);
  });

  it('shows while the row has keyboard focus', async () => {
    const { row, shown } = await render(false);
    const matches = vi.spyOn(row, 'matches').mockImplementation((selector) => selector === ':focus-visible');

    row.dispatchEvent(new FocusEvent('focusin'));
    expect(await shown()).toBe(true);
    row.dispatchEvent(new FocusEvent('focusout'));
    expect(await shown()).toBe(false);
    matches.mockRestore();
  });

  it('does not show for a pointer focus (no focus ring)', async () => {
    const { row, shown } = await render(false);
    vi.spyOn(row, 'matches').mockReturnValue(false);

    row.dispatchEvent(new FocusEvent('focusin'));
    expect(await shown()).toBe(false);
  });

  it('hides on Esc until the next hover', async () => {
    const { anchor, shown } = await render(true);

    pointer(anchor, 'pointerenter');
    expect(await shown()).toBe(true);
    escape();
    expect(await shown()).toBe(false);
    pointer(anchor, 'pointerleave');
    pointer(anchor, 'pointerenter');
    expect(await shown()).toBe(true);
  });

  it('sits beside its anchor with placement "start"', async () => {
    TestBed.overrideComponent(Host, {
      set: {
        template: `<span><tc-tooltip placement="start">Tip</tc-tooltip></span>`,
      },
    });
    const { tooltip } = await render(true);

    expect(tooltip.classList.contains('tc-tooltip--start')).toBe(true);
  });
});
