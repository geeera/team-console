import { isRepoFullName } from '@shared/contracts';
import type {
  PullRequestEventKind,
  VcsDelivery,
  VcsEvent,
  VcsRepositoryOfEvent,
  VcsWebhooks,
} from '@worker/vcs';
import { isCommitSha, isRecord, pullRequestOf } from './records';
import { verifyGitHubSignature } from './signature';

// `pull_request` actions that change what the `pull_requests` row holds; labels, reviews and assignees do not.
// A Map, not an object literal: an action named `constructor` must not find `Object.prototype`'s.
const PULL_REQUEST_ACTIONS: ReadonlyMap<string, PullRequestEventKind> = new Map([
  ['opened', 'pr.opened'],
  ['reopened', 'pr.reopened'],
  ['synchronize', 'pr.synchronize'],
  ['edited', 'pr.edited'],
  ['ready_for_review', 'pr.ready'],
  ['converted_to_draft', 'pr.draft'],
  ['closed', 'pr.closed'],
]);

function repositoryOf(payload: Readonly<Record<string, unknown>>): VcsRepositoryOfEvent | null {
  const repository = payload['repository'];
  if (!isRecord(repository)) {
    return null;
  }
  const id = repository['id'];
  const fullName = repository['full_name'];
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || !isRepoFullName(fullName)) {
    return null;
  }
  return { externalId: String(id), fullName };
}

function installationIdOf(payload: Readonly<Record<string, unknown>>): number | null {
  const installation = payload['installation'];
  const id = isRecord(installation) ? installation['id'] : undefined;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

function pullRequestEventOf(
  payload: Readonly<Record<string, unknown>>,
  repository: VcsRepositoryOfEvent,
  installationId: number | null,
): VcsEvent | null {
  const action = payload['action'];
  const kind = typeof action === 'string' ? PULL_REQUEST_ACTIONS.get(action) : undefined;
  if (kind === undefined) {
    return null;
  }
  const pullRequest = pullRequestOf(payload['pull_request'], repository.fullName);
  if (pullRequest === null) {
    return null;
  }
  return {
    kind: kind === 'pr.closed' && pullRequest.state === 'merged' ? 'pr.merged' : kind,
    repository,
    installationId,
    pullRequest,
  };
}

/** `workflow_run.completed` (the app subscribes to it, ADR 0003 decision 5): a CI run on that head finished. */
function ciEventOf(
  payload: Readonly<Record<string, unknown>>,
  repository: VcsRepositoryOfEvent,
  installationId: number | null,
): VcsEvent | null {
  const run = payload['workflow_run'];
  if (payload['action'] !== 'completed' || !isRecord(run) || !isCommitSha(run['head_sha'])) {
    return null;
  }
  return { kind: 'ci.completed', repository, installationId, sha: run['head_sha'] };
}

function pushEventOf(
  payload: Readonly<Record<string, unknown>>,
  repository: VcsRepositoryOfEvent,
  installationId: number | null,
): VcsEvent | null {
  const ref = payload['ref'];
  return typeof ref === 'string' && ref.startsWith('refs/') && ref.length <= 512
    ? { kind: 'push', repository, installationId, ref }
    : null;
}

/** A delivery normalised; anything the console does not act on, or of an unexpected shape, is `null`. */
export function parseGitHubDelivery(delivery: VcsDelivery): VcsEvent | null {
  const payload = delivery.payload;
  if (!isRecord(payload)) {
    return null;
  }
  const repository = repositoryOf(payload);
  if (repository === null) {
    return null;
  }
  const installationId = installationIdOf(payload);
  switch (delivery.event) {
    case 'pull_request':
      return pullRequestEventOf(payload, repository, installationId);
    case 'workflow_run':
      return ciEventOf(payload, repository, installationId);
    case 'push':
      return pushEventOf(payload, repository, installationId);
    default:
      return null;
  }
}

/** GitHub's webhooks: HMAC-SHA256 over the raw body (`X-Hub-Signature-256`) and the delivery's normalised event. */
export const githubWebhooks: VcsWebhooks = {
  verify: verifyGitHubSignature,
  parse: parseGitHubDelivery,
};
