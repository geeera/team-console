import {
  MODEL_ALLOW_LIST,
  NEVER_OFF_ROLES,
  SUGGESTED_MONTHLY_BUDGET_USD,
  TEAM_CONFIG_BOUNDS,
  TEAM_CONFIG_MAX_BYTES,
  TEAM_CONFIG_PRESET_ROLES,
  TEAM_CONFIG_SCHEMA,
  TEAM_ROLES,
  allowedModelsOf,
  checkTeamConfig,
  defaultPresetOf,
  isResolvedTeamConfig,
  isTeamConfig,
  presetViewOf,
  resolveTeamConfig,
  teamConfigDiffOf,
  type TeamConfig,
  type TeamRole,
} from './team-config';

const doc = (members: Record<string, unknown> = {}): Record<string, unknown> => ({ schema: TEAM_CONFIG_SCHEMA, ...members });

function refusal(value: unknown): { type: string; field: string } | null {
  const check = checkTeamConfig(value);
  return check.ok ? null : { type: check.type, field: check.field };
}

const invalidAt = (field: string) => ({ type: 'team-config-invalid', field });

describe('checkTeamConfig: the schema member', () => {
  it('accepts the smallest document, the schema alone', () => {
    expect(checkTeamConfig(doc())).toEqual({ ok: true, value: { schema: TEAM_CONFIG_SCHEMA } });
  });

  it.each([['team-config/v2'], ['team-config/v0'], [''], [1], [null]])('refuses schema %j as team-config-schema', (schema) => {
    expect(refusal({ schema })).toEqual({ type: 'team-config-schema', field: 'schema' });
  });

  it('refuses a document without a schema as team-config-schema', () => {
    expect(refusal({ preset: 'economy' })).toEqual({ type: 'team-config-schema', field: 'schema' });
  });

  it.each([[null], [[]], ['team-config/v1'], [7]])('refuses %j as the document', (value) => {
    expect(refusal(value)).toEqual(invalidAt('config'));
  });
});

describe('checkTeamConfig: exact keys at every level', () => {
  it.each([
    ['an unknown top-level key', doc({ model: 'claude-opus-5-5' }), 'model'],
    ['an unknown role', doc({ roles: { intern: { model: 'claude-sonnet-5' } } }), 'roles.intern'],
    ['an unknown role member', doc({ roles: { dev: { temperature: 1 } } }), 'roles.dev.temperature'],
    ['an unknown gates member', doc({ gates: { security: 'always' } }), 'gates.security'],
    ['an unknown cap mode', doc({ caps: { turbo: { dev_tasks: 1 } } }), 'caps.turbo'],
    ['an unknown cap member', doc({ caps: { burn: { devs: 1 } } }), 'caps.burn.devs'],
    ['an unknown access member', doc({ access: { source: 'api_key', kind: 'api-key' } }), 'access.kind'],
    ['a credential-like access member', doc({ access: { source: 'api_key', token: 'x' } }), 'access.token'],
    ['an unknown budget member', doc({ budget: { monthly_usd: 10, daily_usd: 1 } }), 'budget.daily_usd'],
    ['an unknown cost member', doc({ cost: { batch: true } }), 'cost.batch'],
  ])('refuses %s with its path', (_, value, field) => {
    expect(refusal(value)).toEqual(invalidAt(field));
  });

  it('refuses a __proto__ key parsed from JSON, at the top and nested', () => {
    expect(refusal(JSON.parse('{"schema":"team-config/v1","__proto__":{"preset":"max"}}'))).toEqual(
      invalidAt('__proto__'),
    );
    expect(refusal(JSON.parse('{"schema":"team-config/v1","roles":{"__proto__":{"model":"claude-fable-5-1"}}}'))).toEqual(
      invalidAt('roles.__proto__'),
    );
  });

  it('refuses constructor and prototype keys', () => {
    expect(refusal(doc({ constructor: {} }))).toEqual(invalidAt('constructor'));
    expect(refusal(doc({ roles: { constructor: {} } }))).toEqual(invalidAt('roles.constructor'));
    expect(refusal(doc({ gates: { prototype: 1 } }))).toEqual(invalidAt('gates.prototype'));
  });

  it('refuses an object whose prototype was forged, and never reads inherited members', () => {
    const forged = Object.create({ preset: 'max' }) as Record<string, unknown>;
    forged['schema'] = TEAM_CONFIG_SCHEMA;
    expect(refusal(forged)).toEqual(invalidAt('config'));
    const nested = doc({ roles: Object.create({ dev: { model: 'claude-fable-5-1' } }) as object });
    expect(refusal(nested)).toEqual(invalidAt('roles'));
  });

  it('answers a fresh copy, so nothing of the caller’s object survives into storage', () => {
    const input = doc({ preset: 'economy' });
    const check = checkTeamConfig(input);
    expect(check.ok && check.value).toEqual(input);
    expect(check.ok && check.value).not.toBe(input);
  });
});

/** Every integer bound ±1 (property: the bound itself passes, one past it on either side fails). */
const INTEGER_FIELDS: readonly (readonly [string, { readonly min: number; readonly max: number }, (n: unknown) => Record<string, unknown>])[] = [
  ['roles.dev.max_parallel', TEAM_CONFIG_BOUNDS.maxParallel, (n) => doc({ roles: { dev: { max_parallel: n } } })],
  ['roles.dev.max_minutes', TEAM_CONFIG_BOUNDS.maxMinutes, (n) => doc({ roles: { dev: { max_minutes: n } } })],
  ['roles.scribe.max_turns', TEAM_CONFIG_BOUNDS.maxTurns, (n) => doc({ roles: { scribe: { max_turns: n } } })],
  ['gates.max_rework_rounds', TEAM_CONFIG_BOUNDS.maxReworkRounds, (n) => doc({ gates: { max_rework_rounds: n } })],
  ['caps.normal.dev_tasks', TEAM_CONFIG_BOUNDS.devTasks, (n) => doc({ caps: { normal: { dev_tasks: n } } })],
  ['caps.burn.parallel_devs', TEAM_CONFIG_BOUNDS.parallelDevs, (n) => doc({ caps: { burn: { parallel_devs: n } } })],
  ['sprint.length_days', TEAM_CONFIG_BOUNDS.lengthDays, (n) => doc({ sprint: { length_days: n, freeze_days: 0 } })],
  ['sprint.freeze_days', TEAM_CONFIG_BOUNDS.freezeDays, (n) => doc({ sprint: { length_days: 28, freeze_days: n } })],
  ['budget.monthly_usd', TEAM_CONFIG_BOUNDS.monthlyUsd, (n) => doc({ budget: { monthly_usd: n } })],
];

describe.each(INTEGER_FIELDS)('the bound of %s', (field, bound, build) => {
  it('accepts min and max', () => {
    expect(isTeamConfig(build(bound.min))).toBe(true);
    expect(isTeamConfig(build(bound.max))).toBe(true);
  });

  it('refuses min − 1 and max + 1', () => {
    expect(refusal(build(bound.min - 1))).toEqual(invalidAt(field));
    expect(refusal(build(bound.max + 1))).toEqual(invalidAt(field));
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [bound.min + 0.5], [String(bound.min)], [true], [null], [[bound.min]]])(
    'refuses %j',
    (value) => {
      if (field === 'budget.monthly_usd' && value === null) {
        expect(isTeamConfig(build(value))).toBe(true);
        return;
      }
      expect(refusal(build(value))).toEqual(invalidAt(field));
    },
  );
});

describe('checkTeamConfig: enums', () => {
  it.each([
    ['preset', doc({ preset: 'cheap' })],
    ['preset', doc({ preset: 'custom' })],
    ['access.source', doc({ access: { source: 'oauth' } })],
    ['access.source', doc({ access: {} })],
    ['roles.dev.effort', doc({ roles: { dev: { effort: 'max' } } })],
    ['gates.qa', doc({ gates: { qa: 'never' } })],
    ['gates.reviewer', doc({ gates: { reviewer: 'sometimes' } })],
    ['language', doc({ language: 'de' })],
    ['cost.reviewer_context', doc({ cost: { reviewer_context: 'tree' } })],
    ['cost.prompt_caching', doc({ cost: { prompt_caching: 'yes' } })],
  ])('refuses a value outside %s', (field, value) => {
    expect(refusal(value)).toEqual(invalidAt(field));
  });
});

describe('checkTeamConfig: models and their per-role bounds', () => {
  it.each(['opus', 'claude-opus', 'claude-opus-5-5 --dangerously-skip-permissions', 'claude-opus-4-1', ''])(
    'refuses %j, which is not one of the four pinned ids',
    (model) => {
      expect(refusal(doc({ roles: { dev: { model } } }))).toEqual(invalidAt('roles.dev.model'));
    },
  );

  it('never runs security on Fable or Haiku, and allows it Opus and Sonnet', () => {
    expect(refusal(doc({ roles: { security: { model: 'claude-fable-5-1' } } }))).toEqual(invalidAt('roles.security.model'));
    expect(refusal(doc({ roles: { security: { model: 'claude-haiku-4-5-20251001' } } }))).toEqual(
      invalidAt('roles.security.model'),
    );
    expect(isTeamConfig(doc({ roles: { security: { model: 'claude-sonnet-5' } } }))).toBe(true);
    expect(isTeamConfig(doc({ roles: { security: { model: 'claude-opus-5-5' } } }))).toBe(true);
  });

  it.each(TEAM_ROLES.filter((role) => role !== 'scribe'))('gives %s no Haiku', (role) => {
    expect(refusal(doc({ roles: { [role]: { model: 'claude-haiku-4-5-20251001' } } }))).toEqual(
      invalidAt(`roles.${role}.model`),
    );
  });

  it('lets scribe run on Haiku', () => {
    expect(allowedModelsOf('scribe')).toEqual(MODEL_ALLOW_LIST);
  });
});

describe('checkTeamConfig: roles that stay on', () => {
  it.each(NEVER_OFF_ROLES)('refuses %s with enabled: false, accepts enabled: true', (role) => {
    expect(refusal(doc({ roles: { [role]: { enabled: false } } }))).toEqual(invalidAt(`roles.${role}.enabled`));
    expect(isTeamConfig(doc({ roles: { [role]: { enabled: true } } }))).toBe(true);
  });

  it.each([[true], [false], ['true'], [null]])('refuses roles.security.enabled at any value (%j)', (enabled) => {
    expect(refusal(doc({ roles: { security: { enabled } } }))).toEqual(invalidAt('roles.security.enabled'));
  });

  it.each(TEAM_ROLES.filter((role) => !NEVER_OFF_ROLES.includes(role) && role !== 'security'))(
    'lets %s be switched off',
    (role) => {
      expect(isTeamConfig(doc({ roles: { [role]: { enabled: false } } }))).toBe(true);
    },
  );
});

describe('checkTeamConfig: code_paths', () => {
  const at = (paths: unknown) => doc({ gates: { code_paths: paths } });

  it('accepts relative globs up to the count and the length', () => {
    expect(isTeamConfig(at(['apps/**']))).toBe(true);
    expect(isTeamConfig(at(Array.from({ length: 20 }, (_, i) => `p${String(i)}/**`)))).toBe(true);
    expect(isTeamConfig(at(['a'.repeat(200)]))).toBe(true);
  });

  it.each([
    ['an empty list (it would recreate never)', [], 'gates.code_paths'],
    ['21 globs', Array.from({ length: 21 }, (_, i) => `p${String(i)}`), 'gates.code_paths'],
    ['a glob of 201 characters', ['a'.repeat(201)], 'gates.code_paths[0]'],
    ['an empty glob', [''], 'gates.code_paths[0]'],
    ['..', ['apps/../secrets'], 'gates.code_paths[0]'],
    ['a leading /', ['/etc/**'], 'gates.code_paths[0]'],
    ['a backslash', ['apps\\**'], 'gates.code_paths[0]'],
    ['a control character', ['apps/\n**'], 'gates.code_paths[0]'],
    ['a number', [7], 'gates.code_paths[0]'],
    ['a string instead of a list', 'apps/**', 'gates.code_paths'],
  ])('refuses %s', (_, paths, field) => {
    expect(refusal(at(paths))).toEqual(invalidAt(field));
  });
});

describe('checkTeamConfig: document-wide rules', () => {
  it('refuses a document over 16 KB, whatever is in it', () => {
    const big = doc({ gates: { code_paths: ['x'.repeat(TEAM_CONFIG_MAX_BYTES)] } });
    expect(refusal(big)).toEqual(invalidAt('config'));
  });

  it('refuses a freeze as long as the sprint, judged on the resolved values', () => {
    expect(refusal(doc({ sprint: { length_days: 7, freeze_days: 7 } }))).toEqual(invalidAt('sprint.freeze_days'));
    expect(isTeamConfig(doc({ sprint: { length_days: 7, freeze_days: 6 } }))).toBe(true);
  });
});

describe('the presets are data', () => {
  it('makes recommended exactly today’s table (the runner’s ROLE_MODELS, the agent frontmatter)', () => {
    const models = Object.fromEntries(TEAM_ROLES.map((role) => [role, TEAM_CONFIG_PRESET_ROLES.recommended[role].model]));
    expect(models).toEqual({
      pm: 'claude-opus-5-5',
      architect: 'claude-fable-5-1',
      orchestrator: 'claude-opus-5-5',
      dev: 'claude-opus-5-5',
      'dev-light': 'claude-sonnet-5',
      'dev-heavy': 'claude-fable-5-1',
      qa: 'claude-opus-5-5',
      reviewer: 'claude-sonnet-5',
      security: 'claude-opus-5-5',
      devops: 'claude-sonnet-5',
      analyst: 'claude-sonnet-5',
      scribe: 'claude-haiku-4-5-20251001',
      'ux-designer': 'claude-opus-5-5',
      'ui-designer': 'claude-opus-5-5',
    });
  });

  it('keeps every preset inside the per-role bounds and every role on', () => {
    for (const preset of ['economy', 'recommended', 'max'] as const) {
      for (const role of TEAM_ROLES) {
        const entry = TEAM_CONFIG_PRESET_ROLES[preset][role];
        expect(allowedModelsOf(role), `${preset} ${role}`).toContain(entry.model);
        expect(entry.enabled).toBe(true);
      }
      expect(isResolvedTeamConfig(resolveTeamConfig({ schema: TEAM_CONFIG_SCHEMA, preset }, { revision: 1, accessSource: 'api_key' }))).toBe(true);
    }
  });

  it('follows #631: economy for a new API-key project, $400 / $700 suggested budgets', () => {
    expect(defaultPresetOf('api_key')).toBe('economy');
    expect(defaultPresetOf('subscription')).toBe('recommended');
    expect(SUGGESTED_MONTHLY_BUDGET_USD).toEqual({ economy: 400, recommended: 700, max: null });
  });

  it('caps no role’s parallel jobs below the bound in recommended, so nothing changes for a project without a row', () => {
    for (const role of TEAM_ROLES) {
      expect(TEAM_CONFIG_PRESET_ROLES.recommended[role].max_parallel).toBe(TEAM_CONFIG_BOUNDS.maxParallel.max);
    }
  });
});

describe('resolveTeamConfig', () => {
  it('resolves no document to recommended with the project’s access source', () => {
    const view = resolveTeamConfig(null, { revision: 0, accessSource: 'subscription' });
    expect(view.revision).toBe(0);
    expect(view.access).toEqual({ source: 'subscription' });
    expect(view.roles).toEqual(TEAM_CONFIG_PRESET_ROLES.recommended);
    expect(view.gates.qa).toBe('always');
    expect(isResolvedTeamConfig(view)).toBe(true);
  });

  it('fills a missing role or member from the preset and keeps an override', () => {
    const stored: TeamConfig = {
      schema: TEAM_CONFIG_SCHEMA,
      preset: 'economy',
      access: { source: 'api_key' },
      roles: { dev: { model: 'claude-opus-5-5' }, scribe: { enabled: false } },
      sprint: { freeze_days: 3 },
    };
    const view = resolveTeamConfig(stored, { revision: 4, accessSource: 'subscription' });
    expect(view.access.source).toBe('api_key');
    expect(view.roles.dev).toEqual({ ...TEAM_CONFIG_PRESET_ROLES.economy.dev, model: 'claude-opus-5-5' });
    expect(view.roles.scribe.enabled).toBe(false);
    expect(view.roles.pm).toEqual(TEAM_CONFIG_PRESET_ROLES.economy.pm);
    expect(view.sprint).toEqual({ length_days: 14, freeze_days: 3 });
    expect(isResolvedTeamConfig(view)).toBe(true);
  });

  it('is deterministic', () => {
    const stored: TeamConfig = { schema: TEAM_CONFIG_SCHEMA, preset: 'max' };
    expect(resolveTeamConfig(stored, { revision: 2, accessSource: 'api_key' })).toEqual(
      resolveTeamConfig(stored, { revision: 2, accessSource: 'api_key' }),
    );
  });

  it('carries no budget, preset, reason, author, diff or credential member (key set)', () => {
    const view = resolveTeamConfig({ schema: TEAM_CONFIG_SCHEMA, budget: { monthly_usd: 9 } }, { revision: 1, accessSource: 'api_key' });
    expect(Object.keys(view).sort()).toEqual(['access', 'caps', 'cost', 'gates', 'language', 'revision', 'roles', 'schema', 'sprint']);
    expect(Object.keys(view.access)).toEqual(['source']);
  });
});

describe('isResolvedTeamConfig', () => {
  const view = resolveTeamConfig(null, { revision: 0, accessSource: 'api_key' });

  it.each([
    ['a budget member', { ...view, budget: { monthly_usd: 1 } }],
    ['a preset member', { ...view, preset: 'economy' }],
    ['a missing role', { ...view, roles: Object.fromEntries(Object.entries(view.roles).filter(([role]) => role !== 'dev')) }],
    ['a role of an unknown model', { ...view, roles: { ...view.roles, dev: { ...view.roles.dev, model: 'opus' } } }],
    ['security on Fable', { ...view, roles: { ...view.roles, security: { ...view.roles.security, model: 'claude-fable-5-1' } } }],
    ['security switched off', { ...view, roles: { ...view.roles, security: { ...view.roles.security, enabled: false } } }],
    ['a missing gate member', { ...view, gates: { qa: 'always' } }],
    ['another schema', { ...view, schema: 'team-config/v2' }],
    ['a credential member in access', { ...view, access: { source: 'api_key', kind: 'api-key' } }],
  ])('refuses a view with %s', (_, value) => {
    expect(isResolvedTeamConfig(value)).toBe(false);
  });
});

describe('presetViewOf', () => {
  it('derives custom from a role whose model or effort differs from the preset', () => {
    expect(presetViewOf(null)).toBe('recommended');
    expect(presetViewOf({ schema: TEAM_CONFIG_SCHEMA, preset: 'economy' })).toBe('economy');
    expect(presetViewOf({ schema: TEAM_CONFIG_SCHEMA, preset: 'economy', roles: { dev: { model: 'claude-sonnet-5' } } })).toBe(
      'economy',
    );
    expect(presetViewOf({ schema: TEAM_CONFIG_SCHEMA, preset: 'economy', roles: { dev: { model: 'claude-opus-5-5' } } })).toBe(
      'custom',
    );
    expect(presetViewOf({ schema: TEAM_CONFIG_SCHEMA, roles: { dev: { effort: 'low' } } })).toBe('custom');
  });
});

describe('teamConfigDiffOf', () => {
  it('lists the changed leaves in key order, arrays whole', () => {
    const before: TeamConfig = { schema: TEAM_CONFIG_SCHEMA, preset: 'recommended', gates: { code_paths: ['apps/**'] } };
    const after: TeamConfig = {
      schema: TEAM_CONFIG_SCHEMA,
      preset: 'economy',
      gates: { code_paths: ['apps/**', 'libs/**'] },
      roles: { dev: { model: 'claude-opus-5-5' } },
    };
    expect(teamConfigDiffOf(before, after)).toEqual([
      { path: 'gates.code_paths', from: ['apps/**'], to: ['apps/**', 'libs/**'] },
      { path: 'preset', from: 'recommended', to: 'economy' },
      { path: 'roles.dev.model', to: 'claude-opus-5-5' },
    ]);
  });

  it('diffs a first revision against the empty document', () => {
    expect(teamConfigDiffOf(null, { schema: TEAM_CONFIG_SCHEMA, language: 'en' })).toEqual([
      { path: 'language', to: 'en' },
      { path: 'schema', to: TEAM_CONFIG_SCHEMA },
    ]);
  });

  it('lists a removed member without its new value', () => {
    expect(teamConfigDiffOf({ schema: TEAM_CONFIG_SCHEMA, language: 'en' }, { schema: TEAM_CONFIG_SCHEMA })).toEqual([
      { path: 'language', from: 'en' },
    ]);
  });
});

it('names every role of the schema once', () => {
  const roles: readonly TeamRole[] = TEAM_ROLES;
  expect(new Set(roles).size).toBe(14);
});
