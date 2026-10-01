import type { AddProjectStep } from '@shared/contracts';
import type { ProblemExtensionValue } from '@worker/core';
import {
  GitHubClient,
  GitHubError,
  githubPath,
  type RepoName,
  type RepoOwner as RepositoryOwner,
} from '@worker/github';
import type { GitHubConnection } from '../github';
import { ownerLanguageOf, type OwnerLanguage } from './project-yml';

/**
 * The GitHub reads behind adding a project and its setup status (#15): installation lookup (app JWT), then the
 * repository and its `.product-team/project.yml` with the repository's read-only installation token.
 */

export interface RepositoryRead {
  /** `owner/name` as GitHub spells it now. */
  readonly fullName: string;
  readonly owner: RepositoryOwner;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRepositoryWithOwner(
  value: unknown,
): value is { full_name: string; owner: { login: string; id: number } } {
  if (!isRecord(value) || typeof value['full_name'] !== 'string' || !isRecord(value['owner'])) {
    return false;
  }
  const owner = value['owner'];
  return typeof owner['login'] === 'string' && Number.isSafeInteger(owner['id']);
}

/** A contents API answer: a file object, or an array for a directory. */
function isContentsAnswer(value: unknown): value is Record<string, unknown> | unknown[] {
  return Array.isArray(value) || isRecord(value);
}

export function isGitHubProblem(error: unknown, type: string): error is GitHubError {
  return error instanceof GitHubError && error.problem.type === type;
}

function decodeBase64Text(content: string): string {
  const bytes = Uint8Array.from(atob(content.replace(/\s/g, '')), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** A GitHub failure during a step keeps #9's type and status and gains the step it happened in. */
export function inStep(
  error: unknown,
  step: AddProjectStep,
  extra: Record<string, ProblemExtensionValue> = {},
): unknown {
  if (!(error instanceof GitHubError)) {
    return error;
  }
  return new GitHubError(
    { ...error.problem, extensions: { ...error.problem.extensions, ...extra, step } },
    error.githubStatus,
  );
}

/** The app's install page for this environment's app (`team-console-<env>`, ADR 0003 decision 1). */
export function installUrlFor(environment: string): string {
  // ENVIRONMENT is our own var, but it still goes into a URL: anything unexpected falls back to the apps list.
  return /^[a-z]+$/.test(environment)
    ? `https://github.com/apps/team-console-${environment}/installations/new`
    : 'https://github.com/settings/installations';
}

/** The installation id, or `null` when the app is not installed on the repository. */
export async function installationOf(github: GitHubConnection, repo: RepoName): Promise<number | null> {
  try {
    return await github.auth.installationIdFor(repo);
  } catch (error: unknown) {
    if (isGitHubProblem(error, 'github-app-not-installed')) {
      return null;
    }
    throw error;
  }
}

export function repositoryClient(github: GitHubConnection, repo: RepoName): GitHubClient {
  return new GitHubClient(github.fetch, github.auth.tokenSourceFor(repo));
}

export async function readRepository(client: GitHubClient, repo: RepoName): Promise<RepositoryRead> {
  const read = await client.getJson(githubPath`/repos/${repo}`, isRepositoryWithOwner);
  return { fullName: read.full_name, owner: { login: read.owner.login, id: read.owner.id } };
}

/** `.product-team/project.yml` as the contents API describes it. */
export interface ProjectYmlFile {
  /** Bytes, as GitHub reports them. */
  readonly size: number;
  /** The decoded text; `null` when GitHub sent no usable content (a file over its 1 MB limit, bad base64). */
  readonly text: string | null;
}

/** The contents API's answer for `.product-team/project.yml`; `null` when there is no such file. */
export async function readProjectYmlFile(
  client: GitHubClient,
  repo: RepoName,
): Promise<ProjectYmlFile | null> {
  let answer: Record<string, unknown> | unknown[];
  try {
    answer = await client.getJson(
      githubPath`/repos/${repo}/contents/.product-team/project.yml`,
      isContentsAnswer,
    );
  } catch (error: unknown) {
    if (isGitHubProblem(error, 'github-not-found')) {
      return null;
    }
    throw error;
  }
  if (Array.isArray(answer) || answer['type'] !== 'file') {
    return null;
  }
  const size = typeof answer['size'] === 'number' && answer['size'] >= 0 ? answer['size'] : 0;
  const content = answer['content'];
  if (answer['encoding'] !== 'base64' || typeof content !== 'string') {
    return { size, text: null };
  }
  try {
    return { size, text: decodeBase64Text(content) };
  } catch {
    return { size, text: null };
  }
}

/**
 * The text of `.product-team/project.yml`, `null` when there is no such file. A file over the contents API's
 * 1 MB limit comes without content: it exists, and reads as empty.
 */
export async function readProjectYml(client: GitHubClient, repo: RepoName): Promise<string | null> {
  const file = await readProjectYmlFile(client, repo);
  // No usable content: the file is there, its language falls back to the default.
  return file === null ? null : (file.text ?? '');
}

/** A tri-state read outcome (#83): `unknown` is a GitHub failure on that particular read, not "missing". */
export type CheckState = 'ok' | 'missing' | 'unknown';

/**
 * What the setup status needs from GitHub, small enough to cache. Each GitHub read fails on its own (#83): a
 * failure of one does not lose the others, so the app-installed, repo-owner and project.yml steps can each be
 * `unknown` independently while the rest still answer.
 */
export interface RepositoryFacts {
  readonly appInstalled: CheckState;
  /** The repository's owner, read only once the app is installed and that read succeeded. */
  readonly owner: RepositoryOwner | null;
  /** `true` when the app is installed but reading the repository (for its owner) failed. */
  readonly ownerCheckFailed: boolean;
  readonly projectYml: CheckState;
  readonly ownerLanguage: OwnerLanguage;
}

/** Subrequests: 1 when the app is missing (2 on the lookup's 404 path), else up to 5 on a cold isolate. */
export async function repositoryFacts(github: GitHubConnection, repo: RepoName): Promise<RepositoryFacts> {
  let installationId: number | null;
  let appInstalled: CheckState;
  try {
    installationId = await installationOf(github, repo);
    appInstalled = installationId === null ? 'missing' : 'ok';
  } catch (error: unknown) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    installationId = null;
    appInstalled = 'unknown';
  }

  if (installationId === null) {
    // Not installed: nothing can be read, and that is known, not a failure. A failed lookup carries over as
    // "unknown" instead — a client that cannot tell whether the app is installed cannot read the repo either.
    return {
      appInstalled,
      owner: null,
      ownerCheckFailed: appInstalled === 'unknown',
      projectYml: appInstalled === 'unknown' ? 'unknown' : 'missing',
      ownerLanguage: 'ru',
    };
  }

  const client = repositoryClient(github, repo);

  let owner: RepositoryOwner | null = null;
  let ownerCheckFailed = false;
  try {
    owner = (await readRepository(client, repo)).owner;
  } catch (error: unknown) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    ownerCheckFailed = true;
  }

  let projectYml: CheckState;
  let ownerLanguage: OwnerLanguage = 'ru';
  try {
    const yml = await readProjectYml(client, repo);
    projectYml = yml === null ? 'missing' : 'ok';
    ownerLanguage = yml === null ? 'ru' : ownerLanguageOf(yml);
  } catch (error: unknown) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    projectYml = 'unknown';
  }

  return { appInstalled, owner, ownerCheckFailed, projectYml, ownerLanguage };
}
