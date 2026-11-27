import { env } from 'cloudflare:test';
import {
  RUNNER_CHECK_DEADLINE_SECONDS,
  isClaimResponse,
  isRunnerCheckClaimResponse,
  isRunnerCheckDto,
  type ClaimResponse,
  type RunnerCheckDto,
} from '@shared/contracts';
import { newUlid } from '@worker/core';
import { accessEnv, uniqueTeamDomain } from '../testing/access-kit';
import {
  enqueueJob,
  enrolRunner,
  generateRunnerKey,
  sendAsRunner,
  type TestRunner,
} from '../testing/runner-kit';
import {
  seedAccountProject,
  seedMembership,
  seedSession,
  seedSessionUser,
  seedUser,
  sendAsSession,
  type SessionUser,
} from '../testing/session-kit';
import { jobActor, send, sendAsService, slugOf } from '../testing/tracker-kit';

// #1059 PR 1: runner checks (architect note §1–§3, security note S1–S12 and «Tests required before merge → PR 1»).

const CLAIM = '/api/v1/runner/jobs/claim';
const checksOf = (accountId: string, runnerId: string): string =>
  `/api/v1/accounts/${accountId}/runners/${runnerId}/checks`;
const finishOf = (checkId: string): string => `/api/v1/runner/checks/${checkId}/finish`;
const PASSED = { result: 'passed', claudeVersion: '2.1.3', durationMs: 840 } as const;
const FAILED = { result: 'failed', reason: 'credential-missing', durationMs: 120 } as const;

type Runner = Pick<TestRunner, 'id' | 'privateKey'>;

/** A runner of the owner's account that has polled once declaring `smoke`: online and declared. */
async function declaringRunner(
  owner: SessionUser,
  options: { projectScope?: 'all' } = {},
): Promise<TestRunner> {
  const runner = await enrolRunner(owner.account.id, { as: owner, ...options });
  const poll = await sendAsRunner(runner, 'POST', CLAIM, { checks: ['smoke'] });
  expect(poll.status).toBe(204);
  return runner;
}

/** A runner row written past the API: a backend, a hosted flag or an enrolment time the doors cannot give. */
async function insertRunner(
  accountId: string,
  row: {
    isolation?: string;
    hosted?: 0 | 1;
    enrolledAt?: string;
    capabilities?: Record<string, unknown>;
    lastSeenAt?: string | null;
  } = {},
): Promise<Runner> {
  const key = await generateRunnerKey();
  const id = newUlid();
  await env.DB.prepare(
    `INSERT INTO runners (id, account_id, name, public_key_jwk, capabilities, hosted, isolation, version, enrolled_at, last_seen_at)
     VALUES (?1, ?2, 'mac', ?3, ?4, ?5, ?6, '0.1.0', ?7, ?8)`,
  )
    .bind(
      id,
      accountId,
      JSON.stringify(key.publicKeyJwk),
      JSON.stringify(row.capabilities ?? { local: false, maxConcurrency: 1, checks: ['smoke'] }),
      row.hosted ?? 0,
      row.isolation ?? 'user',
      row.enrolledAt ?? new Date().toISOString(),
      row.lastSeenAt === undefined ? new Date().toISOString() : row.lastSeenAt,
    )
    .run();
  return { id, privateKey: key.privateKey };
}

async function start(
  owner: SessionUser,
  runnerId: string,
  body: unknown = { kind: 'smoke' },
  accountId = owner.account.id,
): Promise<Response> {
  return sendAsSession(owner, 'POST', checksOf(accountId, runnerId), body);
}

async function started(owner: SessionUser, runnerId: string): Promise<RunnerCheckDto> {
  const response = await start(owner, runnerId);
  expect(response.status).toBe(201);
  const body: unknown = await response.json();
  expect(isRunnerCheckDto(body)).toBe(true);
  return body as RunnerCheckDto;
}

async function read(owner: SessionUser, runnerId: string, checkId: string): Promise<Response> {
  return sendAsSession(owner, 'GET', `${checksOf(owner.account.id, runnerId)}/${checkId}`);
}

async function readCheck(owner: SessionUser, runnerId: string, checkId: string): Promise<RunnerCheckDto> {
  const response = await read(owner, runnerId, checkId);
  expect(response.status).toBe(200);
  return (await response.json()) as RunnerCheckDto;
}

async function claimDeclaring(runner: Runner): Promise<Response> {
  return sendAsRunner(runner, 'POST', CLAIM, { checks: ['smoke'] });
}

async function finish(runner: Runner, checkId: string, body: unknown = PASSED): Promise<Response> {
  return sendAsRunner(runner, 'POST', finishOf(checkId), body);
}

/** A check row written past the API, for a clock the test cannot wait for. */
async function insertCheck(
  accountId: string,
  runnerId: string,
  row: { state: 'queued' | 'running' | 'passed' | 'failed'; createdAt: string; pickedAt?: string | null },
): Promise<string> {
  const id = newUlid();
  const final = row.state === 'passed' || row.state === 'failed';
  await env.DB.prepare(
    `INSERT INTO runner_checks (id, account_id, runner_id, kind, requested_by, state, reason, claude_version, created_at, picked_at, finished_at)
     VALUES (?1, ?2, ?3, 'smoke', 'owner', ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      id,
      accountId,
      runnerId,
      row.state,
      row.state === 'failed' ? 'timeout' : null,
      row.state === 'passed' ? '2.1.3' : null,
      row.createdAt,
      row.pickedAt ?? (row.state === 'queued' ? null : row.createdAt),
      final ? row.createdAt : null,
    )
    .run();
  return id;
}

const ago = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString();

async function auditRows(
  kind: string,
  target: string,
): Promise<
  { actor_kind: string; actor: string; details: Record<string, unknown>; ip_country: string | null }[]
> {
  const { results } = await env.DB.prepare(
    `SELECT actor_kind, actor, details, ip_country FROM audit_events WHERE kind = ?1 AND target = ?2 ORDER BY id`,
  )
    .bind(kind, target)
    .all<{ actor_kind: string; actor: string; details: string; ip_country: string | null }>();
  return results.map((row) => ({ ...row, details: JSON.parse(row.details) as Record<string, unknown> }));
}

async function checkRow(id: string): Promise<{ state: string; reason: string | null } | null> {
  return env.DB.prepare(`SELECT state, reason FROM runner_checks WHERE id = ?1`)
    .bind(id)
    .first<{ state: string; reason: string | null }>();
}

describe('a runner check end to end (#1059)', () => {
  it('starts, is delivered as exactly {check: {id, kind, deadlineSeconds}}, finishes passed and reads back', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await declaringRunner(owner);
    const check = await started(owner, runner.id);
    expect(check).toMatchObject({ kind: 'smoke', state: 'queued', reason: null, claudeVersion: null });

    const claim = await claimDeclaring(runner);
    expect(claim.status).toBe(200);
    const answer: unknown = await claim.json();
    // S2: nothing beside the check, no job, token, scope or team config.
    expect(answer).toEqual({
      check: { id: check.id, kind: 'smoke', deadlineSeconds: RUNNER_CHECK_DEADLINE_SECONDS },
    });
    expect(isRunnerCheckClaimResponse(answer)).toBe(true);
    expect(isClaimResponse(answer)).toBe(true);
    expect((await readCheck(owner, runner.id, check.id)).state).toBe('running');

    const finished = await finish(runner, check.id);
    expect(finished.status).toBe(204);
    const passed = await readCheck(owner, runner.id, check.id);
    expect(isRunnerCheckDto(passed)).toBe(true);
    expect(Object.keys(passed).sort()).toEqual(
      ['claudeVersion', 'createdAt', 'finishedAt', 'id', 'kind', 'pickedAt', 'reason', 'state'].sort(),
    );
    expect(passed).toMatchObject({ state: 'passed', reason: null, claudeVersion: '2.1.3' });
    expect(passed.finishedAt).not.toBeNull();
    // A second finish of a final check is the uniform 404.
    const again = await finish(runner, check.id);
    expect([again.status, await slugOf(again)]).toEqual([404, 'runner-check-not-found']);
  });

  it('writes the requested, finished and expired audit rows with exact key sets and the actor from the identity (S7)', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await declaringRunner(owner);
    const check = await started(owner, runner.id);
    await claimDeclaring(runner);
    await sendAsRunner(runner, 'POST', finishOf(check.id), FAILED, { headers: { 'CF-IPCountry': 'DE' } });

    const [requested] = await auditRows('runner.check-requested', runner.id);
    expect(requested).toMatchObject({ actor_kind: 'user', actor: owner.userId });
    expect(requested?.details).toEqual({ checkId: check.id, kind: 'smoke' });
    const [finished] = await auditRows('runner.check-finished', runner.id);
    expect(finished).toMatchObject({ actor_kind: 'runner', actor: runner.id, ip_country: 'DE' });
    expect(finished?.details).toEqual({
      checkId: check.id,
      kind: 'smoke',
      result: 'failed',
      reason: 'credential-missing',
      claudeVersion: null,
    });

    const stale = await insertCheck(owner.account.id, runner.id, { state: 'queued', createdAt: ago(151) });
    expect((await readCheck(owner, runner.id, stale)).reason).toBe('not-picked-up');
    const [expired] = await auditRows('runner.check-expired', runner.id);
    expect(expired).toMatchObject({ actor_kind: 'system', actor: 'runner-checks', ip_country: null });
    expect(expired?.details).toEqual({ checkId: stale, reason: 'not-picked-up' });
  });
});

describe('isolation (T1, T2, T10; tests 2 and 3)', () => {
  it('answers another account’s owner on A’s runner and check as on ones that do not exist, and B’s runner never sees it', async () => {
    const ownerA = await seedSessionUser('owner');
    const ownerB = await seedSessionUser('owner');
    const runnerA = await declaringRunner(ownerA);
    const runnerB = await declaringRunner(ownerB);
    const check = await started(ownerA, runnerA.id);
    const missing = newUlid();

    // B's owner through B's account id and through A's.
    for (const accountId of [ownerB.account.id, ownerA.account.id]) {
      const foreign = await start(ownerB, runnerA.id, { kind: 'smoke' }, accountId);
      const unknown = await start(ownerB, missing, { kind: 'smoke' }, accountId);
      expect([403, 404]).toContain(foreign.status);
      expect([foreign.status, await slugOf(foreign)]).toEqual([unknown.status, await slugOf(unknown)]);
      const readForeign = await sendAsSession(
        ownerB,
        'GET',
        `${checksOf(accountId, runnerA.id)}/${check.id}`,
      );
      const readUnknown = await sendAsSession(ownerB, 'GET', `${checksOf(accountId, missing)}/${check.id}`);
      expect([readForeign.status, await slugOf(readForeign)]).toEqual([
        readUnknown.status,
        await slugOf(readUnknown),
      ]);
      expect([403, 404]).toContain(readForeign.status);
    }
    // B's runner: its claim never receives A's check, and its finish of A's check is 404.
    expect((await claimDeclaring(runnerB)).status).toBe(204);
    expect((await checkRow(check.id))?.state).toBe('queued');
    const foreignFinish = await finish(runnerB, check.id);
    const unknownFinish = await finish(runnerB, missing);
    expect([foreignFinish.status, await slugOf(foreignFinish)]).toEqual([
      unknownFinish.status,
      await slugOf(unknownFinish),
    ]);
    expect(foreignFinish.status).toBe(404);
    // A's runner still gets it.
    expect(isRunnerCheckClaimResponse(await (await claimDeclaring(runnerA)).json())).toBe(true);
  });

  it('never hands R1’s check to R2 of the same account, nor lets R2 finish or read it', async () => {
    const owner = await seedSessionUser('owner');
    const r1 = await declaringRunner(owner);
    const r2 = await declaringRunner(owner);
    const check = await started(owner, r1.id);
    expect((await claimDeclaring(r2)).status).toBe(204);
    expect(isRunnerCheckClaimResponse(await (await claimDeclaring(r1)).json())).toBe(true);
    const r2Finish = await finish(r2, check.id);
    expect([r2Finish.status, await slugOf(r2Finish)]).toEqual([404, 'runner-check-not-found']);
    expect((await checkRow(check.id))?.state).toBe('running');
    const throughR2 = await read(owner, r2.id, check.id);
    expect([throughR2.status, await slugOf(throughR2)]).toEqual([404, 'runner-check-not-found']);
  });
});

describe('roles (test 4)', () => {
  it('refuses a member with 403, a job with 403, the service identity with 404, and a cross-site POST with 403', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await declaringRunner(owner);
    const check = await started(owner, runner.id);
    const memberId = await seedUser('member');
    await seedMembership(owner.account.id, memberId, 'member');
    const member: SessionUser = {
      userId: memberId,
      cookie: await seedSession(memberId),
      account: owner.account,
    };
    const path = checksOf(owner.account.id, runner.id);

    const memberStart = await start(member, runner.id);
    expect([memberStart.status, await slugOf(memberStart)]).toEqual([403, 'account-owner-only']);
    const memberRead = await read(member, runner.id, check.id);
    expect([memberRead.status, await slugOf(memberRead)]).toEqual([403, 'account-owner-only']);
    for (const [method, target] of [
      ['POST', path],
      ['GET', `${path}/${check.id}`],
    ] as const) {
      const job = await send(method, target, method === 'GET' ? undefined : { kind: 'smoke' }, {
        job: jobActor('pm'),
      });
      expect(job.status).toBe(403);
      const service = await sendAsService(method, target, method === 'GET' ? undefined : { kind: 'smoke' });
      expect([service.status, await slugOf(service)]).toEqual([404, 'account-not-found']);
    }
    const crossSite = await sendAsSession(
      owner,
      'POST',
      path,
      { kind: 'smoke' },
      { headers: { 'Sec-Fetch-Site': 'cross-site' } },
    );
    expect([crossSite.status, await slugOf(crossSite)]).toEqual([403, 'csrf']);
    // None of them made a second check.
    expect(await auditRows('runner.check-requested', runner.id)).toHaveLength(1);
  });
});

describe('enqueue refusals in order (T10; test 5)', () => {
  const refusal = async (response: Response): Promise<[number, string | null]> => [
    response.status,
    await slugOf(response),
  ];

  it('answers 404 for a foreign runner before any state refusal, even a revoked one', async () => {
    const owner = await seedSessionUser('owner');
    const other = await seedSessionUser('owner');
    const revoked = await insertRunner(other.account.id);
    await env.DB.prepare(`UPDATE runners SET revoked_at = ?2 WHERE id = ?1`).bind(revoked.id, ago(5)).run();
    expect(await refusal(await start(owner, revoked.id))).toEqual([404, 'runner-not-found']);
  });

  it('revoked 409, hosted / actions-ephemeral / none-in-production 422, paused 409, offline 409, undeclared 409', async () => {
    const owner = await seedSessionUser('owner');
    const revoked = await insertRunner(owner.account.id);
    await env.DB.prepare(`UPDATE runners SET revoked_at = ?2 WHERE id = ?1`).bind(revoked.id, ago(5)).run();
    expect(await refusal(await start(owner, revoked.id))).toEqual([409, 'runner-revoked']);

    const hosted = await insertRunner(owner.account.id, { hosted: 1, isolation: 'container' });
    expect(await refusal(await start(owner, hosted.id))).toEqual([422, 'runner-check-unsupported']);
    const ephemeral = await insertRunner(owner.account.id, { isolation: 'actions-ephemeral' });
    expect(await refusal(await start(owner, ephemeral.id))).toEqual([422, 'runner-check-unsupported']);
    const none = await insertRunner(owner.account.id, { isolation: 'none' });
    const production = accessEnv(uniqueTeamDomain(), { ENVIRONMENT: 'production' });
    const noneInProduction = await sendAsSession(
      owner,
      'POST',
      checksOf(owner.account.id, none.id),
      { kind: 'smoke' },
      {},
      production,
    );
    expect(await refusal(noneInProduction)).toEqual([422, 'runner-check-unsupported']);

    const paused = await insertRunner(owner.account.id);
    await env.DB.prepare(`UPDATE runners SET paused_until = ?2, pause_reason = 'manual' WHERE id = ?1`)
      .bind(paused.id, new Date(Date.now() + 600_000).toISOString())
      .run();
    expect(await refusal(await start(owner, paused.id))).toEqual([409, 'runner-paused']);

    const offline = await insertRunner(owner.account.id, { lastSeenAt: ago(301) });
    expect(await refusal(await start(owner, offline.id))).toEqual([409, 'runner-offline']);
    const never = await insertRunner(owner.account.id, { lastSeenAt: null });
    expect(await refusal(await start(owner, never.id))).toEqual([409, 'runner-offline']);

    const outdated = await insertRunner(owner.account.id, {
      capabilities: { local: false, maxConcurrency: 1 },
    });
    expect(await refusal(await start(owner, outdated.id))).toEqual([409, 'runner-outdated']);
    // An old runner polls without the declaration: still outdated, and it never gets a check.
    const old = await enrolRunner(owner.account.id, { as: owner });
    expect((await sendAsRunner(old, 'POST', CLAIM, {})).status).toBe(204);
    expect(await refusal(await start(owner, old.id))).toEqual([409, 'runner-outdated']);

    // No refusal created a row or an audit row.
    const { results } = await env.DB.prepare(`SELECT id FROM runner_checks WHERE account_id = ?1`)
      .bind(owner.account.id)
      .all();
    expect(results).toEqual([]);
  });

  it('refuses a body that is not exactly {kind: smoke} with 422, naming the field only', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await declaringRunner(owner);
    const sentinel = `exec-${crypto.randomUUID()}`;
    for (const body of [{ kind: sentinel }, { kind: 'smoke', command: sentinel }, {}]) {
      const response = await start(owner, runner.id, body);
      expect(await refusal(response)).toEqual([422, 'runner-check-invalid']);
      expect(await response.text()).not.toContain(sentinel);
    }
  });
});

describe('the declaration on the claim (S1; test 6)', () => {
  const capabilitiesOf = async (runnerId: string): Promise<Record<string, unknown>> =>
    JSON.parse(
      (
        await env.DB.prepare(`SELECT capabilities FROM runners WHERE id = ?1`)
          .bind(runnerId)
          .first<{ capabilities: string }>()
      )?.capabilities ?? '{}',
    ) as Record<string, unknown>;

  it.each([[['exec']], [['smoke', 'smoke']], [['smoke', 'exec']], ['smoke'], [[1]]])(
    'refuses checks %j with 422 claim-invalid',
    async (checks) => {
      const owner = await seedSessionUser('owner');
      const runner = await enrolRunner(owner.account.id, { as: owner });
      const response = await sendAsRunner(runner, 'POST', CLAIM, { checks });
      expect([response.status, await slugOf(response)]).toEqual([422, 'claim-invalid']);
      expect((await capabilitiesOf(runner.id))['checks']).toBeUndefined();
    },
  );

  it('stores checks with json_set, leaving every other capability key alone, and writes nothing when unchanged', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await enrolRunner(owner.account.id, {
      as: owner,
      enrol: { capabilities: { local: true, maxConcurrency: 1, accessSources: ['api_key'] } },
    });
    const before = await capabilitiesOf(runner.id);
    expect((await sendAsRunner(runner, 'POST', CLAIM, { checks: ['smoke'] })).status).toBe(204);
    expect(await capabilitiesOf(runner.id)).toEqual({ ...before, checks: ['smoke'] });

    const raw = async (): Promise<string | undefined> =>
      (
        await env.DB.prepare(`SELECT capabilities FROM runners WHERE id = ?1`)
          .bind(runner.id)
          .first<{ capabilities: string }>()
      )?.capabilities;
    const stored = await raw();
    const lines: string[] = [];
    await sendAsRunner(runner, 'POST', CLAIM, { checks: ['smoke'] }, { logSink: (line) => lines.push(line) });
    expect(await raw()).toBe(stored);
    expect(lines.some((line) => line.includes('runner declared checks'))).toBe(false);
    // A poll without the key leaves the stored declaration; `[]` replaces it.
    await sendAsRunner(runner, 'POST', CLAIM, {});
    expect((await capabilitiesOf(runner.id))['checks']).toEqual(['smoke']);
    await sendAsRunner(runner, 'POST', CLAIM, { checks: [] });
    expect(await capabilitiesOf(runner.id)).toEqual({ ...before, checks: [] });
  });

  it('ignores a hosted identity’s declaration (an actions-ephemeral one is refused before the body)', async () => {
    const owner = await seedSessionUser('owner');
    const hosted = await insertRunner(owner.account.id, {
      hosted: 1,
      isolation: 'container',
      capabilities: { local: false, maxConcurrency: 1 },
    });
    await sendAsRunner(hosted, 'POST', CLAIM, { checks: ['smoke'] });
    expect((await capabilitiesOf(hosted.id))['checks']).toBeUndefined();
    const ephemeral = await insertRunner(owner.account.id, {
      isolation: 'actions-ephemeral',
      capabilities: { local: false, maxConcurrency: 1 },
    });
    const refused = await sendAsRunner(ephemeral, 'POST', CLAIM, { checks: ['smoke'] });
    expect(refused.status).toBe(403);
    expect((await capabilitiesOf(ephemeral.id))['checks']).toBeUndefined();
  });

  it('delivers nothing to a poll without checks, though the stored capability says smoke (S1)', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await declaringRunner(owner);
    const check = await started(owner, runner.id);
    for (const body of [{}, { checks: [] }]) {
      const poll = await sendAsRunner(runner, 'POST', CLAIM, body);
      expect(poll.status).toBe(204);
    }
    expect((await checkRow(check.id))?.state).toBe('queued');
  });

  // Open point N8: the wizard starts the check as soon as it sees the runner online; a runner that reads as online
  // after a declaring poll must already be declared, so the automatic start never meets a false `runner-outdated`.
  it('stores the declaration no later than the sighting that marks the runner online (N8)', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await insertRunner(owner.account.id, {
      capabilities: { local: false, maxConcurrency: 1 },
      lastSeenAt: null,
    });
    const order: string[] = [];
    const statement = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((query: string) => {
      if (query.includes(`'$.checks'`)) {
        order.push('declaration');
      }
      if (query.includes('SET last_seen_at')) {
        order.push('sighting');
      }
      return statement(query);
    });
    try {
      expect((await claimDeclaring(runner)).status).toBe(204);
    } finally {
      spy.mockRestore();
    }
    expect(order).toEqual(['declaration', 'sighting']);
    // Online from that poll on, and declared: the wizard's start is admitted.
    expect((await start(owner, runner.id)).status).toBe(201);
  });

  it('still records the sighting of a claim that is refused or invalid', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await insertRunner(owner.account.id, { lastSeenAt: null });
    expect((await sendAsRunner(runner, 'POST', CLAIM, { checks: 'smoke' })).status).toBe(422);
    const row = await env.DB.prepare(`SELECT last_seen_at FROM runners WHERE id = ?1`)
      .bind(runner.id)
      .first<{ last_seen_at: string | null }>();
    expect(row?.last_seen_at).not.toBeNull();
  });
});

describe('a check leaves the job pipeline untouched (S2; test 7)', () => {
  const snapshot = async (accountId: string, slug: string): Promise<string> => {
    const tables = await Promise.all([
      env.DB.prepare(`SELECT * FROM jobs WHERE project_slug = ?1 ORDER BY id`).bind(slug).all(),
      env.DB.prepare(
        `SELECT e.* FROM job_events e JOIN jobs j ON j.id = e.job_id WHERE j.project_slug = ?1 ORDER BY e.id`,
      )
        .bind(slug)
        .all(),
      env.DB.prepare(`SELECT * FROM team_state WHERE project_slug = ?1`).bind(slug).all(),
      env.DB.prepare(`SELECT * FROM project_spend WHERE project_slug = ?1`).bind(slug).all(),
      env.DB.prepare(`SELECT * FROM jobs WHERE account_id = ?1 AND token_hash IS NOT NULL`)
        .bind(accountId)
        .all(),
    ]);
    return JSON.stringify(tables.map((table) => table.results));
  };

  it.each([
    ['passed', PASSED],
    ['failed', FAILED],
  ] as const)(
    'keeps jobs, job_events, team_state, spend and job tokens byte-identical through a %s check; the next poll claims the job',
    async (_result, body) => {
      const owner = await seedSessionUser('owner');
      const project = await seedAccountProject(owner.account, { tracker: 'console' });
      const runner = await declaringRunner(owner, { projectScope: 'all' });
      const jobId = await enqueueJob(project.slug, {}, owner);
      const before = await snapshot(owner.account.id, project.slug);

      const check = await started(owner, runner.id);
      const claim = await claimDeclaring(runner);
      const answer = (await claim.json()) as Record<string, unknown>;
      expect(Object.keys(answer)).toEqual(['check']);
      expect(answer).not.toHaveProperty('job');
      expect(answer).not.toHaveProperty('jobToken');
      expect(answer).not.toHaveProperty('scope');
      expect(answer).not.toHaveProperty('teamConfig');
      expect((await finish(runner, check.id, body)).status).toBe(204);
      expect(await snapshot(owner.account.id, project.slug)).toBe(before);

      const next = await claimDeclaring(runner);
      expect(next.status).toBe(200);
      const job: unknown = await next.json();
      expect(isClaimResponse(job)).toBe(true);
      expect((job as ClaimResponse).job.id).toBe(jobId);
    },
  );
});

describe('finish validation (S5; test 8)', () => {
  async function running(): Promise<{ owner: SessionUser; runner: TestRunner; checkId: string }> {
    const owner = await seedSessionUser('owner');
    const runner = await declaringRunner(owner);
    const check = await started(owner, runner.id);
    expect((await claimDeclaring(runner)).status).toBe(200);
    return { owner, runner, checkId: check.id };
  }

  it('refuses every malformed body with 422 naming the field, never echoing the value, and the check stays running', async () => {
    const { runner, checkId } = await running();
    const sentinel = `S${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ ...PASSED, [sentinel]: 1 }, 'body'],
      [{ result: 'failed', reason: 'lost', durationMs: 1, note: sentinel }, 'body'],
      [{ result: 'failed', reason: 'lost', durationMs: 1 }, 'reason'],
      [{ result: 'failed', reason: 'runner-revoked', durationMs: 1 }, 'reason'],
      [{ result: 'failed', reason: 'rate-limited', durationMs: 1 }, 'reason'],
      [{ result: 'failed', reason: 'not-picked-up', durationMs: 1 }, 'reason'],
      [{ result: 'failed', reason: sentinel, durationMs: 1 }, 'reason'],
      [{ result: 'passed', durationMs: 1 }, 'claudeVersion'],
      [{ result: 'failed', reason: 'timeout', claudeVersion: '2.1.3', durationMs: 1 }, 'claudeVersion'],
      [{ result: 'passed', reason: 'timeout', claudeVersion: '2.1.3', durationMs: 1 }, 'reason'],
      [{ ...PASSED, claudeVersion: `<img src=x>${sentinel}` }, 'claudeVersion'],
      [{ ...PASSED, claudeVersion: `2.1.3\n${sentinel}` }, 'claudeVersion'],
      [{ ...PASSED, claudeVersion: `2.1.3-${'a'.repeat(59)}` }, 'claudeVersion'],
      [{ ...PASSED, claudeVersion: `2.1.3-${sentinel}é` }, 'claudeVersion'],
      [{ ...PASSED, claudeVersion: `2.1.3 ${sentinel}` }, 'claudeVersion'],
      [{ ...PASSED, durationMs: -1 }, 'durationMs'],
      [{ ...PASSED, durationMs: 60001 }, 'durationMs'],
      [{ ...PASSED, durationMs: 1.5 }, 'durationMs'],
      [{ ...PASSED, result: sentinel }, 'result'],
    ];
    for (const [body, field] of cases) {
      const response = await finish(runner, checkId, body);
      const text = await response.text();
      expect([response.status, (JSON.parse(text) as { field?: string }).field], JSON.stringify(body)).toEqual(
        [422, field],
      );
      expect(text).not.toContain(sentinel);
      expect(text).not.toContain('<img');
    }
    expect((await checkRow(checkId))?.state).toBe('running');
    expect(await auditRows('runner.check-finished', runner.id)).toEqual([]);
  });

  it('answers a body over the limit with 413', async () => {
    const { runner, checkId } = await running();
    const response = await finish(runner, checkId, JSON.stringify({ ...PASSED, pad: 'x'.repeat(70_000) }));
    expect(response.status).toBe(413);
    expect((await checkRow(checkId))?.state).toBe('running');
  });

  it('answers 404 to a finish of a queued check and to a malformed id', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await declaringRunner(owner);
    const check = await started(owner, runner.id);
    const queued = await finish(runner, check.id);
    expect([queued.status, await slugOf(queued)]).toEqual([404, 'runner-check-not-found']);
    expect((await checkRow(check.id))?.state).toBe('queued');
    expect((await finish(runner, 'not-a-ulid')).status).toBe(404);
  });

  it('answers 404 to a finish 91 s after the pick-up, and the check becomes lost', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await declaringRunner(owner);
    const late = await insertCheck(owner.account.id, runner.id, {
      state: 'running',
      createdAt: ago(120),
      pickedAt: ago(91),
    });
    const response = await finish(runner, late);
    expect([response.status, await slugOf(response)]).toEqual([404, 'runner-check-not-found']);
    expect(await checkRow(late)).toEqual({ state: 'failed', reason: 'lost' });
    expect(await auditRows('runner.check-finished', runner.id)).toEqual([]);
  });
});

describe('idempotent enqueue and the race (S12, T8; test 9)', () => {
  it('answers a second POST with 200 and the same check, creating and auditing nothing', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await declaringRunner(owner);
    const first = await started(owner, runner.id);
    const again = await start(owner, runner.id);
    expect(again.status).toBe(200);
    expect(((await again.json()) as RunnerCheckDto).id).toBe(first.id);
    // While it runs, too.
    await claimDeclaring(runner);
    const running = await start(owner, runner.id);
    expect([running.status, ((await running.json()) as RunnerCheckDto).id]).toEqual([200, first.id]);
    expect(await auditRows('runner.check-requested', runner.id)).toHaveLength(1);
  });

  it('converges two concurrent POSTs on one row, never a 500', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await declaringRunner(owner);
    const responses = await Promise.all([
      start(owner, runner.id),
      start(owner, runner.id),
      start(owner, runner.id),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 201]);
    const ids = await Promise.all(
      responses.map(async (response) => ((await response.json()) as RunnerCheckDto).id),
    );
    expect(new Set(ids).size).toBe(1);
    const { results } = await env.DB.prepare(`SELECT id FROM runner_checks WHERE runner_id = ?1`)
      .bind(runner.id)
      .all();
    expect(results).toHaveLength(1);
  });
});

describe('the hourly caps (S12, T8; test 10)', () => {
  async function cycle(owner: SessionUser, runner: TestRunner): Promise<Response> {
    const response = await start(owner, runner.id);
    if (response.status === 201) {
      const check = (await response.json()) as RunnerCheckDto;
      await claimDeclaring(runner);
      expect((await finish(runner, check.id)).status).toBe(204);
    }
    return response;
  }

  it('answers the 11th check of a runner in an hour with 429 and Retry-After, counting replays never', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await declaringRunner(owner);
    for (let index = 0; index < 10; index += 1) {
      const response = await start(owner, runner.id);
      expect(response.status).toBe(201);
      // A replay of the live check: 200, not counted.
      expect((await start(owner, runner.id)).status).toBe(200);
      const check = (await response.json()) as RunnerCheckDto;
      await claimDeclaring(runner);
      expect((await finish(runner, check.id)).status).toBe(204);
    }
    const lines: string[] = [];
    const limited = await sendAsSession(
      owner,
      'POST',
      checksOf(owner.account.id, runner.id),
      { kind: 'smoke' },
      {
        logSink: (line) => lines.push(line),
      },
    );
    expect([limited.status, await slugOf(limited)]).toEqual([429, 'rate-limited']);
    const retryAfter = Number(limited.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(3000);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect(lines.some((line) => line.includes('"level":"warn"') && line.includes('rate-limited'))).toBe(true);
    // Not audited: the ten created checks, nothing for the refusal.
    expect(await auditRows('runner.check-requested', runner.id)).toHaveLength(10);
  });

  it('answers the 31st check of an account in an hour with 429, a fresh runner included', async () => {
    const owner = await seedSessionUser('owner');
    const runners = await Promise.all([
      declaringRunner(owner),
      declaringRunner(owner),
      declaringRunner(owner),
    ]);
    // Created rows of the last hour: 10 + 10 + 9, written past the API.
    for (const [index, runner] of runners.entries()) {
      for (let count = 0; count < (index === 2 ? 9 : 10); count += 1) {
        await insertCheck(owner.account.id, runner.id, { state: 'passed', createdAt: ago(600 + count) });
      }
    }
    expect((await cycle(owner, runners[2] as TestRunner)).status).toBe(201);
    const fresh = await declaringRunner(owner);
    const limited = await start(owner, fresh.id);
    expect([limited.status, await slugOf(limited)]).toEqual([429, 'rate-limited']);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    // Rows older than the hour do not count.
    const elsewhere = await seedSessionUser('owner');
    const quiet = await declaringRunner(elsewhere);
    for (let count = 0; count < 12; count += 1) {
      await insertCheck(elsewhere.account.id, quiet.id, { state: 'passed', createdAt: ago(3700 + count) });
    }
    expect((await start(elsewhere, quiet.id)).status).toBe(201);
  });
});

describe('lazy expiry, revoke and pause (test 11)', () => {
  it('turns a check queued past 150 s into not-picked-up on GET, and never delivers it', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await declaringRunner(owner);
    const stale = await insertCheck(owner.account.id, runner.id, { state: 'queued', createdAt: ago(151) });
    const fresh = await insertCheck(owner.account.id, (await declaringRunner(owner)).id, {
      state: 'queued',
      createdAt: ago(149),
    });
    // The pick-up refuses it even before a sweep ran.
    expect((await claimDeclaring(runner)).status).toBe(204);
    expect(await readCheck(owner, runner.id, stale)).toMatchObject({
      state: 'failed',
      reason: 'not-picked-up',
    });
    expect(await checkRow(fresh)).toEqual({ state: 'queued', reason: null });
  });

  it('turns a check running past 90 s into lost on POST, then starts a fresh one', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await declaringRunner(owner);
    const lost = await insertCheck(owner.account.id, runner.id, {
      state: 'running',
      createdAt: ago(100),
      pickedAt: ago(91),
    });
    const response = await start(owner, runner.id);
    expect(response.status).toBe(201);
    expect(((await response.json()) as RunnerCheckDto).id).not.toBe(lost);
    expect(await checkRow(lost)).toEqual({ state: 'failed', reason: 'lost' });
    const [expired] = await auditRows('runner.check-expired', runner.id);
    expect(expired?.details).toEqual({ checkId: lost, reason: 'lost' });
  });

  it('fails the live check with runner-revoked in the revoke’s batch, audited', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await declaringRunner(owner);
    const check = await started(owner, runner.id);
    const revoke = await sendAsSession(
      owner,
      'POST',
      `/api/v1/accounts/${owner.account.id}/runners/${runner.id}/revoke`,
      {},
    );
    expect(revoke.status).toBe(200);
    expect(await readCheck(owner, runner.id, check.id)).toMatchObject({
      state: 'failed',
      reason: 'runner-revoked',
    });
    const [expired] = await auditRows('runner.check-expired', runner.id);
    expect(expired).toMatchObject({
      actor_kind: 'system',
      details: { checkId: check.id, reason: 'runner-revoked' },
    });
  });

  it('delivers nothing to a paused runner, then delivers once the pause is lifted', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await declaringRunner(owner);
    const check = await started(owner, runner.id);
    await env.DB.prepare(`UPDATE runners SET paused_until = ?2, pause_reason = 'usage-limit' WHERE id = ?1`)
      .bind(runner.id, new Date(Date.now() + 600_000).toISOString())
      .run();
    expect((await claimDeclaring(runner)).status).toBe(204);
    expect((await checkRow(check.id))?.state).toBe('queued');
    await env.DB.prepare(`UPDATE runners SET paused_until = NULL, pause_reason = NULL WHERE id = ?1`)
      .bind(runner.id)
      .run();
    expect((await claimDeclaring(runner)).status).toBe(200);
  });
});

describe('the idle claim’s Retry-After (T9; test 14)', () => {
  it('is 10 for a runner enrolled less than 15 minutes ago and 60 otherwise, by the server’s enrolled_at', async () => {
    const owner = await seedSessionUser('owner');
    const fresh = await insertRunner(owner.account.id, { enrolledAt: ago(14 * 60) });
    const settled = await insertRunner(owner.account.id, { enrolledAt: ago(16 * 60) });
    const hosted = await insertRunner(owner.account.id, {
      hosted: 1,
      isolation: 'container',
      enrolledAt: ago(60),
    });
    const retryAfter = async (runner: Runner): Promise<[number, string | null]> => {
      const response = await sendAsRunner(runner, 'POST', CLAIM, {});
      return [response.status, response.headers.get('Retry-After')];
    };
    expect(await retryAfter(fresh)).toEqual([204, '10']);
    expect(await retryAfter(settled)).toEqual([204, '60']);
    expect(await retryAfter(hosted)).toEqual([204, '60']);
  });
});

describe('GET …/checks/:check', () => {
  it('answers 404 for a malformed or unknown check id', async () => {
    const owner = await seedSessionUser('owner');
    const runner = await declaringRunner(owner);
    for (const id of ['nope', newUlid()]) {
      const response = await read(owner, runner.id, id);
      expect([response.status, await slugOf(response)]).toEqual([404, 'runner-check-not-found']);
    }
  });
});
