import {
  checkApproveEnrolmentIntentInput,
  checkCreateEnrolmentIntentInput,
  checkPollEnrolmentInput,
  checkStartEnrolmentInput,
  isEnrolmentIntentCreatedDto,
  isRunnerInstallCommandsDto,
  isEnrolmentIntentDto,
  isPollEnrolmentPendingDto,
  isRunnerKeyFingerprint,
  isStartEnrolmentResponse,
  runnerKeyFingerprintOf,
  setupCommandOf,
  type EnrolmentIntentDto,
} from './enrolment-intent';

// #634 PR 3: the enrolment intent's contracts — the fingerprint the owner compares, the bodies of both doors and the
// guards the wizard and the runner narrow the answers with.

const INTENT = '01M6YSNJ0000000000000NTENT';
const KEY = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' } as const;

const start = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  intentId: INTENT,
  publicKey: KEY,
  host: { os: 'darwin', arch: 'arm64', hostname: 'mac.local' },
  capabilities: { local: true, maxConcurrency: 1 },
  isolation: 'user',
  version: '0.1.0',
  ...overrides,
});

const intentDto = (overrides: Partial<Record<keyof EnrolmentIntentDto, unknown>> = {}): Record<string, unknown> => ({
  id: INTENT,
  state: 'bound',
  name: 'Mac',
  projectScope: 'all',
  allowedProjects: [],
  isolation: 'user',
  createdAt: '2026-11-18T10:00:00.000Z',
  expiresAt: '2026-11-18T10:10:00.000Z',
  host: { os: 'darwin', arch: 'arm64', hostname: 'mac.local' },
  version: '0.1.0',
  fingerprint: 'J3XC-NZN9',
  boundAt: '2026-11-18T10:01:00.000Z',
  boundCountry: 'UA',
  runnerId: null,
  ...overrides,
});

describe('runnerKeyFingerprintOf', () => {
  it('is the first 40 bits of the RFC 7638 thumbprint in Crockford base32 (the RFC 8037 A.3 key)', async () => {
    // RFC 8037 appendix A.3 gives this key's thumbprint as kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k: its first five
    // bytes are 90 fa ca fe a9.
    expect(await runnerKeyFingerprintOf(KEY)).toBe('J3XC-NZN9');
  });

  it('ignores members outside the thumbprint and differs for another key', async () => {
    const decorated = { ...KEY, alg: 'EdDSA', kid: 'x' } as unknown as typeof KEY;
    expect(await runnerKeyFingerprintOf(decorated)).toBe('J3XC-NZN9');
    const other = await runnerKeyFingerprintOf({ ...KEY, x: 'x'.repeat(43) });
    expect(other).not.toBe('J3XC-NZN9');
    expect(isRunnerKeyFingerprint(other)).toBe(true);
  });

  it.each(['J3XC-NZN9', '0000-0000'])('takes %s as a fingerprint', (value) => {
    expect(isRunnerKeyFingerprint(value)).toBe(true);
  });

  it.each(['j3xc-nzn9', 'J3XCNZN9', 'J3XC-NZN', 'J3XC-NZNI', 'J3XC-NZNO', 'J3XC-NZN9 ', '', null, 7])(
    'refuses %s as a fingerprint',
    (value) => {
      expect(isRunnerKeyFingerprint(value)).toBe(false);
    },
  );
});

describe('checkCreateEnrolmentIntentInput', () => {
  it('defaults the scope to all with an empty list and trims the name', () => {
    expect(checkCreateEnrolmentIntentInput({ name: ' Mac ', isolation: 'user' })).toEqual({
      ok: true,
      value: { name: 'Mac', projectScope: 'all', allowedProjects: [], isolation: 'user' },
    });
  });

  it('takes selected with its list', () => {
    const input = { name: 'Mac', isolation: 'container', projectScope: 'selected', allowedProjects: ['team-console'] };
    expect(checkCreateEnrolmentIntentInput(input)).toEqual({ ok: true, value: input });
  });

  it.each([
    ['a list beside all', { name: 'x', isolation: 'user', projectScope: 'all', allowedProjects: ['a'] }, 'allowedProjects'],
    ['a list with no scope', { name: 'x', isolation: 'user', allowedProjects: ['a'] }, 'allowedProjects'],
    ['no backend', { name: 'x' }, 'isolation'],
    ['the Actions backend', { name: 'x', isolation: 'actions-ephemeral' }, 'isolation'],
    ['a blank name', { name: ' ', isolation: 'user' }, 'name'],
    ['a credential member', { name: 'x', isolation: 'user', credential: 'api-key' }, 'body'],
  ])('refuses %s', (_, body, field) => {
    expect(checkCreateEnrolmentIntentInput(body)).toMatchObject({ ok: false, field });
  });
});

describe('checkStartEnrolmentInput', () => {
  it('takes the runner’s half and strips the key to kty, crv and x', () => {
    const checked = checkStartEnrolmentInput(start({ publicKey: { ...KEY, alg: 'EdDSA' } }));
    expect(checked).toEqual({ ok: true, value: start() });
  });

  it.each([
    ['an account', { accountId: INTENT }, 'body'],
    ['a name', { name: 'mine' }, 'body'],
    ['a scope', { projectScope: 'all' }, 'body'],
    ['a credential', { credential: 'setup-token' }, 'body'],
    ['a code', { code: 'tce_x' }, 'body'],
    ['a private key', { publicKey: { ...KEY, d: 'y'.repeat(43) } }, 'publicKey'],
    ['an intent id that is no ULID', { intentId: 'abc' }, 'intentId'],
    ['the Actions backend', { isolation: 'actions-ephemeral' }, 'isolation'],
    ['a bidi override in the hostname', { host: { os: 'darwin', arch: 'arm64', hostname: 'a‮b' } }, 'host.hostname'],
    ['a pop-directional-isolate in the arch', { host: { os: 'darwin', arch: 'arm⁩', hostname: 'a' } }, 'host.arch'],
    ['a newline in the hostname', { host: { os: 'darwin', arch: 'arm64', hostname: 'a\nb' } }, 'host.hostname'],
    ['a zero-width joiner in the os', { host: { os: 'dar‍win', arch: 'arm64', hostname: 'a' } }, 'host.os'],
    ['a hostname of spaces', { host: { os: 'darwin', arch: 'arm64', hostname: '   ' } }, 'host.hostname'],
    ['a hostname over 128 characters', { host: { os: 'darwin', arch: 'arm64', hostname: 'h'.repeat(129) } }, 'host.hostname'],
  ])('refuses %s', (_, overrides, field) => {
    expect(checkStartEnrolmentInput(start(overrides))).toMatchObject({ ok: false, field });
  });

  it('keeps a hostname in another script', () => {
    const host = { os: 'darwin', arch: 'arm64', hostname: 'Мак-Кирилла.local' };
    expect(checkStartEnrolmentInput(start({ host }))).toMatchObject({ ok: true, value: { host } });
  });
});

describe('checkPollEnrolmentInput and checkApproveEnrolmentIntentInput', () => {
  it('take exactly their members', () => {
    expect(checkPollEnrolmentInput({ intentId: INTENT, pollToken: 't' })).toEqual({
      ok: true,
      value: { intentId: INTENT, pollToken: 't' },
    });
    expect(checkPollEnrolmentInput({ intentId: INTENT, pollToken: 't', extra: 1 })).toMatchObject({ ok: false, field: 'body' });
    expect(checkPollEnrolmentInput({ intentId: INTENT })).toMatchObject({ ok: false, field: 'pollToken' });
    expect(checkPollEnrolmentInput({ intentId: INTENT, pollToken: 't'.repeat(129) })).toMatchObject({ ok: false, field: 'pollToken' });
    expect(checkApproveEnrolmentIntentInput({ fingerprint: 'J3XC-NZN9' })).toEqual({ ok: true, value: { fingerprint: 'J3XC-NZN9' } });
    expect(checkApproveEnrolmentIntentInput({ fingerprint: 'j3xc-nzn9' })).toMatchObject({ ok: false, field: 'fingerprint' });
    expect(checkApproveEnrolmentIntentInput({ fingerprint: 'J3XC-NZN9', name: 'x' })).toMatchObject({ ok: false, field: 'body' });
  });
});

describe('setupCommandOf', () => {
  it('names the origin and the intent', () => {
    // N3 of the wizard spec: exactly the runbook's invocation, with sudo and the installed launcher.
    expect(setupCommandOf('https://console.example', INTENT)).toBe(
      `sudo /usr/local/lib/team-console-runner/bin/team-console-runner setup --url https://console.example --enrolment ${INTENT}`,
    );
    expect(setupCommandOf('http://localhost:8787', INTENT)).toContain('--url http://localhost:8787 ');
  });

  it.each([
    ['an origin with a shell metacharacter', 'https://x.example;curl evil', INTENT],
    ['an origin with a path', 'https://x.example/a', INTENT],
    ['an origin with a space', 'https://x.example --flag', INTENT],
    ['another scheme', 'file://x', INTENT],
    ['an id that is no ULID', 'https://x.example', '$(id)'],
  ])('offers nothing for %s', (_, origin, id) => {
    expect(setupCommandOf(origin, id)).toBeNull();
  });
});

describe('the DTO guards', () => {
  it('take an intent in every state, bound or not', () => {
    expect(isEnrolmentIntentDto(intentDto())).toBe(true);
    expect(
      isEnrolmentIntentDto(
        intentDto({ state: 'pending', host: null, version: null, fingerprint: null, boundAt: null, boundCountry: null }),
      ),
    ).toBe(true);
    expect(isEnrolmentIntentDto(intentDto({ state: 'approved', runnerId: INTENT }))).toBe(true);
    for (const state of ['expired', 'withdrawn', 'used']) {
      expect(isEnrolmentIntentDto(intentDto({ state }))).toBe(true);
    }
  });

  it.each([
    ['an unknown state', { state: 'done' }],
    ['a fingerprint in lower case', { fingerprint: 'j3xc-nzn9' }],
    ['a list beside all', { allowedProjects: ['a'] }],
    ['a host with a bidi override', { host: { os: 'darwin', arch: 'arm64', hostname: 'a‮b' } }],
    ['a country that is no code', { boundCountry: 'Ukraine' }],
    ['a runner id that is no ULID', { runnerId: 'x' }],
    ['the Actions backend', { isolation: 'actions-ephemeral' }],
  ])('refuse an intent with %s', (_, overrides) => {
    expect(isEnrolmentIntentDto(intentDto(overrides))).toBe(false);
  });

  it('narrow the creation, the bind and the pending poll', () => {
    const expiresAt = '2026-11-18T10:10:00.000Z';
    expect(isEnrolmentIntentCreatedDto({ intentId: INTENT, expiresAt, command: null, installCommands: null })).toBe(true);
    expect(isEnrolmentIntentCreatedDto({ intentId: 'x', expiresAt, command: null, installCommands: null })).toBe(false);
    const installCommands = { version: '0.2.0', 'darwin-arm64': 'curl …', 'darwin-x64': 'curl …' };
    expect(isEnrolmentIntentCreatedDto({ intentId: INTENT, expiresAt, command: null, installCommands })).toBe(true);
    expect(isEnrolmentIntentCreatedDto({ intentId: INTENT, expiresAt, command: null })).toBe(false);
    expect(isRunnerInstallCommandsDto({ ...installCommands, 'linux-x64': 'x' })).toBe(false);
    expect(isRunnerInstallCommandsDto({ ...installCommands, 'darwin-x64': '' })).toBe(false);
    expect(isRunnerInstallCommandsDto({ ...installCommands, version: 'v0.2.0' })).toBe(false);
    const bind = { pollToken: 'tcep_x', fingerprint: 'J3XC-NZN9', intervalSeconds: 5, expiresAt, accountName: 'Acme' };
    expect(isStartEnrolmentResponse(bind)).toBe(true);
    expect(isStartEnrolmentResponse({ ...bind, intervalSeconds: 0 })).toBe(false);
    expect(isStartEnrolmentResponse({ ...bind, fingerprint: 'nope' })).toBe(false);
    expect(isPollEnrolmentPendingDto({ state: 'bound', intervalSeconds: 5 })).toBe(true);
    expect(isPollEnrolmentPendingDto({ state: 'approved', intervalSeconds: 5 })).toBe(false);
  });
});
