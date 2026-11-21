import { actionsSetupFixture } from './actions-setup.fixture';
import {
  actionsSummaryOf,
  canOpenPrOf,
  firstMissingStepOf,
  itemOf,
  notReadyItemKeysOf,
  stepStateOf,
  subCheckToneOf,
  workflowStepOf,
} from './actions-setup-view';

const PR = { number: 42, url: 'https://github.com/geeera/storify/pull/42', provenance: 'console' } as const;

describe('actions setup steps', () => {
  it('is pending before any answer', () => {
    expect(stepStateOf(null, 'environment')).toBe('pending');
    expect(firstMissingStepOf(null)).toBeNull();
  });

  it('counts a step done only when its blocking items are ok; reviewers only warn', () => {
    const setup = actionsSetupFixture({ items: { 'protection-rules': { status: 'wrong' } } });
    expect(stepStateOf(setup, 'environment')).toBe('done');
    expect(actionsSummaryOf(setup)).toEqual({ kind: 'ready' });
    expect(subCheckToneOf(itemOf(setup, 'protection-rules'))).toBe('warning');
  });

  it('never reads an unknown secret as ok', () => {
    const setup = actionsSetupFixture({ items: { 'app-permissions': { status: 'missing' }, secret: { status: 'unknown' } } });
    expect(stepStateOf(setup, 'environment')).toBe('missing');
    expect(subCheckToneOf(itemOf(setup, 'secret'))).toBe('unknown');
    expect(actionsSummaryOf(setup)).toEqual({ kind: 'missing', n: 2 });
    expect(firstMissingStepOf(setup)).toBe('permissions');
    expect(canOpenPrOf(setup)).toBe(false);
  });

  it('shows drift when switched on and no longer ready, and on when ready', () => {
    expect(actionsSummaryOf(actionsSetupFixture({ dispatch: 'actions', items: { secret: { status: 'missing' } } }))).toEqual({ kind: 'drift', n: 1 });
    expect(actionsSummaryOf(actionsSetupFixture({ dispatch: 'actions' }))).toEqual({ kind: 'on' });
  });
});

describe('workflowStepOf', () => {
  it.each([
    ['missing', 'open'],
    ['outdated', 'bump'],
    ['modified', 'restore'],
  ] as const)('offers a PR for a %s file', (status, action) => {
    const view = workflowStepOf(actionsSetupFixture({ items: { workflow: { status } } }));
    expect(view).toMatchObject({ kind: status, action, pr: null });
  });

  it('points at the console PR when one is open, and never says merge for a foreign one', () => {
    expect(workflowStepOf(actionsSetupFixture({ items: { workflow: { status: 'missing', pr: PR } } }))).toMatchObject({ kind: 'pr-open', action: null });
    for (const provenance of ['foreign', 'changed'] as const) {
      expect(workflowStepOf(actionsSetupFixture({ items: { workflow: { status: 'missing', pr: { ...PR, provenance } } } })).kind).toBe('pr-foreign');
    }
  });

  it('calls an open PR left over once the file is ok', () => {
    expect(workflowStepOf(actionsSetupFixture({ items: { workflow: { status: 'ok', pr: PR } } })).kind).toBe('leftover');
    expect(workflowStepOf(actionsSetupFixture()).kind).toBe('ok');
  });

  it('keeps only github.com links', () => {
    const blob = 'https://github.com/geeera/storify/blob/main/.github/workflows/team-console-runner.yml';
    expect(workflowStepOf(actionsSetupFixture({ items: { workflow: { status: 'modified', link: blob } } })).link).toBe(blob);
  });

  it('reads an unknown file as unknown, with nothing to open', () => {
    expect(workflowStepOf(actionsSetupFixture({ items: { workflow: { status: 'unknown' } } }))).toMatchObject({ kind: 'unknown', action: null });
  });
});

describe('notReadyItemKeysOf', () => {
  it('words refusal items in the page order, unknown ids once at the end', () => {
    expect(notReadyItemKeysOf(['workflow', 'future-item', 'secret', 'other'])).toEqual([
      'actions.item.secret',
      'actions.item.workflow',
      'actions.item.unknown',
    ]);
    expect(notReadyItemKeysOf([])).toEqual([]);
  });
});
