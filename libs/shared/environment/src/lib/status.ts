import type { Environment } from '@shared/contracts';
import { consoleRowsOf, projectRowsOf } from './rows';
import { isBindingSet, type EnvironmentItemStatusDto, type EnvironmentStatusDto } from './status-dto';

/**
 * The status of every row `environment`'s api Worker can see (the Worker's side of #104): the console's own rows
 * with no `project`, one project's rows alone with one (#750) — never both, and never another project's. `read`
 * looks one binding up by name; only the boolean of `isBindingSet` leaves this function.
 */
export function environmentStatusOf(
  environment: Environment,
  read: (binding: string) => unknown,
  project: string | null,
): EnvironmentStatusDto {
  const items: EnvironmentItemStatusDto[] = [];
  const rows = project === null ? consoleRowsOf(environment) : projectRowsOf(environment, project);
  for (const row of rows) {
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
