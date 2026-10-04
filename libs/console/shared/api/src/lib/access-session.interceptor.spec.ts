import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, type Observable } from 'rxjs';
import { provideConsoleApi } from './api.providers';
import {
  REAUTH_ENVIRONMENT,
  REAUTH_FLAG_KEY,
  REAUTH_LOOP_GUARD_MS,
  type ReauthEnvironment,
} from './access-session.interceptor';

const PROBLEM = 'application/problem+json; charset=utf-8';
const NOW = 1_800_000_000_000;

class FakeReauthEnvironment implements ReauthEnvironment {
  flag: string | null = null;
  online = true;
  storageWorks = true;
  reloads = 0;
  now = (): number => NOW;
  isOnline = (): boolean => this.online;
  readFlag = (): string | null => this.flag;
  writeFlag = (value: string): boolean => {
    if (!this.storageWorks) {
      return false;
    }
    this.flag = value;
    return true;
  };
  reload = (): void => {
    this.reloads += 1;
  };
}

let fake: FakeReauthEnvironment;
let http: HttpClient;
let controller: HttpTestingController;

beforeEach(() => {
  fake = new FakeReauthEnvironment();
  TestBed.configureTestingModule({
    providers: [
      provideConsoleApi(),
      provideHttpClientTesting(),
      { provide: REAUTH_ENVIRONMENT, useValue: fake },
    ],
  });
  http = TestBed.inject(HttpClient);
  controller = TestBed.inject(HttpTestingController);
});

afterEach(() => controller.verify());

/** Subscribes and records how the call ended; `pending` means it neither emitted, errored nor completed. */
function track<T>(source: Observable<T>): {
  outcome: () => 'pending' | 'value' | 'error' | 'complete';
  error: () => unknown;
} {
  let outcome: 'pending' | 'value' | 'error' | 'complete' = 'pending';
  let caught: unknown;
  source.subscribe({
    next: () => (outcome = 'value'),
    error: (error: unknown) => {
      outcome = 'error';
      caught = error;
    },
    complete: () => {
      if (outcome === 'pending') {
        outcome = 'complete';
      }
    },
  });
  return { outcome: () => outcome, error: () => caught };
}

function problemBody(slug: string, status = 401): object {
  return { type: `https://team-console/problems/${slug}`, title: 'Unauthorized', status };
}

describe('accessSessionInterceptor', () => {
  it('passes successful JSON responses through untouched', async () => {
    const response = firstValueFrom(http.get('/api/v1/projects'));
    controller.expectOne('/api/v1/projects').flush([]);

    await expect(response).resolves.toEqual([]);
    expect(fake.reloads).toBe(0);
  });

  it('reloads when the request fails at the network level (status 0: cross-origin Access redirect)', () => {
    const call = track(http.get('/api/v1/projects'));
    controller.expectOne('/api/v1/projects').error(new ProgressEvent('error'));

    expect(fake.reloads).toBe(1);
    expect(fake.flag).toBe(String(NOW));
    expect(call.outcome()).toBe('pending');
  });

  it('reloads when the API answers with an HTML page (Access login) instead of JSON', () => {
    const call = track(http.get('/api/v1/projects'));
    controller.expectOne('/api/v1/projects').flush('<!doctype html><title>Sign in</title>', {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });

    expect(fake.reloads).toBe(1);
    expect(call.outcome()).toBe('pending');
  });

  it('reloads when parsing the HTML page as JSON already failed (status 200, text/html)', () => {
    const call = track(http.get('/api/v1/projects'));
    controller.expectOne('/api/v1/projects').error(new ProgressEvent('error'), {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'text/html' },
    });

    expect(fake.reloads).toBe(1);
    expect(call.outcome()).toBe('pending');
  });

  it('leaves non-JSON bodies alone when the caller asked for text', async () => {
    const response = firstValueFrom(http.get('/api/v1/export', { responseType: 'text' }));
    controller
      .expectOne('/api/v1/export')
      .flush('a,b', { status: 200, statusText: 'OK', headers: { 'Content-Type': 'text/csv' } });

    await expect(response).resolves.toBe('a,b');
    expect(fake.reloads).toBe(0);
  });

  it.each(['access-missing', 'access-unverified'])('reloads on 401 %s', (slug) => {
    track(http.get('/api/v1/projects'));
    controller.expectOne('/api/v1/projects').flush(problemBody(slug), {
      status: 401,
      statusText: 'Unauthorized',
      headers: { 'Content-Type': PROBLEM },
    });

    expect(fake.reloads).toBe(1);
  });

  it.each(['access-forbidden', 'access-misconfigured'])(
    'does not reload on 401 %s — signing in again cannot fix it',
    (slug) => {
      const call = track(http.get('/api/v1/projects'));
      controller.expectOne('/api/v1/projects').flush(problemBody(slug), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'Content-Type': PROBLEM },
      });

      expect(fake.reloads).toBe(0);
      expect(call.outcome()).toBe('error');
      expect(call.error()).toBeInstanceOf(HttpErrorResponse);
    },
  );

  it('does not reload on other JSON API errors', () => {
    const call = track(http.get('/api/v1/nope'));
    controller.expectOne('/api/v1/nope').flush(problemBody('not-found', 404), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'Content-Type': PROBLEM },
    });

    expect(fake.reloads).toBe(0);
    expect(call.outcome()).toBe('error');
  });

  describe('loop guard', () => {
    it('does not reload a second time within 30 s and surfaces the error instead', () => {
      fake.flag = String(NOW - (REAUTH_LOOP_GUARD_MS - 1));
      const call = track(http.get('/api/v1/projects'));
      controller.expectOne('/api/v1/projects').error(new ProgressEvent('error'));

      expect(fake.reloads).toBe(0);
      expect(call.outcome()).toBe('error');
      expect((call.error() as HttpErrorResponse).status).toBe(0);
    });

    it('reloads again once the last reload is older than 30 s', () => {
      fake.flag = String(NOW - REAUTH_LOOP_GUARD_MS);
      track(http.get('/api/v1/projects'));
      controller.expectOne('/api/v1/projects').error(new ProgressEvent('error'));

      expect(fake.reloads).toBe(1);
      expect(fake.flag).toBe(String(NOW));
    });

    it('treats a corrupt flag as no previous reload', () => {
      fake.flag = 'not-a-number';
      track(http.get('/api/v1/projects'));
      controller.expectOne('/api/v1/projects').error(new ProgressEvent('error'));

      expect(fake.reloads).toBe(1);
    });

    it('does not reload when the flag cannot be stored — no guard, no reload', () => {
      fake.storageWorks = false;
      const call = track(http.get('/api/v1/projects'));
      controller.expectOne('/api/v1/projects').error(new ProgressEvent('error'));

      expect(fake.reloads).toBe(0);
      expect(call.outcome()).toBe('error');
    });
  });

  it('does not reload while offline — a reload cannot fix the network', () => {
    fake.online = false;
    const call = track(http.get('/api/v1/projects'));
    controller.expectOne('/api/v1/projects').error(new ProgressEvent('error'));

    expect(fake.reloads).toBe(0);
    expect(call.outcome()).toBe('error');
  });

  it('does not reload a POST on status 0 — the response may have been lost after the write landed', () => {
    const call = track(http.post('/api/v1/questions/1/answer', { body: 'hi' }));
    controller.expectOne('/api/v1/questions/1/answer').error(new ProgressEvent('error'));

    expect(fake.reloads).toBe(0);
    expect(call.outcome()).toBe('error');
    expect((call.error() as HttpErrorResponse).status).toBe(0);
  });

  it('still reloads a GET on status 0 — existing Access-session behaviour', () => {
    const call = track(http.get('/api/v1/projects'));
    controller.expectOne('/api/v1/projects').error(new ProgressEvent('error'));

    expect(fake.reloads).toBe(1);
    expect(call.outcome()).toBe('pending');
  });

  it('ignores requests that are not to our /api', () => {
    const call = track(http.get('https://api.github.com/zen'));
    controller.expectOne('https://api.github.com/zen').error(new ProgressEvent('error'));

    expect(fake.reloads).toBe(0);
    expect(call.outcome()).toBe('error');
  });
});

describe('REAUTH_ENVIRONMENT default (browser)', () => {
  beforeEach(() => {
    controller.verify();
    TestBed.resetTestingModule();
    sessionStorage.clear();
  });

  it('keeps the loop-guard flag in sessionStorage under tc.reauth', () => {
    const browser = TestBed.inject(REAUTH_ENVIRONMENT);

    expect(browser.readFlag()).toBeNull();
    expect(browser.writeFlag('123')).toBe(true);
    expect(browser.readFlag()).toBe('123');
    expect(sessionStorage.getItem(REAUTH_FLAG_KEY)).toBe('123');
  });

  it('reports a refused write instead of throwing', () => {
    const browser = TestBed.inject(REAUTH_ENVIRONMENT);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    expect(browser.writeFlag('1')).toBe(false);
    setItem.mockRestore();
  });
});
