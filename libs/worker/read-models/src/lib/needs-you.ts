import type {
  InboxDto,
  NeedsYouDto,
  NeedsYouItemDto,
  NeedsYouProjectDto,
  NeedsYouProjectProblem,
  NeedsYouProjectRef,
} from '@shared/contracts';
import { ANSWERS, sectionRank } from '@shared/owner-grammar';

/** One project's share of "Needs you": its inbox, or why it could not be read. */
export type ProjectInboxResult =
  | { readonly project: NeedsYouProjectRef; readonly inbox: InboxDto }
  | { readonly project: NeedsYouProjectRef; readonly problem: NeedsYouProjectProblem };

/**
 * The cross-project union (#16): every item tagged with its project, sorted by inbox order, then project in the
 * order given (the registry's), then issue number.
 */
export function buildNeedsYou(
  results: readonly ProjectInboxResult[],
  omittedProjects: readonly NeedsYouProjectRef[],
): NeedsYouDto {
  const items: { item: NeedsYouItemDto; projectIndex: number }[] = [];
  const projects = results.map((result, projectIndex): NeedsYouProjectDto => {
    const ref = { slug: result.project.slug, name: result.project.name };
    if ('problem' in result) {
      return {
        ...ref,
        setup: false,
        setupUrl: null,
        paused: false,
        pausedUrl: null,
        problem: result.problem,
      };
    }
    for (const item of result.inbox.items) {
      items.push({ item: { ...item, project: ref, allowedCommands: ANSWERS[item.section] }, projectIndex });
    }
    return {
      ...ref,
      setup: result.inbox.setup,
      setupUrl: result.inbox.setupUrl,
      paused: result.inbox.paused,
      pausedUrl: result.inbox.pausedUrl,
      problem: null,
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
