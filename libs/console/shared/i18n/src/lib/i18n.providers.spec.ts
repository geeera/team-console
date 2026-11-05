import { DOCUMENT } from '@angular/common';
import { ApplicationInitStatus, ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { firstValueFrom, throwError } from 'rxjs';
import { provideConsoleAppI18n, provideConsoleI18n } from './i18n.providers';
import { DEVICE_LANGUAGES, LANGUAGE_STORAGE, memoryLanguageStorage } from './language-preference';
import { DEFAULT_LANG } from './languages';
import { LazyTranslationLoader } from './lazy-translation-loader';
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
    await firstValueFrom(transloco.load('en'));
    transloco.setActiveLang('en');

    expect(transloco.translate('shell.needsYou')).toBe('Needs you');
  });

  it('mirrors the active language on <html lang>', async () => {
    const document = TestBed.inject(DOCUMENT);
    expect(document.documentElement.lang).toBe('ru');

    await firstValueFrom(transloco.load('en'));
    transloco.setActiveLang('en');

    expect(document.documentElement.lang).toBe('en');
  });
});

describe('StaticTranslationLoader', () => {
  it('hands out the inline Russian reference copy synchronously, so the first paint needs no fetch (#123)', () => {
    let received: unknown = null;
    new StaticTranslationLoader().getTranslation('ru').subscribe((translation) => (received = translation));

    expect(received).toBe(ru);
  });

  it('loads English from its own chunk', async () => {
    const translation = await firstValueFrom(new StaticTranslationLoader().getTranslation('en'));

    expect(translation).toEqual(en);
  });

  it('rejects a language the console does not ship', async () => {
    const loader = new StaticTranslationLoader();

    await expect(firstValueFrom(loader.getTranslation('de'))).rejects.toThrowError(
      'Unsupported language "de"',
    );
  });
});

describe('LazyTranslationLoader (the app, #433)', () => {
  it('loads Russian from its own chunk', async () => {
    expect(await firstValueFrom(new LazyTranslationLoader().getTranslation('ru'))).toEqual(ru);
  });

  it('loads English from its own chunk', async () => {
    expect(await firstValueFrom(new LazyTranslationLoader().getTranslation('en'))).toEqual(en);
  });

  it('rejects a language the console does not ship', async () => {
    await expect(firstValueFrom(new LazyTranslationLoader().getTranslation('de'))).rejects.toThrowError(
      'Unsupported language "de"',
    );
  });
});

describe('provideConsoleAppI18n', () => {
  function configure(): void {
    TestBed.configureTestingModule({
      providers: [
        provideConsoleAppI18n(),
        { provide: LANGUAGE_STORAGE, useValue: memoryLanguageStorage('en') },
        { provide: DEVICE_LANGUAGES, useValue: ['ru-RU'] },
      ],
    });
  }

  it('renders the first screen in the stored language once its lazy dictionary is in', async () => {
    configure();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const transloco = TestBed.inject(TranslocoService);

    expect(transloco.getActiveLang()).toBe('en');
    expect(transloco.translate('shell.needsYou')).toBe('Needs you');
  });

  it('still starts, and reports it, when no dictionary can load at all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(LazyTranslationLoader.prototype, 'getTranslation').mockImplementation(() =>
      throwError(() => new Error('offline')),
    );
    const handleError = vi.fn();
    TestBed.configureTestingModule({ providers: [{ provide: ErrorHandler, useValue: { handleError } }] });
    configure();

    await expect(TestBed.inject(ApplicationInitStatus).donePromise).resolves.toBeUndefined();
    // Transloco's own fallback (`fallbackLang`) wraps the loader's rejection into its `TranslationLoadError`
    // before it reaches `startIn`'s own catchError — that wrapper, not a bare `Error`, is the fallback error.
    expect(handleError).toHaveBeenCalledTimes(1);
    expect(handleError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'TranslationLoadError', lang: DEFAULT_LANG }),
    );
    vi.restoreAllMocks();
  });
});

describe('locale files', () => {
  it('keep the same keys in ru and en so no string silently falls back', () => {
    expect(flattenKeys(en).sort()).toEqual(flattenKeys(ru).sort());
  });
});
