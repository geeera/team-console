import type { ProblemDetails } from './problem-details';

/**
 * `GET /api/v1/github/installation/repositories[?fresh=1]` (#194, ADR 0003 decisions 2 and 6 as amended): the
 * repositories the console app's installation on the connected owner's account can see, each with its place in
 * the registry.
 */
export const INSTALLATION_REPOSITORIES_URL = '/api/v1/github/installation/repositories';

export type RepositoryRegistration =
  | { readonly state: 'none' }
  | { readonly state: 'active'; readonly slug: string }
  | { readonly state: 'archived'; readonly slug: string };

export interface InstallationRepositoryDto {
  /** `owner/name` as GitHub spells it. */
  readonly fullName: string;
  readonly private: boolean;
  readonly registration: RepositoryRegistration;
}

export interface InstallationRepositoriesDto {
  /** Sorted by `fullName`, case-insensitively. */
  readonly repositories: readonly InstallationRepositoryDto[];
  /** The page cap or the subrequest budget stopped the read; `repositories` holds what was read. */
  readonly partial: boolean;
  /** GitHub's page for changing the installation's repository selection, built on the server. */
  readonly selectionUrl: string;
}

/** 409 `github-app-not-installed` on this route: no installation of the console app on the connected account. */
export interface GitHubAppNotInstalledProblem extends ProblemDetails {
  readonly installUrl: string;
}
