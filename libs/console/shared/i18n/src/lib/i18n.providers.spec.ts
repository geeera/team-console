import { DOCUMENT } from '@angular/common';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { provideConsoleI18n } from './i18n.providers';
import en from './locales/en.json';
import ru from './locales/ru.json';
import { StaticTranslationLoader } from './static-translation-loader';

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('provideConsoleI18n', () => {
  let transloco: TranslocoService;

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [provideConsoleI18n()] });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    transloco = TestBed.inject(TranslocoService);
  });

  it('starts in Russian, the reference copy', () => {
    expect(transloco.getActiveLang()).toBe('ru');
    expect(transloco.translate('shell.needsYou')).toBe('Ждут вас');
  });

  it('switches to English at runtime', async () => {
    transloco.setActiveLang('en');
    await firstValueFrom(transloco.load('en'));

    expect(transloco.translate('shell.needsYou')).toBe('Needs you');
  });

  it('mirrors the active language on <html lang>', async () => {
    const document = TestBed.inject(DOCUMENT);
    expect(document.documentElement.lang).toBe('ru');

    transloco.setActiveLang('en');
    await firstValueFrom(transloco.load('en'));

    expect(document.documentElement.lang).toBe('en');
  });
});

describe('StaticTranslationLoader', () => {
  it('rejects a language the console does not ship', async () => {
    const loader = new StaticTranslationLoader();

    await expect(firstValueFrom(loader.getTranslation('de'))).rejects.toThrowError(
      'Unsupported language "de"',
    );
  });
});

describe('locale files', () => {
  it('keep the same keys in ru and en so no string silently falls back', () => {
    expect(flattenKeys(en).sort()).toEqual(flattenKeys(ru).sort());
  });
});
