import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { ApplicationInitStatus, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { HEALTH_URL } from '@console/entities/app-info';
import { ExternalNavigation, GITHUB_CONNECTION_URL } from '@console/entities/github-connection';
import { PROJECTS_URL } from '@console/entities/project';
import { JUST_ADDED_STATE } from '@console/features/add-project';
import { NetworkStatus } from '@console/shared/api';
import { provideAppConfig } from '@console/shared/config';
import { provideConsoleI18n } from '@console/shared/i18n';
import { actionsSetupFixture } from '@console/entities/actions-setup';
import type { ProjectDispatchDto, ProjectSetupDto } from '@shared/contracts';
import { ENVIRONMENT_STATUS_URL, type EnvironmentStatusDto } from '@shared/environment';
import { settingsRoutes } from './settings.routes';

const SETUP_URL = '/api/v1/projects/fieldnote/setup';
const DISPATCH_URL = '/api/v1/projects/fieldnote/dispatch';
const ACTIONS_URL = '/api/v1/projects/fieldnote/actions-setup';
const ACCOUNTS_URL = '/api/v1/accounts';
const CONNECTED = {
  state: 'connected',
  login: 'geeera',
  connectedAt: '2026-09-28T10:00:00.000Z',
  appName: 'team-console-dev',
};
const MISSING_APP: ProjectSetupDto = {
  appInstalled: 'missing',
  repoOwner: 'not-checked',
  projectYml: 'missing',
  events: 'never',
  lastEventAt: null,
  routineToken: 'missing',
  connection: { state: 'connected', login: 'geeera' },
  accessLostAt: null,
  ownerLanguage: 'ru',
  installUrl: 'https://github.com/apps/team-console-dev/installations/new',
};
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

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
  }
}

describe('ProjectSetupPage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;
  /** The project's environment status (#750): a 403 unless a case says otherwise, as for a customer. */
  let environmentAnswer: EnvironmentStatusDto | number = 403;

  /** `GET …/dispatch` for the Actions row (#759): the account's read, so a member gets 200 too. */
  let dispatchAnswer: ProjectDispatchDto | number = 403;
  /** The caller's role in its one account (`GET /accounts`); the row is the owner's only. */
  let accountRole: 'owner' | 'member' = 'member';

  function answerDispatch(): void {
    for (const request of http.match((req) => req.url === ACCOUNTS_URL)) {
      request.flush({
        accounts: [{ id: '01M6YSNJ0000000000000000A1', slug: 'geeera', name: 'geeera', role: accountRole }],
      });
    }
    for (const request of http.match((req) => req.url === ACTIONS_URL)) {
      // The Worker's answer to a member: owner-only, before any GitHub call.
      if (accountRole === 'member') {
        request.flush(
          { type: 'https://team-console/problems/owner-only', title: 'x', status: 403 },
          { status: 403, statusText: 'Forbidden' },
        );
      }
    }
    for (const request of http.match((req) => req.url === DISPATCH_URL)) {
      if (typeof dispatchAnswer === 'number') {
        request.flush(null, { status: dispatchAnswer, statusText: 'Refused' });
      } else {
        request.flush(dispatchAnswer);
      }
    }
  }

  function answerEnvironment(): void {
    answerDispatch();
    for (const request of http.match((req) => req.url === ENVIRONMENT_STATUS_URL)) {
      expect(request.request.params.get('project')).toBe('fieldnote');
      if (typeof environmentAnswer === 'number') {
        request.flush(null, { status: environmentAnswer, statusText: 'Refused' });
      } else {
        request.flush(environmentAnswer);
      }
    }
  }

  const root = (): HTMLElement => harness.routeNativeElement as HTMLElement;
  const result = (): string =>
    root().querySelector('[data-testid="setup-result"]')?.textContent?.trim() ?? '';
  const states = (): string[] =>
    Array.from(root().querySelectorAll('[data-testid="step-state"]')).map(
      (node) => node.textContent?.trim() ?? '',
    );
  const setupRequest = (): TestRequest => http.expectOne((req) => req.url === SETUP_URL);

  async function open(state?: Record<string, unknown>): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: 'settings', children: settingsRoutes }], withComponentInputBinding()),
        provideAppConfig({ name: 'Team Console', version: '0.1.0', builtAt: 'local' }),
        { provide: NetworkStatus, useValue: { online: signal(true) } },
        { provide: ExternalNavigation, useValue: { assign: vi.fn() } },
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
    document.body.appendChild(harness.fixture.nativeElement);
    const navigation = TestBed.inject(Router).navigateByUrl(
      '/settings/projects/fieldnote',
      state ? { state } : {},
    );
    await settle();
    http.expectOne(GITHUB_CONNECTION_URL).flush(CONNECTED);
    http.expectOne(HEALTH_URL).flush({ status: 'ok', environment: 'dev', version: '0.1.0' });
    http.expectOne(PROJECTS_URL).flush([
      {
        slug: 'fieldnote',
        repo: 'geeera/fieldnote',
        displayName: 'fieldnote',
        routineId: null,
        addedAt: '2026-09-29T00:00:00.000Z',
        archivedAt: null,
      },
    ]);
    await navigation;
    await settle();
    answerEnvironment();
    await settle();
  }

  afterEach(() => {
    answerEnvironment();
    environmentAnswer = 403;
    dispatchAnswer = 403;
    accountRole = 'member';
    harness?.fixture.nativeElement.remove();
    http.verify();
  });

  describe('the GitHub Actions row (#759)', () => {
    const chip = (): string =>
      root().querySelector('[data-testid="project-actions-chip"]')?.textContent?.trim() ?? '';

    it('reads «Не включено» for a pull project and spends no readiness check', async () => {
      accountRole = 'owner';
      dispatchAnswer = { dispatch: 'pull', defaultBranch: null };
      await open();
      setupRequest().flush(READY);
      await settle();
      answerEnvironment();
      await settle();
      expect(chip()).toBe('Не включено');
      expect(root().querySelector('[data-testid="project-actions-entry"] a')?.getAttribute('href')).toBe(
        '/settings/projects/fieldnote/actions',
      );
      http.expectNone(ACTIONS_URL);
    });

    it('counts the missing steps of a switched-on project', async () => {
      accountRole = 'owner';
      dispatchAnswer = { dispatch: 'actions', defaultBranch: 'main' };
      await open();
      setupRequest().flush(READY);
      await settle();
      answerEnvironment();
      await settle();
      http
        .expectOne(ACTIONS_URL)
        .flush(actionsSetupFixture({ dispatch: 'actions', items: { secret: { status: 'missing' } } }));
      await settle();
      expect(chip()).toBe('Не готово: 1');
    });

    it('is not there for a member, whose dispatch read answers 200', async () => {
      dispatchAnswer = { dispatch: 'actions', defaultBranch: 'main' };
      await open();
      setupRequest().flush(READY);
      await settle();
      answerEnvironment();
      await settle();
      expect(root().querySelector('[data-testid="project-actions-entry"]')).toBeNull();
    });
  });

  describe('the Project environment row (#750)', () => {
    const PRODUCTION: EnvironmentStatusDto = {
      environment: 'production',
      items: [
        { id: 'project/fieldnote/ROUTINE_TOKEN_FIELDNOTE', status: 'missing', optional: false },
        { id: 'project/fieldnote/SLOT_TOKEN_FIELDNOTE_PM', status: 'missing', optional: true },
      ],
    };

    it('is there once the project’s status answered, with the #104 chip, and step 5 links to the screen', async () => {
      environmentAnswer = PRODUCTION;
      await open({ [JUST_ADDED_STATE]: true });
      setupRequest().flush(MISSING_APP);
      await settle();

      const entry = root().querySelector('[data-testid="project-env-entry"] a') as HTMLAnchorElement;
      expect(entry.getAttribute('href')).toBe('/settings/projects/fieldnote/environment');
      expect(entry.textContent).toContain('Окружение проекта');
      expect(entry.textContent).toContain('production · секреты проекта');
      // The optional token never counts.
      expect(root().querySelector('[data-testid="project-env-chip"]')?.textContent?.trim()).toBe(
        'Не задано: 1',
      );
      const link = root().querySelector('[data-step="routine"] [data-testid="step-environment-link"]');
      expect(link?.getAttribute('href')).toBe('/settings/projects/fieldnote/environment');
      expect(link?.textContent).toContain('Открыть окружение проекта');
    });

    it('says "Not checked" where this console cannot see the project’s secrets', async () => {
      environmentAnswer = { environment: 'dev', items: [] };
      await open();
      setupRequest().flush(MISSING_APP);
      await settle();
      expect(root().querySelector('[data-testid="project-env-chip"]')?.textContent?.trim()).toBe(
        'Не проверено',
      );
    });

    it('is not there for a sign-in the status refuses (403), and step 5 has no link', async () => {
      await open();
      setupRequest().flush(MISSING_APP);
      await settle();
      expect(root().querySelector('[data-testid="project-env-entry"]')).toBeNull();
      expect(root().querySelector('[data-testid="step-environment-link"]')).toBeNull();
    });
  });

  it('first shows the Worker’s cached status: steps as words, the install link, and the steps left', async () => {
    await open();
    const first = setupRequest();
    expect(first.request.params.has('fresh')).toBe(false);
    first.flush(MISSING_APP);
    await settle();

    expect(states()).toEqual(['Не хватает', 'Не проверено', 'Не проверено', 'Ждём', 'Не хватает']);
    expect(result()).toContain('Не хватает 4 шагов');
    expect(result()).toContain('Проверено в');
    expect(document.activeElement?.tagName).toBe('H1');
    expect(root().querySelector('.setup__repo')?.getAttribute('href')).toBe(
      'https://github.com/geeera/fieldnote',
    );
  });

  it('right after adding says "Project added. N steps left"', async () => {
    await open({ [JUST_ADDED_STATE]: true });
    setupRequest().flush(MISSING_APP);
    await settle();

    expect(result()).toContain('Проект добавлен. Осталось 4 шага');
  });

  it.each([
    [{ routineToken: 'missing' }, 'Проект добавлен. Остался 1 шаг'],
    [{ routineToken: 'missing', projectYml: 'missing' }, 'Проект добавлен. Осталось 2 шага'],
  ] as const)(
    'counts only the steps that need the owner, in the right plural form',
    async (missing, title) => {
      await open({ [JUST_ADDED_STATE]: true });
      setupRequest().flush({ ...READY, events: 'never', lastEventAt: null, ...missing });
      await settle();

      expect(result()).toContain(title);
    },
  );

  it('with only the first event to wait for, the project is ready and says so (#205)', async () => {
    await open({ [JUST_ADDED_STATE]: true });
    setupRequest().flush({ ...READY, events: 'never', lastEventAt: null });
    await settle();

    expect(root().querySelector('[data-testid="setup-result"] h2')?.textContent?.trim()).toBe(
      'Проект готов. Ждём первое событие от GitHub',
    );
    expect(result()).not.toContain('Остался');
    expect(states()).toEqual(['Готово', 'Готово', 'Готово', 'Ждём', 'Готово']);
    expect(root().querySelector('[data-step="events"] .step__how-toggle')).toBeNull();
    // Nothing to fix, so coming back to the app does not re-check by itself.
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    http.expectNone((req) => req.url === SETUP_URL);
  });

  it('Check again bypasses the cache (?fresh=1), then focuses the result', async () => {
    await open();
    setupRequest().flush(MISSING_APP);
    await settle();

    (root().querySelector('[data-testid="check-again"]') as HTMLButtonElement).click();
    await settle();
    const again = setupRequest();
    expect(again.request.urlWithParams).toBe(`${SETUP_URL}?fresh=1`);
    expect(states()).toEqual(Array(5).fill('Проверяем…'));
    again.flush(READY);
    await settle();

    expect(result()).toContain('fieldnote готов');
    expect(states()).toEqual(Array(5).fill('Готово'));
    expect(document.activeElement?.closest('[data-testid="setup-result"]')).not.toBeNull();
  });

  it('re-checks once, fresh, when the app comes back to the foreground with a step missing', async () => {
    await open();
    setupRequest().flush(MISSING_APP);
    await settle();

    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    const recheck = setupRequest();
    expect(recheck.request.params.get('fresh')).toBe('1');
    recheck.flush(READY);
    await settle();

    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    http.expectNone((req) => req.url === SETUP_URL);
  });

  // #514: Archive is on screen before the first status answers; its late heading focus left the confirmation.
  it('a status that answers while the archive confirmation is open leaves focus on its Cancel', async () => {
    await open();
    const first = setupRequest();
    (root().querySelector('[data-testid="archive-project"]') as HTMLButtonElement).click();
    await settle();
    const cancel = document.querySelector<HTMLElement>('[role="alertdialog"] .tc-confirm__cancel');
    expect(cancel).not.toBeNull();
    expect(document.activeElement).toBe(cancel);

    first.flush(MISSING_APP);
    await settle();
    expect(result()).toContain('Не хватает 4 шагов');
    expect(document.activeElement).toBe(cancel);

    cancel?.click();
    await settle();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('a re-check that answers while a sheet is open leaves focus in the sheet', async () => {
    await open();
    setupRequest().flush(MISSING_APP);
    await settle();
    (root().querySelector('[data-testid="check-again"]') as HTMLButtonElement).click();
    await settle();
    const again = setupRequest();
    (root().querySelector('[data-testid="archive-project"]') as HTMLButtonElement).click();
    await settle();
    const cancel = document.querySelector<HTMLElement>('[role="alertdialog"] .tc-confirm__cancel');
    expect(document.activeElement).toBe(cancel);

    again.flush(READY);
    await settle();
    expect(result()).toContain('fieldnote готов');
    expect(document.activeElement).toBe(cancel);

    cancel?.click();
    await settle();
  });

  it('an unknown slug says the project is not found', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: 'settings', children: settingsRoutes }], withComponentInputBinding()),
        { provide: NetworkStatus, useValue: { online: signal(true) } },
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
    const navigation = harness.navigateByUrl('/settings/projects/nowhere');
    await settle();
    http.expectOne(GITHUB_CONNECTION_URL).flush(CONNECTED);
    http.expectOne(HEALTH_URL).flush({ status: 'ok', environment: 'dev', version: '0.1.0' });
    http.expectOne(PROJECTS_URL).flush([]);
    await navigation;
    await settle();

    expect(root().querySelector('h1')?.textContent?.trim()).toBe('Проект не найден');
  });
});
