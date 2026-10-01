import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { DeploymentStore, HEALTH_URL } from './deployment.store';

describe('DeploymentStore', () => {
  let store: DeploymentStore;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    store = TestBed.inject(DeploymentStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('reads the environment once', async () => {
    const first = store.ensureLoaded();
    const second = store.ensureLoaded();
    http.expectOne(HEALTH_URL).flush({ status: 'ok', environment: 'dev', version: '0.1.0' });
    await Promise.all([first, second]);

    expect(store.environment()).toBe('dev');
    await store.ensureLoaded();
  });

  it('stays unknown on a failure or an unexpected value, and tries again next time', async () => {
    const failed = store.ensureLoaded();
    http.expectOne(HEALTH_URL).flush(null, { status: 502, statusText: 'Bad Gateway' });
    await failed;
    expect(store.environment()).toBeNull();

    const odd = store.ensureLoaded();
    http.expectOne(HEALTH_URL).flush({ environment: 'prod; rm -rf' });
    await odd;
    expect(store.environment()).toBeNull();
  });
});
