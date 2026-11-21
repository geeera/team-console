import { actionsSetupFixture } from './actions-setup.fixture';
import {
  actionsSummaryOf,
  canOpenPrOf,
  firstMissingStepOf,
  itemOf,
  notReadyItemKeysOf,
  notReadyMessageOf,
  stepStateOf,
  subCheckToneOf,
  workflowStepOf,
  workflowVersionsOf,
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

  it('counts an outdated workflow as passing, with its own state, and an unsupported one as missing (#870)', () => {
    const outdated = actionsSetupFixture({ items: { workflow: { status: 'outdated' } } });
    expect(outdated.ready).toBe(true);
    expect(stepStateOf(outdated, 'workflow')).toBe('outdated');
    expect(firstMissingStepOf(outdated)).toBeNull();
    expect(actionsSummaryOf(outdated)).toEqual({ kind: 'ready' });
    const unsupported = actionsSetupFixture({ items: { workflow: { status: 'unsupported' } } });
    expect(stepStateOf(unsupported, 'workflow')).toBe('missing');
    expect(actionsSummaryOf(unsupported)).toEqual({ kind: 'missing', n: 1 });
  });

  it('can open a PR only with the app’s permissions and the PR path on (#870)', () => {
    expect(canOpenPrOf(actionsSetupFixture())).toBe(true);
    expect(canOpenPrOf(actionsSetupFixture({ workflowPr: 'disabled' }))).toBe(false);
    expect(canOpenPrOf(actionsSetupFixture({ items: { 'app-permissions': { status: 'missing' } } }))).toBe(false);
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
    ['unsupported', 'bump'],
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

  it('calls the console’s PR for an earlier rendering stale, and still offers a new one (#870)', () => {
    const stale = { ...PR, stale: true } as const;
    expect(workflowStepOf(actionsSetupFixture({ items: { workflow: { status: 'outdated', pr: stale } } }))).toMatchObject({
      kind: 'pr-stale',
      pr: stale,
      action: 'bump',
    });
    expect(
      workflowStepOf(actionsSetupFixture({ items: { workflow: { status: 'missing', pr: { ...stale, provenance: 'changed' } } } })),
    ).toMatchObject({ kind: 'pr-foreign', action: null });
  });

  it('names the file’s runner and the console’s (#870)', () => {
    const setup = actionsSetupFixture({
      versions: { current: { runner: '0.1.0', node: '22.1.0', claudeCode: null } },
    });
    expect(workflowVersionsOf(setup)).toEqual({ old: '0.1.0', new: '0.2.0' });
    expect(workflowVersionsOf(actionsSetupFixture({ versions: { current: null } }))).toEqual({ old: null, new: '0.2.0' });
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

describe('notReadyMessageOf', () => {
  const translate = (key: string, params?: Record<string, unknown>): string => `${key}${params === undefined ? '' : JSON.stringify(params)}`;

  it('names the items, or says it bare when the refusal named none', () => {
    expect(notReadyMessageOf(['secret'], 'storify', translate)).toBe(
      'runners.err.actionsNotReady{"project":"storify","items":"actions.item.secret"}',
    );
    expect(notReadyMessageOf([], 'storify', translate)).toBe('runners.err.actionsNotReadyBare{"project":"storify"}');
  });
});
