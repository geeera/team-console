import { ACTIONS_SETUP_BRANCH_PREFIX } from '@shared/actions-workflow';
import { ACTIONS_WORKFLOW_FILE, isGitHubUiUrl } from '@shared/contracts';
import { readRunnerWorkflowFile, type RunnerWorkflowFile } from './actions-setup-reads';
import type { GitHubClient } from './client';
import { GitHubError } from './errors';
import { githubPath } from './github-path';
import type { RepoName } from './repo-name';

/**
 * The console's setup PR, found again by its head branch (#759; architect note §4, security note row "A PR that is
 * not the console's is shown as the console's"). Read with the repository's cached read token (Pull requests and
 * Contents: read). The head is `<owner>:<branch>` with the owner of the id-checked repository, so a fork's PR from a
 * branch of the same name is never matched. What is kept is what the provenance judgement needs, nothing else: no
 * title, body, labels or the author's profile.
 */

export const RUNNER_WORKFLOW_PATH = `.github/workflows/${ACTIONS_WORKFLOW_FILE}`;
const SHA = /^[0-9a-f]{40}$/;

export interface ActionsSetupPull {
  readonly number: number;
  /** GitHub's `html_url` of the PR; `null` unless it is an `https://github.com/` URL. */
  readonly htmlUrl: string | null;
  readonly author: { readonly login: string; readonly type: string } | null;
  readonly headRepositoryId: number | null;
  readonly baseRepositoryId: number | null;
  readonly commits: number;
  readonly changedFiles: number;
  /** The changed paths, when the PR changes exactly one file (else not read). */
  readonly files: readonly string[];
  /** The workflow file at the PR's head commit, when the PR is one commit changing one file (else not read). */
  readonly headFile: RunnerWorkflowFile | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;
}

const isPullList = (value: unknown): value is unknown[] => Array.isArray(value);

interface PullAnswer {
  readonly number: number;
  readonly html_url: unknown;
  readonly user: unknown;
  readonly head: { readonly sha: string; readonly repo: unknown };
  readonly base: { readonly repo: unknown };
  readonly commits: number;
  readonly changed_files: number;
}

function isPullAnswer(value: unknown): value is PullAnswer {
  if (!isRecord(value) || positiveInt(value['number']) === null) {
    return false;
  }
  const head = value['head'];
  const base = value['base'];
  return (
    isRecord(head) &&
    typeof head['sha'] === 'string' &&
    SHA.test(head['sha']) &&
    isRecord(base) &&
    Number.isSafeInteger(value['commits']) &&
    Number.isSafeInteger(value['changed_files'])
  );
}

const isFileList = (value: unknown): value is unknown[] => Array.isArray(value);

function repositoryIdOf(value: unknown): number | null {
  return isRecord(value) ? positiveInt(value['id']) : null;
}

function authorOf(value: unknown): ActionsSetupPull['author'] {
  if (!isRecord(value) || typeof value['login'] !== 'string' || typeof value['type'] !== 'string') {
    return null;
  }
  return { login: value['login'], type: value['type'] };
}

/**
 * The open PR from `<repo owner>:<branch>`, or `null` when there is none. `repo` is GitHub's current name of the
 * id-checked repository (`readRegisteredRepository`), never input; `branch` is `actionsSetupBranchOf` the rendering.
 * Up to four reads: the list, the PR (its commit and file counts), and — only for a one-commit, one-file PR — its
 * file list and the workflow file at its head commit.
 */
export async function readActionsSetupPull(
  client: GitHubClient,
  repo: RepoName,
  branch: string,
): Promise<ActionsSetupPull | null> {
  const listed = await client.getJson(
    githubPath`/repos/${repo}/pulls?head=${`${repo.owner}:${branch}`}&state=open&per_page=${1}`,
    isPullList,
  );
  const number = isRecord(listed[0]) ? positiveInt(listed[0]['number']) : null;
  if (number === null) {
    return null;
  }
  const pull = await client.getJson(githubPath`/repos/${repo}/pulls/${number}`, isPullAnswer);
  const htmlUrl = isGitHubUiUrl(pull.html_url) ? pull.html_url : null;
  let files: string[] = [];
  let headFile: RunnerWorkflowFile | null = null;
  if (pull.commits === 1 && pull.changed_files === 1) {
    const changed = await client.getJson(githubPath`/repos/${repo}/pulls/${number}/files?per_page=${2}`, isFileList);
    files = changed.flatMap((file) => (isRecord(file) && typeof file['filename'] === 'string' ? [file['filename']] : []));
    headFile = await readRunnerWorkflowFile(client, repo, pull.head.sha);
  }
  return {
    number,
    htmlUrl,
    author: authorOf(pull.user),
    headRepositoryId: repositoryIdOf(pull.head.repo),
    baseRepositoryId: repositoryIdOf(pull.base.repo),
    commits: pull.commits,
    changedFiles: pull.changed_files,
    files,
    headFile,
  };
}

/** A setup branch as the console names it: the prefix and 12 hex characters of a rendering's sha256. */
const SETUP_BRANCH_STEM = /^[0-9a-f]{12}$/;
const isSetupBranch = (branch: string): boolean =>
  branch.startsWith(ACTIONS_SETUP_BRANCH_PREFIX) && SETUP_BRANCH_STEM.test(branch.slice(ACTIONS_SETUP_BRANCH_PREFIX.length));
/** More setup branches than this are not the console's doing; the rest are not looked at. */
export const SETUP_BRANCHES_MAX = 20;

const isRefList = (value: unknown): value is unknown[] => Array.isArray(value);

/**
 * The console's setup branches in the repository (#870, a stale PR): `GET …/git/matching-refs/heads/<prefix>`, one
 * read with the cached read token (Contents: read), refs only. Names that are not exactly a setup branch are
 * dropped; GitHub's 404 (an empty repository) is none. At most `SETUP_BRANCHES_MAX`, in GitHub's order.
 */
export async function readSetupBranches(client: GitHubClient, repo: RepoName): Promise<string[]> {
  const [area, stem, ...rest] = ACTIONS_SETUP_BRANCH_PREFIX.split('/');
  if (area === undefined || stem === undefined || rest.length > 0) {
    throw new Error('the setup branch prefix is one directory and a stem');
  }
  let refs: unknown[];
  try {
    refs = await client.getJson(githubPath`/repos/${repo}/git/matching-refs/heads/${area}/${stem}`, isRefList);
  } catch (error: unknown) {
    if (error instanceof GitHubError && error.problem.type === 'github-not-found') {
      return [];
    }
    throw error;
  }
  return refs
    .flatMap((ref) => {
      const name = isRecord(ref) && typeof ref['ref'] === 'string' ? ref['ref'] : '';
      const branch = name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : '';
      return isSetupBranch(branch) ? [branch] : [];
    })
    .slice(0, SETUP_BRANCHES_MAX);
}

export interface PullProvenanceExpectation {
  /** `projects.repo_id`: both the head and the base repository must be it. */
  readonly repositoryId: number;
  /** The app's `<slug>[bot]` from `readInstallationPermissions`; `null` makes every PR foreign. */
  readonly botLogin: string | null;
  /** This console's rendering, byte for byte. */
  readonly rendering: Uint8Array;
}

export type PullProvenance = 'console' | 'foreign' | 'changed';

/** Byte-for-byte equality of a read workflow file with the rendering. */
export function sameWorkflowBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/**
 * `console` only when the app's bot opened it in the project's own repository and it is still one commit changing
 * the one workflow file to this console's rendering. `foreign`: another author, or another repository on either side.
 * `changed`: the console's PR, with other commits, files or bytes on it now.
 */
export function judgePullProvenance(pull: ActionsSetupPull, expected: PullProvenanceExpectation): PullProvenance {
  const author = pull.author;
  if (
    expected.botLogin === null ||
    author === null ||
    author.type !== 'Bot' ||
    author.login.toLowerCase() !== expected.botLogin.toLowerCase() ||
    pull.headRepositoryId !== expected.repositoryId ||
    pull.baseRepositoryId !== expected.repositoryId
  ) {
    return 'foreign';
  }
  const onlyFile = pull.files.length === 1 && pull.files[0] === RUNNER_WORKFLOW_PATH;
  const headFile = pull.headFile;
  if (
    pull.commits !== 1 ||
    pull.changedFiles !== 1 ||
    !onlyFile ||
    headFile === null ||
    headFile.kind !== 'file' ||
    !sameWorkflowBytes(headFile.bytes, expected.rendering)
  ) {
    return 'changed';
  }
  return 'console';
}
