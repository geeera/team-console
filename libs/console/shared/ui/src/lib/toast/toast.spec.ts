import { TestBed } from '@angular/core/testing';
import { TOAST_DURATION_MS, ToastOutlet, Toaster, UNDO_DURATION_MS } from './toast';

describe('Toaster and ToastOutlet', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ imports: [ToastOutlet] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps an empty polite status region until a message arrives, then shows it', () => {
    const fixture = TestBed.createComponent(ToastOutlet);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.getAttribute('role')).toBe('status');
    expect(host.getAttribute('aria-live')).toBe('polite');
    expect(host.textContent?.trim()).toBe('');

    TestBed.inject(Toaster).show('storify archived');
    fixture.detectChanges();

    expect(host.querySelector('.tc-toast')?.textContent).toBe('storify archived');
  });

  it('hides the message after the duration; a newer message restarts the timer', () => {
    const fixture = TestBed.createComponent(ToastOutlet);
    const toaster = TestBed.inject(Toaster);

    toaster.show('first');
    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    toaster.show('second');
    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent?.trim()).toBe('second');

    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(toaster.message()).toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector('.tc-toast')).toBeNull();
  });

  it('offers Undo for its 10 s, paused while hovered or focused, and ⌘Z / Ctrl+Z runs it once (#409)', () => {
    const fixture = TestBed.createComponent(ToastOutlet);
    const toaster = TestBed.inject(Toaster);
    const run = vi.fn();
    toaster.offerUndo('TC-408 → Sprint 04', { label: 'Undo', run });
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="undo"]')?.textContent).toContain('Undo');

    vi.advanceTimersByTime(UNDO_DURATION_MS - 1000);
    host.querySelector('[data-testid="undo-toast"]')?.dispatchEvent(new Event('mouseenter'));
    vi.advanceTimersByTime(60_000);
    expect(toaster.undo()).not.toBeNull();
    host.querySelector('[data-testid="undo-toast"]')?.dispatchEvent(new Event('mouseleave'));
    vi.advanceTimersByTime(999);
    expect(toaster.undo()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(toaster.undo()).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('expires the Undo offer after UNDO_DURATION_MS', () => {
    TestBed.createComponent(ToastOutlet);
    const toaster = TestBed.inject(Toaster);
    toaster.offerUndo('moved', { label: 'Undo', run: vi.fn() });
    vi.advanceTimersByTime(UNDO_DURATION_MS);
    expect(toaster.undo()).toBeNull();
  });
});
