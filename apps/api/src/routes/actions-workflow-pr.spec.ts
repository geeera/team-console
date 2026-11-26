import { env } from 'cloudflare:test';
import { actionsSetupBranchOf, type RunnerWorkflowRendering } from '@shared/actions-workflow';
import {
  OWNER_ACCOUNT_ID,
  isActionsWorkflowPrDto,
  isProblemDetails,
  problemSlugOf,
  type ActionsWorkflowPrDto,
} from '@shared/contracts';
import { JOB_ROLES } from '../auth/job-roles';
import { ApiGitHub } from '../github';
import { fetchApi } from '../testing/access-kit';
import {
  BLOB_SHA,
  COMMIT_SHA,
  HEAD_SHA,
  SETUP_ORIGIN,
  SETUP_PR_NUMBER,
  answerSetupRead,
  answerSetupWrite,
  consolePull,
  readyWorld,
  renderingFor,
  type SetupWorld,
} from '../testing/actions-setup-kit';
import {
  INSTALLATION_ID,
  TOKEN_SENTINEL,
  json,
  localEnv,
  stubGitHub,
  type GitHubCall,
  type StubGitHub,
} from '../testing/github-kit';
import {
  seedMembership,
  seedSession,
  seedSessionUser,
  seedUser,
  sendAsSession,
} from '../testing/session-kit';
import { jobActor, seedTrackerProject } from '../testing/tracker-kit';
import { localJobHeader } from '../testing/local-job-kit';
import { WORKFLOW_PR_PER_PROJECT } from './actions-setup-problems';

// #759 PR 4: `POST …/actions-setup/workflow-pr`, the console's one write to a customer repository (architect note §4;
// security note rows "The console writes outside its own branch", "A PR that is not the console's is shown as the
// console's", "RUNNER_VERSION bump", "Cross-tenant or member trigger" and "Abuse of the write path"; SEC 4).

const SCRIPTED_INSTALLATION = 7791;
const FOREIGN_INSTALLATION = 7792;
const ACCOUNT_B = '01M6YSNJ00000000000000WPB2';
const WORKFLOW = '.github/workflows/team-console-runner.yml';
const WRITE_PERMISSIONS = { contents: 'write', workflows: 'write', pull_requests: 'write' };

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
    `INSERT INTO accounts (id, slug, name, created_at) SELECT ?1, 'wp-b', 'B', '2026-11-01T00:00:00.000Z'
     WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE id = ?1)`,
  )
    .bind(ACCOUNT_B)
    .run();
  await linkInstallation(OWNER_ACCOUNT_ID, INSTALLATION_ID);
  await linkInstallation(OWNER_ACCOUNT_ID, SCRIPTED_INSTALLATION);
  await linkInstallation(ACCOUNT_B, FOREIGN_INSTALLATION);
  rendering = await renderingFor();
});

beforeEach(async () => {
  // Each case starts with fresh hourly counters and no operator stop.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM rate_limits WHERE key LIKE '%actions-setup-pr'`),
    env.DB.prepare(`DELETE FROM operator_stops`),
  ]);
});

interface Fixture {
  readonly slug: string;
  readonly repo: string;
  readonly world: SetupWorld;
  readonly stub: StubGitHub;
}

/** A project whose repository has everything but the workflow file, on an installation that accepted the writes. */
async function seedProject(options: { installationId?: number } = {}): Promise<Fixture> {
  const { slug } = await seedTrackerProject();
  const row = await env.DB.prepare(`SELECT repo, repo_id FROM projects WHERE slug = ?1`)
    .bind(slug)
    .first<{ repo: string; repo_id: number }>();
  if (row === null) {
    throw new Error('seeded project missing');
  }
  const installationId = options.installationId ?? INSTALLATION_ID;
  await env.DB.prepare(`UPDATE projects SET installation_id = ?2 WHERE slug = ?1`)
    .bind(slug, installationId)
    .run();
  const world = readyWorld(row.repo_id, rendering);
  world.installationId = installationId;
  world.workflow = null;
  world.permissions = { metadata: 'read', actions: 'write', environments: 'read', ...WRITE_PERMISSIONS };
  const stub = stubGitHub(
    (call) =>
      answerSetupWrite(world, row.repo, rendering, call) ??
      answerSetupRead(world, row.repo, rendering, call) ??
      json(404, { message: 'Not Found' }),
  );
  return { slug, repo: row.repo, world, stub };
}

interface Call {
  readonly origin?: string;
  readonly logs?: string[];
  readonly body?: string;
  readonly bindings?: Record<string, string | undefined>;
  readonly headers?: Record<string, string>;
}

async function open(fixture: Fixture, call: Call = {}): Promise<Response> {
  return fetchApi(
    `/api/v1/projects/${fixture.slug}/actions-setup/workflow-pr`,
    localEnv({ CONSOLE_PUBLIC_ORIGIN: SETUP_ORIGIN, ...call.bindings }),
    {
      method: 'POST',
      origin: call.origin ?? SETUP_ORIGIN,
      headers: { 'Sec-Fetch-Site': 'same-origin', ...call.headers },
      github: new ApiGitHub({ fetch: fixture.stub.fetch }),
      ...(call.body === undefined ? {} : { body: call.body }),
      ...(call.logs === undefined ? {} : { logSink: (line: string) => call.logs?.push(line) }),
    },
  );
}

async function slugOf(response: Response): Promise<string | null> {
  const body: unknown = await response.clone().json();
  return isProblemDetails(body) ? problemSlugOf(body.type) : null;
}

const isScopedMint = (call: GitHubCall): boolean =>
  call.url.pathname.endsWith('/access_tokens') && (call.body ?? '').includes('repository_ids');
const scopedMints = (stub: StubGitHub): GitHubCall[] => stub.calls.filter(isScopedMint);
const revokes = (stub: StubGitHub): GitHubCall[] =>
  stub.calls.filter((call) => call.method === 'DELETE' && call.url.pathname === '/installation/token');
/** Everything that is neither a read nor the token's mint and revoke. */
const writes = (stub: StubGitHub): GitHubCall[] =>
  stub.calls.filter(
    (call) =>
      call.method !== 'GET' &&
      !call.url.pathname.endsWith('/access_tokens') &&
      call.url.pathname !== '/installation/token',
  );
const bodyOf = (call: GitHubCall | undefined): Record<string, unknown> =>
  JSON.parse(call?.body ?? '{}') as Record<string, unknown>;

/** The bearer GitHub minted for the write: `stubGitHub` numbers its tokens in the order of the mints. */
function writeBearer(stub: StubGitHub): string {
  const mints = stub.calls.filter((call) => call.url.pathname.endsWith('/access_tokens'));
  return `Bearer ${TOKEN_SENTINEL}${String(mints.findIndex(isScopedMint) + 1)}`;
}

interface AuditRow {
  readonly kind: string;
  readonly actor: string;
  readonly account_id: string;
  readonly details: Record<string, unknown>;
}

async function auditOf(slug: string): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT kind, actor, account_id, details FROM audit_events WHERE target = ?1 AND kind LIKE 'project.actions-workflow-pr-%' ORDER BY id`,
  )
    .bind(slug)
    .all<{ kind: string; actor: string; account_id: string; details: string }>();
  return results.map((row) => ({ ...row, details: JSON.parse(row.details) as Record<string, unknown> }));
}

function decoded(content: unknown): string {
  return new TextDecoder().decode(Uint8Array.from(atob(String(content)), (char) => char.charCodeAt(0)));
}

function withPin(text: string, name: string, version: string): string {
  const pattern = new RegExp(`(${name}: )\\d+\\.\\d+\\.\\d+`);
  if (!pattern.test(text)) {
    throw new Error(`the rendering has no ${name}`);
  }
  return text.replace(pattern, `$1${version}`);
}

describe('POST /api/v1/projects/:slug/actions-setup/workflow-pr: the setup pull request', () => {
  it('opens the PR and answers 201 with its number, its github.com address and the kind, nothing else', async () => {
    const fixture = await seedProject();
    const response = await open(fixture);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body: unknown = await response.json();
    expect(isActionsWorkflowPrDto(body)).toBe(true);
    expect(body).toEqual({
      number: SETUP_PR_NUMBER,
      url: `https://github.com/${fixture.repo}/pull/${String(SETUP_PR_NUMBER)}`,
      kind: 'setup',
    } satisfies ActionsWorkflowPrDto);
  });

  it('mints one workflow-pr token for the one repository by id, makes its calls with it and revokes it', async () => {
    const fixture = await seedProject();
    await open(fixture);
    const [mint, ...more] = scopedMints(fixture.stub);
    expect(more).toEqual([]);
    expect(bodyOf(mint)).toEqual({ repository_ids: [fixture.world.repoId], permissions: WRITE_PERMISSIONS });
    const bearer = writeBearer(fixture.stub);
    const withWriteToken = fixture.stub.calls.filter((call) => call.headers.get('authorization') === bearer);
    expect(
      withWriteToken.map(
        (call) => `${call.method} ${call.url.pathname.replace(`/repos/${fixture.repo}`, '')}`,
      ),
    ).toEqual([
      'GET /branches/main',
      'POST /git/refs',
      `GET /contents/${WORKFLOW}`,
      `PUT /contents/${WORKFLOW}`,
      'POST /pulls',
      'DELETE /installation/token',
    ]);
    // Every write is made with that token and none with the cached read token.
    expect(writes(fixture.stub).every((call) => call.headers.get('authorization') === bearer)).toBe(true);
    expect(revokes(fixture.stub)).toHaveLength(1);
    expect(fixture.stub.calls.at(-1)?.url.pathname).toBe('/installation/token');
  });

  it('creates its own branch at the default branch’s head and writes the rendering there, byte for byte', async () => {
    const fixture = await seedProject();
    await open(fixture);
    const branch = actionsSetupBranchOf(rendering.sha256);
    const [ref, put, pull, ...more] = writes(fixture.stub);
    expect(more).toEqual([]);
    expect(bodyOf(ref)).toEqual({ ref: `refs/heads/${branch}`, sha: HEAD_SHA });
    const written = bodyOf(put);
    expect(Object.keys(written).sort()).toEqual(['branch', 'content', 'message']);
    expect(written['branch']).toBe(branch);
    expect(decoded(written['content'])).toBe(rendering.text);
    expect(put?.url.pathname).toBe(`/repos/${fixture.repo}/contents/${WORKFLOW}`);
    expect(put?.url.search).toBe('');
    expect(bodyOf(pull)).toMatchObject({ head: branch, base: 'main', maintainer_can_modify: false });
  });

  it('never writes to the default branch, never moves or deletes a ref and never merges', async () => {
    const fixture = await seedProject();
    await open(fixture);
    const branch = actionsSetupBranchOf(rendering.sha256);
    for (const call of writes(fixture.stub)) {
      const path = call.url.pathname;
      expect(`${call.method} ${path}`).not.toMatch(/^(PATCH|DELETE) .*\/git\/refs/);
      expect(path).not.toMatch(/\/merge$|\/merges$|\/git\/refs\/.+/);
      const body = bodyOf(call);
      // A contents write names the console's branch; a write without `branch` would land on the default one.
      if (call.method === 'PUT') {
        expect(body['branch']).toBe(branch);
      }
      expect(body['branch']).not.toBe('main');
      expect(body['ref']).not.toBe('refs/heads/main');
      expect(body['head']).not.toBe('main');
    }
    expect(branch).not.toBe('main');
  });

  it('writes a title, a body and a commit message of constants, the pins and the sha256: no @, no project name', async () => {
    const fixture = await seedProject();
    await open(fixture);
    const [, put, pull] = writes(fixture.stub);
    const text = [bodyOf(put)['message'], bodyOf(pull)['title'], bodyOf(pull)['body']].map(String);
    expect(bodyOf(pull)['title']).toBe('Add the Team Console runner workflow');
    expect(text[2]).toContain(rendering.sha256);
    expect(text[2]).toContain(rendering.pins.runner);
    expect(text[2]).toContain('never merges');
    for (const part of text) {
      expect(part).not.toContain('@');
      expect(part).not.toContain(fixture.slug);
      expect(part).not.toContain(fixture.repo);
    }
  });

  it('takes nothing from the request: a body, a query and forged headers change no call', async () => {
    const plain = await seedProject();
    await open(plain);
    const steered = await seedProject();
    const response = await fetchApi(
      `/api/v1/projects/${steered.slug}/actions-setup/workflow-pr?branch=main&repo=evil/evil`,
      localEnv({ CONSOLE_PUBLIC_ORIGIN: SETUP_ORIGIN }),
      {
        method: 'POST',
        origin: SETUP_ORIGIN,
        headers: {
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
          'X-Forwarded-Host': 'evil.example.com',
        },
        body: JSON.stringify({
          branch: 'main',
          repo: 'evil/evil',
          repositoryId: 1,
          installationId: 2,
          text: 'on: push',
          kind: 'bump',
        }),
        github: new ApiGitHub({ fetch: steered.stub.fetch }),
      },
    );
    expect(response.status).toBe(201);
    const shape = (fixture: Fixture) =>
      writes(fixture.stub).map((call) => ({
        call: `${call.method} ${call.url.pathname.replace(fixture.repo, 'REPO')}${call.url.search}`,
        body: call.body,
      }));
    expect(shape(steered)).toEqual(shape(plain));
    expect(JSON.stringify(shape(steered))).not.toContain('evil');
  });

  it('audits the attempt before the mint and the opened PR after it, with ids and enums only', async () => {
    const fixture = await seedProject();
    await open(fixture);
    const rows = await auditOf(fixture.slug);
    expect(rows.map((row) => row.kind)).toEqual([
      'project.actions-workflow-pr-attempted',
      'project.actions-workflow-pr-opened',
    ]);
    const facts = {
      kind: 'setup',
      repositoryId: fixture.world.repoId,
      installationId: INSTALLATION_ID,
      sha256: rendering.sha256,
    };
    expect(rows[0]?.details).toEqual(facts);
    expect(rows[1]?.details).toEqual({
      ...facts,
      prNumber: SETUP_PR_NUMBER,
      branch: actionsSetupBranchOf(rendering.sha256),
      commit: COMMIT_SHA,
    });
    expect(rows.every((row) => row.account_id === OWNER_ACCOUNT_ID && row.actor === 'local-owner')).toBe(
      true,
    );
  });

  it('keeps the token out of the answer, the logs and the audit', async () => {
    const fixture = await seedProject();
    const logs: string[] = [];
    const response = await open(fixture, { logs });
    const audit = JSON.stringify(await auditOf(fixture.slug));
    for (const text of [await response.text(), logs.join('\n'), audit]) {
      expect(text).not.toContain(TOKEN_SENTINEL);
    }
    expect(logs.join('\n')).toContain('actions workflow pr opened');
  });
});

describe('a bump, a restore, and a file that needs neither', () => {
  it('opens a bump when the file on the default branch pins an older runner, replacing exactly the blob on its branch', async () => {
    const fixture = await seedProject();
    fixture.world.workflow = withPin(rendering.text, 'RUNNER_VERSION', '0.0.1');
    const response = await open(fixture);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(((await response.json()) as ActionsWorkflowPrDto).kind).toBe('bump');
    const [, put, pull] = writes(fixture.stub);
    // The sha is the blob read on the branch just created, so the write is a compare-and-set.
    expect(bodyOf(put)['sha']).toBe(BLOB_SHA);
    expect(decoded(bodyOf(put)['content'])).toBe(rendering.text);
    expect(bodyOf(pull)['title']).toBe(`Update the Team Console runner to ${rendering.pins.runner}`);
    expect(String(bodyOf(pull)['body'])).toContain(`0.0.1 → ${rendering.pins.runner}`);
    expect(String(bodyOf(pull)['body'])).toContain(`${rendering.pins.node} (unchanged)`);
    expect((await auditOf(fixture.slug)).map((row) => row.details['kind'])).toEqual(['bump', 'bump']);
  });

  it('opens a restore when the file differs with the same pins, and prints nothing of it', async () => {
    const fixture = await seedProject();
    fixture.world.workflow = `${rendering.text}\n# @someone please review ${fixture.slug}\n`;
    const response = await open(fixture);
    expect(((await response.json()) as ActionsWorkflowPrDto).kind).toBe('restore');
    const [, , pull] = writes(fixture.stub);
    expect(bodyOf(pull)['title']).toBe('Restore the Team Console runner workflow');
    expect(String(bodyOf(pull)['body'])).not.toContain('@');
    expect(String(bodyOf(pull)['body'])).not.toContain('someone');
  });

  it.each([
    ['runner', 'RUNNER_VERSION'],
    ['node', 'NODE_VERSION'],
    ['claudeCode', 'CLAUDE_CODE_VERSION'],
  ])('never lowers a pin: 422 actions-setup-downgrade naming %s, with no mint', async (pin, name) => {
    const fixture = await seedProject();
    fixture.world.workflow = withPin(rendering.text, name, '999.0.0');
    const response = await open(fixture);
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('actions-setup-downgrade');
    expect(((await response.json()) as { pins: string[] }).pins).toEqual([pin]);
    expect(scopedMints(fixture.stub)).toEqual([]);
    expect(await auditOf(fixture.slug)).toEqual([]);
  });

  it('answers 422 actions-setup-ready when the file is already the rendering, with no mint', async () => {
    const fixture = await seedProject();
    fixture.world.workflow = rendering.text;
    const response = await open(fixture);
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('actions-setup-ready');
    expect(scopedMints(fixture.stub)).toEqual([]);
  });
});

describe('a pull request or a branch that is already there', () => {
  it('answers 409 actions-setup-pr-open with the open PR and its provenance, with no mint', async () => {
    const fixture = await seedProject();
    fixture.world.pull = consolePull(fixture.world, fixture.repo, rendering);
    fixture.world.pullFiles = [WORKFLOW];
    fixture.world.pullWorkflow = rendering.text;
    const response = await open(fixture);
    expect(response.status).toBe(409);
    expect(await slugOf(response)).toBe('actions-setup-pr-open');
    expect(await response.json()).toMatchObject({
      number: SETUP_PR_NUMBER,
      url: `https://github.com/${fixture.repo}/pull/${String(SETUP_PR_NUMBER)}`,
      provenance: 'console',
    });
    expect(scopedMints(fixture.stub)).toEqual([]);
  });

  it('says so when the open PR on its branch is someone else’s', async () => {
    const fixture = await seedProject();
    fixture.world.pull = consolePull(fixture.world, fixture.repo, rendering, {
      user: { login: 'someone', type: 'User' },
    });
    const response = await open(fixture);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { provenance: string }).provenance).toBe('foreign');
  });

  it('leaves an existing branch exactly as it is: 409 actions-setup-branch-exists, no file write, token revoked', async () => {
    const fixture = await seedProject();
    fixture.world.write.branchExists = true;
    const response = await open(fixture);
    expect(response.status).toBe(409);
    expect(await slugOf(response)).toBe('actions-setup-branch-exists');
    expect(((await response.json()) as { link: string }).link).toBe(
      `https://github.com/${fixture.repo}/branches`,
    );
    expect(writes(fixture.stub).map((call) => call.method)).toEqual(['POST']);
    expect(revokes(fixture.stub)).toHaveLength(1);
    const rows = await auditOf(fixture.slug);
    expect(rows.map((row) => row.kind)).toEqual([
      'project.actions-workflow-pr-attempted',
      'project.actions-workflow-pr-failed',
    ]);
    expect(rows[1]?.details['reason']).toBe('branch-exists');
  });

  it('closes a PR whose head is not its own commit and answers 409 actions-setup-pr-tampered', async () => {
    const fixture = await seedProject();
    fixture.world.write.pullHeadSha = 'f'.repeat(40);
    const response = await open(fixture);
    expect(response.status).toBe(409);
    expect(await slugOf(response)).toBe('actions-setup-pr-tampered');
    const close = writes(fixture.stub).at(-1);
    expect(`${close?.method ?? ''} ${close?.url.pathname ?? ''}`).toBe(
      `PATCH /repos/${fixture.repo}/pulls/${String(SETUP_PR_NUMBER)}`,
    );
    expect(bodyOf(close)).toEqual({ state: 'closed' });
    expect(revokes(fixture.stub)).toHaveLength(1);
    expect((await auditOf(fixture.slug)).at(-1)?.details['reason']).toBe('pr-tampered');
  });
});

describe('permissions the installer has not accepted', () => {
  it('names the missing permissions from the app’s own read (422), with no mint and the installation’s page', async () => {
    const fixture = await seedProject();
    fixture.world.permissions = {
      metadata: 'read',
      contents: 'write',
      pull_requests: 'read',
      actions: 'write',
    };
    const response = await open(fixture);
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('actions-permission-missing');
    expect(await response.json()).toMatchObject({
      permissions: ['workflows', 'pull_requests'],
      link: fixture.world.htmlUrl,
    });
    expect(scopedMints(fixture.stub)).toEqual([]);
    expect(await auditOf(fixture.slug)).toEqual([]);
  });

  it('answers the same 422 when GitHub refuses the mint after all, and audits the failed attempt', async () => {
    const fixture = await seedProject({ installationId: SCRIPTED_INSTALLATION });
    fixture.world.otherMint = 'refused';
    const response = await open(fixture);
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('actions-permission-missing');
    expect(writes(fixture.stub)).toEqual([]);
    const rows = await auditOf(fixture.slug);
    expect(rows.map((row) => row.kind)).toEqual([
      'project.actions-workflow-pr-attempted',
      'project.actions-workflow-pr-failed',
    ]);
    expect(rows[1]?.details).toMatchObject({
      reason: 'mint-failed',
      failure: 'permission-missing',
      githubStatus: 422,
    });
  });

  it('a suspended installation, or one linked to another account, is never minted through', async () => {
    const suspended = await seedProject();
    suspended.world.suspended = true;
    expect(await slugOf(await open(suspended))).toBe('actions-permission-missing');
    expect(scopedMints(suspended.stub)).toEqual([]);

    const foreign = await seedProject({ installationId: FOREIGN_INSTALLATION });
    expect(await slugOf(await open(foreign))).toBe('actions-permission-missing');
    expect(foreign.stub.calls).toEqual([]);
  });
});

describe('the kill switch (SEC 4): the reviewed var and the operator’s stop', () => {
  it.each([
    ['false', 'false'],
    ['unset', undefined],
    ['TRUE (only the exact value counts)', 'TRUE'],
  ])(
    'answers 503 github-write-disabled with the var %s, before any GitHub call, count or audit row',
    async (_case, value) => {
      const fixture = await seedProject();
      const response = await open(fixture, { bindings: { ALLOW_ACTIONS_SETUP_WRITE: value } });
      expect(response.status).toBe(503);
      expect(await slugOf(response)).toBe('github-write-disabled');
      expect(fixture.stub.calls).toEqual([]);
      expect(await auditOf(fixture.slug)).toEqual([]);
      const counted = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE '%actions-setup-pr'`,
      ).first<{ n: number }>();
      expect(counted?.n).toBe(0);
    },
  );

  it('answers the same 503 once the operator wrote a stop, on the next request and without a deploy', async () => {
    const fixture = await seedProject();
    await env.DB.prepare(
      `INSERT INTO operator_stops (name, stopped_at, reason) VALUES ('actions-setup-write', '2026-11-18T10:00:00Z', 'incident drill')`,
    ).run();
    const response = await open(fixture);
    expect(response.status).toBe(503);
    expect(await slugOf(response)).toBe('github-write-disabled');
    expect(fixture.stub.calls).toEqual([]);
    // Lifting the stop is the operator's too; the path is on again on the next request.
    await env.DB.prepare(`DELETE FROM operator_stops`).run();
    expect((await open(fixture)).status).toBe(201);
  });

  it('a stop never switches the path on where the var is off', async () => {
    const fixture = await seedProject();
    const response = await open(fixture, { bindings: { ALLOW_ACTIONS_SETUP_WRITE: 'false' } });
    expect(await slugOf(response)).toBe('github-write-disabled');
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM operator_stops`).first<{ n: number }>())?.n).toBe(
      0,
    );
  });
});

describe('who may open it (security note row "Cross-tenant or member trigger")', () => {
  it('another account’s owner gets 404 and a member 403 owner-only, both with zero GitHub calls', async () => {
    const fixture = await seedProject();
    const github = new ApiGitHub({ fetch: fixture.stub.fetch });
    const bindings = { ...localEnv({ CONSOLE_PUBLIC_ORIGIN: SETUP_ORIGIN, AUTH_MODE: undefined }) };
    const path = `/api/v1/projects/${fixture.slug}/actions-setup/workflow-pr`;

    const ownerOfB = await seedSessionUser('owner');
    const foreign = await sendAsSession(
      ownerOfB,
      'POST',
      path,
      undefined,
      { github, origin: SETUP_ORIGIN },
      bindings,
    );
    expect(foreign.status).toBe(404);
    expect(await slugOf(foreign)).toBe('project-not-found');

    const memberId = await seedUser('member');
    await seedMembership(OWNER_ACCOUNT_ID, memberId, 'member');
    const member = { cookie: await seedSession(memberId) };
    const refused = await sendAsSession(
      member,
      'POST',
      path,
      undefined,
      { github, origin: SETUP_ORIGIN },
      bindings,
    );
    expect(refused.status).toBe(403);
    expect(await slugOf(refused)).toBe('owner-only');

    expect(fixture.stub.calls).toEqual([]);
    expect(await auditOf(fixture.slug)).toEqual([]);
  });

  it('a job of the project is refused, whatever its role', async () => {
    const fixture = await seedProject();
    const path = `/api/v1/projects/${fixture.slug}/actions-setup/workflow-pr`;
    for (const role of JOB_ROLES) {
      const response = await open(fixture, {
        headers: { Authorization: localJobHeader(jobActor(role), path) },
      });
      expect(response.status, role).toBe(403);
    }
    expect(fixture.stub.calls).toEqual([]);
  });

  it('a cross-site POST is refused before anything else', async () => {
    const fixture = await seedProject();
    const response = await open(fixture, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(response.status).toBe(403);
    expect(fixture.stub.calls).toEqual([]);
  });
});

describe('refusals and failures', () => {
  it(`answers 429 past ${String(WORKFLOW_PR_PER_PROJECT)} attempts of a project in an hour, without calling GitHub`, async () => {
    const fixture = await seedProject();
    fixture.world.workflow = rendering.text;
    for (let index = 0; index < WORKFLOW_PR_PER_PROJECT; index += 1) {
      expect((await open(fixture)).status).toBe(422);
    }
    const before = fixture.stub.calls.length;
    const limited = await open(fixture);
    expect(limited.status).toBe(429);
    expect(await slugOf(limited)).toBe('rate-limited');
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(fixture.stub.calls.length).toBe(before);
    // Another project of the account keeps its own budget.
    expect((await open(await seedProject())).status).toBe(201);
  });

  it('logs the volume line at error level once the attempts of all accounts pass the threshold, and refuses nothing', async () => {
    await env.DB.prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES ('all:actions-setup-pr', ?1, 30)`,
    )
      .bind(String(Math.floor(Date.now() / 3_600_000) * 3600))
      .run();
    const fixture = await seedProject();
    const logs: string[] = [];
    expect((await open(fixture, { logs })).status).toBe(201);
    const line = logs
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
      .find((entry) => entry['message'] === 'actions setup write volume');
    expect(line).toMatchObject({ level: 'error', count: 31, threshold: 30 });
  });

  it.each(['refs', 'contents', 'pulls'] as const)(
    'a GitHub 5xx on %s answers 502, audits the failure and still revokes the token',
    async (failing) => {
      const fixture = await seedProject();
      fixture.world.write.failing = failing;
      const response = await open(fixture);
      expect(response.status).toBe(502);
      expect(await slugOf(response)).toBe('github-unavailable');
      expect(revokes(fixture.stub)).toHaveLength(1);
      const rows = await auditOf(fixture.slug);
      expect(rows.at(-1)).toMatchObject({
        kind: 'project.actions-workflow-pr-failed',
        details: { reason: 'github-error', githubStatus: 503 },
      });
    },
  );

  it('answers 503 console-origin-misconfigured on another origin, before any GitHub call', async () => {
    const fixture = await seedProject();
    const response = await open(fixture, { origin: 'http://localhost:4200' });
    expect(response.status).toBe(503);
    expect(await slugOf(response)).toBe('console-origin-misconfigured');
    expect(fixture.stub.calls).toEqual([]);
  });

  it('answers 422 dispatch-repository-unverified when GitHub names another repository, with no mint', async () => {
    const fixture = await seedProject();
    fixture.world.repoId += 1;
    const response = await open(fixture);
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('dispatch-repository-unverified');
    expect(scopedMints(fixture.stub)).toEqual([]);
  });

  it('refuses a body larger than a small write', async () => {
    const fixture = await seedProject();
    const response = await open(fixture, {
      body: 'x'.repeat(5 * 1024),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(413);
    expect(fixture.stub.calls).toEqual([]);
  });
});
