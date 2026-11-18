import { env } from 'cloudflare:test';
import type { NewAuditEvent } from '../accounts/audit.repo';
import {
  EnrolmentIntentsRepo,
  type EnrolmentIntentBind,
  type IntentOwner,
  type NewEnrolmentIntent,
} from './enrolment-intents.repo';

// #634 PR 3, migration 0037: every write of an enrolment intent decides in its own statement, names the account and
// the creator on the owner's side, and audits only what took effect.

const ACCOUNT_A = '01M6YSNJ00000000000000EJA1';
const ACCOUNT_B = '01M6YSNJ00000000000000EJB2';
const SUSPENDED = '01M6YSNJ00000000000000EJS3';
const T0 = '2026-11-18T10:00:00.000Z';
const at = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const CAPS = { liveMax: 3, perHour: 20 };
const ALICE: IntentOwner = { accountId: ACCOUNT_A, createdBy: 'alice' };

let counter = 0;
const ulid = (): string => {
  counter += 1;
  return `01M6YSNJ0000000000EJ${String(counter).padStart(6, '0')}`;
};

const audit = (kind: NewAuditEvent['kind'], target: string, accountId = ACCOUNT_A): NewAuditEvent => ({
  accountId,
  at: T0,
  actorKind: 'user',
  actor: 'alice',
  kind,
  target,
});

const auditRows = (kind: NewAuditEvent['kind'], target: string): Promise<number | null> =>
  env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = ?1 AND target = ?2`).bind(kind, target).first<number>('n');

const bindOf = (overrides: Partial<EnrolmentIntentBind> = {}): EnrolmentIntentBind => ({
  publicKeyX: 'x'.repeat(43),
  host: { os: 'darwin', arch: 'arm64', hostname: 'mac' },
  capabilities: { local: true, maxConcurrency: 1, accessSources: ['subscription'] },
  version: '0.1.0',
  fingerprint: 'ABCD-EFGH',
  pollTokenHash: 'a'.repeat(64),
  at: at(1),
  country: 'UA',
  ...overrides,
});

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'ej-a', 'A', ?2)`).bind(ACCOUNT_A, T0),
    env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'ej-b', 'B', ?2)`).bind(ACCOUNT_B, T0),
    env.DB
      .prepare(`INSERT INTO accounts (id, slug, name, created_at, suspended_at) VALUES (?1, 'ej-s', 'S', ?2, ?2)`)
      .bind(SUSPENDED, T0),
  ]);
});

describe('EnrolmentIntentsRepo', () => {
  const repo = new EnrolmentIntentsRepo(env.DB);

  // Each case clears the account's open intents first: the live cap is per account and the cases share D1.
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM runner_enrolment_requests`).run();
  });

  async function created(overrides: Partial<NewEnrolmentIntent> = {}): Promise<NewEnrolmentIntent> {
    const intent: NewEnrolmentIntent = {
      id: ulid(),
      accountId: ACCOUNT_A,
      name: 'mac',
      projectScope: 'selected',
      allowedProjects: ['p1'],
      isolation: 'user',
      createdBy: 'alice',
      at: T0,
      expiresAt: at(600),
      ...overrides,
    };
    expect(await repo.create(intent, CAPS, audit('enrolment-intent.created', intent.id, intent.accountId))).toBe('ok');
    return intent;
  }

  async function bound(overrides: Partial<NewEnrolmentIntent> = {}, bind = bindOf()): Promise<NewEnrolmentIntent> {
    const intent = await created(overrides);
    expect(await repo.bind(intent.id, intent.isolation, bind, audit('enrolment-intent.bound', intent.id))).toBe(true);
    return intent;
  }

  const approveOf = (id: string, fingerprint = 'ABCD-EFGH', when = at(2), owner = ALICE) => {
    const runnerId = ulid();
    return repo
      .approve(owner, id, { fingerprint, runnerId, at: when }, () => audit('runner.enrolled', runnerId))
      .then((intent) => ({ intent, runnerId }));
  };

  describe('create', () => {
    it('writes a pending intent with its audit row, and stores no list beside all', async () => {
      const intent = await created({ projectScope: 'all', allowedProjects: ['ignored'] });
      expect(await repo.findById(intent.id)).toMatchObject({
        id: intent.id,
        accountId: ACCOUNT_A,
        projectScope: 'all',
        allowedProjects: [],
        isolation: 'user',
        createdBy: 'alice',
        state: 'pending',
        bind: null,
        runnerId: null,
      });
      expect(await auditRows('enrolment-intent.created', intent.id)).toBe(1);
    });

    it('holds the live cap inside the INSERT, counts only open intents of this account, and audits nothing refused', async () => {
      const [first] = [await created(), await created(), await created()];
      await created({ accountId: ACCOUNT_B });
      const over: NewEnrolmentIntent = { ...(first as NewEnrolmentIntent), id: ulid() };
      expect(await repo.create(over, CAPS, audit('enrolment-intent.created', over.id))).toBe('live-limit');
      expect(await repo.findById(over.id)).toBeNull();
      expect(await auditRows('enrolment-intent.created', over.id)).toBe(0);

      // A withdrawn intent and one past its time are not open.
      expect(await repo.withdraw(ALICE, (first as NewEnrolmentIntent).id, at(5), audit('enrolment-intent.withdrawn', 'x'))).toBe(true);
      await created();
      const later: NewEnrolmentIntent = { ...over, id: ulid(), at: at(601), expiresAt: at(1201) };
      expect(await repo.create(later, CAPS, audit('enrolment-intent.created', later.id))).toBe('ok');
    });

    it('holds the hourly cap, and lets the next hour through', async () => {
      const caps = { liveMax: 100, perHour: 2 };
      await created();
      const second = await created({ at: at(10), expiresAt: at(610) });
      const third: NewEnrolmentIntent = { ...second, id: ulid(), at: at(20), expiresAt: at(620) };
      expect(await repo.create(third, caps, audit('enrolment-intent.created', third.id))).toBe('hourly-limit');
      const nextHour = { ...third, id: ulid(), at: at(3700), expiresAt: at(4300) };
      expect(await repo.create(nextHour, caps, audit('enrolment-intent.created', nextHour.id))).toBe('ok');
    });

    it('prunes the account’s rows a day old in the same batch, and no other account’s', async () => {
      const old = await created();
      const foreign = await created({ accountId: ACCOUNT_B });
      await created({ at: at(25 * 3600), expiresAt: at(25 * 3600 + 600) });
      expect(await repo.findById(old.id)).toBeNull();
      expect(await repo.findById(foreign.id)).not.toBeNull();
    });
  });

  describe('findOwned', () => {
    it('answers the creator in the intent’s account only', async () => {
      const intent = await created();
      expect(await repo.findOwned(ALICE, intent.id)).toMatchObject({ id: intent.id });
      expect(await repo.findOwned({ accountId: ACCOUNT_A, createdBy: 'bob' }, intent.id)).toBeNull();
      expect(await repo.findOwned({ accountId: ACCOUNT_B, createdBy: 'alice' }, intent.id)).toBeNull();
    });
  });

  describe('bind', () => {
    it('binds a pending intent whole, with the audit row', async () => {
      const intent = await bound();
      expect(await repo.findById(intent.id)).toMatchObject({ state: 'bound', bind: bindOf() });
      expect(await auditRows('enrolment-intent.bound', intent.id)).toBe(1);
    });

    it('lets the first bind win and leaves the second nothing, the audit row included', async () => {
      const intent = await bound();
      const second = bindOf({ publicKeyX: 'y'.repeat(43), fingerprint: 'ZZZZ-ZZZZ', pollTokenHash: 'b'.repeat(64) });
      expect(await repo.bind(intent.id, 'user', second, audit('enrolment-intent.bound', intent.id))).toBe(false);
      expect((await repo.findById(intent.id))?.bind).toEqual(bindOf());
      expect(await auditRows('enrolment-intent.bound', intent.id)).toBe(1);
    });

    it.each([
      ['an intent past its time', {}, 'user', { at: at(600) }],
      ['another backend than the intent’s', {}, 'container', {}],
      ['an intent of a suspended account', { accountId: SUSPENDED }, 'user', {}],
    ] as const)('refuses %s', async (_, overrides, isolation, bind) => {
      const intent = await created(overrides);
      expect(await repo.bind(intent.id, isolation, bindOf(bind), audit('enrolment-intent.bound', intent.id, intent.accountId))).toBe(false);
      expect(await repo.findById(intent.id)).toMatchObject({ state: 'pending', bind: null });
      expect(await auditRows('enrolment-intent.bound', intent.id)).toBe(0);
    });

    it('refuses a withdrawn intent and an unknown one', async () => {
      const intent = await created();
      expect(await repo.withdraw(ALICE, intent.id, at(1), audit('enrolment-intent.withdrawn', intent.id))).toBe(true);
      expect(await repo.bind(intent.id, 'user', bindOf({ at: at(2) }), audit('enrolment-intent.bound', intent.id))).toBe(false);
      expect(await repo.bind(ulid(), 'user', bindOf(), audit('enrolment-intent.bound', 'none'))).toBe(false);
    });
  });

  describe('withdraw', () => {
    it('withdraws a pending or bound intent once, for its creator in its account alone', async () => {
      const intent = await bound();
      expect(await repo.withdraw({ accountId: ACCOUNT_A, createdBy: 'bob' }, intent.id, at(3), audit('enrolment-intent.withdrawn', intent.id))).toBe(false);
      expect(await repo.withdraw({ accountId: ACCOUNT_B, createdBy: 'alice' }, intent.id, at(3), audit('enrolment-intent.withdrawn', intent.id))).toBe(false);
      expect(await repo.withdraw(ALICE, intent.id, at(3), audit('enrolment-intent.withdrawn', intent.id))).toBe(true);
      expect(await repo.withdraw(ALICE, intent.id, at(4), audit('enrolment-intent.withdrawn', intent.id))).toBe(false);
      expect(await auditRows('enrolment-intent.withdrawn', intent.id)).toBe(1);
      // What asked stays on the row.
      expect(await repo.findById(intent.id)).toMatchObject({ state: 'withdrawn', bind: bindOf() });
    });

    it('leaves an expired and an approved intent as they are', async () => {
      const expired = await created();
      expect(await repo.withdraw(ALICE, expired.id, at(600), audit('enrolment-intent.withdrawn', expired.id))).toBe(false);
      const approved = await bound();
      expect((await approveOf(approved.id)).intent?.state).toBe('approved');
      expect(await repo.withdraw(ALICE, approved.id, at(5), audit('enrolment-intent.withdrawn', approved.id))).toBe(false);
    });
  });

  describe('approve', () => {
    it('writes the runner from the intent row alone, with the creator as the enroller, and audits it', async () => {
      const intent = await bound({ name: 'Studio', projectScope: 'all', allowedProjects: [], isolation: 'container' });
      const { intent: approved, runnerId } = await approveOf(intent.id);
      expect(approved).toMatchObject({ state: 'approved', runnerId, approvedAt: at(2) });
      const runner = await env.DB.prepare(`SELECT * FROM runners WHERE id = ?1`).bind(runnerId).first<Record<string, unknown>>();
      expect(runner).toMatchObject({
        account_id: ACCOUNT_A,
        name: 'Studio',
        project_scope: 'all',
        allowed_projects: '[]',
        isolation: 'container',
        hosted: 0,
        version: '0.1.0',
        enrolled_by: 'alice',
        enrolled_at: at(2),
      });
      expect(JSON.parse(String(runner?.['public_key_jwk']))).toEqual({ kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43) });
      expect(JSON.parse(String(runner?.['capabilities']))).toEqual(bindOf().capabilities);
      expect(await auditRows('runner.enrolled', runnerId)).toBe(1);
    });

    it.each([
      ['another fingerprint than the bound key’s', 'ZZZZ-ZZZZ', at(2), ALICE],
      ['an intent past its time', 'ABCD-EFGH', at(600), ALICE],
      ['another owner of the account', 'ABCD-EFGH', at(2), { accountId: ACCOUNT_A, createdBy: 'bob' }],
      ['another account', 'ABCD-EFGH', at(2), { accountId: ACCOUNT_B, createdBy: 'alice' }],
    ] as const)('writes nothing for %s', async (_, fingerprint, when, owner) => {
      const intent = await bound();
      const { intent: approved, runnerId } = await approveOf(intent.id, fingerprint, when, owner);
      expect(approved).toBeNull();
      expect(await env.DB.prepare(`SELECT id FROM runners WHERE id = ?1`).bind(runnerId).first()).toBeNull();
      expect(await auditRows('runner.enrolled', runnerId)).toBe(0);
      expect(await repo.findById(intent.id)).toMatchObject({ state: 'bound', runnerId: null });
    });

    it('writes nothing for a pending intent, a suspended account, or a second approval', async () => {
      const pending = await created();
      expect((await approveOf(pending.id)).intent).toBeNull();

      const suspended = await created({ accountId: ACCOUNT_B });
      expect(await repo.bind(suspended.id, 'user', bindOf(), audit('enrolment-intent.bound', suspended.id, ACCOUNT_B))).toBe(true);
      await env.DB.prepare(`UPDATE accounts SET suspended_at = ?2 WHERE id = ?1`).bind(ACCOUNT_B, T0).run();
      const refused = await approveOf(suspended.id, 'ABCD-EFGH', at(2), { accountId: ACCOUNT_B, createdBy: 'alice' });
      await env.DB.prepare(`UPDATE accounts SET suspended_at = NULL WHERE id = ?1`).bind(ACCOUNT_B).run();
      expect(refused.intent).toBeNull();
      expect(await env.DB.prepare(`SELECT id FROM runners WHERE id = ?1`).bind(refused.runnerId).first()).toBeNull();

      const intent = await bound();
      const first = await approveOf(intent.id);
      const second = await approveOf(intent.id);
      expect(first.intent?.runnerId).toBe(first.runnerId);
      expect(second.intent).toBeNull();
      expect(await env.DB.prepare(`SELECT id FROM runners WHERE id = ?1`).bind(second.runnerId).first()).toBeNull();
      expect(await repo.findById(intent.id)).toMatchObject({ state: 'approved', runnerId: first.runnerId });
    });
  });

  describe('admitPoll and collect', () => {
    it('admits a poll of the token’s holder only when the last one is the gap behind', async () => {
      const intent = await bound();
      expect(await repo.admitPoll(intent.id, 'b'.repeat(64), at(10), 4)).toBe(false);
      expect(await repo.admitPoll(intent.id, 'a'.repeat(64), at(10), 4)).toBe(true);
      expect(await repo.admitPoll(intent.id, 'a'.repeat(64), at(13), 4)).toBe(false);
      // The refused poll did not move the clock.
      expect(await repo.admitPoll(intent.id, 'a'.repeat(64), at(14), 4)).toBe(true);
    });

    it('collects an approved intent once, for the token’s holder', async () => {
      const intent = await bound();
      expect(await repo.collect(intent.id, 'a'.repeat(64), at(3), 120)).toBeNull();
      const { runnerId } = await approveOf(intent.id);
      expect(await repo.collect(intent.id, 'b'.repeat(64), at(3), 120)).toBeNull();
      expect(await repo.collect(intent.id, 'a'.repeat(64), at(3), 120)).toBe(runnerId);
      expect(await repo.collect(intent.id, 'a'.repeat(64), at(4), 120)).toBeNull();
      expect(await repo.findById(intent.id)).toMatchObject({ state: 'used', runnerId });
    });

    it('keeps the collection open to the later of the expiry and the grace after the approval', async () => {
      const lastSecond = await bound();
      await approveOf(lastSecond.id, 'ABCD-EFGH', at(599));
      // Past `expires_at` (T0 + 600 s), inside the grace after the approval.
      expect(await repo.collect(lastSecond.id, 'a'.repeat(64), at(700), 120)).not.toBeNull();

      const early = await bound();
      await approveOf(early.id, 'ABCD-EFGH', at(2));
      // The grace is long over, the intent's own ten minutes are not.
      expect(await repo.collect(early.id, 'a'.repeat(64), at(500), 120)).not.toBeNull();

      const late = await bound();
      await approveOf(late.id, 'ABCD-EFGH', at(599));
      expect(await repo.collect(late.id, 'a'.repeat(64), at(720), 120)).toBeNull();
      expect(await repo.findById(late.id)).toMatchObject({ state: 'approved' });
    });
  });
});
