import { isRunnerPolicy, isRunnerPolicyDto } from './job';
import {
  compareRunnerVersions,
  enrolCommandOf,
  isEnrolmentCodeDto,
  isEnrolmentId,
  isPendingEnrolmentDto,
  isRunnerDto,
  isRunnerListDto,
  isRunnerVersionBelow,
  type RunnerDto,
} from './runner';

const RUNNER_ID = '01M6YSNJ000000000000000R01';
const OTHER_ID = '01M6YSNJ000000000000000R02';

const RUNNER: RunnerDto = {
  id: RUNNER_ID,
  name: 'Mac',
  isolation: 'user',
  hosted: false,
  version: '0.1.0',
  pinnedVersion: null,
  host: { os: 'darwin', arch: 'arm64', hostname: 'mac.local' },
  capabilities: { local: true, maxConcurrency: 1 },
  allowedProjects: ['team-console'],
  enrolledAt: '2026-11-10T00:00:00.000Z',
  lastSeenAt: null,
  lastSeenCountry: null,
  online: false,
  suspect: null,
  revokedAt: null,
  belowMinimum: false,
};

describe('compareRunnerVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.0', '1.0.1', -1],
    ['1.10.0', '1.9.0', 1],
    ['2.0.0', '10.0.0', -1],
    ['1.0.0-rc.1', '1.0.0', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0-rc.1', '1.0.0-beta', 1],
    ['1.0.0+build.7', '1.0.0', 0],
  ])('orders %s against %s as SemVer 2.0.0 does', (a, b, order) => {
    expect(compareRunnerVersions(a, b)).toBe(order);
  });

  it.each(['main', '1.0', '01.0.0', 'v1.0.0', ''])('cannot compare %j', (label) => {
    expect(compareRunnerVersions(label, '1.0.0')).toBeNull();
    expect(compareRunnerVersions('1.0.0', label)).toBeNull();
  });
});

describe('isRunnerVersionBelow', () => {
  it('flags nothing while no minimum is set', () => {
    expect(isRunnerVersionBelow('0.0.1', null)).toBe(false);
    expect(isRunnerVersionBelow('main', null)).toBe(false);
  });

  it('flags a lower version, not an equal or higher one', () => {
    expect(isRunnerVersionBelow('0.1.9', '0.2.0')).toBe(true);
    expect(isRunnerVersionBelow('0.2.0', '0.2.0')).toBe(false);
    expect(isRunnerVersionBelow('0.3.0-rc.1', '0.2.0')).toBe(false);
  });

  it('flags a label it cannot compare, since it cannot be shown to meet the minimum', () => {
    expect(isRunnerVersionBelow('main', '0.2.0')).toBe(true);
  });
});

describe('enrolCommandOf', () => {
  const code = `tce_${'A'.repeat(43)}`;

  it('builds the one command to paste', () => {
    expect(enrolCommandOf({ apiUrl: 'https://console.example.dev', code })).toBe(
      `team-console-runner enrol --url https://console.example.dev --code ${code}`,
    );
    expect(enrolCommandOf({ apiUrl: 'http://localhost:8787', code })).toContain('--url http://localhost:8787 ');
  });

  it.each([
    ['a URL with a path', { apiUrl: 'https://x.dev/path', code }],
    ['a URL with a shell metacharacter', { apiUrl: 'https://x.dev;rm -rf ~', code }],
    ['a non-http URL', { apiUrl: 'file:///etc', code }],
    ['a code with a space', { apiUrl: 'https://x.dev', code: 'tce_abc def' }],
    ['a code with a quote', { apiUrl: 'https://x.dev', code: `tce_${'A'.repeat(20)}'` }],
    ['a code with command substitution', { apiUrl: 'https://x.dev', code: 'tce_$(whoami)AAAAAAAAAAAAAA' }],
  ])('offers nothing for %s', (_, enrolment) => {
    expect(enrolCommandOf(enrolment)).toBeNull();
  });
});

describe('runner guards', () => {
  it('accepts a runner as the Worker answers it', () => {
    expect(isRunnerDto(RUNNER)).toBe(true);
    expect(
      isRunnerDto({
        ...RUNNER,
        lastSeenAt: '2026-11-10T00:01:00.000Z',
        suspect: { at: '2026-11-10T00:01:00.000Z', reason: 'two-pollers' },
        revokedAt: '2026-11-10T00:02:00.000Z',
      }),
    ).toBe(true);
  });

  it.each([
    ['no belowMinimum', { belowMinimum: undefined }],
    ['an unknown backend', { isolation: 'vm' }],
    ['a malformed id', { id: 'runner-1' }],
    ['an unknown suspect reason', { suspect: { at: '2026-11-10T00:00:00.000Z', reason: 'other' } }],
    ['a host without a hostname', { host: { os: 'darwin', arch: 'arm64' } }],
  ])('refuses a runner with %s', (_, patch) => {
    expect(isRunnerDto({ ...RUNNER, ...patch })).toBe(false);
  });

  it('requires the release and the pending codes beside the list', () => {
    const release = { version: '0.2.0', minimumVersion: null };
    expect(isRunnerListDto({ runners: [RUNNER], pendingEnrolments: [], release })).toBe(true);
    expect(isRunnerListDto({ runners: [RUNNER], release })).toBe(false);
    expect(isRunnerListDto({ runners: [RUNNER], pendingEnrolments: [] })).toBe(false);
    expect(
      isRunnerListDto({ runners: [RUNNER], pendingEnrolments: [], release: { version: 'not ok!', minimumVersion: null } }),
    ).toBe(false);
  });

  // #492: a pending code is named by its hash, never by the code.
  describe('pending enrolments', () => {
    const PENDING = {
      id: 'a1'.repeat(32),
      name: 'Mac',
      allowedProjects: ['team-console'],
      createdAt: '2026-11-12T10:00:00.000Z',
      expiresAt: '2026-11-12T10:10:00.000Z',
    };

    it('narrows a pending code', () => {
      expect(isPendingEnrolmentDto(PENDING)).toBe(true);
      expect(isRunnerListDto({ runners: [], pendingEnrolments: [PENDING], release: { version: null, minimumVersion: null } })).toBe(true);
    });

    it.each([
      ['an id that is not a SHA-256', { id: 'abc' }],
      ['an upper-case id', { id: 'A1'.repeat(32) }],
      ['a code in place of the id', { id: `tce_${'e'.repeat(43)}` }],
      ['no expiry', { expiresAt: 'soon' }],
      ['a project list that is not strings', { allowedProjects: [1] }],
    ])('refuses a pending code with %s', (_, patch) => {
      expect(isPendingEnrolmentDto({ ...PENDING, ...patch })).toBe(false);
    });

    it('takes a lowercase 64-hex id only', () => {
      expect(isEnrolmentId('0'.repeat(64))).toBe(true);
      expect(isEnrolmentId('0'.repeat(63))).toBe(false);
      expect(isEnrolmentId(42)).toBe(false);
    });
  });

  it('narrows an enrolment code answer', () => {
    const dto = {
      code: `tce_${'A'.repeat(43)}`,
      expiresAt: '2026-11-10T00:10:00.000Z',
      apiUrl: 'https://x.dev',
      audience: 'team-console:dev',
      name: 'Mac',
      allowedProjects: [],
    };
    expect(isEnrolmentCodeDto(dto)).toBe(true);
    expect(isEnrolmentCodeDto({ ...dto, expiresAt: 'soon' })).toBe(false);
    expect(isEnrolmentCodeDto({ ...dto, code: 7 })).toBe(false);
  });
});

describe('runner policy guards', () => {
  it.each([
    { mode: 'any' },
    { mode: 'pinned', runner: RUNNER_ID },
    { mode: 'failover', preferred: RUNNER_ID, fallback: [OTHER_ID], offline_after_seconds: 300 },
  ])('accepts %j', (policy) => {
    expect(isRunnerPolicy(policy)).toBe(true);
    expect(isRunnerPolicyDto({ policy, effective: policy })).toBe(true);
    expect(isRunnerPolicyDto({ policy: null, effective: policy })).toBe(true);
  });

  it.each([
    ['a failover without its threshold', { mode: 'failover', preferred: RUNNER_ID, fallback: [OTHER_ID] }],
    ['a failover without fallbacks', { mode: 'failover', preferred: RUNNER_ID, fallback: [], offline_after_seconds: 300 }],
    ['a pinned policy naming no runner', { mode: 'pinned' }],
    ['an unknown mode', { mode: 'round-robin' }],
    ['an extra member', { mode: 'any', runner: RUNNER_ID }],
  ])('refuses %s', (_, policy) => {
    expect(isRunnerPolicy(policy)).toBe(false);
  });

  it('refuses a DTO without an effective policy', () => {
    expect(isRunnerPolicyDto({ policy: null, effective: null })).toBe(false);
  });
});
