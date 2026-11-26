import {
  ACTIONS_SETUP_ADVISORY_ITEMS,
  ACTIONS_SETUP_ITEMS,
  ACTIONS_SETUP_PASSING_STATUSES,
  isGitHubUiUrl,
  type ActionsSetupDto,
  type ActionsSetupItemDto,
  type ActionsSetupItemId,
  type ActionsSetupPrDto,
  type ActionsSetupStatus,
} from '@shared/contracts';

/**
 * The setup page's steps (#759 UX spec §2): grouped by where the customer acts, each holding the readiness items it
 * stands for. Step 6 (the first run) is not part of the check, so it is not here.
 */
export const ACTIONS_SETUP_STEPS = ['access', 'permissions', 'environment', 'workflow', 'switch'] as const;
export type ActionsSetupStepId = (typeof ACTIONS_SETUP_STEPS)[number];

const STEP_ITEMS: Readonly<Record<Exclude<ActionsSetupStepId, 'switch'>, readonly ActionsSetupItemId[]>> = {
  access: ['access-source'],
  permissions: ['app-permissions'],
  environment: ['environment', 'branch-policy', 'protection-rules', 'secret'],
  workflow: ['workflow'],
};

/** The four steps the readiness check judges; the switch is the fifth and depends on them. */
export const ACTIONS_CHECKED_STEPS = ['access', 'permissions', 'environment', 'workflow'] as const;
export type ActionsCheckedStepId = (typeof ACTIONS_CHECKED_STEPS)[number];

/**
 * `pending`: no answer yet (the ledger shows its titles without state words). `outdated` (#870): done, but the file
 * is an earlier rendering, «Можно обновить».
 */
export type ActionsStepState = 'done' | 'outdated' | 'missing' | 'pending';

const isAdvisory = (id: ActionsSetupItemId): boolean => ACTIONS_SETUP_ADVISORY_ITEMS.includes(id);

export function itemOf(setup: ActionsSetupDto, id: ActionsSetupItemId): ActionsSetupItemDto {
  // The DTO guard requires every item, in order; the fallback only keeps a type-level promise.
  return setup.items.find((item) => item.id === id) ?? { id, status: 'unknown' };
}

/**
 * A step is done when every item it holds passes (`ok`, or `outdated`, which still runs); the advisory
 * `protection-rules` warns and never holds it back. The server's `blockingItemsOf` judges the same way.
 */
export function stepStateOf(setup: ActionsSetupDto | null, step: ActionsCheckedStepId): ActionsStepState {
  if (setup === null) {
    return 'pending';
  }
  const statuses = STEP_ITEMS[step].filter((id) => !isAdvisory(id)).map((id) => itemOf(setup, id).status);
  if (statuses.some((status) => !ACTIONS_SETUP_PASSING_STATUSES.includes(status))) {
    return 'missing';
  }
  return statuses.includes('outdated') ? 'outdated' : 'done';
}

export function missingStepsOf(setup: ActionsSetupDto): ActionsCheckedStepId[] {
  return ACTIONS_CHECKED_STEPS.filter((step) => stepStateOf(setup, step) === 'missing');
}

/** The first step that is not done: open and highlighted (UX spec §6 "Partial"). */
export function firstMissingStepOf(setup: ActionsSetupDto | null): ActionsCheckedStepId | null {
  return setup === null ? null : (missingStepsOf(setup)[0] ?? null);
}

/**
 * The summary (UX spec §3, §6): the count of missing steps while switched off, «Всё готово — осталось включить», «Задания
 * идут на GitHub Actions», or drift — switched on while the repository is no longer ready. The server's `ready` is
 * the judge: the count is at least one whenever it says not ready.
 */
export type ActionsSummary =
  | { readonly kind: 'missing'; readonly n: number }
  | { readonly kind: 'ready' }
  | { readonly kind: 'on' }
  | { readonly kind: 'drift'; readonly n: number };

export function actionsSummaryOf(setup: ActionsSetupDto): ActionsSummary {
  const n = Math.max(setup.ready ? 0 : 1, missingStepsOf(setup).length);
  if (setup.dispatch === 'actions') {
    return setup.ready ? { kind: 'on' } : { kind: 'drift', n };
  }
  return setup.ready ? { kind: 'ready' } : { kind: 'missing', n };
}

/** A sub-check line of step 3: its status as the UX spec words it. */
export type SubCheckTone = 'ok' | 'missing' | 'warning' | 'unknown';

export function subCheckToneOf(item: ActionsSetupItemDto): SubCheckTone {
  if (item.status === 'ok') {
    return 'ok';
  }
  if (item.status === 'unknown') {
    return 'unknown';
  }
  return isAdvisory(item.id) ? 'warning' : 'missing';
}

/** The GitHub link an item carries, only when it points at GitHub's own UI. */
export function linkOf(item: ActionsSetupItemDto): string | null {
  return item.link !== undefined && isGitHubUiUrl(item.link) ? item.link : null;
}

/**
 * Step 4 (UX spec §3.4), from the `workflow` item, its PR, and whether the app may open a PR at all:
 * - `ok` — the file on the default branch is the console's; `leftover` — and a console PR is still open;
 * - `missing` / `outdated` / `unsupported` / `modified` — the file is absent, an earlier rendering (still running, or
 *   below the environment's minimum runner), or changed: «Открыть PR …» (setup, bump, restore);
 * - `pr-open` — the console's own PR is open: merge it; `pr-foreign` — a PR on a console branch it cannot vouch for
 *   (`foreign` or `changed`): never "merge it"; `pr-stale` — the console's PR for an earlier rendering: close it, and
 *   a new one can be opened beside it;
 * - `unknown` — the console could not read the file.
 * `canOpenPr` is false while step 2 is not done or the operator switched the PR path off: the Copy path is primary.
 */
export type WorkflowStepKind =
  | 'ok'
  | 'leftover'
  | 'missing'
  | 'outdated'
  | 'unsupported'
  | 'modified'
  | 'pr-open'
  | 'pr-stale'
  | 'pr-foreign'
  | 'unknown';

export interface WorkflowStepView {
  readonly kind: WorkflowStepKind;
  readonly pr: ActionsSetupPrDto | null;
  /** The blob or file link GitHub gave for the item, when there is one. */
  readonly link: string | null;
  /** Which PR the button opens, when one can be opened from this state. */
  readonly action: 'open' | 'bump' | 'restore' | null;
}

const ACTION_OF: Partial<Record<ActionsSetupStatus, WorkflowStepView['action']>> = {
  missing: 'open',
  outdated: 'bump',
  unsupported: 'bump',
  modified: 'restore',
};

export function workflowStepOf(setup: ActionsSetupDto): WorkflowStepView {
  const item = itemOf(setup, 'workflow');
  const link = linkOf(item);
  const pr = item.pr !== undefined && isGitHubUiUrl(item.pr.url) ? item.pr : null;
  if (item.status === 'ok') {
    return { kind: pr === null ? 'ok' : 'leftover', pr, link, action: null };
  }
  const action = ACTION_OF[item.status] ?? null;
  if (pr !== null) {
    if (pr.provenance !== 'console') {
      return { kind: 'pr-foreign', pr, link, action: null };
    }
    // A PR for an earlier rendering does not stand in the way: the new one opens from another branch.
    return pr.stale === true
      ? { kind: 'pr-stale', pr, link, action }
      : { kind: 'pr-open', pr, link, action: null };
  }
  if (action === null) {
    return { kind: 'unknown', pr: null, link, action: null };
  }
  return { kind: item.status as 'missing' | 'outdated' | 'unsupported' | 'modified', pr: null, link, action };
}

/**
 * Whether the console can open the PR from here: the app has the permissions it needs and the PR path is on (#870,
 * `workflowPr`); otherwise step 4 offers the Copy path first.
 */
export function canOpenPrOf(setup: ActionsSetupDto): boolean {
  return itemOf(setup, 'app-permissions').status === 'ok' && setup.workflowPr === 'enabled';
}

/** The runner versions step 4 names for an earlier rendering: the file's and this console's (#870). */
export interface WorkflowVersionsView {
  readonly old: string | null;
  readonly new: string;
}

export function workflowVersionsOf(setup: ActionsSetupDto): WorkflowVersionsView {
  return { old: setup.versions.current?.runner ?? null, new: setup.versions.expected.runner };
}

/**
 * The `actions.item.*` keys that word an `actions-not-ready` refusal (UX spec §5), in the page's order; ids this
 * console does not know read as one «настройка репозитория» at the end.
 */
export function notReadyItemKeysOf(ids: readonly string[]): string[] {
  const known = ACTIONS_SETUP_ITEMS.filter((id) => ids.includes(id)).map((id) => `actions.item.${id}`);
  const hasUnknown = ids.some((id) => !(ACTIONS_SETUP_ITEMS as readonly string[]).includes(id));
  return hasUnknown ? [...known, 'actions.item.unknown'] : known;
}

/** «GitHub Actions для {project} ещё не готов: {items}. Ничего не изменилось.» (UX spec §5), from the refusal's items. */
export function notReadyMessageOf(
  items: readonly string[],
  project: string,
  translate: (key: string, params?: Record<string, unknown>) => string,
): string {
  const names = notReadyItemKeysOf(items).map((key) => translate(key));
  return names.length === 0
    ? translate('runners.err.actionsNotReadyBare', { project })
    : translate('runners.err.actionsNotReady', { project, items: names.join(', ') });
}
