import type {
  AnswerCommand,
  InboxDto,
  NeedsYouBudgetStopDto,
  NeedsYouDto,
  NeedsYouItemDto,
  NeedsYouProjectDto,
  NeedsYouProjectProblem,
  NeedsYouProjectRef,
} from '@shared/contracts';
import { ANSWERS, sectionRank } from '@shared/owner-grammar';

/** One project's share of "Needs you": its inbox, or why it could not be read. */
export type ProjectInboxResult =
  | {
      readonly project: NeedsYouProjectRef;
      readonly inbox: InboxDto;
      /**
       * The commands an item accepts by number, when they are not its section's (`ANSWERS`): a console-tracker
       * item with an open ask accepts the ask's commands (#434).
       */
      readonly allowedCommands?: ReadonlyMap<number, readonly AnswerCommand[]>;
    }
  | { readonly project: NeedsYouProjectRef; readonly problem: NeedsYouProjectProblem };

/**
 * The cross-project union (#16): every item tagged with its project, sorted by inbox order, then project in the
 * order given (the registry's), then issue number. A project the budget stopped (#684) carries its stop, whether its
 * inbox was read or not: the stop is the console's own record, not the inbox's. `canManage` (#735) is the caller's
 * own standing on the project (`projectOwnerRefusal` at the route), read once here for every row read or not; a
 * slug missing from the map (a result that predates #735, in a test) reads as `true`, today's behaviour.
 */
export function buildNeedsYou(
  results: readonly ProjectInboxResult[],
  omittedProjects: readonly NeedsYouProjectRef[],
  budgetStops: ReadonlyMap<string, NeedsYouBudgetStopDto> = new Map(),
  canManageOf: ReadonlyMap<string, boolean> = new Map(),
): NeedsYouDto {
  const items: { item: NeedsYouItemDto; projectIndex: number }[] = [];
  const projects = results.map((result, projectIndex): NeedsYouProjectDto => {
    const ref = { slug: result.project.slug, name: result.project.name };
    const stop = budgetStops.get(ref.slug);
    const budget = stop === undefined ? {} : { budgetStop: stop };
    const canManage = canManageOf.get(ref.slug) ?? true;
    if ('problem' in result) {
      return {
        ...ref,
        setup: false,
        setupUrl: null,
        paused: false,
        pausedUrl: null,
        problem: result.problem,
        canManage,
        ...budget,
      };
    }
    for (const item of result.inbox.items) {
      const allowedCommands = result.allowedCommands?.get(item.number) ?? ANSWERS[item.section];
      items.push({ item: { ...item, project: ref, allowedCommands }, projectIndex });
    }
    return {
      ...ref,
      setup: result.inbox.setup,
      setupUrl: result.inbox.setupUrl,
      paused: result.inbox.paused,
      pausedUrl: result.inbox.pausedUrl,
      problem: null,
      canManage,
      ...budget,
    };
  });
  items.sort(
    (a, b) =>
      sectionRank(a.item.section) - sectionRank(b.item.section) ||
      a.projectIndex - b.projectIndex ||
      a.item.number - b.item.number,
  );
  return { items: items.map(({ item }) => item), projects, omittedProjects };
}
