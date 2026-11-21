import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ActionsSetupApi, actionsSetupFixture } from '@console/entities/actions-setup';
import { ProjectsStore } from '@console/entities/project';
import { RunnersApi, runnerFailureOf, type RunnerResult } from '@console/entities/runner';
import { provideConsoleI18n } from '@console/shared/i18n';
import { PROBLEM_TYPE_PREFIX, type ActionsSetupDto, type ProjectDispatch, type ProjectDispatchDto } from '@shared/contracts';
import { ProjectDispatchEditor } from './project-dispatch-editor';

const PULL: ProjectDispatchDto = { dispatch: 'pull', defaultBranch: null };

function problem(status: number, slug: string, extra: Record<string, unknown> = {}): RunnerResult<ProjectDispatchDto> {
  const error = new HttpErrorResponse({
    status,
    error: { type: `${PROBLEM_TYPE_PREFIX}${slug}`, title: 'x', status, field: 'dispatch', ...extra },
    headers: new HttpHeaders({ 'Content-Type': 'application/problem+json' }),
  });
  return { ok: false, failure: runnerFailureOf(error) };
}

describe('ProjectDispatchEditor (#670)', () => {
  async function render({
    read = (): RunnerResult<ProjectDispatchDto> => ({ ok: true, value: PULL }),
    write = (dispatch: ProjectDispatch): RunnerResult<ProjectDispatchDto> => ({
      ok: true,
      value: { dispatch, defaultBranch: dispatch === 'actions' ? 'main' : null },
    }),
    readiness = (): ActionsSetupDto => actionsSetupFixture(),
  } = {}) {
    const writes: { slug: string; dispatch: ProjectDispatch }[] = [];
    const checks: string[] = [];
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        provideRouter([]),
        {
          provide: ActionsSetupApi,
          useValue: {
            check: async (slug: string) => {
              checks.push(slug);
              return { ok: true, value: readiness() };
            },
          },
        },
        { provide: ProjectsStore, useValue: { bySlug: () => ({ displayName: 'Team Console' }) } },
        {
          provide: RunnersApi,
          useValue: {
            dispatch: async () => read(),
            setDispatch: async (slug: string, dispatch: ProjectDispatch) => {
              writes.push({ slug, dispatch });
              return write(dispatch);
            },
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(ProjectDispatchEditor);
    fixture.componentRef.setInput('slug', 'team-console');
    fixture.componentRef.setInput('teamUrl', '/settings/projects/team-console/team');
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 3; i += 1) {
        await fixture.whenStable();
        await new Promise((resolve) => setTimeout(resolve));
      }
      await fixture.whenStable();
    };
    await settle();
    const root = fixture.nativeElement as HTMLElement;
    const find = <T extends HTMLElement = HTMLElement>(id: string): T | null => root.querySelector<T>(`[data-testid="${id}"]`);
    const choose = async (mode: ProjectDispatch): Promise<void> => {
      const radio = find<HTMLInputElement>(`dispatch-mode-${mode}`) as HTMLInputElement;
      radio.checked = true;
      radio.dispatchEvent(new Event('change'));
      await fixture.whenStable();
    };
    const save = async (): Promise<void> => {
      find<HTMLFormElement>('project-dispatch-form')?.dispatchEvent(new Event('submit'));
      await settle();
    };
    return { root, find, choose, save, writes, checks, fixture, settle };
  }

  it('shows the stored dispatch and says plainly that the Actions minutes are the owner’s spend', async () => {
    const { find } = await render();
    expect(find<HTMLInputElement>('dispatch-mode-pull')?.checked).toBe(true);
    expect(find<HTMLInputElement>('dispatch-mode-actions')?.checked).toBe(false);
    expect(find('project-dispatch-minutes')?.textContent).toContain('Минуты GitHub Actions — это ваши расходы');
    // The note is read with the Actions choice, not only seen near it.
    const described = find('dispatch-mode-actions')?.getAttribute('aria-describedby') ?? '';
    expect(described.split(' ')).toContain(find('project-dispatch-minutes')?.id);
    expect(find('project-dispatch-branch')).toBeNull();
  });

  it('switches to GitHub Actions, then shows the default branch the Worker read from GitHub', async () => {
    const { find, choose, save, writes } = await render();
    await choose('actions');
    await save();
    expect(writes).toEqual([{ slug: 'team-console', dispatch: 'actions' }]);
    expect(find('project-dispatch-saved')?.textContent).toContain('Способ запуска сохранён');
    expect(find('project-dispatch-saved')?.getAttribute('role')).toBe('status');
    expect(find('project-dispatch-branch')?.textContent).toContain('main');
  });

  it.each([
    ['access-source-hosted', 'переключите источник доступа на API-ключ'],
    ['dispatch-repository-unverified', 'не смогла подтвердить репозиторий'],
  ])('explains a %s refusal in an alert and keeps the stored choice', async (slug, text) => {
    const { find, choose, save } = await render({ write: () => problem(422, slug) });
    await choose('actions');
    await save();
    const banner = find('project-dispatch-error');
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(banner?.textContent).toContain(text);
    expect(find('project-dispatch-saved')?.textContent?.trim()).toBe('');
  });

  it('links an access-source refusal to the project’s Team settings, and no other refusal (#688)', async () => {
    const hosted = await render({ write: () => problem(422, 'access-source-hosted') });
    await hosted.choose('actions');
    await hosted.save();
    const link = hosted.find<HTMLAnchorElement>('project-dispatch-team');
    expect(link?.getAttribute('href')).toBe('/settings/projects/team-console/team');
    expect(link?.textContent?.trim()).toBe('Открыть настройки команды');
    TestBed.resetTestingModule();
    const other = await render({ write: () => problem(422, 'dispatch-repository-unverified') });
    await other.choose('actions');
    await other.save();
    expect(other.find('project-dispatch-error')).not.toBeNull();
    expect(other.find('project-dispatch-team')).toBeNull();
  });

  it('checks readiness only once GitHub Actions is chosen, and says the repository is ready (#759)', async () => {
    const { find, choose, settle, checks } = await render();
    expect(find('project-dispatch-readiness')).toBeNull();
    expect(checks).toEqual([]);
    await choose('actions');
    await settle();
    expect(checks).toEqual(['team-console']);
    expect(find('project-dispatch-readiness')?.getAttribute('role')).toBe('status');
    expect(find('project-dispatch-readiness')?.textContent).toContain('Репозиторий готов к GitHub Actions.');
    expect(find('project-dispatch-save')?.getAttribute('aria-disabled')).toBeNull();
  });

  it('holds Save back while the repository is not ready and sends focus to «Подготовить репозиторий»', async () => {
    const { find, choose, save, settle, writes } = await render({
      readiness: () => actionsSetupFixture({ items: { secret: { status: 'missing' }, workflow: { status: 'missing' } } }),
    });
    await choose('actions');
    await settle();
    expect(find('project-dispatch-readiness')?.textContent).toContain('не хватает 2 шагов');
    const link = find<HTMLAnchorElement>('project-dispatch-prepare');
    expect(link?.getAttribute('href')).toBe('/settings/projects/team-console/actions?from=runners');
    const button = find('project-dispatch-save');
    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.getAttribute('aria-describedby')).toBe(find('project-dispatch-readiness')?.id);
    await save();
    expect(writes).toEqual([]);
    expect(document.activeElement).toBe(link);
  });

  it('names the items of an actions-not-ready refusal and links the setup page', async () => {
    const { find, choose, save } = await render({
      write: () => problem(422, 'actions-not-ready', { items: ['workflow', 'secret'] }),
    });
    await choose('actions');
    await save();
    expect(find('project-dispatch-error')?.textContent).toContain(
      'GitHub Actions для Team Console ещё не готов: ключ TC_INFERENCE_API_KEY, файл workflow. Ничего не изменилось.',
    );
    expect(find<HTMLAnchorElement>('project-dispatch-prepare-refusal')?.getAttribute('href')).toBe(
      '/settings/projects/team-console/actions?from=runners',
    );
  });

  it('offers a retry when the dispatch cannot be read', async () => {
    const { find } = await render({ read: () => problem(403, 'owner-only') });
    expect(find('project-dispatch-load-error')).not.toBeNull();
    expect(find('project-dispatch-form')).toBeNull();
  });
});
