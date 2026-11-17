import {
  CAP_MODES,
  ENABLED_FORBIDDEN_ROLES,
  NEVER_OFF_ROLES,
  TEAM_CONFIG_PRESET_ROLES,
  TEAM_CONFIG_SCHEMA,
  TEAM_ROLES,
  budgetOf,
  resolveTeamConfig,
  type AccessSource,
  type CapMode,
  type TeamCap,
  type TeamConfig,
  type TeamConfigDto,
  type TeamConfigPreset,
  type TeamCost,
  type TeamGates,
  type TeamLanguage,
  type TeamRole,
  type TeamRoleSettings,
  type TeamSprint,
} from '@shared/contracts';

/**
 * What the Settings › Team form edits (#688): every value in effect, never a partial document. The form works on
 * this and turns it back into a stored document only at save (`documentOf`), so a draft is always complete and
 * two drafts compare leaf by leaf.
 */
export interface TeamDraft {
  readonly preset: TeamConfigPreset;
  readonly source: AccessSource;
  readonly roles: Readonly<Record<TeamRole, TeamRoleSettings>>;
  readonly gates: TeamGates;
  readonly caps: Readonly<Record<CapMode, TeamCap>>;
  readonly sprint: TeamSprint;
  readonly language: TeamLanguage;
  readonly monthlyUsd: number | null;
  readonly cost: TeamCost;
}

/** One changed value between two drafts; `path` is the document's own (`roles.dev.model`, `budget.monthly_usd`). */
export interface DraftChange {
  readonly path: string;
  readonly from: unknown;
  readonly to: unknown;
}

/** The role settings an override may carry; `enabled` is the role's switch, not an override of the preset. */
export const OVERRIDE_KEYS = ['model', 'effort', 'max_minutes', 'max_turns', 'max_parallel'] as const;
export type OverrideKey = (typeof OVERRIDE_KEYS)[number];

const ROLE_KEYS = ['enabled', ...OVERRIDE_KEYS] as const;

export function isNeverOff(role: TeamRole): boolean {
  return NEVER_OFF_ROLES.includes(role);
}

/** `security` has no switch at all (ADR 0009 d.2): the security check decides when it runs. */
export function hasNoSwitch(role: TeamRole): boolean {
  return ENABLED_FORBIDDEN_ROLES.includes(role);
}

export function draftOf(view: TeamConfigDto): TeamDraft {
  const { resolved } = view;
  return {
    preset: view.config?.preset ?? 'recommended',
    source: resolved.access.source,
    roles: resolved.roles,
    gates: resolved.gates,
    caps: resolved.caps,
    sprint: resolved.sprint,
    language: resolved.language,
    monthlyUsd: view.budget.monthly_usd,
    cost: resolved.cost,
  };
}

/**
 * The draft a stored document gives on its own: a revision's `config` for "Use as draft" (#688). The document always
 * names its access source; `source` is only for one that does not.
 */
export function draftOfDocument(config: TeamConfig, source: AccessSource): TeamDraft {
  const resolved = resolveTeamConfig(config, { revision: 0, accessSource: config.access?.source ?? source });
  return {
    preset: config.preset ?? 'recommended',
    source: resolved.access.source,
    roles: resolved.roles,
    gates: resolved.gates,
    caps: resolved.caps,
    sprint: resolved.sprint,
    language: resolved.language,
    monthlyUsd: budgetOf(config).monthly_usd,
    cost: resolved.cost,
  };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The sections an import may fill (ADR 0009 "Migration" 2); models, access, budget and cost stay the console's. */
export const IMPORTED_SECTIONS = ['gates', 'caps', 'sprint', 'language'] as const;

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The leaves an imported document names, by document path (arrays are leaves): only those go into the draft. */
function importedLeavesOf(imported: TeamConfig): Array<readonly [string, unknown]> {
  const known = new Set(leavesOf(draftOfDocument({ schema: TEAM_CONFIG_SCHEMA }, 'api_key')).map(([path]) => path));
  const leaves: Array<readonly [string, unknown]> = [];
  const walk = (value: unknown, path: string): void => {
    if (isPlainRecord(value)) {
      for (const [key, member] of Object.entries(value)) {
        walk(member, `${path}.${key}`);
      }
    } else if (known.has(path)) {
      leaves.push([path, value]);
    }
  };
  for (const section of IMPORTED_SECTIONS) {
    if (imported[section] !== undefined) {
      walk(imported[section], section);
    }
  }
  return leaves;
}

/** How many of the import's sections the file filled ("From project.yml (main, 3 sections)"). */
export function importedSectionCountOf(imported: TeamConfig): number {
  return IMPORTED_SECTIONS.filter((section) => imported[section] !== undefined).length;
}

/**
 * The draft with an import's values over it (#688, UX spec §2.7): every rule the file names replaces the draft's,
 * everything else — preset, roles and models, access, budget, cost — stays as the owner has it.
 */
export function withImported(draft: TeamDraft, imported: TeamConfig): TeamDraft {
  return importedLeavesOf(imported).reduce((next, [path, value]) => withLeaf(next, path, value), draft);
}

/** Every leaf of a draft by its document path, in the order the page shows the sections. */
export function leavesOf(draft: TeamDraft): ReadonlyArray<readonly [string, unknown]> {
  const leaves: Array<readonly [string, unknown]> = [
    ['preset', draft.preset],
    ['access.source', draft.source],
  ];
  for (const role of TEAM_ROLES) {
    for (const key of ROLE_KEYS) {
      leaves.push([`roles.${role}.${key}`, draft.roles[role][key]]);
    }
  }
  leaves.push(['budget.monthly_usd', draft.monthlyUsd]);
  leaves.push(['gates.qa', draft.gates.qa], ['gates.reviewer', draft.gates.reviewer]);
  leaves.push(['gates.code_paths', draft.gates.code_paths], ['gates.max_rework_rounds', draft.gates.max_rework_rounds]);
  for (const mode of CAP_MODES) {
    leaves.push([`caps.${mode}.dev_tasks`, draft.caps[mode].dev_tasks], [`caps.${mode}.parallel_devs`, draft.caps[mode].parallel_devs]);
  }
  leaves.push(['sprint.length_days', draft.sprint.length_days], ['sprint.freeze_days', draft.sprint.freeze_days]);
  leaves.push(['language', draft.language]);
  leaves.push(
    ['cost.prompt_caching', draft.cost.prompt_caching],
    ['cost.batch_api', draft.cost.batch_api],
    ['cost.reviewer_context', draft.cost.reviewer_context],
  );
  return leaves;
}

/** The draft with one leaf replaced; `path` is one `leavesOf` names. An unknown path is a programming error. */
export function withLeaf(draft: TeamDraft, path: string, value: unknown): TeamDraft {
  const parts = path.split('.');
  const [head, second, third] = parts;
  switch (head) {
    case 'preset':
      return { ...draft, preset: value as TeamConfigPreset };
    case 'access':
      return { ...draft, source: value as AccessSource };
    case 'language':
      return { ...draft, language: value as TeamLanguage };
    case 'budget':
      return { ...draft, monthlyUsd: value as number | null };
    case 'roles': {
      const role = second as TeamRole;
      return { ...draft, roles: { ...draft.roles, [role]: { ...draft.roles[role], [third as string]: value } } };
    }
    case 'caps': {
      const mode = second as CapMode;
      return { ...draft, caps: { ...draft.caps, [mode]: { ...draft.caps[mode], [third as string]: value } } };
    }
    case 'gates':
      return { ...draft, gates: { ...draft.gates, [second as string]: value } };
    case 'sprint':
      return { ...draft, sprint: { ...draft.sprint, [second as string]: value } };
    case 'cost':
      return { ...draft, cost: { ...draft.cost, [second as string]: value } };
    default:
      throw new Error(`Unknown team draft path ${path}`);
  }
}

/** The values that differ from `before` to `after`, in page order. */
export function changesOf(before: TeamDraft, after: TeamDraft): DraftChange[] {
  const old = new Map(leavesOf(before));
  return leavesOf(after)
    .filter(([path, value]) => !same(old.get(path), value))
    .map(([path, value]) => ({ path, from: old.get(path), to: value }));
}

/** The settings of `role` that differ from its preset's: what the "Override" chip and the row's Reset are about. */
export function overridesOf(draft: TeamDraft, role: TeamRole): OverrideKey[] {
  const preset = TEAM_CONFIG_PRESET_ROLES[draft.preset][role];
  return OVERRIDE_KEYS.filter((key) => draft.roles[role][key] !== preset[key]);
}

export function overriddenRolesOf(draft: TeamDraft): TeamRole[] {
  return TEAM_ROLES.filter((role) => overridesOf(draft, role).length > 0);
}

/** One role back to its preset's model, effort and limits; its switch stays as it is. */
export function resetRole(draft: TeamDraft, role: TeamRole): TeamDraft {
  const preset = TEAM_CONFIG_PRESET_ROLES[draft.preset][role];
  return { ...draft, roles: { ...draft.roles, [role]: { ...preset, enabled: draft.roles[role].enabled } } };
}

/** Every role on `preset`'s settings (the overrides go), switches kept: choosing a preset and `Reset to <preset>`. */
export function withPreset(draft: TeamDraft, preset: TeamConfigPreset): TeamDraft {
  const roles = Object.fromEntries(
    TEAM_ROLES.map((role) => [role, { ...TEAM_CONFIG_PRESET_ROLES[preset][role], enabled: draft.roles[role].enabled }]),
  ) as Record<TeamRole, TeamRoleSettings>;
  return { ...draft, preset, roles };
}

/** How many roles would run on another model after choosing `preset` ("7 models change"). */
export function modelsChangedBy(draft: TeamDraft, preset: TeamConfigPreset): number {
  return TEAM_ROLES.filter((role) => draft.roles[role].model !== TEAM_CONFIG_PRESET_ROLES[preset][role].model).length;
}

/**
 * The draft as a stored document over `stored` (the revision it was read from). Roles carry only what differs from
 * the preset, so a later preset change moves them; every other section keeps the stored document's own members and
 * sets only the values the draft changed, so a save names in its history exactly what the owner touched.
 */
export function documentOf(draft: TeamDraft, stored: TeamConfig | null): TeamConfig {
  const base = resolveTeamConfig(stored, { revision: 0, accessSource: draft.source });
  const roles = Object.fromEntries(
    TEAM_ROLES.flatMap((role) => {
      const preset = TEAM_CONFIG_PRESET_ROLES[draft.preset][role];
      const settings = draft.roles[role];
      const keys = ROLE_KEYS.filter(
        (key) => settings[key] !== preset[key] && !(key === 'enabled' && (hasNoSwitch(role) || isNeverOff(role))),
      );
      return keys.length === 0 ? [] : [[role, Object.fromEntries(keys.map((key) => [key, settings[key]]))]];
    }),
  );
  const section = <T extends object>(kept: Partial<T> | undefined, was: T, now: T): Partial<T> | undefined => {
    const changed = Object.fromEntries(
      Object.entries(now).filter(([key, value]) => !same(value, (was as Record<string, unknown>)[key])),
    ) as Partial<T>;
    const merged = { ...kept, ...changed };
    return Object.keys(merged).length === 0 ? undefined : merged;
  };
  const caps = Object.fromEntries(
    CAP_MODES.flatMap((mode) => {
      const merged = section(stored?.caps?.[mode], base.caps[mode], draft.caps[mode]);
      return merged === undefined ? [] : [[mode, merged]];
    }),
  );
  const gates = section(stored?.gates, base.gates, draft.gates);
  const sprint = section(stored?.sprint, base.sprint, draft.sprint);
  const cost = section(stored?.cost, base.cost, draft.cost);
  const storedBudget = budgetOf(stored);
  const languageChanged = draft.language !== base.language;
  return {
    schema: TEAM_CONFIG_SCHEMA,
    ...(stored?.preset !== undefined || draft.preset !== 'recommended' ? { preset: draft.preset } : {}),
    access: { source: draft.source },
    ...(Object.keys(roles).length > 0 ? { roles } : {}),
    ...(gates === undefined ? {} : { gates }),
    ...(Object.keys(caps).length > 0 ? { caps } : {}),
    ...(sprint === undefined ? {} : { sprint }),
    ...(stored?.language !== undefined || languageChanged ? { language: draft.language } : {}),
    ...(stored?.budget !== undefined || draft.monthlyUsd !== storedBudget.monthly_usd
      ? { budget: { monthly_usd: draft.monthlyUsd } }
      : {}),
    ...(cost === undefined ? {} : { cost }),
  };
}

/**
 * "Keep my edits on top" after a 412 (UX spec §2.5): their revision with every value I changed from `base` put back.
 * A value we both changed, to different things, is a conflict: mine is kept and the path is returned so the owner
 * can choose.
 */
export function mergeOnTop(
  base: TeamDraft,
  mine: TeamDraft,
  theirs: TeamDraft,
): { readonly draft: TeamDraft; readonly conflicts: readonly DraftChange[] } {
  const was = new Map(leavesOf(base));
  const their = new Map(leavesOf(theirs));
  let draft = theirs;
  const conflicts: DraftChange[] = [];
  for (const [path, value] of leavesOf(mine)) {
    if (same(was.get(path), value)) {
      continue;
    }
    draft = withLeaf(draft, path, value);
    if (!same(was.get(path), their.get(path)) && !same(their.get(path), value)) {
      conflicts.push({ path, from: their.get(path), to: value });
    }
  }
  return { draft, conflicts };
}
