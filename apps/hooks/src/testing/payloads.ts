import { TEST_INSTALLATION_ID } from './webhook-kit';

/**
 * Webhook payloads trimmed from real GitHub App deliveries to the fields the Worker reads plus a little noise
 * (no tokens, no e-mail addresses). `repo` is `owner/name`.
 */

type Association = 'OWNER' | 'MEMBER' | 'COLLABORATOR' | 'CONTRIBUTOR' | 'NONE';

function repository(repo: string): Record<string, unknown> {
  return {
    id: 860001,
    name: repo.split('/')[1],
    full_name: repo,
    private: false,
    default_branch: 'main',
    html_url: `https://github.com/${repo}`,
  };
}

function user(login: string, type: 'User' | 'Bot' = 'User'): Record<string, unknown> {
  return { login, id: 1001, type };
}

function envelope(repo: string, installationId: number): Record<string, unknown> {
  return {
    repository: repository(repo),
    installation: { id: installationId, node_id: 'MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9u' },
    sender: user('geeera'),
  };
}

export interface IssueOptions {
  readonly repo?: string;
  readonly number?: number;
  readonly title?: string;
  readonly labels?: readonly string[];
  readonly association?: Association;
  readonly installationId?: number;
}

function issue(options: IssueOptions): Record<string, unknown> {
  return {
    number: options.number ?? 42,
    title: options.title ?? 'Pick the onboarding copy',
    state: 'open',
    labels: (options.labels ?? []).map((name) => ({ name, color: 'ededed' })),
    author_association: options.association ?? 'OWNER',
    user: user('geeera'),
    body: 'Which of the two?',
  };
}

export function issuesEvent(
  action: 'opened' | 'labeled' | 'edited' | 'closed',
  options: IssueOptions & { readonly addedLabel?: string } = {},
): Record<string, unknown> {
  const repo = options.repo ?? 'geeera/storify';
  return {
    action,
    issue: issue(options),
    ...(options.addedLabel === undefined ? {} : { label: { name: options.addedLabel } }),
    ...envelope(repo, options.installationId ?? TEST_INSTALLATION_ID),
  };
}

export function issueCommentEvent(
  options: IssueOptions & {
    readonly commentId?: number;
    readonly body?: string;
    readonly commentAssociation?: Association;
    readonly action?: 'created' | 'edited';
    /** The comment's author (#219: the team's app posts handled markers). */
    readonly commentAuthor?: { readonly login: string; readonly type: 'User' | 'Bot' };
    readonly createdAt?: string;
  } = {},
): Record<string, unknown> {
  const repo = options.repo ?? 'geeera/storify';
  return {
    action: options.action ?? 'created',
    issue: issue(options),
    comment: {
      id: options.commentId ?? 9_000_001,
      body: options.body ?? 'Looks good.',
      author_association: options.commentAssociation ?? 'OWNER',
      user: user(options.commentAuthor?.login ?? 'geeera', options.commentAuthor?.type ?? 'User'),
      created_at: options.createdAt ?? '2026-10-06T12:00:00Z',
      updated_at: options.createdAt ?? '2026-10-06T12:00:00Z',
      html_url: `https://github.com/${repo}/issues/42#issuecomment-${String(options.commentId ?? 9_000_001)}`,
    },
    ...envelope(repo, options.installationId ?? TEST_INSTALLATION_ID),
  };
}

export function pullRequestEvent(
  action: 'opened' | 'ready_for_review' | 'closed',
  options: { repo?: string; base?: string; association?: Association; number?: number } = {},
): Record<string, unknown> {
  const repo = options.repo ?? 'geeera/storify';
  return {
    action,
    number: options.number ?? 77,
    pull_request: {
      number: options.number ?? 77,
      title: 'Release 0.4.0',
      draft: false,
      base: { ref: options.base ?? 'main' },
      head: { ref: 'stage' },
      author_association: options.association ?? 'OWNER',
      user: user('geeera'),
    },
    ...envelope(repo, TEST_INSTALLATION_ID),
  };
}

export function workflowRunEvent(
  options: { repo?: string; name?: string; conclusion?: string; branch?: string; headRepo?: string } = {},
): Record<string, unknown> {
  const repo = options.repo ?? 'geeera/storify';
  return {
    action: 'completed',
    workflow_run: {
      id: 123456789,
      name: options.name ?? 'deploy',
      event: 'push',
      status: 'completed',
      conclusion: options.conclusion ?? 'failure',
      head_branch: options.branch ?? 'stage',
      head_repository: { full_name: options.headRepo ?? repo },
    },
    ...envelope(repo, TEST_INSTALLATION_ID),
  };
}

export function pushEvent(ref: string, options: { repo?: string } = {}): Record<string, unknown> {
  const repo = options.repo ?? 'geeera/storify';
  return {
    ref,
    before: 'a'.repeat(40),
    after: 'b'.repeat(40),
    commits: [],
    ...envelope(repo, TEST_INSTALLATION_ID),
  };
}

export function releaseEvent(options: { repo?: string } = {}): Record<string, unknown> {
  const repo = options.repo ?? 'geeera/storify';
  return { action: 'published', release: { tag_name: 'v0.4.0' }, ...envelope(repo, TEST_INSTALLATION_ID) };
}

export function installationRepositoriesEvent(
  action: 'added' | 'removed',
  repos: readonly string[],
  installationId = TEST_INSTALLATION_ID,
): Record<string, unknown> {
  const list = repos.map((fullName) => ({
    id: 1,
    name: fullName.split('/')[1],
    full_name: fullName,
    private: false,
  }));
  return {
    action,
    installation: { id: installationId, account: { login: 'geeera' } },
    repository_selection: 'selected',
    repositories_added: action === 'added' ? list : [],
    repositories_removed: action === 'removed' ? list : [],
    sender: user('geeera'),
  };
}

export function installationEvent(
  action: 'deleted' | 'created' | 'suspend',
  installationId = TEST_INSTALLATION_ID,
): Record<string, unknown> {
  return {
    action,
    installation: { id: installationId, account: { login: 'geeera' } },
    repositories: [],
    sender: user('geeera'),
  };
}

export function pingEvent(): Record<string, unknown> {
  return { zen: 'Keep it logically awesome.', hook_id: 1, hook: { type: 'App', events: ['issues'] } };
}
