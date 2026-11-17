import { LaunchRefusal } from '../jobs/refusal';

/**
 * The model each job role runs on when the claim carries no team configuration (an older console; ADR 0009
 * "Migration" 4): the pinned IDs of the plugin's `reference/schedule-and-models.md`, never an alias, equal to the
 * `recommended` preset. `roles.spec.ts` reads that table and the preset and fails when they part. A claim with a view
 * takes the model from it (`job-team-config.ts`); no runner-side override exists any more.
 */
export const ROLE_MODELS = {
  orchestrator: 'claude-opus-5-5',
  pm: 'claude-opus-5-5',
  qa: 'claude-opus-5-5',
  security: 'claude-opus-5-5',
  reviewer: 'claude-sonnet-5',
} as const satisfies Readonly<Record<string, string>>;
export type JobRole = keyof typeof ROLE_MODELS;

export const isJobRole = (value: string): value is JobRole => Object.hasOwn(ROLE_MODELS, value);

/** The job role, or the launch refusal for a role the runner has no prompt and no model for. */
export function jobRoleOf(role: string): JobRole {
  if (!isJobRole(role)) {
    throw new LaunchRefusal('role-unknown', `no model is configured for the role ${JSON.stringify(role)}`);
  }
  return role;
}
