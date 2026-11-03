import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { GITHUB_CONNECTION_URL, ExternalNavigation } from '@console/entities/github-connection';
import { PROJECTS_URL, ProjectsStore } from '@console/entities/project';
import { NetworkStatus } from '@console/shared/api';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Toaster } from '@console/shared/ui';
import {
  INSTALLATION_REPOSITORIES_URL,
  PROBLEM_TYPE_PREFIX,
  type InstallationRepositoriesDto,
  type ProjectSetupDto,
} from '@shared/contracts';
import { GitHubRepositoriesBlock } from './github-repositories-block';

const CONNECTED = {
  state: 'connected',
  login: 'geeera',
  connectedAt: '2026-09-28T10:00:00.000Z',
  appName: 'team-console-dev',
};
const NOT_CONNECTED = { state: 'not-connected', ownerLogin: 'geeera', appName: 'team-console-dev' };

const LIST: InstallationRepositoriesDto = {
  repositories: [
    { fullName: 'geeera/storify', private: true, registration: { state: 'none' } },
    { fullName: 'geeera/no-yml', private: true, registration: { state: 'none' } },
    {
      fullName: 'geeera/team-console',
      private: false,
      registration: { state: 'active', slug: 'team-console' },
    },
  ],
  partial: false,
  selectionUrl: 'https://github.com/settings/installations/1001',
};

const SETUP: ProjectSetupDto = {
  appInstalled: 'ok',
  repoOwner: 'ok',
  projectYml: 'ok',
  events: 'never',
  lastEventAt: null,
  routineToken: 'missing',
  connection: { state: 'connected', login: 'geeera' },
  accessLostAt: null,
  ownerLanguage: 'ru',
  repoOwnerLogin: 'geeera',
};

const problem = (slug: string, status: number, extra: Record<string, unknown> = {}) => ({
  type: `${PROBLEM_TYPE_PREFIX}${slug}`,
  title: slug,
  status,
  ...extra,
});

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
  }
}

describe('GitHubRepositoriesBlock', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<GitHubRepositoriesBlock>;
  const online = signal(true);

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const overlay = (): HTMLElement => document.querySelector('.cdk-overlay-container') as HTMLElement;
  const row = (fullName: string): HTMLElement =>
    root().querySelector(`[data-repo="${fullName.toLowerCase()}"]`) as HTMLElement;

  async function render(connection: object = CONNECTED): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: NetworkStatus, useValue: { online } },
        { provide: ExternalNavigation, useValue: { assign: vi.fn() } },
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GitHubRepositoriesBlock);
    document.body.appendChild(fixture.nativeElement);
    await settle(fixture);
    http.expectOne(GITHUB_CONNECTION_URL).flush(connection);
    await settle(fixture);
  }

  async function listed(body: InstallationRepositoriesDto = LIST): Promise<void> {
    http.expectOne(INSTALLATION_REPOSITORIES_URL).flush(body);
    await settle(fixture);
  }

  async function tapAdd(fullName: string): Promise<void> {
    (row(fullName).querySelector('[data-testid="repo-add"]') as HTMLButtonElement).click();
    await settle(fixture);
    http
      .match((request) => request.url.endsWith('/healthz'))
      .forEach((request) => request.flush({ environment: 'dev' }));
  }

  beforeEach(() => online.set(true));

  afterEach(() => {
    fixture?.nativeElement.remove();
    overlay()?.remove();
    http.verify();
  });

  it('asks for no list while GitHub is not connected and offers Connect instead', async () => {
    await render(NOT_CONNECTED);
    http.expectNone(INSTALLATION_REPOSITORIES_URL);
    const callout = root().querySelector('[data-testid="repos-need-connect"]') as HTMLElement;
    expect(callout.textContent).toContain('Сначала подключите GitHub');
    expect(callout.textContent).toContain(
      'Тогда здесь появятся репозитории, которые видит приложение team-console-dev',
    );
    expect(callout.querySelector('button')).not.toBeNull();
  });

  it('reads the list once connected and shows its rows', async () => {
    await render();
    await listed();
    expect(row('geeera/storify').querySelector('[data-testid="repo-add"]')).not.toBeNull();
    expect(row('geeera/team-console').querySelector('a')?.getAttribute('href')).toBe(
      '/settings/projects/team-console',
    );
  });

  it('switches to Connect when the list answers 403 not connected', async () => {
    await render();
    http
      .expectOne(INSTALLATION_REPOSITORIES_URL)
      .flush(problem('github-owner-not-connected', 403, { connectUrl: '/api/v1/github/connect' }), {
        status: 403,
        statusText: 'Forbidden',
      });
    await settle(fixture);
    expect(root().querySelector('[data-testid="repos-need-connect"]')).not.toBeNull();
  });

  it('Add with project.yml missing: the sheet says nothing was saved; after Close the row says step 3 is missing', async () => {
    await render();
    await listed();
    await tapAdd('geeera/no-yml');

    const add = http.expectOne(PROJECTS_URL);
    expect(add.request.method).toBe('POST');
    expect(add.request.body).toEqual({ repo: 'geeera/no-yml' });
    const sheet = overlay().querySelector('tc-sheet-container') as HTMLElement;
    expect(sheet.querySelector('.tc-sheet__title')?.textContent?.trim()).toBe('Добавить geeera/no-yml');
    expect(row('geeera/no-yml').querySelector('[data-testid="repo-add"]')?.textContent).toContain(
      'Проверяем…',
    );

    add.flush(problem('project-yml-missing', 409, { step: 'project-yml' }), {
      status: 409,
      statusText: 'Conflict',
    });
    await settle(fixture);

    expect(sheet.querySelector('[data-testid="add-result"]')?.textContent).toContain('Проект не добавлен');
    expect(sheet.querySelector('[data-testid="add-result"]')?.textContent).toContain('Ничего не сохранено');
    expect(sheet.querySelector('.tc-sheet__foot [data-testid="check-again"]')).not.toBeNull();
    expect(TestBed.inject(ProjectsStore).active()).toEqual([]);

    (sheet.querySelector('[data-testid="sheet-close"]') as HTMLButtonElement).click();
    await settle(fixture);
    expect(row('geeera/no-yml').querySelector('[data-testid="repo-not-added"]')?.textContent).toContain(
      'Не добавлен: не хватает шага 3',
    );
    expect(row('geeera/no-yml').querySelector('[data-testid="repo-add"]')).not.toBeNull();
  });

  it('a successful Add: "Project added" with Done; the row turns "Project" and the project is in the switcher', async () => {
    await render();
    await listed();
    await tapAdd('geeera/storify');

    http.expectOne(PROJECTS_URL).flush({
      slug: 'storify',
      repo: 'geeera/storify',
      displayName: 'storify',
      routineId: null,
      addedAt: '2026-10-05T12:00:00.000Z',
      archivedAt: null,
    });
    await settle(fixture);
    http.expectOne('/api/v1/projects/storify/setup').flush(SETUP);
    await settle(fixture);

    const sheet = overlay().querySelector('tc-sheet-container') as HTMLElement;
    expect(sheet.querySelector('[data-testid="add-result"]')?.textContent).toContain('Проект добавлен');
    expect(sheet.querySelector('.tc-sheet__foot [data-testid="sheet-done"]')?.textContent?.trim()).toBe(
      'Готово',
    );
    expect(TestBed.inject(ProjectsStore).activeSlugs()).toContain('storify');
    expect(row('geeera/storify').querySelector('a')?.getAttribute('href')).toBe('/settings/projects/storify');

    (sheet.querySelector('[data-testid="sheet-done"]') as HTMLButtonElement).click();
    await settle(fixture);
    expect(overlay().querySelector('tc-sheet-container')).toBeNull();
    expect(document.activeElement).toBe(row('geeera/storify').querySelector('a'));
  });

  it('closed while checking: the result lands on the row with a toast', async () => {
    await render();
    await listed();
    await tapAdd('geeera/storify');
    (overlay().querySelector('[data-testid="sheet-close"]') as HTMLButtonElement).click();
    await settle(fixture);

    http.expectOne(PROJECTS_URL).flush({
      slug: 'storify',
      repo: 'geeera/storify',
      displayName: 'storify',
      routineId: null,
      addedAt: '2026-10-05T12:00:00.000Z',
      archivedAt: null,
    });
    await settle(fixture);
    http.expectOne('/api/v1/projects/storify/setup').flush(SETUP);
    await settle(fixture);

    expect(TestBed.inject(Toaster).message()).toBe('geeera/storify добавлен');
    expect(row('geeera/storify').querySelector('a')).not.toBeNull();
  });

  it('Retry after an error reads again, bypassing the cache, and focuses the heading', async () => {
    await render();
    http
      .expectOne(INSTALLATION_REPOSITORIES_URL)
      .flush(problem('github-unavailable', 502), { status: 502, statusText: 'Bad Gateway' });
    await settle(fixture);
    (root().querySelector('[data-testid="repos-retry"]') as HTMLButtonElement).click();
    await settle(fixture);
    http.expectOne(`${INSTALLATION_REPOSITORIES_URL}?fresh=1`).flush(LIST);
    await settle(fixture);
    expect(document.activeElement).toBe(root().querySelector('h2'));
  });

  it('Refresh keeps the rows, reads fresh and stays focused', async () => {
    await render();
    await listed();
    const refresh = root().querySelector('[data-testid="repos-refresh"]') as HTMLButtonElement;
    refresh.focus();
    refresh.click();
    await settle(fixture);
    expect(row('geeera/storify')).not.toBeNull();
    http.expectOne(`${INSTALLATION_REPOSITORIES_URL}?fresh=1`).flush(LIST);
    await settle(fixture);
    expect(document.activeElement).toBe(root().querySelector('[data-testid="repos-refresh"]'));
  });

  it('Add by name opens #24 form, without its own Connect callout or Cancel', async () => {
    await render();
    await listed();
    const toggle = root().querySelector('[data-testid="by-name-toggle"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    await settle(fixture);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(root().querySelector('[data-testid="repo-field"]')).not.toBeNull();
    expect(root().querySelector('#repos-by-name [data-testid="need-connect"]')).toBeNull();
    expect(root().querySelector('#repos-by-name')?.textContent).not.toContain('Отмена');
    http.expectOne('/api/v1/healthz').flush({ environment: 'dev' });
  });
});
