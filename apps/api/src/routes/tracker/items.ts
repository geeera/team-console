import { Hono } from 'hono';
import {
  checkCreateItemInput,
  checkUpdateItemInput,
  isFlagName,
  isItemKind,
  isItemSeverity,
  isItemStatus,
  isItemTier,
  type ItemEventListDto,
  type ItemListDto,
} from '@shared/contracts';
import { withoutInvisibles } from '@shared/plain-text';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import {
  ItemEventsRepo,
  ItemsRepo,
  LabelsRepo,
  SprintsRepo,
  TrackerProjectsRepo,
  type ItemFilter,
  type TrackerProject,
} from '@worker/db';
import { ownerOnlyMiddleware } from '../../auth/owner-only.middleware';
import type { Identity } from '../../auth/auth.types';
import { transitionRefusal, type ItemTransition, type PolicyActor } from '../../auth/policy';
import type { ApiEnv } from '../../env';
import {
  invalid,
  itemOf,
  keyPrefixOf,
  trackerNotCutOver,
  trackerProjectOf,
  transitionProblem,
} from '../../tracker/context';
import { itemDtoOf, itemEventDtoOf, itemSummaryDtoOf } from '../../tracker/dto';
import {
  TEXT_WRITE_MAX_BYTES,
  etagOf,
  expectedVersionOf,
  nextCursor,
  pageOf,
  writeLimit,
} from '../../tracker/http';
import { idempotent } from '../../tracker/idempotency';
import { planItemUpdate } from '../../tracker/item-change';
import { trackerWriteContextOf } from '../../tracker/write-context';

type Context = WorkerContext<ApiEnv>;

const SPRINT_FILTER = /^(none|[1-9][0-9]{0,8})$/;

type ColumnFilter = 'status' | 'kind' | 'severity' | 'tier';
const COLUMN_FILTERS: readonly (readonly [ColumnFilter, string, (value: unknown) => boolean])[] = [
  ['status', 'status:', isItemStatus],
  ['kind', 'kind:', isItemKind],
  ['severity', 'sev:', isItemSeverity],
  ['tier', 'tier:', isItemTier],
];

/** `GET …/items` filters; `label` names a flag or a column label (`tier:heavy` filters the tier). */
function filterOf(c: Context): ItemFilter | Response {
  const state = c.req.query('state') ?? 'open';
  if (state !== 'open' && state !== 'closed' && state !== 'all') {
    return invalid(c, 'query-invalid', 'state', 'state is open, closed or all');
  }
  const filter: Record<string, string | number> = {};
  const label = c.req.query('label');
  for (const [name, prefix, is] of COLUMN_FILTERS) {
    const fromLabel = label?.startsWith(prefix) === true ? label.slice(prefix.length) : undefined;
    const value = fromLabel ?? c.req.query(name);
    if (value !== undefined) {
      if (!is(value)) {
        return invalid(
          c,
          'query-invalid',
          fromLabel === undefined ? name : 'label',
          `${name} is not a known value`,
        );
      }
      filter[name] = value;
    }
  }
  if (label !== undefined && !COLUMN_FILTERS.some(([, prefix]) => label.startsWith(prefix))) {
    if (!isFlagName(label)) {
      return invalid(c, 'query-invalid', 'label', 'label is not a label name');
    }
    filter['flag'] = label;
  }
  const sprint = c.req.query('sprint');
  if (sprint !== undefined) {
    if (!SPRINT_FILTER.test(sprint)) {
      return invalid(c, 'query-invalid', 'sprint', 'sprint is a sprint number or none');
    }
    filter['sprint'] = sprint === 'none' ? 'none' : Number(sprint);
  }
  // Every value above passed its guard; the record only gathers them.
  return { ...filter, state } as ItemFilter;
}

async function itemResponse(
  c: Context,
  project: TrackerProject,
  number: number,
  status: 200 | 201,
): Promise<Response> {
  const item = await new ItemsRepo(c.env.DB).findByNumber(project.slug, number);
  if (item === null) {
    return problem(c, { type: 'item-not-found', title: 'Item not found', status: 404 });
  }
  const dto = itemDtoOf(keyPrefixOf(project), item);
  c.header('ETag', etagOf(item.version));
  c.header('Cache-Control', 'no-store');
  if (status === 201) {
    c.header('Location', `/api/v1/projects/${project.slug}/items/${dto.key}`);
  }
  return c.json(dto, status);
}

/** The sprint `number` names in the project: its id, `null` for none, or the 422 when it is unknown or closed. */
async function sprintOf(
  c: Context,
  project: TrackerProject,
  number: number | null,
): Promise<{ id: number; number: number } | null | Response> {
  if (number === null) {
    return null;
  }
  const sprint = await new SprintsRepo(c.env.DB).findByNumber(project.slug, number);
  if (sprint === null) {
    return invalid(c, 'item-invalid', 'sprint', 'The project has no sprint with this number');
  }
  if (sprint.state === 'closed') {
    return invalid(c, 'item-invalid', 'sprint', 'The sprint is closed');
  }
  return { id: sprint.id, number: sprint.number };
}

async function unknownLabels(
  c: Context,
  project: TrackerProject,
  field: string,
  names: readonly string[],
): Promise<Response | null> {
  const missing = await new LabelsRepo(c.env.DB).missing(project.slug, names);
  return missing.length === 0
    ? null
    : invalid(c, 'item-invalid', field, 'A label is not one of the project labels; create it first');
}

/**
 * Items of the console's own tracker (#410, ADR 0006): list, read, create and change. Owner-only in Phase 1a (the
 * `job` identity arrives with Phase 2 of #309); every write passes the tracker gate first, carries an
 * `Idempotency-Key`, is judged by the transition table (`auth/policy.ts`, for the actor `policyActorOf` names) and
 * lands with its `item_events` row in one D1 batch.
 */
export function createTrackerItemRoutes(
  policyActorOf: (identity: Identity) => PolicyActor | null,
): Hono<WorkerHonoEnv<ApiEnv>> {
  // The transition table's verdict for this request; no actor (the service identity) is refused outright.
  const judge = (c: Context, transition: ItemTransition): Response | null => {
    const actor = policyActorOf(c.get('identity'));
    if (actor === null) {
      return problem(c, { type: 'owner-only', title: 'Forbidden', status: 403 });
    }
    const refusal = transitionRefusal(actor, transition);
    return refusal === null ? null : transitionProblem(c, refusal);
  };

  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/items', ownerOnlyMiddleware, async (c) => {
      const project = await trackerProjectOf(c);
      if (project instanceof Response) {
        return project;
      }
      const filter = filterOf(c);
      const page = pageOf(c);
      if (filter instanceof Response) {
        return filter;
      }
      if (page instanceof Response) {
        return page;
      }
      const result = await new ItemsRepo(c.env.DB).list(project.slug, filter, page.after, page.limit);
      const body: ItemListDto = {
        items: result.items.map((item) => itemSummaryDtoOf(keyPrefixOf(project), item)),
        next: result.next,
      };
      c.header('Cache-Control', 'no-store');
      return c.json(body);
    })

    .post('/:slug/items', ownerOnlyMiddleware, writeLimit(TEXT_WRITE_MAX_BYTES), async (c) => {
      const context = await trackerWriteContextOf(c);
      if (context instanceof Response) {
        return context;
      }
      const { project, actor, write } = context;
      return idempotent(
        c,
        write,
        (ref, status) => itemResponse(c, project, Number(ref), status === 201 ? 201 : 200),
        async (complete) => {
          const input = checkCreateItemInput(write.body);
          if (!input.ok) {
            return invalid(c, 'item-invalid', input.field, input.detail);
          }
          const { value } = input;
          const sprint = await sprintOf(c, project, value.sprint);
          if (sprint instanceof Response) {
            return sprint;
          }
          const labels = await unknownLabels(c, project, 'labels', value.labels);
          if (labels !== null) {
            return labels;
          }
          const denied = judge(c, {
            before: null,
            after: { status: value.status, flags: [...value.labels], closed: false },
            changesOtherFields: true,
          });
          if (denied !== null) {
            return denied;
          }
          const number = await new TrackerProjectsRepo(c.env.DB).allocateItemNumber(project.slug);
          if (number === null) {
            // The project went back to GitHub Issues (or was archived) between the gate and here.
            return trackerNotCutOver(c);
          }
          const at = new Date().toISOString();
          await new ItemsRepo(c.env.DB).create(
            project.slug,
            {
              number,
              kind: value.kind,
              status: value.status,
              severity: value.severity,
              tier: value.tier,
              sprintId: sprint?.id ?? null,
              title: withoutInvisibles(value.title),
              body: value.body,
              flags: value.labels,
            },
            actor,
            at,
            [complete(201, 'item', { value: String(number) })],
          );
          c.get('logger').info('tracker item created', { slug: project.slug, number });
          return itemResponse(c, project, number, 201);
        },
      );
    })

    .get('/:slug/items/:key', ownerOnlyMiddleware, async (c) => {
      const project = await trackerProjectOf(c);
      if (project instanceof Response) {
        return project;
      }
      const item = await itemOf(c, project);
      if (item instanceof Response) {
        return item;
      }
      c.header('ETag', etagOf(item.version));
      c.header('Cache-Control', 'no-store');
      return c.json(itemDtoOf(keyPrefixOf(project), item));
    })

    .patch('/:slug/items/:key', ownerOnlyMiddleware, writeLimit(TEXT_WRITE_MAX_BYTES), async (c) => {
      const context = await trackerWriteContextOf(c);
      if (context instanceof Response) {
        return context;
      }
      // Checked before the key is claimed; the key's request hash covers If-Match too.
      const expectedVersion = expectedVersionOf(c);
      if (expectedVersion === null) {
        return problem(c, {
          type: 'item-version-required',
          title: 'If-Match required',
          status: 428,
          detail: 'Send the item version you changed as If-Match: "<version>" (the ETag of the item)',
        });
      }
      const { project, actor, write } = context;
      return idempotent(
        c,
        write,
        (ref) => itemResponse(c, project, Number(ref), 200),
        async (complete) => {
          const item = await itemOf(c, project);
          if (item instanceof Response) {
            return item;
          }
          const stale = (): Response =>
            problem(c, {
              type: 'item-version',
              title: 'The item changed since it was read',
              status: 412,
              detail: 'Read the item again and apply the change to its current version',
            });
          if (item.version !== expectedVersion) {
            return stale();
          }
          const input = checkUpdateItemInput(write.body);
          if (!input.ok) {
            return invalid(c, 'item-invalid', input.field, input.detail);
          }
          const { value } = input;
          const sprint = value.sprint === undefined ? undefined : await sprintOf(c, project, value.sprint);
          if (sprint instanceof Response) {
            return sprint;
          }
          const labels = await unknownLabels(c, project, 'addLabels', value.addLabels ?? []);
          if (labels !== null) {
            return labels;
          }
          const at = new Date().toISOString();
          const outcome = planItemUpdate(item, value, sprint, at);
          if (outcome.kind === 'invalid') {
            return invalid(c, 'item-invalid', outcome.field, outcome.detail);
          }
          const done = complete(200, 'item', { value: String(item.number) });
          if (outcome.kind === 'unchanged') {
            await done.run();
            return itemResponse(c, project, item.number, 200);
          }
          const denied = judge(c, outcome.plan.transition);
          if (denied !== null) {
            return denied;
          }
          const { patch, flags, event } = outcome.plan;
          if (
            !(await new ItemsRepo(c.env.DB).update(item.id, expectedVersion, patch, flags, actor, event, at, [
              done,
            ]))
          ) {
            return stale();
          }
          c.get('logger').info('tracker item changed', {
            slug: project.slug,
            number: item.number,
            kind: event.kind,
          });
          return itemResponse(c, project, item.number, 200);
        },
      );
    })

    .get('/:slug/items/:key/events', ownerOnlyMiddleware, async (c) => {
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
      const rows = await new ItemEventsRepo(c.env.DB).list(item.id, page.after, page.limit + 1);
      const body: ItemEventListDto = {
        events: rows.slice(0, page.limit).map(itemEventDtoOf),
        next: nextCursor(rows, page.limit),
      };
      c.header('Cache-Control', 'no-store');
      return c.json(body);
    });
}
