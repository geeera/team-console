import { JOB_MAX_MINUTES_MAX } from './job';

/**
 * Team configuration as a versioned contract per project (ADR 0009, #630, #687). One schema, `team-config/v1`, owned
 * here and shared by its three consumers: the console validates every write with `checkTeamConfig`, the runner
 * re-validates the claim's view with `isResolvedTeamConfig`, the plugin replays the fixtures written from them.
 *
 * Every value is an allow-list or a bounded integer, and the guard is an exact-key allow-list: an unknown member, an
 * unknown role or a value out of its bound is refused with the failing path, never ignored. A stored document may
 * leave members out; `resolveTeamConfig` fills them from the preset and the defaults below, so a project with no
 * document behaves as `recommended`, today's table.
 *
 * Presets and defaults are data: a change to them is a PR with a changelog line and a fixture diff under
 * `apps/api/fixtures/team-config/`, which the runner and the plugin's lock both see.
 */

export const TEAM_CONFIG_SCHEMA = 'team-config/v1';
export type TeamConfigSchema = typeof TEAM_CONFIG_SCHEMA;

/** The job roles (`apps/api/src/auth/job-roles.ts` `JOB_ROLES`, kept equal by `team-config-roles.spec.ts`). */
export const TEAM_ROLES = [
  'pm',
  'architect',
  'orchestrator',
  'dev',
  'dev-light',
  'dev-heavy',
  'qa',
  'reviewer',
  'security',
  'devops',
  'analyst',
  'scribe',
  'ux-designer',
  'ui-designer',
] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const isTeamRole = (value: unknown): value is TeamRole =>
  (TEAM_ROLES as readonly unknown[]).includes(value);

/** The four pinned ids of `reference/schedule-and-models.md`; no alias, so no value can name another model or a flag. */
export const MODEL_ALLOW_LIST = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
] as const;
export type TeamModel = (typeof MODEL_ALLOW_LIST)[number];

const FABLE: TeamModel = 'claude-fable-5-1';
const OPUS: TeamModel = 'claude-opus-5-5';
const SONNET: TeamModel = 'claude-sonnet-5';
const HAIKU: TeamModel = 'claude-haiku-4-5-20251001';

export const TEAM_EFFORTS = ['low', 'medium', 'high'] as const;
export type TeamEffort = (typeof TEAM_EFFORTS)[number];

export const ACCESS_SOURCES = ['subscription', 'api_key'] as const;
export type AccessSource = (typeof ACCESS_SOURCES)[number];
export const isAccessSource = (value: unknown): value is AccessSource =>
  (ACCESS_SOURCES as readonly unknown[]).includes(value);

/** The presets a document may name; `custom` is derived from role overrides (`presetViewOf`), never stored. */
export const TEAM_CONFIG_PRESETS = ['economy', 'recommended', 'max'] as const;
export type TeamConfigPreset = (typeof TEAM_CONFIG_PRESETS)[number];
export type TeamConfigPresetView = TeamConfigPreset | 'custom';
export const isTeamConfigPreset = (value: unknown): value is TeamConfigPreset =>
  (TEAM_CONFIG_PRESETS as readonly unknown[]).includes(value);

/** ADR 0009 d.2: the 0.11 template's `never` is dropped; an import maps it to `code` with a note. */
export const GATE_POLICIES = ['always', 'code'] as const;
export type GatePolicy = (typeof GATE_POLICIES)[number];

export const TEAM_LANGUAGES = ['ru', 'en'] as const;
export type TeamLanguage = (typeof TEAM_LANGUAGES)[number];

export const REVIEWER_CONTEXTS = ['diff', 'repo'] as const;
export type ReviewerContext = (typeof REVIEWER_CONTEXTS)[number];

export const CAP_MODES = ['normal', 'burn', 'freeze'] as const;
export type CapMode = (typeof CAP_MODES)[number];

/** The roles the gate rests on (ADR 0006 decision 6): `enabled: false` is refused for them. */
export const NEVER_OFF_ROLES: readonly TeamRole[] = ['orchestrator', 'pm', 'dev', 'qa', 'reviewer'];

/**
 * `security` cannot be switched off and cannot carry `enabled` at all (ADR 0009 d.2): its verdict is required whenever
 * `pr security-check` says so. Its `model` is configurable within its bound.
 */
export const ENABLED_FORBIDDEN_ROLES: readonly TeamRole[] = ['security'];

interface Bound {
  readonly min: number;
  readonly max: number;
}

export const TEAM_CONFIG_BOUNDS = {
  maxParallel: { min: 1, max: 5 },
  maxMinutes: { min: 1, max: JOB_MAX_MINUTES_MAX },
  maxTurns: { min: 1, max: 1000 },
  maxReworkRounds: { min: 0, max: 3 },
  devTasks: { min: 0, max: 10 },
  parallelDevs: { min: 1, max: 5 },
  lengthDays: { min: 7, max: 28 },
  freezeDays: { min: 0, max: 7 },
  monthlyUsd: { min: 1, max: 100_000 },
  codePaths: { min: 1, max: 20 },
  codePathLength: { min: 1, max: 200 },
} as const satisfies Readonly<Record<string, Bound>>;

/** UTF-8 bytes of the serialized document; `team_configs.config` CHECKs the same bound. */
export const TEAM_CONFIG_MAX_BYTES = 16 * 1024;
/** A revision's `reason`, after redaction; `team_config_revisions.reason` CHECKs the same bound. */
export const TEAM_CONFIG_REASON_MAX_LENGTH = 500;

export interface TeamRoleSettings {
  readonly enabled: boolean;
  readonly model: TeamModel;
  readonly effort: TeamEffort;
  readonly max_parallel: number;
  readonly max_minutes: number;
  readonly max_turns: number;
}
export type TeamRoleOverride = Partial<TeamRoleSettings>;

export interface TeamAccess {
  readonly source: AccessSource;
}

export interface TeamGates {
  readonly qa: GatePolicy;
  readonly reviewer: GatePolicy;
  readonly code_paths: readonly string[];
  readonly max_rework_rounds: number;
}

export interface TeamCap {
  readonly dev_tasks: number;
  readonly parallel_devs: number;
}

export interface TeamSprint {
  readonly length_days: number;
  readonly freeze_days: number;
}

export interface TeamBudget {
  /** Whole dollars; `null` means no budget. */
  readonly monthly_usd: number | null;
}

export interface TeamCost {
  readonly prompt_caching: boolean;
  /** Stored, not applied (ADR 0009 d.5 addendum, #689): the runner reports `unsupported` under `api_key`, `not-applied` otherwise. */
  readonly batch_api: boolean;
  readonly reviewer_context: ReviewerContext;
}

/** The document as the owner stores it: `schema` is required, every other member falls back to the preset/default. */
export interface TeamConfig {
  readonly schema: TeamConfigSchema;
  readonly preset?: TeamConfigPreset;
  readonly access?: TeamAccess;
  readonly roles?: { readonly [R in TeamRole]?: TeamRoleOverride };
  readonly gates?: Partial<TeamGates>;
  readonly caps?: { readonly [M in CapMode]?: Partial<TeamCap> };
  readonly sprint?: Partial<TeamSprint>;
  readonly language?: TeamLanguage;
  readonly budget?: TeamBudget;
  readonly cost?: Partial<TeamCost>;
}

/**
 * What a job and the runner see (ADR 0009 "Schema"): every role present with its effective entry, and nothing the job
 * has no business reading — no `budget`, `preset`, `reason`, author or history. No credential of any kind either:
 * the console knows only the enum the owner chose (ADR 0008 decision 7).
 */
export interface ResolvedTeamConfigDto {
  readonly schema: TeamConfigSchema;
  /** The revision this view was resolved from; 0 when the project has none (the `recommended` default). */
  readonly revision: number;
  readonly access: TeamAccess;
  readonly roles: Readonly<Record<TeamRole, TeamRoleSettings>>;
  readonly gates: TeamGates;
  readonly caps: Readonly<Record<CapMode, TeamCap>>;
  readonly sprint: TeamSprint;
  readonly language: TeamLanguage;
  readonly cost: TeamCost;
}

/** `GET …/team-config` (owner and member): the stored document, its revision and what it resolves to. */
export interface TeamConfigDto {
  /** The stored document; `null` while the project has none. */
  readonly config: TeamConfig | null;
  readonly revision: number;
  readonly preset: TeamConfigPresetView;
  readonly budget: TeamBudget;
  readonly resolved: ResolvedTeamConfigDto;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  /**
   * The author's display name (their login, never an email; #688 "author name only"); `null` when the revision was
   * written by the console's own owner identity (`local-owner`, `access-owner`) or there is none.
   */
  readonly updatedByName: string | null;
  /** The current revision's reason as its author wrote it (plain text, redacted); `null` without one or a revision (#688). */
  readonly reason: string | null;
  /**
   * Whether the caller may write the document: the project's owner (`canManageProject`, #688). Display only — every
   * write checks the route matrix again, so a stale or forged `true` is still 403.
   */
  readonly canManage: boolean;
  /**
   * `access.source: subscription` would be refused now (ADR 0009 d.3): the effective placement admits a hosted runner,
   * or the project is dispatched to GitHub Actions. Settings shows the choice disabled with its reason.
   */
  readonly subscriptionBlocked: boolean;
}

/** `PUT …/team-config` with `If-Match: "<revision>"`. */
export interface PutTeamConfigInput {
  readonly config: unknown;
  readonly reason: string | null;
}

/** One changed leaf of a revision (arrays are leaves); `from`/`to` absent when the member was absent. */
export interface TeamConfigChange {
  readonly path: string;
  readonly from?: unknown;
  readonly to?: unknown;
}

export interface TeamConfigRevisionSummaryDto {
  readonly revision: number;
  readonly createdAt: string;
  readonly createdBy: string;
  /** The author's login, never an email; `null` for the console's own owner identities (#688, as `updatedByName`). */
  readonly createdByName: string | null;
  readonly reason: string | null;
  readonly paths: readonly string[];
}

export interface TeamConfigRevisionListDto {
  readonly revisions: readonly TeamConfigRevisionSummaryDto[];
  readonly nextCursor: number | null;
}

export interface TeamConfigRevisionDto {
  readonly revision: number;
  readonly config: TeamConfig;
  readonly diff: readonly TeamConfigChange[];
  readonly createdAt: string;
  readonly createdBy: string;
  /** The author's login, never an email; `null` for the console's own owner identities (#688). */
  readonly createdByName: string | null;
  readonly reason: string | null;
}

/** Why an import left something out or changed it (ADR 0009 "Migration" 2); codes, the console renders the text. */
export const TEAM_CONFIG_IMPORT_NOTES = ['never-as-code', 'model-ignored', 'key-ignored'] as const;
export type TeamConfigImportNoteCode = (typeof TEAM_CONFIG_IMPORT_NOTES)[number];

export interface TeamConfigImportNote {
  /** The `project.yml` path the note is about, e.g. `review.qa`. */
  readonly path: string;
  readonly code: TeamConfigImportNoteCode;
}

/** `POST …/team-config/import`: a draft for `PUT`, never saved by the import itself. */
export interface TeamConfigImportDto {
  readonly draft: TeamConfig;
  readonly notes: readonly TeamConfigImportNote[];
  readonly source: { readonly path: string; readonly ref: string; readonly sha: string };
}

export type TeamConfigProblemType =
  | 'team-config-schema'
  | 'team-config-invalid'
  | 'team-config-stale'
  | 'team-config-version-required'
  | 'team-config-revision-not-found'
  | 'team-config-import-invalid'
  | 'access-source-hosted';

// ── Presets (ADR 0009 d.4, #631) ─────────────────────────────────────────────────────────────────────────────

const MODEL_EFFORT: Readonly<Record<TeamModel, TeamEffort>> = {
  'claude-fable-5-1': 'high',
  'claude-opus-5-5': 'high',
  'claude-sonnet-5': 'medium',
  'claude-haiku-4-5-20251001': 'low',
};

/** `effort` follows the model: Fable and Opus `high`, Sonnet `medium`, Haiku `low`. */
export function effortOfModel(model: TeamModel): TeamEffort {
  return MODEL_EFFORT[model];
}

/**
 * Per-role limits, the same in every preset until #631's data says otherwise. `max_parallel` is the bound's top for
 * every role: today nothing caps a role's parallel jobs on a project, and `recommended` must change no behaviour.
 */
const ROLE_LIMITS: Readonly<
  Record<TeamRole, Pick<TeamRoleSettings, 'max_parallel' | 'max_minutes' | 'max_turns'>>
> = Object.fromEntries(
  TEAM_ROLES.map((role) => [
    role,
    {
      max_parallel: TEAM_CONFIG_BOUNDS.maxParallel.max,
      max_minutes: role === 'dev-heavy' ? 120 : role === 'scribe' ? 15 : 90,
      max_turns: role === 'scribe' ? 40 : 400,
    },
  ]),
) as Record<TeamRole, Pick<TeamRoleSettings, 'max_parallel' | 'max_minutes' | 'max_turns'>>;

/** ADR 0009 "Presets": `recommended` is exactly today's table (`ROLE_MODELS`, the agent frontmatter). */
const PRESET_MODELS: Readonly<Record<TeamConfigPreset, Readonly<Record<TeamRole, TeamModel>>>> = {
  economy: {
    architect: OPUS,
    'dev-heavy': OPUS,
    dev: SONNET,
    orchestrator: SONNET,
    pm: SONNET,
    qa: SONNET,
    'ux-designer': SONNET,
    'ui-designer': SONNET,
    // Owner #690: security stays on Opus 5.5 in every preset — the security gate rests on its verdict.
    security: OPUS,
    'dev-light': SONNET,
    reviewer: SONNET,
    devops: SONNET,
    analyst: SONNET,
    scribe: HAIKU,
  },
  recommended: {
    architect: FABLE,
    'dev-heavy': FABLE,
    dev: OPUS,
    orchestrator: OPUS,
    pm: OPUS,
    qa: OPUS,
    'ux-designer': OPUS,
    'ui-designer': OPUS,
    security: OPUS,
    'dev-light': SONNET,
    reviewer: SONNET,
    devops: SONNET,
    analyst: SONNET,
    scribe: HAIKU,
  },
  max: {
    architect: FABLE,
    'dev-heavy': FABLE,
    dev: FABLE,
    orchestrator: OPUS,
    pm: OPUS,
    qa: OPUS,
    'ux-designer': OPUS,
    'ui-designer': OPUS,
    security: OPUS,
    'dev-light': OPUS,
    reviewer: OPUS,
    devops: OPUS,
    analyst: OPUS,
    scribe: SONNET,
  },
};

function presetRolesOf(preset: TeamConfigPreset): Readonly<Record<TeamRole, TeamRoleSettings>> {
  return Object.fromEntries(
    TEAM_ROLES.map((role) => {
      const model = PRESET_MODELS[preset][role];
      return [role, { enabled: true, model, effort: effortOfModel(model), ...ROLE_LIMITS[role] }];
    }),
  ) as Record<TeamRole, TeamRoleSettings>;
}

export const TEAM_CONFIG_PRESET_ROLES: Readonly<
  Record<TeamConfigPreset, Readonly<Record<TeamRole, TeamRoleSettings>>>
> = {
  economy: presetRolesOf('economy'),
  recommended: presetRolesOf('recommended'),
  max: presetRolesOf('max'),
};

/** The non-role defaults: the plugin's 0.11 template and this team's `project.yml`, so `recommended` changes nothing. */
export const TEAM_CONFIG_DEFAULTS: Readonly<{
  gates: TeamGates;
  caps: Readonly<Record<CapMode, TeamCap>>;
  sprint: TeamSprint;
  language: TeamLanguage;
  budget: TeamBudget;
  cost: TeamCost;
}> = {
  gates: {
    qa: 'always',
    reviewer: 'code',
    code_paths: ['apps/**', 'libs/**', 'tools/**'],
    max_rework_rounds: 1,
  },
  caps: {
    normal: { dev_tasks: 2, parallel_devs: 2 },
    burn: { dev_tasks: 5, parallel_devs: 3 },
    freeze: { dev_tasks: 0, parallel_devs: 1 },
  },
  sprint: { length_days: 14, freeze_days: 2 },
  language: 'ru',
  budget: { monthly_usd: null },
  cost: { prompt_caching: true, batch_api: false, reviewer_context: 'diff' },
};

/** #631: a new API-key project starts on `economy`; a subscription project keeps today's `recommended`. */
export function defaultPresetOf(source: AccessSource): TeamConfigPreset {
  return source === 'api_key' ? 'economy' : 'recommended';
}

/** #631's suggested monthly budget per preset, owner-editable; `null`: no suggestion (none was modelled). */
export const SUGGESTED_MONTHLY_BUDGET_USD: Readonly<Record<TeamConfigPreset, number | null>> = {
  economy: 400,
  recommended: 700,
  max: null,
};

/** The models a role may run on: `security` never Fable (plugin SPEC decision 13); only `scribe` runs on Haiku. */
export function allowedModelsOf(role: TeamRole): readonly TeamModel[] {
  return MODEL_ALLOW_LIST.filter(
    (model) => (model !== HAIKU || role === 'scribe') && (model !== FABLE || role !== 'security'),
  );
}

// ── The guard ────────────────────────────────────────────────────────────────────────────────────────────────

export type TeamConfigCheck =
  | { readonly ok: true; readonly value: TeamConfig }
  | {
      readonly ok: false;
      readonly type: 'team-config-schema' | 'team-config-invalid';
      readonly field: string;
      readonly detail: string;
    };

class ConfigError extends Error {
  constructor(
    readonly field: string,
    detail: string,
    readonly type: 'team-config-schema' | 'team-config-invalid' = 'team-config-invalid',
  ) {
    super(detail);
  }
}

type Mode = 'stored' | 'resolved';
type FieldCheck = (value: unknown, path: string) => void;

const joined = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

/** A plain JSON object: no array, no `null`, no prototype but `Object.prototype` or none (a forged `__proto__`). */
function plainObject(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(
      path === '' ? 'config' : path,
      `${path === '' ? 'The document' : path} must be an object`,
    );
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ConfigError(
      path === '' ? 'config' : path,
      `${path === '' ? 'The document' : path} must be a plain object`,
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * The exact-key walk: every own key must be one of `fields` (`Object.hasOwn`, so `__proto__` and `constructor` are
 * unknown keys like any other), and with `required` every field must be present.
 */
function section(
  value: unknown,
  path: string,
  fields: Readonly<Record<string, FieldCheck>>,
  required: boolean,
): Readonly<Record<string, unknown>> {
  const object = plainObject(value, path);
  for (const key of Object.keys(object)) {
    if (!Object.hasOwn(fields, key)) {
      throw new ConfigError(joined(path, key), `${joined(path, key)} is not a member of team-config/v1`);
    }
  }
  for (const [key, check] of Object.entries(fields)) {
    if (Object.hasOwn(object, key)) {
      check(object[key], joined(path, key));
    } else if (required) {
      throw new ConfigError(joined(path, key), `${joined(path, key)} is required`);
    }
  }
  return object;
}

const integerIn =
  (bound: Bound): FieldCheck =>
  (value, path) => {
    // `Number.isInteger` refuses NaN, ±Infinity, fractions; `typeof` refuses numeric strings.
    if (typeof value !== 'number' || !Number.isInteger(value) || value < bound.min || value > bound.max) {
      throw new ConfigError(
        path,
        `${path} must be a whole number from ${String(bound.min)} to ${String(bound.max)}`,
      );
    }
  };

const oneOf =
  (values: readonly string[]): FieldCheck =>
  (value, path) => {
    if (typeof value !== 'string' || !values.includes(value)) {
      throw new ConfigError(path, `${path} must be one of ${values.join(', ')}`);
    }
  };

const boolean: FieldCheck = (value, path) => {
  if (typeof value !== 'boolean') {
    throw new ConfigError(path, `${path} must be true or false`);
  }
};

/** C0 controls and DEL: a glob is one line of plain text. */
function hasControlCharacter(text: string): boolean {
  return [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

/** Repository globs: relative, no traversal, no Windows separators, no control characters; at least one. */
const codePaths: FieldCheck = (value, path) => {
  const { codePaths: count, codePathLength: length } = TEAM_CONFIG_BOUNDS;
  if (!Array.isArray(value) || value.length < count.min || value.length > count.max) {
    throw new ConfigError(
      path,
      `${path} must be a list of ${String(count.min)} to ${String(count.max)} globs`,
    );
  }
  value.forEach((glob: unknown, index) => {
    const at = `${path}[${String(index)}]`;
    if (
      typeof glob !== 'string' ||
      glob.length < length.min ||
      glob.length > length.max ||
      glob.includes('..') ||
      glob.startsWith('/') ||
      glob.includes('\\') ||
      hasControlCharacter(glob)
    ) {
      throw new ConfigError(
        at,
        `${at} must be a relative glob of at most ${String(length.max)} characters without .., a leading / or \\`,
      );
    }
  });
};

function roleFields(role: TeamRole, mode: Mode): Readonly<Record<string, FieldCheck>> {
  const enabled: FieldCheck = (value, path) => {
    if (mode === 'stored' && ENABLED_FORBIDDEN_ROLES.includes(role)) {
      throw new ConfigError(path, `${path} cannot be set: the ${role} role is never switched off`);
    }
    boolean(value, path);
    if (value === false && (NEVER_OFF_ROLES.includes(role) || ENABLED_FORBIDDEN_ROLES.includes(role))) {
      throw new ConfigError(path, `${path} must be true: the ${role} role is never switched off`);
    }
  };
  return {
    enabled,
    model: oneOf(allowedModelsOf(role)),
    effort: oneOf(TEAM_EFFORTS),
    max_parallel: integerIn(TEAM_CONFIG_BOUNDS.maxParallel),
    max_minutes: integerIn(TEAM_CONFIG_BOUNDS.maxMinutes),
    max_turns: integerIn(TEAM_CONFIG_BOUNDS.maxTurns),
  };
}

function rolesCheck(mode: Mode): FieldCheck {
  const fields = Object.fromEntries(
    TEAM_ROLES.map((role) => [
      role,
      (value: unknown, path: string) =>
        void section(value, path, roleFields(role, mode), mode === 'resolved'),
    ]),
  );
  return (value, path) => void section(value, path, fields, mode === 'resolved');
}

const nested =
  (fields: Readonly<Record<string, FieldCheck>>, mode: Mode): FieldCheck =>
  (value, path) =>
    void section(value, path, fields, mode === 'resolved');

const capFields: Readonly<Record<string, FieldCheck>> = {
  dev_tasks: integerIn(TEAM_CONFIG_BOUNDS.devTasks),
  parallel_devs: integerIn(TEAM_CONFIG_BOUNDS.parallelDevs),
};

function documentFields(mode: Mode): Readonly<Record<string, FieldCheck>> {
  const common: Record<string, FieldCheck> = {
    access: nested({ source: oneOf(ACCESS_SOURCES) }, 'resolved'),
    roles: rolesCheck(mode),
    gates: nested(
      {
        qa: oneOf(GATE_POLICIES),
        reviewer: oneOf(GATE_POLICIES),
        code_paths: codePaths,
        max_rework_rounds: integerIn(TEAM_CONFIG_BOUNDS.maxReworkRounds),
      },
      mode,
    ),
    caps: nested(Object.fromEntries(CAP_MODES.map((cap) => [cap, nested(capFields, mode)])), mode),
    sprint: nested(
      {
        length_days: integerIn(TEAM_CONFIG_BOUNDS.lengthDays),
        freeze_days: integerIn(TEAM_CONFIG_BOUNDS.freezeDays),
      },
      mode,
    ),
    language: oneOf(TEAM_LANGUAGES),
    cost: nested(
      { prompt_caching: boolean, batch_api: boolean, reviewer_context: oneOf(REVIEWER_CONTEXTS) },
      mode,
    ),
  };
  if (mode === 'resolved') {
    return {
      schema: () => undefined,
      revision: integerIn({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      ...common,
    };
  }
  return {
    schema: () => undefined,
    preset: (value, path) => {
      if (value === 'custom') {
        throw new ConfigError(path, `${path} custom is derived from the role overrides and never stored`);
      }
      oneOf(TEAM_CONFIG_PRESETS)(value, path);
    },
    budget: nested(
      {
        monthly_usd: (value, path) => {
          if (value !== null) {
            integerIn(TEAM_CONFIG_BOUNDS.monthlyUsd)(value, path);
          }
        },
      },
      'resolved',
    ),
    ...common,
  };
}

function checkSchemaMember(object: Readonly<Record<string, unknown>>): void {
  const schema = Object.hasOwn(object, 'schema') ? object['schema'] : undefined;
  if (schema !== TEAM_CONFIG_SCHEMA) {
    throw new ConfigError('schema', `schema must be ${TEAM_CONFIG_SCHEMA}`, 'team-config-schema');
  }
}

function byteLengthOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function checkFreezeShorterThanSprint(sprint: TeamSprint): void {
  if (sprint.freeze_days >= sprint.length_days) {
    throw new ConfigError('sprint.freeze_days', 'sprint.freeze_days must be shorter than sprint.length_days');
  }
}

/**
 * Checks a stored document: the schema first (another version is `team-config-schema`), the size, then every member
 * against the exact-key allow-list and its bound; on success the value is a fresh copy, so nothing the caller passed
 * (a getter, a prototype) survives into storage.
 */
export function checkTeamConfig(value: unknown): TeamConfigCheck {
  try {
    const object = plainObject(value, '');
    checkSchemaMember(object);
    if (byteLengthOf(value) > TEAM_CONFIG_MAX_BYTES) {
      throw new ConfigError('config', `The document must be at most ${String(TEAM_CONFIG_MAX_BYTES)} bytes`);
    }
    section(object, '', documentFields('stored'), false);
    const copy = JSON.parse(JSON.stringify(object)) as TeamConfig;
    checkFreezeShorterThanSprint(sprintOf(copy));
    return { ok: true, value: copy };
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      return { ok: false, type: error.type, field: error.field, detail: error.message };
    }
    throw error;
  }
}

export const isTeamConfig = (value: unknown): value is TeamConfig => checkTeamConfig(value).ok;

/** The runner's re-check of the claim's view (ADR 0009 T5): every member present, exactly these, each in bound. */
export function isResolvedTeamConfig(value: unknown): value is ResolvedTeamConfigDto {
  try {
    const object = plainObject(value, '');
    checkSchemaMember(object);
    section(object, '', documentFields('resolved'), true);
    checkFreezeShorterThanSprint((value as ResolvedTeamConfigDto).sprint);
    return true;
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      return false;
    }
    throw error;
  }
}

// ── Resolution ───────────────────────────────────────────────────────────────────────────────────────────────

function sprintOf(stored: TeamConfig | null): TeamSprint {
  return { ...TEAM_CONFIG_DEFAULTS.sprint, ...stored?.sprint };
}

export interface ResolveContext {
  /** The revision the document is (0 for none). */
  readonly revision: number;
  /** `projects.access_source`, for a project with no document (never derived a second way, threat model C12). */
  readonly accessSource: AccessSource;
}

/** Preset + overrides → the effective view: pure and deterministic; `null` resolves to `recommended`. */
export function resolveTeamConfig(stored: TeamConfig | null, context: ResolveContext): ResolvedTeamConfigDto {
  const preset = stored?.preset ?? 'recommended';
  const base = TEAM_CONFIG_PRESET_ROLES[preset];
  const roles = Object.fromEntries(
    TEAM_ROLES.map((role) => [role, { ...base[role], ...stored?.roles?.[role] }]),
  ) as Record<TeamRole, TeamRoleSettings>;
  const caps = Object.fromEntries(
    CAP_MODES.map((cap) => [cap, { ...TEAM_CONFIG_DEFAULTS.caps[cap], ...stored?.caps?.[cap] }]),
  ) as Record<CapMode, TeamCap>;
  return {
    schema: TEAM_CONFIG_SCHEMA,
    revision: context.revision,
    access: { source: stored?.access?.source ?? context.accessSource },
    roles,
    gates: { ...TEAM_CONFIG_DEFAULTS.gates, ...stored?.gates },
    caps,
    sprint: sprintOf(stored),
    language: stored?.language ?? TEAM_CONFIG_DEFAULTS.language,
    cost: { ...TEAM_CONFIG_DEFAULTS.cost, ...stored?.cost },
  };
}

export function budgetOf(stored: TeamConfig | null): TeamBudget {
  return stored?.budget ?? TEAM_CONFIG_DEFAULTS.budget;
}

/** The preset the owner sees: the stored one, or `custom` once a role's model or effort differs from it. */
export function presetViewOf(stored: TeamConfig | null): TeamConfigPresetView {
  const preset = stored?.preset ?? 'recommended';
  const base = TEAM_CONFIG_PRESET_ROLES[preset];
  const isCustom = TEAM_ROLES.some((role) => {
    const override = stored?.roles?.[role];
    return (
      (override?.model !== undefined && override.model !== base[role].model) ||
      (override?.effort !== undefined && override.effort !== base[role].effort)
    );
  });
  return isCustom ? 'custom' : preset;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The changed leaves from `before` to `after` (arrays compared whole), in key order; `null` is the empty document. */
export function teamConfigDiffOf(before: TeamConfig | null, after: TeamConfig): TeamConfigChange[] {
  const changes: TeamConfigChange[] = [];
  const walk = (from: unknown, to: unknown, path: string): void => {
    if (isPlainRecord(from) && isPlainRecord(to)) {
      const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
      for (const key of keys) {
        walk(
          Object.hasOwn(from, key) ? from[key] : undefined,
          Object.hasOwn(to, key) ? to[key] : undefined,
          joined(path, key),
        );
      }
      return;
    }
    if (from === undefined && isPlainRecord(to)) {
      walk({}, to, path);
      return;
    }
    if (to === undefined && isPlainRecord(from)) {
      walk(from, {}, path);
      return;
    }
    if (!sameJson(from, to)) {
      changes.push({ path, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) });
    }
  };
  walk(before ?? {}, after, '');
  return changes;
}
