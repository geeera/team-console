import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  isCalendarDate,
  type MoveDemoRequest,
  type MoveDemoResponse,
  type NextSprintRequest,
  type NextSprintResponse,
  type SprintRefDto,
} from '@shared/contracts';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { ProjectsRepo, type ProjectRow } from '@worker/db';
import { GitHubError, githubPath, type RepoName } from '@worker/github';
import { ownerOnlyMiddleware } from '../auth/owner-only.middleware';
import type { ApiEnv } from '../env';
import type { ApiGitHub, GitHubConnection } from '../github';
import { jsonBody } from '../json-body';
import { ownerWriter } from '../owner/owner-writer';
import { findProject, projectNotFound, repoOf } from '../projects/lookup';
import { repositoryClient } from '../projects/repository-checks';
import { ProjectReads, freezeDaysOfFile, readAllMilestones } from '../read-models/project-reads';
import {
  freezeOfDue,
  freezeStartsNow,
  moveDemoRefusal,
  nextSprintRefusal,
  sprintPlanOf,
  type MoveDemoRefusal,
  type NextSprintRefusal,
  type SprintPlan,
} from '../team/sprint-plan';
import { sprintToday } from '@worker/read-models';

type Context = WorkerContext<ApiEnv>;

const MAX_BODY_BYTES = 1024;
/** A milestone title is GitHub's; this is far above any `Sprint NN` and keeps the comparison cheap. */
const MAX_TITLE_LENGTH = 255;

interface GitHubMilestoneAnswer {
  readonly number: number;
  readonly title: string;
  readonly due_on: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMilestoneAnswer(value: unknown): value is GitHubMilestoneAnswer {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value['number']) &&
    typeof value['title'] === 'string' &&
    (value['due_on'] === null || typeof value['due_on'] === 'string')
  );
}

function hasOnlyKeys(body: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(body).every((key) => keys.includes(key)) && keys.every((key) => key in body);
}

export function parseMoveDemo(body: unknown): MoveDemoRequest | string {
  if (!isRecord(body) || !hasOnlyKeys(body, ['due', 'expectedDue'])) {
    return 'The body must be {"due": "YYYY-MM-DD", "expectedDue": "YYYY-MM-DD"}';
  }
  const { due, expectedDue } = body;
  if (!isCalendarDate(due) || !isCalendarDate(expectedDue)) {
    return 'due and expectedDue must be calendar dates written YYYY-MM-DD';
  }
  return { due, expectedDue };
}

export function parseNextSprint(body: unknown): NextSprintRequest | string {
  if (!isRecord(body) || !hasOnlyKeys(body, ['due', 'expectedCurrent'])) {
    return 'The body must be {"due": "YYYY-MM-DD", "expectedCurrent": string | null}';
  }
  const { due, expectedCurrent } = body;
  if (!isCalendarDate(due)) {
    return 'due must be a calendar date written YYYY-MM-DD';
  }
  if (
    expectedCurrent !== null &&
    (typeof expectedCurrent !== 'string' || expectedCurrent.length > MAX_TITLE_LENGTH)
  ) {
    return `expectedCurrent must be null or a title of at most ${MAX_TITLE_LENGTH} characters`;
  }
  return { due, expectedCurrent };
}

function invalid(c: Context, detail: string): Response {
  return problem(c, { type: 'validation', title: 'Invalid request', status: 422, detail });
}

/** `backlog sprint create`'s `due_on`: noon UTC of the day, so every time zone reads the same date. */
export function dueOnOf(day: string): string {
  return `${day}T12:00:00Z`;
}

function refOf(answer: GitHubMilestoneAnswer, fallbackDue: string): SprintRefDto {
  return { number: answer.number, title: answer.title, due: answer.due_on?.slice(0, 10) ?? fallbackDue };
}

function moveRefused(c: Context, refusal: MoveDemoRefusal): Response {
  switch (refusal.type) {
    case 'sprint-none':
      return problem(c, { type: 'sprint-none', title: 'There is no current sprint', status: 409 });
    case 'sprint-changed':
      return problem(c, {
        type: 'sprint-changed',
        title: 'The demo date changed meanwhile',
        status: 409,
        detail: 'Check the current demo date and send again',
        extensions: { due: refusal.due },
      });
    case 'sprint-unchanged':
      return problem(c, { type: 'sprint-unchanged', title: 'The demo is on that day already', status: 409 });
    case 'sprint-date-past':
      return problem(c, {
        type: 'sprint-date-past',
        title: 'That day has passed',
        status: 422,
        detail: 'Pick today or a later day (Kyiv time)',
        extensions: { today: refusal.today },
      });
    case 'sprint-date-after-next':
      return problem(c, {
        type: 'sprint-date-after-next',
        title: 'The next sprint has an earlier demo',
        status: 422,
        detail: 'Move the next sprint first',
        extensions: { nextTitle: refusal.next.title, nextDue: refusal.next.due },
      });
  }
}

function nextRefused(c: Context, refusal: NextSprintRefusal): Response {
  switch (refusal.type) {
    case 'sprint-changed':
      return problem(c, {
        type: 'sprint-changed',
        title: 'The current sprint changed meanwhile',
        status: 409,
        detail: 'Check the sprints and send again',
        extensions: {
          currentTitle: refusal.current?.title ?? null,
          currentDue: refusal.current?.due ?? null,
        },
      });
    case 'sprint-exists':
      return problem(c, {
        type: 'sprint-exists',
        title: 'The next sprint exists already',
        status: 409,
        // `title` is a standard problem member: the sprint's title goes in `nextTitle`, as for the date refusal.
        extensions: { nextTitle: refusal.title, nextDue: refusal.due },
      });
    case 'sprint-date-early':
      return problem(c, {
        type: 'sprint-date-early',
        title: 'The demo must come later',
        status: 422,
        extensions: { after: refusal.after },
      });
  }
}

interface Prepared {
  readonly project: ProjectRow;
  readonly repo: RepoName;
  readonly installation: GitHubConnection;
  readonly plan: SprintPlan;
}

/**
 * Sprint commands (#218, architect note on #29 §1–2): move the current sprint's demo and start the next sprint,
 * written on the owner's token exactly as `backlog sprint create` writes a milestone. Behind `ownerOnlyMiddleware`
 * (the service identity gets 403 before any read) and the owner connection (403 before any GitHub call). Each
 * request carries the state the owner saw; the Worker compares it with a live, uncached milestones read and answers
 * 409 with the current values, writing nothing on any 4xx. Writes are idempotent by state: a repeat finds the new
 * state and is refused as "changed" or "exists" with values that show it is done.
 * Subrequests: installation ≤ 2 + milestones 1 + project.yml 1 (shared, usually cached) + repository 1 + write 1.
 */
export function createSprintCommandsRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  const limit = bodyLimit({ maxSize: MAX_BODY_BYTES });

  /** Project, owner connection, live milestones; a `Response` for every refusal before them. */
  async function prepare(c: Context): Promise<Prepared | Response> {
    const project = await findProject(c, c.req.param('slug') ?? '');
    if (project === null) {
      return projectNotFound(c);
    }
    const repo = repoOf(c, project);
    if (repo instanceof Response) {
      return repo;
    }
    // D1 only: no connection is 403 github-owner-not-connected before GitHub is asked anything.
    await (await github.ownerConnection(c.env, c.get('logger'))).account();
    const installation = await github.connect(c.env);
    const reads = new ProjectReads(github, c.env, project, repo, github.now, installation);
    const [milestones, file] = await Promise.all([
      readAllMilestones(repositoryClient(installation, repo), repo),
      reads.projectYmlFile(),
    ]);
    return {
      project,
      repo,
      installation,
      plan: sprintPlanOf(milestones, sprintToday(github.now()), freezeDaysOfFile(file)),
    };
  }

  /** The board, the overview and the status card read the new milestone at once instead of within a minute. */
  async function refreshReads(c: Context, project: ProjectRow): Promise<void> {
    try {
      await new ProjectsRepo(c.env.DB).bumpCacheEpoch(project.slug);
    } catch (error: unknown) {
      c.get('logger').error('sprint written, read cache not refreshed', { slug: project.slug, error });
    }
  }

  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .post('/:slug/sprint/demo-date', ownerOnlyMiddleware, limit, async (c) => {
      const request = parseMoveDemo(await jsonBody(c));
      if (typeof request === 'string') {
        return invalid(c, request);
      }
      const prepared = await prepare(c);
      if (prepared instanceof Response) {
        return prepared;
      }
      const { project, repo, installation, plan } = prepared;
      const refusal = moveDemoRefusal(plan, request);
      if (refusal !== null || plan.current === null) {
        return moveRefused(c, refusal ?? { type: 'sprint-none' });
      }
      const writer = await ownerWriter(c.env, c.get('logger'), github, installation, {
        repo,
        registered: project.repo,
      });
      const answer = await writer.patchJson(
        githubPath`/repos/${repo}/milestones/${plan.current.number}`,
        { due_on: dueOnOf(request.due) },
        isMilestoneAnswer,
      );
      await refreshReads(c, project);
      c.get('logger').info('sprint demo moved', {
        slug: project.slug,
        milestone: plan.current.number,
        identity: c.get('identity').kind,
      });
      const body: MoveDemoResponse = {
        sprint: refOf(answer, request.due),
        freeze: freezeOfDue(plan, request.due),
        freezeStartsNow: freezeStartsNow(plan, request.due),
      };
      c.header('Cache-Control', 'no-store');
      return c.json(body);
    })

    .post('/:slug/sprint/next', ownerOnlyMiddleware, limit, async (c) => {
      const request = parseNextSprint(await jsonBody(c));
      if (typeof request === 'string') {
        return invalid(c, request);
      }
      const prepared = await prepare(c);
      if (prepared instanceof Response) {
        return prepared;
      }
      const { project, repo, installation, plan } = prepared;
      const refusal = nextSprintRefusal(plan, request);
      if (refusal !== null) {
        return nextRefused(c, refusal);
      }
      const writer = await ownerWriter(c.env, c.get('logger'), github, installation, {
        repo,
        registered: project.repo,
      });
      let answer: GitHubMilestoneAnswer;
      try {
        answer = await writer.postJson(
          githubPath`/repos/${repo}/milestones`,
          { title: plan.nextTitle, due_on: dueOnOf(request.due) },
          isMilestoneAnswer,
        );
      } catch (error: unknown) {
        // GitHub's 422 here is `already_exists`: the title and due date were checked, so only the title can clash —
        // the PM created this sprint between our read and the write.
        if (error instanceof GitHubError && error.githubStatus === 422) {
          return nextRefused(c, { type: 'sprint-exists', title: plan.nextTitle, due: null });
        }
        throw error;
      }
      await refreshReads(c, project);
      c.get('logger').info('sprint created', {
        slug: project.slug,
        milestone: answer.number,
        identity: c.get('identity').kind,
      });
      const body: NextSprintResponse = {
        sprint: refOf(answer, request.due),
        becomesCurrentAfter: plan.current?.due ?? null,
      };
      c.header('Cache-Control', 'no-store');
      return c.json(body, 201);
    });
}
