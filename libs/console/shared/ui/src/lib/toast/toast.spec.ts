import { TestBed } from '@angular/core/testing';
import { TOAST_DURATION_MS, ToastOutlet, Toaster } from './toast';

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
});
