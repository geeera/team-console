import { env } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID } from '@shared/contracts';
import { RunnersRepo } from './runners.repo';

// #838 (migration 0042): what the Access owner made before the GitHub link is theirs after it, so D3 still matches it.
const T0 = '2026-11-22T10:00:00.000Z';
const ACCESS_OWNER = '01M6YSNJ0000000000000838E1';
const SECOND_OWNER = '01M6YSNJ0000000000000838E2';
const STRANGER = '01M6YSNJ0000000000000838E3';
const OTHER_ACCOUNT = '01M6YSNJ0000000000000838A2';
const KEY = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43) });

let runners = 0;
async function runner(enrolledBy: string | null, accountId: string = OWNER_ACCOUNT_ID): Promise<string> {
  runners += 1;
  const id = `01M6YSNJ0000000000000838R${String(runners)}`;
  // `all`, declaring no access source: the subscription-capable kind D3 holds back in a two-owner account.
  await env.DB.prepare(
    `INSERT INTO runners (id, account_id, name, public_key_jwk, host, capabilities, isolation, allowed_projects, version, enrolled_at, project_scope, enrolled_by)
     VALUES (?1, ?2, 'mac', ?3, '{"os":"darwin","arch":"arm64","hostname":"mac"}', '{"local":true,"maxConcurrency":1}', 'user', '[]', '0.1.0', ?4, 'all', ?5)`,
  )
    .bind(id, accountId, KEY, T0, enrolledBy)
    .run();
  return id;
}

async function project(slug: string, createdBy: string, accountId: string = OWNER_ACCOUNT_ID): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO projects (slug, repo, display_name, added_at, account_id, created_by) VALUES (?1, ?2, ?1, ?3, ?4, ?5)`,
  )
    .bind(slug, `acme/${slug}`, T0, accountId, createdBy)
    .run();
}

async function user(id: string, providerUserId: string, accessSubject: string | null = null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, provider, provider_user_id, login, access_subject, created_at, last_seen_at) VALUES (?1, 'github', ?2, ?2, ?3, ?4, ?4)`,
  )
    .bind(id, providerUserId, accessSubject, T0)
    .run();
}

const link = (id: string, subject: string) =>
  env.DB.prepare(`UPDATE users SET access_subject = ?2 WHERE id = ?1`).bind(id, subject).run();
const enrollerOf = (id: string) =>
  env.DB.prepare(`SELECT enrolled_by FROM runners WHERE id = ?1`).bind(id).first<string | null>('enrolled_by');
const creatorOf = (slug: string) =>
  env.DB.prepare(`SELECT created_by FROM projects WHERE slug = ?1`).bind(slug).first<string | null>('created_by');
const adoptions = () =>
  env.DB.prepare(`SELECT actor_kind, actor, target, details FROM audit_events WHERE kind = 'auth.access-actor-adopted'`)
    .all<{ actor_kind: string; actor: string; target: string; details: string }>()
    .then((rows) => rows.results);

describe('the Access–GitHub link adopts the access-owner actor (#838)', () => {
  const repo = new RunnersRepo(env.DB);
  const served = async (runnerId: string) => (await repo.servedProjectsOf(OWNER_ACCOUNT_ID, runnerId)).map((p) => p.slug);

  beforeAll(async () => {
    await env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'acc-838', 'Other', ?2)`)
      .bind(OTHER_ACCOUNT, T0)
      .run();
    await user(ACCESS_OWNER, '838001');
    await user(SECOND_OWNER, '838002');
    for (const owner of [ACCESS_OWNER, SECOND_OWNER]) {
      await env.DB.prepare(`INSERT INTO account_members (account_id, user_id, role, joined_at) VALUES (?1, ?2, 'owner', ?3)`)
        .bind(OWNER_ACCOUNT_ID, owner, T0)
        .run();
    }
  });

  it('keeps the owner’s runner serving the owner’s projects once they link, audited once', async () => {
    // Enrolled and created through the Access door before the link.
    const mine = await runner('access-owner');
    const other = await runner(SECOND_OWNER);
    const elsewhere = await runner('access-owner', OTHER_ACCOUNT);
    await project('p838-early', 'access-owner');
    await project('p838-theirs', SECOND_OWNER);
    await project('p838-elsewhere', 'access-owner', OTHER_ACCOUNT);
    expect(await served(mine)).toEqual(['p838-early']);

    await link(ACCESS_OWNER, 'access-sub-838');
    // After the link the owner acts as their user id: a project they create now names it.
    await project('p838-late', ACCESS_OWNER);

    expect(await enrollerOf(mine)).toBe(ACCESS_OWNER);
    expect(await creatorOf('p838-early')).toBe(ACCESS_OWNER);
    expect(await served(mine)).toEqual(['p838-early', 'p838-late']);
    // D3 still holds the other owner's project back, and nothing outside the owner's account moved.
    expect(await enrollerOf(other)).toBe(SECOND_OWNER);
    expect(await enrollerOf(elsewhere)).toBe('access-owner');
    expect(await creatorOf('p838-elsewhere')).toBe('access-owner');
    expect(await adoptions()).toEqual([
      { actor_kind: 'system', actor: 'access-link', target: ACCESS_OWNER, details: JSON.stringify({ runners: 1, projects: 1 }) },
    ]);

    // A code the owner made before the link becomes a runner after it: the runner is the linked user's.
    expect(await enrollerOf(await runner('access-owner'))).toBe(ACCESS_OWNER);
  });

  it('still refuses every other change of a recorded enroller', async () => {
    const mine = await runner(ACCESS_OWNER);
    const update = (by: string) =>
      env.DB.prepare(`UPDATE runners SET enrolled_by = ?2 WHERE id = ?1`).bind(mine, by).run();
    await expect(update(SECOND_OWNER)).rejects.toThrow(/runners keep their identity/u);
    await expect(update('access-owner')).rejects.toThrow(/runners keep their identity/u);
    const legacy = await runner('access-owner', OTHER_ACCOUNT);
    await expect(
      env.DB.prepare(`UPDATE runners SET enrolled_by = ?2 WHERE id = ?1`).bind(legacy, ACCESS_OWNER).run(),
    ).rejects.toThrow(/runners keep their identity/u);
    await expect(
      env.DB.prepare(`UPDATE runners SET enrolled_by = ?2 WHERE id = ?1`).bind(await runner('access-owner'), STRANGER).run(),
    ).rejects.toThrow(/runners keep their identity/u);
  });

  it('hands nothing over once a second user is linked: nobody can tell which is the Access owner', async () => {
    await user(STRANGER, '838003', 'access-sub-838-b');
    const before = (await adoptions()).length;
    const stale = await runner('access-owner');
    expect(await enrollerOf(stale)).toBe('access-owner');
    await expect(
      env.DB.prepare(`UPDATE runners SET enrolled_by = ?2 WHERE id = ?1`).bind(stale, ACCESS_OWNER).run(),
    ).rejects.toThrow(/runners keep their identity/u);
    expect(await adoptions()).toHaveLength(before);
  });
});
