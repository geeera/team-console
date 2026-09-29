import { Hono } from 'hono';
import type { ProjectDto } from '@shared/contracts';
import type { WorkerHonoEnv } from '@worker/core';
import { ProjectsRepo, toProjectDto } from '@worker/db';
import type { ApiEnv } from '../env';

/** Read side of the registry; add/archive arrive with the Settings screen (#15). */
export const projectsRoutes = new Hono<WorkerHonoEnv<ApiEnv>>().get('/', async (c) => {
  const rows = await new ProjectsRepo(c.env.DB).listActive();
  const body: ProjectDto[] = rows.map(toProjectDto);
  return c.json(body);
});
