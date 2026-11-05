import type { Environment } from '@shared/contracts';
import { environmentRowsOf } from './rows';
import { isBindingSet, type EnvironmentItemStatusDto, type EnvironmentStatusDto } from './status-dto';

/**
 * The status of every row `environment`'s api Worker can see (the Worker's side of #104). `read` looks one binding
 * up by name; only the boolean of `isBindingSet` leaves this function.
 */
export function environmentStatusOf(
  environment: Environment,
  read: (binding: string) => unknown,
  projectSlugs: readonly string[],
): EnvironmentStatusDto {
  const items: EnvironmentItemStatusDto[] = [];
  for (const row of environmentRowsOf(environment, projectSlugs)) {
    if (row.binding !== null) {
      items.push({
        id: row.id,
        status: isBindingSet(read(row.binding)) ? 'set' : 'missing',
        optional: row.item.optional === true,
      });
    }
  }
  return { environment, items };
}
