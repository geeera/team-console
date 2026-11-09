import { Hono } from 'hono';
import {
  checkCreateSprintInput,
  checkUpdateSprintInput,
  isSprintState,
  type TrackerSprintListDto,
} from '@shared/contracts';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { SprintsRepo, type TrackerProject } from '@worker/db';
import { trackerAccess } from '../../auth/tracker-access.middleware';
import type { ApiEnv } from '../../env';
import { bodySecretRefusal } from '../../tracker/body-secret';
import { invalid, trackerProjectOf } from '../../tracker/context';
import { sprintDtoOf } from '../../tracker/dto';
import { TEXT_WRITE_MAX_BYTES, writeLimit } from '../../tracker/http';
import { idempotent } from '../../tracker/idempotency';
import { trackerWriteContextOf } from '../../tracker/write-context';

type Context = WorkerContext<ApiEnv>;

const SPRINT_NUMBER = /^[1-9][0-9]{0,8}$/;

function sprintNotFound(c: Context): Response {
  return problem(c, { type: 'sprint-not-found', title: 'Sprint not found', status: 404 });
}

async function sprintResponse(
  c: Context,
  project: TrackerProject,
  number: number,
  status: 200 | 201,
): Promise<Response> {
  const sprint = await new SprintsRepo(c.env.DB).findByNumber(project.slug, number);
  if (sprint === null) {
    return sprintNotFound(c);
  }
  c.header('Cache-Control', 'no-store');
  if (status === 201) {
    c.header('Location', `/api/v1/projects/${project.slug}/sprints/${String(number)}`);
  }
  return c.json(sprintDtoOf(sprint), status);
}

/**
 * Sprints of the console's own tracker (#410): numbered per project and titled `Sprint NN` like `backlog sprint
 * create`, or with the owner's name (#457); addressed by that number, never by a row id. The demo-date rules of the GitHub-backed sprint commands
 * (#218) stay with those routes until Phase 1b moves the board here.
 */
export function createTrackerSprintRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  const guard = {
    list: trackerAccess('GET /api/v1/projects/:slug/sprints'),
    read: trackerAccess('GET /api/v1/projects/:slug/sprints/:number'),
    create: trackerAccess('POST /api/v1/projects/:slug/sprints'),
    change: trackerAccess('PATCH /api/v1/projects/:slug/sprints/:number'),
  };
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/sprints', guard.list, async (c) => {
      const project = await trackerProjectOf(c);
      if (project instanceof Response) {
        return project;
      }
      const state = c.req.query('state') ?? 'all';
      if (state !== 'all' && !isSprintState(state)) {
        return invalid(c, 'query-invalid', 'state', 'state is open, closed or all');
      }
      const sprints = await new SprintsRepo(c.env.DB).list(project.slug, state);
      const body: TrackerSprintListDto = { sprints: sprints.map(sprintDtoOf) };
      c.header('Cache-Control', 'no-store');
      return c.json(body);
    })

    .get('/:slug/sprints/:number', guard.read, async (c) => {
      const project = await trackerProjectOf(c);
      if (project instanceof Response) {
        return project;
      }
      const number = c.req.param('number');
      return SPRINT_NUMBER.test(number) ? sprintResponse(c, project, Number(number), 200) : sprintNotFound(c);
    })

    .post('/:slug/sprints', guard.create, writeLimit(TEXT_WRITE_MAX_BYTES), async (c) => {
      const context = await trackerWriteContextOf(c);
      if (context instanceof Response) {
        return context;
      }
      const { project, policyActor, write } = context;
      return idempotent(
        c,
        write,
        (ref, status) => sprintResponse(c, project, Number(ref), status === 201 ? 201 : 200),
        async (complete) => {
          const input = checkCreateSprintInput(write.body);
          if (!input.ok) {
            return invalid(c, 'sprint-invalid', input.field, input.detail);
          }
          // The title is validated plain text already (`checkCreateSprintInput`); this only judges it for secrets.
          const { title, description } = input.value;
          const secret = bodySecretRefusal(c, policyActor, { title, description });
          if (secret !== null) {
            return secret;
          }
          const repo = new SprintsRepo(c.env.DB);
          const number = await repo.nextNumber(project.slug);
          const created = await repo.create(
            project.slug,
            number,
            { ...input.value, at: new Date().toISOString() },
            [complete(201, 'sprint', { value: String(number) })],
          );
          if (!created) {
            return problem(c, {
              type: 'sprint-exists',
              title: 'Another sprint took this number',
              status: 409,
              detail: 'A sprint was created at the same moment; send the request again',
            });
          }
          c.get('logger').info('tracker sprint created', { slug: project.slug, number });
          return sprintResponse(c, project, number, 201);
        },
      );
    })

    .patch('/:slug/sprints/:number', guard.change, writeLimit(TEXT_WRITE_MAX_BYTES), async (c) => {
      const context = await trackerWriteContextOf(c);
      if (context instanceof Response) {
        return context;
      }
      const { project, policyActor, write } = context;
      const param = c.req.param('number');
      const number = SPRINT_NUMBER.test(param) ? Number(param) : null;
      return idempotent(
        c,
        write,
        (ref) => sprintResponse(c, project, Number(ref), 200),
        async (complete) => {
          const repo = new SprintsRepo(c.env.DB);
          // Sprints are never deleted, so one that exists now still exists for the update below.
          if (number === null || (await repo.findByNumber(project.slug, number)) === null) {
            return sprintNotFound(c);
          }
          const input = checkUpdateSprintInput(write.body);
          if (!input.ok) {
            return invalid(c, 'sprint-invalid', input.field, input.detail);
          }
          const secret = bodySecretRefusal(c, policyActor, { description: input.value.description });
          if (secret !== null) {
            return secret;
          }
          await repo.update(project.slug, number, input.value, new Date().toISOString(), [
            complete(200, 'sprint', { value: String(number) }),
          ]);
          c.get('logger').info('tracker sprint changed', { slug: project.slug, number });
          return sprintResponse(c, project, number, 200);
        },
      );
    });
}
