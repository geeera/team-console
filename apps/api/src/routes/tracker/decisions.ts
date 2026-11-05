import { Hono } from 'hono';
import {
  checkCreateDecisionInput,
  type CreateDecisionInput,
  type DecisionListDto,
  type Section,
} from '@shared/contracts';
import { ANSWERS, NEEDS_REASON, isAnswerCommand, sectionOf } from '@shared/owner-grammar';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import {
  AsksRepo,
  CommentsRepo,
  OwnerDecisionsRepo,
  type ItemRecord,
  type TrackerActor,
  type TrackerProject,
} from '@worker/db';
import { decisionEffectOf } from '../../auth/policy';
import { trackerAccess } from '../../auth/tracker-access.middleware';
import type { ApiEnv } from '../../env';
import { invalid, itemOf } from '../../tracker/context';
import { decisionDtoOf, labelsOf } from '../../tracker/dto';
import { withOneRetry, writeWithItemEffect } from '../../tracker/effect-batch';
import { ASK_WRITE_MAX_BYTES, nextCursor, writeLimit } from '../../tracker/http';
import { idempotent, type CompleteKey } from '../../tracker/idempotency';
import { planItemUpdate, type ItemUpdatePlan } from '../../tracker/item-change';
import { itemReadOf } from '../../tracker/item-reads';
import { trackerWriteContextOf } from '../../tracker/write-context';

type Context = WorkerContext<ApiEnv>;

function commandRefusal(c: Context, detail: string): Response {
  return invalid(c, 'decision-command', 'command', detail);
}

/** The item's inbox section as the GitHub inbox classifies it (the plugin's grammar), `null` when closed. */
function sectionOfItem(item: ItemRecord): Section | null {
  return item.closedAt === null ? sectionOf(labelsOf(item), item.kind) : null;
}

interface Judged {
  readonly plan: ItemUpdatePlan | null;
}

/**
 * Steps 2–6 of the architect note on #434 §5 over the item as read now: the section, the commands it (or its open
 * console ask) accepts, the reason, the ask binding, the reversal, and the effect. A refusal is the problem.
 */
async function judge(
  c: Context,
  item: ItemRecord,
  input: CreateDecisionInput,
  at: string,
): Promise<Judged | Response> {
  const section = sectionOfItem(item);
  if (section === null) {
    return commandRefusal(c, 'This item is not waiting for the owner');
  }
  const open = await new AsksRepo(c.env.DB).findOpen(item.id);
  // #443: a decision names the console ask it answers. Without `askId` the owner may be answering an ask that was
  // replaced (new wording, new commands) between their read and the write, so an open console ask demands it.
  const isAskMissing = input.askId === null && open !== null && open.source === 'console';
  if (isAskMissing || (input.askId !== null && input.askId !== open?.id)) {
    return problem(c, {
      type: 'ask-not-open',
      title: 'The question changed',
      status: 409,
      detail: isAskMissing
        ? 'The item has an open question; send its askId'
        : 'The ask was answered or replaced since it was read; read the item again',
    });
  }
  const allowed = open !== null && open.source === 'console' ? open.commands : ANSWERS[section];
  // `resume` is Phase 4's (`team_state`): the CHECK admits it, the route does not yet.
  if (!isAnswerCommand(input.command) || !allowed.includes(input.command)) {
    return commandRefusal(c, `This item takes ${allowed.join(', ')}`);
  }
  if (NEEDS_REASON.has(input.command) && input.text.trim() === '') {
    return invalid(c, 'decision-invalid', 'text', `${input.command} needs the reason in text`);
  }
  if (open !== null && open.source === 'import') {
    // R7: an imported question is re-confirmed on the cutover screen, never answered as is.
    return problem(c, {
      type: 'ask-imported',
      title: 'An imported question',
      status: 409,
      detail: 'Re-confirm the imported question on the cutover screen first',
    });
  }
  if (input.reversesCommentId !== null) {
    const comment = await new CommentsRepo(c.env.DB).find(item.id, input.reversesCommentId);
    if (
      input.command !== 'reject' ||
      comment === null ||
      comment.kind !== 'decision' ||
      comment.reversedByDecisionId !== null
    ) {
      return invalid(
        c,
        'decision-invalid',
        'reversesCommentId',
        'Only a reject reverses a team decision of this item that is not reversed yet',
      );
    }
  }
  const effect = decisionEffectOf(section, input.command, item);
  if (effect === null) {
    return { plan: null };
  }
  const outcome = planItemUpdate(item, effect, undefined, at);
  if (outcome.kind === 'invalid') {
    // The table only names changes `planItemUpdate` accepts; anything else is a bug, never a partial write.
    throw new Error(`decision effect refused: ${outcome.field}`);
  }
  return { plan: outcome.kind === 'change' ? outcome.plan : null };
}

const OWNER: TrackerActor = { kind: 'owner', name: 'owner', jobId: null };

async function decide(
  c: Context,
  project: TrackerProject,
  found: ItemRecord,
  input: CreateDecisionInput,
  idempotencyKey: string,
  complete: CompleteKey,
): Promise<Response> {
  const decisions = new OwnerDecisionsRepo(c.env.DB);
  return withOneRetry(c, async (isRetry) => {
    const item = isRetry ? await itemOf(c, project) : found;
    if (item instanceof Response) {
      return item;
    }
    const at = new Date().toISOString();
    const judged = await judge(c, item, input, at);
    if (judged instanceof Response) {
      return judged;
    }
    // `judge` has bound `input.askId` to the open console ask; an imported one never gets here (R7).
    const askId = input.askId;
    const written = await writeWithItemEffect(c.env.DB, item, judged.plan, OWNER, at, [
      ...decisions.createStatements(
        project.slug,
        item.id,
        {
          command: input.command,
          text: input.text,
          askId,
          reversesCommentId: input.reversesCommentId,
          via: input.via,
          idempotencyKey,
        },
        OWNER,
        at,
      ),
      complete(201, 'decision', { newestDecisionOf: item.id }),
    ]);
    if (!written) {
      return null;
    }
    const recorded = await decisions.findByKey(item.id, idempotencyKey);
    c.get('logger').info('tracker decision recorded', {
      slug: project.slug,
      number: item.number,
      command: input.command,
      answered: askId !== null,
      effect: judged.plan?.events.map((event) => event.kind).join(',') ?? 'none',
    });
    if (recorded === null) {
      return problem(c, { type: 'decision-not-found', title: 'Decision not found', status: 404 });
    }
    c.header('Cache-Control', 'no-store');
    return c.json(decisionDtoOf(recorded), 201);
  });
}

/**
 * The owner's decisions (#434, ADR 0006 decision 4 and Phase 1a′). Owner-only (the route matrix; a job gets 403);
 * the decision, the answer of its ask, the reversal of a team decision and the item's effects (R5's transition table,
 * `decisionEffectOf`) land in one batch. No `If-Match`: the decision is about the ask, not a version the owner
 * edited; a moved version re-reads once, then 409 `item-changed`.
 */
export function createTrackerDecisionRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  const guard = {
    list: trackerAccess('GET /api/v1/projects/:slug/items/:key/decisions'),
    create: trackerAccess('POST /api/v1/projects/:slug/items/:key/decisions'),
  };
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/items/:key/decisions', guard.list, async (c) => {
      const read = await itemReadOf(c);
      if (read instanceof Response) {
        return read;
      }
      const rows = await new OwnerDecisionsRepo(c.env.DB).list(
        read.item.id,
        read.page.after,
        read.page.limit + 1,
      );
      const body: DecisionListDto = {
        decisions: rows.slice(0, read.page.limit).map(decisionDtoOf),
        next: nextCursor(rows, read.page.limit),
      };
      c.header('Cache-Control', 'no-store');
      return c.json(body);
    })

    .post('/:slug/items/:key/decisions', guard.create, writeLimit(ASK_WRITE_MAX_BYTES), async (c) => {
      const context = await trackerWriteContextOf(c);
      if (context instanceof Response) {
        return context;
      }
      const { project, write } = context;
      const found = await itemOf(c, project);
      if (found instanceof Response) {
        return found;
      }
      return idempotent(
        c,
        write,
        async (ref, status) => {
          const decision = await new OwnerDecisionsRepo(c.env.DB).find(found.id, Number(ref));
          if (decision === null) {
            return problem(c, { type: 'decision-not-found', title: 'Decision not found', status: 404 });
          }
          c.header('Cache-Control', 'no-store');
          return c.json(decisionDtoOf(decision), status === 201 ? 201 : 200);
        },
        async (complete) => {
          const input = checkCreateDecisionInput(write.body);
          if (!input.ok) {
            return invalid(c, 'decision-invalid', input.field, input.detail);
          }
          return decide(c, project, found, input.value, write.key, complete);
        },
      );
    });
}
