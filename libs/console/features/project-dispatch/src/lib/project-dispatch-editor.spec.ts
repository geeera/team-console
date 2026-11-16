import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { RunnersApi, runnerFailureOf, type RunnerResult } from '@console/entities/runner';
import { provideConsoleI18n } from '@console/shared/i18n';
import { PROBLEM_TYPE_PREFIX, type ProjectDispatch, type ProjectDispatchDto } from '@shared/contracts';
import { ProjectDispatchEditor } from './project-dispatch-editor';

const PULL: ProjectDispatchDto = { dispatch: 'pull', defaultBranch: null };

function problem(status: number, slug: string): RunnerResult<ProjectDispatchDto> {
  const error = new HttpErrorResponse({
    status,
    error: { type: `${PROBLEM_TYPE_PREFIX}${slug}`, title: 'x', status, field: 'dispatch' },
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
  } = {}) {
    const writes: { slug: string; dispatch: ProjectDispatch }[] = [];
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
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
    return { root, find, choose, save, writes, fixture };
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
    ['dispatch-placement-conflict', 'Сначала выберите «Любой раннер»'],
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

  it('offers a retry when the dispatch cannot be read', async () => {
    const { find } = await render({ read: () => problem(403, 'owner-only') });
    expect(find('project-dispatch-load-error')).not.toBeNull();
    expect(find('project-dispatch-form')).toBeNull();
  });
});
