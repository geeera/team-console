import { Hono } from 'hono';
import { checkCreateCommentInput, type CommentListDto } from '@shared/contracts';
import { problem, type WorkerHonoEnv } from '@worker/core';
import { CommentsRepo } from '@worker/db';
import { commentKindRefusal } from '../../auth/policy';
import { trackerAccess } from '../../auth/tracker-access.middleware';
import type { ApiEnv } from '../../env';
import { invalid, itemOf, trackerProjectOf } from '../../tracker/context';
import { commentDtoOf } from '../../tracker/dto';
import { TEXT_WRITE_MAX_BYTES, nextCursor, pageOf, writeLimit } from '../../tracker/http';
import { idempotent } from '../../tracker/idempotency';
import { trackerWriteContextOf } from '../../tracker/write-context';

/**
 * Comments on tracker items (#410). Append-only (ADR 0006 decision 5): there is no edit or delete route. The author
 * is the identity, never a body member. The owner writes `comment`s; a job also `note`s and team `decision`s
 * (formerly `backlog decide`), a team decision not as `dev-light` (#444, `commentKindRefusal`).
 */
export function createTrackerCommentRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  const guard = {
    list: trackerAccess('GET /api/v1/projects/:slug/items/:key/comments'),
    create: trackerAccess('POST /api/v1/projects/:slug/items/:key/comments'),
  };
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/items/:key/comments', guard.list, async (c) => {
      const project = await trackerProjectOf(c);
      if (project instanceof Response) {
        return project;
      }
      const item = await itemOf(c, project);
      if (item instanceof Response) {
        return item;
      }
      const page = pageOf(c);
      if (page instanceof Response) {
        return page;
      }
      const rows = await new CommentsRepo(c.env.DB).list(item.id, page.after, page.limit + 1);
      const body: CommentListDto = {
        comments: rows.slice(0, page.limit).map(commentDtoOf),
        next: nextCursor(rows, page.limit),
      };
      c.header('Cache-Control', 'no-store');
      return c.json(body);
    })

    .post('/:slug/items/:key/comments', guard.create, writeLimit(TEXT_WRITE_MAX_BYTES), async (c) => {
      const context = await trackerWriteContextOf(c);
      if (context instanceof Response) {
        return context;
      }
      const { project, actor, policyActor, write } = context;
      const item = await itemOf(c, project);
      if (item instanceof Response) {
        return item;
      }
      const respond = async (id: number, status: 201 | 200): Promise<Response> => {
        const comment = await new CommentsRepo(c.env.DB).find(item.id, id);
        if (comment === null) {
          return problem(c, { type: 'comment-not-found', title: 'Comment not found', status: 404 });
        }
        c.header('Cache-Control', 'no-store');
        return c.json(commentDtoOf(comment), status);
      };
      return idempotent(
        c,
        write,
        (ref, status) => respond(Number(ref), status === 201 ? 201 : 200),
        async (complete) => {
          const input = checkCreateCommentInput(write.body);
          if (!input.ok) {
            return invalid(c, 'comment-invalid', input.field, input.detail);
          }
          const refusal = commentKindRefusal(policyActor, input.value.kind);
          if (refusal !== null) {
            c.get('logger').warn('tracker comment refused', { type: refusal.type, reason: refusal.reason });
            return problem(c, {
              type: refusal.type,
              title: 'Forbidden',
              status: 403,
              detail:
                policyActor.kind === 'owner'
                  ? 'The owner writes comments; decisions go through the decisions route'
                  : 'A team decision is not written by this role',
              extensions: { reason: refusal.reason },
            });
          }
          const id = await new CommentsRepo(c.env.DB).create(
            item.id,
            { kind: input.value.kind, body: input.value.body },
            actor,
            new Date().toISOString(),
            [complete(201, 'comment', { newestCommentOf: item.id })],
          );
          c.get('logger').info('tracker comment added', {
            slug: project.slug,
            number: item.number,
            kind: input.value.kind,
          });
          return respond(id, 201);
        },
      );
    });
}
