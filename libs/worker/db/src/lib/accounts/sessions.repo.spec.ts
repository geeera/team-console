import { env } from 'cloudflare:test';
import { SessionsRepo, sessionIdHashOf } from './sessions.repo';

const USER = '01M6YSNJ00000000000000SES1';
const T0 = '2026-11-10T10:00:00.000Z';
const LATER = '2026-11-11T10:00:00.000Z';

async function seedSession(idHash: string, options: { expiresAt?: string; revokedAt?: string } = {}) {
  await env.DB.prepare(
    `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, ?3, ?4, ?5)`,
  )
    .bind(idHash, USER, T0, options.expiresAt ?? LATER, options.revokedAt ?? null)
    .run();
}

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT INTO users (id, provider, provider_user_id, login, created_at, last_seen_at)
     VALUES (?1, 'github', '424242', 'sessions-user', ?2, ?2)`,
  )
    .bind(USER, T0)
    .run();
});

describe('sessionIdHashOf', () => {
  it('is the SHA-256 hex of the id, so the cookie value itself never reaches D1', async () => {
    await expect(sessionIdHashOf('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('SessionsRepo', () => {
  const repo = new SessionsRepo(env.DB);

  it('finds a live session by its hash and names its user', async () => {
    const hash = await sessionIdHashOf('live');
    await seedSession(hash);
    await expect(repo.findActive(hash, T0)).resolves.toEqual({
      idHash: hash,
      userId: USER,
      expiresAt: LATER,
    });
  });

  it('answers nothing for an expired, a revoked or an unknown session', async () => {
    const expired = await sessionIdHashOf('expired');
    const revoked = await sessionIdHashOf('revoked');
    await seedSession(expired, { expiresAt: '2026-11-10T09:00:00.000Z' });
    await seedSession(revoked, { revokedAt: T0 });

    await expect(repo.findActive(expired, T0)).resolves.toBeNull();
    await expect(repo.findActive(revoked, T0)).resolves.toBeNull();
    await expect(repo.findActive(await sessionIdHashOf('nope'), T0)).resolves.toBeNull();
  });

  it('refuses a hash that is not 64 hex characters without asking D1', async () => {
    await expect(repo.findActive('not-a-hash', T0)).resolves.toBeNull();
    await expect(repo.findActive("' OR 1=1 --", T0)).resolves.toBeNull();
  });

  it('touches last_seen_at of a live session only', async () => {
    const hash = await sessionIdHashOf('touch');
    await seedSession(hash);
    await repo.touch(hash, LATER);
    const row = await env.DB.prepare('SELECT last_seen_at FROM sessions WHERE id_hash = ?1')
      .bind(hash)
      .first<{ last_seen_at: string }>();
    expect(row?.last_seen_at).toBe(LATER);
  });
});
