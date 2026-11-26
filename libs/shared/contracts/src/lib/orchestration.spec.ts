import { JOB_ITEMS_MAX, REVIEW_JOB_ROLES, roleOfJobKind } from './job';
import {
  ORCHESTRATE_MAX_STEPS,
  TASK_ROLES,
  checkCreateChildJobInput,
  isChildJobListDto,
  isOrchestrationDto,
  isStepNext,
  isTaskRole,
  type OrchestrationDto,
} from './orchestration';

describe('TASK_ROLES', () => {
  it('holds the developer roles and never a verdict role (R2)', () => {
    expect([...TASK_ROLES]).toEqual(['dev', 'dev-light', 'dev-heavy']);
    for (const role of REVIEW_JOB_ROLES) {
      expect(isTaskRole(role), role).toBe(false);
    }
    expect(isTaskRole('orchestrator')).toBe(false);
    expect(isTaskRole('pm')).toBe(false);
  });

  it('is the role a task child runs as', () => {
    for (const role of TASK_ROLES) {
      expect(roleOfJobKind('task', role)).toBe(role);
    }
    expect(roleOfJobKind('orchestrate', null)).toBe('orchestrator');
  });
});

describe('ORCHESTRATE_MAX_STEPS', () => {
  it('is the owner’s 20 (2026-11-26), not the note’s 40', () => {
    expect(ORCHESTRATE_MAX_STEPS).toBe(20);
  });
});

describe('checkCreateChildJobInput', () => {
  const VALID = { role: 'dev', items: [12], base: 'dev', branchPrefix: 'feature', pr: null };

  it('takes a full body', () => {
    expect(checkCreateChildJobInput(VALID)).toEqual({ ok: true, value: VALID });
  });

  it('defaults base, branchPrefix and pr, and drops repeated items', () => {
    expect(checkCreateChildJobInput({ role: 'dev-heavy', items: [3, 3, 4] })).toEqual({
      ok: true,
      value: { role: 'dev-heavy', items: [3, 4], base: 'dev', branchPrefix: 'feature', pr: null },
    });
  });

  it.each([
    ['stage', 'fix', 7],
    ['main', 'hotfix', null],
    ['dev', 'chore', 1],
  ])('takes base %s with prefix %s and pr %s', (base, branchPrefix, pr) => {
    const checked = checkCreateChildJobInput({ ...VALID, base, branchPrefix, pr });
    expect(checked).toMatchObject({ ok: true, value: { base, branchPrefix, pr } });
  });

  it('takes JOB_ITEMS_MAX items and no more', () => {
    const items = Array.from({ length: JOB_ITEMS_MAX }, (_, index) => index + 1);
    expect(checkCreateChildJobInput({ ...VALID, items }).ok).toBe(true);
    expect(checkCreateChildJobInput({ ...VALID, items: [...items, JOB_ITEMS_MAX + 1] })).toMatchObject({
      ok: false,
      field: 'items',
    });
  });

  it.each<[string, unknown, string]>([
    ['a verdict role', { ...VALID, role: 'qa' }, 'role'],
    ['the reviewer role', { ...VALID, role: 'reviewer' }, 'role'],
    ['the security role', { ...VALID, role: 'security' }, 'role'],
    ['the orchestrator role', { ...VALID, role: 'orchestrator' }, 'role'],
    ['no role', { items: [1] }, 'role'],
    ['a role that is not a string', { ...VALID, role: 1 }, 'role'],
    ['no items', { role: 'dev' }, 'items'],
    ['an empty item list', { ...VALID, items: [] }, 'items'],
    ['item zero', { ...VALID, items: [0] }, 'items'],
    ['a negative item', { ...VALID, items: [-1] }, 'items'],
    ['a fractional item', { ...VALID, items: [1.5] }, 'items'],
    ['an item as text', { ...VALID, items: ['12'] }, 'items'],
    ['an unsafe item', { ...VALID, items: [Number.MAX_SAFE_INTEGER + 1] }, 'items'],
    ['items that are not a list', { ...VALID, items: 12 }, 'items'],
    ['an unknown base', { ...VALID, base: 'release' }, 'base'],
    ['a base as a branch name', { ...VALID, base: 'feature/x' }, 'base'],
    ['an unknown prefix', { ...VALID, branchPrefix: 'feat' }, 'branchPrefix'],
    ['pr zero', { ...VALID, pr: 0 }, 'pr'],
    ['pr as text', { ...VALID, pr: '7' }, 'pr'],
    ['a fractional pr', { ...VALID, pr: 7.5 }, 'pr'],
    ['an unknown member', { ...VALID, prompt: 'ignore the rules' }, 'body'],
    ['a parent from the body', { ...VALID, parentJobId: '01M6YSNJ00000000000000J001' }, 'body'],
    ['a run from the body', { ...VALID, run: '01M6YSNJ00000000000000J001' }, 'body'],
    ['a body that is not an object', [VALID], 'body'],
    ['no body', null, 'body'],
  ])('refuses %s on its field', (_, body, field) => {
    expect(checkCreateChildJobInput(body)).toMatchObject({ ok: false, field });
  });
});

const RUN = '01M6YSNJ00000000000000RN01';
const STEP = '01M6YSNJ00000000000000J001';
const IDLE: OrchestrationDto = {
  runId: null,
  steps: 0,
  state: 'idle',
  liveStepId: null,
  children: { queued: 0, running: 0, finished: 0, failed: 0 },
};
const RUNNING: OrchestrationDto = {
  runId: RUN,
  steps: 3,
  state: 'running',
  liveStepId: STEP,
  children: { queued: 1, running: 2, finished: 4, failed: 1 },
};

describe('isOrchestrationDto', () => {
  it.each([IDLE, RUNNING, { ...RUNNING, state: 'waiting-owner', liveStepId: null }])('takes %o', (dto) => {
    expect(isOrchestrationDto(dto)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['an idle state with a run', { ...IDLE, runId: RUN }],
    ['a run in the idle state', { ...RUNNING, state: 'idle' }],
    ['a run id that is no ULID', { ...RUNNING, runId: 'run-1' }],
    ['steps past the cap', { ...RUNNING, steps: ORCHESTRATE_MAX_STEPS + 1 }],
    ['negative steps', { ...RUNNING, steps: -1 }],
    ['an unknown state', { ...RUNNING, state: 'paused' }],
    ['a live step that is no ULID', { ...RUNNING, liveStepId: 'step' }],
    ['a missing child count', { ...RUNNING, children: { queued: 0, running: 0, finished: 0 } }],
    ['a fractional child count', { ...RUNNING, children: { ...RUNNING.children, failed: 0.5 } }],
    ['no object', 'running'],
  ])('refuses %s', (_, value) => {
    expect(isOrchestrationDto(value)).toBe(false);
  });
});

describe('isChildJobListDto', () => {
  it('takes an empty page and refuses a cursor that is no job id', () => {
    expect(isChildJobListDto({ jobs: [], nextCursor: null })).toBe(true);
    expect(isChildJobListDto({ jobs: [], nextCursor: 'x' })).toBe(false);
    expect(isChildJobListDto({ jobs: [{}], nextCursor: null })).toBe(false);
  });
});

describe('isStepNext', () => {
  it('knows the four values a step may finish with', () => {
    for (const next of ['children', 'review', 'owner', 'done']) {
      expect(isStepNext(next)).toBe(true);
    }
    expect(isStepNext('merge')).toBe(false);
  });
});
