import { env } from 'cloudflare:test';
import { afterEach, vi } from 'vitest';
import {
  ENROLMENT_INTENTS_LIVE_MAX,
  ENROLMENT_INTENTS_PER_HOUR,
  ENROLMENT_INTENT_POLL_SECONDS,
  isEnrolmentIntentCreatedDto,
  isEnrolmentIntentDto,
  isStartEnrolmentResponse,
  runnerAudienceOf,
  runnerKeyFingerprintOf,
  type EnrolRunnerResponse,
  type EnrolmentIntentCreatedDto,
  type EnrolmentIntentDto,
  type RunnerSelfDto,
  type StartEnrolmentResponse,
} from '@shared/contracts';
import { ENROLMENT_CODE_PREFIX, ENROLMENT_POLL_TOKEN_PREFIX } from '@shared/redaction';
import { newUlid, sha256Hex } from '@worker/core';
import { EnrolmentIntentsRepo, type NewAuditEvent } from '@worker/db';
import { accessEnv, uniqueTeamDomain } from '../testing/access-kit';
import { localEnv } from '../testing/github-kit';
import {
  bindIntent,
  createEnrolmentIntent,
  enrolBodyOf,
  generateRunnerKey,
  inOneRateWindow,
  postEnrol,
  postEnrolDoor,
  resetPollClock,
  sendAsRunner,
  startBodyOf,
  withRateBucketAt,
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
import { slugOf } from '../testing/tracker-kit';
import { ENROL_POLL_RATE_LIMIT_PER_MINUTE } from './enrolment-intents';
import { ENROL_RATE_LIMIT_GLOBAL_PER_MINUTE, ENROL_RATE_LIMIT_PER_MINUTE, ENROL_RATE_LIMIT_UNVERIFIED_PER_MINUTE } from './runner';

// #634 PR 3 (architect note section 2; threat model C4 R-INT-1…7): enrolment intents. The owner's wizard makes a
// request, a runner binds its key (first bind wins), the owner approves the fingerprint they were shown, and the
// runner collects its enrolment with a poll token only it holds. Every case works in an account of its own: the cap
// of open intents is per account, and a file's cases share D1.

const UNKNOWN_INTENT = '01M6YSNJ0000000000000N0PE1';
const intentsPath = (accountId: string): string => `/api/v1/accounts/${accountId}/runners/enrolment-intents`;
const intentPath = (accountId: string, intentId: string, action = ''): string =>
  `${intentsPath(accountId)}/${intentId}${action === '' ? '' : `/${action}`}`;

interface AuditRow {
  kind: string;
  actor_kind: string;
  actor: string;
  target: string | null;
  details: string;
  ip_country: string | null;
}

async function auditOf(accountId: string, kind: string): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT kind, actor_kind, actor, target, details, ip_country FROM audit_events WHERE account_id = ?1 AND kind = ?2 ORDER BY id`,
  )
    .bind(accountId, kind)
    .all<AuditRow>();
  return results;
}

async function intentRow(intentId: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(`SELECT * FROM runner_enrolment_requests WHERE id = ?1`).bind(intentId).first<Record<string, unknown>>();
}

async function runnersOf(accountId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM runners WHERE account_id = ?1 ORDER BY enrolled_at, id`)
    .bind(accountId)
    .all<Record<string, unknown>>();
  return results;
}

const getIntent = async (owner: SessionUser, intentId: string): Promise<EnrolmentIntentDto> =>
  (await (await sendAsSession(owner, 'GET', intentPath(owner.account.id, intentId))).json()) as EnrolmentIntentDto;

const approve = (owner: SessionUser, intentId: string, fingerprint: string, extra: Parameters<typeof sendAsSession>[4] = {}) =>
  sendAsSession(owner, 'POST', intentPath(owner.account.id, intentId, 'approve'), { fingerprint }, extra);

const poll = (intentId: string, pollToken: string, request: Parameters<typeof postEnrolDoor>[2] = {}) =>
  postEnrolDoor('poll', { intentId, pollToken }, request);

/** A problem body without the request's own id, so two refusals can be compared member for member. */
async function refusalOf(response: Response): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { status: response.status, ...((await response.clone().json()) as Record<string, unknown>) };
  delete body['instance'];
  return body;
}

const seedAudit = (accountId: string, at: string): NewAuditEvent => ({
  accountId,
  at,
  actorKind: 'user',
  actor: 'seed',
  kind: 'enrolment-intent.created',
  target: null,
});

/** An intent written with its own clock: rows never change their times (0037), so an old one is seeded as such. */
async function seedIntentAt(owner: SessionUser, createdAt: Date, expiresAt: Date): Promise<string> {
  const id = newUlid(createdAt.getTime());
  const outcome = await new EnrolmentIntentsRepo(env.DB).create(
    {
      id,
      accountId: owner.account.id,
      createdBy: owner.userId,
      name: 'old',
      projectScope: 'all',
      allowedProjects: [],
      isolation: 'user',
      at: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
    { liveMax: 1000, perHour: 1000 },
    seedAudit(owner.account.id, createdAt.toISOString()),
  );
  expect(outcome).toBe('ok');
  return id;
}

/** Binds `id` at `at` through the repo, as `start` does; the poll token it would have returned. */
async function seedBindAt(owner: SessionUser, id: string, at: Date): Promise<{ pollToken: string; fingerprint: string }> {
  const key = await generateRunnerKey();
  const pollToken = `${ENROLMENT_POLL_TOKEN_PREFIX}${crypto.randomUUID().replace(/-/g, '').padEnd(43, 'A').slice(0, 43)}`;
  const fingerprint = await runnerKeyFingerprintOf(key.publicKeyJwk);
  const bound = await new EnrolmentIntentsRepo(env.DB).bind(
    id,
    'user',
    {
      publicKeyX: key.publicKeyJwk.x,
      host: { os: 'darwin', arch: 'arm64', hostname: 'mac.local' },
      capabilities: { local: true, maxConcurrency: 1 },
      version: '0.1.0',
      fingerprint,
      pollTokenHash: await sha256Hex(pollToken),
      at: at.toISOString(),
      country: null,
    },
    { ...seedAudit(owner.account.id, at.toISOString()), kind: 'enrolment-intent.bound', target: id },
  );
  expect(bound).toBe(true);
  return { pollToken, fingerprint };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the owner’s enrolment intents', () => {
  it('creates an intent with the command, defaults the scope to all, and audits it', async () => {
    const owner = await seedSessionUser('owner');
    const response = await sendAsSession(owner, 'POST', intentsPath(owner.account.id), { name: ' Mac mini ', isolation: 'user' });
    expect(response.status).toBe(201);
    const body = (await response.json()) as EnrolmentIntentCreatedDto;
    expect(isEnrolmentIntentCreatedDto(body)).toBe(true);
    expect(Object.keys(body).sort()).toEqual(['command', 'expiresAt', 'intentId']);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);

    expect(await intentRow(body.intentId)).toMatchObject({
      account_id: owner.account.id,
      name: 'Mac mini',
      project_scope: 'all',
      allowed_projects: '[]',
      isolation: 'user',
      created_by: owner.userId,
      state: 'pending',
      public_key: null,
      poll_token_hash: null,
      runner_id: null,
    });
    const [audit] = await auditOf(owner.account.id, 'enrolment-intent.created');
    expect(audit).toMatchObject({ actor_kind: 'user', actor: owner.userId, target: body.intentId });
    expect(JSON.parse(audit?.details ?? '{}')).toEqual({
      name: 'Mac mini',
      projectScope: 'all',
      allowedProjects: [],
      isolation: 'user',
      expiresAt: body.expiresAt,
    });

    const dto = await getIntent(owner, body.intentId);
    expect(isEnrolmentIntentDto(dto)).toBe(true);
    expect(dto).toEqual({
      id: body.intentId,
      state: 'pending',
      name: 'Mac mini',
      projectScope: 'all',
      allowedProjects: [],
      isolation: 'user',
      createdAt: dto.createdAt,
      expiresAt: body.expiresAt,
      host: null,
      version: null,
      fingerprint: null,
      boundAt: null,
      boundCountry: null,
      runnerId: null,
    });
  });

  it('builds the command from the configured origin, never from the request’s host', async () => {
    const owner = await seedSessionUser('owner');
    const create = (bindings: ReturnType<typeof accessEnv>, origin?: string) =>
      sendAsSession(owner, 'POST', intentsPath(owner.account.id), { name: 'x', isolation: 'user' }, origin === undefined ? {} : { origin }, bindings);

    const configured = (await (
      await create(accessEnv(uniqueTeamDomain(), { CONSOLE_PUBLIC_ORIGIN: 'https://console.example' }), 'https://evil.example')
    ).json()) as EnrolmentIntentCreatedDto;
    expect(configured.command).toBe(`team-console-runner setup --url https://console.example --enrolment ${configured.intentId}`);

    // No origin configured on a deployed environment: no command, rather than one that names whatever host was asked.
    const unconfigured = (await (await create(accessEnv(uniqueTeamDomain(), { CONSOLE_PUBLIC_ORIGIN: undefined }), 'https://evil.example')).json()) as EnrolmentIntentCreatedDto;
    expect(unconfigured.command).toBeNull();

    // A configured origin that is not safe to paste into a terminal is no command either.
    const unsafe = (await (await create(accessEnv(uniqueTeamDomain(), { CONSOLE_PUBLIC_ORIGIN: 'https://x.example; rm -rf ~' }))).json()) as EnrolmentIntentCreatedDto;
    expect(unsafe.command).toBeNull();
  });

  it('names the request’s own origin on a local environment only, whatever var the stack inherited', async () => {
    const owner = await seedSessionUser('owner');
    const response = await sendAsSession(
      owner,
      'POST',
      intentsPath(owner.account.id),
      { name: 'x', isolation: 'user' },
      {},
      localEnv({ AUTH_MODE: undefined, CONSOLE_PUBLIC_ORIGIN: 'https://team-console-dev.example' }),
    );
    const body = (await response.json()) as EnrolmentIntentCreatedDto;
    expect(body.command).toBe(`team-console-runner setup --url http://api.test --enrolment ${body.intentId}`);
  });

  it.each([
    ['a missing name', { isolation: 'user' }, 'name'],
    ['a blank name', { name: '   ', isolation: 'user' }, 'name'],
    ['a missing backend', { name: 'x' }, 'isolation'],
    ['the Actions backend', { name: 'x', isolation: 'actions-ephemeral' }, 'isolation'],
    ['a list beside all', { name: 'x', isolation: 'user', projectScope: 'all', allowedProjects: ['team-console'] }, 'allowedProjects'],
    ['a list with no scope', { name: 'x', isolation: 'user', allowedProjects: ['team-console'] }, 'allowedProjects'],
    ['an unknown scope', { name: 'x', isolation: 'user', projectScope: 'everything', allowedProjects: [] }, 'projectScope'],
    ['a credential member', { name: 'x', isolation: 'user', credential: 'setup-token' }, 'body'],
    ['a hosted member', { name: 'x', isolation: 'user', hosted: true }, 'body'],
  ])('refuses %s with 422 and the field', async (_, body, field) => {
    const owner = await seedSessionUser('owner');
    const response = await sendAsSession(owner, 'POST', intentsPath(owner.account.id), body);
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('enrolment-intent-invalid');
    expect(((await response.json()) as { field: string }).field).toBe(field);
  });

  it('takes selected with the account’s own active projects only', async () => {
    const owner = await seedSessionUser('owner');
    const other = await seedSessionUser('owner');
    const mine = await seedAccountProject(owner.account);
    const theirs = await seedAccountProject(other.account);
    const foreign = await sendAsSession(owner, 'POST', intentsPath(owner.account.id), {
      name: 'x',
      isolation: 'user',
      projectScope: 'selected',
      allowedProjects: [mine.slug, theirs.slug],
    });
    expect(foreign.status).toBe(422);
    expect(await slugOf(foreign)).toBe('allowed-projects-invalid');
    expect(await foreign.text()).not.toContain(theirs.slug);

    const { intentId } = await createEnrolmentIntent(owner.account.id, { projectScope: 'selected', allowedProjects: [mine.slug] }, owner);
    expect(await getIntent(owner, intentId)).toMatchObject({ projectScope: 'selected', allowedProjects: [mine.slug] });
  });

  it('refuses the none backend on production when the intent is made (ADR 0008 decision 8)', async () => {
    const owner = await seedSessionUser('owner');
    const body = { name: 'x', isolation: 'none' };
    const production = await sendAsSession(owner, 'POST', intentsPath(owner.account.id), body, {}, accessEnv(uniqueTeamDomain(), { ENVIRONMENT: 'production' }));
    expect(production.status).toBe(422);
    expect(await slugOf(production)).toBe('runner-isolation-none');
    expect((await sendAsSession(owner, 'POST', intentsPath(owner.account.id), body)).status).toBe(201);
  });

  // R-INT-5: at most three open intents per account, and an hourly cap on making them.
  it('holds an account to three open intents, and frees a place when one is withdrawn', async () => {
    const owner = await seedSessionUser('owner');
    const made: string[] = [];
    for (let index = 0; index < ENROLMENT_INTENTS_LIVE_MAX; index += 1) {
      made.push((await createEnrolmentIntent(owner.account.id, {}, owner)).intentId);
    }
    const over = await sendAsSession(owner, 'POST', intentsPath(owner.account.id), { name: 'x', isolation: 'user' });
    expect(over.status).toBe(409);
    expect(await slugOf(over)).toBe('enrolment-intent-limit');
    expect(await auditOf(owner.account.id, 'enrolment-intent.created')).toHaveLength(ENROLMENT_INTENTS_LIVE_MAX);

    expect((await sendAsSession(owner, 'POST', intentPath(owner.account.id, made[0] ?? '', 'withdraw'))).status).toBe(204);
    expect((await sendAsSession(owner, 'POST', intentsPath(owner.account.id), { name: 'x', isolation: 'user' })).status).toBe(201);
  });

  it('caps the intents an account makes in an hour, and prunes rows a day old', async () => {
    const owner = await seedSessionUser('owner');
    const now = Date.now();
    const ancient = await seedIntentAt(owner, new Date(now - 26 * 3600_000), new Date(now - 26 * 3600_000 + 600_000));
    for (let index = 0; index < ENROLMENT_INTENTS_PER_HOUR; index += 1) {
      // Made and expired inside the last hour: none of them is open, all of them count.
      await seedIntentAt(owner, new Date(now - 30 * 60_000 + index), new Date(now - 20 * 60_000));
    }
    const over = await sendAsSession(owner, 'POST', intentsPath(owner.account.id), { name: 'x', isolation: 'user' });
    expect(over.status).toBe(429);
    expect(await slugOf(over)).toBe('rate-limited');
    // The row from yesterday went with the creation's own batch; the audit keeps its history.
    expect(await intentRow(ancient)).toBeNull();
  });

  it('shows the owner an intent past its time as expired', async () => {
    const owner = await seedSessionUser('owner');
    const now = Date.now();
    const pending = await seedIntentAt(owner, new Date(now - 11 * 60_000), new Date(now - 60_000));
    const bound = await seedIntentAt(owner, new Date(now - 12 * 60_000), new Date(now - 2 * 60_000));
    await seedBindAt(owner, bound, new Date(now - 11 * 60_000));
    expect((await getIntent(owner, pending)).state).toBe('expired');
    expect((await getIntent(owner, bound)).state).toBe('expired');
  });
});

describe('who may see and decide an intent (R-INT-2)', () => {
  const ownerRoutes: readonly (readonly [string, string, unknown])[] = [
    ['GET', '', undefined],
    ['POST', 'approve', { fingerprint: 'ABCD-EFGH' }],
    ['POST', 'withdraw', undefined],
  ];

  it('answers another account’s owner 404, on their own account’s path and on the intent’s, and changes nothing', async () => {
    const alice = await seedSessionUser('owner');
    const mallory = await seedSessionUser('owner');
    const bound = await bindIntent(alice.account.id, { as: alice, name: 'Alice Mac' });

    for (const [method, action, body] of ownerRoutes) {
      const fingerprintBody = action === 'approve' ? { fingerprint: bound.start.fingerprint } : body;
      // Mallory names Alice's intent under her own account: the same answer as an intent that never was.
      const underOwn = await sendAsSession(mallory, method, intentPath(mallory.account.id, bound.intentId, action), fingerprintBody);
      const unknown = await sendAsSession(mallory, method, intentPath(mallory.account.id, UNKNOWN_INTENT, action), fingerprintBody);
      expect(underOwn.status, `${method} ${action}`).toBe(404);
      expect(await refusalOf(underOwn)).toEqual(await refusalOf(unknown));
      expect(await slugOf(underOwn)).toBe('enrolment-not-found');
      // And under Alice's account she is no member at all.
      const underTheirs = await sendAsSession(mallory, method, intentPath(alice.account.id, bound.intentId, action), fingerprintBody);
      expect(underTheirs.status).toBe(404);
      expect(await slugOf(underTheirs)).toBe('account-not-found');
    }

    // Nothing moved: the intent is still Alice's to approve, and no runner exists in either account.
    expect(await intentRow(bound.intentId)).toMatchObject({ state: 'bound', account_id: alice.account.id, runner_id: null });
    expect(await runnersOf(mallory.account.id)).toEqual([]);
    expect(await runnersOf(alice.account.id)).toEqual([]);

    // Alice approves: the runner is hers alone, and it sees nothing of Mallory's account.
    const theirs = await seedAccountProject(mallory.account);
    expect((await approve(alice, bound.intentId, bound.start.fingerprint)).status).toBe(200);
    const [runner] = await runnersOf(alice.account.id);
    expect(runner).toMatchObject({ account_id: alice.account.id, name: 'Alice Mac' });
    expect(await runnersOf(mallory.account.id)).toEqual([]);
    const self = (await (
      await sendAsRunner({ id: String(runner?.['id']), privateKey: bound.privateKey }, 'GET', '/api/v1/runner/self')
    ).json()) as RunnerSelfDto;
    expect(self.runner.accountId).toBe(alice.account.id);
    expect(self.projects.map((project) => project.slug)).not.toContain(theirs.slug);
    expect(await auditOf(mallory.account.id, 'runner.enrolled')).toEqual([]);
  });

  it('answers a second owner of the same account 404: only the owner who made the intent decides it', async () => {
    const alice = await seedSessionUser('owner');
    const bobId = await seedUser('bob');
    await seedMembership(alice.account.id, bobId, 'owner');
    const bob: SessionUser = { userId: bobId, cookie: await seedSession(bobId), account: alice.account };
    const bound = await bindIntent(alice.account.id, { as: alice });

    for (const [method, action, body] of ownerRoutes) {
      const fingerprintBody = action === 'approve' ? { fingerprint: bound.start.fingerprint } : body;
      const response = await sendAsSession(bob, method, intentPath(alice.account.id, bound.intentId, action), fingerprintBody);
      const unknown = await sendAsSession(bob, method, intentPath(alice.account.id, UNKNOWN_INTENT, action), fingerprintBody);
      expect(response.status, `${method} ${action}`).toBe(404);
      expect(await refusalOf(response)).toEqual(await refusalOf(unknown));
    }
    expect(await intentRow(bound.intentId)).toMatchObject({ state: 'bound', runner_id: null });
    expect(await runnersOf(alice.account.id)).toEqual([]);
  });

  it('refuses a member with 403, and a cross-site write with 403 csrf', async () => {
    const owner = await seedSessionUser('owner');
    const memberId = await seedUser('member');
    await seedMembership(owner.account.id, memberId, 'member');
    const member: SessionUser = { userId: memberId, cookie: await seedSession(memberId), account: owner.account };
    const bound = await bindIntent(owner.account.id, { as: owner });

    const asMember = await sendAsSession(member, 'POST', intentsPath(owner.account.id), { name: 'x', isolation: 'user' });
    expect(asMember.status).toBe(403);
    expect(await slugOf(asMember)).toBe('account-owner-only');
    for (const [method, action, body] of ownerRoutes) {
      const response = await sendAsSession(member, method, intentPath(owner.account.id, bound.intentId, action), body);
      expect(response.status, `${method} ${action}`).toBe(403);
    }

    const crossSite = { headers: { 'Sec-Fetch-Site': 'cross-site' } };
    const writes: readonly (readonly [string, unknown])[] = [
      [intentsPath(owner.account.id), { name: 'x', isolation: 'user' }],
      [intentPath(owner.account.id, bound.intentId, 'approve'), { fingerprint: bound.start.fingerprint }],
      [intentPath(owner.account.id, bound.intentId, 'withdraw'), undefined],
    ];
    for (const [path, body] of writes) {
      const response = await sendAsSession(owner, 'POST', path, body, crossSite);
      expect(response.status, path).toBe(403);
      expect(await slugOf(response)).toBe('csrf');
    }
    expect(await intentRow(bound.intentId)).toMatchObject({ state: 'bound' });
  });
});

describe('POST /api/v1/runner/enrol/start', () => {
  it('binds the runner’s key, returns the poll token once and keeps only its hash', async () => {
    const owner = await seedSessionUser('owner');
    const { intentId, expiresAt } = await createEnrolmentIntent(owner.account.id, { isolation: 'container' }, owner);
    const key = await generateRunnerKey();
    const response = await postEnrolDoor(
      'start',
      startBodyOf(intentId, key.publicKeyJwk, {
        isolation: 'container',
        host: { os: 'linux', arch: 'x64', hostname: 'vps-1' },
        capabilities: { local: false, maxConcurrency: 2, accessSources: ['api_key'] },
        version: '0.2.0',
      }),
      { headers: { 'CF-IPCountry': 'UA' } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as StartEnrolmentResponse;
    expect(isStartEnrolmentResponse(body)).toBe(true);
    expect(Object.keys(body).sort()).toEqual(['accountName', 'expiresAt', 'fingerprint', 'intervalSeconds', 'pollToken']);
    expect(body).toMatchObject({
      fingerprint: await runnerKeyFingerprintOf(key.publicKeyJwk),
      intervalSeconds: ENROLMENT_INTENT_POLL_SECONDS,
      expiresAt,
      accountName: 'Account',
    });
    expect(body.pollToken).toMatch(new RegExp(`^${ENROLMENT_POLL_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));

    const row = await intentRow(intentId);
    expect(row).toMatchObject({
      state: 'bound',
      public_key: key.publicKeyJwk.x,
      fingerprint: body.fingerprint,
      poll_token_hash: await sha256Hex(body.pollToken),
      version: '0.2.0',
      bound_country: 'UA',
      runner_id: null,
    });
    expect(JSON.stringify(row)).not.toContain(body.pollToken);

    expect(await getIntent(owner, intentId)).toMatchObject({
      state: 'bound',
      host: { os: 'linux', arch: 'x64', hostname: 'vps-1' },
      version: '0.2.0',
      fingerprint: body.fingerprint,
      boundCountry: 'UA',
      runnerId: null,
    });
    const [audit] = await auditOf(owner.account.id, 'enrolment-intent.bound');
    expect(audit).toMatchObject({ actor_kind: 'system', actor: 'enrolment', target: intentId, ip_country: 'UA' });
    expect(JSON.parse(audit?.details ?? '{}')).toEqual({ fingerprint: body.fingerprint, isolation: 'container', version: '0.2.0' });
    // The bind enrols nothing yet.
    expect(await runnersOf(owner.account.id)).toEqual([]);
  });

  // R-INT-1: a local user who read the intent's id binds their own key; only one bind ever holds.
  it('lets the first bind win a race: one 200, one 409, and the row holds the winner’s key', async () => {
    const owner = await seedSessionUser('owner');
    const { intentId } = await createEnrolmentIntent(owner.account.id, {}, owner);
    const [first, second] = [await generateRunnerKey(), await generateRunnerKey()];
    const responses = await Promise.all([
      postEnrolDoor('start', startBodyOf(intentId, first.publicKeyJwk)),
      postEnrolDoor('start', startBodyOf(intentId, second.publicKeyJwk)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = responses[0]?.status === 200 ? first : second;
    const won = (await (responses.find((response) => response.status === 200) as Response).json()) as StartEnrolmentResponse;
    const lost = responses.find((response) => response.status === 409) as Response;
    expect(await slugOf(lost)).toBe('enrolment-intent-bound');
    expect(await lost.text()).not.toContain(won.fingerprint);

    expect(await intentRow(intentId)).toMatchObject({ state: 'bound', public_key: winner.publicKeyJwk.x, fingerprint: won.fingerprint });
    expect(await auditOf(owner.account.id, 'enrolment-intent.bound')).toHaveLength(1);
    // A later `start`, by anyone, is the same 409 and changes nothing.
    const late = await postEnrolDoor('start', startBodyOf(intentId, (await generateRunnerKey()).publicKeyJwk));
    expect(late.status).toBe(409);
    expect(await intentRow(intentId)).toMatchObject({ public_key: winner.publicKeyJwk.x });
  });

  it('decides the race in the write: a bind that lands after the route’s read still loses', async () => {
    const owner = await seedSessionUser('owner');
    const { intentId } = await createEnrolmentIntent(owner.account.id, {}, owner);
    const rival = await generateRunnerKey();
    const realBind = EnrolmentIntentsRepo.prototype.bind;
    vi.spyOn(EnrolmentIntentsRepo.prototype, 'bind').mockImplementationOnce(async function (this: EnrolmentIntentsRepo, id, isolation, bind, audit) {
      // The rival's whole `start` commits between this request's read of a pending intent and its own write.
      expect((await postEnrolDoor('start', startBodyOf(intentId, rival.publicKeyJwk))).status).toBe(200);
      return realBind.call(this, id, isolation, bind, audit);
    });
    const loser = await generateRunnerKey();
    const response = await postEnrolDoor('start', startBodyOf(intentId, loser.publicKeyJwk));
    expect(response.status).toBe(409);
    expect(await slugOf(response)).toBe('enrolment-intent-bound');
    expect(await intentRow(intentId)).toMatchObject({ public_key: rival.publicKeyJwk.x });
    expect(await auditOf(owner.account.id, 'enrolment-intent.bound')).toHaveLength(1);
  });

  it('the owner approves only the key they were shown: the loser of the race never becomes the runner', async () => {
    const owner = await seedSessionUser('owner');
    const { intentId } = await createEnrolmentIntent(owner.account.id, {}, owner);
    const attacker = await generateRunnerKey();
    const real = await generateRunnerKey();
    // The attacker binds first; the real `setup` then gets the loud 409.
    const attackerStart = (await (await postEnrolDoor('start', startBodyOf(intentId, attacker.publicKeyJwk))).json()) as StartEnrolmentResponse;
    expect((await postEnrolDoor('start', startBodyOf(intentId, real.publicKeyJwk))).status).toBe(409);

    // The owner compares with the terminal of the real machine: its fingerprint is not the bound one.
    const realFingerprint = await runnerKeyFingerprintOf(real.publicKeyJwk);
    expect(realFingerprint).not.toBe(attackerStart.fingerprint);
    const mismatch = await approve(owner, intentId, realFingerprint);
    expect(mismatch.status).toBe(409);
    expect(await slugOf(mismatch)).toBe('enrolment-fingerprint-mismatch');
    expect(await runnersOf(owner.account.id)).toEqual([]);

    // Rejected: the attacker's token collects nothing, ever.
    expect((await sendAsSession(owner, 'POST', intentPath(owner.account.id, intentId, 'withdraw'))).status).toBe(204);
    expect((await poll(intentId, attackerStart.pollToken)).status).toBe(404);
    expect(await runnersOf(owner.account.id)).toEqual([]);
  });

  it('answers an unknown, an expired and a withdrawn intent with one 404 and one body', async () => {
    const owner = await seedSessionUser('owner');
    const now = Date.now();
    const expired = await seedIntentAt(owner, new Date(now - 11 * 60_000), new Date(now - 60_000));
    const withdrawn = (await createEnrolmentIntent(owner.account.id, {}, owner)).intentId;
    expect((await sendAsSession(owner, 'POST', intentPath(owner.account.id, withdrawn, 'withdraw'))).status).toBe(204);

    const key = (await generateRunnerKey()).publicKeyJwk;
    const refusals = [];
    for (const intentId of [UNKNOWN_INTENT, expired, withdrawn]) {
      refusals.push(await refusalOf(await postEnrolDoor('start', startBodyOf(intentId, key))));
    }
    expect(refusals[0]).toMatchObject({ status: 404, type: expect.stringContaining('enrolment-not-found') as unknown });
    expect(refusals[1]).toEqual(refusals[0]);
    expect(refusals[2]).toEqual(refusals[0]);
    for (const intentId of [expired, withdrawn]) {
      expect(await intentRow(intentId)).toMatchObject({ public_key: null });
    }
  });

  it.each([
    ['an account member', { accountId: '01M6YSNJ0000000000000N0PE1' }, 'body'],
    ['a name', { name: 'mine' }, 'body'],
    ['a scope', { projectScope: 'all' }, 'body'],
    ['a credential member', { credential: 'setup-token' }, 'body'],
    ['a private key member', { publicKey: { kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43), d: 'y'.repeat(43) } }, 'publicKey'],
    ['a malformed intent id', { intentId: 'not-an-id' }, 'intentId'],
    ['a bidi override in the hostname', { host: { os: 'darwin', arch: 'arm64', hostname: 'mac\u202Egnp.exe' } }, 'host.hostname'],
    ['a control character in the hostname', { host: { os: 'darwin', arch: 'arm64', hostname: 'mac\u0007' } }, 'host.hostname'],
    ['an isolate in the os', { host: { os: '\u2066darwin', arch: 'arm64', hostname: 'mac' } }, 'host.os'],
    ['a hostname over the cap', { host: { os: 'darwin', arch: 'arm64', hostname: 'h'.repeat(129) } }, 'host.hostname'],
  ])('refuses %s with 422 and binds nothing (R-INT-6, R-INT-7)', async (_, overrides, field) => {
    const owner = await seedSessionUser('owner');
    const { intentId } = await createEnrolmentIntent(owner.account.id, {}, owner);
    const body = { ...startBodyOf(intentId, (await generateRunnerKey()).publicKeyJwk), ...overrides };
    const response = await postEnrolDoor('start', body);
    expect(response.status).toBe(422);
    expect(await slugOf(response)).toBe('enrol-invalid');
    expect(((await response.json()) as { field: string }).field).toBe(field);
    expect(await intentRow(intentId)).toMatchObject({ state: 'pending', public_key: null });
  });

  it('refuses another backend than the intent’s with 422 and leaves the intent for the right one', async () => {
    const owner = await seedSessionUser('owner');
    const { intentId } = await createEnrolmentIntent(owner.account.id, { isolation: 'user' }, owner);
    const key = (await generateRunnerKey()).publicKeyJwk;
    const mismatch = await postEnrolDoor('start', startBodyOf(intentId, key, { isolation: 'container' }));
    expect(mismatch.status).toBe(422);
    expect(await slugOf(mismatch)).toBe('enrolment-isolation-mismatch');
    expect(await intentRow(intentId)).toMatchObject({ state: 'pending' });
    expect((await postEnrolDoor('start', startBodyOf(intentId, key, { isolation: 'user' }))).status).toBe(200);
  });

  it('refuses an intent of a suspended account, and the none backend on production', async () => {
    const owner = await seedSessionUser('owner');
    const suspended = (await createEnrolmentIntent(owner.account.id, {}, owner)).intentId;
    const none = (await createEnrolmentIntent(owner.account.id, { isolation: 'none' }, owner)).intentId;
    const key = (await generateRunnerKey()).publicKeyJwk;

    const production = await postEnrolDoor('start', startBodyOf(none, key, { isolation: 'none' }), {}, localEnv({ ENVIRONMENT: 'production', AUTH_MODE: undefined }));
    expect(production.status).toBe(422);
    expect(await slugOf(production)).toBe('runner-isolation-none');

    await env.DB.prepare(`UPDATE accounts SET suspended_at = '2026-11-10T00:00:00.000Z' WHERE id = ?1`).bind(owner.account.id).run();
    const response = await postEnrolDoor('start', startBodyOf(suspended, key));
    expect(response.status).toBe(403);
    expect(await slugOf(response)).toBe('account-suspended');
    expect(await intentRow(suspended)).toMatchObject({ state: 'pending' });
  });

  it('is open to the enrolment identity only: a cookie or a cross-site page carries nothing there', async () => {
    const owner = await seedSessionUser('owner');
    for (const call of ['start', 'poll'] as const) {
      const response = await postEnrolDoor(call, {}, { headers: { Cookie: `__Host-tc_session=${owner.cookie}`, 'Sec-Fetch-Site': 'cross-site' } });
      expect(response.status).toBe(422);
      expect(await slugOf(response)).toBe('enrol-invalid');
    }
  });
});

describe('approval and POST /api/v1/runner/enrol/poll', () => {
  it('walks the whole flow: 202 while bound, the runner from the intent row on approval, the enrolment once, then a working JWT', async () => {
    const owner = await seedSessionUser('owner');
    const project = await seedAccountProject(owner.account);
    const bound = await bindIntent(owner.account.id, {
      as: owner,
      name: 'Studio',
      projectScope: 'selected',
      allowedProjects: [project.slug],
      start: { capabilities: { local: true, maxConcurrency: 1, accessSources: ['subscription'] }, version: '0.3.0' },
    });

    const waiting = await poll(bound.intentId, bound.start.pollToken);
    expect(waiting.status).toBe(202);
    expect(await waiting.json()).toEqual({ state: 'bound', intervalSeconds: ENROLMENT_INTENT_POLL_SECONDS });

    const approved = await approve(owner, bound.intentId, bound.start.fingerprint, { headers: { 'CF-IPCountry': 'PL' } });
    expect(approved.status).toBe(200);
    const dto = (await approved.json()) as EnrolmentIntentDto;
    expect(isEnrolmentIntentDto(dto)).toBe(true);
    expect(dto).toMatchObject({ state: 'approved', fingerprint: bound.start.fingerprint });

    // R-INT-6: the runner row is the intent row's — account, name, scope, list, backend — and the binder's key.
    const runners = await runnersOf(owner.account.id);
    expect(runners).toHaveLength(1);
    const [runner] = runners;
    expect(runner).toMatchObject({
      id: dto.runnerId,
      account_id: owner.account.id,
      name: 'Studio',
      project_scope: 'selected',
      allowed_projects: JSON.stringify([project.slug]),
      isolation: 'user',
      hosted: 0,
      version: '0.3.0',
      // D3: the owner who made (and approved) the intent is the enroller.
      enrolled_by: owner.userId,
    });
    expect(JSON.parse(String(runner?.['public_key_jwk']))).toEqual(bound.publicKeyJwk);
    expect(JSON.parse(String(runner?.['capabilities']))).toEqual({ local: true, maxConcurrency: 1, accessSources: ['subscription'] });
    expect(await intentRow(bound.intentId)).toMatchObject({ state: 'approved', runner_id: dto.runnerId, approved_by: owner.userId });

    const [audit] = await auditOf(owner.account.id, 'runner.enrolled');
    expect(audit).toMatchObject({ actor_kind: 'user', actor: owner.userId, target: dto.runnerId, ip_country: 'PL' });
    expect(JSON.parse(audit?.details ?? '{}')).toEqual({
      name: 'Studio',
      isolation: 'user',
      version: '0.3.0',
      projectScope: 'selected',
      allowedProjects: [project.slug],
      accessSources: ['subscription'],
      createdBy: owner.userId,
      via: 'intent',
      intentId: bound.intentId,
      fingerprint: bound.start.fingerprint,
    });

    await resetPollClock(bound.intentId);
    const collected = await poll(bound.intentId, bound.start.pollToken);
    expect(collected.status).toBe(200);
    const enrolment = (await collected.json()) as EnrolRunnerResponse;
    expect(Object.keys(enrolment).sort()).toEqual(['accountId', 'allowedProjects', 'audience', 'name', 'pollSeconds', 'projectScope', 'runnerId']);
    expect(enrolment).toMatchObject({
      runnerId: dto.runnerId,
      accountId: owner.account.id,
      name: 'Studio',
      audience: runnerAudienceOf('local'),
      projectScope: 'selected',
      allowedProjects: [project.slug],
    });
    expect((await getIntent(owner, bound.intentId)).state).toBe('used');

    // Once: the token is spent, and the answer is the door's one 404.
    await resetPollClock(bound.intentId);
    const again = await poll(bound.intentId, bound.start.pollToken);
    expect(again.status).toBe(404);
    expect(await slugOf(again)).toBe('enrolment-not-found');

    // The key that never left the host now authenticates the runner.
    const self = await sendAsRunner({ id: enrolment.runnerId, privateKey: bound.privateKey }, 'GET', '/api/v1/runner/self');
    expect(self.status).toBe(200);
    expect(((await self.json()) as RunnerSelfDto).projects).toEqual([{ slug: project.slug, accessSource: 'subscription' }]);
  });

  it('approves once: a repeated approval answers the same intent and writes no second runner or audit row', async () => {
    const owner = await seedSessionUser('owner');
    const bound = await bindIntent(owner.account.id, { as: owner });
    const first = (await (await approve(owner, bound.intentId, bound.start.fingerprint)).json()) as EnrolmentIntentDto;
    const second = await approve(owner, bound.intentId, bound.start.fingerprint);
    expect(second.status).toBe(200);
    expect(((await second.json()) as EnrolmentIntentDto).runnerId).toBe(first.runnerId);
    expect(await runnersOf(owner.account.id)).toHaveLength(1);
    expect(await auditOf(owner.account.id, 'runner.enrolled')).toHaveLength(1);
    // Another fingerprint on the approved intent is still a mismatch, never a second approval.
    const other = await approve(owner, bound.intentId, bound.start.fingerprint === 'ABCD-EFGH' ? 'ABCD-EFGJ' : 'ABCD-EFGH');
    expect(other.status).toBe(409);
    expect(await slugOf(other)).toBe('enrolment-fingerprint-mismatch');
  });

  it('takes nothing but the fingerprint in the approval: a body cannot choose account, name, scope or backend', async () => {
    const owner = await seedSessionUser('owner');
    const bound = await bindIntent(owner.account.id, { as: owner });
    for (const extra of [{ accountId: UNKNOWN_INTENT }, { name: 'other' }, { projectScope: 'all' }, { isolation: 'none' }, { hosted: true }, { publicKey: {} }]) {
      const response = await sendAsSession(owner, 'POST', intentPath(owner.account.id, bound.intentId, 'approve'), {
        fingerprint: bound.start.fingerprint,
        ...extra,
      });
      expect(response.status, JSON.stringify(extra)).toBe(422);
      expect(await slugOf(response)).toBe('enrolment-intent-invalid');
    }
    const malformed = await approve(owner, bound.intentId, 'abcd-efgh');
    expect(malformed.status).toBe(422);
    expect(await runnersOf(owner.account.id)).toEqual([]);
  });

  it('refuses to approve a pending intent (409), and an expired or withdrawn one (404)', async () => {
    const owner = await seedSessionUser('owner');
    const pending = (await createEnrolmentIntent(owner.account.id, {}, owner)).intentId;
    const notBound = await approve(owner, pending, 'ABCD-EFGH');
    expect(notBound.status).toBe(409);
    expect(await slugOf(notBound)).toBe('enrolment-intent-not-bound');

    const now = Date.now();
    const expired = await seedIntentAt(owner, new Date(now - 12 * 60_000), new Date(now - 60_000));
    const expiredBind = await seedBindAt(owner, expired, new Date(now - 11 * 60_000));
    expect((await approve(owner, expired, expiredBind.fingerprint)).status).toBe(404);

    const withdrawn = await bindIntent(owner.account.id, { as: owner });
    expect((await sendAsSession(owner, 'POST', intentPath(owner.account.id, withdrawn.intentId, 'withdraw'))).status).toBe(204);
    expect((await approve(owner, withdrawn.intentId, withdrawn.start.fingerprint)).status).toBe(404);
    expect(await runnersOf(owner.account.id)).toEqual([]);
    expect(await auditOf(owner.account.id, 'runner.enrolled')).toEqual([]);
  });

  it('refuses to approve for a suspended account and the none backend on production', async () => {
    const owner = await seedSessionUser('owner');
    // Elsewhere than production a fixture runner without isolation enrols.
    const none = await bindIntent(owner.account.id, { as: owner, isolation: 'none' });
    expect((await approve(owner, none.intentId, none.start.fingerprint)).status).toBe(200);

    const refused = await bindIntent(owner.account.id, { as: owner, isolation: 'none' });
    const onProduction = await sendAsSession(
      owner,
      'POST',
      intentPath(owner.account.id, refused.intentId, 'approve'),
      { fingerprint: refused.start.fingerprint },
      {},
      accessEnv(uniqueTeamDomain(), { ENVIRONMENT: 'production' }),
    );
    expect(onProduction.status).toBe(422);
    expect(await slugOf(onProduction)).toBe('runner-isolation-none');

    const bound = await bindIntent(owner.account.id, { as: owner });
    await env.DB.prepare(`UPDATE accounts SET suspended_at = '2026-11-10T00:00:00.000Z' WHERE id = ?1`).bind(owner.account.id).run();
    const suspended = await approve(owner, bound.intentId, bound.start.fingerprint);
    expect(suspended.status).toBe(403);
    expect(await slugOf(suspended)).toBe('account-suspended');
    expect(await runnersOf(owner.account.id)).toHaveLength(1);
  });

  it('withdraws a pending or bound intent with an audit row, once; an approved one stays', async () => {
    const owner = await seedSessionUser('owner');
    const withdraw = (intentId: string) => sendAsSession(owner, 'POST', intentPath(owner.account.id, intentId, 'withdraw'));
    const bound = await bindIntent(owner.account.id, { as: owner });
    expect((await withdraw(bound.intentId)).status).toBe(204);
    expect((await getIntent(owner, bound.intentId)).state).toBe('withdrawn');
    const [audit] = await auditOf(owner.account.id, 'enrolment-intent.withdrawn');
    expect(audit).toMatchObject({ actor: owner.userId, target: bound.intentId });
    const twice = await withdraw(bound.intentId);
    expect(twice.status).toBe(404);
    expect(await auditOf(owner.account.id, 'enrolment-intent.withdrawn')).toHaveLength(1);
    // The rejected key stays on the row: the rejection is evidence of who asked.
    expect(await intentRow(bound.intentId)).toMatchObject({ state: 'withdrawn', public_key: bound.publicKeyJwk.x });

    const approved = await bindIntent(owner.account.id, { as: owner });
    expect((await approve(owner, approved.intentId, approved.start.fingerprint)).status).toBe(200);
    expect((await withdraw(approved.intentId)).status).toBe(404);
    expect((await getIntent(owner, approved.intentId)).state).toBe('approved');
    expect((await withdraw('not-an-id')).status).toBe(404);
  });

  it('answers a wrong token, an expired and a withdrawn intent with one 404 and one body', async () => {
    const owner = await seedSessionUser('owner');
    const live = await bindIntent(owner.account.id, { as: owner });
    const withdrawn = await bindIntent(owner.account.id, { as: owner });
    expect((await sendAsSession(owner, 'POST', intentPath(owner.account.id, withdrawn.intentId, 'withdraw'))).status).toBe(204);
    const now = Date.now();
    const expired = await seedIntentAt(owner, new Date(now - 12 * 60_000), new Date(now - 60_000));
    const expiredBind = await seedBindAt(owner, expired, new Date(now - 11 * 60_000));
    const pending = (await createEnrolmentIntent(owner.account.id, {}, owner)).intentId;
    const guess = `${ENROLMENT_POLL_TOKEN_PREFIX}${'G'.repeat(43)}`;

    const cases: readonly (readonly [string, string, string])[] = [
      ['an unknown intent', UNKNOWN_INTENT, guess],
      ['a guessed token', live.intentId, guess],
      ['another intent’s token', live.intentId, withdrawn.start.pollToken],
      ['a token that is no token', live.intentId, 'x'],
      ['a pending intent', pending, guess],
      ['a withdrawn intent', withdrawn.intentId, withdrawn.start.pollToken],
      ['an expired intent', expired, expiredBind.pollToken],
    ];
    const refusals = [];
    for (const [, intentId, token] of cases) {
      refusals.push(await refusalOf(await poll(intentId, token)));
    }
    expect(refusals[0]).toMatchObject({ status: 404, type: expect.stringContaining('enrolment-not-found') as unknown });
    for (const [index, [name]] of cases.entries()) {
      expect(refusals[index], name).toEqual(refusals[0]);
    }
    // And it is the body `start` gives for the same three.
    expect(await refusalOf(await postEnrolDoor('start', startBodyOf(UNKNOWN_INTENT, live.publicKeyJwk)))).toEqual(refusals[0]);
    // None of the wrong tokens slowed the real binder down.
    expect((await poll(live.intentId, live.start.pollToken)).status).toBe(202);
  });

  it('answers a poll sooner than the interval with 429 slow-down, for the binder alone', async () => {
    const owner = await seedSessionUser('owner');
    const bound = await bindIntent(owner.account.id, { as: owner });
    expect((await poll(bound.intentId, bound.start.pollToken)).status).toBe(202);
    const early = await poll(bound.intentId, bound.start.pollToken);
    expect(early.status).toBe(429);
    expect(await slugOf(early)).toBe('slow-down');
    expect(early.headers.get('Retry-After')).toBe(String(ENROLMENT_INTENT_POLL_SECONDS));

    // A poll a full interval after the last admitted one passes.
    await env.DB.prepare(`UPDATE runner_enrolment_requests SET last_polled_at = ?2 WHERE id = ?1`)
      .bind(bound.intentId, new Date(Date.now() - ENROLMENT_INTENT_POLL_SECONDS * 1000).toISOString())
      .run();
    expect((await poll(bound.intentId, bound.start.pollToken)).status).toBe(202);
  });

  it('keeps an approval made at the last second collectable, and closes the window after it', async () => {
    const owner = await seedSessionUser('owner');
    const intents = new EnrolmentIntentsRepo(env.DB);
    const audit = (runnerId: string) => (): NewAuditEvent => ({
      accountId: owner.account.id,
      at: new Date().toISOString(),
      actorKind: 'user',
      actor: owner.userId,
      kind: 'runner.enrolled',
      target: runnerId,
    });
    const now = Date.now();
    const seed = async (expiredAgoMs: number, approvedAgoMs: number) => {
      const id = await seedIntentAt(owner, new Date(now - expiredAgoMs - 600_000), new Date(now - expiredAgoMs));
      const bind = await seedBindAt(owner, id, new Date(now - approvedAgoMs - 1000));
      const runnerId = newUlid(now - approvedAgoMs);
      const approved = await intents.approve(
        { accountId: owner.account.id, createdBy: owner.userId },
        id,
        { fingerprint: bind.fingerprint, runnerId, at: new Date(now - approvedAgoMs).toISOString() },
        audit(runnerId),
      );
      expect(approved?.state).toBe('approved');
      return { id, ...bind, runnerId };
    };
    // Approved a minute ago, thirty seconds before its time ran out: still inside the collection window.
    const inside = await seed(30_000, 60_000);
    const collected = await poll(inside.id, inside.pollToken);
    expect(collected.status).toBe(200);
    expect(((await collected.json()) as EnrolRunnerResponse).runnerId).toBe(inside.runnerId);

    // Approved four minutes ago and never collected: the window closed, the one 404.
    const outside = await seed(200_000, 240_000);
    const late = await poll(outside.id, outside.pollToken);
    expect(late.status).toBe(404);
    expect(await slugOf(late)).toBe('enrolment-not-found');
  });

  it('gives a runner the owner revoked before it collected the one 404', async () => {
    const owner = await seedSessionUser('owner');
    const bound = await bindIntent(owner.account.id, { as: owner });
    const dto = (await (await approve(owner, bound.intentId, bound.start.fingerprint)).json()) as EnrolmentIntentDto;
    const revoked = await sendAsSession(owner, 'POST', `/api/v1/accounts/${owner.account.id}/runners/${String(dto.runnerId)}/revoke`);
    expect(revoked.status).toBe(200);
    expect((await poll(bound.intentId, bound.start.pollToken)).status).toBe(404);
  });

  // D3 (owner, 2026-11-17): the enroller is the owner who made the intent, so a subscription runner scoped to `all`
  // in an account with two owners serves that owner's projects only.
  it('records the intent’s creator as the enroller, so an all-scope subscription runner serves only their projects', async () => {
    const alice = await seedSessionUser('owner');
    const bobId = await seedUser('bob');
    await seedMembership(alice.account.id, bobId, 'owner');
    const hers = await seedAccountProject(alice.account);
    const his = await seedAccountProject(alice.account);
    await env.DB.batch([
      env.DB.prepare(`UPDATE projects SET created_by = ?2 WHERE slug = ?1`).bind(hers.slug, alice.userId),
      env.DB.prepare(`UPDATE projects SET created_by = ?2 WHERE slug = ?1`).bind(his.slug, bobId),
    ]);
    const bound = await bindIntent(alice.account.id, {
      as: alice,
      projectScope: 'all',
      start: { capabilities: { local: true, maxConcurrency: 1, accessSources: ['subscription'] } },
    });
    const dto = (await (await approve(alice, bound.intentId, bound.start.fingerprint)).json()) as EnrolmentIntentDto;
    const [runner] = await runnersOf(alice.account.id);
    expect(runner).toMatchObject({ id: dto.runnerId, project_scope: 'all', enrolled_by: alice.userId });
    const self = (await (
      await sendAsRunner({ id: String(dto.runnerId), privateKey: bound.privateKey }, 'GET', '/api/v1/runner/self')
    ).json()) as RunnerSelfDto;
    expect(self.projects.map((project) => project.slug)).toEqual([hers.slug]);
  });
});

describe('the door’s rate limits (R-INT-5)', () => {
  it('counts start in the enrol door’s per-address bucket and poll in one of its own', async () => {
    const outcome = await inOneRateWindow(async () => {
      const address = { 'CF-Connecting-IP': `198.51.100.${String(Math.floor(Math.random() * 200) + 1)}` };
      const key = (await generateRunnerKey()).publicKeyJwk;
      const starts: number[] = [];
      for (let attempt = 0; attempt < ENROL_RATE_LIMIT_PER_MINUTE + 1; attempt += 1) {
        starts.push((await postEnrolDoor('start', startBodyOf(UNKNOWN_INTENT, key), { headers: address })).status);
      }
      // The same address is over on `/enrol` too (one bucket), and still polls (another).
      const enrol = await postEnrol(enrolBodyOf(`${ENROLMENT_CODE_PREFIX}${'B'.repeat(43)}`, key), { headers: address });
      const polled = await poll(UNKNOWN_INTENT, `${ENROLMENT_POLL_TOKEN_PREFIX}${'P'.repeat(43)}`, { headers: address });
      return { starts, enrol: enrol.status, retryAfter: Number(enrol.headers.get('Retry-After')), polled: polled.status };
    });
    expect(outcome.starts).toEqual([...new Array<number>(ENROL_RATE_LIMIT_PER_MINUTE).fill(404), 429]);
    expect(outcome.enrol).toBe(429);
    expect(outcome.retryAfter).toBeGreaterThan(0);
    expect(outcome.polled).toBe(404);
  });

  it('rate-limits polls per address at their own limit', async () => {
    const outcome = await inOneRateWindow(async () => {
      const address = `192.0.2.${String(Math.floor(Math.random() * 200) + 1)}`;
      return withRateBucketAt(`enrol:poll-ip:${await sha256Hex(address)}`, ENROL_POLL_RATE_LIMIT_PER_MINUTE, async () => {
        const over = await poll(UNKNOWN_INTENT, `${ENROLMENT_POLL_TOKEN_PREFIX}${'P'.repeat(43)}`, { headers: { 'CF-Connecting-IP': address } });
        return [over.status, await slugOf(over)];
      });
    });
    expect(outcome).toEqual([429, 'rate-limited']);
  });

  it('binds a pending intent while junk is at its environment limit, and answers every junk 429 alike', async () => {
    const owner = await seedSessionUser('owner');
    const outcome = await inOneRateWindow(async () => {
      const bound = await bindIntent(owner.account.id, { as: owner });
      const { intentId } = await createEnrolmentIntent(owner.account.id, {}, owner);
      const key = (await generateRunnerKey()).publicKeyJwk;
      const result = await withRateBucketAt('enrol:unverified', ENROL_RATE_LIMIT_UNVERIFIED_PER_MINUTE, async () => {
        const junk = [
          await postEnrolDoor('start', startBodyOf(UNKNOWN_INTENT, key)),
          await postEnrolDoor('start', { intentId: 1 }),
          // A bound intent is junk to a second binder: the 429 tells nothing about which intents exist.
          await postEnrolDoor('start', startBodyOf(bound.intentId, key)),
          await poll(UNKNOWN_INTENT, `${ENROLMENT_POLL_TOKEN_PREFIX}${'J'.repeat(43)}`),
          await poll(bound.intentId, `${ENROLMENT_POLL_TOKEN_PREFIX}${'J'.repeat(43)}`),
        ];
        const real = await postEnrolDoor('start', startBodyOf(intentId, key));
        const realPoll = await poll(bound.intentId, bound.start.pollToken);
        return {
          junk: await Promise.all(junk.map(async (response) => [response.status, await slugOf(response)])),
          real: real.status,
          realPoll: realPoll.status,
        };
      });
      // Leave the account room for the next run of this body.
      for (const id of [bound.intentId, intentId]) {
        await sendAsSession(owner, 'POST', intentPath(owner.account.id, id, 'withdraw'));
      }
      return result;
    });
    expect(outcome.junk).toEqual(new Array(5).fill([429, 'rate-limited']));
    expect(outcome.real).toBe(200);
    expect(outcome.realPoll).toBe(202);
  });

  it('floors binds on pending intents for the environment', async () => {
    const owner = await seedSessionUser('owner');
    const outcome = await inOneRateWindow(async () => {
      const { intentId } = await createEnrolmentIntent(owner.account.id, {}, owner);
      const key = (await generateRunnerKey()).publicKeyJwk;
      const result = await withRateBucketAt('enrol:verified', ENROL_RATE_LIMIT_GLOBAL_PER_MINUTE, async () => ({
        real: (await postEnrolDoor('start', startBodyOf(intentId, key))).status,
        guess: (await postEnrolDoor('start', startBodyOf(UNKNOWN_INTENT, key))).status,
      }));
      await sendAsSession(owner, 'POST', intentPath(owner.account.id, intentId, 'withdraw'));
      return result;
    });
    expect(outcome).toEqual({ real: 429, guess: 404 });
  });
});

describe('what never leaves the door (R-INT-4)', () => {
  it('never writes the poll token or the runner key into a log line, an audit row or a problem body', async () => {
    const owner = await seedSessionUser('owner');
    const { intentId } = await createEnrolmentIntent(owner.account.id, {}, owner);
    const key = await generateRunnerKey();
    const lines: string[] = [];
    const logSink = (line: string): void => void lines.push(line);
    const bodies: string[] = [];
    const keep = async (response: Response): Promise<Response> => {
      bodies.push(await response.clone().text());
      return response;
    };

    const started = await postEnrolDoor('start', startBodyOf(intentId, key.publicKeyJwk), { logSink });
    const { pollToken, fingerprint } = (await started.json()) as StartEnrolmentResponse;
    await keep(await poll(intentId, pollToken, { logSink }));
    // A too-early poll, a second bind, a mismatched approval: every refusal on the way.
    await keep(await poll(intentId, pollToken, { logSink }));
    await keep(await postEnrolDoor('start', startBodyOf(intentId, (await generateRunnerKey()).publicKeyJwk), { logSink }));
    await keep(await approve(owner, intentId, fingerprint === 'ABCD-EFGH' ? 'ABCD-EFGJ' : 'ABCD-EFGH', { logSink }));
    await keep(await sendAsSession(owner, 'GET', intentPath(owner.account.id, intentId), undefined, { logSink }));
    await keep(await approve(owner, intentId, fingerprint, { logSink }));
    await resetPollClock(intentId);
    expect((await poll(intentId, pollToken, { logSink })).status).toBe(200);
    await resetPollClock(intentId);
    await keep(await poll(intentId, pollToken, { logSink }));

    const { results } = await env.DB.prepare(`SELECT details, target, actor FROM audit_events WHERE account_id = ?1`)
      .bind(owner.account.id)
      .all<Record<string, unknown>>();
    const output = [lines.join('\n'), bodies.join('\n'), JSON.stringify(results)].join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(results.length).toBeGreaterThanOrEqual(3);
    for (const secret of [pollToken, pollToken.slice(ENROLMENT_POLL_TOKEN_PREFIX.length), await sha256Hex(pollToken), key.publicKeyJwk.x]) {
      expect(output).not.toContain(secret);
    }
  });

  it('has no credential, token or kind member in any DTO the owner reads, and one token in the bind’s answer', async () => {
    const owner = await seedSessionUser('owner');
    const created = await createEnrolmentIntent(owner.account.id, {}, owner);
    const key = await generateRunnerKey();
    const start = (await (await postEnrolDoor('start', startBodyOf(created.intentId, key.publicKeyJwk))).json()) as StartEnrolmentResponse;
    const bound = await getIntent(owner, created.intentId);
    const approved = (await (await approve(owner, created.intentId, start.fingerprint)).json()) as EnrolmentIntentDto;
    await resetPollClock(created.intentId);
    const collected = (await (await poll(created.intentId, start.pollToken)).json()) as EnrolRunnerResponse;

    const expectedIntentKeys = [
      'allowedProjects', 'boundAt', 'boundCountry', 'createdAt', 'expiresAt', 'fingerprint', 'host', 'id', 'isolation',
      'name', 'projectScope', 'runnerId', 'state', 'version',
    ];
    expect(Object.keys(bound).sort()).toEqual(expectedIntentKeys);
    expect(Object.keys(approved).sort()).toEqual(expectedIntentKeys);
    const memberNames = (value: unknown): string[] =>
      value !== null && typeof value === 'object'
        ? Object.entries(value).flatMap(([name, member]) => [name, ...memberNames(member)])
        : [];
    for (const dto of [created, bound, approved, collected]) {
      for (const name of memberNames(dto)) {
        expect(name).not.toMatch(/credential|token|kind|secret|key/i);
      }
    }
    expect(memberNames(start).filter((name) => /credential|token|kind|secret|key/i.test(name))).toEqual(['pollToken']);
    // The owner's side never carries the binder's token or the key itself.
    for (const dto of [created, bound, approved]) {
      expect(JSON.stringify(dto)).not.toContain(start.pollToken);
      expect(JSON.stringify(dto)).not.toContain(key.publicKeyJwk.x);
    }
  });
});
