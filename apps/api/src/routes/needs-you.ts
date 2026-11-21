import { Hono } from 'hono';
import { renderRunnerWorkflow } from '@shared/actions-workflow';
import {
  NEEDS_YOU_MAX_PROJECTS,
  type NeedsYouActionsDriftDto,
  type NeedsYouBudgetStopDto,
  type NeedsYouConcurrencyStopDto,
  type NeedsYouProjectRef,
} from '@shared/contracts';
import type { Logger, WorkerHonoEnv } from '@worker/core';
import { ActionsWorkflowStateRepo, JobsRepo, TeamStateRepo } from '@worker/db';
import { GitHubError, InvalidRepoNameError, parseRepoName } from '@worker/github';
import { actionsDriftOf, buildNeedsYou, type ProjectInboxResult } from '@worker/read-models';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { canManageProject, scopedProjectsOf, trackerProjectOf } from '../projects/lookup';
import { projectProblemOf } from '../read-models/errors';
import { ProjectReads } from '../read-models/project-reads';
import { TrackerReads, readsRows } from '../read-models/tracker-reads';

/** A project's inbox as read, before it is tagged with the project. */
type ProjectInbox = Omit<Extract<ProjectInboxResult, { readonly inbox: unknown }>, 'project'>;

/**
 * `GET /api/v1/needs-you` (#35, #9 row 8): the inbox of every active project **of the request's scope** (ADR 0008
 * decision 2, #466), merged.
 *
 * Subrequest budget (Workers free plan: 50 per request). The first NEEDS_YOU_MAX_PROJECTS (6) GitHub-backed active
 * projects are read, each at most 6 subrequests on a cold isolate (installation lookup, token mint, ≤ 3 pages of
 * open issues, project.yml; see `ProjectReads`) → ≤ 36, plus 4 D1 queries (the registry, its tracker columns, the
 * budget stops, the concurrency stops, the Actions workflow judgements) and the Access key set → ≤ 41. Later GitHub-backed projects are listed in `omittedProjects`, not read. Within the read
 * cache's TTL a project costs nothing. A console-tracker project (#434) is one D1 query and no subrequest, so every
 * one is read and none counts against the cap.
 *
 * A project that fails is reported on its own row and the others are still shown — except a GitHub rate limit,
 * which the whole answer surfaces as 429 with `Retry-After` (the longest wait any project got), because the next
 * read of any project would hit the same limit.
 *
 * A project whose team the budget stopped (#684) carries `budgetStop`, its one "Budget used up" row. Every project
 * also carries `canManage` (#735): the caller's own standing on it, the same check `projectOwnerRefusal` makes at
 * write time, read once here as a hint for the UI. A project whose queued jobs cannot start because its account is
 * entitled to no concurrent job (#746, `max_concurrency: 0`) carries `concurrencyStop`, which says so. An Actions
 * project whose workflow drifted (#874) carries `actionsDrift`, from the judgement the readiness check or a failed
 * dispatch last stored: no GitHub call, so it is only as fresh as that write, and it says when it was made.
 */
export function createNeedsYouRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>().get('/', async (c) => {
    const active = await scopedProjectsOf(c);
    const trackers = new Map(active.map((row) => [row.slug, trackerProjectOf(row)]));
    // The cap is GitHub's subrequest budget: row-backed projects are read in full, in registry order with the rest.
    let githubBacked = 0;
    const read = active.filter(
      (row) => readsRows(trackers.get(row.slug)) || ++githubBacked <= NEEDS_YOU_MAX_PROJECTS,
    );
    const omitted: NeedsYouProjectRef[] = active
      .filter((row) => !read.includes(row))
      .map((row) => ({ slug: row.slug, name: row.display_name }));

    const settled = await Promise.allSettled(
      read.map(async (row): Promise<ProjectInbox> => {
        const tracker = trackers.get(row.slug);
        if (readsRows(tracker)) {
          return TrackerReads.of(c.env.DB, tracker, c.get('logger')).needsYou();
        }
        return {
          inbox: await new ProjectReads(github, c.env, row, parseRepoName(row.repo), github.now).inbox(),
        };
      }),
    );

    let rateLimit: GitHubError | undefined;
    const results: ProjectInboxResult[] = settled.map((outcome, index) => {
      const row = read[index];
      if (row === undefined) {
        throw new Error('settled results outnumber the projects read');
      }
      const project = { slug: row.slug, name: row.display_name };
      if (outcome.status === 'fulfilled') {
        return { project, ...outcome.value };
      }
      const error: unknown = outcome.reason;
      if (error instanceof GitHubError && error.problem.type === 'github-rate-limit') {
        if ((error.problem.retryAfter ?? 0) >= (rateLimit?.problem.retryAfter ?? -1)) {
          rateLimit = error;
        }
      }
      if (error instanceof InvalidRepoNameError) {
        c.get('logger').error('registry row holds an invalid repository name', { slug: row.slug });
        return {
          project,
          problem: {
            type: 'project-invalid',
            title: 'The project has an invalid repository name',
            status: 500,
          },
        };
      }
      const problem = projectProblemOf(error);
      if (problem === undefined) {
        // Not a known failure (a bug): the request fails as a whole rather than hiding it.
        throw error;
      }
      c.get('logger').warn('needs-you project failed', { slug: row.slug, problem: problem.type });
      return { project, problem };
    });
    if (rateLimit !== undefined) {
      throw rateLimit;
    }
    // #684: one D1 query for every project read, whatever its tracker; no GitHub subrequest.
    const budgetStops = new Map<string, NeedsYouBudgetStopDto>();
    for (const stop of await new TeamStateRepo(c.env.DB).budgetStopsOf(read.map((row) => row.slug), new Date().toISOString())) {
      if (stop.budgetUsd === null) {
        // A save that removes the budget lifts its pause in the same batch, so this is a broken invariant, not input.
        c.get('logger').error('budget stop without a budget', { slug: stop.projectSlug });
        continue;
      }
      budgetStops.set(stop.projectSlug, {
        month: stop.month,
        spentUsd: stop.spentUsd,
        budgetUsd: stop.budgetUsd,
        stoppedAt: stop.stoppedAt,
      });
    }
    // #746: one D1 query as well; the claim and the dispatch refuse these jobs on their own.
    const concurrencyStops = new Map<string, NeedsYouConcurrencyStopDto>(
      (await new JobsRepo(c.env.DB).concurrencyStopsOf(read.map((row) => row.slug))).map((stop) => [
        stop.projectSlug,
        { queuedJobs: stop.queuedJobs },
      ]),
    );
    // #735: a hint only, read once per project here; the write routes refuse on their own regardless of it.
    const canManage = new Map(read.map((row) => [row.slug, canManageProject(c, row)]));
    const actionsDrifts = await actionsDriftsOf(c.env, c.get('logger'), read.map((row) => row.slug));
    return c.json(buildNeedsYou(results, omitted, budgetStops, canManage, concurrencyStops, actionsDrifts));
  });
}

/**
 * #874: one D1 query, then this console's rendering, made locally, for the sha256 a stored `ok` is compared with. A
 * console that cannot render (its origin misconfigured) still shows every stored drift word, only not `release`.
 */
async function actionsDriftsOf(
  env: ApiEnv,
  logger: Logger,
  slugs: readonly string[],
): Promise<Map<string, NeedsYouActionsDriftDto>> {
  const drifts = new Map<string, NeedsYouActionsDriftDto>();
  const states = await new ActionsWorkflowStateRepo(env.DB).actionsStatesOf(slugs);
  if (states.length === 0) {
    return drifts;
  }
  const rendered = await renderRunnerWorkflow({ consoleOrigin: env.CONSOLE_PUBLIC_ORIGIN ?? '', environment: env.ENVIRONMENT });
  if (!rendered.ok) {
    logger.error('needs-you could not render the runner workflow', { failure: rendered.failure });
  }
  const sha256 = rendered.ok ? rendered.rendering.sha256 : null;
  for (const state of states) {
    const drift = actionsDriftOf(state, sha256);
    if (drift !== null) {
      drifts.set(state.projectSlug, drift);
    }
  }
  return drifts;
}
