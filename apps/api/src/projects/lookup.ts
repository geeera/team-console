import { problem, type WorkerContext } from '@worker/core';
import { ProjectsRepo, type ProjectRow, type TrackerProject } from '@worker/db';
import { InvalidRepoNameError, parseRepoName, type RepoName } from '@worker/github';
import { admits, roleIn, scopeOf } from '../auth/scope';
import type { ApiEnv } from '../env';

// Threat row 2 of #9: a slug with `/`, `..` or an encoded slash never reaches D1 or GitHub. Looser than the
// registry's slug rule on purpose: lookups only need to be safe, and a stricter rule lives on write.
const SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;

/**
 * The active project behind `:slug` **inside the request's scope** (ADR 0008 decision 2, the one chokepoint for a
 * slug): archived, unknown and out-of-scope slugs are all `null`, so the 404 `project-not-found` they get is one
 * answer — nothing behind a slug is enumerable across accounts. The scope comes from the identity alone
 * (`scopeOf`), never from a body or a query.
 */
export async function findProject(c: WorkerContext<ApiEnv>, slug: string): Promise<ProjectRow | null> {
  if (!SLUG_PATTERN.test(slug)) {
    return null;
  }
  const row = await new ProjectsRepo(c.env.DB).findActiveBySlug(slug);
  if (row === null) {
    return null;
  }
  if (!admits(scopeOf(c.get('identity'), c.env), row)) {
    c.get('logger').warn('project refused', { reason: 'out-of-scope', identity: c.get('identity').kind });
    return null;
  }
  return row;
}

/** The scope's active projects (`/needs-you`, `/overview`, the registry list): an empty scope lists nothing. */
export async function scopedProjectsOf(
  c: WorkerContext<ApiEnv>,
  include: 'active' | 'all' = 'active',
): Promise<ProjectRow[]> {
  const scope = scopeOf(c.get('identity'), c.env);
  const repo = new ProjectsRepo(c.env.DB);
  switch (scope.kind) {
    case 'accounts':
      return include === 'all' ? repo.listAll(scope.accountIds) : repo.listActive(scope.accountIds);
    case 'project': {
      // A job lists its own project only (R4), and never an archived one.
      const row = await findProject(c, scope.slug);
      return row === null ? [] : [row];
    }
    case 'none':
      return [];
  }
}

/** The account ids a request may create or list in; `[]` for an identity with no account scope. */
export function scopedAccountIdsOf(c: WorkerContext<ApiEnv>): readonly string[] {
  const scope = scopeOf(c.get('identity'), c.env);
  return scope.kind === 'accounts' ? scope.accountIds : [];
}

/** The tracker view of a scoped row (one read serves the registry and the tracker). */
export function trackerProjectOf(row: ProjectRow): TrackerProject {
  return {
    slug: row.slug,
    accountId: row.account_id,
    tracker: row.tracker,
    keyPrefix: row.key_prefix,
    nextItemNumber: row.next_item_number,
    cutoverAt: row.cutover_at,
  };
}

/**
 * 403 `account-owner-only` unless the identity is an `owner` of the project's account (#482 security review: the
 * owner-grade project writes — registry edits, answers, team and sprint commands, snooze — are the account owner's,
 * not any member's, and not the Access owner's on an account it is merely a member of). The dev/stage service
 * identity keeps the path its own gates give it. Called after `findProject`, so it never reveals a slug.
 */
export function projectOwnerRefusal(c: WorkerContext<ApiEnv>, project: ProjectRow): Response | null {
  const identity = c.get('identity');
  if (identity.kind === 'service' || roleIn(identity, c.env, project.account_id) === 'owner') {
    return null;
  }
  c.get('logger').warn('project write refused', { reason: 'account-owner-only', identity: identity.kind });
  return problem(c, {
    type: 'account-owner-only',
    title: 'Forbidden',
    status: 403,
    detail: 'Only an owner of the project’s account can make this change',
  });
}

export function projectNotFound(c: WorkerContext<ApiEnv>): Response {
  return problem(c, { type: 'project-not-found', title: 'Project not found', status: 404 });
}

/** The row's repository as a validated name, or a 500 problem for a row that holds something else. */
export function repoOf(c: WorkerContext<ApiEnv>, project: ProjectRow): RepoName | Response {
  try {
    return parseRepoName(project.repo);
  } catch (error: unknown) {
    if (!(error instanceof InvalidRepoNameError)) {
      throw error;
    }
    // Registry rows are validated on write (#15); one that is not is our data, so it never reaches a URL.
    c.get('logger').error('registry row holds an invalid repository name', { slug: project.slug });
    return problem(c, {
      type: 'project-invalid',
      title: 'The project has an invalid repository name',
      status: 500,
    });
  }
}
