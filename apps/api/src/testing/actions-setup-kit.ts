import { env } from 'cloudflare:test';
import { actionsSetupBranchOf, renderRunnerWorkflow, type RunnerWorkflowRendering } from '@shared/actions-workflow';
import { ACTIONS_ENVIRONMENT, ACTIONS_INFERENCE_KEY_SECRET } from '@shared/contracts';
import { mintScopeOf } from '@worker/github/testing';
import { INSTALLATION_ID, TOKEN_SENTINEL, json, type GitHubCall } from './github-kit';

/**
 * Test-only (#759 PR 3): a scripted GitHub for the Actions readiness check, behind `stubGitHub`. The world starts
 * ready (every item ok) and a case breaks one part of it. `stubGitHub` mints for `INSTALLATION_ID` itself; any other
 * installation's mint is answered here, so a case can make the `environment-read` mint refused (422, permission not
 * accepted).
 */

/** The configured console origin of these specs; a request on it renders the workflow. */
export const SETUP_ORIGIN = 'https://console.example.com';
export const APP_SLUG = 'team-console-test';
export const BOT_LOGIN = `${APP_SLUG}[bot]`;
export const ENVIRONMENT_ID = 4242;
export const SETUP_PR_NUMBER = 17;

export interface SetupWorld {
  installationId: number;
  /** `GET /app/installations/{id}`'s `permissions`; `null` answers 404 (GitHub knows no such installation). */
  permissions: Record<string, string> | null;
  suspended: boolean;
  htmlUrl: string;
  /** What a mint of an installation other than `INSTALLATION_ID` answers. */
  otherMint: 'minted' | 'refused';
  repoId: number;
  defaultBranch: string;
  /** `GET …/environments/team-console`'s body; `null` answers 404. */
  environment: Record<string, unknown> | null;
  /** `…/deployment-branch-policies`'s `branch_policies`; `null` answers 404. */
  branchPolicies: Record<string, unknown>[] | null;
  /** The secrets the Environment holds; only `TC_INFERENCE_API_KEY` is ever asked for. */
  secrets: string[];
  /** The workflow file on the default branch; `null` answers 404. */
  workflow: string | null;
  /** The open PR from the console's head branch, if any. */
  pull: Record<string, unknown> | null;
  pullFiles: string[];
  /** The workflow file at the PR's head commit. */
  pullWorkflow: string | null;
  /** A path suffix answered 503, to model GitHub being down for one read. */
  unavailable: string | null;
  /** #759 PR 4: what the setup's write calls answer (`answerSetupWrite`). */
  write: SetupWrites;
}

export interface SetupWrites {
  /** The default branch's head commit, `GET …/branches/{default}`. */
  headSha: string;
  /** `POST …/git/refs` answers 422: the console's branch is already there. */
  branchExists: boolean;
  /** The commit `PUT …/contents` answers. */
  commitSha: string;
  /** The head `POST …/pulls` answers; `null` is the console's own commit. */
  pullHeadSha: string | null;
  /** The write answered 503, to model GitHub failing mid-way. */
  failing: 'refs' | 'contents' | 'pulls' | null;
}

export const HEAD_SHA = 'b'.repeat(40);
export const COMMIT_SHA = 'c'.repeat(40);
/** The blob sha the kit names for a file already on the new branch. */
export const BLOB_SHA = 'd'.repeat(40);

export async function renderingFor(origin = SETUP_ORIGIN): Promise<RunnerWorkflowRendering> {
  const rendered = await renderRunnerWorkflow({ consoleOrigin: origin, environment: env.ENVIRONMENT });
  if (!rendered.ok) {
    throw new Error(`the runner workflow does not render for ${origin}: ${rendered.failure}`);
  }
  return rendered.rendering;
}

export function readyWorld(repoId: number, rendering: RunnerWorkflowRendering): SetupWorld {
  return {
    installationId: INSTALLATION_ID,
    permissions: { metadata: 'read', contents: 'read', pull_requests: 'read', actions: 'write', environments: 'read' },
    suspended: false,
    htmlUrl: `https://github.com/settings/installations/${String(INSTALLATION_ID)}`,
    otherMint: 'minted',
    repoId,
    defaultBranch: 'main',
    environment: {
      id: ENVIRONMENT_ID,
      name: ACTIONS_ENVIRONMENT,
      protection_rules: [{ id: 1, type: 'branch_policy' }],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    },
    branchPolicies: [{ id: 2, name: 'main', type: 'branch' }],
    secrets: [ACTIONS_INFERENCE_KEY_SECRET],
    workflow: rendering.text,
    pull: null,
    pullFiles: [],
    pullWorkflow: null,
    unavailable: null,
    write: { headSha: HEAD_SHA, branchExists: false, commitSha: COMMIT_SHA, pullHeadSha: null, failing: null },
  };
}

/** The console's own setup PR, as GitHub answers it, opened by the app's bot in the project's repository. */
export function consolePull(
  world: SetupWorld,
  repo: string,
  rendering: RunnerWorkflowRendering,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const [owner = ''] = repo.split('/');
  const repository = { id: world.repoId, owner: { login: owner } };
  return {
    number: SETUP_PR_NUMBER,
    state: 'open',
    html_url: `https://github.com/${repo}/pull/${String(SETUP_PR_NUMBER)}`,
    user: { login: BOT_LOGIN, type: 'Bot' },
    head: { ref: actionsSetupBranchOf(rendering.sha256), sha: 'a'.repeat(40), repo: repository },
    base: { ref: world.defaultBranch, repo: repository },
    commits: 1,
    changed_files: 1,
    ...overrides,
  };
}

const raw = (text: string): Response =>
  new Response(text, { status: 200, headers: { 'Content-Type': 'application/vnd.github.raw+json' } });
const notFound = (): Response => json(404, { message: 'Not Found' });

/**
 * The readiness reads of `repo`, or `null` for any other call (the caller's own handler answers it). Paths are
 * matched exactly, so a read the check is not meant to make (the secrets list, `…/variables`) is a 404 here and the
 * path allowlist spec names it.
 */
export function answerSetupRead(world: SetupWorld, repo: string, rendering: RunnerWorkflowRendering, call: GitHubCall): Response | null {
  const path = call.url.pathname;
  if (world.unavailable !== null && path.endsWith(world.unavailable)) {
    return json(503, { message: 'Service Unavailable' });
  }
  const environment = `/repos/${repo}/environments/${ACTIONS_ENVIRONMENT}`;
  const workflowPath = `/repos/${repo}/contents/.github/workflows/team-console-runner.yml`;
  if (call.method === 'GET' && path === `/app/installations/${String(world.installationId)}`) {
    return world.permissions === null
      ? notFound()
      : json(200, {
          id: world.installationId,
          app_slug: APP_SLUG,
          account: { login: 'acme', id: 1 },
          html_url: world.htmlUrl,
          suspended_at: world.suspended ? '2026-11-01T00:00:00Z' : null,
          permissions: world.permissions,
        });
  }
  if (call.method === 'POST' && path === `/app/installations/${String(world.installationId)}/access_tokens`) {
    // Only reached for an installation other than INSTALLATION_ID; `stubGitHub` mints that one itself.
    return world.otherMint === 'refused'
      ? json(422, { message: 'The permissions requested are not granted to this installation.' })
      : json(201, {
          token: `${TOKEN_SENTINEL}other`,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          ...mintScopeOf(call.body),
        });
  }
  if (call.method === 'DELETE' && path === '/installation/token') {
    return new Response(null, { status: 204 });
  }
  if (call.method !== 'GET') {
    return null;
  }
  if (path === `/repos/${repo}`) {
    return json(200, { id: world.repoId, full_name: repo, default_branch: world.defaultBranch, private: true });
  }
  if (path === environment) {
    return world.environment === null ? notFound() : json(200, world.environment);
  }
  if (path === `${environment}/deployment-branch-policies`) {
    return world.branchPolicies === null
      ? notFound()
      : json(200, { total_count: world.branchPolicies.length, branch_policies: world.branchPolicies });
  }
  if (path === `${environment}/secrets/${ACTIONS_INFERENCE_KEY_SECRET}`) {
    return world.secrets.includes(ACTIONS_INFERENCE_KEY_SECRET)
      ? json(200, { name: ACTIONS_INFERENCE_KEY_SECRET, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' })
      : notFound();
  }
  if (path === workflowPath) {
    const ref = call.url.searchParams.get('ref');
    if (ref === world.defaultBranch) {
      return world.workflow === null ? notFound() : raw(world.workflow);
    }
    return world.pullWorkflow === null ? notFound() : raw(world.pullWorkflow);
  }
  if (path === `/repos/${repo}/pulls`) {
    const [owner = ''] = repo.split('/');
    const head = `${owner}:${actionsSetupBranchOf(rendering.sha256)}`;
    return json(200, world.pull !== null && call.url.searchParams.get('head') === head ? [world.pull] : []);
  }
  if (world.pull !== null && path === `/repos/${repo}/pulls/${String(world.pull['number'])}`) {
    return json(200, world.pull);
  }
  if (world.pull !== null && path === `/repos/${repo}/pulls/${String(world.pull['number'])}/files`) {
    return json(200, world.pullFiles.map((filename) => ({ filename })));
  }
  return null;
}

/**
 * #759 PR 4: the setup's write calls on `repo`, or `null` for any other call. The new branch starts as the default
 * branch, so the blob read on it answers `BLOB_SHA` while the default branch has a workflow file. A write the console
 * must never make (a `PATCH` or `DELETE` of a ref, a `PUT` elsewhere) is not answered here and so ends as a 404.
 */
export function answerSetupWrite(world: SetupWorld, repo: string, rendering: RunnerWorkflowRendering, call: GitHubCall): Response | null {
  const path = call.url.pathname;
  const branch = actionsSetupBranchOf(rendering.sha256);
  const workflowPath = `/repos/${repo}/contents/.github/workflows/team-console-runner.yml`;
  const unavailable = (): Response => json(503, { message: 'Service Unavailable' });
  if (call.method === 'GET' && path === `/repos/${repo}/branches/${world.defaultBranch}`) {
    return json(200, { name: world.defaultBranch, commit: { sha: world.write.headSha } });
  }
  if (call.method === 'POST' && path === `/repos/${repo}/git/refs`) {
    if (world.write.failing === 'refs') {
      return unavailable();
    }
    const body = JSON.parse(call.body ?? '{}') as Record<string, unknown>;
    return world.write.branchExists
      ? json(422, { message: 'Reference already exists' })
      : json(201, { ref: body['ref'], object: { sha: body['sha'], type: 'commit' } });
  }
  if (call.method === 'GET' && path === workflowPath && call.url.searchParams.get('ref') === branch) {
    return world.workflow === null
      ? notFound()
      : json(200, { type: 'file', path: '.github/workflows/team-console-runner.yml', sha: BLOB_SHA });
  }
  if (call.method === 'PUT' && path === workflowPath) {
    return world.write.failing === 'contents'
      ? unavailable()
      : json(world.workflow === null ? 201 : 200, {
          content: { path: '.github/workflows/team-console-runner.yml', sha: 'e'.repeat(40) },
          commit: { sha: world.write.commitSha },
        });
  }
  if (call.method === 'POST' && path === `/repos/${repo}/pulls`) {
    if (world.write.failing === 'pulls') {
      return unavailable();
    }
    return json(201, {
      number: SETUP_PR_NUMBER,
      html_url: `https://github.com/${repo}/pull/${String(SETUP_PR_NUMBER)}`,
      head: { ref: branch, sha: world.write.pullHeadSha ?? world.write.commitSha },
    });
  }
  if (call.method === 'PATCH' && path === `/repos/${repo}/pulls/${String(SETUP_PR_NUMBER)}`) {
    return json(200, { number: SETUP_PR_NUMBER, state: 'closed' });
  }
  return null;
}

/** The GitHub paths a readiness check may ask for, by shape; anything else in `calls` is an over-read. */
export function isAllowedSetupPath(repo: string, call: GitHubCall): boolean {
  const path = call.url.pathname;
  const environment = `/repos/${repo}/environments/${ACTIONS_ENVIRONMENT}`;
  return (
    /^\/repos\/[^/]+\/[^/]+\/installation$/.test(path) ||
    /^\/app\/installations\/\d+(\/access_tokens)?$/.test(path) ||
    path === '/installation/token' ||
    path === `/repos/${repo}` ||
    path === environment ||
    path === `${environment}/deployment-branch-policies` ||
    path === `${environment}/secrets/${ACTIONS_INFERENCE_KEY_SECRET}` ||
    path === `/repos/${repo}/contents/.github/workflows/team-console-runner.yml` ||
    /^\/repos\/[^/]+\/[^/]+\/pulls(\/\d+(\/files)?)?$/.test(path)
  );
}
