import type { OwnerRequest } from '@shared/contracts';
import { pyOneLine } from './python-text';

/**
 * Owner requests to the PM (ADR 0005 decision 1), the format shared with #107 and the plugin's reader
 * (`ptlib/ownerrequests.py`, product-team 0.11.0):
 *
 *   request  line 1: <!-- pt-owner-request {"kind":"sprint","target":"next","v":1} -->
 *   handled  line 1: <!-- pt-owner-request-handled {"comment_id":123,"result":"applied","v":1} -->
 *
 * Both parsers anchor on the whole first line and accept only the canonical JSON (sorted keys, no whitespace,
 * exactly the known fields): `<!-- pt-owner-request` is a prefix of `<!-- pt-owner-request-handled`, and a quote
 * in prose or a shape this version does not know must do nothing. Golden fixtures pin both against the plugin.
 */

export type RequestLanguage = 'ru' | 'en';
export type HandledResult = 'applied' | 'declined';

export interface HandledMarker {
  readonly commentId: number;
  readonly result: HandledResult;
}

export interface RequestCommentInput {
  readonly request: OwnerRequest;
  /** The project's `owner.language`. */
  readonly language: RequestLanguage;
  /** Optional; collapsed to one line, so nothing typed can start a line of its own. */
  readonly ownerSaid?: string;
}

const REQUEST = /^<!-- pt-owner-request (\{[^\n]*\}) -->$/;
const HANDLED = /^<!-- pt-owner-request-handled (\{[^\n]*\}) -->$/;

const HUMAN_LINES: Readonly<Record<RequestLanguage, Readonly<Record<string, string>>>> = {
  ru: {
    'sprint:current': 'Просьба к PM: перенести задачу в текущий спринт.',
    'sprint:next': 'Просьба к PM: перенести задачу в следующий спринт.',
    'sprint:backlog': 'Просьба к PM: убрать задачу в бэклог, без спринта.',
    'priority:up': 'Просьба к PM: поднять задачу в очереди.',
    'priority:down': 'Просьба к PM: опустить задачу в очереди.',
  },
  en: {
    'sprint:current': 'Request to the PM: move this issue to the current sprint.',
    'sprint:next': 'Request to the PM: move this issue to the next sprint.',
    'sprint:backlog': 'Request to the PM: move this issue to the backlog, out of any sprint.',
    'priority:up': 'Request to the PM: move this issue up the queue.',
    'priority:down': 'Request to the PM: move this issue down the queue.',
  },
};

function keyOf(request: OwnerRequest): string {
  return request.kind === 'sprint' ? `sprint:${request.target}` : `priority:${request.direction}`;
}

/** The marker's JSON with sorted keys and no whitespace, as Python's `json.dumps(sort_keys=True)` writes it. */
function canonicalRequest(request: OwnerRequest): string {
  return request.kind === 'sprint'
    ? `{"kind":"sprint","target":"${request.target}","v":1}`
    : `{"direction":"${request.direction}","kind":"priority","v":1}`;
}

export function requestMarker(request: OwnerRequest): string {
  return `<!-- pt-owner-request ${canonicalRequest(request)} -->`;
}

/** The comment the console posts on the owner's token: the marker, one human line, the italic trailer. */
export function requestComment(input: RequestCommentInput): string {
  const words = pyOneLine(input.ownerSaid ?? '');
  const trailer =
    words === ''
      ? '_Requested by the owner in the team console_'
      : `_Requested by the owner in the team console: «${words}»_`;
  return `${requestMarker(input.request)}\n${HUMAN_LINES[input.language][keyOf(input.request)]}\n\n${trailer}\n`;
}

export function handledMarker(marker: HandledMarker): string {
  return `<!-- pt-owner-request-handled {"comment_id":${marker.commentId},"result":"${marker.result}","v":1} -->`;
}

/** The comment's first line; a CRLF line end is GitHub's, not part of the marker (`ownerrequests.first_line`). */
function firstLineOf(body: string): string {
  const line = body.split('\n', 1)[0] ?? '';
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function parsedObject(raw: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

/**
 * The request in a comment, or `null`. Valid fields are rebuilt into the canonical bytes and compared with the
 * line, which rejects spacing, key order, duplicate keys and escapes exactly as the plugin's `_canonical` does.
 */
export function requestMarkerOf(body: string): OwnerRequest | null {
  const match = REQUEST.exec(firstLineOf(body));
  const raw = match?.[1];
  const data = raw === undefined ? null : parsedObject(raw);
  if (data === null || data['v'] !== 1) {
    return null;
  }
  let request: OwnerRequest | null = null;
  if (data['kind'] === 'sprint' && ['current', 'next', 'backlog'].includes(String(data['target']))) {
    request = { kind: 'sprint', target: data['target'] as 'current' | 'next' | 'backlog' };
  } else if (data['kind'] === 'priority' && ['up', 'down'].includes(String(data['direction']))) {
    request = { kind: 'priority', direction: data['direction'] as 'up' | 'down' };
  }
  return request !== null && canonicalRequest(request) === raw ? request : null;
}

/** The handled marker in a comment, or `null`: integer `comment_id` > 0, `result` applied | declined, `v` 1. */
export function handledMarkerOf(body: string): HandledMarker | null {
  const match = HANDLED.exec(firstLineOf(body));
  const raw = match?.[1];
  const data = raw === undefined ? null : parsedObject(raw);
  if (data === null) {
    return null;
  }
  const commentId = data['comment_id'];
  const result = data['result'];
  if (
    typeof commentId !== 'number' ||
    !Number.isSafeInteger(commentId) ||
    commentId <= 0 ||
    (result !== 'applied' && result !== 'declined')
  ) {
    return null;
  }
  const marker: HandledMarker = { commentId, result };
  return `{"comment_id":${commentId},"result":"${result}","v":1}` === raw ? marker : null;
}
