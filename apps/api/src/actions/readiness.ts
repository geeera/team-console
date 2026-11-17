import { actionsSetupBranchOf, renderRunnerWorkflow, type RunnerWorkflowRendering } from '@shared/actions-workflow';
import {
  blockingItemsOf,
  isGitHubUiUrl,
  type ActionsSetupDto,
  type ActionsSetupItemDto,
  type ActionsSetupItemId,
  type ActionsSetupPrDto,
  type ActionsSetupStatus,
} from '@shared/contracts';
import type { Logger } from '@worker/core';
import { ProjectDispatchRepo, type ActionsReadinessTarget, type ProjectRow } from '@worker/db';
import {
  ACTIONS_DISPATCH_PERMISSIONS,
  ENVIRONMENT_READ_PERMISSIONS,
  GitHubClient,
  GitHubError,
  InvalidRepoNameError,
  RUNNER_WORKFLOW_PATH,
  hasInferenceKeySecret,
  judgePullProvenance,
  parseRepoName,
  readActionsEnvironment,
  readActionsSetupPull,
  readDeploymentBranchPolicies,
  readRegisteredRepository,
  readRunnerWorkflowFile,
  sameWorkflowBytes,
  type ActionsEnvironment,
  type DeploymentBranchPolicies,
  type InstallationPermissions,
  type PermissionLevel,
  type RepoName,
} from '@worker/github';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';

/**
 * The Actions setup's readiness check (#759 PR 3; architect note §4, security note rows "Readiness over-reads or
 * leaks", "Readiness used as authorisation" and "Cross-tenant or member trigger"). It answers `GET …/actions-setup`
 * and holds back `PUT …/dispatch {actions}`. Every item is read from GitHub on each check; nothing is stored.
 *
 * Readiness is availability only: neither the OIDC exchange nor the dispatch reads it or relaxes a check because of
 * it (`tools/workspace-checks/src/actions-readiness-advisory.spec.ts`).
 *
 * The order is cheap and local first: the project row and the console's own rendering (no GitHub call while either
 * is wrong), then the installation's accepted permissions with the app JWT (no mint), the repository by its recorded
 * id, one `environment-read` token for the Environment, its branch policies and its one secret (revoked in `finally`),
 * and the workflow file and the setup PR with the cached read token. A GitHub 5xx stops the check as a thrown
 * `GitHubError` (502 `github-unavailable`); no partial items are answered.
 */

export interface ReadinessDeps {
  readonly env: ApiEnv;
  readonly github: ApiGitHub;
  readonly logger: Logger;
  /** The origin the request arrived on; only compared with `CONSOLE_PUBLIC_ORIGIN`, never copied. */
  readonly requestOrigin: string;
  readonly now?: () => Date;
}

export type ReadinessOutcome =
  | {
      readonly kind: 'checked';
      readonly setup: ActionsSetupDto;
      /** GitHub's `default_branch`, when the repository was read; the switch records it. */
      readonly defaultBranch: string | null;
    }
  | { readonly kind: 'repository-unverified'; readonly detail: string }
  | { readonly kind: 'console-misconfigured'; readonly reason: string };

/** What the Actions path needs of the installation: the dispatch's `actions: write` and the check's reads. */
const REQUIRED_PERMISSIONS: Readonly<Record<string, 'read' | 'write'>> = Object.freeze({
  ...ENVIRONMENT_READ_PERMISSIONS,
  ...ACTIONS_DISPATCH_PERMISSIONS,
});

const LEVEL_RANK: Readonly<Record<PermissionLevel, number>> = { read: 1, write: 2, admin: 3 };

function grants(installation: InstallationPermissions, wanted: Readonly<Record<string, 'read' | 'write'>>): boolean {
  return Object.entries(wanted).every(([name, level]) => {
    const granted = installation.permissions[name];
    return granted !== undefined && LEVEL_RANK[granted] >= LEVEL_RANK[level];
  });
}

type Items = Record<ActionsSetupItemId, ActionsSetupItemDto>;

function item(
  id: ActionsSetupItemId,
  status: ActionsSetupStatus,
  link?: string | null,
  pr?: ActionsSetupPrDto,
): ActionsSetupItemDto {
  // Every link is GitHub's own UI; anything else is dropped rather than handed to the page.
  const safeLink = status !== 'ok' && link !== undefined && link !== null && isGitHubUiUrl(link) ? link : undefined;
  return {
    id,
    status,
    ...(safeLink === undefined ? {} : { link: safeLink }),
    ...(pr === undefined ? {} : { pr }),
  };
}

const ORDER: readonly ActionsSetupItemId[] = [
  'access-source',
  'app-permissions',
  'environment',
  'branch-policy',
  'protection-rules',
  'secret',
  'workflow',
];

function repoUrl(repo: RepoName): string {
  return `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

function refPath(ref: string): string {
  return ref.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/** The Environment's settings page: GitHub's UI addresses it by id (`…/settings/environments/{id}/edit`). */
function environmentLink(repo: RepoName, environment: ActionsEnvironment | null): string {
  if (environment === null) {
    return `${repoUrl(repo)}/settings/environments/new`;
  }
  return environment.id === null
    ? `${repoUrl(repo)}/settings/environments`
    : `${repoUrl(repo)}/settings/environments/${String(environment.id)}/edit`;
}

/** Exactly one deployment-branch rule, of ref type Branch, naming the default branch: only `main` reads the key. */
function branchPolicyStatus(
  environment: ActionsEnvironment,
  policies: DeploymentBranchPolicies | null,
  defaultBranch: string,
): ActionsSetupStatus {
  const policy = environment.branchPolicy;
  if (policy === null) {
    return 'missing';
  }
  if (policy.protectedBranches || !policy.customBranchPolicies) {
    return 'wrong';
  }
  if (policies === null || policies.policies.length === 0) {
    return 'missing';
  }
  const [only] = policies.policies;
  return policies.complete && policies.policies.length === 1 && only?.type === 'branch' && only.name === defaultBranch
    ? 'ok'
    : 'wrong';
}

function protectionStatus(environment: ActionsEnvironment): ActionsSetupStatus {
  // Required reviewers, a wait timer or a custom gate makes every run wait: a warning, never a block.
  return environment.protectionRules.some((rule) => rule !== 'branch_policy') ? 'wrong' : 'ok';
}

interface EnvironmentItems {
  readonly environment: ActionsSetupItemDto;
  readonly branchPolicy: ActionsSetupItemDto;
  readonly protectionRules: ActionsSetupItemDto;
  readonly secret: ActionsSetupItemDto;
}

const unknownEnvironment = (): EnvironmentItems => ({
  environment: item('environment', 'unknown'),
  branchPolicy: item('branch-policy', 'unknown'),
  protectionRules: item('protection-rules', 'unknown'),
  secret: item('secret', 'unknown'),
});

/** A mint GitHub refused because the installer has not accepted the permission (GitHub answers 422). */
function isPermissionRefusal(error: unknown): boolean {
  return error instanceof GitHubError && error.githubStatus === 422;
}

async function environmentItems(
  deps: ReadinessDeps,
  connection: Awaited<ReturnType<ApiGitHub['connect']>>,
  target: { readonly installationId: number; readonly repositoryId: number; readonly slug: string },
  repo: RepoName,
  defaultBranch: string,
): Promise<EnvironmentItems> {
  const { auth, fetch } = connection;
  let token;
  try {
    token = await auth.mintScoped(
      'environment-read',
      { installationId: target.installationId, repositoryId: target.repositoryId },
      async (event) => {
        deps.logger.info('actions readiness token', {
          slug: target.slug,
          outcome: event.outcome,
          ...(event.outcome === 'failed' ? { failure: event.failure, githubStatus: event.githubStatus } : {}),
        });
      },
    );
  } catch (error: unknown) {
    // SEC 5 of PR 1's review: a permission the installer has not accepted leaves these items unknown, never ok.
    if (isPermissionRefusal(error)) {
      return unknownEnvironment();
    }
    throw error;
  }
  try {
    const environment = await readActionsEnvironment(fetch, token, repo);
    const link = environmentLink(repo, environment);
    if (environment === null) {
      return {
        environment: item('environment', 'missing', link),
        branchPolicy: item('branch-policy', 'missing', link),
        protectionRules: item('protection-rules', 'unknown'),
        secret: item('secret', 'missing', link),
      };
    }
    const policies =
      environment.branchPolicy?.customBranchPolicies === true
        ? await readDeploymentBranchPolicies(fetch, token, repo)
        : null;
    const hasSecret = await hasInferenceKeySecret(fetch, token, repo);
    return {
      environment: item('environment', 'ok'),
      branchPolicy: item('branch-policy', branchPolicyStatus(environment, policies, defaultBranch), link),
      protectionRules: item('protection-rules', protectionStatus(environment), link),
      secret: item('secret', hasSecret ? 'ok' : 'missing', link),
    };
  } finally {
    await auth.revokeScoped(token);
  }
}

async function workflowItem(
  client: GitHubClient,
  repo: RepoName,
  defaultBranch: string,
  rendering: RunnerWorkflowRendering,
  expectation: { readonly repositoryId: number; readonly botLogin: string | null },
): Promise<ActionsSetupItemDto> {
  const bytes = new TextEncoder().encode(rendering.text);
  const file = await readRunnerWorkflowFile(client, repo, defaultBranch);
  const pull = await readActionsSetupPull(client, repo, actionsSetupBranchOf(rendering.sha256));
  const pr: ActionsSetupPrDto | undefined =
    pull === null || pull.htmlUrl === null
      ? undefined
      : {
          number: pull.number,
          url: pull.htmlUrl,
          provenance: judgePullProvenance(pull, { ...expectation, rendering: bytes }),
        };
  const fileUrl = `${repoUrl(repo)}/blob/${refPath(defaultBranch)}/${RUNNER_WORKFLOW_PATH}`;
  if (file.kind === 'missing') {
    return item('workflow', 'missing', `${repoUrl(repo)}/new/${refPath(defaultBranch)}?filename=${RUNNER_WORKFLOW_PATH}`, pr);
  }
  // No earlier release's rendering is kept yet, so a file that differs is `modified`, never `outdated`.
  const status: ActionsSetupStatus =
    file.kind === 'file' && sameWorkflowBytes(file.bytes, bytes) ? 'ok' : 'modified';
  return item('workflow', status, fileUrl, pr);
}

function answer(
  dispatch: ActionsSetupDto['dispatch'],
  accessSource: ActionsSetupDto['accessSource'],
  items: Items,
  checkedAt: string,
): ActionsSetupDto {
  const ordered = ORDER.map((id) => items[id]);
  return { dispatch, accessSource, ready: blockingItemsOf(ordered).length === 0, checkedAt, items: ordered };
}

/** The project's readiness inputs, in one D1 read; `null` when the row is gone. */
export async function readinessTargetOf(deps: Pick<ReadinessDeps, 'env'>, row: ProjectRow): Promise<ActionsReadinessTarget | null> {
  return new ProjectDispatchRepo(deps.env.DB).readinessTargetOf(row.slug);
}

/**
 * `target` is `readinessTargetOf(row)`, read by the caller in the same request: the switch judges the access source
 * from it before any GitHub call or render, so a subscription project keeps its own refusal on every console.
 */
export async function checkActionsReadiness(
  deps: ReadinessDeps,
  row: ProjectRow,
  target: ActionsReadinessTarget,
): Promise<ReadinessOutcome> {
  const consoleOrigin = deps.env.CONSOLE_PUBLIC_ORIGIN ?? '';
  const rendered = await renderRunnerWorkflow({ consoleOrigin, environment: deps.env.ENVIRONMENT });
  if (!rendered.ok) {
    if (rendered.failure === 'template-invalid') {
      throw new Error(`the bundled runner workflow template is invalid: ${rendered.detail}`);
    }
    return { kind: 'console-misconfigured', reason: rendered.failure };
  }
  if (deps.requestOrigin !== consoleOrigin) {
    return { kind: 'console-misconfigured', reason: 'console-origin-mismatch' };
  }
  if (target.repoId === null) {
    return { kind: 'repository-unverified', detail: 'The repository id of this project was never recorded' };
  }
  let registered: RepoName;
  try {
    registered = parseRepoName(row.repo);
  } catch (error: unknown) {
    if (error instanceof InvalidRepoNameError) {
      return { kind: 'repository-unverified', detail: 'The project has an invalid repository name' };
    }
    throw error;
  }
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const accessSource = item('access-source', target.accessSource === 'api_key' ? 'ok' : 'missing');
  const nothingRead = (appPermissions: ActionsSetupItemDto): ReadinessOutcome => {
    const env = unknownEnvironment();
    return {
      kind: 'checked',
      defaultBranch: null,
      setup: answer(
        target.dispatch,
        target.accessSource,
        {
          'access-source': accessSource,
          'app-permissions': appPermissions,
          environment: env.environment,
          'branch-policy': env.branchPolicy,
          'protection-rules': env.protectionRules,
          secret: env.secret,
          workflow: item('workflow', 'unknown'),
        },
        checkedAt,
      ),
    };
  };
  // Not linked to the project's own account (or suspended): no GitHub call at all, and nothing is minted.
  const installationId = target.linkedInstallationId;
  if (installationId === null) {
    return nothingRead(item('app-permissions', 'missing'));
  }
  const connection = await deps.github.connect(deps.env);
  const installation = await connection.auth.readInstallationPermissions(installationId);
  if (installation === null || installation.suspended) {
    return nothingRead(item('app-permissions', 'missing', installation?.htmlUrl ?? null));
  }
  const client = new GitHubClient(connection.fetch, connection.auth.tokenSourceFor(registered));
  const repository = await readRegisteredRepository(client, registered, target.repoId);
  if (repository === null) {
    deps.logger.warn('actions readiness refused', { reason: 'repository-id-mismatch', slug: row.slug });
    return { kind: 'repository-unverified', detail: 'GitHub names another repository under this name' };
  }
  const environment = grants(installation, ENVIRONMENT_READ_PERMISSIONS)
    ? await environmentItems(
        deps,
        connection,
        { installationId, repositoryId: target.repoId, slug: row.slug },
        repository.current,
        repository.defaultBranch,
      )
    : unknownEnvironment();
  const workflow = await workflowItem(client, repository.current, repository.defaultBranch, rendered.rendering, {
    repositoryId: target.repoId,
    botLogin: installation.botLogin,
  });
  const setup = answer(
    target.dispatch,
    target.accessSource,
    {
      'access-source': accessSource,
      'app-permissions': item(
        'app-permissions',
        grants(installation, REQUIRED_PERMISSIONS) ? 'ok' : 'missing',
        installation.htmlUrl,
      ),
      environment: environment.environment,
      'branch-policy': environment.branchPolicy,
      'protection-rules': environment.protectionRules,
      secret: environment.secret,
      workflow,
    },
    checkedAt,
  );
  deps.logger.info('actions readiness checked', {
    slug: row.slug,
    ready: setup.ready,
    blocking: blockingItemsOf(setup.items).join(','),
  });
  return { kind: 'checked', setup, defaultBranch: repository.defaultBranch };
}
