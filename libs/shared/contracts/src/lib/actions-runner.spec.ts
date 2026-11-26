import {
  ACTIONS_SETUP_DTO_KEYS,
  ACTIONS_SETUP_ITEMS,
  actionsRunIdOf,
  actionsRunnerNameOf,
  blockingItemsOf,
  checkOidcExchangeInput,
  isActionsSetupDto,
  isActionsWorkflowDto,
  isGitHubUiUrl,
  isNeedsYouActionsDriftDto,
  NEEDS_YOU_ACTIONS_DRIFTS,
  type ActionsSetupDto,
  type ActionsSetupItemDto,
  isOidcExchangeResponse,
  isProjectDispatch,
} from './actions-runner';
import { checkEnrolRunnerInput, isEnrolmentIsolation } from './runner';
import { resolveTeamConfig } from './team-config';

const KEY = { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43) };
const BODY = {
  idToken: 'header.payload.signature',
  jobId: '01M6YSNJ0000000000000J0B01',
  publicKey: KEY,
  version: '0.4.0',
  host: { os: 'linux', arch: 'x64', hostname: 'fv-az1' },
};

describe('the ephemeral runner name', () => {
  it('carries the run id and reads it back; any other name is no run', () => {
    expect(actionsRunnerNameOf('9876543210')).toBe('actions:9876543210');
    expect(actionsRunIdOf('actions:9876543210')).toBe('9876543210');
    for (const name of [
      'Mac mini',
      'actions:',
      'actions:0123',
      'actions:12a',
      'xactions:12',
      'actions:12 ',
    ]) {
      expect(actionsRunIdOf(name), name).toBeNull();
    }
  });
});

describe('checkOidcExchangeInput', () => {
  it('takes the five members and keeps only the public key’s x', () => {
    const check = checkOidcExchangeInput({ ...BODY, publicKey: { ...KEY, alg: 'EdDSA' } });
    expect(check).toEqual({ ok: true, value: { ...BODY, publicKey: KEY } });
  });

  it.each([
    ['idToken', { idToken: '' }],
    ['idToken', { idToken: 'x'.repeat(8193) }],
    ['jobId', { jobId: 'not-a-ulid' }],
    ['publicKey', { publicKey: { ...KEY, d: 'B'.repeat(43) } }],
    ['publicKey', { publicKey: { kty: 'RSA', n: 'x', e: 'AQAB' } }],
    ['version', { version: 'v 1' }],
    ['host.os', { host: { arch: 'x64', hostname: 'h' } }],
    ['body', { isolation: 'actions-ephemeral' }],
  ])('refuses a bad %s', (field, change) => {
    expect(checkOidcExchangeInput({ ...BODY, ...change })).toMatchObject({ ok: false, field });
  });
});

describe('what an enrolment code can grant (#668)', () => {
  it('is every backend but actions-ephemeral', () => {
    expect(['container', 'user', 'none'].every(isEnrolmentIsolation)).toBe(true);
    expect(isEnrolmentIsolation('actions-ephemeral')).toBe(false);
    const body = {
      code: 'tce_x',
      publicKey: KEY,
      host: BODY.host,
      capabilities: { local: false, maxConcurrency: 1 },
      version: '0.4.0',
    };
    expect(checkEnrolRunnerInput({ ...body, isolation: 'container' }).ok).toBe(true);
    expect(checkEnrolRunnerInput({ ...body, isolation: 'actions-ephemeral' })).toMatchObject({
      ok: false,
      field: 'isolation',
    });
  });
});

// #817: the host fields reach the owner's runner list from `/runner/enrol` and the OIDC exchange too, so both refuse
// what an intent's bind refuses (R-INT-7).
describe('host fields on /runner/enrol and the OIDC exchange', () => {
  const enrolBody = {
    code: 'tce_x',
    publicKey: KEY,
    host: BODY.host,
    capabilities: { local: false, maxConcurrency: 1 },
    isolation: 'container',
    version: '0.4.0',
  };
  const doors = [
    ['/runner/enrol', (host: unknown) => checkEnrolRunnerInput({ ...enrolBody, host })],
    ['the OIDC exchange', (host: unknown) => checkOidcExchangeInput({ ...BODY, host })],
  ] as const;

  it.each(doors)('%s keeps plain text in any script', (_, check) => {
    const host = { os: 'linux', arch: 'x64', hostname: 'сборщик-1' };
    expect(check(host)).toMatchObject({ ok: true, value: { host } });
  });

  it.each(
    doors.flatMap(([door, check]) =>
      [
        ['a right-to-left override', { os: 'linux', arch: 'x64', hostname: 'a‮b' }, 'host.hostname'],
        ['a first-strong isolate', { os: 'linux', arch: 'x6⁨4', hostname: 'h' }, 'host.arch'],
        ['a left-to-right mark', { os: '‎linux', arch: 'x64', hostname: 'h' }, 'host.os'],
        ['a line separator', { os: 'linux', arch: 'x64', hostname: 'a b' }, 'host.hostname'],
        ['an escape', { os: 'linux', arch: 'x64', hostname: 'a\u001B[2Jb' }, 'host.hostname'],
        ['nothing but spaces', { os: 'linux', arch: 'x64', hostname: '  ' }, 'host.hostname'],
      ].map(([what, host, field]) => [door, what, check, host, field] as const),
    ),
  )('%s refuses %s', (_, __, check, host, field) => {
    expect(check(host)).toMatchObject({
      ok: false,
      field,
      detail: `${String(field)} must be visible text without control or direction characters`,
    });
  });
});

describe('isActionsWorkflowDto (#759)', () => {
  const dto = { text: 'name: x\n', sha256: 'a'.repeat(64), version: '0.1.0' };

  it('is the text, its hex SHA-256 and the pinned runner version, nothing more', () => {
    expect(isActionsWorkflowDto(dto)).toBe(true);
    expect(isActionsWorkflowDto({ ...dto, text: '' })).toBe(false);
    expect(isActionsWorkflowDto({ ...dto, sha256: 'A'.repeat(64) })).toBe(false);
    expect(isActionsWorkflowDto({ ...dto, sha256: 'a'.repeat(63) })).toBe(false);
    expect(isActionsWorkflowDto({ ...dto, version: 'latest' })).toBe(false);
    expect(isActionsWorkflowDto({ ...dto, consoleUrl: 'https://x.example' })).toBe(false);
    expect(isActionsWorkflowDto(null)).toBe(false);
  });
});

describe('the Actions readiness answer (#759 PR 3)', () => {
  const okItems = (): ActionsSetupItemDto[] =>
    ACTIONS_SETUP_ITEMS.map((id) => ({ id, status: 'ok' as const }));
  const ready: ActionsSetupDto = {
    dispatch: 'pull',
    accessSource: 'api_key',
    ready: true,
    checkedAt: '2026-11-18T00:00:00.000Z',
    items: okItems(),
    defaultBranch: 'main',
    workflowPr: 'enabled',
    versions: {
      expected: { runner: '0.2.0', node: '22.23.5', claudeCode: '2.1.325' },
      current: { runner: '0.2.0', node: '22.23.5', claudeCode: '2.1.325' },
      minRunner: '0.1.0',
      runnerSupport: 'supported',
    },
  };
  const withItem = (item: Record<string, unknown>): Record<string, unknown> => ({
    ...ready,
    ready: false,
    items: ready.items.map((entry) => (entry.id === item['id'] ? item : entry)),
  });

  it('accepts the exact key set, every item once, in the page’s order', () => {
    expect(isActionsSetupDto(ready)).toBe(true);
    expect(isActionsSetupDto({ ...ready, items: [...ready.items].reverse() })).toBe(false);
    expect(isActionsSetupDto({ ...ready, items: ready.items.slice(1) })).toBe(false);
    expect(isActionsSetupDto({ ...ready, secretNames: ['OTHER'] })).toBe(false);
    expect(isActionsSetupDto(withItem({ id: 'secret', status: 'ok', updatedAt: '2026-11-01' }))).toBe(false);
    expect(
      isActionsSetupDto(withItem({ id: 'protection-rules', status: 'wrong', reviewers: ['someone'] })),
    ).toBe(false);
    expect(isActionsSetupDto({ ...ready, checkedAt: 'yesterday' })).toBe(false);
  });

  it('has exactly the documented top-level keys (#870)', () => {
    expect(Object.keys(ready).sort()).toEqual([...ACTIONS_SETUP_DTO_KEYS].sort());
    for (const key of ACTIONS_SETUP_DTO_KEYS) {
      const { [key]: _dropped, ...rest } = ready;
      expect(isActionsSetupDto(rest), `without ${key}`).toBe(false);
    }
    expect(isActionsSetupDto({ ...ready, installationId: 1 })).toBe(false);
  });

  it('takes a default branch or null, and the PR path as enabled or disabled (#870)', () => {
    expect(isActionsSetupDto({ ...ready, defaultBranch: null })).toBe(true);
    expect(isActionsSetupDto({ ...ready, defaultBranch: '' })).toBe(false);
    expect(isActionsSetupDto({ ...ready, defaultBranch: 7 })).toBe(false);
    expect(isActionsSetupDto({ ...ready, workflowPr: 'disabled' })).toBe(true);
    expect(isActionsSetupDto({ ...ready, workflowPr: true })).toBe(false);
  });

  it('takes versions with exactly their keys, versions as x.y.z and current pins nullable (#870)', () => {
    const versions = ready.versions;
    const withVersions = (patch: Record<string, unknown>): Record<string, unknown> => ({
      ...ready,
      versions: { ...versions, ...patch },
    });
    expect(isActionsSetupDto(withVersions({ current: null, runnerSupport: 'unknown' }))).toBe(true);
    expect(
      isActionsSetupDto(withVersions({ current: { runner: null, node: '22.1.0', claudeCode: null } })),
    ).toBe(true);
    expect(isActionsSetupDto(withVersions({ expected: { ...versions.expected, runner: null } }))).toBe(false);
    expect(
      isActionsSetupDto(withVersions({ expected: { ...versions.expected, runner: '1.2.3-rc.1' } })),
    ).toBe(false);
    expect(isActionsSetupDto(withVersions({ current: { ...versions.current, sha: 'x' } }))).toBe(false);
    expect(isActionsSetupDto(withVersions({ minRunner: null }))).toBe(true);
    expect(isActionsSetupDto(withVersions({ minRunner: '0.2.0-rc.1' }))).toBe(true);
    expect(isActionsSetupDto(withVersions({ minRunner: '0.1 <beta>' }))).toBe(false);
    expect(isActionsSetupDto(withVersions({ runnerSupport: 'maybe' }))).toBe(false);
    expect(isActionsSetupDto(withVersions({ fileText: 'name: x' }))).toBe(false);
  });

  it('takes a stale flag on a PR only as true (#870)', () => {
    const pr = { number: 3, url: 'https://github.com/acme/x/pull/3', provenance: 'console' };
    expect(
      isActionsSetupDto(withItem({ id: 'workflow', status: 'missing', pr: { ...pr, stale: true } })),
    ).toBe(true);
    expect(
      isActionsSetupDto(withItem({ id: 'workflow', status: 'missing', pr: { ...pr, stale: false } })),
    ).toBe(false);
    expect(
      isActionsSetupDto(withItem({ id: 'workflow', status: 'missing', pr: { ...pr, stale: 'yes' } })),
    ).toBe(false);
  });

  it('refuses a ready flag that disagrees with the items', () => {
    expect(isActionsSetupDto({ ...ready, ready: false })).toBe(false);
    expect(isActionsSetupDto({ ...withItem({ id: 'secret', status: 'unknown' }), ready: true })).toBe(false);
  });

  it('takes links and PRs only on GitHub’s own UI, a PR only on the workflow item', () => {
    expect(
      isActionsSetupDto(
        withItem({
          id: 'secret',
          status: 'missing',
          link: 'https://github.com/acme/x/settings/environments',
        }),
      ),
    ).toBe(true);
    expect(
      isActionsSetupDto(withItem({ id: 'secret', status: 'missing', link: 'https://evil.example.com/' })),
    ).toBe(false);
    expect(
      isActionsSetupDto(withItem({ id: 'secret', status: 'missing', link: '/settings/projects/x/actions' })),
    ).toBe(false);
    const pr = { number: 3, url: 'https://github.com/acme/x/pull/3', provenance: 'console' };
    expect(isActionsSetupDto(withItem({ id: 'workflow', status: 'missing', pr }))).toBe(true);
    expect(isActionsSetupDto(withItem({ id: 'secret', status: 'missing', pr }))).toBe(false);
    expect(
      isActionsSetupDto(
        withItem({ id: 'workflow', status: 'missing', pr: { ...pr, url: 'https://evil.example.com/3' } }),
      ),
    ).toBe(false);
    expect(
      isActionsSetupDto(
        withItem({ id: 'workflow', status: 'missing', pr: { ...pr, provenance: 'trusted' } }),
      ),
    ).toBe(false);
  });

  it('counts unknown as blocking and protection rules as advisory', () => {
    const items = okItems().map((entry): ActionsSetupItemDto =>
      entry.id === 'secret'
        ? { ...entry, status: 'unknown' }
        : entry.id === 'protection-rules'
          ? { ...entry, status: 'wrong' }
          : entry,
    );
    expect(blockingItemsOf(items)).toEqual(['secret']);
    expect(blockingItemsOf(okItems())).toEqual([]);
  });

  it('lets an outdated workflow through and holds an unsupported one back (#870)', () => {
    const withWorkflow = (status: ActionsSetupItemDto['status']): ActionsSetupItemDto[] =>
      okItems().map((entry) => (entry.id === 'workflow' ? { ...entry, status } : entry));
    expect(blockingItemsOf(withWorkflow('outdated'))).toEqual([]);
    expect(blockingItemsOf(withWorkflow('unsupported'))).toEqual(['workflow']);
    expect(isActionsSetupDto({ ...ready, items: withWorkflow('outdated'), ready: true })).toBe(true);
    expect(isActionsSetupDto({ ...ready, items: withWorkflow('unsupported'), ready: true })).toBe(false);
  });

  it.each([
    ['https://github.com/acme/x', true],
    ['https://github.com.evil.example/x', false],
    ['http://github.com/acme/x', false],
    ['https://github.com/acme/x"onmouseover=', false],
    ['https://github.com/acme/<x>', false],
    ['https://github.com/acme/x y', false],
    [42, false],
    // #870: the host is the parser's, not a prefix's.
    ['https://github.com/acme/x/pull/3?diff=split#files', true],
    ['https://github.com', false],
    ['https://user@github.com/acme/x', false],
    ['https://user:pass@github.com/acme/x', false],
    ['https://github.com@evil.example/x', false],
    ['https://github.com:8443/acme/x', false],
    ['https://github.com:443/acme/x', false],
    ['https://GITHUB.com/acme/x', false],
    ['https://github.com./acme/x', false],
    ['https://api.github.com/repos/acme/x', false],
    ['https://evil.example/https://github.com/', false],
    ['javascript:alert(1)//https://github.com/', false],
    ['https://github.com/acme/x\\..\\evil', false],
    ['https://github.com/acme/x\n', false],
    [`https://github.com/${'a'.repeat(2100)}`, false],
    ['', false],
    [null, false],
  ])('isGitHubUiUrl(%j) is %s', (value, expected) => {
    expect(isGitHubUiUrl(value)).toBe(expected);
  });
});

describe('isProjectDispatch', () => {
  it('is pull or actions', () => {
    expect(isProjectDispatch('pull')).toBe(true);
    expect(isProjectDispatch('actions')).toBe(true);
    expect(isProjectDispatch('hosted')).toBe(false);
  });
});

describe('isOidcExchangeResponse', () => {
  const job = {
    id: '01M6YSNJ0000000000000J0B01',
    projectSlug: 'storify',
    kind: 'slot-dev',
    role: 'developer',
    state: 'claimed',
    items: [],
    priority: 0,
    requestedBy: 'owner',
    needsLocal: false,
    dispatch: 'actions',
    runnerId: '01M6YSNJ0000000000000RVN01',
    attempt: 1,
    maxMinutes: 90,
    createdAt: '2026-11-16T10:00:00.000Z',
    claimedAt: '2026-11-16T10:01:00.000Z',
    leaseUntil: '2026-11-16T10:06:00.000Z',
    startedAt: null,
    finishedAt: null,
    result: null,
  };
  const answer = {
    job,
    jobToken: 'tcj_x',
    leaseSeconds: 300,
    teamConfig: resolveTeamConfig(null, { revision: 0, accessSource: 'api_key' }),
    teamConfigRevision: null,
    runner: { id: '01M6YSNJ0000000000000RVN01', audience: 'team-console:dev' },
  };

  it('narrows the claim plus the runner identity, and nothing short of it', () => {
    expect(isOidcExchangeResponse(answer)).toBe(true);
    expect(isOidcExchangeResponse({ ...answer, runner: { id: 'nope', audience: 'x' } })).toBe(false);
    expect(isOidcExchangeResponse({ ...answer, runner: undefined })).toBe(false);
    expect(isOidcExchangeResponse({ ...answer, job: { ...job, state: 'sleeping' } })).toBe(false);
    expect(isOidcExchangeResponse(null)).toBe(false);
  });

  it('requires a team configuration to be present (#687) but leaves its shape to the job loop (#741)', () => {
    expect(isOidcExchangeResponse({ ...answer, teamConfigRevision: 3 })).toBe(true);
    expect(isOidcExchangeResponse({ ...answer, teamConfig: undefined })).toBe(false);
    // A malformed view is still an envelope the caller accepts; `launchPlanOf` is where it is judged and refused.
    expect(
      isOidcExchangeResponse({
        ...answer,
        teamConfig: { ...answer.teamConfig, budget: { monthly_usd: 400 } },
      }),
    ).toBe(true);
    expect(isOidcExchangeResponse({ ...answer, teamConfigRevision: undefined })).toBe(false);
    expect(isOidcExchangeResponse({ ...answer, teamConfigRevision: 1.5 })).toBe(false);
  });
});

describe('the Needs-you Actions drift (#874)', () => {
  const drift = { drift: 'modified', checkedAt: '2026-11-20T09:00:00.000Z' };

  it('accepts exactly the drift word and when it was checked', () => {
    expect(Object.keys(drift).sort()).toEqual(['checkedAt', 'drift']);
    expect(isNeedsYouActionsDriftDto(drift)).toBe(true);
    for (const word of NEEDS_YOU_ACTIONS_DRIFTS) {
      expect(isNeedsYouActionsDriftDto({ ...drift, drift: word })).toBe(true);
    }
  });

  it('refuses an added or a missing key, so nothing else of the stored row leaks', () => {
    expect(isNeedsYouActionsDriftDto({ ...drift, sha256: 'a'.repeat(64) })).toBe(false);
    expect(isNeedsYouActionsDriftDto({ drift: 'modified' })).toBe(false);
    expect(isNeedsYouActionsDriftDto({ checkedAt: drift.checkedAt })).toBe(false);
  });

  it('refuses a status that is no drift, and a time that is none', () => {
    expect(isNeedsYouActionsDriftDto({ ...drift, drift: 'ok' })).toBe(false);
    expect(isNeedsYouActionsDriftDto({ ...drift, drift: 'unknown' })).toBe(false);
    expect(isNeedsYouActionsDriftDto({ ...drift, checkedAt: 'yesterday' })).toBe(false);
    expect(isNeedsYouActionsDriftDto(null)).toBe(false);
  });
});
