import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { HEALTH_URL } from '@console/entities/app-info';
import {
  ExternalNavigation,
  GITHUB_CONNECTION_URL,
  GitHubConnectionStore,
} from '@console/entities/github-connection';
import { PROJECTS_URL, ProjectsStore } from '@console/entities/project';
import { NetworkStatus } from '@console/shared/api';
import { provideConsoleI18n } from '@console/shared/i18n';
import { PROBLEM_TYPE_PREFIX } from '@shared/contracts';
import { AddProjectForm, JUST_ADDED_STATE } from './add-project-form';

const CONNECTED = {
  state: 'connected',
  login: 'geeera',
  connectedAt: '2026-09-28T10:00:00.000Z',
  appName: 'team-console-dev',
};

const problem = (slug: string, status: number, extensions: Record<string, unknown> = {}) => ({
  type: `${PROBLEM_TYPE_PREFIX}${slug}`,
  title: slug,
  status,
  ...extensions,
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
  }
}

describe('AddProjectForm', () => {
  let fixture: ComponentFixture<AddProjectForm>;
  let http: HttpTestingController;
  let root: HTMLElement;
  const online = signal(true);

  async function render(connection: object = CONNECTED): Promise<void> {
    TestBed.configureTestingModule({
      imports: [AddProjectForm],
      providers: [
        provideConsoleI18n(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: '**', children: [] }]),
        { provide: NetworkStatus, useValue: { online } },
        { provide: ExternalNavigation, useValue: { assign: vi.fn() } },
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AddProjectForm);
    root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    await settle();
    http.expectOne(GITHUB_CONNECTION_URL).flush(connection);
    http.expectOne(HEALTH_URL).flush({ status: 'ok', environment: 'dev', version: '0.1.0' });
    await settle();
  }

  const field = (): HTMLInputElement => root.querySelector('[data-testid="repo-field"]') as HTMLInputElement;
  async function type(value: string): Promise<void> {
    field().value = value;
    field().dispatchEvent(new Event('input'));
    await settle();
  }
  async function submit(): Promise<void> {
    (root.querySelector('[data-testid="add-submit"]') as HTMLButtonElement).click();
    await settle();
  }
  const stateWords = (): string[] =>
    Array.from(root.querySelectorAll('[data-testid="step-state"]')).map(
      (node) => node.textContent?.trim() ?? '',
    );

  beforeEach(() => online.set(true));

  afterEach(() => {
    root?.remove();
    http.verify();
  });

  it('focuses the field, with iOS-safe input attributes, and previews the address while valid', async () => {
    await render();
    expect(document.activeElement).toBe(field());
    expect(field().getAttribute('autocapitalize')).toBe('none');
    expect(field().getAttribute('spellcheck')).toBe('false');
    expect(field().getAttribute('enterkeyhint')).toBe('go');

    await type('https://github.com/geeera/Field_Note.git');
    const note = root.querySelector('.tc-field__note') as HTMLElement;
    expect(note.textContent?.trim()).toBe('Адрес в консоли: /p/field-note');
    expect(field().getAttribute('aria-describedby')).toContain(note.id);
  });

  it('invalid input shows an inline error and sends no request', async () => {
    await render();
    await type('just-a-name');
    await submit();

    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(root.querySelector('.tc-field__error')?.textContent).toContain('«just-a-name» не похоже');
    http.expectNone(PROJECTS_URL);

    await type('');
    await submit();
    expect(root.querySelector('.tc-field__error')?.textContent).toContain('Введите репозиторий');
  });

  it('not connected: says to connect first, offers Connect and sends nothing', async () => {
    await render({ state: 'not-connected', ownerLogin: 'geeera', appName: 'team-console-dev' });
    await type('geeera/storify');
    await submit();

    expect(root.querySelector('[data-testid="need-connect"] h2')?.textContent?.trim()).toBe(
      'Сначала подключите GitHub',
    );
    expect(root.querySelector('tc-connect-github-button')).not.toBeNull();
    expect(root.querySelector('[data-testid="add-submit"]')?.getAttribute('aria-disabled')).toBe('true');
    http.expectNone(PROJECTS_URL);
  });

  it('saves a pasted link as owner/repo and opens the new project’s setup page', async () => {
    await render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
    await type('  https://github.com/geeera/storify  ');
    await submit();

    const request = http.expectOne(PROJECTS_URL);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ repo: 'geeera/storify' });
    expect(stateWords()).toEqual(Array(5).fill('Проверяем…'));
    request.flush(
      {
        slug: 'storify',
        repo: 'geeera/storify',
        displayName: 'storify',
        routineId: null,
        addedAt: '2026-10-01T10:00:00.000Z',
        archivedAt: null,
      },
      { status: 201, statusText: 'Created' },
    );
    await settle();

    expect(TestBed.inject(ProjectsStore).isActive('storify')).toBe(true);
    expect(navigate).toHaveBeenCalledWith(['/settings/projects', 'storify'], {
      state: { [JUST_ADDED_STATE]: true },
    });
  });

  it('a refused add says nothing was saved, marks the step and the rest; Check again re-sends the same value', async () => {
    await render();
    await type('acme/site');
    await submit();
    http
      .expectOne(PROJECTS_URL)
      .flush(
        problem('github-owner-mismatch', 409, { step: 'repo-owner', repoOwner: 'acme', login: 'geeera' }),
        {
          status: 409,
          statusText: 'Conflict',
        },
      );
    await settle();

    const result = root.querySelector('[data-testid="add-result"] h2') as HTMLElement;
    expect(result.textContent?.trim()).toBe('Проект не добавлен');
    expect(document.activeElement).toBe(result);
    expect(root.querySelector('[data-testid="add-result"]')?.textContent).toContain('Ничего не сохранено');
    expect(stateWords()).toEqual(['Готово', 'Не хватает', 'Не проверено', 'Не проверено', 'Не проверено']);
    expect(root.textContent).toContain('Владелец acme/site — acme, а подключён geeera');

    (root.querySelector('[data-testid="check-again"]') as HTMLButtonElement).click();
    await settle();
    expect(http.expectOne(PROJECTS_URL).request.body).toEqual({ repo: 'acme/site' });
  });

  it('rate limit names the time from Retry-After; nothing is saved', async () => {
    await render();
    await type('geeera/storify');
    await submit();
    http.expectOne(PROJECTS_URL).flush(problem('github-rate-limit', 429, { step: 'app-installed' }), {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'Retry-After': '42' },
    });
    await settle();

    const text = root.querySelector('[data-testid="add-result"]')?.textContent ?? '';
    expect(text).toContain('GitHub просит подождать до');
    expect(text).toContain('Ничего не сохранено');
    expect(text).not.toMatch(/PAT|GITHUB_TOKEN/);
  });

  it('a broken console app credential (503 github-auth) has its own message naming the app', async () => {
    await render();
    await type('geeera/storify');
    await submit();
    http.expectOne(PROJECTS_URL).flush(problem('github-auth', 503, { step: 'app-installed' }), {
      status: 503,
      statusText: 'Service Unavailable',
    });
    await settle();

    const text = root.querySelector('[data-testid="add-result"]')?.textContent ?? '';
    expect(text).toContain('как приложение team-console-dev');
    expect(text).not.toMatch(/PAT|GITHUB_TOKEN/);
  });

  it('a connection lost meanwhile (403) reads as lost with Connect, not a generic error', async () => {
    await render();
    await type('geeera/storify');
    await submit();
    http
      .expectOne(PROJECTS_URL)
      .flush(
        problem('github-owner-not-connected', 403, {
          step: 'repo-owner',
          connectUrl: '/api/v1/github/connect',
        }),
        {
          status: 403,
          statusText: 'Forbidden',
        },
      );
    await settle();

    expect(TestBed.inject(GitHubConnectionStore).view()).toBe('lost');
    expect(root.querySelector('[data-testid="add-result"] h2')?.textContent?.trim()).toBe(
      'Подключение к GitHub потеряно',
    );
    expect(root.querySelector('[data-testid="add-result"] tc-connect-github-button')).not.toBeNull();
  });

  it('an already-registered repository links to its setup page; an archived one says so', async () => {
    await render();
    await type('Geeera/Storify');
    await submit();
    http
      .expectOne(PROJECTS_URL)
      .flush(problem('project-exists', 409, { step: 'unique' }), { status: 409, statusText: 'Conflict' });
    await settle();
    http
      .expectOne((req) => req.url === PROJECTS_URL && req.params.get('include') === 'archived')
      .flush([
        {
          slug: 'storify',
          repo: 'geeera/storify',
          displayName: 'storify',
          routineId: null,
          addedAt: '2026-09-29T00:00:00.000Z',
          archivedAt: null,
        },
      ]);
    await settle();

    expect(root.querySelector('[data-testid="add-result"] h2')?.textContent?.trim()).toBe(
      'Geeera/Storify уже есть в списке.',
    );
    expect(root.querySelector('[data-testid="duplicate-link"]')?.getAttribute('href')).toBe(
      '/settings/projects/storify',
    );

    await submit();
    http
      .expectOne(PROJECTS_URL)
      .flush(problem('project-exists', 409, { step: 'unique' }), { status: 409, statusText: 'Conflict' });
    await settle();
    http
      .expectOne((req) => req.url === PROJECTS_URL && req.params.get('include') === 'archived')
      .flush([
        {
          slug: 'storify',
          repo: 'geeera/storify',
          displayName: 'storify',
          routineId: null,
          addedAt: '2026-09-29T00:00:00.000Z',
          archivedAt: '2026-09-30T00:00:00.000Z',
        },
      ]);
    await settle();
    expect(root.querySelector('[data-testid="add-result"]')?.textContent).toContain('в архиве');
  });

  it('clears the previous result and inline error as soon as the value changes (#124 item 3)', async () => {
    await render();
    await type('acme/site');
    await submit();
    http
      .expectOne(PROJECTS_URL)
      .flush(problem('project-exists', 409, { step: 'unique' }), { status: 409, statusText: 'Conflict' });
    await settle();
    http
      .expectOne((req) => req.url === PROJECTS_URL && req.params.get('include') === 'archived')
      .flush([
        {
          slug: 'site',
          repo: 'acme/site',
          displayName: 'site',
          routineId: null,
          addedAt: '2026-09-29T00:00:00.000Z',
          archivedAt: null,
        },
      ]);
    await settle();
    expect(root.querySelector('[data-testid="add-result"]')).not.toBeNull();

    await type('nope');
    expect(root.querySelector('[data-testid="add-result"]')).toBeNull();

    await submit();
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(root.querySelector('.tc-field__error')).not.toBeNull();

    await type('geeera/storify');
    expect(root.querySelector('.tc-field__error')).toBeNull();
    http.expectNone(PROJECTS_URL);
  });

  it('offline: Check and add is unavailable with an explanation and sends nothing', async () => {
    await render();
    online.set(false);
    await type('geeera/storify');
    await submit();

    expect(root.querySelector('[data-testid="add-submit"]')?.getAttribute('aria-disabled')).toBe('true');
    expect(root.textContent).toContain('Нет сети: проверить репозиторий можно только онлайн.');
    http.expectNone(PROJECTS_URL);
  });
});
