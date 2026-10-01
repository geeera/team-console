import { isValidSlug } from '@shared/contracts';
import { kindOf, sectionOf } from '@shared/owner-grammar';
import { isTrustedAuthor } from '@worker/read-models';
import {
  addedLabelOf,
  commentOf,
  issueOf,
  pullRequestOf,
  workflowRunOf,
  type Envelope,
  type JsonObject,
} from '../github/payload';
import type { PushKind, PushLanguage, PushMessage } from '../push/push-sender';
import { PUSH_COPY, type CopyInput } from './copy';

/** The registered project a delivery belongs to, as the mapping needs it. */
export interface MappedProject {
  readonly slug: string;
  readonly displayName: string;
  readonly language: PushLanguage;
}

export type MapResult =
  | { readonly kind: 'push'; readonly message: PushMessage }
  | { readonly kind: 'ignored'; readonly reason: 'no-notification' | 'untrusted-author' };

type SpaceSection = 'questions' | 'chat' | 'board' | 'demo';

const NO_NOTIFICATION: MapResult = { kind: 'ignored', reason: 'no-notification' };
const UNTRUSTED_AUTHOR: MapResult = { kind: 'ignored', reason: 'untrusted-author' };

/** The PM routine's reply marker (Sprint 02); anyone can type it, hence the author gate. */
export const PM_REPLY_MARKER = '<!-- pt-chat:pm -->';
const RUN_LOG_LABEL = 'team:run-log';
const RELEASE_BASE = 'main';
const DEPLOY_WORKFLOW = 'deploy';
const ENVIRONMENT_OF_BRANCH: Readonly<Record<string, string>> = {
  main: 'production',
  stage: 'stage',
  dev: 'dev',
};

/** `/p/<slug>/<section>[#<n>]`: a same-origin path from the registry's slug and an integer, never payload text. */
export function deepLinkOf(slug: string, section: SpaceSection, number?: number): string {
  if (!isValidSlug(slug)) {
    throw new Error('a deep link needs a valid project slug');
  }
  return number === undefined ? `/p/${slug}/${section}` : `/p/${slug}/${section}#${String(number)}`;
}

/** `/settings/projects/<slug>`: the project's setup screen, where a lost installation is shown (#15). */
export function settingsLinkOf(slug: string): string {
  if (!isValidSlug(slug)) {
    throw new Error('a deep link needs a valid project slug');
  }
  return `/settings/projects/${slug}`;
}

export function pushMessageOf(
  project: MappedProject,
  kind: PushKind,
  url: string,
  input: Omit<CopyInput, 'project'> = {},
): PushMessage {
  const line = PUSH_COPY[project.language][kind];
  const copyInput: CopyInput = { project: project.displayName, ...input };
  return {
    kind,
    slug: project.slug,
    language: project.language,
    title: line.title(copyInput),
    body: line.body(copyInput),
    url,
    tag: url,
  };
}

function push(
  project: MappedProject,
  kind: PushKind,
  url: string,
  input?: Omit<CopyInput, 'project'>,
): MapResult {
  return { kind: 'push', message: pushMessageOf(project, kind, url, input) };
}

/** Row 1: an issue that now waits for the owner — opened that way, or the label just added made it so. */
function mapIssues(project: MappedProject, action: string | null, payload: JsonObject): MapResult {
  if (action !== 'opened' && action !== 'labeled') {
    return NO_NOTIFICATION;
  }
  const issue = issueOf(payload);
  if (issue === null) {
    return NO_NOTIFICATION;
  }
  if (!isTrustedAuthor(issue.author)) {
    return UNTRUSTED_AUTHOR;
  }
  if (sectionOf(issue.labels, kindOf(issue.labels)) === null) {
    return NO_NOTIFICATION;
  }
  if (action === 'labeled') {
    const added = addedLabelOf(payload);
    const before = issue.labels.filter((label) => label !== added);
    if (added === null || sectionOf(before, kindOf(before)) !== null) {
      return NO_NOTIFICATION;
    }
  }
  return push(project, 'decision', deepLinkOf(project.slug, 'questions', issue.number), {
    number: issue.number,
    title: issue.title,
  });
}

/** Rows 2 and 3: the PM's chat reply, or the run log saying the team paused (plugin `runstate`). */
function mapIssueComment(project: MappedProject, action: string | null, payload: JsonObject): MapResult {
  if (action !== 'created') {
    return NO_NOTIFICATION;
  }
  const comment = commentOf(payload);
  const issue = issueOf(payload);
  if (comment === null || issue === null) {
    return NO_NOTIFICATION;
  }
  if (!isTrustedAuthor(comment.author)) {
    return UNTRUSTED_AUTHOR;
  }
  if (comment.body.includes(PM_REPLY_MARKER)) {
    return push(project, 'pm-reply', deepLinkOf(project.slug, 'chat'), {
      number: issue.number,
      title: issue.title,
    });
  }
  const firstLine = comment.body.split('\n', 1)[0] ?? '';
  if (issue.labels.includes(RUN_LOG_LABEL) && firstLine.includes('paused')) {
    return push(project, 'team-paused', deepLinkOf(project.slug, 'board'));
  }
  return NO_NOTIFICATION;
}

/** Row 4: the release PR into `main` is open and ready. */
function mapPullRequest(project: MappedProject, action: string | null, payload: JsonObject): MapResult {
  if (action !== 'opened' && action !== 'ready_for_review') {
    return NO_NOTIFICATION;
  }
  const pull = pullRequestOf(payload);
  if (pull === null) {
    return NO_NOTIFICATION;
  }
  if (!isTrustedAuthor(pull.author)) {
    return UNTRUSTED_AUTHOR;
  }
  if (pull.baseRef !== RELEASE_BASE) {
    return NO_NOTIFICATION;
  }
  return push(project, 'release-ready', deepLinkOf(project.slug, 'demo'), {
    number: pull.number,
    title: pull.title,
  });
}

/**
 * Row 5: the `deploy` workflow failed. A run has no author association; a run from a fork is someone else's code
 * and someone else's workflow file, so only runs of the repository itself count.
 */
function mapWorkflowRun(project: MappedProject, envelope: Envelope, payload: JsonObject): MapResult {
  if (envelope.action !== 'completed') {
    return NO_NOTIFICATION;
  }
  const run = workflowRunOf(payload);
  if (run === null) {
    return NO_NOTIFICATION;
  }
  const repo = envelope.repository?.fullName.toLowerCase();
  if (run.headRepository === null || run.headRepository.toLowerCase() !== repo) {
    return UNTRUSTED_AUTHOR;
  }
  if (run.name !== DEPLOY_WORKFLOW || run.conclusion !== 'failure') {
    return NO_NOTIFICATION;
  }
  const branch = run.headBranch ?? '';
  return push(project, 'deploy-failed', deepLinkOf(project.slug, 'board'), {
    environment: ENVIRONMENT_OF_BRANCH[branch] ?? branch,
  });
}

/**
 * Event → push (architect note on #12, the v1 table; every row is one test). Pure: no I/O, the caller has
 * already verified, deduped, routed and filtered own writes.
 */
export function mapEvent(
  project: MappedProject,
  event: string,
  envelope: Envelope,
  payload: JsonObject,
): MapResult {
  switch (event) {
    case 'issues':
      return mapIssues(project, envelope.action, payload);
    case 'issue_comment':
      return mapIssueComment(project, envelope.action, payload);
    case 'pull_request':
      return mapPullRequest(project, envelope.action, payload);
    case 'workflow_run':
      return mapWorkflowRun(project, envelope, payload);
    default:
      return NO_NOTIFICATION;
  }
}
