import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Route } from '@angular/router';
import { HEALTH_URL } from '@console/entities/app-info';
import { provideConsoleI18n } from '@console/shared/i18n';
import { consoleEnvironmentRoutes, environmentRoutes } from './environment.routes';

@Component({ template: '' })
class Blank {}

/** The real redirects and guards, with the screens they open swapped for a blank page (no network). */
function withBlankPages(routes: readonly Route[]): Route[] {
  return routes.map((route): Route => {
    const { loadComponent, children, ...rest } = route;
    return {
      ...rest,
      ...(loadComponent === undefined ? {} : { component: Blank }),
      ...(children === undefined ? {} : { children: withBlankPages(children) }),
    };
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
  }
}

describe('environment routes: the old addresses redirect (#750 UX spec §7)', () => {
  let router: Router;
  let http: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'admin', children: withBlankPages(consoleEnvironmentRoutes) },
          { path: 'settings', children: withBlankPages(environmentRoutes) },
        ]),
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    router = TestBed.inject(Router);
    http = TestBed.inject(HttpTestingController);
  });

  /** Navigates and answers the one question a guard may ask: which environment this console is. */
  async function go(url: string): Promise<string> {
    let done = false;
    const navigation = router.navigateByUrl(url).then(() => {
      done = true;
    });
    for (let i = 0; i < 100 && !done; i += 1) {
      for (const request of http.match(HEALTH_URL)) {
        request.flush({ environment: 'stage' });
      }
      await settle();
    }
    await navigation;
    return router.url;
  }

  it.each([
    ['/settings/environment', '/admin/environment/stage'],
    ['/settings/environment/production', '/admin/environment/production'],
    [
      '/settings/environment/production/project/storify/ROUTINE_TOKEN_STORIFY',
      '/settings/projects/storify/environment/production/ROUTINE_TOKEN_STORIFY',
    ],
    ['/settings/environment/production/api/OWNER_EMAIL', '/admin/environment/production/api/OWNER_EMAIL'],
    [
      '/admin/environment/production/project/storify/SLOT_TOKEN_STORIFY_PM',
      '/settings/projects/storify/environment/production/SLOT_TOKEN_STORIFY_PM',
    ],
    ['/admin/environment', '/admin/environment/stage'],
    ['/admin/environment/qa', '/admin/environment/stage'],
  ])('%s → %s', async (from, to) => {
    expect(await go(from)).toBe(to);
  });

  it('keeps the query and the fragment', async () => {
    expect(
      await go('/settings/environment/production/project/storify/ROUTINE_TOKEN_STORIFY?from=mail#how'),
    ).toBe('/settings/projects/storify/environment/production/ROUTINE_TOKEN_STORIFY?from=mail#how');
    expect(await go('/settings/environment?x=1#top')).toBe('/admin/environment/stage?x=1#top');
  });
});
