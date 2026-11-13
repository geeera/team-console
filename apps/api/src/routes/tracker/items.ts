import { Hono } from 'hono';
import {
  checkCreateItemInput,
  checkQueueMoveInput,
  checkUpdateItemInput,
  isFlagName,
  isItemKind,
  isItemSeverity,
  isItemStatus,
  isItemTier,
  isWorkableStatus,
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
  planQueueMove,
  type ItemFilter,
  type TrackerProject,
} from '@worker/db';
import { transitionRefusal, type ItemTransition } from '../../auth/policy';
import { policyActorOfContext, trackerAccess } from '../../auth/tracker-access.middleware';
import type { ApiEnv } from '../../env';
import type { ApiGitHub } from '../../github';
import {
  invalid,
  itemClosed,
  itemOf,
  keyPrefixOf,
  trackerNotCutOver,
  trackerProjectOf,
  transitionProblem,
} from '../../tracker/context';
import { bodySecretRefusal } from '../../tracker/body-secret';
import { itemDtoOf, itemEventDtoOf, itemSummaryDtoOf } from '../../tracker/dto';
import {
  SMALL_WRITE_MAX_BYTES,
  TEXT_WRITE_MAX_BYTES,
  etagOf,
  expectedVersionOf,
  nextCursor,
  pageOf,
  writeLimit,
} from '../../tracker/http';
import { withOneRetry } from '../../tracker/effect-batch';
import { idempotent } from '../../tracker/idempotency';
import { planItemUpdate, queueMoveTransition } from '../../tracker/item-change';
import { frozenSprintRefusal } from '../../tracker/sprint-freeze';
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
): Promise<{ id: number; number: number; dueOn: string | null } | null | Response> {
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
  return { id: sprint.id, number: sprint.number, dueOn: sprint.dueOn };
}

/** 428: a write that changes an item names the version it read (`If-Match: "<version>"`, the item's ETag). */
function versionRequired(c: Context): Response {
  return problem(c, {
    type: 'item-version-required',
    title: 'If-Match required',
    status: 428,
    detail: 'Send the item version you changed as If-Match: "<version>" (the ETag of the item)',
  });
}

/** 412: the item moved on since the version in `If-Match` was read. */
function stale(c: Context): Response {
  return problem(c, {
    type: 'item-version',
    title: 'The item changed since it was read',
    status: 412,
    detail: 'Read the item again and apply the change to its current version',
  });
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
 * Items of the console's own tracker (#410, ADR 0006): list, read, create and change. Who reaches each route is the
 * route matrix (`trackerAccess`: the owner and the jobs of the project); every write passes the tracker gate first,
 * carries an `Idempotency-Key`, is judged by the transition table (`auth/policy.ts`) and lands with its
 * `item_events` row in one D1 batch.
 */
export function createTrackerItemRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  // The transition table's verdict on the admitted actor; `itemNumber` is `null` for a new item.
  const judge = (c: Context, transition: ItemTransition, itemNumber: number | null): Response | null => {
    const refusal = transitionRefusal(policyActorOfContext(c), transition, itemNumber);
    return refusal === null ? null : transitionProblem(c, refusal);
  };
  const guard = {
    list: trackerAccess('GET /api/v1/projects/:slug/items'),
    create: trackerAccess('POST /api/v1/projects/:slug/items'),
    read: trackerAccess('GET /api/v1/projects/:slug/items/:key'),
    change: trackerAccess('PATCH /api/v1/projects/:slug/items/:key'),
    queue: trackerAccess('POST /api/v1/projects/:slug/items/:key/queue'),
    events: trackerAccess('GET /api/v1/projects/:slug/items/:key/events'),
    scrub: trackerAccess('POST /api/v1/projects/:slug/items/:key/events/scrub'),
  };

  return (
    new Hono<WorkerHonoEnv<ApiEnv>>()
      .get('/:slug/items', guard.list, async (c) => {
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

      .post('/:slug/items', guard.create, writeLimit(TEXT_WRITE_MAX_BYTES), async (c) => {
        const context = await trackerWriteContextOf(c);
        if (context instanceof Response) {
          return context;
        }
        const { project, actor, policyActor, write } = context;
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
            // A new item always lands in the sprint it names (there is no earlier sprint to move out of).
            if (sprint !== null) {
              const frozen = await frozenSprintRefusal(c, github, sprint);
              if (frozen !== null) {
                return frozen;
              }
            }
            const labels = await unknownLabels(c, project, 'labels', value.labels);
            if (labels !== null) {
              return labels;
            }
            const denied = judge(
              c,
              {
                before: null,
                after: {
                  status: value.status,
                  flags: [...value.labels],
                  closed: false,
                  approved: isWorkableStatus(value.status),
                },
                changesText: true,
                changesPlanning: true,
                changesUnclassified: false,
              },
              null,
            );
            if (denied !== null) {
              return denied;
            }
            // After the transition table (#474 review): a change the role may not make is 403, whatever its text.
            const secret = bodySecretRefusal(c, policyActor, { title: value.title, body: value.body });
            if (secret !== null) {
              return secret;
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
                sprint,
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

      .get('/:slug/items/:key', guard.read, async (c) => {
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

      .patch('/:slug/items/:key', guard.change, writeLimit(TEXT_WRITE_MAX_BYTES), async (c) => {
        const context = await trackerWriteContextOf(c);
        if (context instanceof Response) {
          return context;
        }
        // Checked before the key is claimed; the key's request hash covers If-Match too.
        const expectedVersion = expectedVersionOf(c);
        if (expectedVersion === null) {
          return versionRequired(c);
        }
        const { project, actor, policyActor, write } = context;
        return idempotent(
          c,
          write,
          (ref) => itemResponse(c, project, Number(ref), 200),
          async (complete) => {
            const item = await itemOf(c, project);
            if (item instanceof Response) {
              return item;
            }
            if (item.version !== expectedVersion) {
              return stale(c);
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
            // Only a move into another sprint is judged; one out of a frozen sprint, or staying, never is.
            if (sprint !== undefined && sprint !== null && sprint.number !== item.sprintNumber) {
              const frozen = await frozenSprintRefusal(c, github, sprint);
              if (frozen !== null) {
                return frozen;
              }
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
            const denied = judge(c, outcome.plan.transition, item.number);
            if (denied !== null) {
              return denied;
            }
            // After the transition table (#474 review): a change the role may not make is 403, whatever its text.
            const secret = bodySecretRefusal(c, policyActor, { title: value.title, body: value.body });
            if (secret !== null) {
              return secret;
            }
            const { patch, flags, events } = outcome.plan;
            if (
              !(await new ItemsRepo(c.env.DB).update(
                item.id,
                expectedVersion,
                patch,
                flags,
                actor,
                events,
                at,
                [done],
              ))
            ) {
              return stale(c);
            }
            c.get('logger').info('tracker item changed', {
              slug: project.slug,
              number: item.number,
              kinds: events.map((event) => event.kind).join(','),
            });
            return itemResponse(c, project, item.number, 200);
          },
        );
      })

      // #456 (#409 §2.2): First / Up / Down within the item's lane — the open items of its sprint and status. Up and
      // Down swap ranks with the neighbour, First takes min(rank) − 1024; already first or last changes nothing and
      // records no event. One D1 batch checks the item's version and the neighbour's rank; a neighbour that moved
      // meanwhile is one re-read and retry, then 409 `item-changed`.
      .post('/:slug/items/:key/queue', guard.queue, writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
        const context = await trackerWriteContextOf(c);
        if (context instanceof Response) {
          return context;
        }
        const expectedVersion = expectedVersionOf(c);
        if (expectedVersion === null) {
          return versionRequired(c);
        }
        const { project, actor, write } = context;
        return idempotent(
          c,
          write,
          (ref) => itemResponse(c, project, Number(ref), 200),
          async (complete) => {
            const input = checkQueueMoveInput(write.body);
            if (!input.ok) {
              return invalid(c, 'item-invalid', input.field, input.detail);
            }
            const items = new ItemsRepo(c.env.DB);
            return withOneRetry(c, async () => {
              const item = await itemOf(c, project);
              if (item instanceof Response) {
                return item;
              }
              if (item.version !== expectedVersion) {
                return stale(c);
              }
              if (item.closedAt !== null) {
                return itemClosed(c);
              }
              const denied = judge(c, queueMoveTransition(item), item.number);
              if (denied !== null) {
                return denied;
              }
              const lane = await items.laneOf(item.id);
              const plan = planQueueMove(lane, item.id, input.value.move);
              if (plan === null) {
                // Closed or moved between the read and the lane: let the retry read it again.
                return null;
              }
              const done = complete(200, 'item', { value: String(item.number) });
              if (plan.kind === 'noop') {
                await done.run();
                return itemResponse(c, project, item.number, 200);
              }
              const rankBefore = lane.find((row) => row.id === item.id)?.rank ?? 0;
              const outcome = await items.reorder(
                item.id,
                expectedVersion,
                rankBefore,
                plan,
                actor,
                new Date().toISOString(),
                [done],
              );
              if (outcome === 'stale') {
                return stale(c);
              }
              if (outcome === 'lost-race') {
                return null;
              }
              c.get('logger').info('tracker item reordered', {
                slug: project.slug,
                number: item.number,
                move: input.value.move,
              });
              return itemResponse(c, project, item.number, 200);
            });
          },
        );
      })

      .get('/:slug/items/:key/events', guard.events, async (c) => {
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
      })

      // #462 (ADR 0008 row 2-0): incident response for a secret that reached an item's title or body. The owner corrects
      // the item, then masks the old text its created/edited events keep; the scrub records itself as a `scrubbed` event.
      .post('/:slug/items/:key/events/scrub', guard.scrub, writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
        const context = await trackerWriteContextOf(c);
        if (context instanceof Response) {
          return context;
        }
        const { project, actor, write } = context;
        const item = await itemOf(c, project);
        if (item instanceof Response) {
          return item;
        }
        const events = new ItemEventsRepo(c.env.DB);
        const respond = async (id: number, status: 200 | 201): Promise<Response> => {
          const event = await events.find(item.id, id);
          if (event === null) {
            return problem(c, { type: 'item-not-found', title: 'Item event not found', status: 404 });
          }
          c.header('Cache-Control', 'no-store');
          return c.json(itemEventDtoOf(event), status);
        };
        return idempotent(
          c,
          write,
          (ref, status) => respond(Number(ref), status === 201 ? 201 : 200),
          async (complete) => {
            if (!isEmptyBody(write.body)) {
              return invalid(c, 'item-invalid', 'body', 'A scrub takes no members; send {} or no body');
            }
            const scrub = await events.scrub(item.id, actor, new Date().toISOString(), [
              complete(201, 'event', { newestEventOf: item.id }),
            ]);
            c.get('logger').info('tracker item events scrubbed', {
              slug: project.slug,
              number: item.number,
              events: scrub.masked,
            });
            return respond(scrub.eventId, 201);
          },
        );
      })
  );
}

/** No body, or an empty JSON object. */
function isEmptyBody(body: unknown): boolean {
  return (
    body === undefined ||
    (typeof body === 'object' && body !== null && !Array.isArray(body) && Object.keys(body).length === 0)
  );
}
