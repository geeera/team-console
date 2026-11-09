import { Hono } from 'hono';
import { isEnvironment } from '@shared/contracts';
import { environmentStatusOf, type EnvironmentStatusDto } from '@shared/environment';
import { problem, type WorkerHonoEnv } from '@worker/core';
import { ownerOnlyMiddleware } from '../auth/owner-only.middleware';
import type { ApiEnv } from '../env';
import { scopedProjectsOf } from '../projects/lookup';

/**
 * `GET /api/v1/environment/status` (#104): which manifest items this Worker's own environment has, set or missing.
 * Owner-only — the list is the owner's map of the environment, so the dev/stage service identity gets 403. Each
 * binding is looked up by the name the manifest gives and reduced to a boolean at once; no value, length, prefix or
 * hash reaches the response or a log line.
 */
export function createEnvironmentRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  const routes = new Hono<WorkerHonoEnv<ApiEnv>>();
  routes.use('*', ownerOnlyMiddleware);

  routes.get('/status', async (c) => {
    const environment = c.env.ENVIRONMENT;
    if (!isEnvironment(environment)) {
      c.get('logger').error('environment status refused', { reason: 'unknown-environment' });
      return problem(c, {
        type: 'environment-unknown',
        title: 'Unknown environment',
        status: 503,
        detail: 'This Worker does not know which environment it runs in',
      });
    }
    const projects = await scopedProjectsOf(c);
    // Per-project secrets have names known only at run time, so the bindings are read by name.
    const bindings = c.env as unknown as Readonly<Record<string, unknown>>;
    const body: EnvironmentStatusDto = environmentStatusOf(
      environment,
      (name) => (Object.hasOwn(bindings, name) ? bindings[name] : undefined),
      projects.map((project) => project.slug),
    );
    c.get('logger').info('environment status', {
      items: body.items.length,
      missing: body.items.filter((item) => item.status === 'missing').length,
    });
    return c.json(body);
  });

  return routes;
}
