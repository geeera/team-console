import { ApplicationInitStatus, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { AppUpdates } from './app-updates';
import { UpdateBanner } from './update-banner';

describe('UpdateBanner', () => {
  const isReady = signal(false);
  const activate = vi.fn(async () => undefined);

  beforeEach(async () => {
    isReady.set(false);
    activate.mockClear();
    await TestBed.configureTestingModule({
      imports: [UpdateBanner],
      providers: [
        provideConsoleI18n(),
        { provide: AppUpdates, useValue: { ready: computed(() => isReady()), activate } },
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
  });

  it('is an empty live region until a version is ready, then offers «Обновить»', async () => {
    const fixture = TestBed.createComponent(UpdateBanner);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.getAttribute('role')).toBe('status');
    expect(host.querySelector('[data-testid="update-banner"]')).toBeNull();

    isReady.set(true);
    await fixture.whenStable();

    expect(host.querySelector('[tc-banner-text]')?.textContent?.trim()).toBe('Доступна новая версия');
    const button = host.querySelector('[data-testid="update-apply"]') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe('Обновить');

    button.click();
    expect(activate).toHaveBeenCalledTimes(1);
  });
});
