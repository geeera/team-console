import { boundedIntegerOf, controlPathOf, sectionOf } from './team-fields';
import { fieldLabelOf, rawDiffOf, revisionChangesOf, valueTextOf, type Translate } from './team-words';

/** Echoes the key and its params, so the spec reads which copy a path takes. */
const t: Translate = (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`);

describe('fieldLabelOf', () => {
  it('names a role setting by the role and the setting, and the switch by the role alone', () => {
    expect(fieldLabelOf(t, 'roles.dev.model')).toBe('teamConfig.role.name.dev · teamConfig.field.role.model');
    expect(fieldLabelOf(t, 'roles.ui-designer.enabled')).toBe('teamConfig.role.name.ui-designer');
    expect(fieldLabelOf(t, 'caps.burn.dev_tasks')).toBe('teamConfig.rules.caps.burn: teamConfig.field.caps.dev_tasks');
    expect(fieldLabelOf(t, 'gates.code_paths[2]')).toBe('teamConfig.field.gates.code_paths');
  });
});

describe('valueTextOf', () => {
  it('words every kind of value, never a raw id or a boolean', () => {
    expect(valueTextOf(t, 'en', 'roles.dev.model', 'claude-opus-5-5')).toBe('teamConfig.model.opus');
    expect(valueTextOf(t, 'en', 'roles.dev.enabled', true)).toBe('teamConfig.value.on');
    expect(valueTextOf(t, 'en', 'cost.batch_api', false)).toBe('teamConfig.value.no');
    expect(valueTextOf(t, 'en', 'budget.monthly_usd', 250)).toBe('$250');
    expect(valueTextOf(t, 'en', 'budget.monthly_usd', null)).toBe('teamConfig.value.noBudget');
    expect(valueTextOf(t, 'en', 'gates.code_paths', ['apps/**', 'libs/**'])).toBe('apps/**, libs/**');
    expect(valueTextOf(t, 'en', 'access.source', 'subscription')).toBe('teamConfig.value.subscription');
  });

  it('keeps markup a value might carry as plain text (threat model T4)', () => {
    expect(valueTextOf(t, 'en', 'gates.code_paths', ['<img src=x onerror=alert(1)>'])).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('controls of a document path', () => {
  it('lands a role’s effort on its model button and its limits on the limits button', () => {
    expect(controlPathOf('roles.qa.effort')).toBe('roles.qa.model');
    expect(controlPathOf('roles.qa.max_turns')).toBe('roles.qa.limits');
    expect(controlPathOf('gates.code_paths[3]')).toBe('gates.code_paths');
    expect(controlPathOf('access.source')).toBe('access.source');
  });

  it('unfolds the section of a control', () => {
    expect(sectionOf('budget.monthly_usd')).toBe('limits');
    expect(sectionOf('roles.qa.limits')).toBe('roles');
    expect(sectionOf('sprint.freeze_days')).toBe('rules');
  });

  it('takes only whole numbers inside the bound', () => {
    expect(boundedIntegerOf(' 14 ', 7, 28)).toBe(14);
    expect(boundedIntegerOf('6', 7, 28)).toBeNull();
    expect(boundedIntegerOf('1e1', 0, 100)).toBeNull();
    expect(boundedIntegerOf('7.5', 0, 100)).toBeNull();
    expect(boundedIntegerOf('', 0, 100)).toBeNull();
  });
});

describe('revisionChangesOf', () => {
  it('words a stored diff: changed values, an added value after "not set", a removed one, never the schema tag', () => {
    const rows = revisionChangesOf(t, 'en', [
      { path: 'schema', to: 'team-config/v1' },
      { path: 'roles.qa.model', from: 'claude-opus-5-5', to: 'claude-sonnet-5' },
      { path: 'budget.monthly_usd', to: 200 },
      { path: 'language', from: 'en' },
    ]);
    expect(rows).toEqual([
      {
        path: 'roles.qa.model',
        label: 'teamConfig.role.name.qa · teamConfig.field.role.model',
        from: 'teamConfig.model.opus',
        to: 'teamConfig.model.sonnet',
      },
      {
        path: 'budget.monthly_usd',
        label: 'teamConfig.field.budget.monthly_usd',
        from: 'teamConfig.history.notSet',
        to: 'teamConfig.history.added{"value":"$200"}',
      },
      {
        path: 'language',
        label: 'teamConfig.field.language',
        from: 'teamConfig.rules.language.en',
        to: 'teamConfig.history.removed',
      },
    ]);
  });

  it('keeps markup in a stored value as plain text (T4)', () => {
    const [row] = revisionChangesOf(t, 'en', [
      { path: 'gates.code_paths', from: ['apps/**'], to: ['<img src=x onerror=alert(1)>'] },
    ]);
    expect(row?.to).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('rawDiffOf', () => {
  it('gives the diff as JSON by path, leaving out a side that was absent', () => {
    const raw = rawDiffOf([
      { path: 'roles.qa.effort', from: 'high', to: 'medium' },
      { path: 'budget.monthly_usd', to: 200 },
    ]);
    expect(JSON.parse(raw)).toEqual({
      'roles.qa.effort': { from: 'high', to: 'medium' },
      'budget.monthly_usd': { to: 200 },
    });
  });
});
