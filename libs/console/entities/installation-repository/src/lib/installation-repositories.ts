import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  INSTALLATION_REPOSITORIES_URL,
  isGitHubPageUrl,
  isRepoFullName,
  isValidSlug,
  type InstallationRepositoriesDto,
  type InstallationRepositoryDto,
  type RepositoryRegistration,
} from '@shared/contracts';
import { firstValueFrom } from 'rxjs';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRegistration(value: unknown): value is RepositoryRegistration {
  if (!isRecord(value)) {
    return false;
  }
  if (value['state'] === 'none') {
    return true;
  }
  return (
    (value['state'] === 'active' || value['state'] === 'archived') &&
    typeof value['slug'] === 'string' &&
    isValidSlug(value['slug'])
  );
}

function isRepository(value: unknown): value is InstallationRepositoryDto {
  return (
    isRecord(value) &&
    isRepoFullName(value['fullName']) &&
    typeof value['private'] === 'boolean' &&
    isRegistration(value['registration'])
  );
}

/**
 * `GET /api/v1/github/installation/repositories` as the console reads it (#194). A name that is not `owner/name`
 * or a selection link off github.com refuses the whole answer: the names end up in an Add request and the link in
 * an `href`.
 */
export function isInstallationRepositoriesDto(value: unknown): value is InstallationRepositoriesDto {
  return (
    isRecord(value) &&
    Array.isArray(value['repositories']) &&
    value['repositories'].every(isRepository) &&
    typeof value['partial'] === 'boolean' &&
    isGitHubPageUrl(value['selectionUrl'])
  );
}

/** A 2xx answer of another shape: a Worker and console out of step, or a bug. */
export class UnexpectedInstallationRepositoriesResponse extends Error {
  constructor() {
    super('The installation repositories response has an unexpected shape');
    this.name = 'UnexpectedInstallationRepositoriesResponse';
  }
}

@Injectable({ providedIn: 'root' })
export class InstallationRepositoriesApi {
  private readonly http = inject(HttpClient);

  /** `fresh` bypasses the Worker's 60 s cache (Refresh, back from GitHub, back online). */
  async load(options: { readonly fresh?: boolean } = {}): Promise<InstallationRepositoriesDto> {
    const params = options.fresh === true ? new HttpParams().set('fresh', '1') : undefined;
    const body = await firstValueFrom(
      this.http.get<unknown>(INSTALLATION_REPOSITORIES_URL, params === undefined ? {} : { params }),
    );
    if (!isInstallationRepositoriesDto(body)) {
      throw new UnexpectedInstallationRepositoriesResponse();
    }
    return body;
  }
}

/** The list as All projects shows it: what the owner can add first, then what is already in the console. */
export interface RepositoryGroups {
  readonly addable: readonly InstallationRepositoryDto[];
  /** Projects A→Z, then archived ones A→Z. */
  readonly registered: readonly InstallationRepositoryDto[];
}

const byName = (a: InstallationRepositoryDto, b: InstallationRepositoryDto): number => {
  const left = a.fullName.toLowerCase();
  const right = b.fullName.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
};

/**
 * Splits the list by registration (#194 UX spec §3). `keepInPlace` (full names, any case) stays in the addable
 * group whatever its registration: a repository added a moment ago turns "Project" where the owner tapped Add
 * instead of jumping away from their focus.
 */
export function repositoryGroupsOf(
  repositories: readonly InstallationRepositoryDto[],
  keepInPlace: ReadonlySet<string> = new Set(),
): RepositoryGroups {
  const kept = new Set([...keepInPlace].map((name) => name.toLowerCase()));
  const isAddable = (repo: InstallationRepositoryDto): boolean =>
    repo.registration.state === 'none' || kept.has(repo.fullName.toLowerCase());
  const addable = repositories.filter(isAddable).sort(byName);
  const rest = repositories.filter((repo) => !isAddable(repo));
  const active = rest.filter((repo) => repo.registration.state === 'active').sort(byName);
  const archived = rest.filter((repo) => repo.registration.state === 'archived').sort(byName);
  return { addable, registered: [...active, ...archived] };
}
