import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { GITHUB_CONNECTION_URL, ExternalNavigation } from '@console/entities/github-connection';
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

  async function open(url: string, { connection = CONNECTED as object } = {}): Promise<void> {
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
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
    // Focus moves only inside the document: attach the harness so focus assertions mean something.
    document.body.appendChild(harness.fixture.nativeElement);
    const navigation = harness.navigateByUrl(url);
    await settle();
    http.expectOne(GITHUB_CONNECTION_URL).flush(connection);
    await navigation;
    await settle();
  }

  beforeEach(() => {
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
      'Язык интерфейса',
    ]);
    expect(text('[data-testid="gh-connected"] h3')).toBe('Подключено как geeera');
    expect(text('[data-testid="app-built-at"]')).toBe('2026-09-29T10:00:00.000Z');
  });

  it('switches the language without a reload and remembers it on the device (#4, #125)', async () => {
    await open('/settings');
    const button = root().querySelector('[data-testid="switch-lang"]') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe('English');
    expect(button.lang).toBe('en');

    button.click();
    await settle();

    expect(TestBed.inject(TranslocoService).getActiveLang()).toBe('en');
    expect(text('h1')).toBe('Settings');
    expect(Array.from(root().querySelectorAll('h2')).map((h) => h.textContent?.trim())).toEqual([
      'GitHub',
      'Notifications',
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
