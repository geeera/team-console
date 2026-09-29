import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideAppConfig } from '@console/shared/config';
import { provideConsoleI18n } from '@console/shared/i18n';
import { App } from './app';
import { appRoutes } from './app.routes';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter(appRoutes),
        provideConsoleI18n(),
        provideAppConfig({ name: 'Team Console', version: '0.0.0', builtAt: 'local' }),
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
  });

  it('routes the root URL to the hello page', async () => {
    const harness = await RouterTestingHarness.create('/');

    expect(harness.routeNativeElement?.querySelector('h1')?.textContent?.trim()).toBe('Привет, консоль');
  });

  it('sends unknown URLs back to the root', async () => {
    const harness = await RouterTestingHarness.create('/nowhere');

    expect(harness.routeNativeElement?.querySelector('h1')).not.toBeNull();
  });
});
