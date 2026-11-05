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
