import { problem, type WorkerContext } from '@worker/core';
import type { RepoName } from '@worker/github';
import type { ApiEnv } from '../env';

/**
 * The fixture-label gate of #62 (owner decision 2026-10-05, ADR 0003 decisions 1 and 8). The Access service
 * identity (dev/stage only) may write as the owner only on an issue that carries this label, and never on an item
 * whose answer is an owner decision of this product: a release go/no-go, a design, or a question the team asked.
 */
export const FIXTURE_LABEL = 'e2e:fixture';

const PROTECTED_LABELS: ReadonlySet<string> = new Set(['team:demo']);
const PROTECTED_PREFIXES: readonly string[] = ['design:'];
const QUESTION_LABEL = 'kind:question';

/** The live issue as the gate needs it: label names and who opened it (`null` for a deleted account). */
export interface GatedIssue {
  readonly labels: readonly string[];
  readonly authorLogin: string | null;
  readonly authorType: string | null;
}

export type ServiceWriteRefusal =
  /** No fixture label: a real item of the product. */
  | { readonly type: 'service-not-fixture'; readonly reason: 'no-fixture-label' }
  /** Fixture label, but the item is an owner decision the label must never unlock. */
  | { readonly type: 'service-protected-item'; readonly reason: 'release' | 'design' | 'team-question' };

/**
 * A question counts as the team's unless the repository owner's own account opened it. Fail closed: a bot, an
 * outsider or a deleted account all count as the team, so only a fixture the owner filed can be answered.
 */
function isOwnersOwnIssue(issue: GatedIssue, repo: RepoName): boolean {
  return (
    issue.authorType === 'User' &&
    issue.authorLogin !== null &&
    issue.authorLogin.toLowerCase() === repo.owner.toLowerCase()
  );
}

/** Why the service identity may not write on this issue, or `null` when it may. Protection wins over the label. */
export function serviceWriteRefusal(issue: GatedIssue, repo: RepoName): ServiceWriteRefusal | null {
  if (issue.labels.some((label) => PROTECTED_LABELS.has(label))) {
    return { type: 'service-protected-item', reason: 'release' };
  }
  if (issue.labels.some((label) => PROTECTED_PREFIXES.some((prefix) => label.startsWith(prefix)))) {
    return { type: 'service-protected-item', reason: 'design' };
  }
  if (issue.labels.includes(QUESTION_LABEL) && !isOwnersOwnIssue(issue, repo)) {
    return { type: 'service-protected-item', reason: 'team-question' };
  }
  if (!issue.labels.includes(FIXTURE_LABEL)) {
    return { type: 'service-not-fixture', reason: 'no-fixture-label' };
  }
  return null;
}

/**
 * For the service identity: the 403 that refuses an owner write on this issue, or `null` to go on. Any other
 * identity passes untouched. Call it on labels read live, before the owner token is read, minted or used.
 */
export function refuseServiceWrite(
  c: WorkerContext<ApiEnv>,
  issue: GatedIssue,
  repo: RepoName,
): Response | null {
  if (c.get('identity').kind !== 'service') {
    return null;
  }
  const refusal = serviceWriteRefusal(issue, repo);
  if (refusal === null) {
    c.get('logger').info('service owner write allowed on a fixture issue', { path: c.req.path });
    return null;
  }
  c.get('logger').warn('service owner write refused', {
    reason: refusal.reason,
    method: c.req.method,
    path: c.req.path,
  });
  return problem(c, {
    type: refusal.type,
    title: 'Forbidden',
    status: 403,
    detail:
      refusal.type === 'service-not-fixture'
        ? `The service identity writes only on issues labelled ${FIXTURE_LABEL}`
        : 'The service identity never writes on a release, a design or a question the team asked',
    extensions: { reason: refusal.reason },
  });
}
