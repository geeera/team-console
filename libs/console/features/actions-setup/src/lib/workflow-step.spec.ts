import { LiveAnnouncer } from '@angular/cdk/a11y';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActionsSetupApi, actionsSetupFixture, type WorkflowPrRefusal } from '@console/entities/actions-setup';
import { NetworkStatus } from '@console/shared/api';
import { provideConsoleI18n } from '@console/shared/i18n';
import type { ActionsSetupDto, ActionsWorkflowPrDto } from '@shared/contracts';
import { WorkflowStep } from './workflow-step';

const PR_URL = 'https://github.com/geeera/storify/pull/42';
const MISSING = actionsSetupFixture({ items: { workflow: { status: 'missing' } } });

type PrAnswer = { ok: true; value: ActionsWorkflowPrDto } | { ok: false; problem: WorkflowPrRefusal };

describe('WorkflowStep (#759 step 4)', () => {
  async function render(setup: ActionsSetupDto, answer: () => PrAnswer = () => ({ ok: true, value: { number: 42, url: PR_URL, kind: 'setup' } })) {
    const announce = vi.fn(async () => undefined);
    const calls: string[] = [];
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        { provide: LiveAnnouncer, useValue: { announce } },
        { provide: NetworkStatus, useValue: { online: signal(true) } },
        {
          provide: ActionsSetupApi,
          useValue: {
            openWorkflowPr: async (slug: string) => {
              calls.push(slug);
              return answer();
            },
            workflow: async () => ({ ok: true, value: { text: 'on: workflow_dispatch', sha256: 'a'.repeat(64), version: '0.42.0' } }),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(WorkflowStep);
    fixture.componentRef.setInput('slug', 'storify');
    fixture.componentRef.setInput('repo', 'geeera/storify');
    fixture.componentRef.setInput('setup', setup);
    fixture.componentRef.setInput('branch', 'main');
    fixture.componentRef.setInput('branchLabel', 'main');
    const rechecks: number[] = [];
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
    const find = <T extends HTMLElement = HTMLElement>(id: string): T | null => root.querySelector<T>(`[data-testid="${id}"]`);
    const click = async (id: string): Promise<void> => {
      find(id)?.click();
      await settle();
    };
    return { root, find, click, calls, announce, rechecks, fixture, settle };
  }

  afterEach(() => document.body.replaceChildren());

  it('opens the PR, shows it, moves focus to it and announces it', async () => {
    const { find, click, calls, announce } = await render(MISSING);
    expect(find('workflow-fix')?.textContent).toContain('Файла team-console-runner.yml в main нет.');
    expect(find('workflow-open-pr')?.textContent?.trim()).toBe('Открыть PR с файлом');
    await click('workflow-open-pr');
    expect(calls).toEqual(['storify']);
    const link = find<HTMLAnchorElement>('workflow-pr-link');
    expect(link?.getAttribute('href')).toBe(PR_URL);
    expect(document.activeElement).toBe(link);
    expect(find('workflow-fix')?.textContent).toContain('PR #42 открыт. Смержите его');
    expect(announce).toHaveBeenCalledWith('PR #42 открыт', 'polite');
  });

  it('shows an already open console PR on 409 and announces it', async () => {
    const { find, click, announce } = await render(MISSING, () => ({
      ok: false,
      problem: { kind: 'pr-open', pr: { number: 7, url: PR_URL, provenance: 'console' } },
    }));
    await click('workflow-open-pr');
    expect(find('workflow-pr-link')?.textContent).toContain('Открыть PR #7 на GitHub');
    expect(announce).toHaveBeenCalledWith('PR #7 уже открыт', 'polite');
  });

  it('never says merge for a PR the console cannot vouch for', async () => {
    const { find } = await render(
      actionsSetupFixture({ items: { workflow: { status: 'missing', pr: { number: 9, url: PR_URL, provenance: 'changed' } } } }),
    );
    expect(find('workflow-fix')?.textContent).toContain('Не мержите его, пока не проверите');
    expect(find('workflow-open-pr')).toBeNull();
  });

  it('names a leftover branch and links it on GitHub (#844), and opens the Copy path', async () => {
    const link = 'https://github.com/geeera/storify/branches/all?query=team-console%2Frunner-';
    const { find, click } = await render(MISSING, () => ({ ok: false, problem: { kind: 'branch-exists', link } }));
    await click('workflow-open-pr');
    expect(find('workflow-pr-error')?.getAttribute('role')).toBe('alert');
    expect(find('workflow-pr-error')?.textContent).toContain('удалите эту ветку на GitHub');
    expect(find<HTMLAnchorElement>('workflow-pr-error-link')?.getAttribute('href')).toBe(link);
    expect(find('workflow-file')).not.toBeNull();
  });

  it('switches to the Copy path for good when the operator turned PRs off', async () => {
    const { find, click } = await render(MISSING, () => ({ ok: false, problem: { kind: 'write-disabled' } }));
    await click('workflow-open-pr');
    expect(find('workflow-copy-reason')?.textContent).toContain('Сейчас консоль не открывает PR');
    expect(find('workflow-open-pr')).toBeNull();
    expect(find('workflow-show-file')?.getAttribute('aria-expanded')).toBe('true');
    expect(find('workflow-file-meta')?.textContent).toContain('Версия 0.42.0');
  });

  it.each([
    [{ kind: 'permission-missing', permissions: ['workflows'], link: 'https://github.com/settings/installations/1' }, 'Приложению не хватает прав: workflows'],
    [{ kind: 'tampered' }, 'Консоль не смогла открыть чистый PR'],
    [{ kind: 'downgrade', pins: ['runner'] }, 'более новые версии (runner)'],
    [{ kind: 'misconfigured' }, 'ошибка на нашей стороне'],
    [{ kind: 'unverified' }, 'не смогла подтвердить репозиторий'],
    [{ kind: 'offline' }, 'Нет сети. PR не открыт'],
    [{ kind: 'failed' }, 'PR не открылся'],
  ] as [WorkflowPrRefusal, string][])('words the %o refusal', async (problem, text) => {
    const { find, click } = await render(MISSING, () => ({ ok: false, problem }));
    await click('workflow-open-pr');
    expect(find('workflow-pr-error')?.textContent).toContain(text);
  });

  it('re-checks when the file is already current', async () => {
    const { find, click, rechecks } = await render(MISSING, () => ({ ok: false, problem: { kind: 'ready' } }));
    await click('workflow-open-pr');
    expect(find('workflow-pr-error')?.textContent).toContain('Файл уже на месте');
    expect(rechecks).toHaveLength(1);
  });

  it('says when a PR can be opened again after a 429', async () => {
    const { find, click } = await render(MISSING, () => ({ ok: false, problem: { kind: 'rate', retryAt: '2026-11-21T13:00:00.000Z' } }));
    await click('workflow-open-pr');
    expect(find('workflow-pr-rate')?.textContent).toContain('PR можно открыть ещё раз позже');
  });

  it('leads with the Copy path while the app lacks its permissions', async () => {
    const { find } = await render(
      actionsSetupFixture({ items: { 'app-permissions': { status: 'missing' }, workflow: { status: 'missing' } } }),
    );
    expect(find('workflow-open-pr')).toBeNull();
    expect(find('workflow-copy-reason')?.textContent).toContain('когда приложение получит права');
    expect(find('workflow-show-file')?.className).toContain('primary');
  });
});
