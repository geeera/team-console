import { env } from 'cloudflare:test';
import { TEAM_CONFIG_SCHEMA, isProblemDetails, problemSlugOf } from '@shared/contracts';
import { newUlid } from '@worker/core';
import { TeamConfigRepo } from '@worker/db';
import {
  actionsToken,
  createTestIssuer,
  exchangeBodyOf,
  postExchange,
  runClaimsOf,
  seedActionsJob,
  seedActionsProject,
  type ActionsProject,
  type TestIssuer,
  type TokenOptions,
} from '../testing/actions-oidc-kit';

// #695 (OIDC exchange hardening before Actions dispatch) and #706 (the exchange applies the role admission): each
// rule the exchange gained, with the run it still admits and the run it now refuses.

let issuer: TestIssuer;

beforeAll(async () => {
  issuer = await createTestIssuer();
});

async function exchange(project: ActionsProject, jobId: string, options: TokenOptions = {}): Promise<Response> {
  const token = await actionsToken(issuer, runClaimsOf(project), options);
  const request = await exchangeBodyOf(token, jobId);
  return postExchange(request.body, issuer.bindings);
}

async function claimOf(response: Response): Promise<{ status: number; slug: string | null; claim: unknown }> {
  const body: unknown = await response.clone().json();
  return {
    status: response.status,
    slug: isProblemDetails(body) ? problemSlugOf(body.type) : null,
    claim: (body as { claim?: unknown }).claim,
  };
}

async function stateOf(jobId: string): Promise<string | undefined> {
  const row = await env.DB.prepare(`SELECT state FROM jobs WHERE id = ?1`).bind(jobId).first<{ state: string }>();
  return row?.state;
}

/** Revision 2 of the project's team configuration (seedActionsProject saved revision 1, `api_key`). */
async function saveRoles(project: ActionsProject, roles: Record<string, unknown>): Promise<void> {
  const at = new Date().toISOString();
  const outcome = await new TeamConfigRepo(env.DB).save({
    projectSlug: project.slug,
    expectedRevision: 1,
    config: { schema: TEAM_CONFIG_SCHEMA, access: { source: 'api_key' }, roles } as Parameters<TeamConfigRepo['save']>[0]['config'],
    diff: [{ path: 'roles', to: roles }],
    reason: null,
    id: newUlid(),
    at,
    by: 'owner',
    audit: {
      accountId: project.accountId,
      at,
      actorKind: 'user',
      actor: 'owner',
      kind: 'team-config.changed',
      target: project.slug,
      details: { revision_from: 1, revision_to: 2, paths: ['roles'] },
    },
  });
  expect(outcome.kind).toBe('saved');
}

describe('#695 item 1: the token’s iat is bounded', () => {
  it('accepts a token issued a minute ago, refuses one issued past the 10-minute limit while its exp still holds', async () => {
    const project = await seedActionsProject();
    const now = Math.floor(Date.now() / 1000);

    const fresh = await seedActionsJob(project);
    expect((await exchange(project, fresh, { issuedAt: now - 60, lifetimeSeconds: 3600 })).status).toBe(200);

    const old = await seedActionsJob(project);
    const response = await exchange(project, old, { issuedAt: now - 20 * 60, lifetimeSeconds: 3600 });
    expect(await claimOf(response)).toEqual({ status: 401, slug: 'oidc-exchange-refused', claim: 'iat' });
    expect(await stateOf(old)).toBe('queued');
  });

  it('refuses a token whose iat is in the future past the 30 s tolerance, and accepts one inside it', async () => {
    const project = await seedActionsProject();
    const now = Math.floor(Date.now() / 1000);

    const ahead = await seedActionsJob(project);
    const response = await exchange(project, ahead, { issuedAt: now + 5 * 60, omit: ['nbf'] });
    expect(await claimOf(response)).toEqual({ status: 401, slug: 'oidc-exchange-refused', claim: 'iat' });

    const skewed = await seedActionsJob(project);
    expect((await exchange(project, skewed, { issuedAt: now + 10, omit: ['nbf'] })).status).toBe(200);
  });
});

describe('#695 item 2: a needs_local job never runs on a GitHub VM', () => {
  it('refuses the exchange for a needs_local job and leaves it queued', async () => {
    const project = await seedActionsProject();
    const local = await seedActionsJob(project, 'actions', { needsLocal: true });
    expect(await claimOf(await exchange(project, local))).toEqual({ status: 409, slug: 'oidc-exchange-refused', claim: 'job_id' });
    expect(await stateOf(local)).toBe('queued');
  });
});

describe('#695 item 3: only a job the console dispatched is exchanged', () => {
  it('refuses a run for a queued Actions job that was never dispatched (a hand-started run), admits it once dispatched', async () => {
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project, 'actions', { dispatched: false });
    expect(await claimOf(await exchange(project, jobId))).toEqual({ status: 409, slug: 'oidc-exchange-refused', claim: 'job_id' });
    expect(await stateOf(jobId)).toBe('queued');

    await env.DB.prepare(`UPDATE jobs SET dispatched_at = ?2 WHERE id = ?1`).bind(jobId, new Date().toISOString()).run();
    expect((await exchange(project, jobId)).status).toBe(200);
    expect(await stateOf(jobId)).toBe('claimed');
  });
});

describe('#706: the role admission inside the exchange', () => {
  it('never exchanges a job of a role the team configuration switched off', async () => {
    const project = await seedActionsProject();
    await saveRoles(project, { architect: { enabled: false } });
    const jobId = await seedActionsJob(project, 'actions', { role: 'architect' });
    expect(await claimOf(await exchange(project, jobId))).toEqual({ status: 409, slug: 'oidc-exchange-refused', claim: 'job_id' });
    expect(await stateOf(jobId)).toBe('queued');
    const runners = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM runners WHERE isolation = 'actions-ephemeral' AND allowed_projects = json_array(?1)`,
    )
      .bind(project.slug)
      .first<{ n: number }>();
    expect(runners?.n).toBe(0);
  });

  it('with max_parallel 1, two concurrent exchanges for two queued jobs of one role give one claim', async () => {
    const project = await seedActionsProject();
    await saveRoles(project, { 'dev-light': { max_parallel: 1 } });
    const first = await seedActionsJob(project, 'actions', { role: 'dev-light' });
    const second = await seedActionsJob(project, 'actions', { role: 'dev-light' });

    const answers = await Promise.all([exchange(project, first), exchange(project, second)]);
    expect(answers.map((response) => response.status).sort()).toEqual([200, 409]);
    const states = [await stateOf(first), await stateOf(second)].sort();
    expect(states).toEqual(['claimed', 'queued']);
    const live = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE project_slug = ?1 AND role = 'dev-light' AND state IN ('claimed', 'running')`,
    )
      .bind(project.slug)
      .first<{ n: number }>();
    expect(live?.n).toBe(1);
  });

  it('admits the second job once the first holds no live slot', async () => {
    const project = await seedActionsProject();
    await saveRoles(project, { 'dev-light': { max_parallel: 1 } });
    const first = await seedActionsJob(project, 'actions', { role: 'dev-light' });
    const second = await seedActionsJob(project, 'actions', { role: 'dev-light' });
    expect((await exchange(project, first)).status).toBe(200);
    expect((await exchange(project, second)).status).toBe(409);

    await env.DB.prepare(`UPDATE jobs SET state = 'finished', finished_at = ?2, token_hash = NULL, lease_until = NULL WHERE id = ?1`)
      .bind(first, new Date().toISOString())
      .run();
    expect((await exchange(project, second)).status).toBe(200);
  });
});
