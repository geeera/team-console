import { isEnvironment, type Environment } from '@shared/contracts';
import { environmentRowsOf } from './rows';

export const ENVIRONMENT_STATUS_URL = '/api/v1/environment/status';

/** Presence only (#104): the endpoint never says anything else about a binding. */
export type EnvironmentItemStatus = 'set' | 'missing';

export interface EnvironmentItemStatusDto {
  /** `EnvironmentRow.id`. */
  readonly id: string;
  readonly status: EnvironmentItemStatus;
}

/**
 * `GET /api/v1/environment/status`: the rows of this Worker's own environment it can see, set or missing. Never a
 * value, a length, a prefix, a masked preview or a hash — nothing derived from a value but whether it is non-empty.
 */
export interface EnvironmentStatusDto {
  readonly environment: Environment;
  readonly items: readonly EnvironmentItemStatusDto[];
}

/** A binding counts as set only when it holds something; an empty or blank string is missing (UX spec open point 2). */
export function isBindingSet(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim() !== '';
  }
  return value !== undefined && value !== null;
}

/**
 * The status of every row `environment`'s api Worker can see. `read` looks one binding up by name; only the
 * boolean of `isBindingSet` leaves this function.
 */
export function environmentStatusOf(
  environment: Environment,
  read: (binding: string) => unknown,
  projectSlugs: readonly string[],
): EnvironmentStatusDto {
  const items: EnvironmentItemStatusDto[] = [];
  for (const row of environmentRowsOf(environment, projectSlugs)) {
    if (row.binding !== null) {
      items.push({ id: row.id, status: isBindingSet(read(row.binding)) ? 'set' : 'missing' });
    }
  }
  return { environment, items };
}

const ROW_ID = /^(?:[a-z-]+|project\/[a-z0-9]+(?:-[a-z0-9]+)*)\/[A-Z][A-Z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isItemStatus(value: unknown): value is EnvironmentItemStatusDto {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    ROW_ID.test(value['id']) &&
    (value['status'] === 'set' || value['status'] === 'missing')
  );
}

export function isEnvironmentStatusDto(value: unknown): value is EnvironmentStatusDto {
  return (
    isRecord(value) &&
    isEnvironment(value['environment']) &&
    Array.isArray(value['items']) &&
    value['items'].every(isItemStatus)
  );
}

export type SetupCommandMode = 'set' | 'rotate' | 'check';

/**
 * The owner's one fix, run on their computer (#103). The console copies the command from here only, so when #103
 * settles its exact invocation this is the one line to change.
 */
export function setupCommandOf(environment: Environment, mode: SetupCommandMode = 'set'): string {
  const base = `setup --env ${environment}`;
  return mode === 'set' ? base : `${base} --${mode}`;
}
