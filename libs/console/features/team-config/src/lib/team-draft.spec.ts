import { TEAM_CONFIG_PRESET_ROLES, TEAM_CONFIG_SCHEMA, checkTeamConfig, type TeamConfig } from '@shared/contracts';
import {
  changesOf,
  documentOf,
  draftOf,
  draftOfDocument,
  importedSectionCountOf,
  mergeOnTop,
  modelsChangedBy,
  overriddenRolesOf,
  overridesOf,
  resetRole,
  withImported,
  withLeaf,
  withPreset,
} from './team-draft';
import { teamConfigViewOf } from './testing';

const stored: TeamConfig = {
  schema: TEAM_CONFIG_SCHEMA,
  preset: 'recommended',
  access: { source: 'api_key' },
  roles: { qa: { model: 'claude-sonnet-5', effort: 'medium' }, 'ui-designer': { enabled: false } },
  gates: { qa: 'code' },
  budget: { monthly_usd: 200 },
};

describe('draftOf / changesOf', () => {
  it('reads every value in effect, so an untouched draft has no changes', () => {
    const draft = draftOf(teamConfigViewOf(stored));
    expect(draft.roles.qa.model).toBe('claude-sonnet-5');
    expect(draft.roles['ui-designer'].enabled).toBe(false);
    expect(draft.gates.qa).toBe('code');
    expect(draft.monthlyUsd).toBe(200);
    expect(changesOf(draft, draft)).toEqual([]);
  });

  it('lists each changed value by its document path, in page order', () => {
    const base = draftOf(teamConfigViewOf(stored));
    let draft = withLeaf(base, 'budget.monthly_usd', 250);
    draft = withLeaf(draft, 'roles.dev.model', 'claude-fable-5-1');
    draft = withLeaf(draft, 'roles.ui-designer.enabled', true);
    expect(changesOf(base, draft)).toEqual([
      { path: 'roles.dev.model', from: 'claude-opus-5-5', to: 'claude-fable-5-1' },
      { path: 'roles.ui-designer.enabled', from: false, to: true },
      { path: 'budget.monthly_usd', from: 200, to: 250 },
    ]);
  });
});

describe('overrides and presets', () => {
  it('counts a role as overridden when its model, effort or a limit differs from the preset', () => {
    const draft = draftOf(teamConfigViewOf(stored));
    expect(overriddenRolesOf(draft)).toEqual(['qa']);
    expect(overridesOf(draft, 'qa')).toEqual(['model', 'effort']);
    // The switch is not an override: UI designer is off but on its preset's model.
    expect(overridesOf(draft, 'ui-designer')).toEqual([]);
  });

  it('resets one role, or every role to the preset, keeping the switches', () => {
    const draft = draftOf(teamConfigViewOf(stored));
    expect(overriddenRolesOf(resetRole(draft, 'qa'))).toEqual([]);
    const reset = withPreset(draft, 'recommended');
    expect(overriddenRolesOf(reset)).toEqual([]);
    expect(reset.roles['ui-designer'].enabled).toBe(false);
  });

  it('says how many models a preset changes', () => {
    const draft = draftOf(teamConfigViewOf(null));
    expect(modelsChangedBy(draft, 'recommended')).toBe(0);
    const economy = withPreset(draft, 'economy');
    expect(economy.roles.dev.model).toBe(TEAM_CONFIG_PRESET_ROLES.economy.dev.model);
    expect(modelsChangedBy(draft, 'economy')).toBeGreaterThan(0);
  });
});

describe('documentOf', () => {
  it('stores roles as overrides of the preset only, and keeps the stored sections it did not touch', () => {
    const view = teamConfigViewOf(stored);
    const draft = withLeaf(withLeaf(draftOf(view), 'roles.dev.model', 'claude-fable-5-1'), 'sprint.length_days', 21);
    const document = documentOf(draft, view.config);
    expect(document.roles).toEqual({
      qa: { model: 'claude-sonnet-5', effort: 'medium' },
      'ui-designer': { enabled: false },
      dev: { model: 'claude-fable-5-1' },
    });
    expect(document.gates).toEqual({ qa: 'code' });
    expect(document.sprint).toEqual({ length_days: 21 });
    expect(document.budget).toEqual({ monthly_usd: 200 });
    expect(checkTeamConfig(document).ok).toBe(true);
  });

  it('turns an untouched project with no document into a minimal one the guard accepts', () => {
    const view = teamConfigViewOf(null);
    const document = documentOf(draftOf(view), null);
    expect(document).toEqual({ schema: TEAM_CONFIG_SCHEMA, access: { source: 'api_key' } });
  });

  it('never stores `enabled` for a never-off role or for security', () => {
    const view = teamConfigViewOf(null);
    const draft = withPreset(draftOf(view), 'economy');
    const document = documentOf(draft, null);
    expect(checkTeamConfig(document).ok).toBe(true);
    expect(JSON.stringify(document.roles ?? {})).not.toContain('enabled');
  });

  it('writes a budget cleared to no limit as null', () => {
    const view = teamConfigViewOf(stored);
    expect(documentOf(withLeaf(draftOf(view), 'budget.monthly_usd', null), view.config).budget).toEqual({ monthly_usd: null });
  });
});

describe('mergeOnTop', () => {
  it('puts my changes over their revision and reports only the values we both changed differently', () => {
    const base = draftOf(teamConfigViewOf(stored));
    const mine = withLeaf(withLeaf(base, 'budget.monthly_usd', 250), 'roles.dev.model', 'claude-fable-5-1');
    const theirs = withLeaf(withLeaf(base, 'budget.monthly_usd', 300), 'sprint.length_days', 21);
    const { draft, conflicts } = mergeOnTop(base, mine, theirs);
    expect(draft.monthlyUsd).toBe(250);
    expect(draft.roles.dev.model).toBe('claude-fable-5-1');
    expect(draft.sprint.length_days).toBe(21);
    expect(conflicts).toEqual([{ path: 'budget.monthly_usd', from: 300, to: 250 }]);
  });

  it('is no conflict when we both chose the same value', () => {
    const base = draftOf(teamConfigViewOf(stored));
    const same = withLeaf(base, 'gates.qa', 'always');
    expect(mergeOnTop(base, same, same).conflicts).toEqual([]);
  });
});

describe('draftOfDocument', () => {
  it('is the draft a revision gives on its own: preset, access, roles, budget', () => {
    const draft = draftOfDocument({ ...stored, budget: { monthly_usd: 300 } }, 'subscription');
    // `stored` already holds a budget of 200; the revision's own one wins.
    expect(draft).toEqual({ ...draftOf(teamConfigViewOf(stored)), monthlyUsd: 300 });
    expect(draft.source).toBe('api_key');
  });

  it('falls back to the given access source for a document without one', () => {
    expect(draftOfDocument({ schema: TEAM_CONFIG_SCHEMA }, 'subscription').source).toBe('subscription');
  });
});

describe('withImported', () => {
  const imported: TeamConfig = {
    schema: TEAM_CONFIG_SCHEMA,
    preset: 'recommended',
    gates: { qa: 'always', code_paths: ['apps/**', 'libs/**'] },
    caps: { burn: { dev_tasks: 4 } },
    language: 'en',
  };

  it('puts every rule the file names over the draft and keeps models, access, budget and the rest', () => {
    const base = { ...draftOf(teamConfigViewOf(stored)), monthlyUsd: 200 };
    const merged = withImported(base, imported);
    expect(merged.gates.qa).toBe('always');
    expect(merged.gates.code_paths).toEqual(['apps/**', 'libs/**']);
    expect(merged.gates.reviewer).toBe(base.gates.reviewer);
    expect(merged.caps.burn.dev_tasks).toBe(4);
    expect(merged.caps.burn.parallel_devs).toBe(base.caps.burn.parallel_devs);
    expect(merged.language).toBe('en');
    expect(merged.roles).toEqual(base.roles);
    expect(merged.source).toBe(base.source);
    expect(merged.monthlyUsd).toBe(200);
    expect(changesOf(base, merged).map((change) => change.path)).toEqual([
      'gates.qa',
      'gates.code_paths',
      'caps.burn.dev_tasks',
      'language',
    ]);
  });

  it('counts the sections the file filled', () => {
    expect(importedSectionCountOf(imported)).toBe(3);
    expect(importedSectionCountOf({ schema: TEAM_CONFIG_SCHEMA })).toBe(0);
  });
});
