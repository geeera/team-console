import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  GITHUB_CONNECT_PATH,
  routineSecretName,
  type AddProjectStep,
  type ProjectDto,
  type ProjectSetupDto,
} from '@shared/contracts';
import { problem, type ProblemInit, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import {
  ProjectSignalsRepo,
  ProjectsRepo,
  toProjectDto,
  type EventsSignal,
  type ProjectRow,
} from '@worker/db';
import {
  isRepoOwnedBy,
  isValidRepoName,
  parseRepoName,
  readCacheKey,
  type OwnerAccount,
} from '@worker/github';
import { embedOriginsOf } from '@worker/read-models';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { jsonBody } from '../json-body';
import { ProjectReads } from '../read-models/project-reads';
import { findProject, projectNotFound, repoOf } from '../projects/lookup';
import type { OwnerConnectionSource } from '../projects/owner-connection';
import { slotsSetupOf } from '../team/slot-secrets';
import {
  inStep,
  installUrlFor,
  isGitHubProblem,
  readProjectYml,
  readRepository,
  repositoryClient,
  repositoryFacts,
  type RepositoryFacts,
  type RepositoryRead,
} from '../projects/repository-checks';
import { isRefusal, parseAddProject, parseUpdateProject, type RequestRefusal } from '../projects/requests';

// The registry's bodies are a few short strings; anything bigger is not ours.
const MAX_BODY_BYTES = 4 * 1024;
const SETUP_TTL_SECONDS = 60;

type Context = WorkerContext<ApiEnv>;

function stepProblem(c: Context, init: ProblemInit & { readonly step: AddProjectStep }): Response {
  const { step, extensions, ...rest } = init;
  return problem(c, { ...rest, extensions: { ...extensions, step } });
}

function refused(c: Context, refusal: RequestRefusal): Response {
  const init: ProblemInit = {
    type: 'validation',
    title: 'Invalid request',
    status: 422,
    detail: refusal.detail,
  };
  return refusal.step === null ? problem(c, init) : stepProblem(c, { ...init, step: refusal.step });
}

/**
 * Presence only: the secret's value is never assigned to anything that leaves this function (#15 AC). Workers
 * bindings are plain properties of `env`.
 */
function hasRoutineToken(env: ApiEnv, slug: string): boolean {
  const name = routineSecretName(slug);
  return typeof Reflect.get(env, name) === 'string' && Reflect.get(env, name) !== '';
}

/** `ProjectDto.slots` (#114): whether Run now is set up per slot, presence only. */
function withSlots(env: ApiEnv, project: ProjectDto): ProjectDto {
  return { ...project, slots: slotsSetupOf(env, project.slug) };
}

/**
 * `ProjectDto.embedOrigins` (#20) of a registered row, through the read cache's project.yml entry. Archived rows
 * embed nothing; a GitHub failure is logged and embeds nothing rather than failing the registry answer, because
 * the list is what the console boots from.
 */
async function embedOriginsFor(c: Context, github: ApiGitHub, row: ProjectRow): Promise<string[]> {
  if (row.archived_at !== null) {
    return [];
  }
  try {
    return await new ProjectReads(github, c.env, row, parseRepoName(row.repo)).embedOrigins();
  } catch (error: unknown) {
    c.get('logger').warn('embed origins unavailable', {
      slug: row.slug,
      error: error instanceof Error ? error.name : 'unknown',
    });
    return [];
  }
}

function projectDtoOf(env: ApiEnv, row: ProjectRow, embedOrigins: readonly string[]): ProjectDto {
  return { ...withSlots(env, toProjectDto(row)), embedOrigins };
}

function setupOf(
  environment: string,
  facts: RepositoryFacts,
  connection: OwnerAccount | null,
  signals: { events: EventsSignal; accessLostAt: string | null; routineToken: boolean },
): ProjectSetupDto {
  let repoOwner: ProjectSetupDto['repoOwner'] = 'not-checked';
  if (facts.ownerCheckFailed) {
    repoOwner = 'unknown';
  } else if (facts.owner !== null && connection !== null) {
    repoOwner = isRepoOwnedBy(connection, facts.owner) ? 'ok' : 'mismatch';
  }
  return {
    appInstalled: facts.appInstalled,
    repoOwner,
    projectYml: facts.projectYml,
    events: signals.events.seen ? 'seen' : 'never',
    lastEventAt: signals.events.lastEventAt,
    routineToken: signals.routineToken ? 'present' : 'missing',
    connection:
      connection === null ? { state: 'not-connected' } : { state: 'connected', login: connection.login },
    accessLostAt: signals.accessLostAt,
    ownerLanguage: facts.ownerLanguage,
    ...(facts.appInstalled === 'missing' ? { installUrl: installUrlFor(environment) } : {}),
    ...(facts.owner === null ? {} : { repoOwnerLogin: facts.owner.login }),
  };
}

/**
 * The project registry (#15; ADR 0001 decisions 19–22 as amended by ADR 0003 decisions 2, 5, 6). Adding checks
 * everything against GitHub before the one D1 write; archived projects are 404 on every project route.
 */
export function createProjectRegistryRoutes(
  github: ApiGitHub,
  owners: OwnerConnectionSource,
): Hono<WorkerHonoEnv<ApiEnv>> {
  const limit = bodyLimit({ maxSize: MAX_BODY_BYTES });

  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/', async (c) => {
      const repo = new ProjectsRepo(c.env.DB);
      const rows = c.req.query('include') === 'archived' ? await repo.listAll() : await repo.listActive();
      const body: ProjectDto[] = await Promise.all(
        rows.map(async (row) => projectDtoOf(c.env, row, await embedOriginsFor(c, github, row))),
      );
      return c.json(body);
    })

    .post('/', limit, async (c) => {
      const request = parseAddProject(await jsonBody(c));
      if (isRefusal(request)) {
        return refused(c, request);
      }
      const { repo, slug, displayName } = request;
      const projects = new ProjectsRepo(c.env.DB);

      // Cheap and before any GitHub call; the insert below repeats it atomically.
      const conflict = await projects.findConflict(slug, repo.fullName);
      if (conflict !== null) {
        return stepProblem(c, {
          type: 'project-exists',
          title: 'The project is already registered',
          status: 409,
          step: 'unique',
          detail: conflict.archived
            ? `An archived project already uses this slug or repository (${conflict.slug})`
            : `A project already uses this slug or repository (${conflict.slug})`,
        });
      }

      const connection = await github.connect(c.env);

      let installationId: number;
      try {
        installationId = await connection.auth.installationIdFor(repo);
      } catch (error: unknown) {
        const extra = isGitHubProblem(error, 'github-app-not-installed')
          ? { installUrl: installUrlFor(c.env.ENVIRONMENT) }
          : {};
        throw inStep(error, 'app-installed', extra);
      }

      const owner = await owners.current(c.env, c.get('logger'));
      if (owner === null) {
        return stepProblem(c, {
          type: 'github-owner-not-connected',
          title: 'No GitHub account is connected',
          status: 403,
          step: 'repo-owner',
          detail: 'Connect the owner GitHub account in Settings first',
          extensions: { connectUrl: GITHUB_CONNECT_PATH },
        });
      }

      const client = repositoryClient(connection, repo);
      let read: RepositoryRead;
      try {
        read = await readRepository(client, repo);
      } catch (error: unknown) {
        throw inStep(error, 'repo-owner');
      }
      if (!isRepoOwnedBy(owner, read.owner)) {
        return stepProblem(c, {
          type: 'github-owner-mismatch',
          title: 'The repository belongs to another account',
          status: 409,
          step: 'repo-owner',
          detail: `${read.fullName} is owned by ${read.owner.login}, not by the connected account ${owner.login}`,
          // Both logins are named in Settings' copy (#24), so the client never parses `detail`.
          extensions: { repoOwner: read.owner.login, login: owner.login },
        });
      }

      let yml: string | null;
      try {
        yml = await readProjectYml(client, repo);
      } catch (error: unknown) {
        throw inStep(error, 'project-yml');
      }
      if (yml === null) {
        return stepProblem(c, {
          type: 'project-yml-missing',
          title: 'The repository has no .product-team/project.yml',
          status: 422,
          step: 'project-yml',
          detail: "Run the product-team plugin's kickoff or adopt in this repository first",
        });
      }

      // GitHub's spelling (current casing, a rename followed); the input when GitHub's is not a name we accept.
      const canonicalRepo = isValidRepoName(read.fullName) ? read.fullName : repo.fullName;
      const created = await projects.create({
        slug,
        repo: canonicalRepo,
        displayName,
        installationId,
        addedAt: new Date().toISOString(),
      });
      const row = created ? await projects.findActiveBySlug(slug) : null;
      if (row === null) {
        return stepProblem(c, {
          type: 'project-exists',
          title: 'The project is already registered',
          status: 409,
          step: 'unique',
          detail: 'A project with this slug or repository was added meanwhile',
        });
      }
      c.get('logger').info('project added', { slug });
      c.header('Location', `/api/v1/projects/${slug}`);
      // The file was just read: no second GitHub round trip for the new project's embed origins.
      return c.json(projectDtoOf(c.env, row, embedOriginsOf(yml)), 201);
    })

    .patch('/:slug', limit, async (c) => {
      const project = await findProject(c, c.req.param('slug'));
      if (project === null) {
        return projectNotFound(c);
      }
      const changes = parseUpdateProject(await jsonBody(c));
      if (isRefusal(changes)) {
        return refused(c, changes);
      }
      const row = await new ProjectsRepo(c.env.DB).update(project.slug, changes);
      // Archived between the lookup and the update.
      return row === null
        ? projectNotFound(c)
        : c.json(projectDtoOf(c.env, row, await embedOriginsFor(c, github, row)));
    })

    .post('/:slug/archive', async (c) => {
      const project = await findProject(c, c.req.param('slug'));
      if (project === null) {
        return projectNotFound(c);
      }
      const archived = await new ProjectsRepo(c.env.DB).archive(project.slug, new Date().toISOString());
      if (!archived) {
        return projectNotFound(c);
      }
      c.get('logger').info('project archived', { slug: project.slug });
      return c.body(null, 204);
    })

    .get('/:slug/setup', async (c) => {
      const project = await findProject(c, c.req.param('slug'));
      if (project === null) {
        return projectNotFound(c);
      }
      const repo = repoOf(c, project);
      if (repo instanceof Response) {
        return repo;
      }
      const key = readCacheKey({
        environment: c.env.ENVIRONMENT,
        slug: project.slug,
        epoch: project.cache_epoch,
        type: 'setup',
      });
      const facts = await github.readCache.getOrFill(
        key,
        SETUP_TTL_SECONDS,
        async () => repositoryFacts(await github.connect(c.env), repo),
        { fresh: c.req.query('fresh') === '1' },
      );
      const signals = new ProjectSignalsRepo(c.env.DB);
      const body = setupOf(c.env.ENVIRONMENT, facts, await owners.current(c.env, c.get('logger')), {
        events: await signals.eventsFor(project.repo),
        accessLostAt: await signals.accessLostAt(project.slug),
        routineToken: hasRoutineToken(c.env, project.slug),
      });
      return c.json(body);
    });
}
