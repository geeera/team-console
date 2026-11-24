import { InputError, checked, record, type InputCheck } from './inputs';

/**
 * The owner's scrub (#462, #477): incident response for a secret that reached stored text. The request names what to
 * mask and nothing else: the text itself is never sent, and every masked value becomes the same marker.
 */

/** The most rows of one kind a single scrub names; a larger incident is several requests. */
export const SCRUB_IDS_MAX = 50;

/**
 * `POST …/items/:key/events/scrub`. No body, or `{}`, masks the item's history alone (`events`), as #462 shipped it.
 * A body with members masks exactly what it names: `events: true` for the title and body kept by the item's
 * `created`, `edited` and `imported` events, and the ids of the item's own comments, asks and handled requests.
 */
export interface ScrubItemInput {
  readonly events: boolean;
  readonly comments: readonly number[];
  readonly asks: readonly number[];
  /** Requests whose `reason` (the PM's answer) is masked. */
  readonly requests: readonly number[];
}

export const SPRINT_SCRUB_FIELDS = ['title', 'description'] as const;
export type SprintScrubField = (typeof SPRINT_SCRUB_FIELDS)[number];

/** `POST …/sprints/:number/scrub`: which of the sprint's two texts to mask, at least one. */
export interface ScrubSprintInput {
  readonly fields: readonly SprintScrubField[];
}

function ids(field: string, value: unknown): number[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > SCRUB_IDS_MAX) {
    throw new InputError(field, `${field} must be a list of 1 to ${String(SCRUB_IDS_MAX)} ids`);
  }
  const list = value as readonly unknown[];
  if (!list.every((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id >= 1)) {
    throw new InputError(field, `${field} must hold positive integer ids`);
  }
  if (new Set(list).size !== list.length) {
    throw new InputError(field, `${field} must not repeat an id`);
  }
  return [...list];
}

export function checkScrubItemInput(body: unknown): InputCheck<ScrubItemInput> {
  return checked(() => {
    const input = body === undefined ? {} : record(body, ['events', 'comments', 'asks', 'requests']);
    if (Object.keys(input).length === 0) {
      return { events: true, comments: [], asks: [], requests: [] };
    }
    const events = input['events'] ?? false;
    if (typeof events !== 'boolean') {
      throw new InputError('events', 'events must be true or false');
    }
    const value: ScrubItemInput = {
      events,
      comments: ids('comments', input['comments']),
      asks: ids('asks', input['asks']),
      requests: ids('requests', input['requests']),
    };
    if (!value.events && value.comments.length + value.asks.length + value.requests.length === 0) {
      throw new InputError('body', 'Nothing to scrub');
    }
    return value;
  });
}

export function checkScrubSprintInput(body: unknown): InputCheck<ScrubSprintInput> {
  return checked(() => {
    const fields = record(body, ['fields'])['fields'];
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new InputError('fields', 'fields must name title, description or both');
    }
    const list = fields as readonly unknown[];
    const named = SPRINT_SCRUB_FIELDS.filter((field) => list.includes(field));
    if (named.length !== list.length) {
      throw new InputError('fields', 'fields must name title, description or both, each once');
    }
    return { fields: named };
  });
}
