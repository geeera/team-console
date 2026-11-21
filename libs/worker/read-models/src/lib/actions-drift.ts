import { isActionsDriftStatus, type ActionsSetupStatus, type NeedsYouActionsDriftDto } from '@shared/contracts';

/** A project's stored workflow judgement (#874, migration 0041), as the read gives it. */
export interface StoredWorkflowJudgement {
  readonly status: ActionsSetupStatus;
  /** The rendering it was judged against; `null` when the writer had none (the dispatch's `missing`). */
  readonly sha256: string | null;
  readonly checkedAt: string;
}

/**
 * Whether an Actions project's workflow drifted, from its stored judgement and the sha256 of this console's rendering
 * now (`null` when the console cannot render: then only the stored words count). Nothing is re-judged here: the
 * status is the readiness check's own (`judgeWorkflowFile`), and a file it last found `ok` is only `release` when the
 * rendering it matched is no longer this console's.
 */
export function actionsDriftOf(
  stored: StoredWorkflowJudgement,
  renderingSha256: string | null,
): NeedsYouActionsDriftDto | null {
  const { checkedAt } = stored;
  if (isActionsDriftStatus(stored.status)) {
    return { drift: stored.status, checkedAt };
  }
  if (stored.status === 'ok' && renderingSha256 !== null && stored.sha256 !== null && stored.sha256 !== renderingSha256) {
    return { drift: 'release', checkedAt };
  }
  return null;
}
