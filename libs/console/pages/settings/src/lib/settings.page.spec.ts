import { ApplicationInitStatus } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideAppConfig } from '@console/shared/config';
import { provideConsoleI18n, TranslocoService } from '@console/shared/i18n';
import { SettingsPage } from './settings.page';

describe('SettingsPage', () => {
  let fixture: ComponentFixture<SettingsPage>;
  let transloco: TranslocoService;

  const text = (selector: string): string =>
    (fixture.nativeElement as HTMLElement).querySelector(selector)?.textContent?.trim() ?? '';

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [
        provideConsoleI18n(),
        provideAppConfig({ name: 'Team Console', version: '0.1.0', builtAt: '2026-09-29T10:00:00.000Z' }),
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    transloco = TestBed.inject(TranslocoService);
    fixture = TestBed.createComponent(SettingsPage);
    await fixture.whenStable();
  });

  it('has one heading, the two sections and the build facts', () => {
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelectorAll('h1')).toHaveLength(1);
    expect(text('h1')).toBe('Настройки');
    expect(root.querySelectorAll('section')).toHaveLength(2);
    expect(text('[data-testid="app-built-at"]')).toBe('2026-09-29T10:00:00.000Z');
  });

  it('offers the other language on a button labelled in that language and switches without reload', async () => {
    const button = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="switch-lang"]',
    ) as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe('English');
    expect(button.lang).toBe('en');

    button.click();
    await fixture.whenStable();

    expect(transloco.getActiveLang()).toBe('en');
    expect(text('h1')).toBe('Settings');
    expect(button.textContent?.trim()).toBe('Русский');
    expect(button.lang).toBe('ru');
  });
});
