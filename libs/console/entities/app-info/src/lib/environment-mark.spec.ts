import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import type { Environment } from '@shared/contracts';
import { HEALTH_URL } from './deployment.store';
import { EnvironmentMark } from './environment-mark';

describe('EnvironmentMark (#237)', () => {
  let fixture: ComponentFixture<EnvironmentMark>;
  let http: HttpTestingController;

  const chip = (): HTMLElement | null =>
    (fixture.nativeElement as HTMLElement).querySelector('[data-testid="environment-mark"]');

  async function render(environment: Environment | null): Promise<void> {
    TestBed.configureTestingModule({
      imports: [EnvironmentMark],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideConsoleI18n()],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(EnvironmentMark);
    const request = http.expectOne(HEALTH_URL);
    if (environment === null) {
      request.flush(null, { status: 502, statusText: 'Bad Gateway' });
    } else {
      request.flush({ status: 'ok', environment, version: '0.1.0' });
    }
    await fixture.whenStable();
  }

  afterEach(() => http.verify());

  it.each([
    ['dev', 'Dev', 'tc-chip--warning'],
    ['stage', 'Stage', 'tc-chip--danger'],
    ['local', 'Local', null],
  ] as const)('names %s in text, with the environment spelled out for a screen reader', async (environment, label, tone) => {
    await render(environment);

    expect(chip()?.textContent?.replace(/\s+/g, ' ').trim()).toBe(`Окружение: ${label}`);
    expect(chip()?.querySelector('.tc-sr-only')?.textContent?.trim()).toBe('Окружение:');
    if (tone !== null) {
      expect(chip()?.classList).toContain(tone);
    }
  });

  it('shows nothing in production', async () => {
    await render('production');

    expect(chip()).toBeNull();
    expect((fixture.nativeElement as HTMLElement).textContent?.trim()).toBe('');
  });

  it('shows nothing while the environment is unknown', async () => {
    await render(null);

    expect(chip()).toBeNull();
  });
});
