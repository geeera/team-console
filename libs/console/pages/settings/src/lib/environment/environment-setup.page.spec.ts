import { LiveAnnouncer } from '@angular/cdk/a11y';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { HEALTH_URL } from '@console/entities/app-info';
import { PROJECTS_URL } from '@console/entities/project';
import { NetworkStatus } from '@console/shared/api';
import { provideConsoleI18n } from '@console/shared/i18n';
import { ENVIRONMENT_STATUS_URL, environmentRowsOf, type EnvironmentStatusDto } from '@shared/environment';
import { settingsRoutes } from '../settings.routes';

const PROJECT = {
  slug: 'storify',
  repo: 'geeera/storify',
  displayName: 'Storify',
  routineId: null,
  addedAt: '2026-09-28T10:00:00.000Z',
  archivedAt: null,
};

/** Every row production's Worker can see, set but the given ids. */
function productionStatus(missing: readonly string[]): EnvironmentStatusDto {
  return {
    environment: 'production',
    items: environmentRowsOf('production', ['storify'])
      .filter((row) => row.binding !== null)
      .map((row) => ({ id: row.id, status: missing.includes(row.id) ? 'missing' : 'set' })),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
  }
}

describe('EnvironmentSetupPage (#104)', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;
  const online = signal(true);
  const announce = vi.fn(async () => undefined);

  const root = (): HTMLElement => harness.routeNativeElement as HTMLElement;
  const all = (selector: string): HTMLElement[] => Array.from(root().querySelectorAll<HTMLElement>(selector));
  const text = (selector: string): string => root().querySelector(selector)?.textContent?.trim() ?? '';
  const row = (id: string): HTMLElement | null =>
    root()
      .querySelector<HTMLElement>(`[data-row="${id}"]`)
      ?.closest<HTMLElement>('[data-testid="env-row"]') ?? null;

  interface Answers {
    readonly status?: EnvironmentStatusDto | number;
    readonly projects?: readonly object[] | number;
  }

  async function open(url: string, answers: Answers = {}): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: 'settings', children: settingsRoutes }], withComponentInputBinding()),
        { provide: NetworkStatus, useValue: { online } },
        { provide: LiveAnnouncer, useValue: { announce } },
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
    document.body.appendChild(harness.fixture.nativeElement);
    const navigation = harness.navigateByUrl(url);
    await settle();
    // The unknown-env guard asks the Worker which environment this is before the page opens.
    for (const request of http.match(HEALTH_URL)) {
      request.flush({ environment: 'production' });
    }
    await navigation;
    await settle();
    for (const request of http.match(HEALTH_URL)) {
      request.flush({ environment: 'production' });
    }
    const projects = answers.projects ?? [PROJECT];
    const projectsRequest = http.expectOne(PROJECTS_URL);
    if (typeof projects === 'number') {
      projectsRequest.flush(null, { status: projects, statusText: 'Failed' });
    } else {
      projectsRequest.flush(projects);
    }
    const status =
      answers.status ?? productionStatus(['api/VAPID_PRIVATE_KEY', 'project/storify/ROUTINE_TOKEN_STORIFY']);
    const statusRequest = http.expectOne(ENVIRONMENT_STATUS_URL);
    if (typeof status === 'number') {
      statusRequest.flush(null, { status, statusText: 'Refused' });
    } else {
      statusRequest.flush(status);
    }
    await settle();
  }

  beforeEach(() => {
    online.set(true);
    announce.mockClear();
  });

  afterEach(() => {
    harness?.fixture.nativeElement.remove();
    http.verify();
  });

  it('counts what is missing and gives the one fix command, with Copy', async () => {
    await open('/settings/environment/production');

    expect(text('h1')).toBe('Настройка окружения');
    expect(document.activeElement?.textContent?.trim()).toBe('Настройка окружения');
    expect(text('[data-testid="env-summary"] h2')).toBe('В production не заданы 2 настройки');
    const codes = all('[data-testid="env-summary"] code').map((code) => code.textContent);
    expect(codes).toEqual(['setup --env production', 'setup --env production --check']);
    expect(text('[data-testid="env-summary"]')).toContain('Проверено в');
  });

  it("marks this console's tab and keeps the four tabs in a tab list", async () => {
    await open('/settings/environment/production');

    const tabs = all('[role="tab"]');
    expect(tabs.map((tab) => tab.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'dev',
      'stage',
      'production эта консоль',
      'local',
    ]);
    expect(tabs[2]?.getAttribute('aria-selected')).toBe('true');
  });

  it('lists missing rows first, each with its status in words and a one-line fix', async () => {
    await open('/settings/environment/production');

    const api = root().querySelector('[data-group="api"]') as HTMLElement;
    const first = api.querySelector('[data-row]') as HTMLAnchorElement;
    expect(first.dataset['row']).toBe('api/VAPID_PRIVATE_KEY');
    expect(first.getAttribute('aria-label')).toBe('VAPID_PRIVATE_KEY, Не задано');
    expect(first.getAttribute('href')).toBe('/settings/environment/production/api/VAPID_PRIVATE_KEY');
    const missing = row('api/VAPID_PRIVATE_KEY') as HTMLElement;
    expect(missing.querySelector('[data-testid="env-fix"] code')?.textContent).toBe('setup --env production');
    expect(missing.querySelector('[data-testid="env-fix"] button')?.getAttribute('aria-label')).toBe(
      'Копировать команду для VAPID_PRIVATE_KEY',
    );
    expect(row('api/OWNER_EMAIL')?.querySelector('[data-testid="env-status"]')?.textContent?.trim()).toBe(
      'Задано',
    );
    expect(row('api/OWNER_EMAIL')?.querySelector('[data-testid="env-fix"]')).toBeNull();
    expect(
      row('hooks/WEBHOOK_SECRET')?.querySelector('[data-testid="env-status"]')?.textContent?.trim(),
    ).toBe('Отсюда не видно');
  });

  it('opens a project block with a missing token and names the real slug', async () => {
    await open('/settings/environment/production');

    const block = root().querySelector('[data-testid="env-project"]') as HTMLElement;
    const toggle = block.querySelector('button') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('storify');
    expect(toggle.textContent).toContain('задано 6 из 7');
    expect(row('project/storify/ROUTINE_TOKEN_STORIFY')).not.toBeNull();
  });

  it('shows another environment as not visible here, with the check command', async () => {
    await open('/settings/environment/stage');

    expect(text('[data-testid="env-summary"]')).toContain('Это консоль production. Что задано в stage');
    expect(text('[data-testid="env-summary"] code')).toBe('setup --env stage --check');
    const statuses = all('[data-testid="env-status"]').map((status) => status.textContent?.trim());
    expect(statuses.length).toBeGreaterThan(0);
    expect(new Set(statuses)).toEqual(new Set(['Отсюда не видно']));
    expect(root().querySelector('[data-testid="env-fix"]')).toBeNull();
  });

  it('shows nothing of the list to a session that is not the owner (403)', async () => {
    await open('/settings/environment/production', { status: 403 });

    expect(root().querySelector('[data-testid="env-forbidden"]')?.getAttribute('role')).toBe('alert');
    expect(text('[data-testid="env-forbidden"]')).toContain('Состояние окружения видит только владелец');
    expect(root().querySelector('[role="tablist"]')).toBeNull();
    expect(root().querySelector('[data-row]')).toBeNull();
  });

  it('keeps the guides open when the check fails, without a status on any row it could check', async () => {
    await open('/settings/environment/production', { status: 503 });

    expect(root().querySelector('[data-testid="env-error"]')?.getAttribute('role')).toBe('alert');
    expect(text('[data-testid="env-error"]')).toContain('Не удалось проверить окружение');
    expect(row('api/OWNER_EMAIL')?.querySelector('[data-testid="env-status"]')).toBeNull();
    expect(root().querySelector('[data-row="api/OWNER_EMAIL"]')?.getAttribute('href')).toBe(
      '/settings/environment/production/api/OWNER_EMAIL',
    );
  });

  it('says so inside Projects only when the projects cannot load', async () => {
    const withoutProjects = productionStatus([]).items.filter((item) => !item.id.startsWith('project/'));
    await open('/settings/environment/production', {
      projects: 500,
      status: { environment: 'production', items: withoutProjects },
    });

    const projects = root().querySelector('[data-group="projects"]') as HTMLElement;
    expect(projects.querySelector('[role="alert"]')?.textContent).toContain('Не удалось загрузить проекты.');
    expect(root().querySelector('[data-group="api"] [data-row]')).not.toBeNull();
    expect(text('[data-testid="env-summary"] h2')).toBe('В production задано всё, что видно отсюда');

    (projects.querySelector('button') as HTMLButtonElement).click();
    await settle();
    http.expectOne(PROJECTS_URL).flush([PROJECT]);
    await settle();
    expect(row('project/storify/ROUTINE_TOKEN_STORIFY')).not.toBeNull();
  });

  it('Check again re-reads the status and announces the result', async () => {
    await open('/settings/environment/production');

    (root().querySelector('[data-testid="env-recheck"]') as HTMLButtonElement).click();
    await settle();
    http.expectOne(ENVIRONMENT_STATUS_URL).flush(productionStatus([]));
    await settle();

    expect(text('[data-testid="env-summary"] h2')).toBe('В production задано всё, что видно отсюда');
    expect(announce).toHaveBeenCalledWith('В production задано всё, что видно отсюда', 'polite');
  });

  it('opens a guide from the manifest, with the command that fits a missing item', async () => {
    await open('/settings/environment/production/api/VAPID_PRIVATE_KEY');

    const guide = root().querySelector('[data-testid="env-guide"]') as HTMLElement;
    expect(guide.querySelector('h1')?.textContent?.trim()).toBe('VAPID_PRIVATE_KEY');
    expect(document.activeElement).toBe(guide.querySelector('h1'));
    expect(guide.textContent).toContain('Значение консоль не показывает и не хранит');
    expect(guide.textContent).toContain('Приватный VAPID-ключ');
    expect(text('[data-testid="env-guide-status"]')).toBe('Не задано');
    expect(guide.querySelector('[data-testid="env-guide-how"] code')?.textContent).toBe(
      'setup --env production',
    );
    // The manifest has no permissions for it: the section is left out, never shown empty.
    expect(guide.querySelector('[data-section="scopes"]')).toBeNull();
    expect(guide.querySelector('[data-section="rotation"]')).not.toBeNull();
    expect(root().querySelector('[data-row="api/VAPID_PRIVATE_KEY"]')?.getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('gives a set item the rotate command and an unseen one the check command', async () => {
    await open('/settings/environment/production/api/OWNER_EMAIL');
    expect(text('[data-testid="env-guide-how"] code')).toBe('setup --env production --rotate');

    await harness.navigateByUrl('/settings/environment/production/github-secrets/CLOUDFLARE_API_TOKEN');
    await settle();
    const codes = all('[data-testid="env-guide-how"] code').map((code) => code.textContent);
    expect(codes).toEqual(['setup --env production --check', 'setup --env production']);
    expect(text('[data-testid="env-guide"]')).toContain('Workers Scripts: Edit');
  });

  it('closes the guide on Escape and returns focus to the row that opened it', async () => {
    await open('/settings/environment/production/api/VAPID_PRIVATE_KEY');

    root()
      .querySelector('[data-testid="env-guide"] h1')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();

    expect(TestBed.inject(Router).url).toBe('/settings/environment/production');
    expect(document.activeElement).toBe(root().querySelector('[data-row="api/VAPID_PRIVATE_KEY"]'));
  });

  it('says there is no such setting for an unknown name', async () => {
    await open('/settings/environment/production/api/NOT_A_SETTING');

    expect(text('[data-testid="env-guide"] h1')).toBe('Такой настройки в production нет');
  });

  it("opens this console's environment for an unknown one", async () => {
    await open('/settings/environment/qa');

    expect(TestBed.inject(Router).url).toBe('/settings/environment/production');
  });
});
