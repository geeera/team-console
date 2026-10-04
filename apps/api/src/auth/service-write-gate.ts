import { problem, type WorkerContext } from '@worker/core';
import { GitHubError, type ListTail } from '@worker/github';
import type { ApiEnv } from '../env';

/**
 * The fixture-label gate of #62 and #193 (ADR 0003 decisions 1 and 8). The Access service identity (dev/stage only)
 * may write as the owner only on an issue that carries this label *and* whose newest `labeled` event for it was made
 * by the owner's own account, and never on an item whose answer is an owner decision of this product: a release
 * go/no-go, a design, or a question. Anything Issues: write can add the label, so its presence alone proves nothing.
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
        /** The newest `labeled` event is someone else's (a bot, an app, another user), or there is none. */
        | 'fixture-not-labelled-by-owner'
        /** The label was removed after the owner's `labeled` event: what the issue shows is not what was granted. */
        | 'fixture-label-removed'
        /** The label's history could not be read or did not make sense: nothing is proven, so nothing is allowed. */
        | 'fixture-history-unreadable';
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

function isFixtureLabelEvent(event: Record<string, unknown>): boolean {
  const label = event['label'];
  return (
    (event['event'] === 'labeled' || event['event'] === 'unlabeled') &&
    isRecord(label) &&
    label['name'] === FIXTURE_LABEL
  );
}

/**
 * The owner's own hand: a `User` (never a `Bot`, an app or an organisation) whose login is the configured owner's,
 * not acting through a GitHub App's user token (an app holding the owner's token is still an app).
 */
function isOwnersOwnAct(event: Record<string, unknown>, ownerLogin: string): boolean {
  const actor = event['actor'];
  const viaApp = event['performed_via_github_app'];
  return (
    isRecord(actor) &&
    actor['type'] === 'User' &&
    typeof actor['login'] === 'string' &&
    actor['login'].toLowerCase() === ownerLogin.toLowerCase() &&
    (viaApp === null || viaApp === undefined)
  );
}

/**
 * Whether the fixture label's history grants the service identity a write: the newest `labeled`/`unlabeled` event
 * for it must be a `labeled` one by the owner. `history` is the tail of `GET …/issues/{n}/events` (oldest first).
 * Fail closed: no owner login configured, no such event in the tail, or events out of order all refuse.
 */
export function fixtureProvenanceRefusal(
  history: ListTail<Record<string, unknown>>,
  ownerLogin: string,
): ServiceWriteRefusal | null {
  const owner = ownerLogin.trim();
  if (owner === '') {
    return { type: 'service-not-fixture', reason: 'fixture-not-labelled-by-owner' };
  }
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
  return isOwnersOwnAct(newest, owner)
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

/**
 * For the service identity: the 403 that refuses an owner write on this issue, or `null` to go on. Any other
 * identity passes untouched and costs no request. Call it on labels read live, before the owner token is read,
 * minted or used. `readLabelHistory` reads the issue's events with the read-only installation token (one or two
 * subrequests, `GitHubClient.lastPage`); it runs only once the labels themselves allow the write.
 */
export async function refuseServiceWrite(
  c: WorkerContext<ApiEnv>,
  labels: readonly string[],
  readLabelHistory: () => Promise<ListTail<Record<string, unknown>>>,
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
    history = await readLabelHistory();
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
  const byHistory = fixtureProvenanceRefusal(history, c.env.OWNER_GITHUB_LOGIN ?? '');
  if (byHistory !== null) {
    return refusalResponse(c, byHistory, 'history');
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
