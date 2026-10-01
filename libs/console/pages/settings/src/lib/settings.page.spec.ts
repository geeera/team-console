import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { GITHUB_CONNECTION_URL, ExternalNavigation } from '@console/entities/github-connection';
import { PROJECTS_URL } from '@console/entities/project';
import { NetworkStatus } from '@console/shared/api';
import { provideAppConfig } from '@console/shared/config';
import {
  LANGUAGE_STORAGE,
  memoryLanguageStorage,
  provideConsoleI18n,
  TranslocoService,
} from '@console/shared/i18n';
import { Toaster } from '@console/shared/ui';
import type { ProjectDto, ProjectSetupDto } from '@shared/contracts';
import { signal } from '@angular/core';
import { settingsRoutes } from './settings.routes';

const project = (slug: string): ProjectDto => ({
  slug,
  repo: `geeera/${slug}`,
  displayName: slug,
  routineId: null,
  addedAt: '2026-09-29T00:00:00.000Z',
  archivedAt: null,
});

const READY: ProjectSetupDto = {
  appInstalled: 'ok',
  repoOwner: 'ok',
  projectYml: 'ok',
  events: 'seen',
  lastEventAt: '2026-10-01T09:35:00.000Z',
  routineToken: 'present',
  connection: { state: 'connected', login: 'geeera' },
  accessLostAt: null,
  ownerLanguage: 'ru',
  repoOwnerLogin: 'geeera',
};

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

  async function open(
    url: string,
    {
      projects = [project('storify'), project('fieldnote'), project('atlas')] as ProjectDto[],
      connection = CONNECTED as object,
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
    http.expectOne(PROJECTS_URL).flush(projects);
    await navigation;
    await settle();
  }

  function flushSetups(bySlug: Record<string, ProjectSetupDto | 'fail'>): void {
    for (const [slug, setup] of Object.entries(bySlug)) {
      const request = http.expectOne(`/api/v1/projects/${slug}/setup`);
      if (setup === 'fail') {
        request.flush(null, { status: 502, statusText: 'Bad Gateway' });
      } else {
        request.flush(setup);
      }
    }
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

  it('has one h1, the GitHub, Projects and Language sections, and the build facts', async () => {
    await open('/settings');
    flushSetups({ storify: READY, fieldnote: READY, atlas: READY });
    await settle();

    expect(root().querySelectorAll('h1')).toHaveLength(1);
    expect(text('h1')).toBe('Настройки');
    expect(Array.from(root().querySelectorAll('h2')).map((h) => h.textContent?.trim())).toEqual([
      'GitHub',
      'Проекты',
      'Язык интерфейса',
    ]);
    expect(text('[data-testid="gh-connected"] h3')).toBe('Подключено как geeera');
    expect(text('[data-testid="app-built-at"]')).toBe('2026-09-29T10:00:00.000Z');
  });

  it('switches the language without a reload and remembers it on the device (#4, #125)', async () => {
    await open('/settings');
    flushSetups({ storify: READY, fieldnote: READY, atlas: READY });
    const button = root().querySelector('[data-testid="switch-lang"]') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe('English');
    expect(button.lang).toBe('en');

    button.click();
    await settle();

    expect(TestBed.inject(TranslocoService).getActiveLang()).toBe('en');
    expect(text('h1')).toBe('Settings');
    expect(Array.from(root().querySelectorAll('h2')).map((h) => h.textContent?.trim())).toEqual([
      'GitHub',
      'Projects',
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

  it('shows each row’s setup state in words from the Worker’s setup status', async () => {
    await open('/settings');
    flushSetups({
      storify: READY,
      fieldnote: { ...READY, routineToken: 'missing', events: 'never', lastEventAt: null },
      atlas: 'fail',
    });
    await settle();

    const chip = (slug: string): string =>
      root().querySelector(`[data-row="${slug}"] [data-testid="setup-chip"]`)?.textContent?.trim() ?? '';
    expect(chip('storify')).toBe('Всё настроено');
    expect(chip('fieldnote')).toBe('Не хватает 2 шагов');
    expect(chip('atlas')).toBe('Не удалось проверить настройку');
  });

  describe('archive', () => {
    async function archiveRow(slug: string): Promise<void> {
      (root().querySelector(`[data-testid="archive-${slug}"]`) as HTMLButtonElement).click();
      await settle();
    }

    it('confirms with focus on Cancel; Escape cancels and nothing is sent', async () => {
      await open('/settings');
      flushSetups({ storify: READY, fieldnote: READY, atlas: READY });
      await archiveRow('fieldnote');

      const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
      expect(dialog.getAttribute('role')).toBe('alertdialog');
      expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
        'Архивировать fieldnote?',
      );
      expect(document.activeElement?.classList).toContain('tc-confirm__cancel');

      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      await settle();
      expect(overlay().querySelector('tc-sheet-container')).toBeNull();
      expect(root().querySelector('[data-row="fieldnote"]')).not.toBeNull();
    });

    it('archives, announces a status toast and moves focus to the next row, else the previous, else Add project', async () => {
      await open('/settings');
      flushSetups({ storify: READY, fieldnote: READY, atlas: READY });
      // The kit's ToastOutlet renders this as role=status (toast.spec.ts); the shell places it once.
      const toaster = TestBed.inject(Toaster);

      const confirmAndRespond = async (slug: string): Promise<void> => {
        await archiveRow(slug);
        (overlay().querySelector('.tc-confirm__ok') as HTMLButtonElement).click();
        await settle();
        const request = http.expectOne(`/api/v1/projects/${slug}/archive`);
        expect(request.request.method).toBe('POST');
        request.flush(null, { status: 204, statusText: 'No Content' });
        await settle();
      };

      await confirmAndRespond('fieldnote');
      expect(root().querySelector('[data-row="fieldnote"]')).toBeNull();
      expect(toaster.message()).toBe('fieldnote в архиве');
      expect(document.activeElement?.closest('[data-row]')?.getAttribute('data-row')).toBe('atlas');

      await confirmAndRespond('atlas');
      expect(document.activeElement?.closest('[data-row]')?.getAttribute('data-row')).toBe('storify');

      await confirmAndRespond('storify');
      expect(root().querySelector('[data-testid="no-projects"]')).not.toBeNull();
      expect(document.activeElement?.getAttribute('data-testid')).toBe('add-project');
    });

    it('a failed archive keeps the dialog open with an alert and the project listed', async () => {
      await open('/settings');
      flushSetups({ storify: READY, fieldnote: READY, atlas: READY });
      await archiveRow('storify');
      (overlay().querySelector('.tc-confirm__ok') as HTMLButtonElement).click();
      await settle();
      http
        .expectOne('/api/v1/projects/storify/archive')
        .flush(null, { status: 502, statusText: 'Bad Gateway' });
      await settle();

      expect(overlay().querySelector('[role="alert"]')?.textContent?.trim()).toBe(
        'Не удалось архивировать. Проект остался в списке.',
      );
      expect(root().querySelector('[data-row="storify"]')).not.toBeNull();
    });
  });

  it('offline: the list stays readable, Add and Archive are unavailable with an explanation', async () => {
    await open('/settings');
    flushSetups({ storify: READY, fieldnote: READY, atlas: READY });
    online.set(false);
    await settle();

    expect(text('[data-testid="offline-note"]')).toContain('Нет сети. Список на момент');
    expect(root().querySelector('[data-testid="add-project"]')?.getAttribute('aria-disabled')).toBe('true');
    const archive = root().querySelector('[data-testid="archive-storify"]') as HTMLButtonElement;
    expect(archive.getAttribute('aria-disabled')).toBe('true');
    archive.click();
    await settle();
    expect(overlay()?.querySelector('tc-sheet-container') ?? null).toBeNull();
    expect(root().querySelector('[data-testid="gh-connected"] button')?.getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('offline: Add project is really disabled — the tap does not navigate (#124 item 5)', async () => {
    await open('/settings');
    flushSetups({ storify: READY, fieldnote: READY, atlas: READY });
    online.set(false);
    await settle();

    const addProject = root().querySelector('[data-testid="add-project"]') as HTMLAnchorElement;
    expect(addProject.getAttribute('aria-disabled')).toBe('true');
    expect(addProject.getAttribute('role')).toBe('button');
    expect(addProject.hasAttribute('href')).toBe(false);

    addProject.click();
    await settle();
    expect(TestBed.inject(Router).url).toBe('/settings');
  });

  it('the callback’s wrong-account outcome names both logins and drops the query', async () => {
    await open('/settings?github=wrong-account&login=octocat', {
      projects: [],
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
      projects: [],
      connection: { state: 'not-connected', ownerLogin: 'geeera', appName: 'team-console-dev' },
    });
    await settle();

    expect(text('[data-testid="gh-error"]')).toContain('GitHub не подтвердил подключение');
  });
});
