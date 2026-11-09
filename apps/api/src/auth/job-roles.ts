/**
 * The roles a job can hold: the plugin's agents (`reference/schedule-and-models.md`) plus the orchestrator
 * (`slot-*`), as ADR 0006 "API and authorisation" names them. A token naming any other role is refused, so a typo
 * never becomes a role the matrix has no row for. `qa-runner` is `qa` on another model, not a role of its own.
 */
export const JOB_ROLES = [
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

export type JobRole = (typeof JOB_ROLES)[number];

export function isJobRole(value: unknown): value is JobRole {
  return typeof value === 'string' && (JOB_ROLES as readonly string[]).includes(value);
}

/** What a role is to the transition table and the route matrix (#462: the one place role groups are defined). */
interface RoleTraits {
  /** Creates and edits items within the transition table (ADR 0006: `pm`, `architect`, `orchestrator`). */
  readonly edits: boolean;
  /** May only move the status of an item it holds. */
  readonly movesStatus: boolean;
  /** A review role: never writes state that reads as a verdict (R2). */
  readonly reviews: boolean;
  /** A developer: does not ask the owner (the ask row of the route matrix). */
  readonly develops: boolean;
}

const NONE: RoleTraits = { edits: false, movesStatus: false, reviews: false, develops: false };
const EDITOR: RoleTraits = { ...NONE, edits: true };
const DEVELOPER: RoleTraits = { ...NONE, movesStatus: true, develops: true };

// A `Record` over the union: a role added to `JOB_ROLES` does not compile until it is decided here.
const ROLE_TRAITS: Readonly<Record<JobRole, RoleTraits>> = {
  pm: EDITOR,
  architect: EDITOR,
  orchestrator: EDITOR,
  dev: DEVELOPER,
  'dev-light': DEVELOPER,
  'dev-heavy': DEVELOPER,
  qa: { ...NONE, movesStatus: true, reviews: true },
  reviewer: { ...NONE, reviews: true },
  security: { ...NONE, reviews: true },
  devops: NONE,
  analyst: NONE,
  scribe: NONE,
  'ux-designer': NONE,
  'ui-designer': NONE,
};

function rolesWith(trait: keyof RoleTraits): ReadonlySet<JobRole> {
  return new Set(JOB_ROLES.filter((role) => ROLE_TRAITS[role][trait]));
}

export const EDITING_ROLES = rolesWith('edits');
export const STATUS_ONLY_ROLES = rolesWith('movesStatus');
export const REVIEWER_ROLES = rolesWith('reviews');
export const DEVELOPER_ROLES = rolesWith('develops');

/**
 * Which roles a route-matrix row admits, decided for every role: `admit` names the admitted ones, the rest are
 * refused. A `Record<JobRole, boolean>`, so the matrix spec can check every cell.
 */
export function roleDecisions(admit: (role: JobRole) => boolean): Readonly<Record<JobRole, boolean>> {
  return Object.fromEntries(JOB_ROLES.map((role) => [role, admit(role)])) as Record<JobRole, boolean>;
}
