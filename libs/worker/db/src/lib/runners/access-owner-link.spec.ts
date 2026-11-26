import { env } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID } from '@shared/contracts';
import { EnrolmentIntentsRepo, type EnrolmentIntentBind } from './enrolment-intents.repo';
import { RunnersRepo } from './runners.repo';

// #838 (migration 0042): what the Access owner made before the GitHub link is theirs after it, so D3 still matches it.
// #899 (migration 0044): only for a linked user who is a member of the owner account, and the owner's unfinished
// enrolment intents are withdrawn at the hand-over.
const T0 = '2026-11-22T10:00:00.000Z';
const ACCESS_OWNER = '01M6YSNJ0000000000000838E1';
const SECOND_OWNER = '01M6YSNJ0000000000000838E2';
const STRANGER = '01M6YSNJ0000000000000838E3';
const OTHER_ACCOUNT = '01M6YSNJ0000000000000838A2';
const KEY = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43) });

let runners = 0;
async function runner(enrolledBy: string | null, accountId: string = OWNER_ACCOUNT_ID): Promise<string> {
  runners += 1;
  const id = `01M6YSNJ000000000000838R${String(runners).padStart(2, '0')}`;
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

const join = (userId: string, role: 'owner' | 'member', accountId: string = OWNER_ACCOUNT_ID) =>
  env.DB.prepare(`INSERT INTO account_members (account_id, user_id, role, joined_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(accountId, userId, role, T0)
    .run();

let intents = 0;
/** An enrolment intent as the routes leave it in `state`; live for ten minutes from now unless `expired`. */
async function intent(
  state: 'pending' | 'bound' | 'approved',
  createdBy: string,
  options: { readonly accountId?: string; readonly expired?: boolean; readonly runnerId?: string } = {},
): Promise<string> {
  intents += 1;
  const id = `01M6YSNJ${`899Q${String(intents).padStart(2, '0')}`.padStart(18, '0')}`;
  const createdAt = options.expired === true ? T0 : new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + 600_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO runner_enrolment_requests (id, account_id, name, project_scope, isolation, created_by, created_at, expires_at)
     VALUES (?1, ?2, 'mac', 'all', 'user', ?3, ?4, ?5)`,
  )
    .bind(id, options.accountId ?? OWNER_ACCOUNT_ID, createdBy, createdAt, expiresAt)
    .run();
  if (state !== 'pending') {
    await env.DB.prepare(
      `UPDATE runner_enrolment_requests
       SET state = 'bound', public_key = ?2, host = '{}', capabilities = '{}', version = '0.1.0', fingerprint = 'ABCD-EFGH',
           poll_token_hash = ?3, bound_at = ?4
       WHERE id = ?1`,
    )
      .bind(id, 'x'.repeat(43), 'a'.repeat(64), createdAt)
      .run();
  }
  if (state === 'approved') {
    await env.DB.prepare(
      `UPDATE runner_enrolment_requests SET state = 'approved', approved_at = ?2, approved_by = ?3, runner_id = ?4 WHERE id = ?1`,
    )
      .bind(id, createdAt, createdBy, options.runnerId ?? null)
      .run();
  }
  return id;
}
const intentStateOf = (id: string) =>
  env.DB.prepare(`SELECT state FROM runner_enrolment_requests WHERE id = ?1`).bind(id).first<string>('state');

const link = (id: string, subject: string) =>
  env.DB.prepare(`UPDATE users SET access_subject = ?2 WHERE id = ?1`).bind(id, subject).run();
const enrollerOf = (id: string) =>
  env.DB.prepare(`SELECT enrolled_by FROM runners WHERE id = ?1`)
    .bind(id)
    .first<string | null>('enrolled_by');
const creatorOf = (slug: string) =>
  env.DB.prepare(`SELECT created_by FROM projects WHERE slug = ?1`)
    .bind(slug)
    .first<string | null>('created_by');
const adoptions = () =>
  env.DB.prepare(
    `SELECT actor_kind, actor, target, details FROM audit_events WHERE kind = 'auth.access-actor-adopted'`,
  )
    .all<{ actor_kind: string; actor: string; target: string; details: string }>()
    .then((rows) => rows.results);
const adoptionsOf = async (target: string) => (await adoptions()).filter((row) => row.target === target);
const linkedUsers = () =>
  env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE access_subject IS NOT NULL`).first<number>('n');
// A case drops its user again (a plain `member`, so the last-owner rule lets the membership go): the count-of-one
// rule then holds for the next case.
const dropUser = (id: string) =>
  env.DB.batch([
    env.DB.prepare(`DELETE FROM account_members WHERE user_id = ?1`).bind(id),
    env.DB.prepare(`DELETE FROM users WHERE id = ?1`).bind(id),
  ]);
const adopted = (target: string, counts: { runners: number; projects: number; intents: number }) => ({
  actor_kind: 'system',
  actor: 'access-link',
  target,
  details: JSON.stringify(counts),
});

// Run first: both need no other user linked yet.
describe('the other ways a link is written (#838)', () => {
  const INSERTED = '01M6YSNJ0000000000000838E4';
  const HAND_LINKED = '01M6YSNJ0000000000000838E5';
  const OUTSIDER = '01M6YSNJ0000000000000899E1';
  const INTENT_OWNER = '01M6YSNJ0000000000000899E2';
  const ELSEWHERE = '01M6YSNJ0000000000000899A1';

  beforeAll(async () => {
    await env.DB.prepare(
      `INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'acc-899', 'Elsewhere', ?2)`,
    )
      .bind(ELSEWHERE, T0)
      .run();
  });

  it('adopts the rows of a user row inserted already linked once its membership is written', async () => {
    expect(await linkedUsers()).toBe(0);
    const mine = await runner('access-owner');
    await project('p838-insert', 'access-owner');
    await user(INSERTED, '838004', 'access-sub-838-insert');
    // #899: a new row has no membership yet, so the link alone moves nothing.
    expect(await enrollerOf(mine)).toBe('access-owner');
    expect(await adoptionsOf(INSERTED)).toEqual([]);

    await join(INSERTED, 'member');

    expect(await enrollerOf(mine)).toBe(INSERTED);
    expect(await creatorOf('p838-insert')).toBe(INSERTED);
    expect(await adoptionsOf(INSERTED)).toEqual([adopted(INSERTED, { runners: 1, projects: 1, intents: 0 })]);
    await dropUser(INSERTED);
  });

  // #899 item 1: the linked user must be a member of the owner account.
  it('hands nothing over to a linked user who is not a member of the owner account', async () => {
    expect(await linkedUsers()).toBe(0);
    const mine = await runner('access-owner');
    await project('p899-outsider', 'access-owner');
    const pending = await intent('pending', 'access-owner');
    await user(OUTSIDER, '899001');

    await link(OUTSIDER, 'access-sub-899-outsider');
    // A membership of another account, written after the link, is still none of the owner account.
    await join(OUTSIDER, 'member', ELSEWHERE);

    expect(await enrollerOf(mine)).toBe('access-owner');
    expect(await creatorOf('p899-outsider')).toBe('access-owner');
    expect(await intentStateOf(pending)).toBe('pending');
    // Neither by a direct write (the 0036 exception asks for the membership too) nor for a runner enrolled later.
    await expect(
      env.DB.prepare(`UPDATE runners SET enrolled_by = ?2 WHERE id = ?1`).bind(mine, OUTSIDER).run(),
    ).rejects.toThrow(/runners keep their identity/u);
    const later = await runner('access-owner');
    expect(await enrollerOf(later)).toBe('access-owner');
    expect(await adoptionsOf(OUTSIDER)).toEqual([]);

    await dropUser(OUTSIDER);
    // Leave no `access-owner` rows behind: the next cases count them.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM runners WHERE id IN (?1, ?2)`).bind(mine, later),
      env.DB.prepare(`DELETE FROM projects WHERE slug = 'p899-outsider'`),
      env.DB.prepare(`DELETE FROM runner_enrolment_requests WHERE id = ?1`).bind(pending),
    ]);
  });

  // #899 item 2: an intent the owner made as `access-owner` answers nobody after the link (the routes match
  // `created_by` with the caller's actor), so the hand-over withdraws it rather than leave it live and unreachable.
  it('withdraws the live pending and bound intents made as access-owner, and nothing else', async () => {
    expect(await linkedUsers()).toBe(0);
    const approvedRunner = await runner('access-owner');
    const pending = await intent('pending', 'access-owner');
    const bound = await intent('bound', 'access-owner');
    const approved = await intent('approved', 'access-owner', { runnerId: approvedRunner });
    const expired = await intent('pending', 'access-owner', { expired: true });
    const theirs = await intent('pending', SECOND_OWNER);
    const elsewhere = await intent('pending', 'access-owner', { accountId: ELSEWHERE });
    await user(INTENT_OWNER, '899002');
    await join(INTENT_OWNER, 'member');

    await link(INTENT_OWNER, 'access-sub-899');

    expect(await intentStateOf(pending)).toBe('withdrawn');
    expect(await intentStateOf(bound)).toBe('withdrawn');
    // Its runner exists and is handed over; the binder still collects it.
    expect(await intentStateOf(approved)).toBe('approved');
    expect(await enrollerOf(approvedRunner)).toBe(INTENT_OWNER);
    // Dead already, another owner's, another account's.
    expect(await intentStateOf(expired)).toBe('pending');
    expect(await intentStateOf(theirs)).toBe('pending');
    expect(await intentStateOf(elsewhere)).toBe('pending');
    expect(await adoptionsOf(INTENT_OWNER)).toEqual([
      adopted(INTENT_OWNER, { runners: 1, projects: 0, intents: 2 }),
    ]);

    // The runner's door: a `start` on the withdrawn intent binds nothing, where the other owner's still binds.
    const repo = new EnrolmentIntentsRepo(env.DB);
    const at = new Date().toISOString();
    const bind: EnrolmentIntentBind = {
      publicKeyX: 'y'.repeat(43),
      host: { os: 'darwin', arch: 'arm64', hostname: 'mac' },
      capabilities: { local: true, maxConcurrency: 1 },
      version: '0.1.0',
      fingerprint: 'ABCD-EFGH',
      pollTokenHash: 'b'.repeat(64),
      at,
      country: null,
    };
    const bound899 = (target: string) =>
      ({
        accountId: OWNER_ACCOUNT_ID,
        at,
        actorKind: 'runner',
        actor: 'runner',
        kind: 'enrolment-intent.bound',
        target,
      }) as const;
    expect(await repo.bind(pending, 'user', bind, bound899(pending))).toBe(false);
    expect(await repo.bind(theirs, 'user', bind, bound899(theirs))).toBe(true);
    // The owner, now acting as the user id, is left with no live intent they cannot reach.
    expect(
      await repo.findOwned({ accountId: OWNER_ACCOUNT_ID, createdBy: INTENT_OWNER }, pending),
    ).toBeNull();
    expect((await repo.findById(pending))?.state).toBe('withdrawn');

    await dropUser(INTENT_OWNER);
    await env.DB.prepare(`DELETE FROM runner_enrolment_requests WHERE id IN (?1, ?2)`)
      .bind(theirs, expired)
      .run();
  });

  it('backfills a link made by hand before the migration, once', async () => {
    expect(await linkedUsers()).toBe(0);
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0042_'));
    const round2 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0044_'));
    if (migration === undefined || round2 === undefined) {
      throw new Error('migration 0042 or 0044 is missing');
    }
    // The schema as 0041 left it: none of 0042's triggers, and 0036's enroller rule without the exception.
    await env.DB.batch([
      env.DB.prepare(`DROP TRIGGER users_access_link_adopts_owner_actor`),
      env.DB.prepare(`DROP TRIGGER users_access_insert_adopts_owner_actor`),
      env.DB.prepare(`DROP TRIGGER runners_access_owner_adopted`),
      env.DB.prepare(`DROP TRIGGER account_members_insert_adopts_owner_actor`),
      env.DB.prepare(`DROP TRIGGER runners_enrolled_by_kept`),
      env.DB.prepare(
        `CREATE TRIGGER runners_enrolled_by_kept BEFORE UPDATE OF enrolled_by ON runners WHEN OLD.enrolled_by IS NOT NULL
         BEGIN SELECT RAISE(ABORT, 'runners keep their identity'); END`,
      ),
    ]);
    const mine = await runner('access-owner');
    await project('p838-hand', 'access-owner');
    await user(HAND_LINKED, '838005', 'access-sub-838-hand');
    // Nothing moved at the link itself: no trigger yet.
    expect(await enrollerOf(mine)).toBe('access-owner');

    for (const query of migration.queries) {
      await env.DB.prepare(query).run();
    }

    expect(await enrollerOf(mine)).toBe(HAND_LINKED);
    expect(await creatorOf('p838-hand')).toBe(HAND_LINKED);
    expect(await adoptionsOf(HAND_LINKED)).toEqual([
      {
        actor_kind: 'system',
        actor: 'access-link',
        target: HAND_LINKED,
        details: JSON.stringify({ runners: 1, projects: 1 }),
      },
    ]);
    // 0044 applies over what 0042 left, and the later cases run on its triggers.
    for (const query of round2.queries) {
      await env.DB.prepare(query).run();
    }
    await dropUser(HAND_LINKED);
  });
});

describe('the Access–GitHub link adopts the access-owner actor (#838)', () => {
  const repo = new RunnersRepo(env.DB);
  const served = async (runnerId: string) =>
    (await repo.servedProjectsOf(OWNER_ACCOUNT_ID, runnerId)).map((p) => p.slug);

  beforeAll(async () => {
    await env.DB.prepare(
      `INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'acc-838', 'Other', ?2)`,
    )
      .bind(OTHER_ACCOUNT, T0)
      .run();
    await user(ACCESS_OWNER, '838001');
    await user(SECOND_OWNER, '838002');
    for (const owner of [ACCESS_OWNER, SECOND_OWNER]) {
      await join(owner, 'owner');
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
    expect(await adoptionsOf(ACCESS_OWNER)).toEqual([
      adopted(ACCESS_OWNER, { runners: 1, projects: 1, intents: 0 }),
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
      env.DB.prepare(`UPDATE runners SET enrolled_by = ?2 WHERE id = ?1`)
        .bind(await runner('access-owner'), STRANGER)
        .run(),
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
