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
  AuditRepo,
  InstallationsRepo,
  ProjectSignalsRepo,
  ProjectsRepo,
  auditEventStatement,
  toProjectDto,
  type EventsSignal,
  type TrackerProject,
} from '@worker/db';
import { isRepoOwnedBy, isValidRepoName, readCacheKey, type OwnerAccount } from '@worker/github';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { jsonBody } from '../json-body';
import { isOwnerIdentity } from '../auth/owner-only.middleware';
import { auditActorOf, membershipsOf } from '../auth/scope';
import {
  findProject,
  projectNotFound,
  projectOwnerRefusal,
  repoOf,
  scopedProjectsOf,
  trackerProjectOf,
} from '../projects/lookup';
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

/** `ProjectDto.tracker`/`keyPrefix` (#435): an archived or unknown project reads as still on GitHub. */
function withTracker(project: ProjectDto, tracker: TrackerProject | null | undefined): ProjectDto {
  return { ...project, tracker: tracker?.tracker ?? 'github', keyPrefix: tracker?.keyPrefix ?? null };
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

/** An owner's registry action as an `audit_events` row (ADR 0008 decision 5): ids and enums only in `details`. */
async function auditOwnerAction(
  c: Context,
  project: { readonly slug: string; readonly account_id: string },
  kind: 'project.updated',
  details: Readonly<Record<string, readonly string[] | string | number>>,
): Promise<void> {
  const actor = auditActorOf(c.get('identity'));
  await new AuditRepo(c.env.DB).append({
    accountId: project.account_id,
    at: new Date().toISOString(),
    actorKind: actor.kind,
    actor: actor.actor,
    kind,
    target: project.slug,
    details,
    ipCountry: c.req.header('CF-IPCountry') ?? null,
  });
}

/**
 * The project registry (#15; ADR 0001 decisions 19–22 as amended by ADR 0003 decisions 2, 5, 6; account-scoped
 * since #466). Adding checks everything against GitHub before the one D1 write; archived projects are 404 on every
 * project route.
 */
export function createProjectRegistryRoutes(
  github: ApiGitHub,
  owners: OwnerConnectionSource,
): Hono<WorkerHonoEnv<ApiEnv>> {
  const limit = bodyLimit({ maxSize: MAX_BODY_BYTES });

  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/', async (c) => {
      const rows = await scopedProjectsOf(c, c.req.query('include') === 'archived' ? 'all' : 'active');
      const nowMs = github.now();
      const body: ProjectDto[] = rows.map((row) =>
        withTracker(
          withSlots(c.env, toProjectDto(row, nowMs)),
          row.archived_at === null ? trackerProjectOf(row) : null,
        ),
      );
      return c.json(body);
    })

    .post('/', limit, async (c) => {
      // #482 security review: the add checks repository ownership against the environment owner's connection and
      // mints with the environment's app, so until T-4 binds a connection per user only the Access owner (and the
      // service identity on its dev/stage path) adds a project — the same rule as the `own-user` routes.
      const identity = c.get('identity');
      if (!isOwnerIdentity(identity, c.env) && identity.kind !== 'service') {
        c.get('logger').warn('owner route refused', {
          reason: identity.kind,
          method: c.req.method,
          path: c.req.path,
        });
        return problem(c, {
          type: 'owner-only',
          title: 'Forbidden',
          status: 403,
          detail: 'Projects are added by the environment owner until connections are per user',
        });
      }
      const request = parseAddProject(await jsonBody(c));
      if (isRefusal(request)) {
        return refused(c, request);
      }
      const { repo, slug, displayName } = request;
      const projects = new ProjectsRepo(c.env.DB);
      // The account the project is created in: an `owner` membership of the identity (ADR 0008 decision 2 — never
      // a body member). One owner membership decides; several need `accountId`, which must be one of them.
      const owned = membershipsOf(c.get('identity'), c.env).filter(
        (membership) => membership.role === 'owner',
      );
      const accountId =
        request.accountId === undefined
          ? owned.length === 1
            ? owned[0]?.accountId
            : undefined
          : owned.some((membership) => membership.accountId === request.accountId)
            ? request.accountId
            : undefined;
      if (accountId === undefined) {
        c.get('logger').warn('project add refused', { reason: 'account-owner-only', owned: owned.length });
        return stepProblem(c, {
          type: 'account-owner-only',
          title: 'Only an account owner adds a project',
          status: 403,
          step: 'unique',
          detail:
            owned.length > 1
              ? 'You own several accounts; say which one with accountId'
              : 'Projects are added by an owner of the account',
        });
      }

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

      // The installation belongs to this account from here on (decision 4; T-4 adds the setup-URL handshake):
      // one GitHub installation is one account's, so a repository of another account's installation is refused
      // before the row exists.
      const at = new Date().toISOString();
      const actor = auditActorOf(identity);
      const linked = await new InstallationsRepo(c.env.DB).link({
        accountId,
        provider: 'github',
        installationId: String(installationId),
        accountLogin: read.owner.login,
        // A `users` row only: the Access owner before the link and the local bypass have none.
        linkedByUserId: identity.kind === 'user' ? identity.userId : null,
        at,
      });
      if (linked === 'linked-elsewhere') {
        c.get('logger').warn('project add refused', { reason: 'installation-other-account', slug });
        return stepProblem(c, {
          type: 'installation-other-account',
          title: 'The installation belongs to another account',
          status: 409,
          step: 'app-installed',
          detail: 'The app installation on this repository is linked to another console account',
        });
      }

      // GitHub's spelling (current casing, a rename followed); the input when GitHub's is not a name we accept.
      const canonicalRepo = isValidRepoName(read.fullName) ? read.fullName : repo.fullName;
      const created = await projects.create({
        slug,
        repo: canonicalRepo,
        displayName,
        installationId,
        addedAt: at,
        accountId,
        repoId: read.id,
      });
      const row = created === 'created' ? await projects.findActiveBySlug(slug) : null;
      if (row === null) {
        // Lost the race the pre-check above did not see (#472 review): which UNIQUE was taken, never a 500.
        const taken = created === 'created' ? 'slug-taken' : created;
        c.get('logger').warn('project add refused', { reason: taken, slug });
        return stepProblem(c, {
          type: taken,
          title: 'The project is already registered',
          status: 409,
          step: 'unique',
          detail:
            taken === 'slug-taken'
              ? 'A project with this slug was added meanwhile'
              : 'A project with this repository was added meanwhile',
        });
      }
      await new AuditRepo(c.env.DB).append({
        accountId,
        at,
        actorKind: actor.kind,
        actor: actor.actor,
        kind: 'project.created',
        target: slug,
        details: { repoId: read.id, installationId },
        ipCountry: c.req.header('CF-IPCountry') ?? null,
      });
      c.get('logger').info('project added', { slug });
      c.header('Location', `/api/v1/projects/${slug}`);
      return c.json(withTracker(withSlots(c.env, toProjectDto(row, github.now())), null), 201);
    })

    .patch('/:slug', limit, async (c) => {
      const project = await findProject(c, c.req.param('slug'));
      if (project === null) {
        return projectNotFound(c);
      }
      const ownerRefusal = projectOwnerRefusal(c, project);
      if (ownerRefusal !== null) {
        return ownerRefusal;
      }
      const changes = parseUpdateProject(await jsonBody(c));
      if (isRefusal(changes)) {
        return refused(c, changes);
      }
      const row = await new ProjectsRepo(c.env.DB).update(project.slug, changes);
      // Archived between the lookup and the update.
      if (row === null) {
        return projectNotFound(c);
      }
      await auditOwnerAction(c, project, 'project.updated', {
        fields: Object.keys(changes).sort(),
      });
      return c.json(withTracker(withSlots(c.env, toProjectDto(row, github.now())), trackerProjectOf(row)));
    })

    .post('/:slug/archive', async (c) => {
      const project = await findProject(c, c.req.param('slug'));
      if (project === null) {
        return projectNotFound(c);
      }
      const ownerRefusal = projectOwnerRefusal(c, project);
      if (ownerRefusal !== null) {
        return ownerRefusal;
      }
      const at = new Date().toISOString();
      const actor = auditActorOf(c.get('identity'));
      const archived = await new ProjectsRepo(c.env.DB).archive(project.slug, at, [
        auditEventStatement(c.env.DB, {
          accountId: project.account_id,
          at,
          actorKind: actor.kind,
          actor: actor.actor,
          kind: 'project.archived',
          target: project.slug,
          ipCountry: c.req.header('CF-IPCountry') ?? null,
        }),
      ]);
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
      // The repository id backfill of rows registered before 0018 (T-2): recorded once from what GitHub answered.
      if (project.repo_id === null && facts.repoId !== null) {
        const recorded = await new ProjectsRepo(c.env.DB).setRepoId(project.slug, facts.repoId);
        c.get('logger').info('project repo id backfilled', { slug: project.slug, recorded });
      }
      const signals = new ProjectSignalsRepo(c.env.DB);
      const body = setupOf(c.env.ENVIRONMENT, facts, await owners.current(c.env, c.get('logger')), {
        events: await signals.eventsFor(project.repo),
        accessLostAt: await signals.accessLostAt(project.slug),
        routineToken: hasRoutineToken(c.env, project.slug),
      });
      return c.json(body);
    });
}
