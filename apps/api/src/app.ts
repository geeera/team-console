import { Hono } from 'hono';
import { createWorkerApp, problem, type LogSink, type WorkerHonoEnv } from '@worker/core';
import { authMiddleware } from './auth/auth.middleware';
import { csrfMiddleware } from './auth/csrf.middleware';
import type { ApiEnv } from './env';
import { ApiGitHub, mapGitHubError } from './github';
import { createGitHubConnectionRoutes } from './routes/github-connection';
import { healthzRoutes } from './routes/healthz';
import { createProjectsRoutes } from './routes/projects';

export interface CreateApiAppOptions {
  readonly logSink?: LogSink;
  /** Per-isolate GitHub state; a test passes its own to script GitHub or to share caches between requests. */
  readonly github?: ApiGitHub;
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
    mapError: mapGitHubError,
    ...(options.logSink === undefined ? {} : { logSink: options.logSink }),
  });
  const github = options.github ?? new ApiGitHub();

  // The only auth seam, mounted once before every router; the route-inventory test in auth.middleware.spec.ts
  // proves every /api route sits behind it. Hono's '/api/*' also matches '/api' itself.
  app.use('/api/*', authMiddleware, csrfMiddleware);

  const v1 = new Hono<WorkerHonoEnv<ApiEnv>>();
  v1.route('/healthz', healthzRoutes);
  v1.route('/projects', createProjectsRoutes(github));
  v1.route('/github', createGitHubConnectionRoutes(github));
  app.route('/api/v1', v1);

  return app;
}
