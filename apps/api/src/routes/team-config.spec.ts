import { env } from 'cloudflare:test';
import {
  OWNER_ACCOUNT_ID,
  TEAM_CONFIG_PRESET_ROLES,
  TEAM_CONFIG_SCHEMA,
  isResolvedTeamConfig,
  type ClaimResponse,
  type ResolvedTeamConfigDto,
  type TeamConfigDto,
  type TeamConfigImportDto,
  type TeamConfigRevisionDto,
  type TeamConfigRevisionListDto,
} from '@shared/contracts';
import { ApiGitHub } from '../github';
import { json } from '../testing/github-kit';
import { enqueueJob, enrolRunner, seedClaimedJob, sendAsJob, sendAsRunner } from '../testing/runner-kit';
import { seedAccount, seedAccountProject, seedMembership, seedSessionUser, sendAsSession } from '../testing/session-kit';
import {
  jobActor,
  pullRequestsGitHub,
  seedTrackerProject,
  send,
  sendAsService,
  slugOf,
  type SeededProject,
} from '../testing/tracker-kit';
import { IMPORTS_PER_WINDOW, auditPathsOf } from './team-config';

// #687 (ADR 0009 d.9; threat model C12): the team-config routes through the whole app — the auth seam, CSRF, the route
// matrix and the scoped lookup all run.

const P = '/api/v1/projects';
const base = (project: SeededProject): string => `${P}/${project.slug}/team-config`;
const doc = (members: Record<string, unknown> = {}) => ({ schema: TEAM_CONFIG_SCHEMA, ...members });

async function put(project: SeededProject, config: unknown, ifMatch: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return send('PUT', base(project), { config, ...extra }, { ifMatch });
}

async function saved(project: SeededProject, config: unknown, ifMatch = '"0"'): Promise<TeamConfigDto> {
  const response = await put(project, config, ifMatch);
  if (response.status !== 200) {
    throw new Error(`saving answered ${String(response.status)}: ${await response.text()}`);
  }
  return (await response.json()) as TeamConfigDto;
}

async function auditRows(slug: string): Promise<{ actor: string; details: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT actor, details FROM audit_events WHERE kind = 'team-config.changed' AND target = ?1 ORDER BY id`,
  )
    .bind(slug)
    .all<{ actor: string; details: string }>();
  return results;
}

/** Every key of a JSON value, at any depth. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(keysOf);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, member]) => [key, ...keysOf(member)]);
  }
  return [];
}

const CREDENTIAL_KEYS = /credential|token|^kind$|secret|password|api_?key/i;

describe('GET …/team-config', () => {
  it('answers recommended for a project with no document, revision 0, with its ETag', async () => {
    const project = await seedTrackerProject();
    const response = await send('GET', base(project));
    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBe('"0"');
    const body = (await response.json()) as TeamConfigDto;
    expect(body).toMatchObject({ config: null, revision: 0, preset: 'recommended', budget: { monthly_usd: null }, updatedAt: null });
    expect(body.resolved.access).toEqual({ source: 'subscription' });
    expect(body.resolved.roles).toEqual(TEAM_CONFIG_PRESET_ROLES.recommended);
  });

  it('is read by a member of the account as well', async () => {
    const project = await seedTrackerProject();
    const member = await seedSessionUser('member');
    await seedMembership(OWNER_ACCOUNT_ID, member.userId, 'member');
    expect((await sendAsSession(member, 'GET', base(project))).status).toBe(200);
  });
});

describe('PUT …/team-config', () => {
  it('saves revision 1 over If-Match "0", answering the new view and ETag', async () => {
    const project = await seedTrackerProject();
    const response = await put(project, doc({ preset: 'economy', access: { source: 'api_key' } }), '"0"');
    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBe('"1"');
    const body = (await response.json()) as TeamConfigDto;
    expect(body.revision).toBe(1);
    expect(body.preset).toBe('economy');
    expect(body.resolved.access.source).toBe('api_key');
    expect(body.resolved.roles.dev.model).toBe('claude-sonnet-5');
    expect(body.updatedBy).toBe('local-owner');
  });

  it('stores the access source it had when the document names none', async () => {
    const project = await seedTrackerProject();
    const body = await saved(project, doc());
    expect(body.config?.access).toEqual({ source: 'subscription' });
  });

  it('answers 428 without If-Match, and 412 team-config-stale for an old or a future revision, writing nothing', async () => {
    const project = await seedTrackerProject();
    const missing = await send('PUT', base(project), { config: doc() });
    expect(missing.status).toBe(428);
    expect(await slugOf(missing)).toBe('team-config-version-required');
    await saved(project, doc());
    for (const ifMatch of ['"0"', '"5"']) {
      const stale = await put(project, doc({ preset: 'max' }), ifMatch);
      expect(stale.status).toBe(412);
      expect(await slugOf(stale)).toBe('team-config-stale');
    }
    expect(await auditRows(project.slug)).toHaveLength(1);
  });

  it('gives two concurrent PUTs with the same If-Match one 200 and one 412', async () => {
    const project = await seedTrackerProject();
    await saved(project, doc());
    const statuses = await Promise.all([put(project, doc({ preset: 'max' }), '"1"'), put(project, doc({ preset: 'economy' }), '"1"')]);
    expect(statuses.map((response) => response.status).sort()).toEqual([200, 412]);
    expect(await auditRows(project.slug)).toHaveLength(2);
  });

  it.each([
    ['an unknown top-level key', doc({ budgets: {} }), 'budgets'],
    ['an unknown role', doc({ roles: { intern: {} } }), 'roles.intern'],
    ['an unknown nested key', doc({ gates: { qa: 'always', extra: 1 } }), 'gates.extra'],
    ['security’s enabled', doc({ roles: { security: { enabled: true } } }), 'roles.security.enabled'],
    ['a never-off role switched off', doc({ roles: { pm: { enabled: false } } }), 'roles.pm.enabled'],
    ['a model outside the allow-list', doc({ roles: { dev: { model: 'opus' } } }), 'roles.dev.model'],
    ['a numeric string', doc({ roles: { dev: { max_turns: '400' } } }), 'roles.dev.max_turns'],
  ])('refuses %s with 422 team-config-invalid naming the path', async (_, config, field) => {
    const project = await seedTrackerProject();
    const response = await put(project, config, '"0"');
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ type: expect.stringContaining('team-config-invalid') as unknown, field });
    expect(await auditRows(project.slug)).toHaveLength(0);
  });

  it('refuses another schema with 422 team-config-schema', async () => {
    const project = await seedTrackerProject();
    const response = await put(project, { schema: 'team-config/v2' }, '"0"');
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ type: expect.stringContaining('team-config-schema') as unknown, field: 'schema' });
  });

  it('refuses a body member other than config and reason, and a reason over 500 characters', async () => {
    const project = await seedTrackerProject();
    const extra = await put(project, doc(), '"0"', { revision: 3 });
    expect(await extra.json()).toMatchObject({ field: 'body' });
    const long = await put(project, doc(), '"0"', { reason: 'x'.repeat(501) });
    expect(long.status).toBe(422);
    expect(await long.json()).toMatchObject({ field: 'reason' });
    expect((await put(project, doc(), '"0"', { reason: 'x'.repeat(500) })).status).toBe(200);
  });

  it('refuses a cross-origin PUT (CSRF) before it writes', async () => {
    const project = await seedTrackerProject();
    const response = await send('PUT', base(project), { config: doc() }, { ifMatch: '"0"', headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('csrf');
    expect(await auditRows(project.slug)).toHaveLength(0);
  });

  it('answers 403 owner-only to a member, a job of every role and the service identity', async () => {
    const project = await seedTrackerProject();
    const member = await seedSessionUser('member');
    await seedMembership(OWNER_ACCOUNT_ID, member.userId, 'member');
    const memberResponse = await sendAsSession(member, 'PUT', base(project), { config: doc() }, { headers: { 'If-Match': '"0"' } });
    expect(await slugOf(memberResponse)).toBe('owner-only');
    for (const role of ['orchestrator', 'pm', 'dev', 'security']) {
      const response = await send('PUT', base(project), { config: doc() }, { ifMatch: '"0"', job: jobActor(role) });
      expect(response.status, role).toBe(403);
      expect(await slugOf(response), role).toBe('owner-only');
    }
    const service = await sendAsService('PUT', base(project), { config: doc() });
    expect(await slugOf(service)).toBe('owner-only');
    expect(await auditRows(project.slug)).toHaveLength(0);
  });
});

describe('the audit row of a change (threat model C12 row 3)', () => {
  it('holds only revision_from, revision_to and the changed paths, never a value', async () => {
    const project = await seedTrackerProject();
    const sentinel = `SENTINEL${crypto.randomUUID().replaceAll('-', '')}`;
    await saved(project, doc({ gates: { code_paths: [`${sentinel}/**`] }, roles: { dev: { model: 'claude-fable-5-1' } } }));
    const [row] = await auditRows(project.slug);
    expect(row?.details).not.toContain(sentinel);
    expect(row?.details).not.toContain('claude-fable-5-1');
    const details = JSON.parse(row?.details ?? '{}') as Record<string, unknown>;
    expect(Object.keys(details).sort()).toEqual(['paths', 'revision_from', 'revision_to']);
    expect(details).toEqual({
      revision_from: 0,
      revision_to: 1,
      paths: ['access.source', 'gates.code_paths', 'roles.dev.model', 'schema'],
    });
  });

  it('names a large change by its sections rather than growing past the bound', () => {
    const diff = Array.from({ length: 40 }, (_, i) => ({ path: `roles.r${String(i % 14)}.max_turns${String(i)}` }));
    const paths = auditPathsOf(diff);
    expect(paths.length).toBeLessThanOrEqual(32);
    expect(paths).toContain('roles.r0');
  });

  it('redacts the reason before it is stored', async () => {
    const project = await seedTrackerProject();
    // Built at run time so no token-shaped literal is in the repository.
    const token = ['ghp', 'A'.repeat(36)].join('_');
    expect((await put(project, doc(), '"0"', { reason: `rotate after ${token} leaked` })).status).toBe(200);
    const revision = (await (await send('GET', `${base(project)}/revisions/1`)).json()) as TeamConfigRevisionDto;
    expect(revision.reason).not.toContain(token);
    expect(revision.reason).toContain('rotate after');
  });
});

describe('access source and placement (ADR 0009 d.3, threat model C12 row 6)', () => {
  async function hostedRunner(accountId = OWNER_ACCOUNT_ID): Promise<string> {
    const id = `01M6YSNJ0000000000HXST${String(Math.floor(Math.random() * 9000) + 1000)}`;
    await env.DB.prepare(
      `INSERT INTO runners (id, account_id, name, public_key_jwk, capabilities, hosted, isolation, allowed_projects, version, enrolled_at)
       VALUES (?1, ?2, 'hosted', ?3, '{"local":false,"maxConcurrency":1}', 1, 'container', '[]', '0.1.0', '2026-11-16T00:00:00.000Z')`,
    )
      .bind(id, accountId, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'h'.repeat(43) }))
      .run();
    return id;
  }

  it('refuses a subscription save while a hosted runner is admitted, and the reverse placement change', async () => {
    const account = await seedAccount();
    const owner = await seedSessionUser('owner');
    await seedMembership(account.id, owner.userId, 'owner');
    const { slug } = await seedAccountProject(account, { tracker: 'console', repoId: 912_345 });
    const path = `${P}/${slug}/team-config`;
    const hosted = await hostedRunner(account.id);

    const refused = await sendAsSession(owner, 'PUT', path, { config: doc({ access: { source: 'subscription' } }) }, { headers: { 'If-Match': '"0"' } });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ type: expect.stringContaining('access-source-hosted') as unknown, field: 'access.source' });

    // Pinned to a self-hosted runner, a subscription is fine; then pointing the placement at the hosted one is refused.
    const mac = await enrolRunner(account.id, { allowedProjects: [slug], as: owner });
    expect((await sendAsSession(owner, 'PUT', `${P}/${slug}/runner-policy`, { mode: 'pinned', runner: mac.id })).status).toBe(200);
    expect((await sendAsSession(owner, 'PUT', path, { config: doc({ access: { source: 'subscription' } }) }, { headers: { 'If-Match': '"0"' } })).status).toBe(200);
    const reverse = await sendAsSession(owner, 'PUT', `${P}/${slug}/runner-policy`, { mode: 'pinned', runner: hosted });
    expect(reverse.status).toBe(422);
    expect(await slugOf(reverse)).toBe('access-source-hosted');
    const accountDefault = await sendAsSession(owner, 'PUT', `/api/v1/accounts/${account.id}/runner-policy`, { mode: 'any' });
    expect(accountDefault.status).toBe(200);
    expect((await sendAsSession(owner, 'PUT', `${P}/${slug}/runner-policy`, null)).status).toBe(422);

    // On an API key the hosted runner is allowed.
    expect((await sendAsSession(owner, 'PUT', path, { config: doc({ access: { source: 'api_key' } }) }, { headers: { 'If-Match': '"1"' } })).status).toBe(200);
    expect((await sendAsSession(owner, 'PUT', `${P}/${slug}/runner-policy`, { mode: 'pinned', runner: hosted })).status).toBe(200);
  });
});

describe('two accounts (threat model C12 row 2, C9)', () => {
  const ROUTES = [
    ['GET', ''],
    ['PUT', ''],
    ['POST', '/reset'],
    ['POST', '/import'],
    ['GET', '/revisions'],
    ['GET', '/revisions/1'],
    ['GET', '/resolved'],
  ] as const;

  it('answers a user of A on B’s project 404 project-not-found on every route', async () => {
    const a = await seedSessionUser('owner');
    const b = await seedAccount();
    const { slug } = await seedAccountProject(b, { tracker: 'console', repoId: 912_346 });
    for (const [method, suffix] of ROUTES) {
      const response = await sendAsSession(a, method, `${P}/${slug}/team-config${suffix}`, method === 'GET' ? undefined : {}, {
        headers: { 'If-Match': '"0"' },
      });
      expect(response.status, `${method} ${suffix}`).toBe(404);
      expect(await slugOf(response)).toBe('project-not-found');
    }
  });

  it('answers a job of project X on project Y of the same account 404 project-not-found on every route', async () => {
    const x = await seedTrackerProject();
    const y = await seedTrackerProject();
    for (const [method, suffix] of ROUTES) {
      const response = await send(method, `${P}/${y.slug}/team-config${suffix}`, method === 'GET' ? undefined : {}, {
        ifMatch: '"0"',
        job: { ...jobActor('pm'), projectSlug: x.slug },
      });
      expect(response.status, `${method} ${suffix}`).toBe(404);
      expect(await slugOf(response)).toBe('project-not-found');
    }
  });
});

describe('…/resolved for a job (threat model C12 row 2, T2)', () => {
  it('answers the revision the claim stamped, whatever the request names', async () => {
    const project = await seedTrackerProject();
    await saved(project, doc({ preset: 'economy', access: { source: 'api_key' } }));
    const { runner, jobToken } = await seedClaimedJob(project.slug);
    await saved(project, doc({ preset: 'max', access: { source: 'api_key' } }), '"1"');
    for (const query of ['', '?revision=2', '?revision=0']) {
      const response = await sendAsJob(runner, jobToken, 'GET', `${base(project)}/resolved${query}`);
      expect(response.status).toBe(200);
      const view = (await response.json()) as ResolvedTeamConfigDto;
      expect(view.revision).toBe(1);
      expect(view.roles.dev.model).toBe(TEAM_CONFIG_PRESET_ROLES.economy.dev.model);
    }
    // The owner reads the current revision.
    expect(((await (await send('GET', `${base(project)}/resolved`)).json()) as ResolvedTeamConfigDto).revision).toBe(2);
  });

  it('resolves a job claimed before any document to recommended plus the project’s access source', async () => {
    const project = await seedTrackerProject();
    const { runner, jobToken } = await seedClaimedJob(project.slug);
    await saved(project, doc({ preset: 'max', access: { source: 'api_key' } }));
    const view = (await (await sendAsJob(runner, jobToken, 'GET', `${base(project)}/resolved`)).json()) as ResolvedTeamConfigDto;
    expect(view.revision).toBe(0);
    expect(view.roles).toEqual(TEAM_CONFIG_PRESET_ROLES.recommended);
    expect(view.access.source).toBe('api_key');
  });

  it('carries no budget, preset, reason, author, diff or credential key (key set, not a snapshot)', async () => {
    const project = await seedTrackerProject();
    await saved(project, doc({ budget: { monthly_usd: 400 } }));
    const { runner, jobToken } = await seedClaimedJob(project.slug);
    const view: unknown = await (await sendAsJob(runner, jobToken, 'GET', `${base(project)}/resolved`)).json();
    expect(isResolvedTeamConfig(view)).toBe(true);
    expect(Object.keys(view as object).sort()).toEqual(['access', 'caps', 'cost', 'gates', 'language', 'revision', 'roles', 'schema', 'sprint']);
    for (const key of ['budget', 'preset', 'reason', 'created_by', 'createdBy', 'diff']) {
      expect(keysOf(view)).not.toContain(key);
    }
  });

  it.each(['', '/revisions', '/revisions/1'])('refuses a job on …/team-config%s with 403 owner-only', async (suffix) => {
    const project = await seedTrackerProject();
    await saved(project, doc());
    const { runner, jobToken } = await seedClaimedJob(project.slug);
    const response = await sendAsJob(runner, jobToken, 'GET', `${base(project)}${suffix}`);
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('owner-only');
  });
});

describe('no credential in any team-config DTO (threat model C12 row 6)', () => {
  it('names no credential, token or kind key in the view, the history, a revision or the claim', async () => {
    const project = await seedTrackerProject();
    await saved(project, doc({ access: { source: 'api_key' } }));
    const bodies: unknown[] = [];
    for (const path of ['', '/resolved', '/revisions', '/revisions/1']) {
      bodies.push(await (await send('GET', `${base(project)}${path}`)).json());
    }
    await enqueueJob(project.slug, { kind: 'slot-qa' });
    const runner = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [project.slug] });
    const claim = (await (await sendAsRunner(runner, 'POST', '/api/v1/runner/jobs/claim', {})).json()) as ClaimResponse;
    bodies.push(claim.teamConfig);
    expect(bodies.flatMap(keysOf).filter((key) => CREDENTIAL_KEYS.test(key))).toEqual([]);
  });
});

describe('the claim response (ADR 0009 d.7)', () => {
  it('carries the resolved view of the stamped revision; a later change applies to the next claim', async () => {
    const project = await seedTrackerProject();
    await saved(project, doc({ preset: 'economy', access: { source: 'api_key' } }));
    await enqueueJob(project.slug, { kind: 'slot-qa' });
    await enqueueJob(project.slug, { kind: 'slot-dev' });
    const runner = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [project.slug], enrol: { capabilities: { local: true, maxConcurrency: 2 } } });
    const first = (await (await sendAsRunner(runner, 'POST', '/api/v1/runner/jobs/claim', {})).json()) as ClaimResponse;
    expect(first.teamConfigRevision).toBe(1);
    expect(first.teamConfig.revision).toBe(1);
    expect(isResolvedTeamConfig(first.teamConfig)).toBe(true);
    await saved(project, doc({ preset: 'max', access: { source: 'api_key' } }), '"1"');
    const second = (await (await sendAsRunner(runner, 'POST', '/api/v1/runner/jobs/claim', {})).json()) as ClaimResponse;
    expect(second.teamConfigRevision).toBe(2);
    expect(second.teamConfig.roles.dev.model).toBe('claude-fable-5-1');
  });

  it('carries recommended and a null revision for a project with no document', async () => {
    const project = await seedTrackerProject();
    await enqueueJob(project.slug, { kind: 'slot-qa' });
    const runner = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [project.slug] });
    const claim = (await (await sendAsRunner(runner, 'POST', '/api/v1/runner/jobs/claim', {})).json()) as ClaimResponse;
    expect(claim.teamConfigRevision).toBeNull();
    expect(claim.teamConfig.roles).toEqual(TEAM_CONFIG_PRESET_ROLES.recommended);
  });
});

describe('revisions', () => {
  it('lists the history oldest first with a cursor, and reads one by its number only', async () => {
    const project = await seedTrackerProject();
    await saved(project, doc());
    await saved(project, doc({ language: 'en' }), '"1"');
    const page = (await (await send('GET', `${base(project)}/revisions?limit=1`)).json()) as TeamConfigRevisionListDto;
    expect(page.revisions.map((row) => row.revision)).toEqual([1]);
    expect(page.nextCursor).toBe(1);
    const next = (await (await send('GET', `${base(project)}/revisions?after=1`)).json()) as TeamConfigRevisionListDto;
    expect(next.revisions).toEqual([expect.objectContaining({ revision: 2, paths: ['language'], reason: null })]);
    const second = (await (await send('GET', `${base(project)}/revisions/2`)).json()) as TeamConfigRevisionDto;
    expect(second.diff).toEqual([{ path: 'language', to: 'en' }]);
    const { id } = (await env.DB.prepare(`SELECT id FROM team_config_revisions WHERE project_slug = ?1 AND revision = 1`)
      .bind(project.slug)
      .first<{ id: string }>()) ?? { id: '' };
    for (const n of [id, '0', '3', '01', '-1']) {
      const response = await send('GET', `${base(project)}/revisions/${n}`);
      expect(response.status, n).toBe(404);
      expect(await slugOf(response)).toBe('team-config-revision-not-found');
    }
  });
});

describe('POST …/team-config/reset', () => {
  it('applies a preset to every role and keeps the rest of the document', async () => {
    const project = await seedTrackerProject();
    await saved(project, doc({ preset: 'max', language: 'en', roles: { dev: { model: 'claude-sonnet-5' } } }));
    const response = await send('POST', `${base(project)}/reset`, { preset: 'economy' }, { ifMatch: '"1"' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as TeamConfigDto;
    expect(body.config).toEqual({ schema: TEAM_CONFIG_SCHEMA, preset: 'economy', language: 'en', access: { source: 'subscription' } });
    expect(body.revision).toBe(2);
  });

  it('defaults to the preset of the access source (#631: economy for an API key) and needs If-Match', async () => {
    const project = await seedTrackerProject();
    await saved(project, doc({ access: { source: 'api_key' } }));
    expect((await send('POST', `${base(project)}/reset`, {})).status).toBe(428);
    const body = (await (await send('POST', `${base(project)}/reset`, {}, { ifMatch: '"1"' })).json()) as TeamConfigDto;
    expect(body.preset).toBe('economy');
    const invalid = await send('POST', `${base(project)}/reset`, { preset: 'custom' }, { ifMatch: '"2"' });
    expect(await invalid.json()).toMatchObject({ field: 'preset' });
  });
});

describe('POST …/team-config/import (threat model C12 row 7)', () => {
  const CONTENTS = /^\/repos\/[^/]+\/[^/]+\/contents\/\.product-team\/project\.yml$/;

  function base64Of(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  /** GitHub with the project's repository by its recorded id, and `file` as its project.yml on `dev`. */
  function gitHubWith(file: string | { readonly size: number } | null): { github: ApiGitHub; contentReads: () => URL[] } {
    const { github, stub } = pullRequestsGitHub(
      () => null,
      (call) => {
        if (!CONTENTS.test(call.url.pathname)) {
          return null;
        }
        if (file === null) {
          return json(404, { message: 'Not Found' });
        }
        if (typeof file !== 'string') {
          return json(200, { type: 'file', size: file.size, sha: 'c'.repeat(40), encoding: 'none', content: '' });
        }
        const content = base64Of(file);
        return json(200, { type: 'file', size: new TextEncoder().encode(file).length, sha: 'c'.repeat(40), encoding: 'base64', content });
      },
    );
    return { github, contentReads: () => stub.reads().filter((call) => CONTENTS.test(call.url.pathname)).map((call) => call.url) };
  }

  const importAs = (project: SeededProject, github: ApiGitHub, body: unknown = {}) =>
    send('POST', `${base(project)}/import`, body, { github });

  const YML = [
    'name: Acme',
    'model: claude-fable-5-1',
    'review:',
    '  qa: never',
    '  reviewer: code',
    '  code_paths: ["apps/**", "libs/**"]',
    '  max_rework_rounds: 2',
    '  model: claude-fable-5-1',
    'caps:',
    '  burn: { dev_tasks: 4, parallel_devs: 2 }',
    'sprint:',
    '  length_days: 14',
    '  freeze_days: 2',
    'owner:',
    '  language: en',
    'access:',
    '  source: subscription',
    'budget:',
    '  monthly_usd: 100000',
    'cost:',
    '  batch_api: true',
    'roles:',
    '  dev: { model: claude-fable-5-1 }',
  ].join('\n');

  it('answers a draft for PUT from the default branch, never saving it', async () => {
    const project = await seedTrackerProject();
    const { github, contentReads } = gitHubWith(YML);
    const response = await importAs(project, github);
    expect(response.status).toBe(200);
    const body = (await response.json()) as TeamConfigImportDto;
    expect(body.draft).toEqual({
      schema: TEAM_CONFIG_SCHEMA,
      preset: 'recommended',
      gates: { qa: 'code', reviewer: 'code', code_paths: ['apps/**', 'libs/**'], max_rework_rounds: 2 },
      caps: { burn: { dev_tasks: 4, parallel_devs: 2 } },
      sprint: { length_days: 14, freeze_days: 2 },
      language: 'en',
    });
    expect(body.notes).toEqual(
      expect.arrayContaining([
        { path: 'review.qa', code: 'never-as-code' },
        { path: 'model', code: 'model-ignored' },
        { path: 'review.model', code: 'model-ignored' },
        { path: 'roles.dev.model', code: 'model-ignored' },
      ]),
    );
    expect(body.source).toEqual({ path: '.product-team/project.yml', ref: 'dev', sha: 'c'.repeat(40) });
    // Read from the registered repository on its default branch; nothing saved.
    expect(contentReads().map((url) => `${url.pathname}${url.search}`)).toEqual([
      `/repos/acme/${project.slug}/contents/.product-team/project.yml?ref=dev`,
    ]);
    expect((await (await send('GET', base(project))).json()) as TeamConfigDto).toMatchObject({ revision: 0, config: null });
    // The draft saves as it is.
    expect((await put(project, body.draft, '"0"')).status).toBe(200);
  });

  it('refuses an alias bomb (billion laughs) without expanding it', async () => {
    const project = await seedTrackerProject();
    const bomb = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]', 'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]', 'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]', 'review: { qa: *c }'].join('\n');
    const response = await importAs(project, gitHubWith(bomb).github);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ type: expect.stringContaining('team-config-import-invalid') as unknown, field: 'project.yml' });
  });

  it('refuses a 1 MB file before reading its content', async () => {
    const project = await seedTrackerProject();
    const response = await importAs(project, gitHubWith({ size: 1024 * 1024 }).github);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ field: 'project.yml' });
  });

  it('never reads a __proto__ key into the draft', async () => {
    const project = await seedTrackerProject();
    const yml = ['__proto__: { preset: max }', 'review:', '  __proto__: { qa: never }', '  qa: always'].join('\n');
    const body = (await (await importAs(project, gitHubWith(yml).github)).json()) as TeamConfigImportDto;
    expect(body.draft).toEqual({ schema: TEAM_CONFIG_SCHEMA, preset: 'recommended', gates: { qa: 'always' } });
    expect(body.notes).toContainEqual({ path: 'review.__proto__', code: 'key-ignored' });
    expect(Object.getPrototypeOf(body.draft)).toBe(Object.prototype);
  });

  it('answers 422 naming the project.yml path of a value the schema refuses', async () => {
    const project = await seedTrackerProject();
    const response = await importAs(project, gitHubWith('review:\n  max_rework_rounds: 9\n').github);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ field: 'review.max_rework_rounds' });
  });

  it('answers 422 when the default branch has no project.yml', async () => {
    const project = await seedTrackerProject();
    const response = await importAs(project, gitHubWith(null).github);
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('team-config-import-invalid');
  });

  it('never reads a repository named in the body', async () => {
    const project = await seedTrackerProject();
    const { github, contentReads } = gitHubWith(YML);
    const response = await importAs(project, github, { repo: 'evil/other', ref: 'main' });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ field: 'body' });
    expect(contentReads()).toEqual([]);
  });

  it(`is limited to ${String(IMPORTS_PER_WINDOW)} imports per project per window`, async () => {
    const project = await seedTrackerProject();
    const { github } = gitHubWith('owner: { language: ru }\n');
    for (let n = 0; n < IMPORTS_PER_WINDOW; n += 1) {
      expect((await importAs(project, github)).status).toBe(200);
    }
    const limited = await importAs(project, github);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).not.toBeNull();
    // Another project has its own budget.
    expect((await importAs(await seedTrackerProject(), github)).status).toBe(200);
  });
});
