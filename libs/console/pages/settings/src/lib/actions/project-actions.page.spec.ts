import { LiveAnnouncer } from '@angular/cdk/a11y';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ActionsSetupApi, actionsSetupFixture, type ActionsCheckProblem } from '@console/entities/actions-setup';
import { JobsApi, jobFixture } from '@console/entities/job';
import { ProjectsStore } from '@console/entities/project';
import { RunnersApi } from '@console/entities/runner';
import { NetworkStatus } from '@console/shared/api';
import { provideConsoleI18n } from '@console/shared/i18n';
import type { ActionsSetupDto, JobDto } from '@shared/contracts';
import { ProjectActionsPage } from './project-actions.page';

type CheckAnswer = { ok: true; value: ActionsSetupDto } | { ok: false; problem: ActionsCheckProblem };

describe('ProjectActionsPage (#759)', () => {
  async function render(answers: CheckAnswer[], jobs: readonly JobDto[] = []) {
    const checks: string[] = [];
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        provideRouter([]),
        { provide: LiveAnnouncer, useValue: { announce: vi.fn(async () => undefined) } },
        { provide: NetworkStatus, useValue: { online: signal(true) } },
        {
          provide: ProjectsStore,
          useValue: {
            status: signal('ready'),
            ready: async () => true,
            bySlug: (slug: string) => (slug === 'storify' ? { slug, repo: 'geeera/storify', displayName: 'storify' } : undefined),
          },
        },
        {
          provide: ActionsSetupApi,
          useValue: {
            check: async (slug: string) => {
              checks.push(slug);
              return answers.shift() ?? { ok: false, problem: { kind: 'failed' } };
            },
          },
        },
        { provide: JobsApi, useValue: { list: async () => ({ ok: true, value: { jobs } }) } },
        { provide: RunnersApi, useValue: { dispatch: async () => ({ ok: true, value: { dispatch: 'pull', defaultBranch: 'main' } }) } },
      ],
    });
    const fixture = TestBed.createComponent(ProjectActionsPage);
    fixture.componentRef.setInput('slug', 'storify');
    document.body.appendChild(fixture.nativeElement);
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 5; i += 1) {
        await fixture.whenStable();
        await new Promise((resolve) => setTimeout(resolve));
      }
    };
    await settle();
    const root = fixture.nativeElement as HTMLElement;
    const find = <T extends HTMLElement = HTMLElement>(id: string): T | null => root.querySelector<T>(`[data-testid="${id}"]`);
    return { root, find, checks, settle };
  }

  afterEach(() => document.body.replaceChildren());

  it('checks once on entry and counts the missing steps, the default branch in the copy', async () => {
    const { find, checks, root } = await render([
      { ok: true, value: actionsSetupFixture({ items: { secret: { status: 'missing' }, workflow: { status: 'missing' } } }) },
    ]);
    expect(checks).toEqual(['storify']);
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('Запуск на GitHub Actions');
    expect(find('actions-summary')?.textContent).toContain('Не хватает 2 шагов');
    expect(root.textContent).toContain('Файл workflow в ветке main');
  });

  it('says all set when ready', async () => {
    const { find } = await render([{ ok: true, value: actionsSetupFixture() }]);
    expect(find('actions-summary')?.textContent).toContain('Всё готово — осталось включить');
  });

  it('shows a member the forbidden state with no steps', async () => {
    const { find } = await render([{ ok: false, problem: { kind: 'forbidden' } }]);
    expect(find('actions-forbidden')?.textContent).toContain('GitHub Actions подключает владелец аккаунта');
    expect(find('actions-ledger')).toBeNull();
  });

  it('says GitHub did not answer, with Retry', async () => {
    const { find, checks, settle } = await render([
      { ok: false, problem: { kind: 'github' } },
      { ok: true, value: actionsSetupFixture() },
    ]);
    expect(find('actions-error')?.textContent).toContain('GitHub не ответил');
    find('actions-retry')?.click();
    await settle();
    expect(checks).toHaveLength(2);
    expect(find('actions-ledger')).not.toBeNull();
  });

  it('keeps the last answer and says when a re-check is allowed after a 429', async () => {
    const { find, settle } = await render([
      { ok: true, value: actionsSetupFixture() },
      { ok: false, problem: { kind: 'rate', retryAt: '2026-11-21T13:00:00.000Z' } },
    ]);
    find('actions-check-again')?.click();
    await settle();
    expect(find('actions-rate')?.textContent).toContain('Проверяли слишком часто');
    expect(find('actions-check-again')?.getAttribute('aria-disabled')).toBe('true');
    expect(find('actions-ledger')).not.toBeNull();
  });

  it('shows drift when switched on and no longer ready', async () => {
    const { find } = await render([
      { ok: true, value: actionsSetupFixture({ dispatch: 'actions', items: { secret: { status: 'missing' } } }) },
    ]);
    expect(find('actions-drift')?.textContent).toContain('репозиторий больше не готов');
  });

  it('adds step 6 once it is on: waiting with no Actions job yet, done with a finished one', async () => {
    const on = { ok: true, value: actionsSetupFixture({ dispatch: 'actions' }) } as const;
    const waiting = await render([on]);
    expect(waiting.root.querySelector('[data-step="first-job"]')?.getAttribute('data-first-job')).toBe('waiting');
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const finished = jobFixture({ dispatch: 'actions', state: 'finished', finishedAt: '2026-11-21T10:00:00.000Z' });
    const done = await render([on], [finished]);
    expect(done.root.querySelector('[data-step="first-job"]')?.getAttribute('data-first-job')).toBe('done');
  });

  it('shows no step 6 while the project is not on Actions', async () => {
    const { root } = await render([{ ok: true, value: actionsSetupFixture() }]);
    expect(root.querySelector('[data-step="first-job"]')).toBeNull();
  });
});
