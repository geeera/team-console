import { Hono } from 'hono';
import { createWorkerApp, markAssetResponse, problem, type LogSink, type WorkerHonoEnv } from '@worker/core';
import { authMiddleware } from './auth/auth.middleware';
import { csrfMiddleware } from './auth/csrf.middleware';
import { routeScopeMiddleware } from './auth/route-scope';
import { jobScopeMiddleware } from './auth/tracker-access.middleware';
import { createAccountRoutes } from './routes/accounts';
import { createAccountRunnerRoutes } from './routes/account-runners';
import { createRunnerRoutes } from './routes/runner';
import { createRunnerJobRoutes } from './routes/runner-jobs';
import { createRunnerPauseRoutes } from './routes/runner-pause';
import { createJobRoutes } from './routes/jobs';
import type { ApiEnv } from './env';
import { ApiGitHub, mapGitHubError } from './github';
import { createAnswerRoutes } from './routes/answer';
import { createOwnerRequestRoutes } from './routes/owner-request';
import { createBatchAnswerRoutes } from './routes/batch-answer';
import { createGitHubConnectionRoutes } from './routes/github-connection';
import { createInstallationRepositoriesRoutes } from './routes/installation-repositories';
import { healthzRoutes } from './routes/healthz';
import { appIdentityRoutes } from './routes/app-identity';
import { connectedOwnerSource, type OwnerConnectionSource } from './projects/owner-connection';
import { createProjectRegistryRoutes } from './routes/project-registry';
import { createProjectsRoutes } from './routes/projects';
import { createProjectReadModelRoutes } from './routes/project-read-models';
import { createArtifactRoutes } from './routes/artifacts';
import { createDesignRoutes } from './routes/designs';
import { createNeedsYouRoutes } from './routes/needs-you';
import { createOverviewRoutes } from './routes/overview';
import { createSprintCommandsRoutes } from './routes/sprint-commands';
import { createTeamCommandsRoutes } from './routes/team-commands';
import { createPushRoutes } from './routes/push';
import { createNotificationsRoutes } from './routes/notifications';
import { createEnvironmentRoutes } from './routes/environment';
import { createTrackerAskRoutes } from './routes/tracker/asks';
import { createTrackerCommentRoutes } from './routes/tracker/comments';
import { createTrackerDecisionRoutes } from './routes/tracker/decisions';
import { createTrackerRequestRoutes } from './routes/tracker/requests';
import { createTrackerPrLinkRoutes } from './routes/tracker/pr-links';
import { createTrackerItemRoutes } from './routes/tracker/items';
import { createTrackerLabelRoutes } from './routes/tracker/labels';
import { createTrackerSprintRoutes } from './routes/tracker/sprints';
import type { FetchLike } from '@worker/routines';
import { mapReadModelError } from './read-models/errors';
import { createPullRequestRoutes } from './routes/pull-requests';
import { mapVcsError } from '@worker/vcs';

export interface CreateApiAppOptions {
  readonly logSink?: LogSink;
  /** Per-isolate GitHub state; a test passes its own to script GitHub or to share caches between requests. */
  readonly github?: ApiGitHub;
  /** The connected owner account for the registry; defaults to the #59 connection. */
  readonly ownerConnection?: OwnerConnectionSource;
  /** The transport of "Run now" fires (#114); a test passes the fake routines API. */
  readonly routinesFetch?: FetchLike;
  readonly routinesDeadlineMs?: number;
  /** The transport of web pushes (#11); a test passes the fake push service. */
  readonly pushFetch?: FetchLike;
  /** Milliseconds since the epoch for the push routes; a seam for the test-push interval. */
  readonly pushNow?: () => number;
}

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/**
 * The `api` Worker. `run_worker_first: ["/api", "/api/*"]` means only API paths normally reach it; should anything
 * else arrive, it is handed to the assets binding so the SPA fallback is never answered with a JSON 404 —
 * and an unknown `/api/*` path is never answered with the SPA.
 */
export function createApiApp(options: CreateApiAppOptions = {}): Hono<WorkerHonoEnv<ApiEnv>> {
  const app = createWorkerApp<ApiEnv>({
    service: 'api',
    notFound: async (c) =>
      isApiPath(c.req.path)
        ? problem(c, { type: 'not-found', title: 'Not Found', status: 404 })
        : // The SPA fallback: the assets binding's own `_headers` governs it, not this Worker's security headers.
          markAssetResponse(await c.env.ASSETS.fetch(c.req.raw)),
    mapError: (error) => mapGitHubError(error) ?? mapVcsError(error) ?? mapReadModelError(error),
    noStore: true,
    ...(options.logSink === undefined ? {} : { logSink: options.logSink }),
  });
  const github = options.github ?? new ApiGitHub();
  const owners = options.ownerConnection ?? connectedOwnerSource(github);

  // The manifest and the icons index.html links to, per ENVIRONMENT (#237); outside /api, so no auth middleware —
  // Access in front of the whole origin still covers them.
  app.route('/', appIdentityRoutes);

  // The only auth seam, mounted once before every router; the route-inventory test in auth.middleware.spec.ts
  // proves every /api route sits behind it. Hono's '/api/*' also matches '/api' itself. A job identity goes no
  // further than the tracker's matrix routes (#444). Then the deny-by-default scope inventory (#466,
  // `route-scope.spec.ts`): a route it does not list is unreachable.
  app.use('/api/*', authMiddleware, jobScopeMiddleware, routeScopeMiddleware, csrfMiddleware);

  const v1 = new Hono<WorkerHonoEnv<ApiEnv>>();
  v1.route('/healthz', healthzRoutes);
  v1.route('/projects', createProjectRegistryRoutes(github, owners));
  v1.route('/projects', createProjectsRoutes(github));
  v1.route('/projects', createProjectReadModelRoutes(github));
  v1.route('/projects', createArtifactRoutes(github));
  v1.route('/projects', createDesignRoutes(github));
  v1.route('/needs-you', createNeedsYouRoutes(github));
  v1.route('/overview', createOverviewRoutes(github));
  v1.route('/projects', createAnswerRoutes(github));
  v1.route('/projects', createBatchAnswerRoutes(github));
  v1.route(
    '/projects',
    createTeamCommandsRoutes(github, {
      ...(options.routinesFetch === undefined ? {} : { routinesFetch: options.routinesFetch }),
      ...(options.routinesDeadlineMs === undefined ? {} : { routinesDeadlineMs: options.routinesDeadlineMs }),
      ...(options.ownerConnection === undefined ? {} : { ownerConnection: options.ownerConnection }),
    }),
  );
  v1.route('/projects', createNotificationsRoutes(github));
  v1.route('/projects', createSprintCommandsRoutes(github));
  v1.route('/projects', createOwnerRequestRoutes(github));
  // The console's own tracker (#410, #434, ADR 0006): D1 only, except project.yml's freeze length for a move into a
  // sprint near its demo (#556). Every route passes its row of the route matrix (`auth/tracker-matrix.ts`); a job
  // identity exists only under the local bypass until Phase 2.
  v1.route('/projects', createTrackerItemRoutes(github));
  v1.route('/projects', createTrackerCommentRoutes());
  v1.route('/projects', createTrackerSprintRoutes());
  v1.route('/projects', createTrackerLabelRoutes());
  v1.route('/projects', createTrackerAskRoutes());
  v1.route('/projects', createTrackerDecisionRoutes());
  v1.route('/projects', createTrackerRequestRoutes());
  // A new link is checked on the provider (#529): the one tracker write that reads GitHub, through the VCS adapter.
  v1.route('/projects', createTrackerPrLinkRoutes(github, owners));
  // Pull requests (#463): D1's mirror behind the same matrix; `?fresh=1` reads GitHub through the VCS adapter.
  v1.route('/projects', createPullRequestRoutes(github, owners));
  // Before the connection routes: their owner-only `use('*')` would otherwise also guard this read (#194), which
  // the service identity may make on dev/stage like every other read (installation-repositories.spec.ts proves it).
  v1.route('/github', createInstallationRepositoriesRoutes(github, owners));
  v1.route('/github', createGitHubConnectionRoutes(github));
  v1.route(
    '/push',
    createPushRoutes({
      ...(options.pushFetch === undefined ? {} : { fetch: options.pushFetch }),
      ...(options.pushNow === undefined ? {} : { now: options.pushNow }),
    }),
  );
  v1.route('/environment', createEnvironmentRoutes());
  // The account's own settings, members and audit (ADR 0008 decision 5, T-2): owner-of-account only.
  v1.route('/accounts', createAccountRoutes());
  // Runners of the account (#467, ADR 0008 row 2-A): enrolment codes, list, allowed projects, revoke.
  v1.route('/accounts', createAccountRunnerRoutes());
  // The runner's own door: enrolment by the one-time code, then the runner JWT alone (`auth/runner-auth.ts`).
  v1.route('/runner', createRunnerRoutes());
  // The queue (#467): the owner's Run now and the reads behind the matrix; the runner's claim, heartbeat, events, finish.
  v1.route('/projects', createJobRoutes());
  v1.route('/runner', createRunnerJobRoutes());
  // The runner's own pause on a usage or rate limit (#571): the claim skips it until `until`.
  v1.route('/runner', createRunnerPauseRoutes());
  app.route('/api/v1', v1);

  return app;
}
