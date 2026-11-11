import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { HEALTH_URL } from '@console/entities/app-info';
import {
  ENVIRONMENT_COPY_LOADER,
  loadEnvironmentCopyChunks,
  type EnvironmentCopyChunks,
} from '@console/entities/environment';
import { GITHUB_CONNECTION_URL, ExternalNavigation } from '@console/entities/github-connection';
import { ENVIRONMENT_STATUS_URL, type EnvironmentStatusDto } from '@shared/environment';
import { NetworkStatus } from '@console/shared/api';
import { provideAppConfig } from '@console/shared/config';
import {
  LANGUAGE_STORAGE,
  memoryLanguageStorage,
  provideConsoleI18n,
  TranslocoService,
} from '@console/shared/i18n';
import { signal } from '@angular/core';
import { settingsRoutes } from './settings.routes';

const CONNECTED = {
  state: 'connected',
  login: 'geeera',
  connectedAt: '2026-09-28T10:00:00.000Z',
  appName: 'team-console-dev',
};

/** Two api secrets missing on dev (#104); the Settings row counts them. */
const DEV_STATUS: EnvironmentStatusDto = {
  environment: 'dev',
  items: [
    { id: 'api/OWNER_EMAIL', status: 'missing', optional: false },
    { id: 'api/VAPID_PRIVATE_KEY', status: 'missing', optional: false },
    { id: 'api/TOKEN_ENCRYPTION_KEY', status: 'set', optional: false },
  ],
};

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
  }
}

describe('SettingsPage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;
  const online = signal(true);
  let languageStorage = memoryLanguageStorage();

  const root = (): HTMLElement => harness.routeNativeElement as HTMLElement;
  const text = (selector: string): string => root().querySelector(selector)?.textContent?.trim() ?? '';
  const overlay = (): HTMLElement => document.querySelector('.cdk-overlay-container') as HTMLElement;

  async function open(
    url: string,
    {
      connection = CONNECTED as object,
      environment = DEV_STATUS as object | number,
      copyLoader = undefined as (() => Promise<EnvironmentCopyChunks>) | undefined,
    } = {},
  ): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: 'settings', children: settingsRoutes }], withComponentInputBinding()),
        provideAppConfig({ name: 'Team Console', version: '0.1.0', builtAt: '2026-09-29T10:00:00.000Z' }),
        { provide: NetworkStatus, useValue: { online } },
        { provide: ExternalNavigation, useValue: { assign: vi.fn() } },
        { provide: LANGUAGE_STORAGE, useValue: languageStorage },
        { provide: ErrorHandler, useValue: { handleError } },
        ...(copyLoader === undefined ? [] : [{ provide: ENVIRONMENT_COPY_LOADER, useValue: copyLoader }]),
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
    // Focus moves only inside the document: attach the harness so focus assertions mean something.
    document.body.appendChild(harness.fixture.nativeElement);
    // The route waits for the lazy env.* copy (an async guard), so wait for the navigation, not a number of ticks.
    await harness.navigateByUrl(url);
    await settle();
    http.expectOne(GITHUB_CONNECTION_URL).flush(connection);
    await settle();
    http.expectOne(HEALTH_URL).flush({ environment: 'dev' });
    const status = http.expectOne(ENVIRONMENT_STATUS_URL);
    if (typeof environment === 'number') {
      status.flush(null, { status: environment, statusText: 'Refused' });
    } else {
      status.flush(environment);
    }
    await settle();
  }

  const handleError = vi.fn();

  beforeEach(() => {
    handleError.mockClear();
    online.set(true);
    languageStorage = memoryLanguageStorage();
  });

  afterEach(() => {
    harness?.fixture.nativeElement.remove();
    overlay()?.remove();
    http.verify();
  });

  it('has one h1, the GitHub, Notifications and Language sections, and the build facts', async () => {
    await open('/settings');

    expect(root().querySelectorAll('h1')).toHaveLength(1);
    expect(text('h1')).toBe('Настройки');
    expect(Array.from(root().querySelectorAll('h2')).map((h) => h.textContent?.trim())).toEqual([
      'GitHub',
      'Уведомления',
      'Окружение',
      'Раннеры',
      'Язык интерфейса',
    ]);
    expect(root().querySelector('[data-testid="runners-entry"] a')?.getAttribute('href')).toBe('/settings/runners');
    expect(text('[data-testid="gh-connected"] h3')).toBe('Подключено как geeera');
    expect(text('[data-testid="app-built-at"]')).toBe('2026-09-29T10:00:00.000Z');
  });

  it('switches the language without a reload and remembers it on the device (#4, #125)', async () => {
    await open('/settings');
    const button = root().querySelector('[data-testid="switch-lang"]') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe('English');
    expect(button.lang).toBe('en');

    button.click();
    // English is a lazy chunk (#123): the switch applies once it has loaded.
    await vi.waitFor(() => expect(TestBed.inject(TranslocoService).getActiveLang()).toBe('en'));
    await settle();
    expect(text('h1')).toBe('Settings');
    expect(Array.from(root().querySelectorAll('h2')).map((h) => h.textContent?.trim())).toEqual([
      'GitHub',
      'Notifications',
      'Environment',
      'Runners',
      'Interface language',
    ]);
    expect(languageStorage.value).toBe('en');

    // And back: the button now offers Russian, in Russian.
    expect(button.textContent?.trim()).toBe('Русский');
    expect(button.lang).toBe('ru');
    button.click();
    await settle();
    expect(text('h1')).toBe('Настройки');
    expect(languageStorage.value).toBe('ru');
  });

  it("has an Environment setup row that opens this console's environment with the missing count (#104)", async () => {
    await open('/settings');

    const row = root().querySelector('[data-testid="env-entry"] a') as HTMLAnchorElement;
    expect(row.getAttribute('href')).toBe('/settings/environment/dev');
    expect(row.textContent).toContain('Настройка окружения');
    expect(row.textContent).toContain('dev · секреты и переменные');
    expect(text('[data-testid="env-entry-chip"]')).toBe('Не задано: 2');
  });

  it('says "All set" when nothing is missing', async () => {
    await open('/settings', {
      environment: { environment: 'dev', items: [{ id: 'api/OWNER_EMAIL', status: 'set', optional: false }] },
    });
    expect(text('[data-testid="env-entry-chip"]')).toBe('Всё задано');
  });

  it('says "Not checked" when the status call is refused (403)', async () => {
    await open('/settings', { environment: 403 });
    expect(text('[data-testid="env-entry-chip"]')).toBe('Не проверено');
  });

  it('waits for a slow env.* copy chunk before Settings renders (the guard is awaited, not timed)', async () => {
    await open('/settings', {
      copyLoader: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return loadEnvironmentCopyChunks();
      },
    });
    expect(text('[data-testid="env-entry-chip"]')).toBe('Не задано: 2');
  });

  it('shows a readable error with Try again, never raw env.* keys, when the copy chunk cannot load', async () => {
    const chunkError = new Error('Failed to fetch dynamically imported module');
    let fail = true;
    await open('/settings', {
      copyLoader: async () => {
        if (fail) {
          throw chunkError;
        }
        return loadEnvironmentCopyChunks();
      },
    });

    expect(handleError).toHaveBeenCalledWith(chunkError);
    const failed = root().querySelector('[data-testid="env-copy-failed"]') as HTMLElement;
    expect(failed.getAttribute('role')).toBe('alert');
    expect(failed.textContent).toContain('Настройка окружения не открылась');
    expect(root().textContent).not.toMatch(/env\.[a-z]/);
    // The rest of Settings is untouched.
    expect(text('h1')).toBe('Настройки');

    fail = false;
    (failed.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(root().querySelector('[data-testid="env-copy-failed"]')).toBeNull();
    expect(text('[data-testid="env-entry-chip"]')).toBe('Не задано: 2');
  });

  it('lists no projects and offers no Add project: Settings holds settings only (#194)', async () => {
    await open('/settings');

    expect(root().querySelector('[data-testid="project-list"]')).toBeNull();
    expect(root().querySelector('[data-testid="add-project"]')).toBeNull();
    expect(root().textContent).not.toContain('Добавить проект');
  });

  it('the callback’s wrong-account outcome names both logins and drops the query', async () => {
    await open('/settings?github=wrong-account&login=octocat', {
      connection: { state: 'not-connected', ownerLogin: 'geeera', appName: 'team-console-dev' },
    });
    await settle();

    const error = root().querySelector('[data-testid="gh-error"]') as HTMLElement;
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain('На GitHub был выбран аккаунт octocat');
    expect(error.textContent).toContain('аккаунту владельца, geeera');
    expect(TestBed.inject(Router).url).toBe('/settings');
  });

  it('the callback’s generic failed outcome has its own copy (#92)', async () => {
    await open('/settings?github=failed', {
      connection: { state: 'not-connected', ownerLogin: 'geeera', appName: 'team-console-dev' },
    });
    await settle();

    expect(text('[data-testid="gh-error"]')).toContain('GitHub не подтвердил подключение');
  });
});
