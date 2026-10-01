import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PROJECTS_URL, ProjectsStore } from '@console/entities/project';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Toaster } from '@console/shared/ui';
import { ArchiveProject, archiveUrlOf } from './archive-project';

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
  }
}

const overlay = (): HTMLElement => document.querySelector('.cdk-overlay-container') as HTMLElement;

describe('ArchiveProject', () => {
  let http: HttpTestingController;
  let archiver: ArchiveProject;
  let projects: ProjectsStore;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideConsoleI18n(), provideHttpClient(), provideHttpClientTesting()],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    archiver = TestBed.inject(ArchiveProject);
    projects = TestBed.inject(ProjectsStore);
    const loaded = projects.load();
    http
      .expectOne(PROJECTS_URL)
      .flush([
        {
          slug: 'storify',
          repo: 'geeera/storify',
          displayName: 'Storify',
          routineId: null,
          addedAt: '2026-09-29T00:00:00.000Z',
          archivedAt: null,
        },
      ]);
    await loaded;
  });

  afterEach(() => {
    overlay()?.remove();
    http.verify();
  });

  it('asks with the approved copy, archives, removes the project and shows the toast', async () => {
    const done = archiver.archive({ slug: 'storify', displayName: 'Storify' });
    await settle();
    expect(overlay().textContent).toContain('Архивировать Storify?');
    expect(overlay().textContent).toContain('Установка приложения и рутина останутся.');

    (overlay().querySelector('.tc-confirm__ok') as HTMLButtonElement).click();
    await settle();
    http.expectOne(archiveUrlOf('storify')).flush(null, { status: 204, statusText: 'No Content' });

    await expect(done).resolves.toBe(true);
    expect(projects.isActive('storify')).toBe(false);
    expect(TestBed.inject(Toaster).message()).toBe('Storify в архиве');
  });

  it('a project already archived elsewhere (404) counts as archived', async () => {
    const done = archiver.archive({ slug: 'storify', displayName: 'Storify' });
    await settle();
    (overlay().querySelector('.tc-confirm__ok') as HTMLButtonElement).click();
    await settle();
    http.expectOne(archiveUrlOf('storify')).flush(null, { status: 404, statusText: 'Not Found' });

    await expect(done).resolves.toBe(true);
    expect(projects.isActive('storify')).toBe(false);
  });
});
