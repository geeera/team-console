import { env } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID } from '@shared/contracts';
import {
  AuditDetailsTooLargeError,
  AuditRepo,
  auditDetailsJson,
  auditEventStatement,
  type NewAuditEvent,
} from './audit.repo';

const ACCOUNT = '01M6YSNJ00000000000000AD01';
const T0 = '2026-11-09T10:00:00.000Z';

const event = (overrides: Partial<NewAuditEvent> = {}): NewAuditEvent => ({
  accountId: ACCOUNT,
  at: T0,
  actorKind: 'user',
  actor: '01M6YSNJ00000000000000VSR1',
  kind: 'auth.signed-in',
  target: null,
  ...overrides,
});

beforeAll(async () => {
  await env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'audit-acct', 'A', ?2)`)
    .bind(ACCOUNT, T0)
    .run();
});

describe('AuditRepo', () => {
  const repo = new AuditRepo(env.DB);

  it('appends a row and reads it back', async () => {
    await repo.append(
      event({ kind: 'invite.created', target: 'invite', details: { role: 'member' }, ipCountry: 'UA' }),
    );

    const page = await repo.listForAccount(ACCOUNT, null, 10);

    expect(page.nextCursor).toBeNull();
    expect(page.events).toEqual([
      expect.objectContaining({
        accountId: ACCOUNT,
        actorKind: 'user',
        kind: 'invite.created',
        target: 'invite',
        details: { role: 'member' },
        ipCountry: 'UA',
      }),
    ]);
  });

  it('pages newest first with a cursor and never shows another account', async () => {
    await env.DB.batch([1, 2, 3, 4, 5].map((n) => auditEventStatement(env.DB, event({ target: `n${n}` }))));
    await repo.append(event({ accountId: OWNER_ACCOUNT_ID, target: 'other-account' }));

    const first = await repo.listForAccount(ACCOUNT, null, 2);
    expect(first.events.map((row) => row.target)).toEqual(['n5', 'n4']);
    expect(first.nextCursor).toBe(first.events[1]?.id);

    const second = await repo.listForAccount(ACCOUNT, first.nextCursor, 2);
    expect(second.events.map((row) => row.target)).toEqual(['n3', 'n2']);

    const rest = await repo.listForAccount(ACCOUNT, second.nextCursor, 100);
    // `invite` is the row of the test before.
    expect(rest.events.map((row) => row.target)).toEqual(['n1', 'invite']);
    expect(rest.nextCursor).toBeNull();
    expect(rest.events.every((row) => row.accountId === ACCOUNT)).toBe(true);
  });

  it('clamps the page size to 1–100', async () => {
    const page = await repo.listForAccount(ACCOUNT, null, 0);
    expect(page.events).toHaveLength(1);
  });

  it('redacts credentials in details before they reach D1', async () => {
    const token = `ghs_${'a'.repeat(36)}`;
    await repo.append(
      event({ target: 'redacted', details: { note: `token ${token}`, authorization: 'Bearer x' } }),
    );

    const stored = await env.DB.prepare(
      `SELECT details FROM audit_events WHERE target = 'redacted'`,
    ).first<string>('details');

    expect(stored).not.toContain(token);
    expect(stored).not.toContain('Bearer x');
    // The shared pattern list names the kind; `redact`'s own formats would have masked it as `[redacted]`.
    expect(JSON.parse(stored ?? '{}')).toEqual({
      note: 'token [redacted:github-token]',
      authorization: '[redacted]',
    });
  });

  // Security review of #473: invite tokens, session ids and enrolment codes are bare random strings no value pattern
  // recognises, so their keys decide.
  it('redacts values under credential-like keys, at any depth, whatever they look like', () => {
    const bare = 'q3Vb9_x-Lm2Pz7Rt0Yw4Kc8Hd1Fs6Gj5Nu3Ea9Bo2Ix'; // 43 base64url characters, no prefix
    expect(bare).toHaveLength(43);

    const stored = JSON.parse(
      auditDetailsJson({
        inviteToken: bare,
        session: bare,
        enrolmentCode: bare,
        nested: { clientSecret: bare, apiKey: bare, list: [{ password: bare }] },
        role: 'member',
        keyId: 'k-1',
      }),
    ) as unknown;

    expect(JSON.stringify(stored)).not.toContain(bare);
    expect(stored).toEqual({
      inviteToken: '[redacted]',
      session: '[redacted]',
      enrolmentCode: '[redacted]',
      nested: { clientSecret: '[redacted]', apiKey: '[redacted]', list: [{ password: '[redacted]' }] },
      role: 'member',
      keyId: 'k-1',
    });
  });

  // #474 security re-check: free text in `details` goes through `@shared/redaction` first, so a job token, an
  // Anthropic key or a PEM in a value is masked whatever key it sits under.
  it('masks every secret shape of @shared/redaction in string values, at any depth', async () => {
    const jobToken = `tcj_${'b'.repeat(43)}`;
    const anthropic = `sk-ant-${'c'.repeat(40)}`;
    const pat = `github_pat_${'d'.repeat(30)}`;
    await repo.append(
      event({
        target: 'shapes',
        details: { reason: `use ${jobToken} now`, nested: { list: [anthropic] }, label: pat },
      }),
    );

    const stored = await env.DB.prepare(
      `SELECT details FROM audit_events WHERE target = 'shapes'`,
    ).first<string>('details');

    for (const secret of [jobToken, anthropic, pat]) {
      expect(stored).not.toContain(secret);
    }
    expect(JSON.parse(stored ?? '{}')).toEqual({
      reason: 'use [redacted:job-token] now',
      nested: { list: ['[redacted:anthropic-key]'] },
      label: '[redacted:github-token]',
    });
  });

  it('refuses details over the bound instead of cutting them', () => {
    expect(() => auditDetailsJson({ text: 'x'.repeat(5000) })).toThrow(AuditDetailsTooLargeError);
  });

  it('counts the bound in UTF-8 bytes, as the column does', () => {
    // About 2,100 characters, about 4,200 bytes.
    expect(() => auditDetailsJson({ text: 'é'.repeat(2100) })).toThrow(AuditDetailsTooLargeError);
    expect(() => auditDetailsJson({ text: 'é'.repeat(2000) })).not.toThrow();
  });

  it('drops an ip country that is not two capital letters', async () => {
    await repo.append(event({ target: 'country', ipCountry: 'ua; DROP' }));
    expect(
      await env.DB.prepare(`SELECT ip_country FROM audit_events WHERE target = 'country'`).first(
        'ip_country',
      ),
    ).toBeNull();
  });

  it('fails the whole batch with its action when the audit row is refused', async () => {
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first<number>('n');
    await expect(
      env.DB.batch([
        env.DB.prepare(
          `INSERT INTO accounts (id, slug, name, created_at) VALUES ('01M6YSNJ00000000000000AD02', 'audit-b', 'B', ?1)`,
        ).bind(T0),
        // A user event outside an account: the CHECK refuses it, so the account above is not written either.
        auditEventStatement(env.DB, event({ accountId: null })),
      ]),
    ).rejects.toThrow(/CHECK/);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first<number>('n')).toBe(before);
  });

  it('offers no way to change or remove a row', () => {
    const methods = Object.getOwnPropertyNames(AuditRepo.prototype).filter((name) => name !== 'constructor');
    expect(methods.sort()).toEqual(['append', 'listForAccount']);
  });
});

describe('@worker/db sources', () => {
  const sources = Object.entries(env.TEST_LIBRARY_SOURCES);

  it('are scanned (the check is not vacuous)', () => {
    expect(sources.map(([path]) => path)).toEqual(
      expect.arrayContaining(['index.ts', 'lib/accounts/audit.repo.ts']),
    );
  });

  it('hold no UPDATE, DELETE or REPLACE of audit_events', () => {
    const writes =
      /\b(?:UPDATE\s+audit_events|DELETE\s+FROM\s+audit_events|REPLACE\s+INTO\s+audit_events|INSERT\s+OR\s+REPLACE\s+INTO\s+audit_events)\b/i;
    const offenders = sources.filter(([, text]) => writes.test(text)).map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  // #472/#473 security re-review: `UPDATE OR REPLACE` (and any other `UPDATE OR …` conflict clause) on a tenancy
  // table resolves a UNIQUE collision by deleting the other row without its DELETE triggers — another account's
  // empty project, or an installation link, could vanish through the slug or repository index. The 0018 triggers
  // guard INSERT; this guards the statements.
  it.each(['accounts', 'users', 'projects', 'installations'])(
    'hold no UPDATE OR … / REPLACE INTO of %s',
    (table) => {
      const conflicting = new RegExp(
        String.raw`\b(?:UPDATE\s+OR\s+\w+\s+${table}|REPLACE\s+INTO\s+${table}|INSERT\s+OR\s+REPLACE\s+INTO\s+${table})\b`,
        'i',
      );
      const offenders = sources.filter(([, text]) => conflicting.test(text)).map(([path]) => path);
      expect(offenders).toEqual([]);
    },
  );

  it('would catch an UPDATE OR REPLACE (the scan is not vacuous)', () => {
    const conflicting = /\bUPDATE\s+OR\s+\w+\s+projects\b/i;
    expect(conflicting.test('UPDATE OR REPLACE projects SET slug = ?1')).toBe(true);
    expect(conflicting.test('UPDATE OR IGNORE projects SET slug = ?1')).toBe(true);
    expect(conflicting.test('UPDATE projects SET slug = ?1')).toBe(false);
  });
});
