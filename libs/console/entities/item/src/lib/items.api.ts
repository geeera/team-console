import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { httpProblemOf, isAccessSessionExpired } from '@console/shared/api';
import type {
  AskDto,
  CommentDto,
  CreateDecisionInput,
  DecisionDto,
  ItemDto,
  ItemEventDto,
  ItemSummaryDto,
  TrackerSprintDto,
  TrackerSprintListDto,
  UpdateItemInput,
} from '@shared/contracts';
import { firstValueFrom, timeout } from 'rxjs';
import {
  isAskListDto,
  isCommentDto,
  isCommentListDto,
  isDecisionDto,
  isDecisionListDto,
  isItemDto,
  isItemEventListDto,
  isItemListDto,
  isSprintFreezeDaysDto,
  isTrackerSprintCountsDto,
  isTrackerSprintDto,
  isTrackerSprintListDto,
} from './item.model';
import { TRACKER_WRITE_TIMEOUT_MS, trackerFailureOf, type TrackerFailure } from './tracker-failure';

/** `/api/v1/projects/:slug/items…`; the number is an integer, the slug is encoded, nothing else reaches the path. */
export function itemsUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/items`;
}

export function itemUrl(slug: string, number: number): string {
  return `${itemsUrl(slug)}/${String(number)}`;
}

export function sprintsUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/sprints`;
}

/** `POST …/items/:n/decisions` (#434): the owner's answer to a console-tracker item. */
export function decisionsUrl(slug: string, number: number): string {
  return `${itemUrl(slug, number)}/decisions`;
}

/** `GET …/sprint-freeze` (#457): project.yml's `sprint.freeze_days`, read by the Worker. */
export function sprintFreezeUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/sprint-freeze`;
}

/** How a read ended, as the screens show it: the value, or why not. */
export type TrackerRead<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'offline' | 'forbidden' | 'session-expired' | 'error';
    };

export type TrackerWrite<T> =
  | { readonly ok: true; readonly value: T; readonly replayed: boolean }
  | { readonly ok: false; readonly failure: TrackerFailure };

/** Pages a cursor list fully, at most this many pages: a list past it is shown as far as it was read. */
const MAX_PAGES = 20;
const PAGE_LIMIT = 100;

function readFailureOf(error: unknown): TrackerRead<never> {
  if (!(error instanceof HttpErrorResponse)) {
    return { ok: false, reason: 'error' };
  }
  if (isAccessSessionExpired(error, error.error)) {
    return { ok: false, reason: 'session-expired' };
  }
  const problem = httpProblemOf(error);
  if (problem.status === 0) {
    return { ok: false, reason: 'offline' };
  }
  if (problem.status === 404) {
    return { ok: false, reason: 'not-found' };
  }
  if (problem.status === 403) {
    return { ok: false, reason: 'forbidden' };
  }
  return { ok: false, reason: 'error' };
}

/** An item list query: the filters the items route takes (`status`, `sprint=N|none`, `state`, …). */
export type ItemQuery = Readonly<Record<string, string>>;

/**
 * The console tracker's HTTP surface (#410, #434) for the screens. Never throws: every read is a `TrackerRead`,
 * every write a `TrackerWrite`. Every write carries the caller's `Idempotency-Key` (kept by the caller across a
 * retry, so a retry is never applied twice) and, where the route needs it, `If-Match` with the version that was read.
 */
@Injectable({ providedIn: 'root' })
export class ItemsApi {
  private readonly http = inject(HttpClient);

  async item(slug: string, number: number): Promise<TrackerRead<ItemDto>> {
    return this.read(itemUrl(slug, number), isItemDto);
  }

  async events(slug: string, number: number): Promise<TrackerRead<ItemEventDto[]>> {
    return this.pages(`${itemUrl(slug, number)}/events`, (body) =>
      isItemEventListDto(body) ? { rows: body.events, next: body.next } : null,
    );
  }

  async comments(slug: string, number: number): Promise<TrackerRead<CommentDto[]>> {
    return this.pages(`${itemUrl(slug, number)}/comments`, (body) =>
      isCommentListDto(body) ? { rows: body.comments, next: body.next } : null,
    );
  }

  async decisions(slug: string, number: number): Promise<TrackerRead<DecisionDto[]>> {
    return this.pages(`${itemUrl(slug, number)}/decisions`, (body) =>
      isDecisionListDto(body) ? { rows: body.decisions, next: body.next } : null,
    );
  }

  async asks(slug: string, number: number): Promise<TrackerRead<AskDto[]>> {
    return this.pages(`${itemUrl(slug, number)}/asks`, (body) =>
      isAskListDto(body) ? { rows: body.asks, next: body.next } : null,
    );
  }

  /** `whole`: a list longer than the page cap is an `error`, never a partial list (the board's counts, #556). */
  async items(
    slug: string,
    query: ItemQuery = {},
    whole = false,
  ): Promise<TrackerRead<ItemSummaryDto[]>> {
    return this.pages(
      itemsUrl(slug),
      (body) => (isItemListDto(body) ? { rows: body.items, next: body.next } : null),
      query,
      whole,
    );
  }

  async sprints(slug: string): Promise<TrackerRead<TrackerSprintDto[]>> {
    const read = await this.read(sprintsUrl(slug), isTrackerSprintListDto);
    return read.ok ? { ok: true, value: [...read.value.sprints] } : read;
  }

  /** The sprints with each one's open count and the backlog's (#561), for the board's folder headers. */
  async sprintList(slug: string): Promise<TrackerRead<TrackerSprintListDto>> {
    return this.read(sprintsUrl(slug), isTrackerSprintCountsDto);
  }

  /** The project's freeze length in days; the screens fall back to the plugin's default when it cannot be read. */
  async freezeDays(slug: string): Promise<TrackerRead<number>> {
    const read = await this.read(sprintFreezeUrl(slug), isSprintFreezeDaysDto);
    return read.ok ? { ok: true, value: read.value.freezeDays } : read;
  }

  /**
   * `POST …/items/:n/decisions` (#434), no `If-Match`: the owner's decision names the open ask it answers (`askId`,
   * required while a console ask is open, #443). The caller keeps one key per intended decision, so a repeat after a
   * drop or a timeout is answered from the first write (`replayed`), never recorded twice.
   */
  async decide(
    slug: string,
    number: number,
    decision: CreateDecisionInput,
    idempotencyKey: string,
  ): Promise<TrackerWrite<DecisionDto>> {
    const headers = new HttpHeaders({ 'Idempotency-Key': idempotencyKey });
    return this.write('POST', decisionsUrl(slug, number), decision, headers, isDecisionDto);
  }

  /** `PATCH …/items/:n` with `If-Match: "<version>"`; a 412 is `conflict`. */
  async update(
    slug: string,
    number: number,
    version: number,
    change: UpdateItemInput,
    idempotencyKey: string,
  ): Promise<TrackerWrite<ItemDto>> {
    const headers = new HttpHeaders({
      'Idempotency-Key': idempotencyKey,
      'If-Match': `"${String(version)}"`,
    });
    return this.write('PATCH', itemUrl(slug, number), change, headers, isItemDto);
  }

  /** `POST …/items/:n/comments`: append-only, no `If-Match`. */
  async comment(
    slug: string,
    number: number,
    body: string,
    idempotencyKey: string,
  ): Promise<TrackerWrite<CommentDto>> {
    const headers = new HttpHeaders({ 'Idempotency-Key': idempotencyKey });
    return this.write('POST', `${itemUrl(slug, number)}/comments`, { body }, headers, isCommentDto);
  }

  /** `POST …/sprints`: the next number, named `title` (#457) or `Sprint NN` by the server; the demo day is the owner's. */
  async createSprint(
    slug: string,
    sprint: { readonly dueOn: string; readonly title: string | null },
    idempotencyKey: string,
  ): Promise<TrackerWrite<TrackerSprintDto>> {
    const headers = new HttpHeaders({ 'Idempotency-Key': idempotencyKey });
    const body =
      sprint.title === null ? { dueOn: sprint.dueOn } : { dueOn: sprint.dueOn, title: sprint.title };
    return this.write('POST', sprintsUrl(slug), body, headers, isTrackerSprintDto);
  }

  /** A write of `body` to `url`, answered as `T`; the timeout makes a hanging write a `timeout` failure. */
  async write<T>(
    method: 'POST' | 'PATCH',
    url: string,
    body: unknown,
    headers: HttpHeaders,
    is: (value: unknown) => value is T,
  ): Promise<TrackerWrite<T>> {
    try {
      const response = await firstValueFrom(
        this.http
          .request<unknown>(method, url, { body, headers, observe: 'response' })
          .pipe(timeout(TRACKER_WRITE_TIMEOUT_MS)),
      );
      if (!is(response.body)) {
        // A 2xx we cannot read may still be a write: the retry is answered from the idempotency record.
        return { ok: false, failure: { kind: 'unknown', field: null, retryAfter: null } };
      }
      return {
        ok: true,
        value: response.body,
        replayed: response.headers.get('Idempotent-Replayed') === 'true',
      };
    } catch (error: unknown) {
      return { ok: false, failure: trackerFailureOf(error) };
    }
  }

  private async read<T>(url: string, is: (value: unknown) => value is T): Promise<TrackerRead<T>> {
    try {
      const body = await firstValueFrom(this.http.get<unknown>(url));
      return is(body) ? { ok: true, value: body } : { ok: false, reason: 'error' };
    } catch (error: unknown) {
      return readFailureOf(error);
    }
  }

  private async pages<T>(
    url: string,
    pageOf: (body: unknown) => { readonly rows: readonly T[]; readonly next: number | null } | null,
    query: ItemQuery = {},
    whole = false,
  ): Promise<TrackerRead<T[]>> {
    const rows: T[] = [];
    let after: number | null = null;
    let isComplete = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let params = new HttpParams({ fromObject: { ...query, limit: String(PAGE_LIMIT) } });
      if (after !== null) {
        params = params.set('after', String(after));
      }
      let body: unknown;
      try {
        body = await firstValueFrom(this.http.get<unknown>(url, { params }));
      } catch (error: unknown) {
        return readFailureOf(error);
      }
      const read = pageOf(body);
      if (read === null) {
        return { ok: false, reason: 'error' };
      }
      rows.push(...read.rows);
      if (read.next === null) {
        isComplete = true;
        break;
      }
      after = read.next;
    }
    return whole && !isComplete ? { ok: false, reason: 'error' } : { ok: true, value: rows };
  }
}
