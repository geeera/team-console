import { env } from 'cloudflare:test';
import {
  OWNER_ACCOUNT_ID,
  type ClaimResponse,
  type EnrolmentCodeDto,
  type RunnerDto,
  type RunnerListDto,
} from '@shared/contracts';
import { ENROLMENT_CODE_PREFIX } from '@shared/redaction';
import {
  accessEnv,
  createSigningKey,
  fetchApi,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
} from '../testing/access-kit';
import { sha256Hex } from '@worker/core';
import {
  createEnrolmentCode,
  enrolBodyOf,
  enqueueJob,
  enrolRunner,
  generateRunnerKey,
  postEnrol,
  sendAsRunner,
  setProjectAccessSource,
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
import { seedTrackerProject, send, sendAsService, slugOf } from '../testing/tracker-kit';

// #467, ADR 0008 row 2-A: `POST /accounts/:id/runners/enrolment-code`, `GET …/runners`, `PATCH …/runners/:runner`,
// `POST …/runners/:runner/revoke` — owner-of-account; another account's runner ids and slugs are refused (the ADR
// 0008 security re-review on allowed_projects writes); every change audited.

const RELEASE = '/api/v1/runner/release';
const CLAIM = '/api/v1/runner/jobs/claim';
const runnersPath = (accountId: string): string => `/api/v1/accounts/${accountId}/runners`;

describe('enrolment codes', () => {
  it('gives the owner a one-time code for the account’s projects and audits it without the code', async () => {
    const project = await seedTrackerProject();
    const response = await send('POST', `${runnersPath(OWNER_ACCOUNT_ID)}/enrolment-code`, {
      name: 'Mac',
      projectScope: 'selected',
      allowedProjects: [project.slug],
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as EnrolmentCodeDto;
    expect(body).toMatchObject({
      name: 'Mac',
      projectScope: 'selected',
      allowedProjects: [project.slug],
      apiUrl: 'http://api.test',
    });
    expect(body.code.startsWith(ENROLMENT_CODE_PREFIX)).toBe(true);
    const audit = await env.DB.prepare(
      `SELECT details FROM audit_events WHERE kind = 'enrolment-code.created' AND account_id = ?1 ORDER BY id DESC`,
    )
      .bind(OWNER_ACCOUNT_ID)
      .first<{ details: string }>();
    expect(audit?.details).not.toContain(body.code.slice(ENROLMENT_CODE_PREFIX.length));
    expect(JSON.parse(audit?.details ?? '{}')).toMatchObject({
      name: 'Mac',
      allowedProjects: [project.slug],
    });
    const stored = await env.DB.prepare(
      `SELECT code_hash FROM runner_enrolments ORDER BY created_at DESC`,
    ).first<{
      code_hash: string;
    }>();
    expect(stored?.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses another account’s slug, an archived one and an unknown one in allowedProjects', async () => {
    const owner = await seedSessionUser('owner');
    const theirs = await seedTrackerProject();
    const mine = await seedAccountProject(owner.account);
    const archived = await seedAccountProject(owner.account);
    await env.DB.prepare(`UPDATE projects SET archived_at = '2026-11-10T00:00:00.000Z' WHERE slug = ?1`)
      .bind(archived.slug)
      .run();
    for (const slug of [theirs.slug, archived.slug, 'zz-no-such-project']) {
      const response = await sendAsSession(owner, 'POST', `${runnersPath(owner.account.id)}/enrolment-code`, {
        name: 'x',
        projectScope: 'selected',
        allowedProjects: [mine.slug, slug],
      });
      expect(response.status).toBe(422);
      expect(await slugOf(response)).toBe('allowed-projects-invalid');
      expect(await response.text()).not.toContain(theirs.slug);
    }
    const ok = await sendAsSession(owner, 'POST', `${runnersPath(owner.account.id)}/enrolment-code`, {
      name: 'x',
      projectScope: 'selected',
      allowedProjects: [mine.slug],
    });
    expect(ok.status).toBe(201);
  });

  it.each([
    ['a missing name', { allowedProjects: [] }, 'name'],
    ['a blank name', { name: '   ', allowedProjects: [] }, 'name'],
    [
      'a malformed slug',
      { name: 'x', projectScope: 'selected', allowedProjects: ['Not A Slug'] },
      'allowedProjects',
    ],
    [
      'a list beside all',
      { name: 'x', projectScope: 'all', allowedProjects: ['team-console'] },
      'allowedProjects',
    ],
    ['a list with no scope', { name: 'x', allowedProjects: ['team-console'] }, 'allowedProjects'],
    ['an unknown scope', { name: 'x', projectScope: 'everything', allowedProjects: [] }, 'projectScope'],
  ])('refuses %s with 422', async (_, body, field) => {
    const response = await send('POST', `${runnersPath(OWNER_ACCOUNT_ID)}/enrolment-code`, body);
    expect(response.status).toBe(422);
    expect(((await response.json()) as { field: string }).field).toBe(field);
  });

  // #775: the owner's default (SECURITY question 6) — a code with no scope is `all`, and the enrolled runner is too.
  it('defaults a code to all projects of the account, and the runner enrolled with it serves them', async () => {
    const response = await send('POST', `${runnersPath(OWNER_ACCOUNT_ID)}/enrolment-code`, { name: 'Mac' });
    expect(response.status).toBe(201);
    const body = (await response.json()) as EnrolmentCodeDto;
    expect(body).toMatchObject({ projectScope: 'all', allowedProjects: [] });
    const key = await generateRunnerKey();
    const enrolled = await postEnrol(enrolBodyOf(body.code, key.publicKeyJwk));
    expect(enrolled.status).toBe(201);
    expect(await enrolled.json()).toMatchObject({ projectScope: 'all', allowedProjects: [] });
    const audit = await env.DB.prepare(
      `SELECT details FROM audit_events WHERE kind = 'enrolment-code.created' AND account_id = ?1 ORDER BY id DESC`,
    )
      .bind(OWNER_ACCOUNT_ID)
      .first<{ details: string }>();
    expect(JSON.parse(audit?.details ?? '{}')).toMatchObject({
      name: 'Mac',
      projectScope: 'all',
      allowedProjects: [],
    });
  });

  it('is the owner’s: a member gets 403, a non-member and the service identity 404', async () => {
    const owner = await seedSessionUser('owner');
    const memberId = await seedUser('member');
    await seedMembership(owner.account.id, memberId, 'member');
    const member = { cookie: await seedSession(memberId) };
    const stranger = await seedSessionUser('owner');
    const path = `${runnersPath(owner.account.id)}/enrolment-code`;
    const body = { name: 'x', allowedProjects: [] };

    const asMember = await sendAsSession(member, 'POST', path, body);
    expect(asMember.status).toBe(403);
    expect(await slugOf(asMember)).toBe('account-owner-only');
    const asStranger = await sendAsSession(stranger, 'POST', path, body);
    expect(asStranger.status).toBe(404);
    expect(await slugOf(asStranger)).toBe('account-not-found');
    const asService = await sendAsService('POST', path, body);
    expect(asService.status).toBe(404);
  });
});

describe('runner list, allowed projects and revoke', () => {
  let owner: SessionUser;

  beforeAll(async () => {
    owner = await seedSessionUser('owner');
  });

  it('lists the account’s runners only, with presence and no key material', async () => {
    const mine = await enrolRunner(owner.account.id, { as: owner, name: 'theirs-not' });
    const theirs = await enrolRunner(OWNER_ACCOUNT_ID, { name: 'owner-mac' });
    await sendAsRunner(mine, 'GET', RELEASE, undefined, { headers: { 'CF-IPCountry': 'UA' } });

    const response = await sendAsSession(owner, 'GET', runnersPath(owner.account.id));
    expect(response.status).toBe(200);
    const text = await response.text();
    const { runners } = JSON.parse(text) as RunnerListDto;
    expect(runners.map((runner) => runner.id)).toEqual([mine.id]);
    expect(runners[0]).toMatchObject({
      name: 'theirs-not',
      isolation: 'user',
      online: true,
      lastSeenCountry: 'UA',
      suspect: null,
      revokedAt: null,
      host: { os: 'darwin', arch: 'arm64', hostname: 'mac.local' },
    });
    expect(text).not.toContain(theirs.id);
    expect(text).not.toContain(mine.publicKeyJwk.x);
    expect(text).not.toContain('publicKey');
  });

  // #464: Settings › Runners flags a runner behind the minimum without the runner door's `GET /runner/release`.
  it('names the release and flags a runner below RUNNER_MINIMUM_VERSION, on the list and on a change', async () => {
    const behind = await enrolRunner(owner.account.id, { as: owner, enrol: { version: '0.1.0' } });
    const current = await enrolRunner(owner.account.id, { as: owner, enrol: { version: '0.2.0-rc.1+abc' } });
    const unlabelled = await enrolRunner(owner.account.id, { as: owner, enrol: { version: 'main' } });
    const bindings = accessEnv(uniqueTeamDomain(), {
      RUNNER_RELEASE_VERSION: '0.3.0',
      RUNNER_MINIMUM_VERSION: '0.2.0-rc.1',
    });

    const response = await sendAsSession(
      owner,
      'GET',
      runnersPath(owner.account.id),
      undefined,
      {},
      bindings,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as RunnerListDto;
    expect(body.release).toEqual({ version: '0.3.0', minimumVersion: '0.2.0-rc.1' });
    const flagOf = (id: string): boolean | undefined =>
      body.runners.find((runner) => runner.id === id)?.belowMinimum;
    expect([flagOf(behind.id), flagOf(current.id), flagOf(unlabelled.id)]).toEqual([true, false, true]);

    const patched = await sendAsSession(
      owner,
      'PATCH',
      `${runnersPath(owner.account.id)}/${behind.id}`,
      { projectScope: 'all', allowedProjects: [] },
      {},
      bindings,
    );
    expect(((await patched.json()) as RunnerDto).belowMinimum).toBe(true);

    // No minimum configured (the deployed default): nothing is behind, and the release reads as unknown.
    const unset = (await (
      await sendAsSession(owner, 'GET', runnersPath(owner.account.id))
    ).json()) as RunnerListDto;
    expect(unset.release).toEqual({ version: null, minimumVersion: null });
    expect(unset.runners.every((runner) => !runner.belowMinimum)).toBe(true);
  });

  it('changes the scope inside the account and refuses foreign slugs and foreign runners', async () => {
    const mine = await enrolRunner(owner.account.id, { as: owner });
    const project = await seedAccountProject(owner.account);
    const theirs = await seedTrackerProject();
    const theirRunner = await enrolRunner(OWNER_ACCOUNT_ID);

    const ok = await sendAsSession(owner, 'PATCH', `${runnersPath(owner.account.id)}/${mine.id}`, {
      projectScope: 'selected',
      allowedProjects: [project.slug],
    });
    expect(ok.status).toBe(200);
    const dto = (await ok.json()) as RunnerDto;
    expect(dto).toMatchObject({ projectScope: 'selected', allowedProjects: [project.slug] });
    expect(dto.servedProjects).toEqual([{ slug: project.slug, accessSource: 'subscription', fit: true }]);

    const foreignSlug = await sendAsSession(owner, 'PATCH', `${runnersPath(owner.account.id)}/${mine.id}`, {
      projectScope: 'selected',
      allowedProjects: [theirs.slug],
    });
    expect(foreignSlug.status).toBe(422);
    expect(await slugOf(foreignSlug)).toBe('allowed-projects-invalid');

    const foreignRunner = await sendAsSession(
      owner,
      'PATCH',
      `${runnersPath(owner.account.id)}/${theirRunner.id}`,
      {
        projectScope: 'selected',
        allowedProjects: [project.slug],
      },
    );
    expect(foreignRunner.status).toBe(404);
    expect(await slugOf(foreignRunner)).toBe('runner-not-found');
    const unchanged = await env.DB.prepare(`SELECT allowed_projects FROM runners WHERE id = ?1`)
      .bind(theirRunner.id)
      .first<{ allowed_projects: string }>();
    expect(unchanged?.allowed_projects).toBe('[]');

    const malformed = await sendAsSession(owner, 'PATCH', `${runnersPath(owner.account.id)}/not-an-id`, {
      projectScope: 'selected',
      allowedProjects: [],
    });
    expect(malformed.status).toBe(404);
    const audit = await env.DB.prepare(
      `SELECT details FROM audit_events WHERE kind = 'runner.scope-changed' AND target = ?1`,
    )
      .bind(mine.id)
      .first<{ details: string }>();
    expect(JSON.parse(audit?.details ?? '{}')).toEqual({
      from: { projectScope: 'selected', allowedProjects: [] },
      to: { projectScope: 'selected', allowedProjects: [project.slug] },
    });
  });

  // #775: PATCH names both keys exactly; `all` needs an empty list; a no-op writes no audit row; the scope changes
  // without re-enrolment and the runner's served projects follow.
  it('switches a runner to all projects and back, audits each change once and refuses a half body', async () => {
    const mine = await enrolRunner(owner.account.id, { as: owner });
    const project = await seedAccountProject(owner.account);
    const path = `${runnersPath(owner.account.id)}/${mine.id}`;
    const scopeAudits = (): Promise<number | null> =>
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'runner.scope-changed' AND target = ?1`,
      )
        .bind(mine.id)
        .first<number>('n');

    for (const body of [
      { allowedProjects: [] },
      { projectScope: 'all' },
      { projectScope: 'all', allowedProjects: [project.slug] },
      { projectScope: 'selected', allowedProjects: [], extra: 1 },
    ]) {
      const refused = await sendAsSession(owner, 'PATCH', path, body);
      expect(refused.status).toBe(422);
      expect(await slugOf(refused)).toBe('runner-invalid');
    }
    expect(await scopeAudits()).toBe(0);

    const widened = await sendAsSession(owner, 'PATCH', path, { projectScope: 'all', allowedProjects: [] });
    expect(widened.status).toBe(200);
    const all = (await widened.json()) as RunnerDto;
    expect(all).toMatchObject({ projectScope: 'all', allowedProjects: [] });
    expect(all.servedProjects.map((row) => row.slug)).toContain(project.slug);
    expect(await scopeAudits()).toBe(1);

    const again = await sendAsSession(owner, 'PATCH', path, { projectScope: 'all', allowedProjects: [] });
    expect(again.status).toBe(200);
    expect(await scopeAudits()).toBe(1);

    const narrowed = await sendAsSession(owner, 'PATCH', path, {
      projectScope: 'selected',
      allowedProjects: [],
    });
    expect(narrowed.status).toBe(200);
    expect(((await narrowed.json()) as RunnerDto).servedProjects).toEqual([]);
    expect(await scopeAudits()).toBe(2);
    const detail = await env.DB.prepare(
      `SELECT details FROM audit_events WHERE kind = 'runner.scope-changed' AND target = ?1 ORDER BY id DESC`,
    )
      .bind(mine.id)
      .first<{ details: string }>();
    expect(JSON.parse(detail?.details ?? '{}')).toEqual({
      from: { projectScope: 'all', allowedProjects: [] },
      to: { projectScope: 'selected', allowedProjects: [] },
    });
  });

  // R-SCOPE-4: a hosted or GitHub Actions identity keeps the scope the console gave it.
  it('refuses to change the scope of a hosted or actions-ephemeral runner (422 runner-scope-fixed)', async () => {
    // `hosted` is kept by the 0021 identity trigger, so a hosted row is inserted as H-2 will insert it (the account's
    // subscription projects would refuse `enrolHosted` here, #707); `isolation` is not kept, so the Actions identity is
    // a plain update of a self-hosted row.
    const key = await generateRunnerKey();
    const hostedId = '01M6YSNJ00000000000000H775';
    await env.DB.prepare(
      `INSERT INTO runners (id, account_id, name, public_key_jwk, capabilities, hosted, isolation, allowed_projects, version, enrolled_at)
       VALUES (?1, ?2, 'hosted', ?3, '{"local":false,"maxConcurrency":1,"accessSources":["api_key"]}', 1, 'container', '[]', '0.3.0', ?4)`,
    )
      .bind(hostedId, owner.account.id, JSON.stringify(key.publicKeyJwk), new Date().toISOString())
      .run();
    const ephemeral = await enrolRunner(owner.account.id, { as: owner });
    await env.DB.prepare(`UPDATE runners SET isolation = 'actions-ephemeral' WHERE id = ?1`)
      .bind(ephemeral.id)
      .run();
    for (const id of [hostedId, ephemeral.id]) {
      const refused = await sendAsSession(owner, 'PATCH', `${runnersPath(owner.account.id)}/${id}`, {
        projectScope: 'all',
        allowedProjects: [],
      });
      expect(refused.status).toBe(422);
      expect(await slugOf(refused)).toBe('runner-scope-fixed');
      const row = await env.DB.prepare(`SELECT project_scope FROM runners WHERE id = ?1`)
        .bind(id)
        .first<{ project_scope: string }>();
      expect(row?.project_scope).toBe('selected');
    }
  });

  // #775: the fit badge — a runner declaring a subscription cannot run an API-key project; the list says so.
  it('marks a served project the runner’s declared access sources do not fit', async () => {
    const project = await seedAccountProject(owner.account);
    await setProjectAccessSource(project.slug, 'api_key', owner);
    const mine = await enrolRunner(owner.account.id, {
      as: owner,
      projectScope: 'all',
      enrol: { capabilities: { local: true, maxConcurrency: 1, accessSources: ['subscription'] } },
    });
    const listed = (await (
      await sendAsSession(owner, 'GET', runnersPath(owner.account.id))
    ).json()) as RunnerListDto;
    const dto = listed.runners.find((runner) => runner.id === mine.id);
    expect(dto?.capabilities.accessSources).toEqual(['subscription']);
    expect(dto?.servedProjects).toContainEqual({ slug: project.slug, accessSource: 'api_key', fit: false });
  });

  // #775 (D3): the owner's client words the D3 state from a per-reader flag; nobody's id, login or e-mail is sent.
  it('says enrolledByYou for the owner who enrolled the runner only, with an exact key set', async () => {
    const account = await seedSessionUser('owner');
    const secondId = await seedUser('second-owner');
    await seedMembership(account.account.id, secondId, 'owner');
    const second = { cookie: await seedSession(secondId) };
    const mine = await enrolRunner(account.account.id, { as: account, name: 'enrolled-by-first' });
    const asFirst = await sendAsSession(account, 'GET', runnersPath(account.account.id));
    const firstText = await asFirst.text();
    const firstDto = (JSON.parse(firstText) as RunnerListDto).runners.find((runner) => runner.id === mine.id);
    expect(firstDto?.enrolledByYou).toBe(true);
    expect(Object.keys(firstDto ?? {}).sort()).toEqual([
      'allowedProjects',
      'belowMinimum',
      'capabilities',
      'canWiden',
      'enrolledAt',
      'enrolledByName',
      'enrolledByYou',
      'enroller',
      'host',
      'hosted',
      'id',
      'isolation',
      'lastSeenAt',
      'lastSeenCountry',
      'name',
      'online',
      'pause',
      'pinnedVersion',
      'projectScope',
      'revokedAt',
      'servedProjects',
      'suspect',
      'unattributedProjects',
      'version',
    ]);
    const asSecond = await sendAsSession(second, 'GET', runnersPath(account.account.id));
    const secondText = await asSecond.text();
    expect(
      (JSON.parse(secondText) as RunnerListDto).runners.find((runner) => runner.id === mine.id)
        ?.enrolledByYou,
    ).toBe(false);
    for (const text of [firstText, secondText]) {
      expect(text).not.toContain(account.userId);
      expect(text).not.toContain(secondId);
    }
    // #775 (migration 0038): the enroller's display name once they have one, to both owners; still no id or login.
    expect(firstDto?.enrolledByName).toBeNull();
    await env.DB.prepare(`UPDATE users SET display_name = 'Анна' WHERE id = ?1`).bind(account.userId).run();
    const named = await (await sendAsSession(second, 'GET', runnersPath(account.account.id))).text();
    expect(
      (JSON.parse(named) as RunnerListDto).runners.find((runner) => runner.id === mine.id)?.enrolledByName,
    ).toBe('Анна');
    expect(named).not.toContain(account.userId);
  });

  it('revokes a runner once, inside the account, and its JWT is refused from then on', async () => {
    const mine = await enrolRunner(owner.account.id, { as: owner });
    const theirRunner = await enrolRunner(OWNER_ACCOUNT_ID);
    expect((await sendAsRunner(mine, 'GET', RELEASE)).status).toBe(200);

    const foreign = await sendAsSession(
      owner,
      'POST',
      `${runnersPath(owner.account.id)}/${theirRunner.id}/revoke`,
      {},
    );
    expect(foreign.status).toBe(404);
    expect((await sendAsRunner(theirRunner, 'GET', RELEASE)).status).toBe(200);

    const revoked = await sendAsSession(
      owner,
      'POST',
      `${runnersPath(owner.account.id)}/${mine.id}/revoke`,
      {},
    );
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as RunnerDto).revokedAt).not.toBeNull();
    const again = await sendAsSession(
      owner,
      'POST',
      `${runnersPath(owner.account.id)}/${mine.id}/revoke`,
      {},
    );
    expect(again.status).toBe(409);
    expect(await slugOf(again)).toBe('runner-revoked');

    const call = await sendAsRunner(mine, 'GET', RELEASE);
    expect(call.status).toBe(401);
    expect(await slugOf(call)).toBe('runner-revoked');
    const audit = await env.DB.prepare(
      `SELECT actor_kind, actor FROM audit_events WHERE kind = 'runner.revoked' AND target = ?1`,
    )
      .bind(mine.id)
      .first<{ actor_kind: string; actor: string }>();
    expect(audit).toEqual({ actor_kind: 'user', actor: owner.userId });
  });

  it('shows a suspect runner as such', async () => {
    const mine = await enrolRunner(owner.account.id, { as: owner });
    await sendAsRunner(mine, 'GET', RELEASE, undefined, {
      headers: { 'CF-IPCountry': 'UA', 'CF-Connecting-IP': '198.51.100.1' },
    });
    await sendAsRunner(mine, 'GET', RELEASE, undefined, {
      headers: { 'CF-IPCountry': 'PL', 'CF-Connecting-IP': '198.51.100.1' },
    });
    const response = await sendAsSession(owner, 'GET', runnersPath(owner.account.id));
    const { runners } = (await response.json()) as RunnerListDto;
    expect(runners.find((runner) => runner.id === mine.id)?.suspect).toEqual({
      at: expect.any(String) as string,
      reason: 'new-country',
    });
  });
});

// #795 (owner decision (a)): a subscription runner takes new projects from the owner who enrolled it only; any owner
// may narrow it; a runner that cannot serve a subscription is every owner's to change, as before.
describe('the scope of a subscription runner in a two-owner account', () => {
  let enroller: SessionUser;
  let other: SessionUser;

  beforeAll(async () => {
    enroller = await seedSessionUser('owner');
    const userId = await seedUser('owner');
    await seedMembership(enroller.account.id, userId, 'owner');
    other = { userId, cookie: await seedSession(userId), account: enroller.account };
  });

  const projectOf = async (by: SessionUser): Promise<string> => {
    const { slug } = await seedAccountProject(enroller.account);
    await env.DB.prepare(`UPDATE projects SET created_by = ?2 WHERE slug = ?1`).bind(slug, by.userId).run();
    return slug;
  };
  const patch = (as: SessionUser, runnerId: string, body: unknown): Promise<Response> =>
    sendAsSession(as, 'PATCH', `${runnersPath(enroller.account.id)}/${runnerId}`, body);
  const storedScope = (runnerId: string) =>
    env.DB.prepare(`SELECT project_scope, allowed_projects FROM runners WHERE id = ?1`)
      .bind(runnerId)
      .first<{ project_scope: string; allowed_projects: string }>();
  const scopeAudits = (runnerId: string) =>
    env.DB.prepare(
      `SELECT actor, details FROM audit_events WHERE kind = 'runner.scope-changed' AND target = ?1 ORDER BY id`,
    )
      .bind(runnerId)
      .all<{ actor: string; details: string }>()
      .then((rows) =>
        rows.results.map((row) => ({ actor: row.actor, details: JSON.parse(row.details) as unknown })),
      );

  it('lets the enroller add another owner’s project, and audits it as every scope change', async () => {
    const theirs = await projectOf(other);
    const runner = await enrolRunner(enroller.account.id, { as: enroller, projectScope: 'selected' });
    const response = await patch(enroller, runner.id, {
      projectScope: 'selected',
      allowedProjects: [theirs],
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as RunnerDto).servedProjects.map((row) => row.slug)).toEqual([theirs]);
    expect(await scopeAudits(runner.id)).toEqual([
      {
        actor: enroller.userId,
        details: {
          from: { projectScope: 'selected', allowedProjects: [] },
          to: { projectScope: 'selected', allowedProjects: [theirs] },
        },
      },
    ]);
  });

  it('refuses another owner adding a project, even their own, or widening to all (403 runner-scope-enroller-only)', async () => {
    const mine = await projectOf(enroller);
    const theirs = await projectOf(other);
    const runner = await enrolRunner(enroller.account.id, {
      as: enroller,
      projectScope: 'selected',
      allowedProjects: [mine],
    });
    for (const body of [
      { projectScope: 'selected', allowedProjects: [mine, theirs] },
      { projectScope: 'selected', allowedProjects: [theirs] },
      { projectScope: 'all', allowedProjects: [] },
    ]) {
      const refused = await patch(other, runner.id, body);
      expect(refused.status).toBe(403);
      expect(await slugOf(refused)).toBe('runner-scope-enroller-only');
    }
    expect(await storedScope(runner.id)).toEqual({
      project_scope: 'selected',
      allowed_projects: JSON.stringify([mine]),
    });
    expect(await scopeAudits(runner.id)).toEqual([]);
    // Saving the scope it already has adds nothing: not a refusal.
    expect(
      (await patch(other, runner.id, { projectScope: 'selected', allowedProjects: [mine] })).status,
    ).toBe(200);
  });

  it('lets another owner narrow it, from a list and from all, and audits the change', async () => {
    const mine = await projectOf(enroller);
    const alsoMine = await projectOf(enroller);
    const listed = await enrolRunner(enroller.account.id, {
      as: enroller,
      projectScope: 'selected',
      allowedProjects: [mine, alsoMine],
    });
    const narrowed = await patch(other, listed.id, { projectScope: 'selected', allowedProjects: [alsoMine] });
    expect(narrowed.status).toBe(200);
    expect(await storedScope(listed.id)).toEqual({
      project_scope: 'selected',
      allowed_projects: JSON.stringify([alsoMine]),
    });
    expect(await scopeAudits(listed.id)).toEqual([
      {
        actor: other.userId,
        details: {
          from: { projectScope: 'selected', allowedProjects: [mine, alsoMine] },
          to: { projectScope: 'selected', allowedProjects: [alsoMine] },
        },
      },
    ]);
    expect((await patch(other, listed.id, { projectScope: 'selected', allowedProjects: [] })).status).toBe(
      200,
    );

    // Under `all` (D3) it serves the enroller's projects; another owner may keep some of those, never one of theirs.
    const everything = await enrolRunner(enroller.account.id, { as: enroller, projectScope: 'all' });
    const theirs = await projectOf(other);
    const widening = await patch(other, everything.id, {
      projectScope: 'selected',
      allowedProjects: [mine, theirs],
    });
    expect(widening.status).toBe(403);
    expect(
      (await patch(other, everything.id, { projectScope: 'selected', allowedProjects: [mine] })).status,
    ).toBe(200);
    expect(await storedScope(everything.id)).toEqual({
      project_scope: 'selected',
      allowed_projects: JSON.stringify([mine]),
    });
  });

  // #825: the projects dialog offers adding projects only where the write above would accept it.
  it('says canWiden per reader as the scope write judges it', async () => {
    const canWidenOf = async (as: SessionUser, runnerId: string): Promise<boolean | undefined> =>
      ((await (await sendAsSession(as, 'GET', runnersPath(enroller.account.id))).json()) as RunnerListDto).runners.find(
        (runner) => runner.id === runnerId,
      )?.canWiden;
    const subscription = await enrolRunner(enroller.account.id, { as: enroller, projectScope: 'selected' });
    expect(await canWidenOf(enroller, subscription.id)).toBe(true);
    expect(await canWidenOf(other, subscription.id)).toBe(false);
    const apiKey = await enrolRunner(enroller.account.id, {
      as: enroller,
      projectScope: 'selected',
      enrol: { capabilities: { local: true, maxConcurrency: 1, accessSources: ['api_key'] } },
    });
    expect(await canWidenOf(other, apiKey.id)).toBe(true);
  });

  it('leaves a runner that cannot serve a subscription to every owner, as before', async () => {
    const theirs = await projectOf(other);
    const apiKey = await enrolRunner(enroller.account.id, {
      as: enroller,
      projectScope: 'selected',
      enrol: { capabilities: { local: true, maxConcurrency: 1, accessSources: ['api_key'] } },
    });
    expect(
      (await patch(other, apiKey.id, { projectScope: 'selected', allowedProjects: [theirs] })).status,
    ).toBe(200);
    expect((await patch(other, apiKey.id, { projectScope: 'all', allowedProjects: [] })).status).toBe(200);
  });

  // #824: the guard above is judged at write time; the runner re-declares its access sources on every claim poll.
  it('stops serving another owner’s entries once the runner switches to a subscription, and cancels their live job', async () => {
    // One API-key project, so the runner has a job of it in flight, and the case the finding names: a subscription one.
    const theirKeyed = await projectOf(other);
    await setProjectAccessSource(theirKeyed, 'api_key', other);
    const theirSubscription = await projectOf(other);
    const runner = await enrolRunner(enroller.account.id, {
      as: enroller,
      projectScope: 'selected',
      enrol: { capabilities: { local: true, maxConcurrency: 1, accessSources: ['api_key'] } },
    });
    const listedSlugs = [theirKeyed, theirSubscription];
    expect(
      (await patch(other, runner.id, { projectScope: 'selected', allowedProjects: listedSlugs })).status,
    ).toBe(200);
    const jobId = await enqueueJob(theirKeyed, {}, other);
    const claimed = await sendAsRunner(runner, 'POST', CLAIM, { accessSources: ['api_key'] });
    expect(claimed.status).toBe(200);
    expect(((await claimed.json()) as ClaimResponse).job.id).toBe(jobId);

    await enqueueJob(theirSubscription, {}, other);
    const switched = await sendAsRunner(runner, 'POST', CLAIM, {
      accessSources: ['api_key', 'subscription'],
    });
    // The enroller's subscription takes neither project's job, and the live one is cancelled: D3, not the list (#825).
    expect(switched.status).toBe(204);
    const job = await env.DB.prepare(`SELECT state, result FROM jobs WHERE id = ?1`)
      .bind(jobId)
      .first<{ state: string; result: string }>();
    expect(job).toEqual({ state: 'cancelled', result: JSON.stringify({ reason: 'runner-scope' }) });
    // The entries stay listed (the other owner's choice for an API-key runner); nothing serves them now.
    expect(await storedScope(runner.id)).toEqual({
      project_scope: 'selected',
      allowed_projects: JSON.stringify(listedSlugs),
    });
    const listed = await sendAsSession(enroller, 'GET', runnersPath(enroller.account.id));
    expect(listed.status).toBe(200);
    const row = ((await listed.json()) as RunnerListDto).runners.find((entry) => entry.id === runner.id);
    expect(row?.servedProjects).toEqual([]);
    expect((await sendAsRunner(runner, 'POST', CLAIM, { accessSources: ['subscription'] })).status).toBe(204);
  });

  // #799: a project from before `created_by` (migration 0036) that 0048 could not attribute is nobody's under D3; the
  // card counts it on every runner D3 holds it back from, on the list and on a change's answer.
  it('counts a project with no recorded creator on the subscription runner it is held back from', async () => {
    const runner = await enrolRunner(enroller.account.id, { as: enroller, projectScope: 'all' });
    const apiKey = await enrolRunner(enroller.account.id, {
      as: enroller,
      projectScope: 'all',
      enrol: { capabilities: { local: true, maxConcurrency: 1, accessSources: ['api_key'] } },
    });
    const counted = async (): Promise<Record<string, number | undefined>> => {
      const listed = await sendAsSession(enroller, 'GET', runnersPath(enroller.account.id));
      expect(listed.status).toBe(200);
      const rows = ((await listed.json()) as RunnerListDto).runners;
      return Object.fromEntries(
        [runner.id, apiKey.id].map((id) => [id, rows.find((row) => row.id === id)?.unattributedProjects]),
      );
    };
    const before = (await counted())[runner.id] ?? 0;
    const { slug: legacy } = await seedAccountProject(enroller.account);
    await env.DB.prepare(`UPDATE projects SET created_by = NULL WHERE slug = ?1`).bind(legacy).run();

    expect(await counted()).toEqual({ [runner.id]: before + 1, [apiKey.id]: 0 });
    const narrowed = await patch(enroller, runner.id, {
      projectScope: 'selected',
      allowedProjects: [legacy],
    });
    expect(narrowed.status).toBe(200);
    // Chosen by its enroller, the entry is theirs: served, so no longer a gap.
    const dto = (await narrowed.json()) as RunnerDto;
    expect(dto.servedProjects.map((row) => row.slug)).toEqual([legacy]);
    expect(dto.unattributedProjects).toBe(0);
  });
});

// #827 (owner decision (a)): a runner from before `enrolled_by` (migration 0036) is claimed by the sole owner, audited.
describe('claim a runner as its enroller', () => {
  let legacyCount = 0;

  /** A runner row as enrolments wrote it before 0036: no enroller. */
  async function legacyRunner(accountId: string): Promise<string> {
    legacyCount += 1;
    const id = `01M6YSNJ00000000000827R${String(legacyCount).padStart(3, '0')}`;
    const { publicKeyJwk } = await generateRunnerKey();
    await env.DB.prepare(
      `INSERT INTO runners (id, account_id, name, public_key_jwk, host, capabilities, isolation, allowed_projects, version, enrolled_at, hosted, project_scope, enrolled_by)
       VALUES (?1, ?2, 'Mac', ?3, '{"os":"darwin","arch":"arm64","hostname":"mac.local"}', '{"local":true,"maxConcurrency":1}', 'user', '[]', '0.1.0', '2026-11-01T00:00:00.000Z', 0, 'selected', NULL)`,
    )
      .bind(id, accountId, JSON.stringify(publicKeyJwk))
      .run();
    return id;
  }

  const claim = (
    as: SessionUser,
    runnerId: string,
    accountId: string = as.account.id,
    extra = {},
  ): Promise<Response> =>
    sendAsSession(as, 'POST', `${runnersPath(accountId)}/${runnerId}/claim-enroller`, undefined, extra);
  const enrollerOf = (runnerId: string): Promise<string | null> =>
    env.DB.prepare(`SELECT enrolled_by FROM runners WHERE id = ?1`)
      .bind(runnerId)
      .first<string | null>('enrolled_by');
  const claimAudits = (runnerId: string) =>
    env.DB.prepare(
      `SELECT actor, actor_kind, details FROM audit_events WHERE kind = 'runner.enroller-claimed' AND target = ?1`,
    )
      .bind(runnerId)
      .all<{ actor: string; actor_kind: string; details: string }>()
      .then((rows) => rows.results);
  const listedOf = async (as: SessionUser, runnerId: string): Promise<RunnerDto | undefined> => {
    const list = (await (await sendAsSession(as, 'GET', runnersPath(as.account.id))).json()) as RunnerListDto;
    return list.runners.find((runner) => runner.id === runnerId);
  };
  const listedEnroller = async (as: SessionUser, runnerId: string): Promise<string | undefined> =>
    (await listedOf(as, runnerId))?.enroller;

  it('lets the sole owner claim it once: the list offers it, the claim records them and audits it', async () => {
    const owner = await seedSessionUser('owner');
    const runnerId = await legacyRunner(owner.account.id);
    expect(await listedEnroller(owner, runnerId)).toBe('claimable');
    // #825: the scope write counts it as the sole owner's, so the list offers adding projects too.
    expect((await listedOf(owner, runnerId))?.canWiden).toBe(true);

    const response = await claim(owner, runnerId);
    expect(response.status).toBe(200);
    expect(((await response.json()) as RunnerDto).enroller).toBe('recorded');
    expect(await enrollerOf(runnerId)).toBe(owner.userId);
    expect(await claimAudits(runnerId)).toEqual([
      { actor: owner.userId, actor_kind: 'user', details: JSON.stringify({ basis: 'sole-owner' }) },
    ]);
    expect(await listedEnroller(owner, runnerId)).toBe('recorded');

    const again = await claim(owner, runnerId);
    expect(again.status).toBe(409);
    expect(await slugOf(again)).toBe('runner-enroller-set');
    expect(await claimAudits(runnerId)).toHaveLength(1);
  });

  it('refuses every owner once a second owner exists (403 runner-enroller-not-sole-owner)', async () => {
    const owner = await seedSessionUser('owner');
    const secondId = await seedUser('owner');
    await seedMembership(owner.account.id, secondId, 'owner');
    const second: SessionUser = {
      userId: secondId,
      cookie: await seedSession(secondId),
      account: owner.account,
    };
    const runnerId = await legacyRunner(owner.account.id);
    expect(await listedEnroller(owner, runnerId)).toBe('unrecorded');
    // #825: and nobody's to widen, as `setScope` judges it.
    expect((await listedOf(owner, runnerId))?.canWiden).toBe(false);
    expect((await listedOf(second, runnerId))?.canWiden).toBe(false);
    for (const as of [owner, second]) {
      const refused = await claim(as, runnerId);
      expect(refused.status).toBe(403);
      expect(await slugOf(refused)).toBe('runner-enroller-not-sole-owner');
    }
    expect(await enrollerOf(runnerId)).toBeNull();
    expect(await claimAudits(runnerId)).toEqual([]);
  });

  it('refuses a runner whose enroller is recorded, and a revoked one', async () => {
    const owner = await seedSessionUser('owner');
    const recorded = await enrolRunner(owner.account.id, { as: owner });
    expect(await listedEnroller(owner, recorded.id)).toBe('recorded');
    const refused = await claim(owner, recorded.id);
    expect(refused.status).toBe(409);
    expect(await slugOf(refused)).toBe('runner-enroller-set');

    const revoked = await legacyRunner(owner.account.id);
    await sendAsSession(owner, 'POST', `${runnersPath(owner.account.id)}/${revoked}/revoke`, {});
    expect(await listedEnroller(owner, revoked)).toBe('not-applicable');
    const onRevoked = await claim(owner, revoked);
    expect(onRevoked.status).toBe(409);
    expect(await slugOf(onRevoked)).toBe('runner-revoked');
    expect(await enrollerOf(revoked)).toBeNull();
  });

  it('answers another account’s runner exactly as a missing one, and a member 403', async () => {
    const owner = await seedSessionUser('owner');
    const runnerId = await legacyRunner(owner.account.id);
    const stranger = await seedSessionUser('owner');

    // Through the stranger's own account: their runner list holds no such id, the same answer as an unknown one.
    const foreign = await claim(stranger, runnerId);
    const missing = await claim(stranger, '01M6YSNJ00000000000827RZZZ');
    expect([foreign.status, missing.status]).toEqual([404, 404]);
    const bodyOf = async (response: Response) => {
      const { type, title, status, detail } = (await response.json()) as Record<string, unknown>;
      return { type, title, status, detail };
    };
    expect(await bodyOf(foreign)).toEqual(await bodyOf(missing));
    expect(await slugOf(await claim(stranger, 'not-a-runner'))).toBe('runner-not-found');
    // Through the owner's account: the stranger is no member there.
    const outside = await claim(stranger, runnerId, owner.account.id);
    expect(outside.status).toBe(404);
    expect(await slugOf(outside)).toBe('account-not-found');

    const memberId = await seedUser('member');
    await seedMembership(owner.account.id, memberId, 'member');
    const asMember = await claim(
      { userId: memberId, cookie: await seedSession(memberId), account: owner.account },
      runnerId,
    );
    expect(asMember.status).toBe(403);
    expect(await slugOf(asMember)).toBe('account-owner-only');
    expect(await enrollerOf(runnerId)).toBeNull();
    expect(await claimAudits(runnerId)).toEqual([]);
  });

  it('refuses a cross-site write with 403 csrf and writes nothing', async () => {
    const owner = await seedSessionUser('owner');
    const runnerId = await legacyRunner(owner.account.id);
    const crossSite = await claim(owner, runnerId, owner.account.id, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
    expect(await slugOf(crossSite)).toBe('csrf');
    expect(await enrollerOf(runnerId)).toBeNull();
  });

  it('answers two concurrent claims with one 200 and one 409, audited once', async () => {
    const owner = await seedSessionUser('owner');
    const runnerId = await legacyRunner(owner.account.id);
    const statuses = (await Promise.all([claim(owner, runnerId), claim(owner, runnerId)])).map(
      (response) => response.status,
    );
    expect(statuses.sort()).toEqual([200, 409]);
    expect(await claimAudits(runnerId)).toHaveLength(1);
  });

  // #840: the 422 a hosted runner answers, at the HTTP level.
  it('refuses a hosted runner with 422 runner-enroller-fixed, naming the field', async () => {
    const owner = await seedSessionUser('owner');
    const key = await generateRunnerKey();
    const hostedId = '01M6YSNJ00000000000000H840';
    await env.DB.prepare(
      `INSERT INTO runners (id, account_id, name, public_key_jwk, capabilities, hosted, isolation, allowed_projects, version, enrolled_at)
       VALUES (?1, ?2, 'hosted', ?3, '{"local":false,"maxConcurrency":1,"accessSources":["api_key"]}', 1, 'container', '[]', '0.3.0', ?4)`,
    )
      .bind(hostedId, owner.account.id, JSON.stringify(key.publicKeyJwk), new Date().toISOString())
      .run();
    const refused = await claim(owner, hostedId);
    expect(refused.status).toBe(422);
    expect(await slugOf(refused)).toBe('runner-enroller-fixed');
    const { status, title, field } = (await refused.json()) as Record<string, unknown>;
    expect({ status, title, field }).toEqual({ status: 422, title: 'Invalid request', field: 'runner' });
    expect(await enrollerOf(hostedId)).toBeNull();
    expect(await claimAudits(hostedId)).toEqual([]);
  });

  // #837 (option A): the Access owner before the GitHub link has no owner row, so beside one other owner's row the count
  // alone would make them "sole". They are offered nothing and refused; and their shared audit name is nobody's "you".
  it('refuses the Access owner before the link (403 runner-enroller-unlinked) and never says enrolled by you', async () => {
    const jwks = stubJwksServer();
    try {
      const teamDomain = uniqueTeamDomain();
      const signing = await createSigningKey();
      jwks.set(teamDomain, { keys: [signing.publicJwk] });
      // A subject no user row is linked to.
      const token = await signAccessToken(signing, teamDomain, {
        subject: `unlinked-${crypto.randomUUID()}`,
      });
      const bindings = accessEnv(teamDomain);
      const asAccess = (method: 'GET' | 'POST', path: string) =>
        fetchApi(path, bindings, {
          method,
          headers: {
            'Cf-Access-Jwt-Assertion': token,
            ...(method === 'POST' ? { 'Sec-Fetch-Site': 'same-origin' } : {}),
          },
        });
      const legacy = await legacyRunner(OWNER_ACCOUNT_ID);
      const viaDoor = await legacyRunner(OWNER_ACCOUNT_ID);
      await env.DB.prepare(`UPDATE runners SET enrolled_by = 'access-owner' WHERE id = ?1`)
        .bind(viaDoor)
        .run();

      const listed = await asAccess('GET', runnersPath(OWNER_ACCOUNT_ID));
      expect(listed.status).toBe(200);
      const runners = ((await listed.json()) as RunnerListDto).runners;
      expect(runners.find((runner) => runner.id === legacy)?.enroller).toBe('unrecorded');
      expect(runners.find((runner) => runner.id === viaDoor)?.enrolledByYou).toBe(false);

      const refused = await asAccess('POST', `${runnersPath(OWNER_ACCOUNT_ID)}/${legacy}/claim-enroller`);
      expect(refused.status).toBe(403);
      expect(await slugOf(refused)).toBe('runner-enroller-unlinked');
      expect(await enrollerOf(legacy)).toBeNull();
      expect(await claimAudits(legacy)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// #492: the owner clears a suspect mark and withdraws a pending enrolment code, inside the account only.
describe('clear a suspect mark', () => {
  let owner: SessionUser;

  beforeAll(async () => {
    owner = await seedSessionUser('owner');
  });

  async function suspectRunner(accountOwner: SessionUser = owner): Promise<TestRunner> {
    const runner = await enrolRunner(accountOwner.account.id, { as: accountOwner });
    await sendAsRunner(runner, 'GET', RELEASE, undefined, { headers: { 'CF-IPCountry': 'UA' } });
    await sendAsRunner(runner, 'GET', RELEASE, undefined, { headers: { 'CF-IPCountry': 'PL' } });
    return runner;
  }

  const clear = (runnerId: string, as: SessionUser = owner): Promise<Response> =>
    sendAsSession(as, 'POST', `${runnersPath(as.account.id)}/${runnerId}/clear-suspect`, {});

  it('clears the mark once with an audit row, and the next sighting judges the runner afresh', async () => {
    const runner = await suspectRunner();
    const response = await clear(runner.id);
    expect(response.status).toBe(200);
    expect(((await response.json()) as RunnerDto).suspect).toBeNull();

    const again = await clear(runner.id);
    expect(again.status).toBe(409);
    expect(await slugOf(again)).toBe('runner-not-suspect');
    const audits = await env.DB.prepare(
      `SELECT actor, details FROM audit_events WHERE kind = 'runner.suspect-cleared' AND target = ?1`,
    )
      .bind(runner.id)
      .all<{ actor: string; details: string }>();
    expect(audits.results).toHaveLength(1);
    expect(audits.results[0]?.actor).toBe(owner.userId);
    expect(JSON.parse(audits.results[0]?.details ?? '{}')).toMatchObject({ reason: 'new-country' });

    // A country it was seen from before is no new country; a third one marks it again.
    await sendAsRunner(runner, 'GET', RELEASE, undefined, { headers: { 'CF-IPCountry': 'UA' } });
    expect((await clear(runner.id)).status).toBe(409);
    await sendAsRunner(runner, 'GET', RELEASE, undefined, { headers: { 'CF-IPCountry': 'DE' } });
    expect((await clear(runner.id)).status).toBe(200);
  });

  it('answers two concurrent clears with one 200 and one 409', async () => {
    const runner = await suspectRunner();
    const statuses = (await Promise.all([clear(runner.id), clear(runner.id)])).map(
      (response) => response.status,
    );
    expect(statuses.sort()).toEqual([200, 409]);
    const audits = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'runner.suspect-cleared' AND target = ?1`,
    )
      .bind(runner.id)
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it('refuses a runner that is not suspect, a revoked one, another account’s and a member', async () => {
    const calm = await enrolRunner(owner.account.id, { as: owner });
    expect(await slugOf(await clear(calm.id))).toBe('runner-not-suspect');

    const revoked = await suspectRunner();
    await sendAsSession(owner, 'POST', `${runnersPath(owner.account.id)}/${revoked.id}/revoke`, {});
    const onRevoked = await clear(revoked.id);
    expect(onRevoked.status).toBe(409);
    expect(await slugOf(onRevoked)).toBe('runner-revoked');

    const stranger = await seedSessionUser('owner');
    const foreign = await clear((await suspectRunner()).id, stranger);
    expect(foreign.status).toBe(404);
    expect(await slugOf(foreign)).toBe('runner-not-found');

    const memberId = await seedUser('member');
    await seedMembership(owner.account.id, memberId, 'member');
    const asMember = await sendAsSession(
      { cookie: await seedSession(memberId) },
      'POST',
      `${runnersPath(owner.account.id)}/${calm.id}/clear-suspect`,
      {},
    );
    expect(asMember.status).toBe(403);
  });
});

describe('withdraw a pending enrolment code', () => {
  let owner: SessionUser;

  beforeAll(async () => {
    owner = await seedSessionUser('owner');
  });

  const pendingOf = async (as: SessionUser): Promise<RunnerListDto['pendingEnrolments']> =>
    ((await (await sendAsSession(as, 'GET', runnersPath(as.account.id))).json()) as RunnerListDto)
      .pendingEnrolments;
  const withdraw = (id: string, as: SessionUser = owner): Promise<Response> =>
    sendAsSession(as, 'POST', `${runnersPath(as.account.id)}/enrolment-codes/${id}/withdraw`, {});

  it('lists the pending code without the code, withdraws it once, and the code no longer enrols', async () => {
    const issued = await createEnrolmentCode(owner.account.id, { name: 'Laptop' }, owner);
    const listed = await sendAsSession(owner, 'GET', runnersPath(owner.account.id));
    const text = await listed.text();
    expect(text).not.toContain(issued.code);
    const id = await sha256Hex(issued.code);
    expect((JSON.parse(text) as RunnerListDto).pendingEnrolments).toContainEqual({
      id,
      name: 'Laptop',
      projectScope: 'selected',
      allowedProjects: [],
      createdAt: expect.any(String) as string,
      expiresAt: issued.expiresAt,
    });

    expect((await withdraw(id)).status).toBe(204);
    expect((await pendingOf(owner)).map((row) => row.id)).not.toContain(id);
    const again = await withdraw(id);
    expect(again.status).toBe(404);
    expect(await slugOf(again)).toBe('enrolment-not-found');
    const key = await generateRunnerKey();
    const enrol = await postEnrol(enrolBodyOf(issued.code, key.publicKeyJwk));
    expect(enrol.status).toBe(401);
    expect(await slugOf(enrol)).toBe('enrolment-code-invalid');

    const audits = await env.DB.prepare(
      `SELECT actor, details FROM audit_events WHERE kind = 'enrolment-code.withdrawn' AND account_id = ?1`,
    )
      .bind(owner.account.id)
      .all<{ actor: string; details: string }>();
    expect(audits.results).toHaveLength(1);
    expect(audits.results[0]?.actor).toBe(owner.userId);
  });

  it('refuses a used code, an expired one, another account’s, a malformed id and a member', async () => {
    const used = await createEnrolmentCode(owner.account.id, {}, owner);
    const key = await generateRunnerKey();
    expect((await postEnrol(enrolBodyOf(used.code, key.publicKeyJwk))).status).toBe(201);
    expect((await withdraw(await sha256Hex(used.code))).status).toBe(404);

    const expiredId = 'e0'.repeat(32);
    await env.DB.prepare(
      `INSERT INTO runner_enrolments (code_hash, account_id, name, created_by, created_at, expires_at)
       VALUES (?1, ?2, 'old', 'owner', '2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z')`,
    )
      .bind(expiredId, owner.account.id)
      .run();
    expect((await pendingOf(owner)).map((row) => row.id)).not.toContain(expiredId);
    expect((await withdraw(expiredId)).status).toBe(404);

    const stranger = await seedSessionUser('owner');
    const theirs = await createEnrolmentCode(stranger.account.id, {}, stranger);
    const theirsId = await sha256Hex(theirs.code);
    expect((await pendingOf(owner)).map((row) => row.id)).not.toContain(theirsId);
    const foreign = await withdraw(theirsId);
    expect(foreign.status).toBe(404);
    expect((await pendingOf(stranger)).map((row) => row.id)).toContain(theirsId);

    expect((await withdraw('not-a-hash')).status).toBe(404);

    const memberId = await seedUser('member');
    await seedMembership(owner.account.id, memberId, 'member');
    const pending = await createEnrolmentCode(owner.account.id, {}, owner);
    const asMember = await sendAsSession(
      { cookie: await seedSession(memberId) },
      'POST',
      `${runnersPath(owner.account.id)}/enrolment-codes/${await sha256Hex(pending.code)}/withdraw`,
      {},
    );
    expect(asMember.status).toBe(403);
    expect((await pendingOf(owner)).map((row) => row.id)).toContain(await sha256Hex(pending.code));
  });
});
