import { HttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { provideConsoleApi } from './api.providers';

describe('provideConsoleApi', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideConsoleApi(), provideHttpClientTesting()] });
  });

  it('provides an HttpClient that sends requests unchanged', async () => {
    const http = TestBed.inject(HttpClient);
    const controller = TestBed.inject(HttpTestingController);

    const response = firstValueFrom(http.get<{ ok: boolean }>('/api/v1/healthz'));
    const request = controller.expectOne('/api/v1/healthz');
    expect(request.request.method).toBe('GET');
    request.flush({ ok: true });

    await expect(response).resolves.toEqual({ ok: true });
    controller.verify();
  });
});
