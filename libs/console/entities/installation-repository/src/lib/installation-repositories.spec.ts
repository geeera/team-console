import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { InstallationRepositoryDto } from '@shared/contracts';
import {
  InstallationRepositoriesApi,
  UnexpectedInstallationRepositoriesResponse,
  isInstallationRepositoriesDto,
  repositoryGroupsOf,
} from './installation-repositories';

const URL = '/api/v1/github/installation/repositories';

const repo = (
  fullName: string,
  registration: InstallationRepositoryDto['registration'] = { state: 'none' },
) => ({
  fullName,
  private: false,
  registration,
});

const dto = (overrides: Record<string, unknown> = {}) => ({
  repositories: [
    repo('geeera/storify'),
    repo('geeera/team-console', { state: 'active', slug: 'team-console' }),
  ],
  partial: false,
  selectionUrl: 'https://github.com/settings/installations/1001',
  ...overrides,
});

describe('isInstallationRepositoriesDto', () => {
  it('accepts the Worker answer, empty lists and archived rows included', () => {
    expect(isInstallationRepositoriesDto(dto())).toBe(true);
    expect(isInstallationRepositoriesDto(dto({ repositories: [], partial: true }))).toBe(true);
    expect(
      isInstallationRepositoriesDto(
        dto({ repositories: [repo('a/old', { state: 'archived', slug: 'old' })] }),
      ),
    ).toBe(true);
  });

  it.each([
    ['a selection link off github.com', dto({ selectionUrl: 'https://evil.example/settings' })],
    ['a javascript: selection link', dto({ selectionUrl: 'javascript:alert(1)' })],
    ['a name that is not owner/name', dto({ repositories: [repo('geeera/a/b')] })],
    ['a name with a query', dto({ repositories: [repo('geeera/a?x=1')] })],
    [
      'an active row without a slug',
      dto({ repositories: [{ ...repo('a/b'), registration: { state: 'active' } }] }),
    ],
    [
      'an unknown registration',
      dto({ repositories: [{ ...repo('a/b'), registration: { state: 'maybe' } }] }),
    ],
    ['private that is not a boolean', dto({ repositories: [{ ...repo('a/b'), private: 'yes' }] })],
    ['no partial flag', { repositories: [], selectionUrl: 'https://github.com/x' }],
    ['not an object', []],
  ])('refuses %s', (_label, value) => {
    expect(isInstallationRepositoriesDto(value)).toBe(false);
  });
});

describe('InstallationRepositoriesApi', () => {
  function setup() {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    return { api: TestBed.inject(InstallationRepositoriesApi), http: TestBed.inject(HttpTestingController) };
  }

  it('reads the list, and with fresh asks the Worker to bypass its cache', async () => {
    const { api, http } = setup();
    const plain = api.load();
    http.expectOne(URL).flush(dto());
    await expect(plain).resolves.toEqual(dto());

    const fresh = api.load({ fresh: true });
    http.expectOne(`${URL}?fresh=1`).flush(dto());
    await expect(fresh).resolves.toEqual(dto());
  });

  it('refuses an answer of another shape', async () => {
    const { api, http } = setup();
    const answer = api.load();
    http.expectOne(URL).flush(dto({ selectionUrl: 'https://evil.example/' }));
    await expect(answer).rejects.toBeInstanceOf(UnexpectedInstallationRepositoriesResponse);
  });
});

describe('repositoryGroupsOf', () => {
  const list = [
    repo('geeera/zeta'),
    repo('geeera/old', { state: 'archived', slug: 'old' }),
    repo('geeera/Beta', { state: 'active', slug: 'beta' }),
    repo('geeera/alpha'),
    repo('geeera/aardvark', { state: 'active', slug: 'aardvark' }),
  ];

  it('puts addable rows first A→Z, then projects A→Z, then archived ones', () => {
    const groups = repositoryGroupsOf(list);
    expect(groups.addable.map((row) => row.fullName)).toEqual(['geeera/alpha', 'geeera/zeta']);
    expect(groups.registered.map((row) => row.fullName)).toEqual([
      'geeera/aardvark',
      'geeera/Beta',
      'geeera/old',
    ]);
  });

  it('keeps a just-added repository where it was, whatever the case of its name', () => {
    const groups = repositoryGroupsOf(list, new Set(['GEEERA/beta']));
    expect(groups.addable.map((row) => row.fullName)).toEqual(['geeera/alpha', 'geeera/Beta', 'geeera/zeta']);
    expect(groups.registered.map((row) => row.fullName)).toEqual(['geeera/aardvark', 'geeera/old']);
  });
});
