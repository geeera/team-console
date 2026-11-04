import { Hono } from 'hono';
import { checkCreateLabelInput, type LabelListDto } from '@shared/contracts';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { LabelsRepo, type TrackerProject } from '@worker/db';
import { ownerOnlyMiddleware } from '../../auth/owner-only.middleware';
import type { ApiEnv } from '../../env';
import { invalid, trackerProjectOf } from '../../tracker/context';
import { labelDtoOf } from '../../tracker/dto';
import { SMALL_WRITE_MAX_BYTES, writeLimit } from '../../tracker/http';
import { idempotent } from '../../tracker/idempotency';
import { trackerWriteContextOf } from '../../tracker/write-context';

async function labelResponse(
  c: WorkerContext<ApiEnv>,
  project: TrackerProject,
  name: string,
  status: 200 | 201,
): Promise<Response> {
  const label = await new LabelsRepo(c.env.DB).find(project.slug, name);
  if (label === null) {
    return problem(c, { type: 'label-not-found', title: 'Label not found', status: 404 });
  }
  c.header('Cache-Control', 'no-store');
  return c.json(labelDtoOf(label), status);
}

/**
 * A project's label set (#410): the plugin's builtin labels, seeded when the tracker leaves GitHub, and the owner's
 * custom flags. Labels are never renamed or deleted here: items reference them.
 */
export function createTrackerLabelRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/labels', ownerOnlyMiddleware, async (c) => {
      const project = await trackerProjectOf(c);
      if (project instanceof Response) {
        return project;
      }
      const body: LabelListDto = {
        labels: (await new LabelsRepo(c.env.DB).list(project.slug)).map(labelDtoOf),
      };
      c.header('Cache-Control', 'no-store');
      return c.json(body);
    })

    .post('/:slug/labels', ownerOnlyMiddleware, writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const context = await trackerWriteContextOf(c);
      if (context instanceof Response) {
        return context;
      }
      const { project, write } = context;
      return idempotent(
        c,
        write,
        (ref, status) => labelResponse(c, project, ref, status === 201 ? 201 : 200),
        async (complete) => {
          const input = checkCreateLabelInput(write.body);
          if (!input.ok) {
            return invalid(c, 'label-invalid', input.field, input.detail);
          }
          const created = await new LabelsRepo(c.env.DB).create(project.slug, input.value, [
            complete(201, 'label', { value: input.value.name }),
          ]);
          if (!created) {
            return problem(c, {
              type: 'label-exists',
              title: 'The project already has this label',
              status: 409,
            });
          }
          c.get('logger').info('tracker label created', { slug: project.slug });
          return labelResponse(c, project, input.value.name, 201);
        },
      );
    });
}
