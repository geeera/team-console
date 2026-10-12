import {
  FakeGitHubOAuth,
  type FakeFault,
  type FakeIssueSeed,
  type FakeMilestoneSeed,
  type FakeThreadCommentSeed,
  type FakeUser,
} from '@worker/github/testing';

/**
 * Local only (`nx run api:fake-github`, 127.0.0.1:9999): the fake GitHub of `@worker/github/testing` as a Worker, so
 * the owner connection (#59) runs end to end against `wrangler dev` of the api with
 * `--var GITHUB_FAKE_ORIGIN:http://127.0.0.1:9999`. The api sends https://github.com/… and https://api.github.com/…
 * here as /github.com/… and /api.github.com/…; the authorize page approves at once as the current user. Controls:
 * POST /_fake/user {"login","id"}, POST /_fake/fail {"fault"}, GET /_fake/state, and for the run log (#114)
 * POST /_fake/issue (a thread to serve: repo, number, title, author, labels, repoOwner) and POST /_fake/token (a fake
 * owner token for the vendored `runlog` CLI pointed here with PT_GITHUB_API), and POST /_fake/comment (a team entry
 * written earlier into a seeded thread: repo, number, body, author, createdAt and an optional later updatedAt, in ms —
 * the board e2e, #132), POST /_fake/milestones {"repo","milestones":[{title,state,dueOn,number?}]} (the sprint
 * commands, #218; GET /_fake/milestones?repo= reads them back, milestone writes are in the state), POST /_fake/issue-update
 * {repo, number, milestone?, state?} (#219: the PM moved or closed the issue meanwhile), POST /_fake/pulls
 * {repo, pulls: [GitHub pull request JSON]} (#277: the design's head commit moves after the console loaded its
 * list). Every value here is fake.
 */

interface FakeEnv {
  readonly FAKE_GITHUB_CLIENT_ID: string;
  readonly FAKE_GITHUB_CLIENT_SECRET: string;
}

let fake: FakeGitHubOAuth | undefined;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function isFakeUser(value: unknown): value is FakeUser {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record['login'] === 'string' && typeof record['id'] === 'number';
}

function isIssueSeed(value: unknown): value is FakeIssueSeed {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['repo'] === 'string' &&
    typeof record['number'] === 'number' &&
    typeof record['title'] === 'string' &&
    typeof record['author'] === 'string' &&
    (record['labels'] === undefined || Array.isArray(record['labels'])) &&
    (record['repoOwner'] === undefined || isFakeUser(record['repoOwner']))
  );
}

interface CommentSeed extends FakeThreadCommentSeed {
  readonly repo: string;
  readonly number: number;
}

function isCommentSeed(value: unknown): value is CommentSeed {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['repo'] === 'string' &&
    typeof record['number'] === 'number' &&
    typeof record['body'] === 'string' &&
    typeof record['author'] === 'string' &&
    typeof record['createdAt'] === 'number' &&
    (record['updatedAt'] === undefined || typeof record['updatedAt'] === 'number')
  );
}

/** #219: the PM moved or closed a seeded issue meanwhile. */
interface IssueUpdate {
  readonly repo: string;
  readonly number: number;
  readonly milestone?: string | null;
  readonly state?: 'open' | 'closed';
}

function isIssueUpdate(value: unknown): value is IssueUpdate {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['repo'] === 'string' &&
    typeof record['number'] === 'number' &&
    (record['milestone'] === undefined ||
      record['milestone'] === null ||
      typeof record['milestone'] === 'string') &&
    (record['state'] === undefined || record['state'] === 'open' || record['state'] === 'closed')
  );
}

/** #277: the repository's open pull requests as GitHub's JSON, replacing the mock's list for the design reads. */
interface PullsSeed {
  readonly repo: string;
  readonly pulls: readonly Readonly<Record<string, unknown>>[];
}

function isPullsSeed(value: unknown): value is PullsSeed {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['repo'] === 'string' &&
    Array.isArray(record['pulls']) &&
    record['pulls'].every((pull) => typeof pull === 'object' && pull !== null)
  );
}

interface MilestonesSeed {
  readonly repo: string;
  readonly milestones: readonly FakeMilestoneSeed[];
}

function isMilestoneSeed(value: unknown): value is FakeMilestoneSeed {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['title'] === 'string' &&
    (record['dueOn'] === null || typeof record['dueOn'] === 'string') &&
    (record['state'] === undefined || record['state'] === 'open' || record['state'] === 'closed') &&
    (record['number'] === undefined || typeof record['number'] === 'number')
  );
}

function isMilestonesSeed(value: unknown): value is MilestonesSeed {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['repo'] === 'string' &&
    Array.isArray(record['milestones']) &&
    record['milestones'].every(isMilestoneSeed)
  );
}

async function control(server: FakeGitHubOAuth, request: Request, path: string): Promise<Response> {
  if (path === '/_fake/state') {
    return json(200, {
      activeGrants: server.activeGrants(),
      tokenEndpointCalls: server.refreshCalls(),
      calls: server.calls.map((call) => `${call.method} ${call.url}`),
      comments: server.comments,
      milestoneWrites: server.milestoneWrites,
    });
  }
  if (path === '/_fake/milestones' && request.method === 'GET') {
    return json(200, server.milestonesOf(new URL(request.url).searchParams.get('repo') ?? ''));
  }
  if (path === '/_fake/token') {
    return json(200, { token: server.issuePair().accessToken });
  }
  const body: unknown = await request.json();
  if (path === '/_fake/issue' && isIssueSeed(body)) {
    server.seedIssue(body);
    return json(200, { seeded: `${body.repo}#${body.number}` });
  }
  if (path === '/_fake/issue-update' && isIssueUpdate(body)) {
    try {
      server.updateIssue(body.repo, body.number, {
        ...(body.milestone === undefined ? {} : { milestone: body.milestone }),
        ...(body.state === undefined ? {} : { state: body.state }),
      });
      return json(200, { updated: `${body.repo}#${body.number}` });
    } catch (error: unknown) {
      return json(404, { message: error instanceof Error ? error.message : 'no such thread' });
    }
  }
  if (path === '/_fake/pulls' && isPullsSeed(body)) {
    server.seedPulls(body.repo, body.pulls);
    return json(200, { seeded: body.pulls.length });
  }
  if (path === '/_fake/milestones' && isMilestonesSeed(body)) {
    server.seedMilestones(body.repo, body.milestones);
    return json(200, { seeded: body.milestones.length });
  }
  if (path === '/_fake/comment' && isCommentSeed(body)) {
    const { repo, number, ...comment } = body;
    try {
      return json(200, { id: server.addComment(repo, number, comment) });
    } catch (error: unknown) {
      // The thread was never seeded: say so rather than fail the Worker.
      return json(404, { message: error instanceof Error ? error.message : 'no such thread' });
    }
  }
  if (path === '/_fake/user' && isFakeUser(body)) {
    server.user = { login: body.login, id: body.id };
    return json(200, server.user);
  }
  if (path === '/_fake/fail' && typeof body === 'object' && body !== null && 'fault' in body) {
    server.fail(String(body.fault) as FakeFault);
    return json(200, body);
  }
  return json(400, { message: 'unknown control' });
}

export default {
  fetch: async (request, env) => {
    if (env.FAKE_GITHUB_CLIENT_ID === '' || env.FAKE_GITHUB_CLIENT_SECRET === '') {
      return json(500, { message: 'FAKE_GITHUB_CLIENT_ID and FAKE_GITHUB_CLIENT_SECRET are required' });
    }
    fake ??= new FakeGitHubOAuth({
      clientId: env.FAKE_GITHUB_CLIENT_ID,
      clientSecret: env.FAKE_GITHUB_CLIENT_SECRET,
    });
    const url = new URL(request.url);
    if (url.pathname.startsWith('/_fake/')) {
      return control(fake, request, url.pathname);
    }
    const [, host, ...rest] = url.pathname.split('/');
    if (host !== 'github.com' && host !== 'api.github.com') {
      return json(404, { message: 'Not Found' });
    }
    return fake.handle(new Request(`https://${host}/${rest.join('/')}${url.search}`, request));
  },
} satisfies ExportedHandler<FakeEnv>;
