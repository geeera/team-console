import { env } from 'cloudflare:test';
import { generateKeyPair, type KeyObject } from 'jose';
import {
  OWNER_ACCOUNT_ID,
  isOidcExchangeResponse,
  isProblemDetails,
  problemSlugOf,
  runnerAudienceOf,
  type OidcExchangeResponse,
  type RunnerListDto,
} from '@shared/contracts';
import { JobsRepo } from '@worker/db';
import { actionsJwksSourceOf } from '../auth/actions-oidc';
import {
  actionsToken,
  createTestIssuer,
  exchangeBodyOf,
  dispatchedRunOf,
  nextRunId,
  postExchange,
  runClaimsOf,
  saveAccessSource,
  seedActionsJob,
  uniqueAddress,
  seedActionsProject,
  type ActionsProject,
  type TestIssuer,
} from '../testing/actions-oidc-kit';
import { fetchApi } from '../testing/access-kit';
import { localEnv } from '../testing/github-kit';
import {
  createEnrolmentCode,
  enrolBodyOf,
  enrolRunner,
  generateRunnerKey,
  inOneRateWindow,
  postEnrol,
  rateBucketCount,
  sendAsJob,
  sendAsRunner,
  withRateBucketAt,
  uniqueIpv6Prefix,
} from '../testing/runner-kit';
import { seedSessionUser } from '../testing/session-kit';
import {
  OIDC_EXCHANGE_RATE_LIMIT_GLOBAL_PER_MINUTE,
  OIDC_EXCHANGE_RATE_LIMIT_PER_MINUTE,
  OIDC_EXCHANGE_RATE_LIMIT_PER_REPOSITORY_PER_MINUTE,
  OIDC_EXCHANGE_RATE_LIMIT_UNVERIFIED_PER_MINUTE,
} from './runner-oidc';

// #668 (#573 sub-issue 1; ADR 0008 decision 7(a′), threat model C11 row 5 and C4): a GitHub-hosted workflow run trades
// its OIDC token for an ephemeral runner identity of exactly one job. Every verified claim is proven with one value
// it accepts and one it refuses; every refusal is one problem, the failing claim named; the token never reaches a log.

let issuer: TestIssuer;

beforeAll(async () => {
  issuer = await createTestIssuer();
});

interface Refusal {
  readonly status: number;
  readonly slug: string | null;
  readonly claim: unknown;
}

async function refusalOf(response: Response): Promise<Refusal> {
  const body: unknown = await response.clone().json();
  return {
    status: response.status,
    slug: isProblemDetails(body) ? problemSlugOf(body.type) : null,
    claim: (body as { claim?: unknown }).claim,
  };
}

const refusedFor = (status: number, claim: string): Refusal => ({ status, slug: 'oidc-exchange-refused', claim });

/** One exchange of a run of `project` for `jobId`, with `claims` changed as the case says. */
async function exchange(
  project: ActionsProject,
  jobId: string,
  change: (claims: Record<string, unknown>) => Record<string, unknown> = (claims) => claims,
  options: { logSink?: (line: string) => void; headers?: Record<string, string> } = {},
) {
  const token = await actionsToken(issuer, change(runClaimsOf(project, dispatchedRunOf(jobId))));
  const request = await exchangeBodyOf(token, jobId);
  const response = await postExchange(request.body, issuer.bindings, options);
  return { response, token, ...request };
}

async function jobRow(id: string) {
  return env.DB.prepare(`SELECT state, runner_id, actions_run_id, token_hash, dispatch FROM jobs WHERE id = ?1`)
    .bind(id)
    .first<{ state: string; runner_id: string | null; actions_run_id: string | null; token_hash: string | null; dispatch: string }>();
}

async function runnerRow(id: string) {
  return env.DB.prepare(
    `SELECT account_id, name, isolation, allowed_projects, capabilities, hosted, revoked_at, suspect_reason FROM runners WHERE id = ?1`,
  )
    .bind(id)
    .first<{
      account_id: string;
      name: string;
      isolation: string;
      allowed_projects: string;
      capabilities: string;
      hosted: number;
      revoked_at: string | null;
      suspect_reason: string | null;
    }>();
}

async function listRunners(): Promise<RunnerListDto> {
  const response = await fetchApi(`/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners`, localEnv());
  expect(response.status).toBe(200);
  return (await response.json()) as RunnerListDto;
}

describe('POST /api/v1/runner/oidc-exchange: a valid run', () => {
  it('writes an actions-ephemeral runner for the job’s project and claims the job for it in one batch', async () => {
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project);
    const { response, publicKeyJwk } = await exchange(project, jobId);

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(isOidcExchangeResponse(body)).toBe(true);
    const answer = body as OidcExchangeResponse;
    expect(answer.runner.audience).toBe(runnerAudienceOf('local'));
    expect(answer.job).toMatchObject({ id: jobId, state: 'claimed', dispatch: 'actions', runnerId: answer.runner.id });
    expect(answer.jobToken.startsWith('tcj_')).toBe(true);

    const runner = await runnerRow(answer.runner.id);
    expect(runner).toMatchObject({ account_id: OWNER_ACCOUNT_ID, isolation: 'actions-ephemeral', hosted: 0, revoked_at: null });
    expect(runner?.name).toMatch(/^actions:[0-9]+$/);
    expect(JSON.parse(runner?.allowed_projects ?? 'null')).toEqual([project.slug]);
    expect(JSON.parse(runner?.capabilities ?? 'null')).toEqual({ local: false, maxConcurrency: 1 });
    const stored = await env.DB.prepare(`SELECT public_key_jwk FROM runners WHERE id = ?1`).bind(answer.runner.id).first<{ public_key_jwk: string }>();
    expect(JSON.parse(stored?.public_key_jwk ?? '{}')).toEqual(publicKeyJwk);

    const job = await jobRow(jobId);
    expect(job).toMatchObject({ state: 'claimed', runner_id: answer.runner.id, dispatch: 'actions' });
    expect(job?.actions_run_id).toBe(runner?.name.slice('actions:'.length));
    const audit = await env.DB.prepare(`SELECT kind, actor, target FROM audit_events WHERE actor = ?1 ORDER BY id`)
      .bind(answer.runner.id)
      .all<{ kind: string; actor: string; target: string }>();
    expect(audit.results.map((row) => [row.kind, row.target])).toEqual([
      ['runner.enrolled', answer.runner.id],
      ['job.claimed', jobId],
    ]);
  });

  it('lets the run use the ordinary runner and job routes, then revokes the identity at finish', async () => {
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project);
    const { response, privateKey } = await exchange(project, jobId);
    const answer = (await response.json()) as OidcExchangeResponse;
    const run = { id: answer.runner.id, privateKey };

    const started = await sendAsRunner(run, 'POST', `/api/v1/runner/jobs/${jobId}/events`, {
      events: [{ level: 'info', kind: 'started', payload: {} }],
    });
    expect(started.status).toBe(201);
    // The job token works only with this run's runner JWT (R4), as for any claimed job.
    const read = await sendAsJob(run, answer.jobToken, 'GET', `/api/v1/projects/${project.slug}/jobs/${jobId}`);
    expect(read.status).toBe(200);

    const finish = await sendAsRunner(run, 'POST', `/api/v1/runner/jobs/${jobId}/finish`, {
      result: 'finished',
      summary: 'done',
    });
    expect(finish.status).toBe(200);
    expect((await runnerRow(run.id))?.revoked_at).not.toBeNull();
    const after = await sendAsRunner(run, 'GET', '/api/v1/runner/release');
    expect(await refusalOf(after)).toMatchObject({ status: 401, slug: 'runner-revoked' });
  });
});

describe('the team configuration (ADR 0009 d.3, d.9; #687, #682)', () => {
  it('stamps the current revision on the job and answers its resolved view, as the pull claim does', async () => {
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project);
    const { response } = await exchange(project, jobId);
    expect(response.status).toBe(200);
    const answer = (await response.json()) as OidcExchangeResponse;
    expect(answer.teamConfigRevision).toBe(1);
    expect(answer.teamConfig).toMatchObject({ revision: 1, access: { source: 'api_key' } });
    const stamped = await env.DB.prepare(`SELECT team_config_revision FROM jobs WHERE id = ?1`)
      .bind(jobId)
      .first<{ team_config_revision: number | null }>();
    expect(stamped?.team_config_revision).toBe(1);
  });

  it('refuses the job of a subscription project as one problem naming access_source, and writes nothing', async () => {
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project);
    // While the project is dispatched to Actions the save itself refuses a subscription.
    expect(await saveAccessSource(project, 'subscription', 1)).toBe('access-source-hosted');
    // A job queued under the API key, the source switched after (the project back on pull): the exchange's batch
    // judges the source, not the job's history.
    await env.DB.prepare(`UPDATE projects SET dispatch = 'pull' WHERE slug = ?1`).bind(project.slug).run();
    expect(await saveAccessSource(project, 'subscription', 1)).toBe('saved');

    const { response } = await exchange(project, jobId);
    expect(await refusalOf(response)).toEqual(refusedFor(403, 'access_source'));
    expect(await jobRow(jobId)).toMatchObject({
      state: 'queued',
      runner_id: null,
      actions_run_id: dispatchedRunOf(jobId),
      token_hash: null,
    });
    const runners = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM runners WHERE isolation = 'actions-ephemeral' AND allowed_projects = json_array(?1)`,
    )
      .bind(project.slug)
      .first<{ n: number }>();
    expect(runners?.n).toBe(0);
  });
});

describe('the token (jose against the issuer JWKS)', () => {
  it('accepts RS256 and refuses another algorithm under the issuer’s kid', async () => {
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project);
    const claims = runClaimsOf(project, dispatchedRunOf(jobId));
    for (const algorithm of ['ES256', 'EdDSA'] as const) {
      const { privateKey } = await generateKeyPair(algorithm, { extractable: true });
      const other = await actionsToken({ privateKey, kid: issuer.kid }, claims, { algorithm });
      const refused = await postExchange((await exchangeBodyOf(other, jobId)).body, issuer.bindings);
      expect(await refusalOf(refused), algorithm).toEqual(refusedFor(401, 'token'));
    }
    const rs256 = await actionsToken(issuer, claims);
    expect((await postExchange((await exchangeBodyOf(rs256, jobId)).body, issuer.bindings)).status).toBe(200);
  });

  it('refuses a token signed by a key the issuer JWKS does not hold, and one forged under its kid', async () => {
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project);
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    for (const kid of ['unknown-kid', issuer.kid]) {
      const forged = await actionsToken({ privateKey, kid }, runClaimsOf(project, dispatchedRunOf(jobId)));
      const response = await postExchange((await exchangeBodyOf(forged, jobId)).body, issuer.bindings);
      expect(await refusalOf(response), kid).toEqual(refusedFor(401, 'token'));
    }
    expect((await jobRow(jobId))?.state).toBe('queued');
  });

  it('refuses an unsigned token and one that is not a JWT', async () => {
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project);
    const unsigned = `${btoa(JSON.stringify({ alg: 'none' })).replace(/=+$/, '')}.${btoa(JSON.stringify(runClaimsOf(project, dispatchedRunOf(jobId)))).replace(/=+$/, '')}.`;
    for (const token of [unsigned, 'not-a-jwt']) {
      const response = await postExchange((await exchangeBodyOf(token, jobId)).body, issuer.bindings);
      expect(await refusalOf(response)).toEqual(refusedFor(401, 'token'));
    }
  });

  it.each([
    ['iss', { issuer: 'https://token.actions.example.com' }],
    ['aud', { audience: runnerAudienceOf('dev') }],
  ] as const)('accepts the fixed %s and refuses another', async (claim, wrong) => {
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project);
    const claims = runClaimsOf(project, dispatchedRunOf(jobId));
    const bad = await postExchange((await exchangeBodyOf(await actionsToken(issuer, claims, wrong), jobId)).body, issuer.bindings);
    expect(await refusalOf(bad)).toEqual(refusedFor(401, claim));
    const good = await postExchange((await exchangeBodyOf(await actionsToken(issuer, claims), jobId)).body, issuer.bindings);
    expect(good.status).toBe(200);
  });

  it('refuses a token without an audience', async () => {
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project);
    const token = await actionsToken(issuer, runClaimsOf(project, dispatchedRunOf(jobId)), { omit: ['aud'] });
    expect(await refusalOf(await postExchange((await exchangeBodyOf(token, jobId)).body, issuer.bindings))).toEqual(
      refusedFor(401, 'aud'),
    );
  });

  it('accepts a token expired inside the 30 s tolerance and refuses one past it', async () => {
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project);
    const now = Math.floor(Date.now() / 1000);
    const claims = runClaimsOf(project, dispatchedRunOf(jobId));
    const stale = await actionsToken(issuer, claims, { issuedAt: now - 400, lifetimeSeconds: 340 });
    expect(await refusalOf(await postExchange((await exchangeBodyOf(stale, jobId)).body, issuer.bindings))).toEqual(
      refusedFor(401, 'exp'),
    );
    const late = await actionsToken(issuer, claims, { issuedAt: now - 320, lifetimeSeconds: 300 });
    expect((await postExchange((await exchangeBodyOf(late, jobId)).body, issuer.bindings)).status).toBe(200);
  });

  it('takes the JWKS override only on ENVIRONMENT = local', () => {
    const jwks = JSON.stringify({ keys: [] });
    expect(actionsJwksSourceOf({ ENVIRONMENT: 'local', ACTIONS_OIDC_JWKS: jwks })).toEqual({ kind: 'local', json: jwks });
    for (const environment of ['dev', 'stage', 'production']) {
      expect(actionsJwksSourceOf({ ENVIRONMENT: environment, ACTIONS_OIDC_JWKS: jwks })).toEqual({ kind: 'remote' });
    }
    expect(actionsJwksSourceOf({ ENVIRONMENT: 'local' })).toEqual({ kind: 'remote' });
  });
});

describe('each claim against the job’s project: one accepted value, one wrong value', () => {
  const at = (claims: Record<string, unknown>, key: string, value: unknown) => ({ ...claims, [key]: value });
  const workflowOf = (project: ActionsProject, file: string, ref = 'refs/heads/main', repo = project.repo) =>
    `${repo}/.github/workflows/${file}@${ref}`;

  it.each([
    ['repository_id', (_p: ActionsProject, c: Record<string, unknown>) => at(c, 'repository_id', '424242')],
    ['repository_id', (_p: ActionsProject, c: Record<string, unknown>) => at(c, 'repository_id', 880001)],
    ['ref', (_p: ActionsProject, c: Record<string, unknown>) => at(c, 'ref', 'refs/heads/feature')],
    ['ref', (_p: ActionsProject, c: Record<string, unknown>) => at(c, 'ref', 'refs/tags/main')],
    ['ref_type', (_p: ActionsProject, c: Record<string, unknown>) => at(c, 'ref_type', 'tag')],
    ['workflow_ref', (p: ActionsProject, c: Record<string, unknown>) => at(c, 'workflow_ref', workflowOf(p, 'other.yml'))],
    [
      'workflow_ref',
      (p: ActionsProject, c: Record<string, unknown>) => at(c, 'workflow_ref', workflowOf(p, 'team-console-runner.yml', 'refs/heads/feature')),
    ],
    [
      'workflow_ref',
      (p: ActionsProject, c: Record<string, unknown>) =>
        at(c, 'workflow_ref', workflowOf(p, 'team-console-runner.yml', 'refs/heads/main', 'evil/fork')),
    ],
    [
      'job_workflow_ref',
      (_p: ActionsProject, c: Record<string, unknown>) =>
        at(c, 'job_workflow_ref', 'evil/shared/.github/workflows/team-console-runner.yml@refs/heads/main'),
    ],
    ['event_name', (_p: ActionsProject, c: Record<string, unknown>) => at(c, 'event_name', 'push')],
    ['environment', (_p: ActionsProject, c: Record<string, unknown>) => at(c, 'environment', 'production')],
    ['environment', (_p: ActionsProject, c: Record<string, unknown>) => at(c, 'environment', undefined)],
    ['runner_environment', (_p: ActionsProject, c: Record<string, unknown>) => at(c, 'runner_environment', 'self-hosted')],
    ['run_id', (_p: ActionsProject, c: Record<string, unknown>) => at(c, 'run_id', '12a')],
  ])('%s: refuses the wrong value with the claim named, then accepts the right one', async (claim, wrong) => {
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project);
    const refused = await exchange(project, jobId, (claims) => wrong(project, claims));
    expect(await refusalOf(refused.response)).toEqual(refusedFor(401, claim));
    expect(await jobRow(jobId)).toMatchObject({ state: 'queued', runner_id: null, actions_run_id: dispatchedRunOf(jobId) });

    const accepted = await exchange(project, jobId);
    expect(accepted.response.status).toBe(200);
  });

  it('compares the repository part of workflow_ref in any case, as GitHub keeps its own casing', async () => {
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project);
    const lower = workflowOf(project, 'team-console-runner.yml', 'refs/heads/main', project.repo.toLowerCase());
    const response = (await exchange(project, jobId, (claims) => ({ ...claims, workflow_ref: lower, job_workflow_ref: lower }))).response;
    expect(response.status).toBe(200);
  });

  it('refuses every run of a project whose repository id or default branch the console never recorded', async () => {
    const project = await seedActionsProject();
    const noBranch = await seedActionsJob(project);
    await env.DB.prepare(`UPDATE projects SET default_branch = NULL WHERE slug = ?1`).bind(project.slug).run();
    expect(await refusalOf((await exchange(project, noBranch)).response)).toEqual(refusedFor(401, 'ref'));
    const unrecorded = await seedActionsProject(OWNER_ACCOUNT_ID, { recordRepoId: false });
    const noRepoId = await seedActionsJob(unrecorded);
    expect(await refusalOf((await exchange(unrecorded, noRepoId)).response)).toEqual(refusedFor(401, 'repository_id'));
  });

  it('refuses a run of another repository for this job, even when its token is otherwise perfect', async () => {
    const mine = await seedActionsProject();
    const theirs = await seedActionsProject((await seedSessionUser('owner')).account.id);
    const jobId = await seedActionsJob(mine);
    const token = await actionsToken(issuer, runClaimsOf(theirs));
    const response = await postExchange((await exchangeBodyOf(token, jobId)).body, issuer.bindings);
    expect(await refusalOf(response)).toEqual(refusedFor(401, 'repository_id'));
  });
});

describe('one run, one job, once', () => {
  it('refuses a run id already exchanged, for another job as for the same one (a replay or a re-run)', async () => {
    const project = await seedActionsProject();
    const first = await seedActionsJob(project);
    const second = await seedActionsJob(project);
    const runId = dispatchedRunOf(first);
    const token = await actionsToken(issuer, runClaimsOf(project, runId));
    expect((await postExchange((await exchangeBodyOf(token, first)).body, issuer.bindings)).status).toBe(200);

    const replayed = await postExchange((await exchangeBodyOf(token, first)).body, issuer.bindings);
    expect(await refusalOf(replayed)).toEqual(refusedFor(401, 'run_id'));
    const rerun = await actionsToken(issuer, { ...runClaimsOf(project, runId), run_attempt: '2' });
    expect(await refusalOf(await postExchange((await exchangeBodyOf(rerun, second)).body, issuer.bindings))).toEqual(
      refusedFor(401, 'run_id'),
    );
    expect(await jobRow(second)).toMatchObject({ state: 'queued', runner_id: null });
    // Accepted: the run dispatched for the second job takes it.
    expect((await exchange(project, second)).response.status).toBe(200);
  });

  it('answers a second exchange for the same job 409, and writes no second runner', async () => {
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project);
    expect((await exchange(project, jobId)).response.status).toBe(200);
    // Another run, never seen, for the job its own run already claimed.
    const token = await actionsToken(issuer, runClaimsOf(project, nextRunId()));
    const second = await postExchange((await exchangeBodyOf(token, jobId)).body, issuer.bindings);
    expect(await refusalOf(second)).toEqual(refusedFor(409, 'job_id'));
    const { results } = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM runners WHERE isolation = 'actions-ephemeral' AND allowed_projects = json_array(?1)`,
    )
      .bind(project.slug)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(1);
  });

  it('keeps the batch atomic when a run already exchanged for one job reaches the write for another', async () => {
    const project = await seedActionsProject();
    const first = await seedActionsJob(project);
    const second = await seedActionsJob(project);
    const runId = dispatchedRunOf(first);
    expect((await postExchange((await exchangeBodyOf(await actionsToken(issuer, runClaimsOf(project, runId)), first)).body, issuer.bindings)).status).toBe(200);
    const key = await generateRunnerKey();
    const repo = new JobsRepo(env.DB);
    const at = new Date().toISOString();
    const audit = { accountId: OWNER_ACCOUNT_ID, at, actorKind: 'runner' as const, actor: 'x', kind: 'job.claimed' as const, target: second };
    const outcome = await repo.exchangeForActions({
      jobId: second,
      runId,
      runnerId: '01M6YSNJ0000000000000RACE1',
      runnerName: `actions:${runId}`,
      publicKeyJwk: key.publicKeyJwk,
      host: { os: 'linux', arch: 'x64', hostname: 'vm' },
      version: '0.4.0',
      tokenHash: 'a'.repeat(64),
      now: at,
      leaseUntil: new Date(Date.now() + 300_000).toISOString(),
      country: null,
      ipHash: null,
      enrolledAudit: { ...audit, kind: 'runner.enrolled' },
      claimedAudit: audit,
    });
    // #723: the second job waits for its own dispatched run, so neither write of the batch lands.
    expect(outcome).toEqual({ kind: 'not-claimable' });
    expect(await runnerRow('01M6YSNJ0000000000000RACE1')).toBeNull();
    expect(await jobRow(second)).toMatchObject({ state: 'queued', runner_id: null, actions_run_id: dispatchedRunOf(second) });
  });

  it.each([
    ['a pulled job', async (project: ActionsProject) => seedActionsJob(project, 'pull'), 409],
    [
      'a job of a paused team',
      async (project: ActionsProject) => {
        const id = await seedActionsJob(project);
        await env.DB.prepare(
          `INSERT INTO team_state (project_slug, paused_at, paused_by, updated_at) VALUES (?1, ?2, 'owner', ?2)`,
        ).bind(project.slug, new Date().toISOString()).run();
        return id;
      },
      409,
    ],
    [
      'a finished job',
      async (project: ActionsProject) => {
        const id = await seedActionsJob(project);
        await env.DB.prepare(`UPDATE jobs SET state = 'cancelled', finished_at = ?2 WHERE id = ?1`).bind(id, new Date().toISOString()).run();
        return id;
      },
      409,
    ],
  ])('refuses %s as a job not waiting for a run', async (_, seed, status) => {
    const project = await seedActionsProject();
    const jobId = await seed(project);
    expect(await refusalOf((await exchange(project, jobId)).response)).toEqual(refusedFor(status, 'job_id'));
  });

  it('refuses a job id that names no job, and an ill-formed body before any token check', async () => {
    const project = await seedActionsProject();
    expect(await refusalOf((await exchange(project, '01M6YSNJ0000000000000N0NE1')).response)).toEqual(refusedFor(401, 'job_id'));
    const token = await actionsToken(issuer, runClaimsOf(project));
    const malformed = await postExchange({ ...(await exchangeBodyOf(token, 'not-a-ulid')).body }, issuer.bindings);
    expect(await refusalOf(malformed)).toMatchObject({ status: 422, slug: 'oidc-exchange-invalid' });
    const privateMember = await postExchange(
      { ...(await exchangeBodyOf(token, '01M6YSNJ0000000000000N0NE1')).body, publicKey: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), d: 'B'.repeat(43) } },
      issuer.bindings,
    );
    expect(await refusalOf(privateMember)).toMatchObject({ status: 422, slug: 'oidc-exchange-invalid' });
  });
});

describe('the token never reaches a log (sentinel)', () => {
  it('logs the claim and ids only, on success and on every refusal kind', async () => {
    const lines: string[] = [];
    const sink = (line: string) => lines.push(line);
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project);
    const tokens: string[] = [];

    for (const change of [
      (claims: Record<string, unknown>) => ({ ...claims, environment: 'production' }),
      (claims: Record<string, unknown>) => ({ ...claims, repository_id: '1' }),
      (claims: Record<string, unknown>) => claims,
      (claims: Record<string, unknown>) => claims,
    ]) {
      const { token, response } = await exchange(project, jobId, change, { logSink: sink });
      tokens.push(token, ((await response.clone().json()) as { jobToken?: string }).jobToken ?? 'no-job-token');
    }
    const expired = await actionsToken(issuer, runClaimsOf(project), { issuedAt: 1_700_000_000 });
    await postExchange((await exchangeBodyOf(expired, jobId)).body, issuer.bindings, { logSink: sink });
    tokens.push(expired);

    expect(lines.some((line) => line.includes('oidc exchange refused'))).toBe(true);
    expect(lines.some((line) => line.includes('"claim":"environment"'))).toBe(true);
    const log = lines.join('\n');
    for (const token of tokens.filter((value) => value !== 'no-job-token')) {
      expect(log).not.toContain(token);
      // Each part on its own, too: a payload or signature logged apart is as good as the token.
      for (const part of token.split('.').filter((segment) => segment.length > 16)) {
        expect(log).not.toContain(part);
      }
    }
    const rows = await env.DB.prepare(
      `SELECT details AS text FROM audit_events WHERE target = ?1 UNION ALL SELECT payload FROM job_events WHERE job_id = ?1`,
    )
      .bind(jobId)
      .all<{ text: string }>();
    const stored = rows.results.map((row) => row.text).join('\n');
    for (const token of tokens.filter((value) => value !== 'no-job-token')) {
      expect(stored).not.toContain(token);
    }
  });
});

describe('rate limits, as for enrol', () => {
  it('limits exchanges per source address', async () => {
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project);
    const headers = { 'CF-Connecting-IP': '203.0.113.68' };
    // Unsigned guesses: they never count against the repository, only against the address.
    for (let attempt = 0; attempt < OIDC_EXCHANGE_RATE_LIMIT_PER_MINUTE; attempt += 1) {
      const response = await postExchange((await exchangeBodyOf('not-a-jwt', jobId)).body, issuer.bindings, { headers });
      expect(response.status).toBe(401);
    }
    const limited = (await exchange(project, jobId, undefined, { headers })).response;
    expect(limited.status).toBe(429);
    expect(await refusalOf(limited)).toMatchObject({ slug: 'rate-limited' });
    expect(limited.headers.get('Retry-After')).not.toBeNull();
    // Another address is judged on its own.
    expect((await exchange(project, jobId)).response.status).toBe(200);
  });

  it('limits exchanges per repository id, whatever the address', async () => {
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project);
    for (let attempt = 0; attempt < OIDC_EXCHANGE_RATE_LIMIT_PER_REPOSITORY_PER_MINUTE; attempt += 1) {
      const { response } = await exchange(project, jobId, (claims) => ({ ...claims, runner_environment: 'self-hosted' }));
      expect(response.status).toBe(401);
    }
    expect((await exchange(project, jobId)).response.status).toBe(429);
    // Another repository is judged on its own.
    const other = await seedActionsProject();
    expect((await exchange(other, await seedActionsJob(other))).response.status).toBe(200);
  });

  // #696: an IPv6 caller holds a whole /64, so the address limit counts the prefix.
  it('limits a whole IPv6 /64 as one address, and another /64 on its own', async () => {
    const outcome = await inOneRateWindow(async () => {
      const project = await seedActionsProject();
      const jobId = await seedActionsJob(project);
      const prefix = uniqueIpv6Prefix();
      const junk: number[] = [];
      for (let attempt = 1; attempt <= OIDC_EXCHANGE_RATE_LIMIT_PER_MINUTE; attempt += 1) {
        const headers = { 'CF-Connecting-IP': `${prefix}::${attempt.toString(16)}` };
        junk.push((await postExchange((await exchangeBodyOf('not-a-jwt', jobId)).body, issuer.bindings, { headers })).status);
      }
      const sameRange = (await exchange(project, jobId, undefined, { headers: { 'CF-Connecting-IP': `${prefix}:ffff:ffff:ffff:ffff` } })).response;
      const otherRange = (await exchange(project, jobId, undefined, { headers: { 'CF-Connecting-IP': `${uniqueIpv6Prefix()}::1` } })).response;
      return { junk, sameRange: await refusalOf(sameRange), otherRange: otherRange.status };
    });
    expect(outcome.junk).toEqual(new Array<number>(OIDC_EXCHANGE_RATE_LIMIT_PER_MINUTE).fill(401));
    expect(outcome.sameRange).toMatchObject({ status: 429, slug: 'rate-limited' });
    expect(outcome.otherRange).toBe(200);
  });

  it('counts an IPv4-mapped IPv6 address as the IPv4 address it carries', async () => {
    const outcome = await inOneRateWindow(async () => {
      const project = await seedActionsProject();
      const jobId = await seedActionsJob(project);
      const address = uniqueAddress();
      for (let attempt = 0; attempt < OIDC_EXCHANGE_RATE_LIMIT_PER_MINUTE; attempt += 1) {
        await postExchange((await exchangeBodyOf('not-a-jwt', jobId)).body, issuer.bindings, { headers: { 'CF-Connecting-IP': address } });
      }
      return (await exchange(project, jobId, undefined, { headers: { 'CF-Connecting-IP': `::ffff:${address}` } })).response.status;
    });
    expect(outcome).toBe(429);
  });

  it('counts a missing or malformed address in one named bucket, and logs it', async () => {
    const lines: string[] = [];
    const outcome = await inOneRateWindow(() =>
      withRateBucketAt('oidc:ip:unknown', 0, async () => {
        const project = await seedActionsProject();
        const jobId = await seedActionsJob(project);
        for (let attempt = 0; attempt < OIDC_EXCHANGE_RATE_LIMIT_PER_MINUTE; attempt += 1) {
          await postExchange((await exchangeBodyOf('not-a-jwt', jobId)).body, issuer.bindings, { headers: { 'CF-Connecting-IP': '' } });
        }
        const malformed = await exchange(project, jobId, undefined, {
          headers: { 'CF-Connecting-IP': 'not-an-address' },
          logSink: (line) => lines.push(line),
        });
        return malformed.response.status;
      }),
    );
    expect(outcome).toBe(429);
    expect(lines.some((line) => line.includes('runner door without a client address'))).toBe(true);
  });

  // #696: junk from rotating addresses has a bucket of its own, so it never spends the budget of a real exchange.
  it('answers a real exchange while junk is at its environment limit, and 429 to more junk', async () => {
    const outcome = await inOneRateWindow(async () => {
      const project = await seedActionsProject();
      const jobId = await seedActionsJob(project);
      return withRateBucketAt('oidc:unverified', OIDC_EXCHANGE_RATE_LIMIT_UNVERIFIED_PER_MINUTE, async () => {
        const junk = await postExchange((await exchangeBodyOf('not-a-jwt', jobId)).body, issuer.bindings);
        const invalid = await postExchange({ idToken: 1 }, issuer.bindings);
        const real = (await exchange(project, jobId)).response;
        return { junk: await refusalOf(junk), invalid: invalid.status, real: real.status, retryAfter: junk.headers.get('Retry-After') };
      });
    });
    expect(outcome.junk).toMatchObject({ status: 429, slug: 'rate-limited' });
    expect(Number(outcome.retryAfter)).toBeGreaterThan(0);
    expect(outcome.invalid).toBe(429);
    expect(outcome.real).toBe(200);
  });

  it('never counts junk in the bucket of real exchanges, nor a real exchange in the junk bucket', async () => {
    const counts = async () => ({ verified: await rateBucketCount('oidc:verified'), unverified: await rateBucketCount('oidc:unverified') });
    const outcome = await inOneRateWindow(async () => {
      const project = await seedActionsProject();
      const jobId = await seedActionsJob(project);
      const before = await counts();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await postExchange((await exchangeBodyOf('not-a-jwt', jobId)).body, issuer.bindings);
      }
      const afterJunk = await counts();
      const real = (await exchange(project, jobId)).response.status;
      const afterReal = await counts();
      return {
        real,
        junkDelta: { verified: afterJunk.verified - before.verified, unverified: afterJunk.unverified - before.unverified },
        realDelta: { verified: afterReal.verified - afterJunk.verified, unverified: afterReal.unverified - afterJunk.unverified },
      };
    });
    expect(outcome.real).toBe(200);
    expect(outcome.junkDelta).toEqual({ verified: 0, unverified: 3 });
    expect(outcome.realDelta).toEqual({ verified: 1, unverified: 0 });
  });

  // #729 security review: GitHub signs a token for any repository, so a signed token spends the verified budget only
  // once it is tied to the job's registered repository; an unknown job or a foreign repository is junk.
  it('answers a real exchange after a full minute of signed tokens for unknown jobs and foreign repositories', async () => {
    const counts = async () => ({ verified: await rateBucketCount('oidc:verified'), unverified: await rateBucketCount('oidc:unverified') });
    const outcome = await inOneRateWindow(async () => {
      const project = await seedActionsProject();
      const jobId = await seedActionsJob(project);
      return withRateBucketAt('oidc:unverified', 0, async () => {
        const before = await counts();
        const refusals = new Map<string, number>();
        for (let attempt = 0; attempt < OIDC_EXCHANGE_RATE_LIMIT_UNVERIFIED_PER_MINUTE; attempt += 1) {
          const { response } =
            attempt % 2 === 0
              ? await exchange(project, jobId, (claims) => ({ ...claims, repository_id: String(900000 + attempt) }))
              : await exchange(project, '01M6YSNJ0000000000000N0NE2');
          const refusal = await refusalOf(response);
          const key = `${String(refusal.status)}:${String(refusal.claim)}`;
          refusals.set(key, (refusals.get(key) ?? 0) + 1);
        }
        const full = await counts();
        const foreign = await refusalOf((await exchange(project, jobId, (claims) => ({ ...claims, repository_id: '424242' }))).response);
        const unknownJob = await refusalOf((await exchange(project, '01M6YSNJ0000000000000N0NE2')).response);
        const real = (await exchange(project, jobId)).response.status;
        const after = await counts();
        return {
          refusals: Object.fromEntries(refusals),
          floodDelta: { verified: full.verified - before.verified, unverified: full.unverified - before.unverified },
          foreign,
          unknownJob,
          real,
          realDelta: after.verified - full.verified,
        };
      });
    });
    const half = OIDC_EXCHANGE_RATE_LIMIT_UNVERIFIED_PER_MINUTE / 2;
    expect(outcome.refusals).toEqual({ '401:repository_id': half, '401:job_id': half });
    expect(outcome.floodDelta).toEqual({ verified: 0, unverified: OIDC_EXCHANGE_RATE_LIMIT_UNVERIFIED_PER_MINUTE });
    // Over the junk limit both answer alike, so the 429 tells nothing about which jobs or repositories exist.
    expect(outcome.foreign).toMatchObject({ status: 429, slug: 'rate-limited' });
    expect(outcome.unknownJob).toMatchObject({ status: 429, slug: 'rate-limited' });
    expect(outcome.real).toBe(200);
    expect(outcome.realDelta).toBe(1);
    // A few hundred signed requests: ~0.5 s locally, several seconds on a loaded CI runner (#736).
  }, 60_000);

  it('still floors real exchanges for the environment, and junk keeps its own answer then', async () => {
    const outcome = await inOneRateWindow(async () => {
      const project = await seedActionsProject();
      const jobId = await seedActionsJob(project);
      return withRateBucketAt('oidc:verified', OIDC_EXCHANGE_RATE_LIMIT_GLOBAL_PER_MINUTE, async () => {
        const real = (await exchange(project, jobId)).response;
        const junk = await postExchange((await exchangeBodyOf('not-a-jwt', jobId)).body, issuer.bindings);
        return { real: await refusalOf(real), junk: junk.status };
      });
    });
    expect(outcome.real).toMatchObject({ status: 429, slug: 'rate-limited' });
    expect(outcome.junk).toBe(401);
  });
});

describe('the ephemeral identity (threat model C4)', () => {
  async function exchanged(): Promise<{ project: ActionsProject; jobId: string; run: { id: string; privateKey: CryptoKey | KeyObject }; answer: OidcExchangeResponse }> {
    const project = await seedActionsProject();
    const jobId = await seedActionsJob(project);
    const { response, privateKey } = await exchange(project, jobId, undefined, { headers: { 'CF-IPCountry': 'US' } });
    const answer = (await response.json()) as OidcExchangeResponse;
    return { project, jobId, run: { id: answer.runner.id, privateKey }, answer };
  }

  it('is never marked suspect, from a new country or a second address', async () => {
    const { run } = await exchanged();
    for (const [ip, country] of [['198.51.100.1', 'DE'], ['198.51.100.2', 'NL'], ['198.51.100.3', 'IE']]) {
      const response = await sendAsRunner(run, 'GET', '/api/v1/runner/release', undefined, {
        headers: { 'CF-Connecting-IP': ip ?? '', 'CF-IPCountry': country ?? '' },
      });
      expect(response.status).toBe(200);
    }
    expect((await runnerRow(run.id))?.suspect_reason).toBeNull();
    // An enrolled runner still is (the rule is unchanged for the other backends).
    const enrolled = await enrolRunner(OWNER_ACCOUNT_ID);
    await sendAsRunner(enrolled, 'GET', '/api/v1/runner/release', undefined, { headers: { 'CF-Connecting-IP': '198.51.100.9', 'CF-IPCountry': 'US' } });
    await sendAsRunner(enrolled, 'GET', '/api/v1/runner/release', undefined, { headers: { 'CF-Connecting-IP': '198.51.100.10', 'CF-IPCountry': 'US' } });
    expect((await runnerRow(enrolled.id))?.suspect_reason).toBe('two-pollers');
  });

  // #682: the identity is never a pulling runner, even once its own job ended and before any sweep revoked it.
  it('never claims from the pull queue, with its job live or ended', async () => {
    const { project, jobId, run } = await exchanged();
    const pulled = await seedActionsJob(project, 'pull');
    const holding = await sendAsRunner(run, 'POST', '/api/v1/runner/jobs/claim', {});
    expect(await refusalOf(holding)).toMatchObject({ status: 403, slug: 'runner-isolation-ephemeral' });

    await env.DB.prepare(
      `UPDATE jobs SET state = 'cancelled', finished_at = ?2, token_hash = NULL, lease_until = NULL WHERE id = ?1`,
    ).bind(jobId, new Date().toISOString()).run();
    const idle = await sendAsRunner(run, 'POST', '/api/v1/runner/jobs/claim', {});
    expect(await refusalOf(idle)).toMatchObject({ status: 403, slug: 'runner-isolation-ephemeral' });
    expect(await jobRow(pulled)).toMatchObject({ state: 'queued', runner_id: null });
    // An enrolled runner of the project takes it (the queue itself is unchanged).
    const puller = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [project.slug] });
    expect((await sendAsRunner(puller, 'POST', '/api/v1/runner/jobs/claim', {})).status).toBe(200);
  });

  it('is revoked by the lease sweep once its job lapses, and the job is lost rather than requeued', async () => {
    const { jobId, run } = await exchanged();
    await env.DB.prepare(`UPDATE jobs SET lease_until = '2026-01-01T00:00:00.000Z' WHERE id = ?1`).bind(jobId).run();
    // The sweep runs at the next claim of any runner.
    const puller = await enrolRunner(OWNER_ACCOUNT_ID);
    await sendAsRunner(puller, 'POST', '/api/v1/runner/jobs/claim', {});
    expect((await runnerRow(run.id))?.revoked_at).not.toBeNull();
    expect(await jobRow(jobId)).toMatchObject({ state: 'lost', runner_id: null, token_hash: null });
    expect((await jobRow(jobId))?.actions_run_id).not.toBeNull();
  });

  it('is revoked by the sweep when its job ended some other way (a cancel)', async () => {
    const { jobId, run } = await exchanged();
    await env.DB.prepare(
      `UPDATE jobs SET state = 'cancelled', finished_at = ?2, token_hash = NULL, lease_until = NULL WHERE id = ?1`,
    ).bind(jobId, new Date().toISOString()).run();
    await sendAsRunner(await enrolRunner(OWNER_ACCOUNT_ID), 'POST', '/api/v1/runner/jobs/claim', {});
    expect((await runnerRow(run.id))?.revoked_at).not.toBeNull();
  });

  it('is listed as its run while live, and leaves the list once revoked, unlike an enrolled runner', async () => {
    const { jobId, run, answer } = await exchanged();
    const live = (await listRunners()).runners.find((runner) => runner.id === run.id);
    expect(live).toMatchObject({ isolation: 'actions-ephemeral', revokedAt: null });
    expect(live?.name).toMatch(/^actions:[0-9]+$/);

    await sendAsRunner(run, 'POST', `/api/v1/runner/jobs/${jobId}/finish`, { result: 'failed', summary: 'x' });
    expect((await listRunners()).runners.map((runner) => runner.id)).not.toContain(answer.runner.id);

    const enrolled = await enrolRunner(OWNER_ACCOUNT_ID);
    await env.DB.prepare(`UPDATE runners SET revoked_at = ?2 WHERE id = ?1`).bind(enrolled.id, new Date().toISOString()).run();
    expect((await listRunners()).runners.map((runner) => runner.id)).toContain(enrolled.id);
  });

  it('is never granted by an enrolment code', async () => {
    const { code } = await createEnrolmentCode(OWNER_ACCOUNT_ID);
    const key = await generateRunnerKey();
    const refused = await postEnrol({ ...enrolBodyOf(code, key.publicKeyJwk), isolation: 'actions-ephemeral' });
    expect(refused.status).toBe(422);
    expect(await refusalOf(refused)).toMatchObject({ slug: 'enrol-invalid' });
    // The same code still enrols one of the backends it can grant.
    expect((await postEnrol(enrolBodyOf(code, key.publicKeyJwk, { isolation: 'container' }))).status).toBe(201);
  });
});

describe('the issuer JWKS', () => {
  it.each(['{"keys": "nope"}', 'not json'])(
    'answers 503 oidc-issuer-unavailable, not a refusal of the token, when the key set is unreadable (%s)',
    async (jwks) => {
      const project = await seedActionsProject();
      const jobId = await seedActionsJob(project);
      const token = await actionsToken(issuer, runClaimsOf(project));
      const response = await postExchange((await exchangeBodyOf(token, jobId)).body, localEnv({ ACTIONS_OIDC_JWKS: jwks }));
      expect(await refusalOf(response)).toMatchObject({ status: 503, slug: 'oidc-issuer-unavailable' });
      expect(response.headers.get('Retry-After')).toBe('30');
      expect((await jobRow(jobId))?.state).toBe('queued');
    },
  );
});
