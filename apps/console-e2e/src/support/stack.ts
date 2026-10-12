import { request as playwrightRequest, type APIRequestContext, type BrowserContext } from '@playwright/test';

/**
 * What a spec talks to. Locally (and in CI) every Playwright worker owns a `LocalStack`; with `BASE_URL` set the
 * suite runs against a deployed or Docker target instead, where only the specs that neither reset data nor need the
 * fake GitHub run (`requireLocalStack`).
 */
export interface Stack {
  readonly baseURL: string;
  /** The fake GitHub's origin; `null` when the target talks to the real GitHub. */
  readonly fakeURL: string | null;
  readonly isLocal: boolean;
  /** Fresh database and api isolate. Local stacks only. */
  reset(): Promise<void>;
  /** Every time a local server stopped serving on its own (a workerd crash, wrangler exiting); none for a target. */
  incidents(): readonly string[];
}

export interface FakeComment {
  readonly id: number;
  readonly repo: string;
  readonly issue: number;
  readonly body: string;
  readonly author: string;
}

interface FakeState {
  readonly comments: readonly FakeComment[];
}

function isFakeState(value: unknown): value is FakeState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'comments' in value &&
    Array.isArray((value as { comments: unknown }).comments)
  );
}

function fakeOf(stack: Stack): string {
  if (stack.fakeURL === null) {
    throw new Error('This step needs the fake GitHub (a local stack)');
  }
  return stack.fakeURL;
}

/** Comments the fake GitHub has received, optionally on one issue. */
export async function fakeComments(stack: Stack, issue?: number): Promise<FakeComment[]> {
  const response = await fetch(`${fakeOf(stack)}/_fake/state`);
  if (!response.ok) {
    throw new Error(`fake GitHub state: ${response.status}`);
  }
  const state: unknown = await response.json();
  if (!isFakeState(state)) {
    throw new Error('fake GitHub state has no comments list');
  }
  return state.comments.filter((comment) => issue === undefined || comment.issue === issue);
}

/**
 * The browser leaves for https://github.com exactly as in production (CSP and all); only the answer comes from the
 * fake GitHub, whose authorize page approves at once and redirects back to the api's callback.
 */
export async function routeGitHubToFake(context: BrowserContext, stack: Stack): Promise<void> {
  const fake = fakeOf(stack);
  await context.route(/^https:\/\/github\.com\//, async (route) => {
    const url = new URL(route.request().url());
    const target = `${fake}/github.com${url.pathname}${url.search}`;
    // A page that moves on at once rather than a 302: WebKit refuses redirects from route.fulfill().
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><title>github.com</title><meta http-equiv="refresh" content="0;url=${target.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">`,
    });
  });
}

/** An API client that passes the Worker's CSRF check the way the browser does. */
export async function apiClient(stack: Stack): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: stack.baseURL,
    extraHTTPHeaders: { 'Sec-Fetch-Site': 'same-origin' },
  });
}

/** The owner's OAuth round trip over HTTP, for specs whose subject is not the connect flow itself. */
export async function connectOwner(api: APIRequestContext, stack: Stack): Promise<void> {
  const fake = fakeOf(stack);
  const start = await api.post('/api/v1/github/connect', { data: {} });
  if (start.status() !== 200) {
    throw new Error(`connect: ${start.status()} ${await start.text()}`);
  }
  // A `__Host-…; Secure` cookie is not kept on plain http, so it travels to the callback by hand.
  const attemptCookie = (start.headers()['set-cookie'] ?? '').split(';')[0] ?? '';
  const body: unknown = await start.json();
  const authorizeUrl =
    typeof body === 'object' && body !== null && 'authorizeUrl' in body ? String(body.authorizeUrl) : '';
  const authorize = await api.get(authorizeUrl.replace('https://github.com', `${fake}/github.com`), {
    maxRedirects: 0,
  });
  const callback = authorize.headers()['location'];
  if (callback === undefined) {
    throw new Error(`fake authorize gave no redirect: ${authorize.status()}`);
  }
  const done = await api.get(callback, { maxRedirects: 0, headers: { Cookie: attemptCookie } });
  const landing = done.headers()['location'] ?? '';
  if (!landing.includes('github=connected')) {
    throw new Error(`connect callback landed on ${landing} (${done.status()})`);
  }
}

export async function addProject(api: APIRequestContext, repo: string): Promise<void> {
  const response = await api.post('/api/v1/projects', { data: { repo } });
  if (response.status() !== 201) {
    throw new Error(`add ${repo}: ${response.status()} ${await response.text()}`);
  }
}

export async function archiveProject(api: APIRequestContext, slug: string): Promise<void> {
  const response = await api.post(`/api/v1/projects/${slug}/archive`, { data: {} });
  if (!response.ok()) {
    throw new Error(`archive ${slug}: ${response.status()} ${await response.text()}`);
  }
}

/** A fresh database with the owner connected and the given repositories registered. */
export async function seed(stack: Stack, repos: readonly string[]): Promise<void> {
  await stack.reset();
  const api = await apiClient(stack);
  try {
    await connectOwner(api, stack);
    for (const repo of repos) {
      await addProject(api, repo);
    }
  } finally {
    await api.dispose();
  }
}
