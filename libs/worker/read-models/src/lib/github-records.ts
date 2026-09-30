/**
 * The few fields of GitHub's issue, milestone and pull request JSON the read models use. Guards narrow GitHub's
 * answer; the records are our own shapes, cached and turned into DTOs — no GitHub type leaves the Worker.
 */

export interface IssueRecord {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly htmlUrl: string;
  readonly state: 'open' | 'closed';
  readonly labels: readonly string[];
  readonly authorAssociation: string;
  /** The issues API lists pull requests too; the plugin drops them (`"pull_request" not in i`). */
  readonly isPullRequest: boolean;
}

export interface MilestoneRecord {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  /** ISO timestamp as GitHub sends it, `null` without a due date. */
  readonly dueOn: string | null;
  readonly htmlUrl: string;
}

export interface PullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly htmlUrl: string;
  readonly draft: boolean;
  readonly authorAssociation: string;
}

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIssueNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isLabel(value: unknown): boolean {
  // REST sends label objects; a plain name is accepted as well, as the plugin's `slim` does not care either.
  return typeof value === 'string' || (isRecord(value) && typeof value['name'] === 'string');
}

function labelName(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return isRecord(value) && typeof value['name'] === 'string' ? value['name'] : '';
}

export function isGitHubIssue(value: unknown): value is JsonRecord {
  return (
    isRecord(value) &&
    isIssueNumber(value['number']) &&
    typeof value['title'] === 'string' &&
    (value['body'] === null || value['body'] === undefined || typeof value['body'] === 'string') &&
    typeof value['html_url'] === 'string' &&
    (value['state'] === 'open' || value['state'] === 'closed') &&
    Array.isArray(value['labels']) &&
    value['labels'].every(isLabel) &&
    typeof value['author_association'] === 'string'
  );
}

/** Call only on a value `isGitHubIssue` accepted. */
export function issueRecordOf(raw: JsonRecord): IssueRecord {
  const labels = Array.isArray(raw['labels']) ? raw['labels'].map(labelName) : [];
  return {
    number: Number(raw['number']),
    title: String(raw['title']),
    body: typeof raw['body'] === 'string' ? raw['body'] : '',
    htmlUrl: String(raw['html_url']),
    state: raw['state'] === 'closed' ? 'closed' : 'open',
    labels,
    authorAssociation: String(raw['author_association']),
    isPullRequest: raw['pull_request'] !== undefined && raw['pull_request'] !== null,
  };
}

export function isGitHubMilestone(value: unknown): value is JsonRecord {
  return (
    isRecord(value) &&
    isIssueNumber(value['number']) &&
    typeof value['title'] === 'string' &&
    typeof value['state'] === 'string' &&
    (value['due_on'] === null || typeof value['due_on'] === 'string') &&
    typeof value['html_url'] === 'string'
  );
}

/** Call only on a value `isGitHubMilestone` accepted. */
export function milestoneRecordOf(raw: JsonRecord): MilestoneRecord {
  return {
    number: Number(raw['number']),
    title: String(raw['title']),
    state: String(raw['state']),
    dueOn: typeof raw['due_on'] === 'string' ? raw['due_on'] : null,
    htmlUrl: String(raw['html_url']),
  };
}

export function isGitHubPullRequest(value: unknown): value is JsonRecord {
  return (
    isRecord(value) &&
    isIssueNumber(value['number']) &&
    typeof value['title'] === 'string' &&
    typeof value['html_url'] === 'string' &&
    (value['draft'] === undefined || typeof value['draft'] === 'boolean') &&
    typeof value['author_association'] === 'string'
  );
}

/** Call only on a value `isGitHubPullRequest` accepted. */
export function pullRequestRecordOf(raw: JsonRecord): PullRequestRecord {
  return {
    number: Number(raw['number']),
    title: String(raw['title']),
    htmlUrl: String(raw['html_url']),
    draft: raw['draft'] === true,
    authorAssociation: String(raw['author_association']),
  };
}
