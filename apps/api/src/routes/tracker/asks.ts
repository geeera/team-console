import { Hono } from 'hono';
import { checkCreateAskInput, type AskListDto } from '@shared/contracts';
import { problem, type WorkerHonoEnv } from '@worker/core';
import { AsksRepo, type ItemRecord } from '@worker/db';
import { askEffectOf } from '../../auth/policy';
import { trackerAccess } from '../../auth/tracker-access.middleware';
import type { ApiEnv } from '../../env';
import { invalid, itemClosed, itemOf } from '../../tracker/context';
import { askDtoOf } from '../../tracker/dto';
import { withOneRetry, writeWithItemEffect } from '../../tracker/effect-batch';
import { ASK_WRITE_MAX_BYTES, nextCursor, writeLimit } from '../../tracker/http';
import { idempotent } from '../../tracker/idempotency';
import { itemReadOf } from '../../tracker/item-reads';
import { trackerWriteContextOf } from '../../tracker/write-context';

/**
 * Questions to the owner (#434, ADR 0006 Phase 1a′; formerly `backlog ask`). Job-only, any role but `dev*` (the route
 * matrix; the owner gets 403 `ask-role`, the service 403 `owner-only`): until Phase 2 the only job identity is the
 * local stand-in, so every deployed caller is refused. An ask replaces the item's open ask and sets
 * `owner:<category>` in the same batch (`askEffectOf`, the second R5 exception).
 */
export function createTrackerAskRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  const guard = {
    list: trackerAccess('GET /api/v1/projects/:slug/items/:key/asks'),
    create: trackerAccess('POST /api/v1/projects/:slug/items/:key/asks'),
  };
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/items/:key/asks', guard.list, async (c) => {
      const read = await itemReadOf(c);
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

    .post('/:slug/items/:key/asks', guard.create, writeLimit(ASK_WRITE_MAX_BYTES), async (c) => {
      const context = await trackerWriteContextOf(c);
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
