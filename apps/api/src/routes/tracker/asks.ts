import { Hono } from 'hono';
import { checkCreateAskInput, type AskListDto } from '@shared/contracts';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { AsksRepo, type ItemRecord } from '@worker/db';
import { askEffectOf, type PolicyActor } from '../../auth/policy';
import type { ApiEnv } from '../../env';
import { invalid, itemClosed, itemOf, roleRefusal, type PolicyActorOf } from '../../tracker/context';
import { askDtoOf } from '../../tracker/dto';
import { withOneRetry, writeWithItemEffect } from '../../tracker/effect-batch';
import { ASK_WRITE_MAX_BYTES, nextCursor, writeLimit } from '../../tracker/http';
import { idempotent } from '../../tracker/idempotency';
import { itemReadOf } from '../../tracker/item-reads';
import { trackerWriteContextOf } from '../../tracker/write-context';

type Context = WorkerContext<ApiEnv>;

/** ADR 0006 "API and authorisation": any role asks the owner except the developers. */
const DEVELOPER_ROLE = /^dev(-[a-z]+)?$/;

/** The owner never asks (the owner decides); a developer does not either. */
function askRefusal(c: Context, actor: PolicyActor): Response | null {
  if (actor.kind === 'job' && !DEVELOPER_ROLE.test(actor.role)) {
    return null;
  }
  return roleRefusal(c, 'ask-role', actor, 'Questions to the owner are asked by a team role other than dev');
}

/**
 * Questions to the owner (#434, ADR 0006 Phase 1a′; formerly `backlog ask`). Job-only: until the Phase 2 job
 * identity exists, no deployed identity maps to a job, so the POST refuses every real caller (the owner with 403
 * `ask-role`, the service with 403 `owner-only`); the specs reach it through `trackerPolicyActorOf`. An ask replaces
 * the item's open ask and sets `owner:<category>` in the same batch (`askEffectOf`, the second R5 exception).
 */
export function createTrackerAskRoutes(actorOf: PolicyActorOf): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/items/:key/asks', async (c) => {
      const read = await itemReadOf(c, actorOf);
      if (read instanceof Response) {
        return read;
      }
      const rows = await new AsksRepo(c.env.DB).list(read.item.id, read.page.after, read.page.limit + 1);
      const body: AskListDto = {
        asks: rows.slice(0, read.page.limit).map(askDtoOf),
        next: nextCursor(rows, read.page.limit),
      };
      c.header('Cache-Control', 'no-store');
      return c.json(body);
    })

    .post('/:slug/items/:key/asks', writeLimit(ASK_WRITE_MAX_BYTES), async (c) => {
      const context = await trackerWriteContextOf(c, actorOf, (actor) => askRefusal(c, actor));
      if (context instanceof Response) {
        return context;
      }
      const { project, actor, write } = context;
      const found = await itemOf(c, project);
      if (found instanceof Response) {
        return found;
      }
      const asks = new AsksRepo(c.env.DB);
      const respond = async (id: number, status: 200 | 201): Promise<Response> => {
        const ask = await asks.find(found.id, id);
        if (ask === null) {
          return problem(c, { type: 'ask-not-found', title: 'Ask not found', status: 404 });
        }
        c.header('Cache-Control', 'no-store');
        return c.json(askDtoOf(ask), status);
      };
      return idempotent(
        c,
        write,
        (ref, status) => respond(Number(ref), status === 201 ? 201 : 200),
        async (complete) => {
          const input = checkCreateAskInput(write.body);
          if (!input.ok) {
            return invalid(c, 'ask-invalid', input.field, input.detail);
          }
          return withOneRetry(c, async (isRetry) => {
            const item: ItemRecord | Response = isRetry ? await itemOf(c, project) : found;
            if (item instanceof Response) {
              return item;
            }
            if (item.closedAt !== null) {
              return itemClosed(c);
            }
            const open = await asks.findOpen(item.id);
            const at = new Date().toISOString();
            const written = await writeWithItemEffect(
              c.env.DB,
              item,
              askEffectOf(item, input.value.category, at),
              actor,
              at,
              [
                // "Replace an existing answer line rather than stacking two" (`backlog ask`).
                ...(open === null ? [] : [asks.withdrawStatement(open.id, at)]),
                ...asks.createStatements(project.slug, item.id, input.value, actor, at, open?.id ?? null),
                complete(201, 'ask', { newestAskOf: item.id }),
              ],
            );
            if (!written) {
              return null;
            }
            const created = await asks.findOpen(item.id);
            c.get('logger').info('tracker ask added', {
              slug: project.slug,
              number: item.number,
              category: input.value.category,
              replaced: open !== null,
            });
            return created === null
              ? problem(c, { type: 'ask-not-found', title: 'Ask not found', status: 404 })
              : respond(created.id, 201);
          });
        },
      );
    });
}
