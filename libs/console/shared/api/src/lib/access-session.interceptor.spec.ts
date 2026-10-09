import {
  HttpClient,
  HttpErrorResponse,
  HttpRequest,
  type HttpEvent,
  type HttpHandlerFn,
} from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, lastValueFrom, throwError, type Observable } from 'rxjs';
import { accessSessionInterceptor } from './access-session.interceptor';
import { AccessSession, PAGE_LOCATION, type PageLocation } from './access-session.store';
import { provideConsoleApi } from './api.providers';

const PROBLEM = 'application/problem+json; charset=utf-8';

class FakeLocation implements PageLocation {
  href = 'https://console.test/p/demo/board?lane=review';
  readonly assigned: string[] = [];
  assign(url: string): void {
    this.assigned.push(url);
  }
}

let location: FakeLocation;
let http: HttpClient;
let controller: HttpTestingController;
let session: AccessSession;

beforeEach(() => {
  location = new FakeLocation();
  TestBed.configureTestingModule({
    providers: [
      provideConsoleApi(),
      provideHttpClientTesting(),
      { provide: PAGE_LOCATION, useValue: location },
    ],
  });
  http = TestBed.inject(HttpClient);
  controller = TestBed.inject(HttpTestingController);
  session = TestBed.inject(AccessSession);
});

afterEach(() => controller.verify());

async function failureOf(call: Observable<unknown>): Promise<HttpErrorResponse> {
  try {
    await firstValueFrom(call);
  } catch (error: unknown) {
    if (error instanceof HttpErrorResponse) {
      return error;
    }
    throw error;
  }
  throw new Error('the call succeeded');
}

/** Runs the interceptor alone against a backend answer TestRequest cannot express (an opaque redirect). */
function intercept(request: HttpRequest<unknown>, answer: HttpErrorResponse): Observable<HttpEvent<unknown>> {
  const next: HttpHandlerFn = () => throwError(() => answer);
  return TestBed.runInInjectionContext(() => accessSessionInterceptor(request, next));
}

describe('accessSessionInterceptor', () => {
  it('sends /api calls past the service worker with redirects left to us', async () => {
    const response = firstValueFrom(http.get('/api/v1/projects'));
    const request = controller.expectOne('/api/v1/projects');

    expect(request.request.redirect).toBe('manual');
    expect(request.request.headers.get('ngsw-bypass')).toBe('true');
    request.flush([]);
    await response;
  });

  it('passes successful JSON responses through untouched', async () => {
    const response = firstValueFrom(http.get('/api/v1/projects'));
    controller.expectOne('/api/v1/projects').flush([]);

    await expect(response).resolves.toEqual([]);
    expect(session.expired()).toBe(false);
  });

  it("marks the session expired on Access's redirect and still fails the call", async () => {
    const redirect = new HttpErrorResponse({
      status: 0,
      responseType: 'opaqueredirect',
      url: '/api/v1/projects',
    });

    await expect(lastValueFrom(intercept(new HttpRequest('GET', '/api/v1/projects'), redirect))).rejects.toBe(
      redirect,
    );
    expect(session.expired()).toBe(true);
  });

  it('marks it on a write too: the redirect means the write never reached the Worker', async () => {
    const redirect = new HttpErrorResponse({ status: 0, responseType: 'opaqueredirect' });

    await expect(
      lastValueFrom(intercept(new HttpRequest('POST', '/api/v1/projects/a/issues/1/answer', {}), redirect)),
    ).rejects.toBe(redirect);
    expect(session.expired()).toBe(true);
  });

  it('turns an HTML page delivered as 200 for a JSON call into an error and marks the session', async () => {
    const response = failureOf(http.get('/api/v1/projects'));
    controller.expectOne('/api/v1/projects').flush('<!doctype html><title>Sign in</title>', {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });

    expect((await response).status).toBe(200);
    expect(session.expired()).toBe(true);
  });

  it('leaves non-JSON bodies alone when the caller asked for text', async () => {
    const response = firstValueFrom(http.get('/api/v1/export', { responseType: 'text' }));
    controller
      .expectOne('/api/v1/export')
      .flush('a,b', { status: 200, statusText: 'OK', headers: { 'Content-Type': 'text/csv' } });

    await expect(response).resolves.toBe('a,b');
    expect(session.expired()).toBe(false);
  });

  it('marks it on our 401 access-missing', async () => {
    const response = failureOf(http.get('/api/v1/projects'));
    controller
      .expectOne('/api/v1/projects')
      .flush(
        { type: 'https://team-console/problems/access-missing', title: 'Unauthorized', status: 401 },
        { status: 401, statusText: 'Unauthorized', headers: { 'Content-Type': PROBLEM } },
      );

    expect((await response).status).toBe(401);
    expect(session.expired()).toBe(true);
  });

  it('does not mark it when the connection dropped — that is the offline state, not a login', async () => {
    const response = failureOf(http.get('/api/v1/projects'));
    controller.expectOne('/api/v1/projects').error(new ProgressEvent('error'));

    expect((await response).status).toBe(0);
    expect(session.expired()).toBe(false);
  });

  it('does not touch requests that are not to our /api', async () => {
    const response = failureOf(http.get('https://api.github.com/zen'));
    const request = controller.expectOne('https://api.github.com/zen');
    expect(request.request.headers.has('ngsw-bypass')).toBe(false);
    request.flush('<!doctype html>', {
      status: 401,
      statusText: 'Unauthorized',
      headers: { 'Content-Type': 'text/html' },
    });

    expect((await response).status).toBe(401);
    expect(session.expired()).toBe(false);
  });
});

describe('AccessSession.signIn', () => {
  it('navigates the whole page to where the owner is, past the service worker', () => {
    session.signIn();

    expect(location.assigned).toEqual(['https://console.test/p/demo/board?lane=review&ngsw-bypass=1']);
  });
});
