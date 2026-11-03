import type {
  InboxDto,
  OverviewProjectReadDto,
  OverviewTeamState,
  SnoozeDto,
  SprintListsDto,
} from '@shared/contracts';
import { withoutInvisibles } from '@shared/plain-text';

export interface OverviewRowInput {
  readonly slug: string;
  readonly name: string;
  readonly team: OverviewTeamState;
  readonly inbox: InboxDto;
  /** The board's read model; its pull requests are not part of the row. */
  readonly sprint: SprintListsDto;
  /** From the registry row (D1), not GitHub. */
  readonly snooze: SnoozeDto;
}

/**
 * One overview row (#27) from the read models the other screens use, so its numbers are the board's and the inbox's:
 * the sprint as `backlog sprint current` picks it, done / total as `sprint-metrics` counts the work items of
 * `backlog list --milestone current`, and the inbox's items as "Needs you" lists them.
 */
export function buildOverviewRow(input: OverviewRowInput): OverviewProjectReadDto {
  const { milestone } = input.sprint;
  return {
    kind: 'read',
    slug: input.slug,
    name: input.name,
    team: input.team,
    sprint:
      milestone === null
        ? null
        : {
            number: milestone.number,
            // The sprint DTO already strips the title; every title-bearing builder strips its own (#287 guard).
            title: withoutInvisibles(milestone.title),
            dueOn: milestone.dueOn,
            planned: input.sprint.planned,
            shipped: input.sprint.shipped,
          },
    needsYou: input.inbox.items.map((item) => item.number),
    setup: input.inbox.setup,
    setupUrl: input.inbox.setupUrl,
    snooze: input.snooze,
  };
}
