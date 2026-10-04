import { Hono } from 'hono';
import { createWorkerApp, problem, type LogSink, type WorkerHonoEnv } from '@worker/core';
import { authMiddleware } from './auth/auth.middleware';
import { csrfMiddleware } from './auth/csrf.middleware';
import type { ApiEnv } from './env';
import { ApiGitHub, mapGitHubError } from './github';
import { createAnswerRoutes } from './routes/answer';
import { createGitHubConnectionRoutes } from './routes/github-connection';
import { healthzRoutes } from './routes/healthz';
import { connectedOwnerSource, type OwnerConnectionSource } from './projects/owner-connection';
import { createProjectRegistryRoutes } from './routes/project-registry';
import { createProjectsRoutes } from './routes/projects';
import { createProjectReadModelRoutes } from './routes/project-read-models';
import { createArtifactRoutes } from './routes/artifacts';
import { createNeedsYouRoutes } from './routes/needs-you';
import { createOverviewRoutes } from './routes/overview';
import { createTeamCommandsRoutes } from './routes/team-commands';
import { createPushRoutes } from './routes/push';
import type { FetchLike } from '@worker/routines';
import { mapReadModelError } from './read-models/errors';

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
    notFound: (c) =>
      isApiPath(c.req.path)
        ? problem(c, { type: 'not-found', title: 'Not Found', status: 404 })
        : c.env.ASSETS.fetch(c.req.raw),
    mapError: (error) => mapGitHubError(error) ?? mapReadModelError(error),
    ...(options.logSink === undefined ? {} : { logSink: options.logSink }),
  });
  const github = options.github ?? new ApiGitHub();

  // The only auth seam, mounted once before every router; the route-inventory test in auth.middleware.spec.ts
  // proves every /api route sits behind it. Hono's '/api/*' also matches '/api' itself.
  app.use('/api/*', authMiddleware, csrfMiddleware);

  const v1 = new Hono<WorkerHonoEnv<ApiEnv>>();
  v1.route('/healthz', healthzRoutes);
  v1.route(
    '/projects',
    createProjectRegistryRoutes(github, options.ownerConnection ?? connectedOwnerSource(github)),
  );
  v1.route('/projects', createProjectsRoutes(github));
  v1.route('/projects', createProjectReadModelRoutes(github));
  v1.route('/projects', createArtifactRoutes(github));
  v1.route('/needs-you', createNeedsYouRoutes(github));
  v1.route('/overview', createOverviewRoutes(github));
  v1.route('/projects', createAnswerRoutes(github));
  v1.route(
    '/projects',
    createTeamCommandsRoutes(github, {
      ...(options.routinesFetch === undefined ? {} : { routinesFetch: options.routinesFetch }),
      ...(options.routinesDeadlineMs === undefined ? {} : { routinesDeadlineMs: options.routinesDeadlineMs }),
      ...(options.ownerConnection === undefined ? {} : { ownerConnection: options.ownerConnection }),
    }),
  );
  v1.route('/github', createGitHubConnectionRoutes(github));
  v1.route(
    '/push',
    createPushRoutes({
      ...(options.pushFetch === undefined ? {} : { fetch: options.pushFetch }),
      ...(options.pushNow === undefined ? {} : { now: options.pushNow }),
    }),
  );
  app.route('/api/v1', v1);

  return app;
}
