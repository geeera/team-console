import { LiveAnnouncer } from '@angular/cdk/a11y';
import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ActionsSetupApi, actionsSetupFixture } from '@console/entities/actions-setup';
import type { ActionsFirstJob } from '@console/entities/job';
import { RunnersApi, runnerFailureOf, type RunnerResult } from '@console/entities/runner';
import { NetworkStatus } from '@console/shared/api';
import { provideConsoleI18n } from '@console/shared/i18n';
import { PROBLEM_TYPE_PREFIX, type ActionsSetupDto, type ProjectDispatchDto } from '@shared/contracts';
import { ActionsSetupLedger } from './actions-setup-ledger';

function refusal(slug: string, extra: Record<string, unknown> = {}): RunnerResult<ProjectDispatchDto> {
  const error = new HttpErrorResponse({
    status: 422,
    error: { type: `${PROBLEM_TYPE_PREFIX}${slug}`, title: 'x', status: 422, field: 'dispatch', ...extra },
    headers: new HttpHeaders({ 'Content-Type': 'application/problem+json' }),
  });
  return { ok: false, failure: runnerFailureOf(error) };
}

describe('ActionsSetupLedger (#759)', () => {
  async function render(
    setup: ActionsSetupDto | null,
    write: () => RunnerResult<ProjectDispatchDto> = () => ({ ok: true, value: { dispatch: 'actions', defaultBranch: 'main' } }),
    firstJob: ActionsFirstJob | null = null,
  ) {
    const writes: string[] = [];
    const announce = vi.fn(async () => undefined);
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        provideRouter([]),
        { provide: LiveAnnouncer, useValue: { announce } },
        { provide: NetworkStatus, useValue: { online: signal(true) } },
        { provide: ActionsSetupApi, useValue: {} },
        {
          provide: RunnersApi,
          useValue: {
            setDispatch: async (slug: string) => {
              writes.push(slug);
              return write();
            },
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(ActionsSetupLedger);
    fixture.componentRef.setInput('slug', 'storify');
    fixture.componentRef.setInput('repo', 'geeera/storify');
    fixture.componentRef.setInput('projectName', 'storify');
    fixture.componentRef.setInput('setup', setup);
    fixture.componentRef.setInput('branch', 'main');
    fixture.componentRef.setInput('branchLabel', 'main');
    fixture.componentRef.setInput('teamUrl', '/settings/projects/storify/team');
    fixture.componentRef.setInput('firstJob', firstJob);
    const switched: ProjectDispatchDto[] = [];
    const rechecks: number[] = [];
    fixture.componentInstance.switched.subscribe((dto) => switched.push(dto));
    fixture.componentInstance.recheck.subscribe(() => rechecks.push(1));
    document.body.appendChild(fixture.nativeElement);
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 4; i += 1) {
        await fixture.whenStable();
        await new Promise((resolve) => setTimeout(resolve));
      }
    };
    await settle();
    const root = fixture.nativeElement as HTMLElement;
    const find = <T extends HTMLElement = HTMLElement>(selector: string): T | null => root.querySelector<T>(selector);
    const states = (): string[] => Array.from(root.querySelectorAll('[data-testid="step-state"]')).map((n) => n.textContent?.trim() ?? '');
    return { root, find, states, writes, switched, rechecks, announce, settle };
  }

  afterEach(() => document.body.replaceChildren());

  it('shows only the titles before the first answer', async () => {
    const { root, states } = await render(null);
    expect(root.querySelectorAll('li.step')).toHaveLength(5);
    expect(states()).toEqual([]);
  });

  it('words every step and opens the first one that is not done', async () => {
    const { find, states } = await render(
      actionsSetupFixture({ items: { secret: { status: 'missing' }, workflow: { status: 'missing' } } }),
    );
    expect(states()).toEqual(['Готово', 'Готово', 'Не хватает', 'Не хватает', 'Не включено']);
    expect(find('[data-testid="actions-env-how"]')?.hidden).toBe(false);
    expect(find('[data-item="secret"]')?.textContent).toContain('Секрета TC_INFERENCE_API_KEY в окружении нет');
  });

  it('never reads an unchecked secret as ok and links the installation', async () => {
    const link = 'https://github.com/settings/installations/7';
    const { find } = await render(
      actionsSetupFixture({ items: { 'app-permissions': { status: 'missing', link }, secret: { status: 'unknown' } } }),
    );
    expect(find('[data-item="secret"]')?.getAttribute('data-tone')).toBe('unknown');
    expect(find('[data-item="secret"]')?.textContent).toContain('Не проверить, пока приложение не получило права');
    expect(find<HTMLAnchorElement>('[data-testid="actions-permissions-link"]')?.getAttribute('href')).toBe(link);
  });

  it('warns about reviewers without holding the step back (owner decision 2)', async () => {
    const { find, states } = await render(actionsSetupFixture({ items: { 'protection-rules': { status: 'wrong' } } }));
    expect(states()[2]).toBe('Готово');
    expect(find('[data-item="protection-rules"]')?.textContent).toContain('будет ждать вашего одобрения');
  });

  it('links only to github.com: the Environment page to create when it is missing', async () => {
    const { find } = await render(actionsSetupFixture({ items: { environment: { status: 'missing' } } }));
    const link = find<HTMLAnchorElement>('[data-testid="actions-environment-link"]');
    expect(link?.getAttribute('href')).toBe('https://github.com/geeera/storify/settings/environments/new');
    expect(link?.textContent).toContain('Создать окружение на GitHub');
  });

  it('holds «Включить» while not ready and moves focus to the first missing step', async () => {
    const { find, writes, settle } = await render(actionsSetupFixture({ items: { workflow: { status: 'missing' } } }));
    const button = find<HTMLButtonElement>('[data-testid="switch-on"]');
    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(find('[data-testid="switch-blocked"]')?.textContent).toContain('Сначала шаги выше: не хватает 1 шага.');
    button?.click();
    await settle();
    expect(writes).toEqual([]);
    expect(document.activeElement?.getAttribute('data-step')).toBe('workflow');
  });

  it('switches on when ready and announces it', async () => {
    const { find, writes, switched, announce, settle } = await render(actionsSetupFixture());
    find<HTMLButtonElement>('[data-testid="switch-on"]')?.click();
    await settle();
    expect(writes).toEqual(['storify']);
    expect(switched).toEqual([{ dispatch: 'actions', defaultBranch: 'main' }]);
    expect(announce).toHaveBeenCalledWith('Запуск на GitHub Actions включён', 'polite');
  });

  it('names the items of a not-ready refusal and checks again', async () => {
    const { find, rechecks, settle } = await render(actionsSetupFixture(), () => refusal('actions-not-ready', { items: ['secret'] }));
    find<HTMLButtonElement>('[data-testid="switch-on"]')?.click();
    await settle();
    expect(find('[data-testid="switch-error"]')?.textContent).toContain(
      'GitHub Actions для storify ещё не готов: ключ TC_INFERENCE_API_KEY. Ничего не изменилось.',
    );
    expect(rechecks).toHaveLength(1);
  });

  it('links Team from an access-source refusal', async () => {
    const { find, settle } = await render(actionsSetupFixture(), () => refusal('access-source-hosted'));
    find<HTMLButtonElement>('[data-testid="switch-on"]')?.click();
    await settle();
    expect(find<HTMLAnchorElement>('[data-testid="switch-team"]')?.getAttribute('href')).toBe('/settings/projects/storify/team');
  });

  it('says where to switch back once on', async () => {
    const { find } = await render(actionsSetupFixture({ dispatch: 'actions' }));
    expect(find('[data-testid="switch-done"]')?.textContent).toContain('Задания проекта идут на GitHub Actions.');
    expect(find<HTMLAnchorElement>('[data-testid="switch-change"]')?.getAttribute('href')).toBe('/settings/runners');
  });

  describe('step 6, the first job', () => {
    const on = () => actionsSetupFixture({ dispatch: 'actions' });
    const ok = (): RunnerResult<ProjectDispatchDto> => ({ ok: true, value: { dispatch: 'actions', defaultBranch: 'main' } });

    it('stays out until the project runs on Actions and the jobs were read', async () => {
      expect((await render(actionsSetupFixture(), ok, { kind: 'waiting' })).find('[data-step="first-job"]')).toBeNull();
      expect((await render(on(), ok, null)).find('[data-step="first-job"]')).toBeNull();
    });

    it('waits for the first job and points to the project', async () => {
      const { find } = await render(on(), ok, { kind: 'waiting' });
      expect(find('[data-testid="first-job-text"]')?.textContent).toContain('Ждём первое задание');
      expect(find<HTMLAnchorElement>('[data-testid="first-job-open"]')?.getAttribute('href')).toBe('/p/storify/questions');
    });

    it('says when the first job passed', async () => {
      const { find } = await render(on(), ok, { kind: 'done', at: '2026-11-21T10:00:00.000Z' });
      expect(find('[data-step="first-job"]')?.getAttribute('data-first-job')).toBe('done');
      expect(find('[data-testid="first-job-text"]')?.textContent).toContain('Первое задание прошло в');
    });

    it('names why the first job failed', async () => {
      const { find } = await render(on(), ok, { kind: 'failed', reason: 'actions-no-show' });
      expect(find('[data-testid="first-job-text"]')?.textContent).toContain(
        'Первое задание не прошло: запуск на GitHub не начался за 15 минут.',
      );
    });
  });
});
