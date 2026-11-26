import { ACTIONS_SETUP_BRANCH_PREFIX } from '@shared/actions-workflow';
import { GitHubError, githubUnexpectedError, mapGitHubResponse } from './errors';
import { RUNNER_WORKFLOW_PATH } from './actions-setup-pull';
import { githubContentsPath, githubPath, type GitHubPath } from './github-path';
import type { RepoName } from './repo-name';
import { assertScopedKind, type ScopedInstallationToken } from './scoped-mint';
import {
  discardBody,
  githubRequest,
  readGitHubJson,
  type FetchLike,
  type GitHubTransportOptions,
} from './transport';

/**
 * The GitHub writes of the Actions setup (#759 PR 4; security note rows "The console writes outside its own branch"
 * and "A PR that is not the console's is shown as the console's"). Each takes a `workflow-pr` scoped token, minted on
 * the account owner's click and revoked by the caller in `finally`.
 *
 * The console writes to one ref only, the one it has just created:
 * - a ref is created with `POST …/git/refs` and nothing else; no function here sends `PATCH` or `DELETE` to a ref, so
 *   a branch that already exists is never moved, reset or removed;
 * - the file write and the pull request take the `CreatedSetupBranch` that `createSetupBranch` returned (any other
 *   object is refused), so a `PUT …/contents` without `branch` (GitHub would then commit to the default branch)
 *   cannot be written;
 * - the one path is `RUNNER_WORKFLOW_PATH`, a constant.
 */

export type ActionsSetupWriteOptions = GitHubTransportOptions & { readonly now?: () => number };

type WriteToken = ScopedInstallationToken<'workflow-pr'>;

const SHA = /^[0-9a-f]{40}$/;
const SETUP_BRANCH = /^[0-9a-f]{12}$/;
const GITHUB_UI_URL = /^https:\/\/github\.com\/[^\s"'<>\\]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A branch this request created at GitHub; only `createSetupBranch` hands one out. */
export interface CreatedSetupBranch {
  readonly repositoryId: number;
  readonly branch: string;
  /** The default branch's commit the branch was created at. */
  readonly baseSha: string;
  readonly base: string;
}

// The types cannot stop a hand-built object literal; this registry does, at run time.
const createdBranches = new WeakSet<CreatedSetupBranch>();

function assertCreated(created: CreatedSetupBranch, token: WriteToken): void {
  if (!createdBranches.has(created) || created.repositoryId !== token.repositoryId) {
    throw new TypeError('the setup writes take the branch createSetupBranch made with this token');
  }
}

async function send(
  fetcher: FetchLike,
  token: WriteToken,
  request: {
    readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH';
    readonly path: GitHubPath;
    readonly body?: unknown;
  },
  options: ActionsSetupWriteOptions,
): Promise<Response> {
  return githubRequest(
    fetcher,
    { ...request, bearer: token.bearer() },
    options.deadlineSignal === undefined ? {} : { deadlineSignal: options.deadlineSignal },
  );
}

async function refused(response: Response, options: ActionsSetupWriteOptions): Promise<GitHubError> {
  await discardBody(response);
  return mapGitHubResponse(response, options.now?.() ?? Date.now());
}

function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export interface SetupBranchRequest {
  /** `actionsSetupBranchOf` the rendering: `team-console/runner-<12 hex>`. */
  readonly branch: string;
  /** GitHub's `default_branch` of the id-checked repository, never input. */
  readonly defaultBranch: string;
}

export type SetupBranchOutcome =
  | { readonly kind: 'created'; readonly branch: CreatedSetupBranch }
  /** GitHub already has a ref of that name (422); it is left exactly as it is. */
  | { readonly kind: 'exists' };

/**
 * Creates the console's branch at the default branch's current commit: `GET …/branches/{default}` for the commit,
 * then `POST …/git/refs`. The name must be the console's (`team-console/runner-<12 hex>`) and never the default
 * branch; anything else is a programming error and throws before a request is sent.
 */
export async function createSetupBranch(
  fetcher: FetchLike,
  token: WriteToken,
  repo: RepoName,
  request: SetupBranchRequest,
  options: ActionsSetupWriteOptions = {},
): Promise<SetupBranchOutcome> {
  assertScopedKind(token, 'workflow-pr');
  const { branch, defaultBranch } = request;
  if (
    !branch.startsWith(ACTIONS_SETUP_BRANCH_PREFIX) ||
    !SETUP_BRANCH.test(branch.slice(ACTIONS_SETUP_BRANCH_PREFIX.length)) ||
    branch === defaultBranch ||
    defaultBranch === ''
  ) {
    throw new RangeError('the setup branch is team-console/runner-<12 hex> and never the default branch');
  }
  const head = await send(
    fetcher,
    token,
    { method: 'GET', path: githubPath`/repos/${repo}/branches/${defaultBranch}` },
    options,
  );
  if (!head.ok) {
    throw await refused(head, options);
  }
  const headBody = await readGitHubJson(head);
  const commit = isRecord(headBody) ? headBody['commit'] : undefined;
  const baseSha = isRecord(commit) ? commit['sha'] : undefined;
  if (typeof baseSha !== 'string' || !SHA.test(baseSha)) {
    throw githubUnexpectedError('GitHub returned a branch of an unexpected shape', head.status);
  }
  const ref = `refs/heads/${branch}`;
  const created = await send(
    fetcher,
    token,
    { method: 'POST', path: githubPath`/repos/${repo}/git/refs`, body: { ref, sha: baseSha } },
    options,
  );
  if (created.status === 422) {
    await discardBody(created);
    return { kind: 'exists' };
  }
  if (!created.ok) {
    throw await refused(created, options);
  }
  const body = await readGitHubJson(created);
  const object = isRecord(body) ? body['object'] : undefined;
  if (!isRecord(body) || body['ref'] !== ref || !isRecord(object) || object['sha'] !== baseSha) {
    throw githubUnexpectedError('GitHub created another ref than the one asked for', created.status);
  }
  const made: CreatedSetupBranch = Object.freeze({
    repositoryId: token.repositoryId,
    branch,
    baseSha,
    base: defaultBranch,
  });
  createdBranches.add(made);
  return { kind: 'created', branch: made };
}

/**
 * The blob sha of the workflow file on the branch just created, or `null` when the branch has none. Read from that
 * ref, never from the default branch, so the write that follows is a compare-and-set on the commit the branch holds.
 */
export async function readSetupBlobSha(
  fetcher: FetchLike,
  token: WriteToken,
  repo: RepoName,
  created: CreatedSetupBranch,
  options: ActionsSetupWriteOptions = {},
): Promise<string | null> {
  assertScopedKind(token, 'workflow-pr');
  assertCreated(created, token);
  const response = await send(
    fetcher,
    token,
    { method: 'GET', path: githubContentsPath(repo, RUNNER_WORKFLOW_PATH, created.branch) },
    options,
  );
  if (response.status === 404) {
    await discardBody(response);
    return null;
  }
  if (!response.ok) {
    throw await refused(response, options);
  }
  const body = await readGitHubJson(response);
  const sha = isRecord(body) && body['type'] === 'file' ? body['sha'] : undefined;
  if (typeof sha !== 'string' || !SHA.test(sha)) {
    throw githubUnexpectedError('GitHub returned a file of an unexpected shape', response.status);
  }
  return sha;
}

export interface RunnerWorkflowWrite {
  /** The console's rendering, written byte for byte. */
  readonly text: string;
  /** A constant of the caller plus the version pins; never request or project text. */
  readonly message: string;
  /** `readSetupBlobSha` of the same branch: `null` creates the file, a sha replaces exactly that blob. */
  readonly blobSha: string | null;
}

/** The body of `PUT …/contents/{path}`; `branch` is not optional, so the default branch can never be the target. */
function contentsBodyOf(created: CreatedSetupBranch, write: RunnerWorkflowWrite): Record<string, string> {
  return {
    message: write.message,
    content: base64Of(new TextEncoder().encode(write.text)),
    branch: created.branch,
    ...(write.blobSha === null ? {} : { sha: write.blobSha }),
  };
}

/**
 * Commits the workflow file to the created branch (`PUT …/contents/.github/workflows/team-console-runner.yml`, which
 * takes Contents and Workflows write) and returns the commit's sha. GitHub answers 409 or 422 when the blob is not the
 * one named (someone pushed to the branch meanwhile); that is thrown as a `GitHubError` carrying the status.
 */
export async function putRunnerWorkflow(
  fetcher: FetchLike,
  token: WriteToken,
  repo: RepoName,
  created: CreatedSetupBranch,
  write: RunnerWorkflowWrite,
  options: ActionsSetupWriteOptions = {},
): Promise<string> {
  assertScopedKind(token, 'workflow-pr');
  assertCreated(created, token);
  const response = await send(
    fetcher,
    token,
    {
      method: 'PUT',
      path: githubContentsPath(repo, RUNNER_WORKFLOW_PATH),
      body: contentsBodyOf(created, write),
    },
    options,
  );
  if (!response.ok) {
    throw await refused(response, options);
  }
  const body = await readGitHubJson(response);
  const commit = isRecord(body) ? body['commit'] : undefined;
  const content = isRecord(body) ? body['content'] : undefined;
  const sha = isRecord(commit) ? commit['sha'] : undefined;
  if (
    typeof sha !== 'string' ||
    !SHA.test(sha) ||
    !isRecord(content) ||
    content['path'] !== RUNNER_WORKFLOW_PATH
  ) {
    throw githubUnexpectedError('GitHub committed something other than the workflow file', response.status);
  }
  return sha;
}

export interface OpenedSetupPull {
  readonly number: number;
  /** GitHub's `html_url`; `null` unless it is an `https://github.com/` URL. */
  readonly htmlUrl: string | null;
  /** The head commit GitHub opened the PR at; the caller compares it with its own commit. */
  readonly headSha: string;
}

/** Title and body are the caller's constants plus version pins and the sha256; never request or project text. */
export interface SetupPullText {
  readonly title: string;
  readonly body: string;
}

/** Opens the pull request from the created branch into the default branch it was created from. */
export async function openSetupPull(
  fetcher: FetchLike,
  token: WriteToken,
  repo: RepoName,
  created: CreatedSetupBranch,
  text: SetupPullText,
  options: ActionsSetupWriteOptions = {},
): Promise<OpenedSetupPull> {
  assertScopedKind(token, 'workflow-pr');
  assertCreated(created, token);
  const response = await send(
    fetcher,
    token,
    {
      method: 'POST',
      path: githubPath`/repos/${repo}/pulls`,
      body: {
        title: text.title,
        body: text.body,
        head: created.branch,
        base: created.base,
        maintainer_can_modify: false,
      },
    },
    options,
  );
  if (!response.ok) {
    throw await refused(response, options);
  }
  const body = await readGitHubJson(response);
  const head = isRecord(body) ? body['head'] : undefined;
  const number = isRecord(body) ? body['number'] : undefined;
  const headSha = isRecord(head) ? head['sha'] : undefined;
  if (
    !isRecord(body) ||
    !Number.isSafeInteger(number) ||
    (number as number) <= 0 ||
    typeof headSha !== 'string' ||
    !SHA.test(headSha)
  ) {
    throw githubUnexpectedError('GitHub returned a pull request of an unexpected shape', response.status);
  }
  const htmlUrl = body['html_url'];
  return {
    number: number as number,
    htmlUrl: typeof htmlUrl === 'string' && GITHUB_UI_URL.test(htmlUrl) ? htmlUrl : null,
    headSha,
  };
}

/**
 * Closes a pull request this request has just opened, when its head is not the console's commit. The branch stays:
 * the console deletes no ref.
 */
export async function closeSetupPull(
  fetcher: FetchLike,
  token: WriteToken,
  repo: RepoName,
  number: number,
  options: ActionsSetupWriteOptions = {},
): Promise<void> {
  assertScopedKind(token, 'workflow-pr');
  const response = await send(
    fetcher,
    token,
    { method: 'PATCH', path: githubPath`/repos/${repo}/pulls/${number}`, body: { state: 'closed' } },
    options,
  );
  if (!response.ok) {
    throw await refused(response, options);
  }
  await discardBody(response);
}
