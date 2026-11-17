import {
  actionsRunIdOf,
  actionsRunnerNameOf,
  checkOidcExchangeInput,
  isActionsWorkflowDto,
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
    for (const name of ['Mac mini', 'actions:', 'actions:0123', 'actions:12a', 'xactions:12', 'actions:12 ']) {
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
    expect(checkEnrolRunnerInput({ ...body, isolation: 'actions-ephemeral' })).toMatchObject({ ok: false, field: 'isolation' });
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
    expect(isOidcExchangeResponse({ ...answer, teamConfig: { ...answer.teamConfig, budget: { monthly_usd: 400 } } })).toBe(true);
    expect(isOidcExchangeResponse({ ...answer, teamConfigRevision: undefined })).toBe(false);
    expect(isOidcExchangeResponse({ ...answer, teamConfigRevision: 1.5 })).toBe(false);
  });
});
