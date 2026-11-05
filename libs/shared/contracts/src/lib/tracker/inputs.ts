import { withoutInvisibles } from '@shared/plain-text';
import { isCalendarDate } from '../sprint-commands';
import {
  COMMENT_BODY_MAX_LENGTH,
  ITEM_BODY_MAX_LENGTH,
  ITEM_TITLE_MAX_LENGTH,
  LABEL_COLOR_PATTERN,
  LABEL_DESCRIPTION_MAX_LENGTH,
  SPRINT_DESCRIPTION_MAX_LENGTH,
  isFlagName,
  isItemKind,
  isItemSeverity,
  isItemStatus,
  isItemTier,
  isSprintState,
  type ItemKind,
  type ItemSeverity,
  type ItemStatus,
  type ItemTier,
  type SprintState,
} from './vocabulary';

/**
 * Request bodies of the tracker routes and their checks (#410). A check never trusts the shape: unknown members,
 * wrong types and out-of-bound text are refused with the field to fix (422 with `extensions.field`). Titles lose
 * invisible characters (`withoutInvisibles`, #287) and surrounding whitespace; bodies are kept as typed.
 */

/** `POST …/items`. `status` defaults to `proposed`; an item is never created `done`. */
export interface CreateItemInput {
  readonly title: string;
  readonly body: string;
  readonly kind: ItemKind;
  readonly status: Exclude<ItemStatus, 'done'>;
  readonly severity: ItemSeverity | null;
  readonly tier: ItemTier | null;
  readonly sprint: number | null;
  /** Flags only; status, kind, tier and severity are their own fields. */
  readonly labels: readonly string[];
}

/** `PATCH …/items/:key` with `If-Match`. An absent member is left as it is. */
export interface UpdateItemInput {
  readonly title?: string;
  readonly body?: string;
  readonly kind?: ItemKind;
  /** `done` closes the item as done; leaving `done` reopens it. */
  readonly status?: ItemStatus;
  readonly severity?: ItemSeverity | null;
  readonly tier?: ItemTier | null;
  readonly sprint?: number | null;
  readonly addLabels?: readonly string[];
  readonly removeLabels?: readonly string[];
  /** `closed` needs `closedReason`; `open` reopens an item closed as not planned or duplicate. */
  readonly state?: 'open' | 'closed';
  readonly closedReason?: 'not-planned' | 'duplicate';
}

/** `POST …/sprints`: the next number, titled `Sprint NN`. */
export interface CreateSprintInput {
  readonly dueOn: string | null;
  readonly description: string;
}

export interface UpdateSprintInput {
  readonly dueOn?: string | null;
  readonly description?: string;
  readonly state?: SprintState;
}

/** `POST …/items/:key/comments`. The owner writes `comment`s; notes and decisions are the roles' (Phase 2). */
export interface CreateCommentInput {
  readonly body: string;
}

/** `POST …/labels`: a custom flag of the owner's. */
export interface CreateLabelInput {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export type InputCheck<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly field: string; readonly detail: string };

const MAX_LABELS = 50;

class InputError extends Error {
  constructor(
    readonly field: string,
    detail: string,
  ) {
    super(detail);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

function record(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new InputError('body', 'The body must be a JSON object');
  }
  // The member's name is the client's text, so the problem names the body, not the member.
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new InputError('body', `Only these members are allowed: ${allowed.join(', ')}`);
  }
  return body;
}

function title(value: unknown): string {
  if (typeof value !== 'string') {
    throw new InputError('title', 'title must be a string');
  }
  const cleaned = withoutInvisibles(value).trim();
  if (cleaned.length === 0 || codePoints(cleaned) > ITEM_TITLE_MAX_LENGTH) {
    throw new InputError('title', `title must be 1 to ${String(ITEM_TITLE_MAX_LENGTH)} characters`);
  }
  return cleaned;
}

function text(field: string, value: unknown, max: number, min = 0): string {
  if (typeof value !== 'string') {
    throw new InputError(field, `${field} must be a string`);
  }
  const length = codePoints(value);
  if (length < min || length > max) {
    throw new InputError(field, `${field} must be ${String(min)} to ${String(max)} characters`);
  }
  return value;
}

function oneOf<T>(field: string, value: unknown, is: (value: unknown) => value is T): T {
  if (!is(value)) {
    throw new InputError(field, `${field} is not one of the allowed values`);
  }
  return value;
}

function nullable<T>(field: string, value: unknown, is: (value: unknown) => value is T): T | null {
  return value === null ? null : oneOf(field, value, is);
}

function sprintNumber(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new InputError('sprint', 'sprint must be a sprint number or null');
  }
  return value;
}

function labels(field: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_LABELS) {
    throw new InputError(field, `${field} must be a list of at most ${String(MAX_LABELS)} labels`);
  }
  if (!value.every(isFlagName)) {
    throw new InputError(
      field,
      `${field} holds a malformed label or a status/kind/tier/sev label (those are their own fields)`,
    );
  }
  return [...new Set(value)];
}

function dueOn(value: unknown): string | null {
  if (value !== null && !isCalendarDate(value)) {
    throw new InputError('dueOn', 'dueOn must be a YYYY-MM-DD date or null');
  }
  return value;
}

function checked<T>(build: () => T): InputCheck<T> {
  try {
    return { ok: true, value: build() };
  } catch (error: unknown) {
    if (error instanceof InputError) {
      return { ok: false, field: error.field, detail: error.message };
    }
    throw error;
  }
}

const isCreateStatus = (value: unknown): value is Exclude<ItemStatus, 'done'> =>
  isItemStatus(value) && value !== 'done';

export function checkCreateItemInput(body: unknown): InputCheck<CreateItemInput> {
  return checked(() => {
    const input = record(body, ['title', 'body', 'kind', 'status', 'severity', 'tier', 'sprint', 'labels']);
    return {
      title: title(input['title']),
      body: input['body'] === undefined ? '' : text('body', input['body'], ITEM_BODY_MAX_LENGTH),
      kind: oneOf('kind', input['kind'], isItemKind),
      status: input['status'] === undefined ? 'proposed' : oneOf('status', input['status'], isCreateStatus),
      severity:
        input['severity'] === undefined ? null : nullable('severity', input['severity'], isItemSeverity),
      tier: input['tier'] === undefined ? null : nullable('tier', input['tier'], isItemTier),
      sprint: input['sprint'] === undefined ? null : sprintNumber(input['sprint']),
      labels: input['labels'] === undefined ? [] : labels('labels', input['labels']),
    };
  });
}

const isClosingReason = (value: unknown): value is 'not-planned' | 'duplicate' =>
  value === 'not-planned' || value === 'duplicate';
const isItemState = (value: unknown): value is 'open' | 'closed' => value === 'open' || value === 'closed';

export function checkUpdateItemInput(body: unknown): InputCheck<UpdateItemInput> {
  return checked(() => {
    const input = record(body, [
      'title',
      'body',
      'kind',
      'status',
      'severity',
      'tier',
      'sprint',
      'addLabels',
      'removeLabels',
      'state',
      'closedReason',
    ]);
    if (Object.keys(input).length === 0) {
      throw new InputError('body', 'Nothing to change');
    }
    const has = (key: string): boolean => key in input;
    const value: UpdateItemInput = {
      ...(has('title') ? { title: title(input['title']) } : {}),
      ...(has('body') ? { body: text('body', input['body'], ITEM_BODY_MAX_LENGTH) } : {}),
      ...(has('kind') ? { kind: oneOf('kind', input['kind'], isItemKind) } : {}),
      ...(has('status') ? { status: oneOf('status', input['status'], isItemStatus) } : {}),
      ...(has('severity') ? { severity: nullable('severity', input['severity'], isItemSeverity) } : {}),
      ...(has('tier') ? { tier: nullable('tier', input['tier'], isItemTier) } : {}),
      ...(has('sprint') ? { sprint: sprintNumber(input['sprint']) } : {}),
      ...(has('addLabels') ? { addLabels: labels('addLabels', input['addLabels']) } : {}),
      ...(has('removeLabels') ? { removeLabels: labels('removeLabels', input['removeLabels']) } : {}),
      ...(has('state') ? { state: oneOf('state', input['state'], isItemState) } : {}),
      ...(has('closedReason')
        ? { closedReason: oneOf('closedReason', input['closedReason'], isClosingReason) }
        : {}),
    };
    if ((value.state === 'closed') !== (value.closedReason !== undefined)) {
      throw new InputError('closedReason', 'closedReason goes with state "closed" and only with it');
    }
    if (value.state === 'closed' && value.status === 'done') {
      throw new InputError('state', 'status "done" already closes the item as done');
    }
    const both = (value.addLabels ?? []).find((name) => (value.removeLabels ?? []).includes(name));
    if (both !== undefined) {
      throw new InputError('removeLabels', 'A label cannot be added and removed at once');
    }
    return value;
  });
}

export function checkCreateSprintInput(body: unknown): InputCheck<CreateSprintInput> {
  return checked(() => {
    const input = record(body, ['dueOn', 'description']);
    return {
      dueOn: input['dueOn'] === undefined ? null : dueOn(input['dueOn']),
      description:
        input['description'] === undefined
          ? ''
          : text('description', input['description'], SPRINT_DESCRIPTION_MAX_LENGTH),
    };
  });
}

export function checkUpdateSprintInput(body: unknown): InputCheck<UpdateSprintInput> {
  return checked(() => {
    const input = record(body, ['dueOn', 'description', 'state']);
    if (Object.keys(input).length === 0) {
      throw new InputError('body', 'Nothing to change');
    }
    return {
      ...('dueOn' in input ? { dueOn: dueOn(input['dueOn']) } : {}),
      ...('description' in input
        ? { description: text('description', input['description'], SPRINT_DESCRIPTION_MAX_LENGTH) }
        : {}),
      ...('state' in input ? { state: oneOf('state', input['state'], isSprintState) } : {}),
    };
  });
}

export function checkCreateCommentInput(body: unknown): InputCheck<CreateCommentInput> {
  return checked(() => {
    const input = record(body, ['body']);
    const value = text('body', input['body'], COMMENT_BODY_MAX_LENGTH, 1);
    if (value.trim().length === 0) {
      throw new InputError('body', 'body must not be blank');
    }
    return { body: value };
  });
}

export function checkCreateLabelInput(body: unknown): InputCheck<CreateLabelInput> {
  return checked(() => {
    const input = record(body, ['name', 'color', 'description']);
    const name = input['name'];
    if (!isFlagName(name)) {
      throw new InputError(
        'name',
        'name must match ^[a-z][a-z0-9:-]{0,49}$ outside status:/kind:/tier:/sev:',
      );
    }
    const color = input['color'];
    if (typeof color !== 'string' || !LABEL_COLOR_PATTERN.test(color)) {
      throw new InputError('color', 'color must be six lower-case hex digits');
    }
    const description =
      input['description'] === undefined
        ? ''
        : withoutInvisibles(text('description', input['description'], LABEL_DESCRIPTION_MAX_LENGTH)).trim();
    return { name, color, description };
  });
}
