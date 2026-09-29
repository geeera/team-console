import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AddProjectStep, ProjectDto, ProjectSetupDto } from '@shared/contracts';
import { problem, type ProblemInit, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { ProjectSignalsRepo, ProjectsRepo, toProjectDto } from '@worker/db';
import { isValidRepoName, readCacheKey } from '@worker/github';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { findProject, projectNotFound, repoOf } from '../projects/lookup';
import {
  CONNECT_URL,
  isConnectedOwner,
  type OwnerConnection,
  type OwnerConnectionSource,
} from '../projects/owner-connection';
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
import { routineSecretName } from '../projects/slug';

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

/** The JSON body, or `undefined` when there is none or it is not JSON (the parsers then refuse it). */
async function jsonBody(c: Context): Promise<unknown> {
  try {
    return (await c.req.json()) as unknown;
  } catch {
    // Malformed JSON is the client's input, answered as a validation problem; the parser's message is dropped.
    return undefined;
  }
}

/**
 * Presence only: the secret's value is never assigned to anything that leaves this function (#15 AC). Workers
 * bindings are plain properties of `env`.
 */
function hasRoutineToken(env: ApiEnv, slug: string): boolean {
  const name = routineSecretName(slug);
  return typeof Reflect.get(env, name) === 'string' && Reflect.get(env, name) !== '';
}

function setupOf(
  facts: RepositoryFacts,
  connection: OwnerConnection | null,
  signals: { events: boolean; accessLostAt: string | null; routineToken: boolean },
): ProjectSetupDto {
  let repoOwner: ProjectSetupDto['repoOwner'] = 'not-checked';
  if (facts.owner !== null && connection !== null) {
    repoOwner = isConnectedOwner(facts.owner, connection) ? 'ok' : 'mismatch';
  }
  return {
    appInstalled: facts.installed ? 'ok' : 'missing',
    repoOwner,
    projectYml: facts.hasProjectYml ? 'ok' : 'missing',
    events: signals.events ? 'seen' : 'never',
    routineToken: signals.routineToken ? 'present' : 'missing',
    connection:
      connection === null ? { state: 'not-connected' } : { state: 'connected', login: connection.login },
    accessLostAt: signals.accessLostAt,
    ownerLanguage: facts.ownerLanguage,
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
      const body: ProjectDto[] = rows.map(toProjectDto);
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

      const owner = await owners.current(c.env);
      if (owner === null) {
        return stepProblem(c, {
          type: 'github-owner-not-connected',
          title: 'No GitHub account is connected',
          status: 403,
          step: 'repo-owner',
          detail: 'Connect the owner GitHub account in Settings first',
          extensions: { connectUrl: CONNECT_URL },
        });
      }

      const client = repositoryClient(connection, repo);
      let read: RepositoryRead;
      try {
        read = await readRepository(client, repo);
      } catch (error: unknown) {
        throw inStep(error, 'repo-owner');
      }
      if (!isConnectedOwner(read.owner, owner)) {
        return stepProblem(c, {
          type: 'github-owner-mismatch',
          title: 'The repository belongs to another account',
          status: 409,
          step: 'repo-owner',
          detail: `${read.fullName} is owned by ${read.owner.login}, not by the connected account ${owner.login}`,
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
      return c.json(toProjectDto(row), 201);
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
      return row === null ? projectNotFound(c) : c.json(toProjectDto(row));
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
      const body = setupOf(facts, await owners.current(c.env), {
        events: await signals.hasDeliveryFor(project.repo),
        accessLostAt: await signals.accessLostAt(project.slug),
        routineToken: hasRoutineToken(c.env, project.slug),
      });
      return c.json(body);
    });
}
