import { LaunchRefusal } from '../jobs/refusal';

/**
 * The model each job role runs on (ADR 0008 decision 8): the pinned IDs of the plugin's
 * `reference/schedule-and-models.md`, never an alias; `roles.spec.ts` reads that table and fails when they part.
 * `config.roles.<role>.model` overrides one per runner.
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
/** A pinned model id: no alias such as `opus` or `sonnet`, no flag-like value. */
export const PINNED_MODEL = /^claude-[a-z0-9]+(?:-[a-z0-9]+)+$/;

export type RoleOverrides = Readonly<Record<string, { readonly model: string }>>;

export function modelOfRole(role: string, overrides: RoleOverrides | undefined): string {
  if (!isJobRole(role)) {
    throw new LaunchRefusal('role-unknown', `no model is configured for the role ${JSON.stringify(role)}`);
  }
  // config.ts admits only pinned ids as overrides.
  return overrides?.[role]?.model ?? ROLE_MODELS[role];
}
