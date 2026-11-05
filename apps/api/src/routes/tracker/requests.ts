import { Hono } from 'hono';
import { checkCreateRequestInput, checkHandleRequestInput, type ItemRequestListDto } from '@shared/contracts';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { ItemRequestsRepo, type ItemRequestRecord } from '@worker/db';
import { ownerOnlyMiddleware } from '../../auth/owner-only.middleware';
import type { PolicyActor } from '../../auth/policy';
import type { ApiEnv } from '../../env';
import { invalid, itemClosed, itemOf, roleRefusal, type PolicyActorOf } from '../../tracker/context';
import { itemRequestDtoOf } from '../../tracker/dto';
import { ASK_WRITE_MAX_BYTES, SMALL_WRITE_MAX_BYTES, nextCursor, writeLimit } from '../../tracker/http';
import { idempotent } from '../../tracker/idempotency';
import { itemReadOf } from '../../tracker/item-reads';
import { trackerWriteContextOf } from '../../tracker/write-context';

type Context = WorkerContext<ApiEnv>;

const REQUEST_ID = /^[1-9][0-9]{0,15}$/;

function ownerOnly(c: Context, actor: PolicyActor): Response | null {
  return actor.kind === 'owner'
    ? null
    : roleRefusal(c, 'owner-only', actor, 'A request to the PM is the owner’s own wish');
}

/** The PM answers requests (ADR 0005, never silently): the record of who handled it is the job, so not the owner. */
function pmOnly(c: Context, actor: PolicyActor): Response | null {
  return actor.kind === 'job' && actor.role === 'pm'
    ? null
    : roleRefusal(c, 'request-handled-role', actor, 'Only the PM job answers a request');
}

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
 * The owner's requests to the PM on an item (#434; ADR 0005 as rows, `item_requests`). The owner records a wish;
 * nothing here moves a sprint or a priority — the PM decides at planning and answers with `…/requests/:id/handled`,
 * a job write that records the job (`handled_by_job_id` from the actor, never from the body). That route refuses
 * every deployed identity until the Phase 2 job identity exists; the specs reach it through `trackerPolicyActorOf`.
 */
export function createTrackerRequestRoutes(actorOf: PolicyActorOf): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/items/:key/requests', async (c) => {
      const read = await itemReadOf(c, actorOf);
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

    .post('/:slug/items/:key/requests', ownerOnlyMiddleware, writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const context = await trackerWriteContextOf(c, actorOf, (actor) => ownerOnly(c, actor));
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

    .post('/:slug/requests/:id/handled', writeLimit(ASK_WRITE_MAX_BYTES), async (c) => {
      const context = await trackerWriteContextOf(c, actorOf, (actor) => pmOnly(c, actor));
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
