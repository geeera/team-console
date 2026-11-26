import { HttpErrorResponse } from '@angular/common/http';
import { httpProblemOf } from '@console/shared/api';
import {
  ACTIONS_SETUP_PR_PROVENANCES,
  isGitHubUiUrl,
  type ActionsSetupPrDto,
  type ActionsSetupPrProvenance,
} from '@shared/contracts';
import { TimeoutError } from 'rxjs';

/** A retry time when a 429 names none. */
const DEFAULT_RETRY_SECONDS = 60;

/**
 * Why `GET …/actions-setup` (or the file read) gave no answer, from the status and problem slug only (never `detail`):
 * - `forbidden` — 403 `owner-only`: a member; nothing is shown and GitHub was never asked;
 * - `not-found` — 404: archived, unknown or another account's project, one answer for all three;
 * - `github` — 502 `github-unavailable`: GitHub did not answer, no partial items;
 * - `misconfigured` — 503 `console-origin-misconfigured`: the console's own configuration, not the customer's repo;
 * - `unverified` — 422 `dispatch-repository-unverified`;
 * - `rate` — 429, with the time a re-check is allowed again;
 * - `offline` — no answer; `failed` — anything else (5xx, a timeout, an answer outside its contract).
 */
export type ActionsCheckProblem =
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'github' }
  | { readonly kind: 'misconfigured' }
  | { readonly kind: 'unverified' }
  | { readonly kind: 'rate'; readonly retryAt: string }
  | { readonly kind: 'offline' }
  | { readonly kind: 'failed' };

export function actionsCheckProblemOf(error: unknown, now: number = Date.now()): ActionsCheckProblem {
  if (error instanceof TimeoutError || !(error instanceof HttpErrorResponse)) {
    return { kind: 'failed' };
  }
  const problem = httpProblemOf(error);
  switch (problem.status) {
    case 0:
      return { kind: 'offline' };
    case 403:
      return { kind: 'forbidden' };
    case 404:
      return { kind: 'not-found' };
    case 429:
      return { kind: 'rate', retryAt: retryAtOf(problem.retryAfterSeconds, now) };
    case 502:
      return problem.slug === 'github-unavailable' ? { kind: 'github' } : { kind: 'failed' };
    case 503:
      return problem.slug === 'console-origin-misconfigured' ? { kind: 'misconfigured' } : { kind: 'failed' };
    case 422:
      return problem.slug === 'dispatch-repository-unverified' ? { kind: 'unverified' } : { kind: 'failed' };
    default:
      return { kind: 'failed' };
  }
}

/**
 * Every answer of `POST …/actions-setup/workflow-pr` that opened no pull request (#759 PR 5 scope, the route's
 * `ACTIONS_WORKFLOW_PR_REFUSALS` plus the shared ones). Links and PR urls are kept only when they point at
 * `https://github.com/`; anything else is dropped, never rendered.
 */
export type WorkflowPrRefusal =
  /** 409: a PR from the console's branch is open; `pr` is null when the answer did not name it. */
  | { readonly kind: 'pr-open'; readonly pr: ActionsSetupPrDto | null }
  /** 409: the console's branch is left from an earlier attempt (#844); the customer deletes it on GitHub. */
  | { readonly kind: 'branch-exists'; readonly link: string | null }
  | { readonly kind: 'tampered' }
  | {
      readonly kind: 'permission-missing';
      readonly permissions: readonly string[];
      readonly link: string | null;
    }
  | { readonly kind: 'ready' }
  | { readonly kind: 'downgrade'; readonly pins: readonly string[] }
  /** 503 `github-write-disabled`: the operator's kill switch; the Copy path stays. */
  | { readonly kind: 'write-disabled' }
  | { readonly kind: 'misconfigured' }
  | { readonly kind: 'unverified' }
  | { readonly kind: 'rate'; readonly retryAt: string }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'failed' };

export function workflowPrRefusalOf(error: unknown, now: number = Date.now()): WorkflowPrRefusal {
  if (error instanceof TimeoutError || !(error instanceof HttpErrorResponse)) {
    return { kind: 'failed' };
  }
  const problem = httpProblemOf(error);
  const extensions = problem.extensions;
  const link = isGitHubUiUrl(extensions['link']) ? extensions['link'] : null;
  switch (problem.slug) {
    case 'actions-setup-pr-open':
      return { kind: 'pr-open', pr: prOf(extensions) };
    case 'actions-setup-branch-exists':
      return { kind: 'branch-exists', link };
    case 'actions-setup-pr-tampered':
      return { kind: 'tampered' };
    case 'actions-permission-missing':
      return { kind: 'permission-missing', permissions: wordsOf(extensions['permissions']), link };
    case 'actions-setup-ready':
      return { kind: 'ready' };
    case 'actions-setup-downgrade':
      return { kind: 'downgrade', pins: wordsOf(extensions['pins']) };
    case 'github-write-disabled':
      return { kind: 'write-disabled' };
    case 'console-origin-misconfigured':
      return { kind: 'misconfigured' };
    case 'dispatch-repository-unverified':
      return { kind: 'unverified' };
  }
  switch (problem.status) {
    case 0:
      return { kind: 'offline' };
    case 403:
      return { kind: 'forbidden' };
    case 404:
      return { kind: 'not-found' };
    case 429:
      return { kind: 'rate', retryAt: retryAtOf(problem.retryAfterSeconds, now) };
    default:
      return { kind: 'failed' };
  }
}

function retryAtOf(seconds: number | null, now: number): string {
  return new Date(now + (seconds ?? DEFAULT_RETRY_SECONDS) * 1000).toISOString();
}

/** Permission and pin names are short identifiers; anything else is left out rather than shown. */
function wordsOf(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((word): word is string => typeof word === 'string' && /^[a-z0-9_.@ -]{1,40}$/i.test(word))
    : [];
}

function prOf(extensions: Readonly<Record<string, unknown>>): ActionsSetupPrDto | null {
  const { number, url, provenance } = extensions;
  if (
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    !isGitHubUiUrl(url) ||
    !(ACTIONS_SETUP_PR_PROVENANCES as readonly unknown[]).includes(provenance)
  ) {
    return null;
  }
  return { number, url, provenance: provenance as ActionsSetupPrProvenance };
}
