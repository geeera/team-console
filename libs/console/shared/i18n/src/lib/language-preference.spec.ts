import { DOCUMENT } from '@angular/common';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { provideConsoleI18n } from './i18n.providers';
import {
  ConsoleLanguage,
  DEVICE_LANGUAGES,
  initialLangOf,
  LANG_STORAGE_KEY,
  LANGUAGE_STORAGE,
  memoryLanguageStorage,
} from './language-preference';
import { deviceLangOf } from './languages';

describe('deviceLangOf', () => {
  it.each([
    [['ru-RU'], 'ru'],
    [['ru'], 'ru'],
    [['ru-UA', 'uk-UA'], 'ru'],
    [['en-US'], 'en'],
    [['EN-gb'], 'en'],
    [['uk-UA', 'ru-RU'], 'en'],
    [['de-DE'], 'en'],
    [['zh-Hans-CN'], 'en'],
    [[], 'en'],
  ] as const)('%j → %s', (languages, lang) => {
    expect(deviceLangOf(languages)).toBe(lang);
  });
});

describe('initialLangOf', () => {
  it('a stored choice wins over the device', () => {
    expect(initialLangOf('en', ['ru-RU'])).toBe('en');
    expect(initialLangOf('ru', ['de-DE'])).toBe('ru');
  });

  it('without a usable stored choice the device decides', () => {
    expect(initialLangOf(null, ['ru-RU'])).toBe('ru');
    expect(initialLangOf('de', ['ru-RU'])).toBe('ru');
    expect(initialLangOf('', ['fr-FR'])).toBe('en');
  });
});

describe('ConsoleLanguage with provideConsoleI18n({ start: "remembered" })', () => {
  async function launch(stored: string | null, device: readonly string[]) {
    const storage = memoryLanguageStorage(stored);
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n({ start: 'remembered' }),
        { provide: LANGUAGE_STORAGE, useValue: storage },
        { provide: DEVICE_LANGUAGES, useValue: device },
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    return {
      storage,
      transloco: TestBed.inject(TranslocoService),
      language: TestBed.inject(ConsoleLanguage),
    };
  }

  it('a first launch on a Russian device starts in Russian', async () => {
    const { transloco } = await launch(null, ['ru-RU', 'en-US']);
    expect(transloco.getActiveLang()).toBe('ru');
    expect(transloco.translate('settings.title')).toBe('Настройки');
  });

  it('a first launch on an English device starts in English', async () => {
    const { transloco } = await launch(null, ['en-US']);
    expect(transloco.getActiveLang()).toBe('en');
    expect(transloco.translate('settings.title')).toBe('Settings');
    expect(TestBed.inject(DOCUMENT).documentElement.lang).toBe('en');
  });

  it('a device in another language starts in English', async () => {
    const { transloco } = await launch(null, ['de-DE', 'ru-RU']);
    expect(transloco.getActiveLang()).toBe('en');
  });

  it('use() switches at once and stores the choice; the next launch starts in it', async () => {
    const first = await launch(null, ['ru-RU']);
    await first.language.use('en');
    TestBed.tick();

    expect(first.transloco.getActiveLang()).toBe('en');
    expect(first.language.active()).toBe('en');
    expect(first.storage.value).toBe('en');

    // The restart: a fresh injector over the same device storage, still on a Russian device.
    TestBed.resetTestingModule();
    const second = await launch(first.storage.value, ['ru-RU']);
    expect(second.transloco.getActiveLang()).toBe('en');
    expect(second.transloco.translate('settings.title')).toBe('Settings');
  });

  it('waits for a dictionary that is not loaded yet, then switches; the last choice wins (#123)', async () => {
    const { language, transloco } = await launch(null, ['ru-RU']);

    const toEnglish = language.use('en');
    expect(transloco.getActiveLang()).toBe('ru');
    await toEnglish;
    expect(transloco.getActiveLang()).toBe('en');
    expect(transloco.translate('settings.title')).toBe('Settings');

    // English is loaded now: a switch to it is immediate, and a quick back-and-forth ends where the owner left it.
    void language.use('ru');
    void language.use('en');
    const back = language.use('ru');
    expect(transloco.getActiveLang()).toBe('ru');
    await back;
    expect(transloco.getActiveLang()).toBe('ru');
  });

  it('a storage that refuses the write keeps the switch for the session and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { language, transloco } = await launch(null, ['ru-RU']);
    const broken = TestBed.inject(LANGUAGE_STORAGE);
    vi.spyOn(broken, 'write').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    await language.use('en');
    await language.use('ru');

    expect(transloco.getActiveLang()).toBe('ru');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('LANGUAGE_STORAGE on the device', () => {
  afterEach(() => localStorage.removeItem(LANG_STORAGE_KEY));

  it(`reads and writes localStorage["${LANG_STORAGE_KEY}"]`, () => {
    const storage = TestBed.inject(LANGUAGE_STORAGE);
    expect(storage.read()).toBeNull();

    storage.write('en');

    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('en');
    expect(storage.read()).toBe('en');
  });
});

describe('provideConsoleI18n() for specs and Storybook', () => {
  afterEach(() => localStorage.removeItem(LANG_STORAGE_KEY));

  it('always starts in the reference copy, whatever is stored or the runner speaks', async () => {
    localStorage.setItem(LANG_STORAGE_KEY, 'en');
    TestBed.configureTestingModule({
      providers: [provideConsoleI18n(), { provide: DEVICE_LANGUAGES, useValue: ['en-US'] }],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;

    expect(TestBed.inject(TranslocoService).getActiveLang()).toBe('ru');
  });
});
