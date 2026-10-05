import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { ProjectNotFoundPage } from './project-not-found.page';

describe('ProjectNotFoundPage', () => {
  async function open(url: string) {
    await TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            {
              path: 'p/:slug',
              component: ProjectNotFoundPage,
              data: { reason: 'project' },
              children: [{ path: '**', children: [] }],
            },
            { path: '**', component: ProjectNotFoundPage, data: { reason: 'route' } },
          ],
          withComponentInputBinding(),
        ),
        provideConsoleI18n(),
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const harness = await RouterTestingHarness.create(url);
    return { root: harness.routeNativeElement as HTMLElement, router: TestBed.inject(Router) };
  }

  it('names the missing project, keeps the URL and links back to the root', async () => {
    const { root, router } = await open('/p/ghost/chat');

    expect(router.url).toBe('/p/ghost/chat');
    const alert = root.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('Проект не найден');
    expect(alert.textContent).toContain('«ghost»');
    expect(root.querySelector('[data-testid="not-found-back"]')?.getAttribute('href')).toBe('/');
    expect(root.querySelectorAll('h1')).toHaveLength(1);
  });

  it('has a route variant for any other unknown URL', async () => {
    const { root } = await open('/nowhere/at/all');

    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Такой страницы нет');
  });

  it('rings an archived project’s notification arrival and leads back to Needs you', async () => {
    const { root } = await open('/p/oldmap/questions#7');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const block = root.querySelector('tc-state-block') as HTMLElement;
    expect(block.textContent).toContain('Его уведомления ведут сюда');
    expect(block.textContent).not.toContain('oldmap');
    expect(block.classList).toContain('tc-arrival');
    expect(document.activeElement).toBe(block);
    expect(root.querySelector('[data-testid="not-found-back"]')?.getAttribute('href')).toBe('/needs-you');
  });

  it('keeps the plain wording for a fragment that is not an issue number', async () => {
    const { root } = await open('/p/oldmap/questions#abc');
    expect(root.textContent).toContain('«oldmap»');
    expect(root.querySelector('tc-state-block')?.classList).not.toContain('tc-arrival');
  });
});
