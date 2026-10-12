import { problem, type WorkerContext } from '@worker/core';
import { GitHubError, type ListTail, type RepoName } from '@worker/github';
import type { ApiEnv } from '../env';

/**
 * The fixture-label gate of #62 and #193 (ADR 0003 decisions 1 and 8). The Access service identity (dev/stage only)
 * may write as the owner only on an issue that carries this label *and* whose newest `labeled` event for it was made
 * by the connected owner's account (numeric id pinned at connect), and never on an item whose answer is an owner
 * decision of this product: a release go/no-go, a design, or a question. Anything Issues: write can add the label, so
 * its presence alone proves nothing.
 */
export const FIXTURE_LABEL = 'e2e:fixture';

const PROTECTED_LABELS: ReadonlySet<string> = new Set(['team:demo']);
const PROTECTED_PREFIXES: readonly string[] = ['design:'];
const QUESTION_LABEL = 'kind:question';

export type ServiceWriteRefusal =
  | {
      readonly type: 'service-not-fixture';
      readonly reason:
        /** No fixture label: a real item of the product. */
        | 'no-fixture-label'
        /** The newest `labeled` event is someone else's (a bot, an app, another account), or there is none. */
        | 'fixture-not-labelled-by-owner'
        /** The label was removed after the owner's `labeled` event: what the issue shows is not what was granted. */
        | 'fixture-label-removed'
        /** The label's history could not be read or did not make sense: nothing is proven, so nothing is allowed. */
        | 'fixture-history-unreadable'
        /** No owner connection in this environment: there is no pinned owner id to compare the labeller with. */
        | 'fixture-owner-not-connected';
    }
  /**
   * Fixture label, but an owner decision the label must never unlock. Every `kind:question` counts: in
   * `same_account` mode the team asks with the owner's own credential, so the author cannot tell the two apart.
   */
  | { readonly type: 'service-protected-item'; readonly reason: 'release' | 'design' | 'question' };

/** Why the labels alone rule the service identity out, or `null` when they do not. Protection wins over the label. */
export function labelRefusal(labels: readonly string[]): ServiceWriteRefusal | null {
  if (labels.some((label) => PROTECTED_LABELS.has(label))) {
    return { type: 'service-protected-item', reason: 'release' };
  }
  if (labels.some((label) => PROTECTED_PREFIXES.some((prefix) => label.startsWith(prefix)))) {
    return { type: 'service-protected-item', reason: 'design' };
  }
  if (labels.includes(QUESTION_LABEL)) {
    return { type: 'service-protected-item', reason: 'question' };
  }
  if (!labels.includes(FIXTURE_LABEL)) {
    return { type: 'service-not-fixture', reason: 'no-fixture-label' };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An issue event as GitHub sends it; only `labeled`/`unlabeled` events for the fixture label are looked into. */
export function isIssueEvent(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

const NUMERIC_REPOSITORY_EVENTS = /^\/repositories\/[1-9][0-9]*\/issues\/([1-9][0-9]*)\/events$/;

/**
 * Whether a pagination link is a page of this issue's events: `/repos/{owner}/{repo}/issues/{n}/events` (owner and
 * name case-insensitive, as GitHub treats them) or the numeric `/repositories/{id}/issues/{n}/events` GitHub uses
 * in `Link` headers. The origin is checked by `GitHubClient` before this is asked.
 */
export function isIssueEventsPage(url: URL, repo: RepoName, issue: number): boolean {
  const numeric = NUMERIC_REPOSITORY_EVENTS.exec(url.pathname);
  if (numeric !== null) {
    return numeric[1] === String(issue);
  }
  const segments = url.pathname.split('/');
  if (segments.length !== 7) {
    return false;
  }
  const [empty, repos, owner, name, issues, number, events] = segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      // A malformed escape is not a path GitHub would send for this list.
      return '\u0000';
    }
  });
  return (
    empty === '' &&
    repos === 'repos' &&
    owner?.toLowerCase() === repo.owner.toLowerCase() &&
    name?.toLowerCase() === repo.name.toLowerCase() &&
    issues === 'issues' &&
    number === String(issue) &&
    events === 'events'
  );
}

function isFixtureLabelEvent(event: Record<string, unknown>): boolean {
  const label = event['label'];
  return (
    (event['event'] === 'labeled' || event['event'] === 'unlabeled') &&
    isRecord(label) &&
    label['name'] === FIXTURE_LABEL
  );
}

/**
 * Who applied the fixture label last, as far as the history can prove it: the numeric id of a `User` acting
 * directly (not through a GitHub App's user token — an app holding a user's token is still an app), or the refusal.
 * `history` is the tail of `GET …/issues/{n}/events` (oldest first). Fail closed: no such event in the tail, events
 * out of order, or an actor without a usable id all refuse.
 */
export function fixtureLabellerOf(
  history: ListTail<Record<string, unknown>>,
): ServiceWriteRefusal | { readonly labelledBy: number } {
  const events = history.items.filter(isFixtureLabelEvent);
  // GitHub lists events oldest first with growing ids; anything else means "newest" cannot be told.
  const ids = events.map((event) => event['id']);
  const isOrdered = ids.every(
    (id, index) =>
      typeof id === 'number' && Number.isSafeInteger(id) && (index === 0 || id > (ids[index - 1] as number)),
  );
  if (!isOrdered) {
    return { type: 'service-not-fixture', reason: 'fixture-history-unreadable' };
  }
  const newest = events.at(-1);
  if (newest === undefined) {
    // On a partial tail the owner's event may sit on an earlier page; that is not proof either.
    return { type: 'service-not-fixture', reason: 'fixture-not-labelled-by-owner' };
  }
  if (newest['event'] === 'unlabeled') {
    return { type: 'service-not-fixture', reason: 'fixture-label-removed' };
  }
  const actor = newest['actor'];
  const viaApp = newest['performed_via_github_app'];
  if (
    !isRecord(actor) ||
    actor['type'] !== 'User' ||
    typeof actor['id'] !== 'number' ||
    !Number.isSafeInteger(actor['id']) ||
    actor['id'] <= 0 ||
    (viaApp !== null && viaApp !== undefined)
  ) {
    return { type: 'service-not-fixture', reason: 'fixture-not-labelled-by-owner' };
  }
  return { labelledBy: actor['id'] };
}

/**
 * Whether the fixture label's history grants the service identity a write: the newest labeller must be the account
 * whose numeric id was pinned when the owner connected (`owner_connections.user_id`). Ids survive a login rename;
 * a login can be given up and registered by someone else. No connection (`null`) refuses.
 */
export function fixtureProvenanceRefusal(
  history: ListTail<Record<string, unknown>>,
  ownerUserId: number | null,
): ServiceWriteRefusal | null {
  const labeller = fixtureLabellerOf(history);
  if ('type' in labeller) {
    return labeller;
  }
  if (ownerUserId === null) {
    return { type: 'service-not-fixture', reason: 'fixture-owner-not-connected' };
  }
  return labeller.labelledBy === ownerUserId
    ? null
    : { type: 'service-not-fixture', reason: 'fixture-not-labelled-by-owner' };
}

function refusalResponse(c: WorkerContext<ApiEnv>, refusal: ServiceWriteRefusal, stage: string): Response {
  c.get('logger').warn('service owner write refused', {
    reason: refusal.reason,
    stage,
    method: c.req.method,
    path: c.req.path,
  });
  return problem(c, {
    type: refusal.type,
    title: 'Forbidden',
    status: 403,
    detail:
      refusal.type === 'service-not-fixture'
        ? `The service identity writes only on issues the owner labelled ${FIXTURE_LABEL}`
        : 'The service identity never writes on a release, a design or a question',
    extensions: { reason: refusal.reason },
  });
}

export interface ServiceWriteReads {
  /** The issue's events with the read-only installation token (one or two subrequests, `GitHubClient.lastPage`). */
  readonly labelHistory: () => Promise<ListTail<Record<string, unknown>>>;
  /** The pinned numeric id of this environment's owner connection, `null` without one (one D1 read, no tokens). */
  readonly ownerUserId: () => Promise<number | null>;
}

/**
 * For the service identity: the 403 that refuses an owner write on this issue, or `null` to go on. Any other
 * identity passes untouched and costs no request. Call it on labels read live, before the owner token is read,
 * refreshed or used. Each read runs only when the previous step allows the write: labels, then the history, then
 * the owner connection's pinned id (only once the newest labeller is a plain `User`).
 */
export async function refuseServiceWrite(
  c: WorkerContext<ApiEnv>,
  labels: readonly string[],
  reads: ServiceWriteReads,
): Promise<Response | null> {
  if (c.get('identity').kind !== 'service') {
    return null;
  }
  const byLabels = labelRefusal(labels);
  if (byLabels !== null) {
    return refusalResponse(c, byLabels, 'labels');
  }
  let history: ListTail<Record<string, unknown>>;
  try {
    history = await reads.labelHistory();
  } catch (error: unknown) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    c.get('logger').warn('fixture label history unreadable', { githubProblem: error.problem.type });
    return refusalResponse(
      c,
      { type: 'service-not-fixture', reason: 'fixture-history-unreadable' },
      'history',
    );
  }
  const labeller = fixtureLabellerOf(history);
  if ('type' in labeller) {
    return refusalResponse(c, labeller, 'history');
  }
  const byOwner = fixtureProvenanceRefusal(history, await reads.ownerUserId());
  if (byOwner !== null) {
    return refusalResponse(c, byOwner, 'history');
  }
  c.get('logger').info('service owner write allowed on a fixture issue', { path: c.req.path });
  return null;
}

/**
 * For the service identity: the same label check on labels read again right before the comment is posted, so a
 * label added or removed while the write was being prepared (claim, token refresh) still stops it. One more
 * subrequest, for the service identity only; a failed read throws, and the caller writes nothing. GitHub has no
 * conditional comment write, so a change inside the last request's window remains possible (#193 item 4).
 */
export async function refuseServiceWriteOnRecheck(
  c: WorkerContext<ApiEnv>,
  readLabels: () => Promise<readonly string[]>,
): Promise<Response | null> {
  if (c.get('identity').kind !== 'service') {
    return null;
  }
  const refusal = labelRefusal(await readLabels());
  return refusal === null ? null : refusalResponse(c, refusal, 'recheck');
}
