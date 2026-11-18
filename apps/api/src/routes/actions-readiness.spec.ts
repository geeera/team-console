import { env } from 'cloudflare:test';
import type { RunnerWorkflowRendering } from '@shared/actions-workflow';
import {
  ACTIONS_SETUP_ITEMS,
  OWNER_ACCOUNT_ID,
  isActionsSetupDto,
  isProblemDetails,
  problemSlugOf,
  type ActionsSetupDto,
  type ActionsSetupItemDto,
  type ActionsSetupItemId,
  type ActionsSetupStatus,
} from '@shared/contracts';
import { ApiGitHub } from '../github';
import { fetchApi } from '../testing/access-kit';
import {
  ENVIRONMENT_ID,
  SETUP_ORIGIN,
  SETUP_PR_NUMBER,
  answerSetupRead,
  consolePull,
  isAllowedSetupPath,
  readyWorld,
  renderingFor,
  type SetupWorld,
} from '../testing/actions-setup-kit';
import { saveAccessSource } from '../testing/actions-oidc-kit';
import { INSTALLATION_ID, TOKEN_SENTINEL, json, localEnv, stubGitHub, type StubGitHub } from '../testing/github-kit';
import { seedMembership, seedSession, seedSessionUser, seedUser, sendAsSession } from '../testing/session-kit';
import { seedTrackerProject } from '../testing/tracker-kit';
import { READINESS_CHECKS_PER_WINDOW } from './actions-setup-problems';

// #759 PR 3: `GET …/actions-setup`, the Actions readiness check (architect note §4; security note rows "Readiness
// over-reads or leaks", "Readiness used as authorisation", "Cross-tenant or member trigger", "A PR that is not the
// console's is shown as the console's"; SEC 5 of PR 1's review).

/** An installation whose mint the kit answers (refused or not); `stubGitHub` mints INSTALLATION_ID itself. */
const SCRIPTED_INSTALLATION = 7781;
/** An installation linked to another account. */
const FOREIGN_INSTALLATION = 7782;
const ACCOUNT_B = '01M6YSNJ00000000000000RDB2';
// Assembled at run time: names that must never leave GitHub's answers.
const REVIEWER_SENTINEL = ['reviewer', 'SENTINEL', 'login'].join('-');
const OTHER_SECRET_SENTINEL = ['OTHER', 'SECRET', 'SENTINEL'].join('_');
const DATE_SENTINEL = '2026-11-02T00:00:00Z';

async function linkInstallation(accountId: string, installationId: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO installations (account_id, provider, installation_id, account_login, linked_at)
     SELECT ?1, 'github', ?2, 'acme', '2026-11-01T00:00:00.000Z'
     WHERE NOT EXISTS (SELECT 1 FROM installations WHERE provider = 'github' AND installation_id = ?2 AND unlinked_at IS NULL)`,
  )
    .bind(accountId, String(installationId))
    .run();
}

let rendering: RunnerWorkflowRendering;

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT INTO accounts (id, slug, name, created_at) SELECT ?1, 'rd-b', 'B', '2026-11-01T00:00:00.000Z'
     WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE id = ?1)`,
  )
    .bind(ACCOUNT_B)
    .run();
  await linkInstallation(OWNER_ACCOUNT_ID, INSTALLATION_ID);
  await linkInstallation(OWNER_ACCOUNT_ID, SCRIPTED_INSTALLATION);
  await linkInstallation(ACCOUNT_B, FOREIGN_INSTALLATION);
  rendering = await renderingFor();
});

interface Fixture {
  readonly slug: string;
  readonly repo: string;
  readonly world: SetupWorld;
  readonly stub: StubGitHub;
}

async function seedReadyProject(options: { installationId?: number; source?: 'api_key' | 'subscription' } = {}): Promise<Fixture> {
  const { slug } = await seedTrackerProject();
  const row = await env.DB.prepare(`SELECT repo, repo_id FROM projects WHERE slug = ?1`)
    .bind(slug)
    .first<{ repo: string; repo_id: number }>();
  if (row === null) {
    throw new Error('seeded project missing');
  }
  const installationId = options.installationId ?? INSTALLATION_ID;
  await env.DB.prepare(`UPDATE projects SET installation_id = ?2 WHERE slug = ?1`).bind(slug, installationId).run();
  if ((options.source ?? 'api_key') === 'api_key') {
    const project = { slug, accountId: OWNER_ACCOUNT_ID, repoId: row.repo_id, repo: row.repo, defaultBranch: 'main' };
    expect(await saveAccessSource(project, 'api_key', 0)).toBe('saved');
  }
  const world = readyWorld(row.repo_id, rendering);
  world.installationId = installationId;
  const stub = stubGitHub((call) => answerSetupRead(world, row.repo, rendering, call) ?? json(404, { message: 'Not Found' }));
  return { slug, repo: row.repo, world, stub };
}

async function check(fixture: Fixture, options: { origin?: string; logs?: string[] } = {}): Promise<Response> {
  return fetchApi(`/api/v1/projects/${fixture.slug}/actions-setup`, localEnv({ CONSOLE_PUBLIC_ORIGIN: SETUP_ORIGIN }), {
    origin: options.origin ?? SETUP_ORIGIN,
    github: new ApiGitHub({ fetch: fixture.stub.fetch }),
    ...(options.logs === undefined ? {} : { logSink: (line: string) => options.logs?.push(line) }),
  });
}

async function setupOf(fixture: Fixture, logs?: string[]): Promise<ActionsSetupDto> {
  const response = await check(fixture, logs === undefined ? {} : { logs });
  expect(response.status, await response.clone().text()).toBe(200);
  const body: unknown = await response.json();
  expect(isActionsSetupDto(body)).toBe(true);
  return body as ActionsSetupDto;
}

function itemOf(setup: ActionsSetupDto, id: ActionsSetupItemId): ActionsSetupItemDto {
  const found = setup.items.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`no ${id} item`);
  }
  return found;
}

const statuses = (setup: ActionsSetupDto): Record<string, ActionsSetupStatus> =>
  Object.fromEntries(setup.items.map((entry) => [entry.id, entry.status]));

async function slugOf(response: Response): Promise<string | null> {
  const body: unknown = await response.clone().json();
  return isProblemDetails(body) ? problemSlugOf(body.type) : null;
}

const scopedMints = (stub: StubGitHub) =>
  stub.calls.filter((call) => call.url.pathname.endsWith('/access_tokens') && (call.body ?? '').includes('repository_ids'));
const revokes = (stub: StubGitHub) =>
  stub.calls.filter((call) => call.method === 'DELETE' && call.url.pathname === '/installation/token');

describe('GET /api/v1/projects/:slug/actions-setup: a ready repository', () => {
  it('answers every item ok in the page’s order, ready, with the exact key set', async () => {
    const fixture = await seedReadyProject();
    const setup = await setupOf(fixture);
    expect(setup.ready).toBe(true);
    expect(setup.dispatch).toBe('pull');
    expect(setup.accessSource).toBe('api_key');
    expect(setup.items.map((entry) => entry.id)).toEqual([...ACTIONS_SETUP_ITEMS]);
    expect(setup.items.every((entry) => entry.status === 'ok')).toBe(true);
    expect(Object.keys(setup).sort()).toEqual(['accessSource', 'checkedAt', 'dispatch', 'items', 'ready']);
    // An ok item carries no link and no PR: nothing to fix, nothing to merge.
    expect(setup.items.every((entry) => Object.keys(entry).sort().join(',') === 'id,status')).toBe(true);
  });

  it('mints environment-read once for the one repository, revokes it, and reads only the allowed paths', async () => {
    const fixture = await seedReadyProject();
    await setupOf(fixture);
    const [mint, ...more] = scopedMints(fixture.stub);
    expect(more).toEqual([]);
    expect(JSON.parse(mint?.body ?? '{}')).toEqual({
      repository_ids: [fixture.world.repoId],
      permissions: { actions: 'read', environments: 'read' },
    });
    expect(revokes(fixture.stub)).toHaveLength(1);
    expect(fixture.stub.calls.filter((call) => !isAllowedSetupPath(fixture.repo, call)).map((call) => call.url.pathname)).toEqual([]);
    expect(fixture.stub.calls.some((call) => /\/variables|\/secrets$/.test(call.url.pathname))).toBe(false);
    expect(fixture.stub.calls.every((call) => call.method === 'GET' || call.method === 'DELETE' || call.url.pathname.endsWith('/access_tokens'))).toBe(true);
  });

  it('is never cached: Cache-Control no-store, and each call reads GitHub again', async () => {
    const fixture = await seedReadyProject();
    const response = await check(fixture);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const first = fixture.stub.calls.length;
    await setupOf(fixture);
    expect(fixture.stub.calls.length).toBeGreaterThan(first);
  });
});

describe('each missing piece is named, with where to fix it on GitHub', () => {
  it('no Environment: environment, branch policy and secret missing, linked to the new-Environment page', async () => {
    const fixture = await seedReadyProject();
    fixture.world.environment = null;
    const setup = await setupOf(fixture);
    expect(setup.ready).toBe(false);
    expect(statuses(setup)).toMatchObject({ environment: 'missing', 'branch-policy': 'missing', secret: 'missing', 'protection-rules': 'unknown' });
    expect(itemOf(setup, 'environment').link).toBe(`https://github.com/${fixture.repo}/settings/environments/new`);
  });

  it.each([
    ['every branch may deploy', { deployment_branch_policy: null }, null, 'missing'],
    ['protected branches instead of a rule', { deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, null, 'wrong'],
    ['a second rule', {}, [{ name: 'main', type: 'branch' }, { name: 'release-*', type: 'branch' }], 'wrong'],
    ['a tag rule', {}, [{ name: 'main', type: 'tag' }], 'wrong'],
    ['another branch', {}, [{ name: 'dev', type: 'branch' }], 'wrong'],
    ['no rule listed', {}, [], 'missing'],
  ])('branch policy: %s → %s', async (_case, environmentPatch, policies, expected) => {
    const fixture = await seedReadyProject();
    fixture.world.environment = { ...fixture.world.environment, ...environmentPatch };
    if (policies !== null) {
      fixture.world.branchPolicies = policies;
    }
    const setup = await setupOf(fixture);
    expect(itemOf(setup, 'branch-policy').status).toBe(expected);
    expect(itemOf(setup, 'branch-policy').link).toBe(`https://github.com/${fixture.repo}/settings/environments/${String(ENVIRONMENT_ID)}/edit`);
    expect(setup.ready).toBe(false);
  });

  it('required reviewers or a wait timer warn and never hold the switch back (owner decision on #759)', async () => {
    const fixture = await seedReadyProject();
    fixture.world.environment = {
      ...fixture.world.environment,
      protection_rules: [
        { id: 1, type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: REVIEWER_SENTINEL } }] },
        { id: 2, type: 'wait_timer', wait_timer: 5 },
        { id: 3, type: 'branch_policy' },
      ],
    };
    const setup = await setupOf(fixture);
    expect(itemOf(setup, 'protection-rules').status).toBe('wrong');
    expect(setup.ready).toBe(true);
  });

  it('no secret: missing, linked to the Environment', async () => {
    const fixture = await seedReadyProject();
    fixture.world.secrets = [OTHER_SECRET_SENTINEL];
    const setup = await setupOf(fixture);
    expect(itemOf(setup, 'secret')).toEqual({
      id: 'secret',
      status: 'missing',
      link: `https://github.com/${fixture.repo}/settings/environments/${String(ENVIRONMENT_ID)}/edit`,
    });
  });

  it('no workflow file: missing, linked to GitHub’s new-file page on the default branch', async () => {
    const fixture = await seedReadyProject();
    fixture.world.workflow = null;
    const setup = await setupOf(fixture);
    expect(itemOf(setup, 'workflow')).toEqual({
      id: 'workflow',
      status: 'missing',
      link: `https://github.com/${fixture.repo}/new/main?filename=.github/workflows/team-console-runner.yml`,
    });
  });

  it('a workflow that differs by one byte is modified, never ok', async () => {
    const fixture = await seedReadyProject();
    fixture.world.workflow = `${rendering.text} `;
    const setup = await setupOf(fixture);
    expect(itemOf(setup, 'workflow').status).toBe('modified');
    expect(itemOf(setup, 'workflow').link).toBe(`https://github.com/${fixture.repo}/blob/main/.github/workflows/team-console-runner.yml`);
    expect(setup.ready).toBe(false);
  });

  it('a subscription project: access-source missing, and the switch is held back', async () => {
    const fixture = await seedReadyProject({ source: 'subscription' });
    const setup = await setupOf(fixture);
    expect(setup.accessSource).toBe('subscription');
    expect(itemOf(setup, 'access-source').status).toBe('missing');
    expect(setup.ready).toBe(false);
  });
});

describe('permissions the installer has not accepted read as unknown, never ok (SEC 5)', () => {
  it('without environments: read granted: no environment-read mint, the Environment items unknown, the app link', async () => {
    const fixture = await seedReadyProject();
    fixture.world.permissions = { metadata: 'read', contents: 'read', actions: 'write' };
    const setup = await setupOf(fixture);
    expect(statuses(setup)).toMatchObject({
      'app-permissions': 'missing',
      environment: 'unknown',
      'branch-policy': 'unknown',
      'protection-rules': 'unknown',
      secret: 'unknown',
    });
    expect(itemOf(setup, 'app-permissions').link).toBe(fixture.world.htmlUrl);
    expect(scopedMints(fixture.stub)).toEqual([]);
    expect(setup.ready).toBe(false);
  });

  it('when GitHub refuses the environment-read mint (422), the Environment items are unknown', async () => {
    const fixture = await seedReadyProject({ installationId: SCRIPTED_INSTALLATION });
    fixture.world.otherMint = 'refused';
    const setup = await setupOf(fixture);
    expect(statuses(setup)).toMatchObject({ environment: 'unknown', 'branch-policy': 'unknown', 'protection-rules': 'unknown', secret: 'unknown' });
    expect(setup.ready).toBe(false);
    expect(revokes(fixture.stub)).toEqual([]);
  });

  it('without actions: write, app-permissions is missing although the reads succeed', async () => {
    const fixture = await seedReadyProject();
    fixture.world.permissions = { metadata: 'read', contents: 'read', actions: 'read', environments: 'read' };
    const setup = await setupOf(fixture);
    expect(itemOf(setup, 'app-permissions').status).toBe('missing');
    expect(itemOf(setup, 'environment').status).toBe('ok');
    expect(setup.ready).toBe(false);
  });

  it('a suspended installation reads nothing more and mints nothing', async () => {
    const fixture = await seedReadyProject();
    fixture.world.suspended = true;
    const setup = await setupOf(fixture);
    expect(itemOf(setup, 'app-permissions').status).toBe('missing');
    expect(setup.items.filter((entry) => !['access-source', 'app-permissions'].includes(entry.id)).every((entry) => entry.status === 'unknown')).toBe(true);
    expect(scopedMints(fixture.stub)).toEqual([]);
  });
});

describe('the console’s setup PR and its provenance', () => {
  it('shows the console’s own PR on the workflow item', async () => {
    const fixture = await seedReadyProject();
    fixture.world.workflow = null;
    fixture.world.pull = consolePull(fixture.world, fixture.repo, rendering);
    fixture.world.pullFiles = ['.github/workflows/team-console-runner.yml'];
    fixture.world.pullWorkflow = rendering.text;
    const setup = await setupOf(fixture);
    expect(itemOf(setup, 'workflow').pr).toEqual({
      number: SETUP_PR_NUMBER,
      url: `https://github.com/${fixture.repo}/pull/${String(SETUP_PR_NUMBER)}`,
      provenance: 'console',
    });
  });

  type PullPatch = (pull: Record<string, unknown>, owner: string) => Record<string, unknown>;
  it.each<[string, PullPatch, string]>([
    ['opened by a person', (pull) => ({ ...pull, user: { login: 'someone', type: 'User' } }), 'foreign'],
    ['opened by another bot', (pull) => ({ ...pull, user: { login: 'other-app[bot]', type: 'Bot' } }), 'foreign'],
    [
      'with its head in another repository',
      // The head label still names the console's branch under the owner, as GitHub's filter matched it.
      (pull, owner) => ({ ...pull, head: { ...(pull['head'] as Record<string, unknown>), repo: { id: 1, owner: { login: owner } } } }),
      'foreign',
    ],
    ['with a second commit', (pull) => ({ ...pull, commits: 2 }), 'changed'],
  ])('a PR %s is %s, never the console’s', async (_case, patch, provenance) => {
    const fixture = await seedReadyProject();
    fixture.world.workflow = null;
    fixture.world.pull = patch(consolePull(fixture.world, fixture.repo, rendering), fixture.repo.split('/')[0] ?? '');
    fixture.world.pullFiles = ['.github/workflows/team-console-runner.yml'];
    fixture.world.pullWorkflow = rendering.text;
    const setup = await setupOf(fixture);
    expect(itemOf(setup, 'workflow').pr?.provenance).toBe(provenance);
  });

  it('a console PR whose file differs from the rendering is changed', async () => {
    const fixture = await seedReadyProject();
    fixture.world.workflow = null;
    fixture.world.pull = consolePull(fixture.world, fixture.repo, rendering);
    fixture.world.pullFiles = ['.github/workflows/team-console-runner.yml'];
    fixture.world.pullWorkflow = `${rendering.text}# appended\n`;
    expect(itemOf(await setupOf(fixture), 'workflow').pr?.provenance).toBe('changed');
  });

  it('a PR whose html_url is not GitHub’s is not shown at all', async () => {
    const fixture = await seedReadyProject();
    fixture.world.workflow = null;
    fixture.world.pull = consolePull(fixture.world, fixture.repo, rendering, { html_url: 'https://evil.example.com/pull/1' });
    const setup = await setupOf(fixture);
    expect(itemOf(setup, 'workflow').pr).toBeUndefined();
    expect(JSON.stringify(setup)).not.toContain('evil.example.com');
  });
});

describe('links point at GitHub’s own UI only', () => {
  it('drops an installation html_url outside https://github.com/', async () => {
    const fixture = await seedReadyProject();
    fixture.world.permissions = { metadata: 'read' };
    fixture.world.htmlUrl = 'https://evil.example.com/settings/installations/777';
    const setup = await setupOf(fixture);
    expect(itemOf(setup, 'app-permissions')).toEqual({ id: 'app-permissions', status: 'missing' });
    expect(JSON.stringify(setup)).not.toContain('evil.example.com');
  });

  it('every link of a broken world starts with https://github.com/', async () => {
    const fixture = await seedReadyProject();
    fixture.world.environment = null;
    fixture.world.workflow = null;
    fixture.world.permissions = { metadata: 'read', actions: 'write', environments: 'read' };
    const setup = await setupOf(fixture);
    const links = setup.items.flatMap((entry) => (entry.link === undefined ? [] : [entry.link]));
    expect(links.length).toBeGreaterThan(2);
    expect(links.every((link) => link.startsWith('https://github.com/'))).toBe(true);
  });
});

describe('nothing of GitHub’s answers leaks (sentinel)', () => {
  it('no reviewer login, other secret name, date or token in the answer or the logs', async () => {
    const fixture = await seedReadyProject();
    fixture.world.environment = {
      ...fixture.world.environment,
      created_at: DATE_SENTINEL,
      protection_rules: [{ id: 1, type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: REVIEWER_SENTINEL } }] }],
    };
    fixture.world.secrets = [OTHER_SECRET_SENTINEL];
    const logs: string[] = [];
    const response = await check(fixture, { logs });
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const sentinel of [REVIEWER_SENTINEL, OTHER_SECRET_SENTINEL, DATE_SENTINEL, TOKEN_SENTINEL]) {
      expect(text).not.toContain(sentinel);
      expect(logs.join('\n')).not.toContain(sentinel);
    }
    expect(logs.join('\n')).toContain('actions readiness checked');
  });
});

describe('refusals', () => {
  it('answers 502 github-unavailable on a GitHub 5xx, with no partial items', async () => {
    const fixture = await seedReadyProject();
    fixture.world.unavailable = '/deployment-branch-policies';
    const response = await check(fixture);
    expect(response.status).toBe(502);
    expect(await slugOf(response)).toBe('github-unavailable');
    expect(await response.text()).not.toContain('"items"');
    // The scoped token is revoked even though its read failed.
    expect(revokes(fixture.stub)).toHaveLength(1);
  });

  it('answers 503 console-origin-misconfigured on another origin, before any GitHub call', async () => {
    const fixture = await seedReadyProject();
    const response = await check(fixture, { origin: 'http://localhost:4200' });
    expect(response.status).toBe(503);
    expect(await slugOf(response)).toBe('console-origin-misconfigured');
    expect(fixture.stub.calls).toEqual([]);
  });

  it('answers 422 dispatch-repository-unverified when GitHub names another repository, without minting', async () => {
    const fixture = await seedReadyProject();
    fixture.world.repoId += 1;
    const response = await check(fixture);
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('dispatch-repository-unverified');
    expect(scopedMints(fixture.stub)).toEqual([]);
  });

  it(`answers 429 rate-limited past ${String(READINESS_CHECKS_PER_WINDOW)} checks of a project, without calling GitHub`, async () => {
    const fixture = await seedReadyProject();
    for (let index = 0; index < READINESS_CHECKS_PER_WINDOW; index += 1) {
      expect((await check(fixture)).status).toBe(200);
    }
    const before = fixture.stub.calls.length;
    const limited = await check(fixture);
    expect(limited.status).toBe(429);
    expect(await slugOf(limited)).toBe('rate-limited');
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(fixture.stub.calls.length).toBe(before);
    // Another project keeps its own budget.
    expect((await check(await seedReadyProject())).status).toBe(200);
  });
});

describe('two accounts and members (security note row "Cross-tenant or member trigger")', () => {
  it('another account’s owner gets 404 and a member of the account 403 owner-only, both with zero GitHub calls', async () => {
    const fixture = await seedReadyProject();
    const github = new ApiGitHub({ fetch: fixture.stub.fetch });
    const bindings = { ...localEnv({ CONSOLE_PUBLIC_ORIGIN: SETUP_ORIGIN, AUTH_MODE: undefined }) };
    const path = `/api/v1/projects/${fixture.slug}/actions-setup`;

    const ownerOfB = await seedSessionUser('owner');
    const foreign = await sendAsSession(ownerOfB, 'GET', path, undefined, { github, origin: SETUP_ORIGIN }, bindings);
    expect(foreign.status).toBe(404);
    expect(await slugOf(foreign)).toBe('project-not-found');

    const memberId = await seedUser('member');
    await seedMembership(OWNER_ACCOUNT_ID, memberId, 'member');
    const member = { cookie: await seedSession(memberId) };
    const refused = await sendAsSession(member, 'GET', path, undefined, { github, origin: SETUP_ORIGIN }, bindings);
    expect(refused.status).toBe(403);
    expect(await slugOf(refused)).toBe('owner-only');

    expect(fixture.stub.calls).toEqual([]);
  });

  it('an installation linked to another account is never asked: app-permissions missing, zero GitHub calls', async () => {
    const fixture = await seedReadyProject({ installationId: FOREIGN_INSTALLATION });
    const setup = await setupOf(fixture);
    expect(itemOf(setup, 'app-permissions')).toEqual({ id: 'app-permissions', status: 'missing' });
    expect(setup.ready).toBe(false);
    expect(fixture.stub.calls).toEqual([]);
  });
});
