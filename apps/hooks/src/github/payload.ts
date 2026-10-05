import type { IssueAuthor } from '@worker/read-models';

/**
 * The few fields of a GitHub webhook payload this Worker reads, narrowed from `unknown` — never the full GitHub
 * types, never stored. Even a correctly signed payload is untrusted content (threat model on #12): text fields
 * are only interpolated into push copy, numbers only into paths built here.
 */
export type JsonObject = Readonly<Record<string, unknown>>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectAt(source: JsonObject, key: string): JsonObject | null {
  const value = source[key];
  return isJsonObject(value) ? value : null;
}

function stringAt(source: JsonObject, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function positiveIntAt(source: JsonObject, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export interface RepositoryRef {
  readonly fullName: string;
  readonly defaultBranch: string | null;
}

/** What every delivery may carry: the action, the repository and the app installation it came through. */
export interface Envelope {
  readonly action: string | null;
  readonly repository: RepositoryRef | null;
  readonly installationId: number | null;
}

export function envelopeOf(payload: JsonObject): Envelope {
  const repository = objectAt(payload, 'repository');
  const fullName = repository === null ? null : stringAt(repository, 'full_name');
  const installation = objectAt(payload, 'installation');
  return {
    action: stringAt(payload, 'action'),
    repository:
      repository === null || fullName === null
        ? null
        : { fullName, defaultBranch: stringAt(repository, 'default_branch') },
    installationId: installation === null ? null : positiveIntAt(installation, 'id'),
  };
}

function authorOf(item: JsonObject): IssueAuthor {
  const user = objectAt(item, 'user');
  return {
    authorAssociation: stringAt(item, 'author_association') ?? 'NONE',
    authorLogin: user === null ? null : stringAt(user, 'login'),
    authorType: user === null ? null : stringAt(user, 'type'),
  };
}

function labelNamesOf(item: JsonObject): string[] {
  const labels = item['labels'];
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels.flatMap((label: unknown) => {
    const name = isJsonObject(label) ? stringAt(label, 'name') : null;
    return name === null ? [] : [name];
  });
}

export interface IssueRef {
  readonly number: number;
  readonly title: string;
  readonly labels: readonly string[];
  readonly author: IssueAuthor;
}

export function issueOf(payload: JsonObject): IssueRef | null {
  const issue = objectAt(payload, 'issue');
  const number = issue === null ? null : positiveIntAt(issue, 'number');
  if (issue === null || number === null) {
    return null;
  }
  return {
    number,
    title: stringAt(issue, 'title') ?? '',
    labels: labelNamesOf(issue),
    author: authorOf(issue),
  };
}

/** `issues.labeled`: the label that was just added. */
export function addedLabelOf(payload: JsonObject): string | null {
  const label = objectAt(payload, 'label');
  return label === null ? null : stringAt(label, 'name');
}

export interface CommentRef {
  readonly id: number;
  readonly body: string;
  readonly author: IssueAuthor;
}

export function commentOf(payload: JsonObject): CommentRef | null {
  const comment = objectAt(payload, 'comment');
  const id = comment === null ? null : positiveIntAt(comment, 'id');
  if (comment === null || id === null) {
    return null;
  }
  return { id, body: stringAt(comment, 'body') ?? '', author: authorOf(comment) };
}

export interface PullRequestRef {
  readonly number: number;
  readonly title: string;
  readonly baseRef: string | null;
  readonly author: IssueAuthor;
}

export function pullRequestOf(payload: JsonObject): PullRequestRef | null {
  const pull = objectAt(payload, 'pull_request');
  const number = pull === null ? null : positiveIntAt(pull, 'number');
  if (pull === null || number === null) {
    return null;
  }
  const base = objectAt(pull, 'base');
  return {
    number,
    title: stringAt(pull, 'title') ?? '',
    baseRef: base === null ? null : stringAt(base, 'ref'),
    author: authorOf(pull),
  };
}

export interface WorkflowRunRef {
  readonly name: string | null;
  readonly conclusion: string | null;
  readonly headBranch: string | null;
  /** `null` when GitHub omits it; a fork's run carries the fork's name here. */
  readonly headRepository: string | null;
}

export function workflowRunOf(payload: JsonObject): WorkflowRunRef | null {
  const run = objectAt(payload, 'workflow_run');
  if (run === null) {
    return null;
  }
  const headRepository = objectAt(run, 'head_repository');
  return {
    name: stringAt(run, 'name'),
    conclusion: stringAt(run, 'conclusion'),
    headBranch: stringAt(run, 'head_branch'),
    headRepository: headRepository === null ? null : stringAt(headRepository, 'full_name'),
  };
}

/** `push`: the full ref that was pushed, e.g. `refs/heads/main`. */
export function pushRefOf(payload: JsonObject): string | null {
  return stringAt(payload, 'ref');
}

/** `installation_repositories`: the `full_name`s of `repositories_added` or `repositories_removed`. */
export function repositoriesOf(
  payload: JsonObject,
  key: 'repositories_added' | 'repositories_removed',
): string[] {
  const list = payload[key];
  if (!Array.isArray(list)) {
    return [];
  }
  return list.flatMap((item: unknown) => {
    const name = isJsonObject(item) ? stringAt(item, 'full_name') : null;
    return name === null ? [] : [name];
  });
}
