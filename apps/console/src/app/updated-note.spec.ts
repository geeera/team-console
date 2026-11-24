import { ApplicationInitStatus, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { AppUpdates } from './app-updates';
import { UPDATED_NOTE_MS, UpdatedNote } from './updated-note';

describe('UpdatedNote', () => {
  const updatedTo = signal<string | null>(null);
  const dismissUpdated = vi.fn(() => updatedTo.set(null));

  beforeEach(async () => {
    vi.useFakeTimers();
    updatedTo.set(null);
    dismissUpdated.mockClear();
    await TestBed.configureTestingModule({
      imports: [UpdatedNote],
      providers: [
        provideConsoleI18n(),
        { provide: AppUpdates, useValue: { justUpdatedTo: updatedTo.asReadonly(), dismissUpdated } },
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
  });

  afterEach(() => vi.useRealTimers());

  it('is an empty live region until the app has just updated', async () => {
    const fixture = TestBed.createComponent(UpdatedNote);
    TestBed.tick();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.getAttribute('role')).toBe('status');
    expect(host.querySelector('[data-testid="updated-note"]')).toBeNull();
  });

  it('says which version it updated to, leaves after 3 s and is gone once the exit has played', async () => {
    const fixture = TestBed.createComponent(UpdatedNote);
    updatedTo.set('1.2.0');
    TestBed.tick();
    const host = fixture.nativeElement as HTMLElement;
    const note = host.querySelector('[data-testid="updated-note"]') as HTMLElement;
    expect(note.textContent?.trim()).toBe('Обновлено до v1.2.0');
    expect(host.querySelector('.tc-paper-note--leaving')).toBeNull();

    await vi.advanceTimersByTimeAsync(UPDATED_NOTE_MS - 1);
    expect(host.querySelector('.tc-paper-note--leaving')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    TestBed.tick();
    const sheet = host.querySelector('.tc-paper-note--leaving') as HTMLElement;
    expect(sheet).not.toBeNull();
    expect(dismissUpdated).not.toHaveBeenCalled();

    sheet.dispatchEvent(new Event('animationend'));
    expect(dismissUpdated).toHaveBeenCalledTimes(1);
  });
});
