import { env } from 'cloudflare:test';
import type { NewAuditEvent } from '../accounts/audit.repo';
import { RunnersRepo } from './runners.repo';

// #492: the 0023 guards on `role_keys`, directly against D1 (no repo writes role keys before 2-C).

const ACCOUNT = '01M6YSNJ00000000000000RKA1';
const T0 = '2026-11-12T10:00:00.000Z';
const T1 = '2026-11-12T10:05:00.000Z';
const KEY = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'k'.repeat(43) });
const OTHER_KEY = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'o'.repeat(43) });

let counter = 0;
async function runner(): Promise<string> {
  counter += 1;
  const id = `01M6YSNJ0000000000RK${String(counter).padStart(6, '0')}`;
  await env.DB.prepare(
    `INSERT INTO runners (id, account_id, name, public_key_jwk, isolation, version, enrolled_at)
     VALUES (?1, ?2, 'r', ?3, 'user', '0.1.0', ?4)`,
  )
    .bind(id, ACCOUNT, KEY, T0)
    .run();
  return id;
}

async function roleKey(runnerId: string, role = 'dev', revokedAt: string | null = null): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO role_keys (runner_id, role, public_key_jwk, created_at, revoked_at) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id`,
  )
    .bind(runnerId, role, KEY, T0, revokedAt)
    .first<{ id: number }>();
  if (row === null) {
    throw new Error('no role key row');
  }
  return row.id;
}

const keyOf = (id: number): Promise<{ role: string; public_key_jwk: string; revoked_at: string | null } | null> =>
  env.DB.prepare(`SELECT role, public_key_jwk, revoked_at FROM role_keys WHERE id = ?1`)
    .bind(id)
    .first<{ role: string; public_key_jwk: string; revoked_at: string | null }>();

const audit: NewAuditEvent = { accountId: ACCOUNT, at: T1, actorKind: 'user', actor: 'owner', kind: 'runner.revoked', target: null };

beforeAll(async () => {
  await env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'rk-a', 'A', ?2)`).bind(ACCOUNT, T0).run();
});

describe('role_keys guards (0023)', () => {
  it.each([
    ['the key', `public_key_jwk = '${OTHER_KEY}'`],
    ['the role', `role = 'qa'`],
    ['the creation time', `created_at = '${T1}'`],
  ])('refuses a change of %s', async (_, assignment) => {
    const id = await roleKey(await runner());
    await expect(env.DB.prepare(`UPDATE role_keys SET ${assignment} WHERE id = ?1`).bind(id).run()).rejects.toThrow(
      /role keys keep their identity/,
    );
    expect(await keyOf(id)).toMatchObject({ role: 'dev', public_key_jwk: KEY });
  });

  it('refuses moving a key to another runner', async () => {
    const id = await roleKey(await runner());
    const other = await runner();
    await expect(env.DB.prepare(`UPDATE role_keys SET runner_id = ?2 WHERE id = ?1`).bind(id, other).run()).rejects.toThrow(
      /role keys keep their identity/,
    );
  });

  it('revokes a key once: neither un-revoked nor re-dated', async () => {
    const id = await roleKey(await runner());
    await env.DB.prepare(`UPDATE role_keys SET revoked_at = ?2 WHERE id = ?1`).bind(id, T0).run();
    for (const value of [null, T1]) {
      await expect(
        env.DB.prepare(`UPDATE role_keys SET revoked_at = ?2 WHERE id = ?1`).bind(id, value).run(),
      ).rejects.toThrow(/a revoked role key stays revoked/);
    }
    expect((await keyOf(id))?.revoked_at).toBe(T0);
  });

  it('refuses INSERT OR REPLACE on the id and on the live key of that runner and role', async () => {
    const owner = await runner();
    const id = await roleKey(owner);
    await expect(
      env.DB.prepare(
        `INSERT OR REPLACE INTO role_keys (id, runner_id, role, public_key_jwk, created_at) VALUES (?1, ?2, 'qa', ?3, ?4)`,
      )
        .bind(id, owner, OTHER_KEY, T1)
        .run(),
    ).rejects.toThrow(/role keys are never replaced/);
    await expect(
      env.DB.prepare(`INSERT OR REPLACE INTO role_keys (runner_id, role, public_key_jwk, created_at) VALUES (?1, 'dev', ?2, ?3)`)
        .bind(owner, OTHER_KEY, T1)
        .run(),
    ).rejects.toThrow(/role keys are never replaced/);
    expect(await keyOf(id)).toMatchObject({ role: 'dev', public_key_jwk: KEY, revoked_at: null });
  });

  it('takes a new live key for a role once the old one is revoked, and keys for other roles', async () => {
    const owner = await runner();
    const old = await roleKey(owner);
    await roleKey(owner, 'qa');
    await env.DB.prepare(`UPDATE role_keys SET revoked_at = ?2 WHERE id = ?1`).bind(old, T0).run();
    const fresh = await roleKey(owner);
    expect((await keyOf(fresh))?.revoked_at).toBeNull();
  });

  it('refuses a live key for a revoked runner', async () => {
    const owner = await runner();
    await new RunnersRepo(env.DB).revoke(ACCOUNT, owner, T0, audit);
    await expect(roleKey(owner)).rejects.toThrow(/a role key needs a live runner/);
  });

  // Item 5 of #492: revoking a runner revokes its role keys, whichever statement revoked the runner.
  it('revokes a runner’s live role keys with the runner, and keeps an earlier revocation’s time', async () => {
    const owner = await runner();
    const bystander = await runner();
    const live = await roleKey(owner, 'dev');
    const live2 = await roleKey(owner, 'qa');
    const earlier = await roleKey(owner, 'pm', T0);
    const untouched = await roleKey(bystander, 'dev');

    expect(await new RunnersRepo(env.DB).revoke(ACCOUNT, owner, T1, audit)).toBe(true);
    expect((await keyOf(live))?.revoked_at).toBe(T1);
    expect((await keyOf(live2))?.revoked_at).toBe(T1);
    expect((await keyOf(earlier))?.revoked_at).toBe(T0);
    expect((await keyOf(untouched))?.revoked_at).toBeNull();
  });
});
