import { Hono } from 'hono';
import { isEnvironment, isValidSlug } from '@shared/contracts';
import {
  ENVIRONMENT_STATUS_PROJECT_PARAM,
  environmentStatusOf,
  type EnvironmentStatusDto,
} from '@shared/environment';
import { problem, type WorkerHonoEnv } from '@worker/core';
import { ownerOnlyMiddleware } from '../auth/owner-only.middleware';
import type { ApiEnv } from '../env';
import { findProject, projectNotFound } from '../projects/lookup';

/**
 * `GET /api/v1/environment/status[?project=<slug>]` (#104, #750): which manifest items this Worker's own environment
 * has, set or missing. Without `project`, the console's own rows only (the operator screen and its Settings row);
 * with it, that one project's rows only, the project reached through `findProject` (404 `project-not-found` outside
 * the request's scope, the same as an unknown slug). Owner-only — the list is the operator's map of the
 * environment, so the dev/stage service identity and a session user get 403. Each binding is looked up by the name
 * the manifest gives and reduced to a boolean at once; no value, length, prefix or hash reaches the response or a
 * log line.
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
    const slug = c.req.query(ENVIRONMENT_STATUS_PROJECT_PARAM);
    let project: string | null = null;
    if (slug !== undefined) {
      if (!isValidSlug(slug)) {
        return problem(c, {
          type: 'query-invalid',
          title: 'Invalid query',
          status: 400,
          detail: 'project is a project slug',
        });
      }
      const row = await findProject(c, slug);
      if (row === null) {
        return projectNotFound(c);
      }
      project = row.slug;
    }
    // Per-project secrets have names known only at run time, so the bindings are read by name.
    const bindings = c.env as unknown as Readonly<Record<string, unknown>>;
    const body: EnvironmentStatusDto = environmentStatusOf(
      environment,
      (name) => (Object.hasOwn(bindings, name) ? bindings[name] : undefined),
      project,
    );
    c.get('logger').info('environment status', {
      scope: project === null ? 'console' : 'project',
      items: body.items.length,
      missing: body.items.filter((item) => item.status === 'missing').length,
    });
    return c.json(body);
  });

  return routes;
}
