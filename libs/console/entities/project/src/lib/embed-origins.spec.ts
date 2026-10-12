import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { EmbedOriginsApi, embedOriginsUrl, isEmbedOriginsDto, UnexpectedEmbedOriginsResponse } from './embed-origins';

describe('isEmbedOriginsDto', () => {
  it('accepts exact origins', () => {
    expect(
      isEmbedOriginsDto({ embedOrigins: ['https://a.pages.dev', 'https://b.workers.dev:8443'] }),
    ).toBe(true);
    expect(isEmbedOriginsDto({ embedOrigins: [] })).toBe(true);
  });

  it.each([
    null,
    [],
    {},
    { embedOrigins: 'https://a.pages.dev' },
    { embedOrigins: ['https://a.pages.dev/'] },
    { embedOrigins: ['https://a.pages.dev/path'] },
    { embedOrigins: ['a.pages.dev'] },
    { embedOrigins: ['javascript:alert(1)'] },
    { embedOrigins: [42] },
  ])('refuses %j', (value) => {
    expect(isEmbedOriginsDto(value)).toBe(false);
  });
});

describe('EmbedOriginsApi', () => {
  function setup() {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    return { api: TestBed.inject(EmbedOriginsApi), http: TestBed.inject(HttpTestingController) };
  }

  it('reads the project\'s origins with the slug encoded', async () => {
    const { api, http } = setup();
    const answer = api.origins('team-console');
    http.expectOne(embedOriginsUrl('team-console')).flush({ embedOrigins: ['https://a.pages.dev'] });
    await expect(answer).resolves.toEqual(['https://a.pages.dev']);
    expect(embedOriginsUrl('a/b')).toBe('/api/v1/projects/a%2Fb/embed-origins');
  });

  it('refuses a response of another shape', async () => {
    const { api, http } = setup();
    const answer = api.origins('tc');
    http.expectOne(embedOriginsUrl('tc')).flush({ embedOrigins: ['https://a.pages.dev/x'] });
    await expect(answer).rejects.toBeInstanceOf(UnexpectedEmbedOriginsResponse);
  });
});
