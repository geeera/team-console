import type { InboxDto, OverviewProjectReadDto, OverviewTeamState, SprintListsDto } from '@shared/contracts';

export interface OverviewRowInput {
  readonly slug: string;
  readonly name: string;
  readonly team: OverviewTeamState;
  readonly inbox: InboxDto;
  /** The board's read model; its pull requests are not part of the row. */
  readonly sprint: SprintListsDto;
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
            title: milestone.title,
            dueOn: milestone.dueOn,
            planned: input.sprint.planned,
            shipped: input.sprint.shipped,
          },
    needsYou: input.inbox.items.map((item) => item.number),
    setup: input.inbox.setup,
    setupUrl: input.inbox.setupUrl,
  };
}
