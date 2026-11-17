import { LiveAnnouncer } from '@angular/cdk/a11y';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, ErrorHandler, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { HEALTH_URL } from '@console/entities/app-info';
import { PROJECTS_URL } from '@console/entities/project';
import { NetworkStatus } from '@console/shared/api';
import { provideConsoleI18n } from '@console/shared/i18n';
import { ENVIRONMENT_STATUS_URL, projectRowsOf, type EnvironmentStatusDto } from '@shared/environment';
import { settingsRoutes } from '../settings.routes';

const PROJECT = {
  slug: 'storify',
  repo: 'geeera/storify',
  displayName: 'Storify',
  routineId: null,
  addedAt: '2026-09-28T10:00:00.000Z',
  archivedAt: null,
};

/** storify's rows as production's Worker reports them, set but the given names. */
function storifyStatus(missing: readonly string[]): EnvironmentStatusDto {
  return {
    environment: 'production',
    items: projectRowsOf('production', 'storify').map((row) => ({
      id: row.id,
      status: missing.includes(row.name) ? 'missing' : 'set',
      optional: row.item.optional === true,
    })),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
  }
}

describe('ProjectEnvironmentPage (#750)', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;
  const announce = vi.fn(async () => undefined);

  const root = (): HTMLElement => harness.routeNativeElement as HTMLElement;
  const all = (selector: string): HTMLElement[] => Array.from(root().querySelectorAll<HTMLElement>(selector));
  const text = (selector: string): string => root().querySelector(selector)?.textContent?.trim() ?? '';

  async function open(
    url: string,
    status: EnvironmentStatusDto | number = storifyStatus(['ROUTINE_TOKEN_STORIFY']),
    thisEnvironment = 'production',
  ): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: 'settings', children: settingsRoutes }], withComponentInputBinding()),
        { provide: NetworkStatus, useValue: { online: signal(true) } },
        { provide: LiveAnnouncer, useValue: { announce } },
        { provide: ErrorHandler, useValue: { handleError: vi.fn() } },
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
    document.body.appendChild(harness.fixture.nativeElement);
    let navigated = false;
    const navigation = harness.navigateByUrl(url).then(() => {
      navigated = true;
    });
    for (let i = 0; i < 200 && !navigated; i += 1) {
      await settle();
    }
    await navigation;
    await settle();
    http.expectOne(HEALTH_URL).flush({ environment: thisEnvironment });
    http.expectOne(PROJECTS_URL).flush([PROJECT]);
    const request = http.expectOne((req) => req.url === ENVIRONMENT_STATUS_URL);
    // One call, scoped to this project: never the console-wide one.
    expect(request.request.params.get('project')).toBe('storify');
    if (typeof status === 'number') {
      request.flush(null, { status, statusText: 'Refused' });
    } else {
      request.flush(status);
    }
    await settle();
  }

  beforeEach(() => announce.mockClear());

  afterEach(() => {
    harness?.fixture.nativeElement.remove();
    http.verify();
  });

  it('lists only this project’s rows in a production section marked this console, required then optional', async () => {
    await open('/settings/projects/storify/environment');

    expect(text('h1')).toBe('Окружение проекта');
    expect(document.activeElement).toBe(root().querySelector('h1'));
    expect(text('.env__lead')).toContain('Секреты Storify');
    expect(root().querySelector('[data-testid="env-crumb"]')?.getAttribute('href')).toBe(
      '/settings/projects/storify',
    );
    const sections = all('[data-testid="env-section"]');
    expect(sections.map((section) => section.dataset['environment'])).toEqual(['production']);
    expect(sections[0]?.querySelector('h2')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'production, эта консоль',
    );
    expect(all('[data-part="required"] [data-row]').map((row) => row.dataset['row'])).toEqual([
      'project/storify/ROUTINE_TOKEN_STORIFY',
    ]);
    expect(all('[data-part="optional"] [data-row]')).toHaveLength(6);
    expect(all('[data-row]').every((row) => row.dataset['row']?.startsWith('project/storify/'))).toBe(true);
    expect(
      root().querySelector('[data-row="project/storify/ROUTINE_TOKEN_STORIFY"]')?.getAttribute('href'),
    ).toBe('/settings/projects/storify/environment/production/ROUTINE_TOKEN_STORIFY');
    expect(text('[data-testid="env-quiet"]')).toBe(
      'В dev, stage и на вашем компьютере проекту ничего задавать не нужно.',
    );
  });

  it('counts a missing required row in an h3 summary under the section’s h2, with the fix command', async () => {
    await open('/settings/projects/storify/environment');

    expect(text('[data-testid="env-summary"] h3')).toBe(
      'Для Storify в production не задана 1 обязательная настройка',
    );
    expect(text('[data-testid="env-summary"] code')).toBe('setup --env production');
    const required = root()
      .querySelector('[data-row="project/storify/ROUTINE_TOKEN_STORIFY"]')
      ?.closest('[data-testid="env-row"]');
    expect(required?.querySelector('[data-testid="env-fix"] code')?.textContent).toBe(
      'setup --env production',
    );
  });

  it('never warns for optional rows: all required set reads moss, with the optional ones left as a plain line', async () => {
    await open(
      '/settings/projects/storify/environment',
      storifyStatus(['SLOT_TOKEN_STORIFY_PM', 'SLOT_ROUTINE_STORIFY_PM']),
    );

    expect(text('[data-testid="env-summary"] h3')).toBe('Для Storify в production задано всё обязательное');
    expect(text('[data-testid="env-optional-left"]')).toBe('Необязательных не задано: 2');
    expect(root().querySelector('[data-testid="env-jump"]')).toBeNull();
    const optional = root()
      .querySelector('[data-row="project/storify/SLOT_TOKEN_STORIFY_PM"]')
      ?.closest('[data-testid="env-row"]');
    expect(optional?.querySelector('[data-testid="env-status"]')?.textContent?.trim()).toBe('Не задано');
    expect(optional?.textContent).toContain('необязательно');
    expect(optional?.querySelector('[data-testid="env-fix"]')).toBeNull();
    expect(optional?.classList.contains('row--missing')).toBe(false);
  });

  it('on a dev console: production is not visible from here, with the check command', async () => {
    await open('/settings/projects/storify/environment', { environment: 'dev', items: [] }, 'dev');

    expect(text('[data-testid="env-summary"]')).toContain('Это консоль dev. Что задано в production');
    expect(text('[data-testid="env-summary"] code')).toBe('setup --env production --check');
    const statuses = all('[data-testid="env-status"]').map((status) => status.textContent?.trim());
    expect(new Set(statuses)).toEqual(new Set(['Отсюда не видно']));
    expect(text('[data-testid="env-quiet"]')).toBe(
      'В dev, stage и на вашем компьютере проекту ничего задавать не нужно.',
    );
  });

  it('shows no row names to a sign-in that may not see them (403), and a way back to setup', async () => {
    await open('/settings/projects/storify/environment', 403);

    const forbidden = root().querySelector('[data-testid="env-forbidden"]') as HTMLElement;
    expect(forbidden.getAttribute('role')).toBe('alert');
    expect(forbidden.textContent).toContain('Секреты проекта задаёт оператор консоли');
    expect(forbidden.querySelector('a')?.getAttribute('href')).toBe('/settings/projects/storify');
    expect(root().querySelector('[data-row]')).toBeNull();
    expect(root().textContent).not.toContain('ROUTINE_TOKEN');
  });

  it('reads an archived, unknown or out-of-scope project (404) as the setup page’s not-found', async () => {
    await open('/settings/projects/storify/environment', 404);

    expect(text('h1')).toBe('Проект не найден');
    expect(root().querySelector('[data-row]')).toBeNull();
  });

  it('keeps the rows and guides when the check fails, with Try again that focuses the summary heading', async () => {
    await open('/settings/projects/storify/environment', 503);

    expect(text('[data-testid="env-error"]')).toContain('Не удалось проверить окружение проекта');
    expect(root().querySelector('[data-row="project/storify/ROUTINE_TOKEN_STORIFY"]')).not.toBeNull();

    (root().querySelector('[data-testid="env-retry"]') as HTMLButtonElement).click();
    await settle();
    http.expectOne((req) => req.url === ENVIRONMENT_STATUS_URL).flush(storifyStatus([]));
    await settle();

    const heading = root().querySelector('[data-testid="env-summary"] h3');
    expect(heading?.textContent?.trim()).toBe('Для Storify в production задано всё обязательное');
    expect(document.activeElement).toBe(heading);
    expect(announce).toHaveBeenCalledWith('Для Storify в production задано всё обязательное', 'polite');
  });

  it('opens a project guide from the manifest; Back reads the project and returns to the row', async () => {
    await open('/settings/projects/storify/environment/production/ROUTINE_TOKEN_STORIFY');

    const guide = root().querySelector('[data-testid="env-guide"]') as HTMLElement;
    expect(guide.querySelector('h1')?.textContent?.trim()).toBe('ROUTINE_TOKEN_STORIFY');
    expect(document.activeElement).toBe(guide.querySelector('h1'));
    expect(text('[data-testid="env-guide-status"]')).toBe('Не задано');
    expect(guide.textContent).toContain('Worker консоли (api), проект storify');
    const back = guide.querySelector('nav a') as HTMLAnchorElement;
    expect(back.getAttribute('href')).toBe('/settings/projects/storify/environment');
    expect(back.textContent?.trim()).toBe('Окружение Storify');

    guide.querySelector('h1')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(TestBed.inject(Router).url).toBe('/settings/projects/storify/environment');
    expect(document.activeElement).toBe(
      root().querySelector('[data-row="project/storify/ROUTINE_TOKEN_STORIFY"]'),
    );
  });

  it('says the project has no such setting for another project’s name or an unknown environment', async () => {
    await open('/settings/projects/storify/environment/production/ROUTINE_TOKEN_OTHER');
    expect(text('[data-testid="env-guide"] h1')).toBe('У проекта Storify нет такой настройки в production');

    await harness.navigateByUrl('/settings/projects/storify/environment/qa/ROUTINE_TOKEN_STORIFY');
    await settle();
    expect(text('[data-testid="env-guide"] h1')).toBe('У проекта Storify нет такой настройки в qa');
  });
});
