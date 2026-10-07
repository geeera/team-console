import type { IssueRequestDto, OwnerRequest, SprintTarget } from '@shared/contracts';

/** Where the issue is now, as the form's sprint options name it; `null` for a milestone that is neither. */
export function whereOf(issue: IssueRequestDto): SprintTarget | null {
  if (issue.milestone === null) {
    return 'backlog';
  }
  if (issue.current !== null && issue.milestone === issue.current.title) {
    return 'current';
  }
  if (issue.next !== null && issue.milestone === issue.next.title) {
    return 'next';
  }
  return null;
}

export type QueueChoice = 'up' | 'keep' | 'down';

export interface RequestChoice {
  readonly sprint: SprintTarget | null;
  readonly queue: QueueChoice;
}

/** The form's start: where the issue is, the queue as is. */
export function initialChoiceOf(issue: IssueRequestDto): RequestChoice {
  return { sprint: whereOf(issue), queue: 'keep' };
}

/**
 * One request per send (ADR 0005 decision 1, wireframe #252): a sprint other than where the issue is, else a
 * queue move, else nothing.
 */
export function requestOf(issue: IssueRequestDto, choice: RequestChoice): OwnerRequest | null {
  if (choice.sprint !== null && choice.sprint !== whereOf(issue)) {
    return { kind: 'sprint', target: choice.sprint };
  }
  if (choice.queue !== 'keep') {
    return { kind: 'priority', direction: choice.queue };
  }
  return null;
}

/** Picking a sprint clears the queue move and the other way round: the form never holds two requests. */
export function pickSprint(sprint: SprintTarget): RequestChoice {
  return { sprint, queue: 'keep' };
}

export function pickQueue(issue: IssueRequestDto, queue: QueueChoice): RequestChoice {
  return { sprint: whereOf(issue), queue };
}

/** Whether a sprint option can be picked: it must exist, unless the issue is there already. */
export function isSprintOffered(issue: IssueRequestDto, target: SprintTarget): boolean {
  if (target === 'current') {
    return issue.current !== null;
  }
  if (target === 'next') {
    return issue.next !== null;
  }
  return true;
}
