import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ItemsApi, type TrackerRead } from '@console/entities/item';
import { ProjectsStore } from '@console/entities/project';
import { provideConsoleI18n } from '@console/shared/i18n';
import {
  memoryPersistedStateStorage,
  PERSISTED_STATE_STORAGE,
  PersistedStateStore,
} from '@console/shared/persisted-state';
import type { ProjectDto, TrackerSprintDto } from '@shared/contracts';
import { NewTaskButton } from './new-task-button';
import { QuickTask } from './quick-task';

const project = (slug: string, tracker: 'github' | 'console'): ProjectDto =>
  ({ slug, displayName: slug, repo: `geeera/${slug}`, archivedAt: null, tracker }) as ProjectDto;

@Component({
  imports: [NewTaskButton],
  template: `<tc-new-task-button [slug]="slug()" />`,
})
class Host {
  readonly slug = signal<string | null>('team-console');
}

async function render(read: TrackerRead<TrackerSprintDto[]>, projects: ProjectDto[]) {
  const open = vi.fn(async () => null);
  TestBed.configureTestingModule({
    providers: [
      provideConsoleI18n(),
      { provide: PERSISTED_STATE_STORAGE, useValue: memoryPersistedStateStorage() },
      { provide: ItemsApi, useValue: { sprints: async () => read } },
      { provide: ProjectsStore, useValue: { active: signal(projects) } },
      { provide: QuickTask, useValue: { open } },
    ],
  });
  await TestBed.inject(ApplicationInitStatus).donePromise;
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  return {
    root,
    open,
    fixture,
    button: () => root.querySelector<HTMLButtonElement>('[data-testid="new-task-open"]'),
  };
}

describe('NewTaskButton (#107)', () => {
  it('shows New task with T on a console-tracker project and opens it on T', async () => {
    const { button, open } = await render({ ok: true, value: [] }, [project('team-console', 'console')]);
    expect(button()?.getAttribute('aria-label')).toBe('Новая задача');
    expect(button()?.getAttribute('aria-keyshortcuts')).toBe('T');

    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT', key: 't', bubbles: true }));
    expect(open).toHaveBeenCalledWith('team-console');
  });

  it('is hidden for an identity the tracker refuses (the service, a job): 403 on the sprints read', async () => {
    const { button, open } = await render({ ok: false, reason: 'forbidden' }, [
      project('team-console', 'console'),
    ]);
    expect(button()).toBeNull();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT', key: 't', bubbles: true }));
    expect(open).not.toHaveBeenCalled();
  });

  it('is hidden on a project still on GitHub', async () => {
    const { button } = await render({ ok: true, value: [] }, [project('team-console', 'github')]);
    expect(button()).toBeNull();
  });
});
