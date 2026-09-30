import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PROJECTS_URL, ProjectsStore } from '@console/entities/project';
import { provideConsoleI18n } from '@console/shared/i18n';
import { ProjectDto } from '@shared/contracts';
import { NeedsYouPage } from './needs-you.page';

describe('NeedsYouPage', () => {
  async function render(list: ProjectDto[]) {
    await TestBed.configureTestingModule({
      imports: [NeedsYouPage],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), provideConsoleI18n()],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const ready = TestBed.inject(ProjectsStore).ready();
    TestBed.inject(HttpTestingController).expectOne(PROJECTS_URL).flush(list);
    await ready;
    const fixture = TestBed.createComponent(NeedsYouPage);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('with no projects it is the empty state that points to Settings', async () => {
    const root = await render([]);

    expect(root.querySelector('h1')?.textContent?.trim()).toBe('Ждут тебя');
    const block = root.querySelector('[data-testid="no-projects"]') as HTMLElement;
    expect(block.textContent).toContain('Проектов пока нет');
    expect(block.querySelector('a')?.getAttribute('href')).toBe('/settings');
  });

  it('with projects it shows the placeholder empty inbox', async () => {
    const root = await render([
      {
        slug: 'a',
        repo: 'g/a',
        displayName: 'A',
        routineId: null,
        addedAt: '2026-09-29T00:00:00Z',
        archivedAt: null,
      },
    ]);

    expect(root.querySelector('[data-testid="no-projects"]')).toBeNull();
    expect(root.textContent).toContain('От тебя сейчас ничего не нужно');
  });
});
