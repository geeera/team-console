import { ACTIONS_ENVIRONMENT, ACTIONS_INFERENCE_KEY_SECRET, ACTIONS_WORKFLOW_FILE } from '@shared/contracts';
import type { GitHubClient } from './client';
import { GitHubError, githubUnexpectedError, mapGitHubResponse } from './errors';
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
 * The GitHub reads of the Actions setup's readiness check (#759; architect note §4, security note rows "Readiness
 * over-reads or leaks"). The Environment and its secret are read with an `environment-read` scoped token, minted per
 * check; the workflow file with the cached read token of the repository. Each answer is reduced here to what the check
 * judges: rule types and booleans, never reviewer identities, dates, sizes or another secret's name.
 */

export type ActionsSetupReadOptions = GitHubTransportOptions & { readonly now?: () => number };

/** A protection rule of the Environment, by type only; `required_reviewers` and `wait_timer` make every run wait. */
export type EnvironmentProtectionRule = 'required_reviewers' | 'wait_timer' | 'branch_policy' | 'other';

export interface ActionsEnvironment {
  /** GitHub's id of the Environment, for the link to its settings page; `null` when the answer carries none. */
  readonly id: number | null;
  /** GitHub's `deployment_branch_policy`; `null` when every branch may deploy to the Environment. */
  readonly branchPolicy: {
    readonly protectedBranches: boolean;
    readonly customBranchPolicies: boolean;
  } | null;
  /** The rule types present, each once, in GitHub's order. A wait timer of 0 minutes is no rule. */
  readonly protectionRules: readonly EnvironmentProtectionRule[];
}

export interface DeploymentBranchPolicy {
  readonly name: string;
  readonly type: 'branch' | 'tag';
}

export interface DeploymentBranchPolicies {
  readonly policies: readonly DeploymentBranchPolicy[];
  /** `false` when GitHub counts more policies than one page holds: the check then cannot call the list exact. */
  readonly complete: boolean;
}

export type RunnerWorkflowFile =
  | { readonly kind: 'file'; readonly bytes: Uint8Array }
  | { readonly kind: 'missing' }
  | { readonly kind: 'too-large' };

/** The workflow file is a few kilobytes; anything far larger is not the console's rendering. */
export const RUNNER_WORKFLOW_MAX_BYTES = 64 * 1024;
const POLICIES_PAGE = 100;
const RAW = 'application/vnd.github.raw+json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One GET with a scoped token: no 401 retry (the token is seconds old), any non-2xx thrown as a `GitHubError`. */
async function scopedGet(
  fetcher: FetchLike,
  token: ScopedInstallationToken<'environment-read'>,
  path: GitHubPath,
  options: ActionsSetupReadOptions,
): Promise<Response> {
  const response = await githubRequest(
    fetcher,
    { method: 'GET', path, bearer: token.bearer() },
    options.deadlineSignal === undefined ? {} : { deadlineSignal: options.deadlineSignal },
  );
  if (!response.ok) {
    await discardBody(response);
    throw mapGitHubResponse(response, options.now?.() ?? Date.now());
  }
  return response;
}

function isNotFound(error: unknown): boolean {
  return error instanceof GitHubError && error.problem.type === 'github-not-found';
}

function protectionRuleOf(rule: unknown): EnvironmentProtectionRule | null {
  if (!isRecord(rule)) {
    return null;
  }
  switch (rule['type']) {
    case 'required_reviewers':
      return 'required_reviewers';
    case 'wait_timer':
      return typeof rule['wait_timer'] === 'number' && rule['wait_timer'] <= 0 ? null : 'wait_timer';
    case 'branch_policy':
      return 'branch_policy';
    default:
      return 'other';
  }
}

function environmentOf(body: unknown, status: number): ActionsEnvironment {
  if (!isRecord(body) || body['name'] !== ACTIONS_ENVIRONMENT) {
    throw githubUnexpectedError('GitHub returned an environment of an unexpected shape', status);
  }
  const rules = body['protection_rules'] ?? [];
  const policy = body['deployment_branch_policy'] ?? null;
  if (!Array.isArray(rules) || !(policy === null || isRecord(policy))) {
    throw githubUnexpectedError('GitHub returned an environment of an unexpected shape', status);
  }
  let branchPolicy: ActionsEnvironment['branchPolicy'] = null;
  if (policy !== null) {
    const protectedBranches = policy['protected_branches'];
    const customBranchPolicies = policy['custom_branch_policies'];
    if (typeof protectedBranches !== 'boolean' || typeof customBranchPolicies !== 'boolean') {
      throw githubUnexpectedError('GitHub returned an environment of an unexpected shape', status);
    }
    branchPolicy = { protectedBranches, customBranchPolicies };
  }
  const protectionRules: EnvironmentProtectionRule[] = [];
  for (const rule of rules) {
    const type = protectionRuleOf(rule);
    if (type !== null && !protectionRules.includes(type)) {
      protectionRules.push(type);
    }
  }
  const id = body['id'];
  return {
    id: Number.isSafeInteger(id) && (id as number) > 0 ? (id as number) : null,
    branchPolicy,
    protectionRules,
  };
}

/**
 * `GET /repos/{owner}/{repo}/environments/team-console` (Actions: read): the Environment's branch policy and the types
 * of its protection rules; `null` when the repository has no such Environment (404).
 */
export async function readActionsEnvironment(
  fetcher: FetchLike,
  token: ScopedInstallationToken<'environment-read'>,
  repo: RepoName,
  options: ActionsSetupReadOptions = {},
): Promise<ActionsEnvironment | null> {
  assertScopedKind(token, 'environment-read');
  try {
    const response = await scopedGet(
      fetcher,
      token,
      githubPath`/repos/${repo}/environments/${ACTIONS_ENVIRONMENT}`,
      options,
    );
    return environmentOf(await readGitHubJson(response), response.status);
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

function policyOf(value: unknown): DeploymentBranchPolicy | null {
  if (!isRecord(value) || typeof value['name'] !== 'string' || value['name'] === '') {
    return null;
  }
  // GitHub leaves `type` out on policies created before tag policies existed; those are branch policies.
  const type = value['type'] ?? 'branch';
  return type === 'branch' || type === 'tag' ? { name: value['name'], type } : null;
}

/**
 * `GET …/environments/team-console/deployment-branch-policies` (Actions: read), first page of 100: the name patterns
 * and their ref types. `null` when GitHub has no list for the Environment (404: no Environment, or no custom policies).
 */
export async function readDeploymentBranchPolicies(
  fetcher: FetchLike,
  token: ScopedInstallationToken<'environment-read'>,
  repo: RepoName,
  options: ActionsSetupReadOptions = {},
): Promise<DeploymentBranchPolicies | null> {
  assertScopedKind(token, 'environment-read');
  let response: Response;
  try {
    response = await scopedGet(
      fetcher,
      token,
      githubPath`/repos/${repo}/environments/${ACTIONS_ENVIRONMENT}/deployment-branch-policies?per_page=${POLICIES_PAGE}`,
      options,
    );
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
  const body = await readGitHubJson(response);
  const listed = isRecord(body) ? body['branch_policies'] : undefined;
  const total = isRecord(body) ? body['total_count'] : undefined;
  if (!Array.isArray(listed) || typeof total !== 'number') {
    throw githubUnexpectedError('GitHub returned branch policies of an unexpected shape', response.status);
  }
  const policies = listed.map(policyOf);
  if (policies.some((policy) => policy === null)) {
    throw githubUnexpectedError('GitHub returned a branch policy of an unexpected shape', response.status);
  }
  return {
    policies: policies.filter((policy): policy is DeploymentBranchPolicy => policy !== null),
    complete: total === listed.length,
  };
}

/**
 * Whether the Environment holds the secret `TC_INFERENCE_API_KEY`: `GET …/environments/team-console/secrets/
 * TC_INFERENCE_API_KEY` (Environments: read), 200 or 404. Never the list, so no other secret's name reaches the
 * Worker, and the answer's body is discarded unread: its dates are not passed on, and GitHub never sends a value.
 */
export async function hasInferenceKeySecret(
  fetcher: FetchLike,
  token: ScopedInstallationToken<'environment-read'>,
  repo: RepoName,
  options: ActionsSetupReadOptions = {},
): Promise<boolean> {
  assertScopedKind(token, 'environment-read');
  try {
    const response = await scopedGet(
      fetcher,
      token,
      githubPath`/repos/${repo}/environments/${ACTIONS_ENVIRONMENT}/secrets/${ACTIONS_INFERENCE_KEY_SECRET}`,
      options,
    );
    await discardBody(response);
    return true;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * The bytes of `.github/workflows/team-console-runner.yml` on `defaultBranch` (Contents: read, the cached read token),
 * for the check's byte-for-byte comparison with the console's rendering. `defaultBranch` is GitHub's own answer
 * (`readRegisteredRepository`), never input. `missing` on a 404, `too-large` past `RUNNER_WORKFLOW_MAX_BYTES`.
 */
export async function readRunnerWorkflowFile(
  client: GitHubClient,
  repo: RepoName,
  defaultBranch: string,
): Promise<RunnerWorkflowFile> {
  const path = githubContentsPath(repo, `.github/workflows/${ACTIONS_WORKFLOW_FILE}`, defaultBranch);
  try {
    const read = await client.getBytes(path, { accept: RAW, maxBytes: RUNNER_WORKFLOW_MAX_BYTES });
    return read.kind === 'too-large' ? { kind: 'too-large' } : { kind: 'file', bytes: read.bytes };
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return { kind: 'missing' };
    }
    throw error;
  }
}
