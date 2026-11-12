import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import {
  checkCreateRequestInput,
  checkHandleRequestInput,
  isRequestState,
  itemKeyOf,
  type ItemRequestListDto,
  type ProjectRequestListDto,
} from '@shared/contracts';
import { withoutInvisibles } from '@shared/plain-text';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { ItemRequestsRepo, type ItemRequestRecord } from '@worker/db';
import { trackerAccess } from '../../auth/tracker-access.middleware';
import type { ApiEnv } from '../../env';
import { bodySecretRefusal } from '../../tracker/body-secret';
import { invalid, itemClosed, itemOf, keyPrefixOf, trackerProjectOf } from '../../tracker/context';
import { itemRequestDtoOf } from '../../tracker/dto';
import {
  ASK_WRITE_MAX_BYTES,
  SMALL_WRITE_MAX_BYTES,
  nextCursor,
  pageOf,
  writeLimit,
} from '../../tracker/http';
import { idempotent } from '../../tracker/idempotency';
import { itemReadOf } from '../../tracker/item-reads';
import { trackerWriteContextOf } from '../../tracker/write-context';

type Context = WorkerContext<ApiEnv>;

const REQUEST_ID = /^[1-9][0-9]{0,15}$/;

function requestNotFound(c: Context): Response {
  return problem(c, { type: 'request-not-found', title: 'Request not found', status: 404 });
}

function requestResponse(c: Context, request: ItemRequestRecord | null, status: 200 | 201): Response {
  if (request === null) {
    return requestNotFound(c);
  }
  c.header('Cache-Control', 'no-store');
  return c.json(itemRequestDtoOf(request), status);
}

/**
 * `GET …/projects/:slug/requests?state=pending|handled|all` (#445, `backlog requests`): the newest request of each
 * item, oldest first, cursor-paged. Behind its own row of the route matrix; `project-read-models.ts` hands the path
 * here only when `state` is given (without it, the path is the owner's GitHub list of #219).
 */
async function listProjectRequests(c: Context): Promise<Response> {
  const project = await trackerProjectOf(c);
  if (project instanceof Response) {
    return project;
  }
  const page = pageOf(c);
  if (page instanceof Response) {
    return page;
  }
  const state = c.req.query('state');
  if (!isRequestState(state)) {
    return invalid(c, 'query-invalid', 'state', 'state is pending, handled or all');
  }
  const rows = await new ItemRequestsRepo(c.env.DB).listOfProject(
    project.slug,
    state,
    page.after,
    page.limit + 1,
  );
  const prefix = keyPrefixOf(project);
  const body: ProjectRequestListDto = {
    requests: rows.slice(0, page.limit).map((row) => ({
      ...itemRequestDtoOf(row),
      item: {
        key: itemKeyOf(prefix, row.itemNumber),
        number: row.itemNumber,
        title: withoutInvisibles(row.itemTitle),
        state: row.itemClosedAt === null ? 'open' : 'closed',
      },
    })),
    next: nextCursor(rows, page.limit),
  };
  c.header('Cache-Control', 'no-store');
  return c.json(body);
}

/**
 * The project-wide requests list with its route-matrix gate, as one call: the gate answers its refusal, or the list
 * runs as the gate's `next`. A gate that neither refused nor ran the list is a bug, so it fails loudly.
 */
export async function guardedProjectRequests(c: Context): Promise<Response> {
  const gate: MiddlewareHandler<WorkerHonoEnv<ApiEnv>> = trackerAccess('GET /api/v1/projects/:slug/requests');
  let listed: Response | undefined;
  const refused = await gate(c, async () => {
    listed = await listProjectRequests(c);
  });
  const response = refused ?? listed;
  if (response === undefined) {
    throw new Error('the requests gate neither refused nor ran the list');
  }
  return response;
}

/**
 * The owner's requests to the PM on an item (#434; ADR 0005 as rows, `item_requests`). The owner records a wish;
 * nothing here moves a sprint or a priority — the PM decides at planning and answers with `…/requests/:id/handled`,
 * a job write that records the job (`handled_by_job_id` from the actor, never from the body), `pm` only by the route
 * matrix. Until Phase 2 the only job identity is the local stand-in, so every deployed caller is refused there.
 */
export function createTrackerRequestRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  const guard = {
    list: trackerAccess('GET /api/v1/projects/:slug/items/:key/requests'),
    create: trackerAccess('POST /api/v1/projects/:slug/items/:key/requests'),
    handled: trackerAccess('POST /api/v1/projects/:slug/requests/:id/handled'),
  };
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/items/:key/requests', guard.list, async (c) => {
      const read = await itemReadOf(c);
      if (read instanceof Response) {
        return read;
      }
      const rows = await new ItemRequestsRepo(c.env.DB).list(
        read.item.id,
        read.page.after,
        read.page.limit + 1,
      );
      const body: ItemRequestListDto = {
        requests: rows.slice(0, read.page.limit).map(itemRequestDtoOf),
        next: nextCursor(rows, read.page.limit),
      };
      c.header('Cache-Control', 'no-store');
      return c.json(body);
    })

    .post('/:slug/items/:key/requests', guard.create, writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const context = await trackerWriteContextOf(c);
      if (context instanceof Response) {
        return context;
      }
      const { project, actor, write } = context;
      const item = await itemOf(c, project);
      if (item instanceof Response) {
        return item;
      }
      const requests = new ItemRequestsRepo(c.env.DB);
      return idempotent(
        c,
        write,
        async (ref, status) =>
          requestResponse(c, await requests.find(project.slug, Number(ref)), status === 201 ? 201 : 200),
        async (complete) => {
          const input = checkCreateRequestInput(write.body);
          if (!input.ok) {
            return invalid(c, 'request-invalid', input.field, input.detail);
          }
          if (item.closedAt !== null) {
            return itemClosed(c);
          }
          // No freeze or sprint logic here (ADR 0005): the PM decides what to do with the wish.
          const id = await requests.create(
            project.slug,
            item.id,
            input.value,
            actor,
            new Date().toISOString(),
            [complete(201, 'request', { newestRequestOf: item.id })],
          );
          c.get('logger').info('tracker request recorded', {
            slug: project.slug,
            number: item.number,
            kind: input.value.kind,
          });
          return requestResponse(c, await requests.find(project.slug, id), 201);
        },
      );
    })

    .post('/:slug/requests/:id/handled', guard.handled, writeLimit(ASK_WRITE_MAX_BYTES), async (c) => {
      const context = await trackerWriteContextOf(c);
      if (context instanceof Response) {
        return context;
      }
      const { project, actor, policyActor, write } = context;
      const raw = c.req.param('id') ?? '';
      const requests = new ItemRequestsRepo(c.env.DB);
      // Another project's request id is simply not found here.
      const request = REQUEST_ID.test(raw) ? await requests.find(project.slug, Number(raw)) : null;
      if (request === null || policyActor.kind !== 'job') {
        return requestNotFound(c);
      }
      const handled = (): Response =>
        problem(c, {
          type: 'request-handled',
          title: 'The request was already answered',
          status: 409,
          detail: 'A request is handled once',
        });
      return idempotent(
        c,
        write,
        async () => requestResponse(c, await requests.find(project.slug, request.id), 200),
        async (complete) => {
          const input = checkHandleRequestInput(write.body);
          if (!input.ok) {
            return invalid(c, 'request-invalid', input.field, input.detail);
          }
          const secret = bodySecretRefusal(c, policyActor, { reason: input.value.reason });
          if (secret !== null) {
            return secret;
          }
          if (request.handledAt !== null) {
            return handled();
          }
          const marked = await requests.markHandled(
            request,
            { jobId: policyActor.jobId, result: input.value.result, reason: input.value.reason },
            actor,
            new Date().toISOString(),
            [complete(200, 'request', { value: String(request.id) })],
          );
          if (!marked) {
            return handled();
          }
          c.get('logger').info('tracker request handled', {
            slug: project.slug,
            requestId: request.id,
            result: input.value.result,
          });
          return requestResponse(c, await requests.find(project.slug, request.id), 200);
        },
      );
    });
}
