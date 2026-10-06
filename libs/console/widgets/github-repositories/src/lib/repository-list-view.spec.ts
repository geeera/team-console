import { ApplicationInitStatus, type ComponentRef } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { RepositoriesProblem, RepositoriesStatus } from '@console/entities/installation-repository';
import { provideConsoleI18n } from '@console/shared/i18n';
import type { InstallationRepositoryDto } from '@shared/contracts';
import { RepositoryListView, type RepositoryRowState } from './repository-list-view';

const repo = (
  fullName: string,
  registration: InstallationRepositoryDto['registration'] = { state: 'none' },
  isPrivate = false,
): InstallationRepositoryDto => ({ fullName, private: isPrivate, registration });

const LIST: readonly InstallationRepositoryDto[] = [
  repo('geeera/storify', { state: 'none' }, true),
  repo('geeera/team-console', { state: 'active', slug: 'team-console' }),
  repo('geeera/old-landing', { state: 'archived', slug: 'old-landing' }),
  repo('geeera/fieldnote'),
];

interface Inputs {
  readonly connection?: 'loading' | 'connected' | 'not-connected' | 'lost' | 'error';
  readonly status?: RepositoriesStatus;
  readonly problem?: RepositoriesProblem | null;
  readonly repositories?: readonly InstallationRepositoryDto[];
  readonly rowStates?: Readonly<Record<string, RepositoryRowState>>;
  readonly partial?: boolean;
  readonly online?: boolean;
  readonly loadedAt?: string | null;
  readonly keepInPlace?: ReadonlySet<string>;
}

describe('RepositoryListView', () => {
  let fixture: ComponentFixture<RepositoryListView>;
  let ref: ComponentRef<RepositoryListView>;

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const text = (selector: string): string =>
    root().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  async function render(inputs: Inputs = {}): Promise<void> {
    TestBed.configureTestingModule({ providers: [provideConsoleI18n(), provideRouter([])] });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    fixture = TestBed.createComponent(RepositoryListView);
    ref = fixture.componentRef;
    ref.setInput('connection', inputs.connection ?? 'connected');
    ref.setInput('status', inputs.status ?? 'ready');
    ref.setInput('problem', inputs.problem ?? null);
    ref.setInput('repositories', inputs.repositories ?? LIST);
    ref.setInput('rowStates', inputs.rowStates ?? {});
    ref.setInput('partial', inputs.partial ?? false);
    ref.setInput('online', inputs.online ?? true);
    ref.setInput('loadedAt', inputs.loadedAt ?? '2026-10-05T09:41:00.000Z');
    ref.setInput('keepInPlace', inputs.keepInPlace ?? new Set());
    ref.setInput('selectionUrl', 'https://github.com/settings/installations/1001');
    ref.setInput('appName', 'team-console-dev');
    ref.setInput('login', 'geeera');
    await fixture.whenStable();
  }

  const row = (fullName: string): HTMLElement =>
    root().querySelector(`[data-repo="${fullName.toLowerCase()}"]`) as HTMLElement;

  it('loading: skeleton rows, busy, with the loading text for screen readers', async () => {
    await render({ status: 'loading' });
    const loading = root().querySelector('[data-testid="repos-loading"]') as HTMLElement;
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.textContent).toContain('Загружаем репозитории с GitHub…');
    expect(root().querySelector('[data-testid="repos-refresh"]')).toBeNull();
  });

  it('loaded: the heading, the lead naming the app and the account, addable rows first', async () => {
    await render();
    expect(text('h2')).toBe('Доступны на GitHub');
    expect(text('.repos__lead')).toBe(
      'Репозитории, которые видит приложение team-console-dev в вашем аккаунте geeera.',
    );
    const addable = [...root().querySelectorAll('[data-group="addable"] [data-repo]')].map((el) =>
      el.getAttribute('data-repo'),
    );
    expect(addable).toEqual(['geeera/fieldnote', 'geeera/storify']);
    expect(text('#repos-already')).toBe('Уже в консоли 2');
  });

  it('an addable row: name, owner, a Private word and one Add button named after the repository', async () => {
    await render();
    const storify = row('geeera/storify');
    expect(storify.textContent).toContain('storify');
    expect(storify.textContent).toContain('Приватный');
    const add = storify.querySelector('[data-testid="repo-add"]') as HTMLButtonElement;
    expect(add.getAttribute('aria-label')).toBe('Добавить geeera/storify');
    expect(row('geeera/fieldnote').textContent).not.toContain('Приватный');
  });

  it('a project row is one link to its setup page, named "… is a project. Open its setup"', async () => {
    await render();
    const project = row('geeera/team-console');
    const link = project.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/settings/projects/team-console');
    expect(link.getAttribute('aria-label')).toBe('geeera/team-console: проект. Открыть настройку');
    expect(project.querySelector('[data-testid="repo-project"]')?.textContent).toContain('Проект');
    expect(project.querySelector('button')).toBeNull();
  });

  it('an archived row says so and has no control', async () => {
    await render();
    const archived = row('geeera/old-landing');
    expect(archived.querySelector('[data-testid="repo-archived"]')?.textContent?.trim()).toBe('В архиве');
    expect(archived.querySelector('a, button')).toBeNull();
    expect(archived.classList).toContain('tc-list-row--muted');
  });

  it('checking: the row Add reads "Checking…" and is aria-disabled; a tap does nothing', async () => {
    await render({ rowStates: { 'geeera/storify': { kind: 'checking' } } });
    const add = row('geeera/storify').querySelector('[data-testid="repo-add"]') as HTMLButtonElement;
    expect(add.textContent).toContain('Проверяем…');
    expect(add.getAttribute('aria-disabled')).toBe('true');
    const added: InstallationRepositoryDto[] = [];
    fixture.componentInstance.add.subscribe((value) => added.push(value));
    add.click();
    expect(added).toEqual([]);
  });

  it('not added: the row keeps Add and says which step is missing, with See why', async () => {
    await render({ rowStates: { 'geeera/fieldnote': { kind: 'not-added', step: 3 } } });
    const fieldnote = row('geeera/fieldnote');
    expect(fieldnote.querySelector('[data-testid="repo-not-added"]')?.textContent).toContain(
      'Не добавлен: не хватает шага 3',
    );
    const why = fieldnote.querySelector('[data-testid="repo-see-why"]') as HTMLButtonElement;
    expect(why.getAttribute('aria-label')).toBe('Почему geeera/fieldnote не добавлен');
    expect(fieldnote.querySelector('[data-testid="repo-add"]')).not.toBeNull();
  });

  it('a project added a moment ago turns "Project" in place', async () => {
    await render({
      repositories: [repo('geeera/storify', { state: 'active', slug: 'storify' }), repo('geeera/zeta')],
      keepInPlace: new Set(['geeera/storify']),
    });
    const storify = root().querySelector(
      '[data-group="addable"] [data-repo="geeera/storify"]',
    ) as HTMLElement;
    expect(storify.querySelector('a')?.getAttribute('href')).toBe('/settings/projects/storify');
  });

  it('partial: "Showing the first N" with the GitHub selection link', async () => {
    await render({ partial: true });
    expect(text('[data-testid="repos-partial"] p')).toContain('Показаны первые 4.');
    const link = root().querySelector('[data-testid="repos-partial"] a') as HTMLAnchorElement;
    expect(link.href).toBe('https://github.com/settings/installations/1001');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
  });

  it('empty: the app sees nothing, with the link to choose repositories on GitHub', async () => {
    await render({ repositories: [] });
    expect(text('[data-testid="repos-empty"]')).toContain(
      'Приложение team-console-dev пока не видит репозиториев',
    );
    expect(root().querySelector('[data-testid="repos-empty"] a')?.getAttribute('href')).toBe(
      'https://github.com/settings/installations/1001',
    );
  });

  it('not connected: the projected Connect callout, no list and no Refresh', async () => {
    await render({ connection: 'not-connected', status: 'idle' });
    expect(root().querySelector('[data-testid="repos-loading"]')).toBeNull();
    expect(root().querySelector('[data-repo]')).toBeNull();
    expect(root().querySelector('[data-testid="repos-refresh"]')).toBeNull();
    expect(root().querySelector('.repos__lead')).toBeNull();
  });

  it('not installed: the install link from the server', async () => {
    await render({
      status: 'error',
      problem: {
        kind: 'not-installed',
        installUrl: 'https://github.com/apps/team-console-dev/installations/new',
      },
    });
    expect(text('[data-testid="repos-not-installed"]')).toContain(
      'Приложение team-console-dev не установлено в вашем аккаунте',
    );
    expect(root().querySelector('[data-testid="repos-not-installed"] a')?.getAttribute('href')).toBe(
      'https://github.com/apps/team-console-dev/installations/new',
    );
  });

  it.each([
    ['GitHub unavailable', { kind: 'github' }, 'GitHub не ответил. Ваши проекты не изменились.'],
    [
      'the app credential',
      { kind: 'auth' },
      'Консоль не может войти в GitHub как приложение team-console-dev',
    ],
  ] as const)('%s: an alert with its reason and Retry', async (_label, problem, reason) => {
    await render({ status: 'error', problem });
    const block = root().querySelector('[data-testid="repos-error"]') as HTMLElement;
    expect(block.getAttribute('role')).toBe('alert');
    expect(block.textContent).toContain('Не удалось загрузить репозитории');
    expect(block.textContent).toContain(reason);
    expect(block.querySelector('[data-testid="repos-retry"]')?.textContent?.trim()).toBe('Повторить');
  });

  it('rate limit: the local time from Retry-After', async () => {
    await render({ status: 'error', problem: { kind: 'rate', retryAt: '2026-10-05T09:58:00.000Z' } });
    expect(text('[data-testid="repos-error"]')).toMatch(/GitHub просит подождать до \d{1,2}:\d{2}/);
  });

  it('offline with a list: the dated note, Add and Refresh unavailable but focusable', async () => {
    await render({ online: false });
    expect(text('[data-testid="repos-offline-note"]')).toMatch(
      /^Нет сети\. Список на момент \d{1,2}:\d{2}\./,
    );
    const add = row('geeera/storify').querySelector('[data-testid="repo-add"]') as HTMLButtonElement;
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(add.disabled).toBe(false);
    expect(root().querySelector('[data-testid="repos-refresh"]')?.getAttribute('aria-disabled')).toBe('true');
    // Project rows still open.
    expect(row('geeera/team-console').querySelector('a')).not.toBeNull();
  });

  it('offline with nothing loaded: its own block with Retry', async () => {
    await render({ status: 'error', problem: { kind: 'offline' }, loadedAt: null });
    expect(text('[data-testid="repos-offline"]')).toContain('Нет сети');
    expect(root().querySelector('[data-testid="repos-offline"] [data-testid="repos-retry"]')).not.toBeNull();
  });

  it('a long list folds after ten addable rows; Show more reveals the rest', async () => {
    const many = Array.from({ length: 14 }, (_, index) => repo(`geeera/r${String(index).padStart(2, '0')}`));
    await render({ repositories: many });
    expect(root().querySelectorAll('[data-group="addable"] [data-repo]')).toHaveLength(10);
    const more = root().querySelector('[data-testid="repos-more"]') as HTMLButtonElement;
    expect(more.textContent?.trim()).toBe('Показать ещё 4');
    more.click();
    await fixture.whenStable();
    expect(root().querySelectorAll('[data-group="addable"] [data-repo]')).toHaveLength(14);
  });

  it('emits add, see why, retry and refresh', async () => {
    await render({ rowStates: { 'geeera/fieldnote': { kind: 'not-added', step: 3 } } });
    const seen: string[] = [];
    const view = fixture.componentInstance;
    view.add.subscribe((value) => seen.push(`add ${value.fullName}`));
    view.seeWhy.subscribe((value) => seen.push(`why ${value.fullName}`));
    view.refresh.subscribe(() => seen.push('refresh'));
    (row('geeera/storify').querySelector('[data-testid="repo-add"]') as HTMLButtonElement).click();
    (row('geeera/fieldnote').querySelector('[data-testid="repo-see-why"]') as HTMLButtonElement).click();
    (root().querySelector('[data-testid="repos-refresh"]') as HTMLButtonElement).click();
    expect(seen).toEqual(['add geeera/storify', 'why geeera/fieldnote', 'refresh']);
  });
});
