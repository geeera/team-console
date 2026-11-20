import {
  actionsSetupBranchOf,
  compareVersions,
  loweredPinsOf,
  readRunnerWorkflowPins,
  renderRunnerWorkflow,
  RUNNER_WORKFLOW_PINS,
  type ReadRunnerWorkflowPins,
  type RunnerWorkflowPin,
  type RunnerWorkflowRendering,
} from '@shared/actions-workflow';
import {
  isGitHubUiUrl,
  type ActionsSetupPrDto,
  type ActionsWorkflowPrDto,
  type ActionsWorkflowPrKind,
  type AuditEventKind,
} from '@shared/contracts';
import type { Logger } from '@worker/core';
import {
  AuditRepo,
  OperatorStopsRepo,
  type ActionsReadinessTarget,
  type NewAuditEvent,
  type ProjectRow,
} from '@worker/db';
import {
  GitHubClient,
  GitHubError,
  InvalidRepoNameError,
  WORKFLOW_PR_PERMISSIONS,
  closeSetupPull,
  createSetupBranch,
  githubUnexpectedError,
  installationGrants,
  judgePullProvenance,
  openSetupPull,
  parseRepoName,
  putRunnerWorkflow,
  readActionsSetupPull,
  readRegisteredRepository,
  readRunnerWorkflowFile,
  readSetupBlobSha,
  sameWorkflowBytes,
  type RepoName,
  type RunnerWorkflowFile,
  type ScopedInstallationToken,
  type ScopedMintEvent,
} from '@worker/github';
import { repoUrlOf } from '@worker/read-models';
import type { ApiEnv } from '../env';
import { setupWriteOf, type ApiGitHub } from '../github';
import { workflowCommitMessageOf, workflowPrBodyOf, workflowPrTitleOf } from './workflow-pr-text';

/**
 * The console's one write to a customer repository (#759 PR 4; architect note §4, security note rows "The console
 * writes outside its own branch", "A PR that is not the console's is shown as the console's", "RUNNER_VERSION bump"
 * and "Abuse of the write path"): on the account owner's click it opens a pull request that adds, updates or restores
 * `.github/workflows/team-console-runner.yml` on a branch the console has just created. It never writes to the default
 * branch, never moves or deletes a ref and never merges.
 *
 * Nothing of the request reaches GitHub: the repository is `projects.repo_id` re-read and compared, the installation
 * is the project's while it is linked to the project's own account, the file is this console's rendering, the branch
 * is named after the rendering's sha256, and title, body and commit message are constants plus version pins.
 *
 * The order keeps every refusal that needs no write token ahead of the mint: the kill switch (the reviewed var and
 * the operator's stop), the rendering, the installation's accepted permissions (app JWT), the repository, the file
 * on the default branch and an open pull request from the console's branch. Only then is
 * `project.actions-workflow-pr-attempted` written and the `workflow-pr` token minted; it makes five calls (six when
 * a tampered pull request is closed) and is revoked in `finally`. The outcome is audited as `…-opened` or `…-failed`.
 */

export interface WorkflowPrDeps {
  readonly env: ApiEnv;
  readonly github: ApiGitHub;
  readonly logger: Logger;
  /** The origin the request arrived on; only compared with `CONSOLE_PUBLIC_ORIGIN`, never copied. */
  readonly requestOrigin: string;
  /** An audit row of this request's actor, on the project's account, targeting the project. */
  readonly audit: (kind: AuditEventKind, details: Readonly<Record<string, unknown>>) => NewAuditEvent;
}

export type WorkflowPrOutcome =
  | { readonly kind: 'opened'; readonly pr: ActionsWorkflowPrDto }
  | { readonly kind: 'write-disabled' }
  | { readonly kind: 'console-misconfigured'; readonly reason: string }
  | { readonly kind: 'repository-unverified'; readonly detail: string }
  /** The installer has not accepted these permissions (or the app is not linked); `link` is where they do. */
  | { readonly kind: 'permission-missing'; readonly permissions: readonly string[]; readonly link: string | null }
  | { readonly kind: 'already-current' }
  | { readonly kind: 'downgrade'; readonly pins: readonly RunnerWorkflowPin[] }
  | { readonly kind: 'pr-open'; readonly pr: ActionsSetupPrDto | null }
  | { readonly kind: 'branch-exists'; readonly link: string }
  | { readonly kind: 'tampered' };

/** Why an attempt opened no pull request, as the audit row names it: a fixed enum, never GitHub's text. */
type FailureReason = 'mint-failed' | 'branch-exists' | 'pr-tampered' | 'github-error' | 'internal';

const WRITE_PERMISSIONS: readonly string[] = Object.keys(WORKFLOW_PR_PERMISSIONS);

/**
 * Whether the write path is on: the reviewed var of this Worker (`ALLOW_ACTIONS_SETUP_WRITE`, exactly `true`) and no
 * operator stop in D1 (SEC 4). Read on every request, so a stop takes effect without a deploy; a failed read throws.
 */
export async function isSetupWriteAllowed(env: ApiEnv): Promise<boolean> {
  if (setupWriteOf(env) !== 'enabled') {
    return false;
  }
  return !(await new OperatorStopsRepo(env.DB).isStopped('actions-setup-write'));
}

interface Plan {
  readonly kind: ActionsWorkflowPrKind;
  readonly current: ReadRunnerWorkflowPins | null;
}

type Planned =
  | { readonly outcome: 'plan'; readonly plan: Plan }
  | { readonly outcome: 'already-current' }
  | { readonly outcome: 'downgrade'; readonly pins: readonly RunnerWorkflowPin[] };

/** What the pull request would be, from the file on the default branch alone. */
export function planWorkflowPr(file: RunnerWorkflowFile, rendering: RunnerWorkflowRendering): Planned {
  if (file.kind === 'missing') {
    return { outcome: 'plan', plan: { kind: 'setup', current: null } };
  }
  if (file.kind === 'too-large') {
    return { outcome: 'plan', plan: { kind: 'restore', current: null } };
  }
  if (sameWorkflowBytes(file.bytes, new TextEncoder().encode(rendering.text))) {
    return { outcome: 'already-current' };
  }
  const current = readRunnerWorkflowPins(new TextDecoder().decode(file.bytes));
  const lowered = loweredPinsOf(current, rendering.pins);
  if (lowered.length > 0) {
    return { outcome: 'downgrade', pins: lowered };
  }
  const raises = RUNNER_WORKFLOW_PINS.some((pin) => {
    const now = current[pin];
    return now !== null && compareVersions(rendering.pins[pin], now) > 0;
  });
  return { outcome: 'plan', plan: { kind: raises ? 'bump' : 'restore', current } };
}

class AttemptRefused extends Error {
  constructor(readonly outcome: Extract<WorkflowPrOutcome, { kind: 'branch-exists' | 'tampered' }>) {
    super(outcome.kind);
    this.name = 'AttemptRefused';
  }
}

export async function openWorkflowPr(
  deps: WorkflowPrDeps,
  row: ProjectRow,
  target: ActionsReadinessTarget,
): Promise<WorkflowPrOutcome> {
  const { env, logger } = deps;
  if (!(await isSetupWriteAllowed(env))) {
    return { kind: 'write-disabled' };
  }
  const consoleOrigin = env.CONSOLE_PUBLIC_ORIGIN ?? '';
  const rendered = await renderRunnerWorkflow({ consoleOrigin, environment: env.ENVIRONMENT });
  if (!rendered.ok) {
    if (rendered.failure === 'template-invalid') {
      throw new Error(`the bundled runner workflow template is invalid: ${rendered.detail}`);
    }
    return { kind: 'console-misconfigured', reason: rendered.failure };
  }
  if (deps.requestOrigin !== consoleOrigin) {
    return { kind: 'console-misconfigured', reason: 'console-origin-mismatch' };
  }
  const { rendering } = rendered;
  const repositoryId = target.repoId;
  if (repositoryId === null) {
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
  // Not linked to the project's own account (or suspended): no GitHub call at all, and nothing is minted.
  const installationId = target.linkedInstallationId;
  if (installationId === null) {
    return { kind: 'permission-missing', permissions: WRITE_PERMISSIONS, link: null };
  }
  const connection = await deps.github.connect(env);
  const installation = await connection.auth.readInstallationPermissions(installationId);
  if (installation === null || installation.suspended) {
    return { kind: 'permission-missing', permissions: WRITE_PERMISSIONS, link: installation?.htmlUrl ?? null };
  }
  const missing = WRITE_PERMISSIONS.filter(
    (name) => !installationGrants(installation, { [name]: WORKFLOW_PR_PERMISSIONS[name] ?? 'write' }),
  );
  if (missing.length > 0) {
    return { kind: 'permission-missing', permissions: missing, link: installation.htmlUrl };
  }
  const client = new GitHubClient(connection.fetch, connection.auth.tokenSourceFor(registered));
  const repository = await readRegisteredRepository(client, registered, repositoryId);
  if (repository === null) {
    logger.warn('actions workflow pr refused', { reason: 'repository-id-mismatch', slug: row.slug });
    return { kind: 'repository-unverified', detail: 'GitHub names another repository under this name' };
  }
  const repo = repository.current;
  const planned = planWorkflowPr(await readRunnerWorkflowFile(client, repo, repository.defaultBranch), rendering);
  if (planned.outcome === 'already-current') {
    return { kind: 'already-current' };
  }
  if (planned.outcome === 'downgrade') {
    return { kind: 'downgrade', pins: planned.pins };
  }
  const { plan } = planned;
  const branch = actionsSetupBranchOf(rendering.sha256);
  const open = await readActionsSetupPull(client, repo, branch);
  if (open !== null) {
    const provenance = judgePullProvenance(open, {
      repositoryId,
      botLogin: installation.botLogin,
      rendering: new TextEncoder().encode(rendering.text),
    });
    return {
      kind: 'pr-open',
      pr: open.htmlUrl === null ? null : { number: open.number, url: open.htmlUrl, provenance },
    };
  }

  const audits = new AuditRepo(env.DB);
  const facts = { kind: plan.kind, repositoryId, installationId, sha256: rendering.sha256 };
  const failed = async (reason: FailureReason, more: Readonly<Record<string, unknown>> = {}): Promise<void> => {
    await audits.append(deps.audit('project.actions-workflow-pr-failed', { ...facts, reason, ...more }));
  };
  const onMint = async (event: ScopedMintEvent): Promise<void> => {
    switch (event.outcome) {
      case 'attempted':
        // Before anything is asked of GitHub: a throw here stops the mint, so no write token goes out unaudited.
        await audits.append(deps.audit('project.actions-workflow-pr-attempted', facts));
        return;
      case 'minted':
        logger.info('actions workflow pr token', { slug: row.slug, outcome: 'minted' });
        return;
      case 'failed':
        logger.warn('actions workflow pr token', {
          slug: row.slug,
          outcome: 'failed',
          failure: event.failure,
          githubStatus: event.githubStatus,
        });
        await failed('mint-failed', { failure: event.failure, githubStatus: event.githubStatus });
        return;
    }
  };
  let token: ScopedInstallationToken<'workflow-pr'>;
  try {
    token = await connection.auth.mintScoped('workflow-pr', { installationId, repositoryId }, onMint);
  } catch (error: unknown) {
    // GitHub answers 422 to a mint asking for a permission the installer has not accepted after all.
    if (error instanceof GitHubError && error.githubStatus === 422) {
      return { kind: 'permission-missing', permissions: WRITE_PERMISSIONS, link: installation.htmlUrl };
    }
    throw error;
  }

  try {
    const made = await createSetupBranch(connection.fetch, token, repo, {
      branch,
      defaultBranch: repository.defaultBranch,
    });
    if (made.kind === 'exists') {
      throw new AttemptRefused({ kind: 'branch-exists', link: `${repoUrlOf(repo)}/branches` });
    }
    const blobSha = await readSetupBlobSha(connection.fetch, token, repo, made.branch);
    const commitSha = await putRunnerWorkflow(connection.fetch, token, repo, made.branch, {
      text: rendering.text,
      message: workflowCommitMessageOf(plan.kind, rendering),
      blobSha,
    });
    const pull = await openSetupPull(connection.fetch, token, repo, made.branch, {
      title: workflowPrTitleOf(plan.kind, rendering),
      body: workflowPrBodyOf(plan.kind, rendering, plan.current),
    });
    if (pull.headSha !== commitSha) {
      // Someone pushed onto the branch between the commit and the pull request: the console does not vouch for it.
      try {
        await closeSetupPull(connection.fetch, token, repo, pull.number);
      } catch (error: unknown) {
        logger.error('actions workflow pr not closed', {
          slug: row.slug,
          number: pull.number,
          githubStatus: error instanceof GitHubError ? error.githubStatus : null,
        });
      }
      throw new AttemptRefused({ kind: 'tampered' });
    }
    if (pull.htmlUrl === null || !isGitHubUiUrl(pull.htmlUrl)) {
      throw githubUnexpectedError('GitHub returned a pull request without its github.com address');
    }
    await audits.append(
      deps.audit('project.actions-workflow-pr-opened', { ...facts, prNumber: pull.number, branch, commit: commitSha }),
    );
    logger.info('actions workflow pr opened', { slug: row.slug, kind: plan.kind, number: pull.number });
    return { kind: 'opened', pr: { number: pull.number, url: pull.htmlUrl, kind: plan.kind } };
  } catch (error: unknown) {
    if (error instanceof AttemptRefused) {
      const reason = error.outcome.kind === 'tampered' ? 'pr-tampered' : 'branch-exists';
      logger.warn('actions workflow pr refused', { slug: row.slug, reason });
      await failed(reason);
      return error.outcome;
    }
    const githubStatus = error instanceof GitHubError ? error.githubStatus : null;
    logger.warn('actions workflow pr failed', { slug: row.slug, githubStatus });
    await failed(error instanceof GitHubError ? 'github-error' : 'internal', { githubStatus });
    throw error;
  } finally {
    await connection.auth.revokeScoped(token);
  }
}
