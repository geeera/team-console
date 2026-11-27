import {
  RUNNER_CHECK_DEADLINE_SECONDS,
  RUNNER_CHECK_REASONS,
  RUNNER_EXPIRED_CHECK_REASONS,
  RUNNER_REPORTED_CHECK_REASONS,
  RUNNER_STORED_CHECK_REASONS,
  checkFinishRunnerCheckInput,
  checkStartRunnerCheckInput,
  isClaimResponse,
  isClaudeVersion,
  isRunnerCheckClaimResponse,
  isRunnerCheckDto,
  type RunnerCheckDto,
} from './runner-check';
import { RUNNER_CHECK_KINDS, checkClaimRunnerInput } from './runner';

// #1059 (security note S2, S5, test 15): the check's DTOs and bodies are exact key sets.

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const PASSED: RunnerCheckDto = {
  id: ID,
  kind: 'smoke',
  state: 'passed',
  reason: null,
  claudeVersion: '2.1.3',
  createdAt: '2026-11-27T10:00:00.000Z',
  pickedAt: '2026-11-27T10:00:05.000Z',
  finishedAt: '2026-11-27T10:00:06.000Z',
};

describe('the vocabularies', () => {
  it('splits what a runner may report from what only the server sets', () => {
    expect(RUNNER_CHECK_KINDS).toEqual(['smoke']);
    for (const reason of RUNNER_EXPIRED_CHECK_REASONS) {
      expect(RUNNER_REPORTED_CHECK_REASONS).not.toContain(reason);
    }
    expect(RUNNER_REPORTED_CHECK_REASONS).not.toContain('rate-limited');
    expect(RUNNER_REPORTED_CHECK_REASONS).not.toContain('runner-outdated');
    expect(RUNNER_STORED_CHECK_REASONS).toEqual([...RUNNER_REPORTED_CHECK_REASONS, ...RUNNER_EXPIRED_CHECK_REASONS]);
    expect(new Set(RUNNER_CHECK_REASONS).size).toBe(RUNNER_CHECK_REASONS.length);
    for (const reason of RUNNER_STORED_CHECK_REASONS) {
      expect(RUNNER_CHECK_REASONS).toContain(reason);
    }
  });
});

describe('isClaudeVersion (the shared bounded regex, S5)', () => {
  it.each(['2.1.3', '0.0.1', '2.1.3-beta.1', '2.1.3+build.7', '123456.123456.123456', `1.2.3-${'a'.repeat(32)}`])(
    'accepts %s',
    (value) => {
      expect(isClaudeVersion(value)).toBe(true);
    },
  );

  it.each([
    '',
    '2.1',
    '2.1.3 ',
    ' 2.1.3',
    '2.1.3\n',
    '2.1.3 (Claude Code)',
    '<img src=x>',
    '2.1.3-<b>',
    '1234567.1.1',
    `1.2.3-${'a'.repeat(33)}`,
    '2.1.3-é',
    '٢.١.٣',
    '2.1.3-',
    7,
    null,
  ])('refuses %j', (value) => {
    expect(isClaudeVersion(value)).toBe(false);
  });

  it('never exceeds the column’s 64 characters', () => {
    expect(`999999.999999.999999-${'a'.repeat(32)}`.length).toBeLessThanOrEqual(64);
  });
});

describe('isRunnerCheckDto', () => {
  it('accepts each consistent state', () => {
    expect(isRunnerCheckDto(PASSED)).toBe(true);
    expect(isRunnerCheckDto({ ...PASSED, state: 'queued', claudeVersion: null, pickedAt: null, finishedAt: null })).toBe(
      true,
    );
    expect(isRunnerCheckDto({ ...PASSED, state: 'failed', claudeVersion: null, reason: 'lost' })).toBe(true);
    expect(isRunnerCheckDto({ ...PASSED, state: 'failed', claudeVersion: null, reason: 'not-picked-up' })).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an extra key', { ...PASSED, command: 'sh' }],
    ['a missing key', { ...PASSED, finishedAt: undefined }],
    ['a non-ULID id', { ...PASSED, id: '../../x' }],
    ['an unknown kind', { ...PASSED, kind: 'exec' }],
    ['a pass without a version', { ...PASSED, claudeVersion: null }],
    ['a failure with a version', { ...PASSED, state: 'failed', reason: 'timeout' }],
    ['a failure without a reason', { ...PASSED, state: 'failed', claudeVersion: null }],
    ['an unknown reason', { ...PASSED, state: 'failed', claudeVersion: null, reason: 'exploded' }],
    ['a version that is markup', { ...PASSED, claudeVersion: '<img src=x onerror=alert(1)>' }],
  ])('refuses %s', (_case, value) => {
    const dto = Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
    expect(isRunnerCheckDto(dto)).toBe(false);
  });
});

describe('the claim answer guards (S2)', () => {
  const answer = { check: { id: ID, kind: 'smoke', deadlineSeconds: RUNNER_CHECK_DEADLINE_SECONDS } };

  it('accepts exactly {check: {id, kind, deadlineSeconds}}', () => {
    expect(isRunnerCheckClaimResponse(answer)).toBe(true);
    expect(isClaimResponse(answer)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['a command beside it', { check: { ...answer.check, command: '/bin/sh' } }],
    ['argv', { check: { ...answer.check, argv: ['-c', 'id'] } }],
    ['env', { check: { ...answer.check, env: { PATH: '/tmp' } } }],
    ['a path', { check: { ...answer.check, path: '/etc' } }],
    ['an unknown kind', { check: { ...answer.check, kind: 'exec' } }],
    ['an id that is a path', { check: { ...answer.check, id: '../../x' } }],
    ['an hour of deadline', { check: { ...answer.check, deadlineSeconds: 3600 } }],
    ['a fractional deadline', { check: { ...answer.check, deadlineSeconds: 1.5 } }],
    ['a job token beside it', { ...answer, jobToken: 'tcj_x' }],
    ['a job beside it', { ...answer, job: {} }],
    ['no check', {}],
  ])('refuses %s', (_case, value) => {
    expect(isRunnerCheckClaimResponse(value)).toBe(false);
    expect(isClaimResponse(value)).toBe(false);
  });
});

describe('checkStartRunnerCheckInput', () => {
  it('takes {kind: smoke} and nothing else', () => {
    expect(checkStartRunnerCheckInput({ kind: 'smoke' })).toEqual({ ok: true, value: { kind: 'smoke' } });
    expect(checkStartRunnerCheckInput({ kind: 'exec' })).toMatchObject({ ok: false, field: 'kind' });
    expect(checkStartRunnerCheckInput({ kind: 'smoke', argv: [] })).toMatchObject({ ok: false, field: 'body' });
    expect(checkStartRunnerCheckInput(null)).toMatchObject({ ok: false, field: 'body' });
  });
});

describe('checkFinishRunnerCheckInput (S5)', () => {
  it('takes a pass with its version and a failure with a runner-reportable reason', () => {
    expect(checkFinishRunnerCheckInput({ result: 'passed', claudeVersion: '2.1.3', durationMs: 0 })).toEqual({
      ok: true,
      value: { result: 'passed', claudeVersion: '2.1.3', durationMs: 0 },
    });
    for (const reason of RUNNER_REPORTED_CHECK_REASONS) {
      expect(checkFinishRunnerCheckInput({ result: 'failed', reason, durationMs: 60_000 })).toEqual({
        ok: true,
        value: { result: 'failed', reason, durationMs: 60_000 },
      });
    }
  });

  it('refuses the server-only reasons', () => {
    for (const reason of [...RUNNER_EXPIRED_CHECK_REASONS, 'rate-limited', 'runner-outdated', 'runner-paused']) {
      expect(checkFinishRunnerCheckInput({ result: 'failed', reason, durationMs: 1 })).toMatchObject({
        ok: false,
        field: 'reason',
      });
    }
  });

  it('names the field and never echoes the value', () => {
    const sentinel = 'SENTINEL-7f3a';
    const refusals = [
      checkFinishRunnerCheckInput({ result: 'passed', claudeVersion: `<img>${sentinel}`, durationMs: 1 }),
      checkFinishRunnerCheckInput({ result: 'failed', reason: sentinel, durationMs: 1 }),
      checkFinishRunnerCheckInput({ result: sentinel, durationMs: 1 }),
      checkFinishRunnerCheckInput({ result: 'passed', claudeVersion: '2.1.3', durationMs: 1, [sentinel]: true }),
    ];
    for (const refusal of refusals) {
      expect(refusal.ok).toBe(false);
      expect(JSON.stringify(refusal)).not.toContain(sentinel);
    }
  });

  it.each<[unknown, string]>([
    [{ result: 'passed', claudeVersion: '2.1.3', durationMs: -1 }, 'durationMs'],
    [{ result: 'passed', claudeVersion: '2.1.3', durationMs: 60_001 }, 'durationMs'],
    [{ result: 'passed', claudeVersion: '2.1.3', durationMs: '5' }, 'durationMs'],
    [{ result: 'passed', claudeVersion: '2.1.3' }, 'durationMs'],
    [{ result: 'passed', durationMs: 1 }, 'claudeVersion'],
    [{ result: 'passed', claudeVersion: '2.1.3', reason: 'timeout', durationMs: 1 }, 'reason'],
    [{ result: 'failed', reason: 'timeout', claudeVersion: '2.1.3', durationMs: 1 }, 'claudeVersion'],
    [{ result: 'failed', durationMs: 1 }, 'reason'],
  ])('refuses %j at %s', (body, field) => {
    expect(checkFinishRunnerCheckInput(body)).toMatchObject({ ok: false, field });
  });
});

describe('checkClaimRunnerInput checks (S1)', () => {
  it('takes a distinct subset of the kinds, [] included, beside accessSources', () => {
    expect(checkClaimRunnerInput({ checks: ['smoke'] })).toEqual({ ok: true, value: { checks: ['smoke'] } });
    expect(checkClaimRunnerInput({ checks: [] })).toEqual({ ok: true, value: { checks: [] } });
    expect(checkClaimRunnerInput({ accessSources: ['api_key'], checks: ['smoke'] })).toEqual({
      ok: true,
      value: { accessSources: ['api_key'], checks: ['smoke'] },
    });
    expect(checkClaimRunnerInput({})).toEqual({ ok: true, value: {} });
  });

  it.each([[['exec']], [['smoke', 'smoke']], [['smoke', 'exec']], ['smoke'], [{ 0: 'smoke' }], [[null]]])(
    'refuses %j',
    (checks) => {
      expect(checkClaimRunnerInput({ checks })).toMatchObject({ ok: false, field: 'checks' });
    },
  );
});
