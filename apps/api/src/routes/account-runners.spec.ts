import { env } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID, type EnrolmentCodeDto, type RunnerDto, type RunnerListDto } from '@shared/contracts';
import { ENROLMENT_CODE_PREFIX } from '@shared/redaction';
import { accessEnv, uniqueTeamDomain } from '../testing/access-kit';
import { enrolRunner, sendAsRunner } from '../testing/runner-kit';
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
const runnersPath = (accountId: string): string => `/api/v1/accounts/${accountId}/runners`;

describe('enrolment codes', () => {
  it('gives the owner a one-time code for the account’s projects and audits it without the code', async () => {
    const project = await seedTrackerProject();
    const response = await send('POST', `${runnersPath(OWNER_ACCOUNT_ID)}/enrolment-code`, {
      name: 'Mac',
      allowedProjects: [project.slug],
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as EnrolmentCodeDto;
    expect(body).toMatchObject({ name: 'Mac', allowedProjects: [project.slug], apiUrl: 'http://api.test' });
    expect(body.code.startsWith(ENROLMENT_CODE_PREFIX)).toBe(true);
    const audit = await env.DB.prepare(
      `SELECT details FROM audit_events WHERE kind = 'enrolment-code.created' AND account_id = ?1 ORDER BY id DESC`,
    )
      .bind(OWNER_ACCOUNT_ID)
      .first<{ details: string }>();
    expect(audit?.details).not.toContain(body.code.slice(ENROLMENT_CODE_PREFIX.length));
    expect(JSON.parse(audit?.details ?? '{}')).toMatchObject({ name: 'Mac', allowedProjects: [project.slug] });
    const stored = await env.DB.prepare(`SELECT code_hash FROM runner_enrolments ORDER BY created_at DESC`).first<{
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
        allowedProjects: [mine.slug, slug],
      });
      expect(response.status).toBe(422);
      expect(await slugOf(response)).toBe('allowed-projects-invalid');
      expect(await response.text()).not.toContain(theirs.slug);
    }
    const ok = await sendAsSession(owner, 'POST', `${runnersPath(owner.account.id)}/enrolment-code`, {
      name: 'x',
      allowedProjects: [mine.slug],
    });
    expect(ok.status).toBe(201);
  });

  it.each([
    ['a missing name', { allowedProjects: [] }, 'name'],
    ['a blank name', { name: '   ', allowedProjects: [] }, 'name'],
    ['a malformed slug', { name: 'x', allowedProjects: ['Not A Slug'] }, 'allowedProjects'],
  ])('refuses %s with 422', async (_, body, field) => {
    const response = await send('POST', `${runnersPath(OWNER_ACCOUNT_ID)}/enrolment-code`, body);
    expect(response.status).toBe(422);
    expect(((await response.json()) as { field: string }).field).toBe(field);
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

    const response = await sendAsSession(owner, 'GET', runnersPath(owner.account.id), undefined, {}, bindings);
    expect(response.status).toBe(200);
    const body = (await response.json()) as RunnerListDto;
    expect(body.release).toEqual({ version: '0.3.0', minimumVersion: '0.2.0-rc.1' });
    const flagOf = (id: string): boolean | undefined => body.runners.find((runner) => runner.id === id)?.belowMinimum;
    expect([flagOf(behind.id), flagOf(current.id), flagOf(unlabelled.id)]).toEqual([true, false, true]);

    const patched = await sendAsSession(
      owner,
      'PATCH',
      `${runnersPath(owner.account.id)}/${behind.id}`,
      { allowedProjects: [] },
      {},
      bindings,
    );
    expect(((await patched.json()) as RunnerDto).belowMinimum).toBe(true);

    // No minimum configured (the deployed default): nothing is behind, and the release reads as unknown.
    const unset = (await (await sendAsSession(owner, 'GET', runnersPath(owner.account.id))).json()) as RunnerListDto;
    expect(unset.release).toEqual({ version: null, minimumVersion: null });
    expect(unset.runners.every((runner) => !runner.belowMinimum)).toBe(true);
  });

  it('changes allowed projects inside the account and refuses foreign slugs and foreign runners', async () => {
    const mine = await enrolRunner(owner.account.id, { as: owner });
    const project = await seedAccountProject(owner.account);
    const theirs = await seedTrackerProject();
    const theirRunner = await enrolRunner(OWNER_ACCOUNT_ID);

    const ok = await sendAsSession(owner, 'PATCH', `${runnersPath(owner.account.id)}/${mine.id}`, {
      allowedProjects: [project.slug],
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as RunnerDto).allowedProjects).toEqual([project.slug]);

    const foreignSlug = await sendAsSession(owner, 'PATCH', `${runnersPath(owner.account.id)}/${mine.id}`, {
      allowedProjects: [theirs.slug],
    });
    expect(foreignSlug.status).toBe(422);
    expect(await slugOf(foreignSlug)).toBe('allowed-projects-invalid');

    const foreignRunner = await sendAsSession(owner, 'PATCH', `${runnersPath(owner.account.id)}/${theirRunner.id}`, {
      allowedProjects: [project.slug],
    });
    expect(foreignRunner.status).toBe(404);
    expect(await slugOf(foreignRunner)).toBe('runner-not-found');
    const unchanged = await env.DB.prepare(`SELECT allowed_projects FROM runners WHERE id = ?1`)
      .bind(theirRunner.id)
      .first<{ allowed_projects: string }>();
    expect(unchanged?.allowed_projects).toBe('[]');

    const malformed = await sendAsSession(owner, 'PATCH', `${runnersPath(owner.account.id)}/not-an-id`, {
      allowedProjects: [],
    });
    expect(malformed.status).toBe(404);
    const audit = await env.DB.prepare(
      `SELECT details FROM audit_events WHERE kind = 'runner.updated' AND target = ?1`,
    )
      .bind(mine.id)
      .first<{ details: string }>();
    expect(JSON.parse(audit?.details ?? '{}')).toEqual({ allowedProjects: [project.slug], before: [] });
  });

  it('revokes a runner once, inside the account, and its JWT is refused from then on', async () => {
    const mine = await enrolRunner(owner.account.id, { as: owner });
    const theirRunner = await enrolRunner(OWNER_ACCOUNT_ID);
    expect((await sendAsRunner(mine, 'GET', RELEASE)).status).toBe(200);

    const foreign = await sendAsSession(owner, 'POST', `${runnersPath(owner.account.id)}/${theirRunner.id}/revoke`, {});
    expect(foreign.status).toBe(404);
    expect((await sendAsRunner(theirRunner, 'GET', RELEASE)).status).toBe(200);

    const revoked = await sendAsSession(owner, 'POST', `${runnersPath(owner.account.id)}/${mine.id}/revoke`, {});
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as RunnerDto).revokedAt).not.toBeNull();
    const again = await sendAsSession(owner, 'POST', `${runnersPath(owner.account.id)}/${mine.id}/revoke`, {});
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
