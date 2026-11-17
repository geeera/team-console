import { Hono } from 'hono';
import {
  TEAM_CONFIG_REASON_MAX_LENGTH,
  TEAM_CONFIG_SCHEMA,
  budgetOf,
  checkTeamConfig,
  defaultPresetOf,
  isRecord,
  isTeamConfigPreset,
  presetViewOf,
  resolveTeamConfig,
  teamConfigDiffOf,
  type AccessSource,
  type TeamConfig,
  type TeamConfigChange,
  type TeamConfigDto,
  type TeamConfigImportDto,
  type TeamConfigProblemType,
  type TeamConfigRevisionDto,
  type TeamConfigRevisionListDto,
  type TeamConfigRevisionSummaryDto,
} from '@shared/contracts';
import { withoutInvisibles } from '@shared/plain-text';
import { redactSecrets } from '@shared/redaction';
import { newUlid, problem, type ProblemExtensionValue, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import {
  JobsRepo,
  RateLimitsRepo,
  TeamConfigRepo,
  UsersRepo,
  rateWindowOf,
  retryAfterOf,
  type ProjectRow,
  type TeamConfigRecord,
  type TeamConfigRevisionRecord,
} from '@worker/db';
import { GitHubVcsAdapter } from '@worker/vcs-github';
import { auditActorOf } from '../auth/scope';
import { policyActorOfContext, trackerAccess, trackerProjectOfContext } from '../auth/tracker-access.middleware';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { jsonBody } from '../json-body';
import { canManageProject, repoOf } from '../projects/lookup';
import type { OwnerConnectionSource } from '../projects/owner-connection';
import { repoIdOf } from '../read-models/repo-id';
import { SubrequestBudget } from '../read-models/subrequest-budget';
import { TEAM_CONFIG_IMPORT_MAX_BYTES, TEAM_CONFIG_IMPORT_PATH, teamConfigDraftOf } from '../team-config/import-draft';
import { resolvedViewOf } from '../team-config/resolved';
import { SMALL_WRITE_MAX_BYTES, pageOf, writeLimit } from '../tracker/http';
import { jobAuditOf } from './jobs';

type Context = WorkerContext<ApiEnv>;

const P = '/api/v1/projects/:slug';

/** A document is at most 16 KB; its JSON body with a 500-character reason in any script stays inside this. */
const PUT_MAX_BYTES = 24 * 1024;
/** Import reads GitHub: per project, as the other GitHub-backed routes are limited (threat model C12 row 7). */
export const IMPORT_WINDOW_SECONDS = 600;
export const IMPORTS_PER_WINDOW = 10;
/** token 2 + the repository by id 1 + the file 1, with room for a retried token mint. */
const IMPORT_BUDGET = 6;
/** The audit row names at most this many changed paths; past it they are named by their section (`roles.dev`). */
const AUDIT_PATHS_MAX = 32;
const REVISION = /^(0|[1-9][0-9]{0,8})$/;

type ProblemStatus = 404 | 409 | 412 | 422 | 428;

function teamConfigProblem(
  c: Context,
  type: TeamConfigProblemType | 'team-config-import-provider',
  status: ProblemStatus,
  detail: string,
  field?: string,
): Response {
  const extensions: Record<string, ProblemExtensionValue> = field === undefined ? {} : { field };
  const titles: Readonly<Record<ProblemStatus, string>> = {
    404: 'Not found',
    409: 'Conflict',
    412: 'The team configuration changed since it was read',
    422: 'Invalid request',
    428: 'If-Match required',
  };
  return problem(c, { type, title: titles[status], status, detail, extensions });
}

/** `If-Match: "<revision>"` as `GET …/team-config`'s `ETag` gives it, 0 for a project with no document yet. */
function expectedRevisionOf(c: Context): number | null {
  const match = /^"(0|[1-9][0-9]{0,8})"$/.exec(c.req.header('If-Match') ?? '');
  return match === null ? null : Number(match[1]);
}

const etagOf = (revision: number): string => `"${String(revision)}"`;

function versionRequired(c: Context): Response {
  return teamConfigProblem(
    c,
    'team-config-version-required',
    428,
    'Send the revision you changed as If-Match: "<revision>" (the ETag of GET …/team-config)',
  );
}

/** The scoped project's access source: the column the claim reads, which only `TeamConfigRepo` writes. */
async function accessSourceOf(c: Context, row: ProjectRow, repo = new TeamConfigRepo(c.env.DB)): Promise<AccessSource> {
  return (await repo.accessSourceOf(row.slug)) ?? 'subscription';
}

/** A person's login for an author id; the console's own owner identities and unknown ids have none. */
async function authorNameOf(c: Context, actor: string | null): Promise<string | null> {
  if (actor === null) {
    return null;
  }
  return (await new UsersRepo(c.env.DB).findById(actor))?.login ?? null;
}

/** `authorNameOf` once per distinct author of a page: a history is a handful of people over many revisions. */
async function authorNamesOf(c: Context, actors: readonly string[]): Promise<ReadonlyMap<string, string | null>> {
  const unique = [...new Set(actors)];
  const names = await Promise.all(unique.map(async (actor) => [actor, await authorNameOf(c, actor)] as const));
  return new Map(names);
}

async function viewOf(c: Context, row: ProjectRow, current: TeamConfigRecord | null): Promise<TeamConfigDto> {
  const config = current?.config ?? null;
  const revision = current?.revision ?? 0;
  const repo = new TeamConfigRepo(c.env.DB);
  return {
    config,
    revision,
    preset: presetViewOf(config),
    budget: budgetOf(config),
    resolved: resolveTeamConfig(config, { revision, accessSource: await accessSourceOf(c, row, repo) }),
    updatedAt: current?.updatedAt ?? null,
    updatedBy: current?.updatedBy ?? null,
    updatedByName: await authorNameOf(c, current?.updatedBy ?? null),
    reason: current === null ? null : ((await repo.findRevision(row.slug, current.revision))?.reason ?? null),
    canManage: canManageProject(c, row),
    subscriptionBlocked: await repo.isSubscriptionBlocked(row.slug),
  };
}

function respondView(c: Context, view: TeamConfigDto): Response {
  c.header('ETag', etagOf(view.revision));
  c.header('Cache-Control', 'no-store');
  return c.json(view);
}

/**
 * The paths the audit row names (ADR 0008 decision 5: ids and enums, never values). Keys only: every key on the
 * path is one of the schema's own, so no value of the document can reach the row.
 */
export function auditPathsOf(diff: readonly TeamConfigChange[]): string[] {
  const leaves = diff.map((change) => change.path);
  if (leaves.length <= AUDIT_PATHS_MAX) {
    return leaves;
  }
  return [...new Set(leaves.map((path) => path.split('.').slice(0, 2).join('.')))].slice(0, AUDIT_PATHS_MAX);
}

/** `reason`: plain text, redacted, 1..500 characters after trimming; blank is none. */
function reasonOf(value: unknown): { readonly ok: true; readonly reason: string | null } | { readonly ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, reason: null };
  }
  if (typeof value !== 'string') {
    return { ok: false };
  }
  const reason = redactSecrets(withoutInvisibles(value).trim(), 'strict');
  if (reason.length > TEAM_CONFIG_REASON_MAX_LENGTH) {
    return { ok: false };
  }
  return { ok: true, reason: reason === '' ? null : reason };
}

/** Only `allowed` members in a JSON object body; an empty or missing body is `{}`. */
function bodyOf(body: unknown, allowed: readonly string[]): Readonly<Record<string, unknown>> | null {
  const value = body ?? {};
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    return null;
  }
  return value;
}

/**
 * Saves `config` over revision `expected` and answers the new view, 412 when another write got there first, or 422
 * `access-source-hosted`. The document always names its access source, so every revision says where it may run.
 */
async function save(
  c: Context,
  row: ProjectRow,
  expected: number,
  input: TeamConfig,
  reason: string | null,
  current: TeamConfigRecord | null,
): Promise<Response> {
  const config = { ...input, access: { source: input.access?.source ?? (await accessSourceOf(c, row)) } };
  const diff = teamConfigDiffOf(current?.config ?? null, config);
  const now = new Date();
  const at = now.toISOString();
  const actor = auditActorOf(c.get('identity'));
  const repo = new TeamConfigRepo(c.env.DB);
  const outcome = await repo.save({
    projectSlug: row.slug,
    expectedRevision: expected,
    config,
    diff,
    reason,
    id: newUlid(now.getTime()),
    at,
    by: actor.actor,
    audit: jobAuditOf(c, row.account_id, at, 'team-config.changed', row.slug, {
      revision_from: expected,
      revision_to: expected + 1,
      paths: auditPathsOf(diff),
    }),
  });
  switch (outcome.kind) {
    case 'saved':
      c.get('logger').info('team config saved', { slug: row.slug, revision: outcome.revision });
      return respondView(c, await viewOf(c, row, await repo.findCurrent(row.slug)));
    case 'stale':
      return teamConfigProblem(c, 'team-config-stale', 412, 'Read the team configuration again and apply the change to its current revision');
    case 'access-source-hosted':
      return teamConfigProblem(
        c,
        'access-source-hosted',
        422,
        'A subscription runs only on your own self-hosted runner: the placement admits a hosted runner, or the project is dispatched to GitHub Actions',
        'access.source',
      );
  }
}

function summaryOf(row: TeamConfigRevisionRecord, names: ReadonlyMap<string, string | null>): TeamConfigRevisionSummaryDto {
  return {
    revision: row.revision,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    createdByName: names.get(row.createdBy) ?? null,
    reason: row.reason,
    paths: row.diff.map((change) => change.path),
  };
}

/**
 * `…/team-config` (ADR 0009 d.9, #687): the owner's and members' reads, the owner's writes, and the one route a job
 * reads, `…/resolved`. Every route passes its row of the route matrix (`trackerAccess`): the writes are owner-only,
 * the reads are the account's, and a job reaches `…/resolved` alone (403 `owner-only` on the rest). The project is
 * the scoped lookup's, so another account's slug is 404 `project-not-found`.
 */
export function createTeamConfigRoutes(github: ApiGitHub, owners: OwnerConnectionSource): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/team-config', trackerAccess(`GET ${P}/team-config`), async (c) => {
      const row = trackerProjectOfContext(c);
      return respondView(c, await viewOf(c, row, await new TeamConfigRepo(c.env.DB).findCurrent(row.slug)));
    })

    .put('/:slug/team-config', trackerAccess(`PUT ${P}/team-config`), writeLimit(PUT_MAX_BYTES), async (c) => {
      const row = trackerProjectOfContext(c);
      const expected = expectedRevisionOf(c);
      if (expected === null) {
        return versionRequired(c);
      }
      const body = bodyOf(await jsonBody(c), ['config', 'reason']);
      if (body === null || !Object.hasOwn(body, 'config')) {
        return teamConfigProblem(c, 'team-config-invalid', 422, 'The body is { config, reason? }', 'body');
      }
      const check = checkTeamConfig(body['config']);
      if (!check.ok) {
        return teamConfigProblem(c, check.type, 422, check.detail, check.field);
      }
      const reason = reasonOf(body['reason']);
      if (!reason.ok) {
        return teamConfigProblem(c, 'team-config-invalid', 422, `reason is text of at most ${String(TEAM_CONFIG_REASON_MAX_LENGTH)} characters`, 'reason');
      }
      const current = await new TeamConfigRepo(c.env.DB).findCurrent(row.slug);
      return save(c, row, expected, check.value, reason.reason, current);
    })

    .post('/:slug/team-config/reset', trackerAccess(`POST ${P}/team-config/reset`), writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const row = trackerProjectOfContext(c);
      const expected = expectedRevisionOf(c);
      if (expected === null) {
        return versionRequired(c);
      }
      const body = bodyOf(await jsonBody(c), ['preset']);
      const preset = body?.['preset'] ?? defaultPresetOf(await accessSourceOf(c, row));
      if (body === null || !isTeamConfigPreset(preset)) {
        return teamConfigProblem(c, 'team-config-invalid', 422, 'The body is { preset?: economy | recommended | max }', body === null ? 'body' : 'preset');
      }
      const current = await new TeamConfigRepo(c.env.DB).findCurrent(row.slug);
      // A reset applies the preset to every role: the role overrides go, the rest of the document stays.
      const kept = Object.fromEntries(
        Object.entries(current?.config ?? { schema: TEAM_CONFIG_SCHEMA }).filter(([key]) => key !== 'roles'),
      ) as TeamConfig;
      return save(c, row, expected, { ...kept, preset }, null, current);
    })

    .post('/:slug/team-config/import', trackerAccess(`POST ${P}/team-config/import`), writeLimit(SMALL_WRITE_MAX_BYTES), async (c) => {
      const row = trackerProjectOfContext(c);
      // Never a repository named by the request: the project's own, by its recorded id (threat model C9, C12).
      if (bodyOf(await jsonBody(c), []) === null) {
        return teamConfigProblem(c, 'team-config-invalid', 422, 'The import takes no body: it reads the project’s own repository', 'body');
      }
      const at = github.now();
      const limit = await new RateLimitsRepo(c.env.DB).hit(
        `team-config-import:${row.slug}`,
        rateWindowOf(at, IMPORT_WINDOW_SECONDS),
        IMPORTS_PER_WINDOW,
      );
      if (!limit.allowed) {
        return problem(c, { type: 'rate-limited', title: 'Too Many Requests', status: 429, retryAfter: retryAfterOf(at, IMPORT_WINDOW_SECONDS) });
      }
      if (row.provider !== 'github') {
        return teamConfigProblem(c, 'team-config-import-provider', 409, 'Only GitHub repositories are imported until the VCS adapter covers this provider');
      }
      const repo = repoOf(c, row);
      if (repo instanceof Response) {
        return repo;
      }
      const repoId = await repoIdOf(c, github, owners, row, repo);
      if (repoId instanceof Response) {
        return repoId;
      }
      const budget = new SubrequestBudget(IMPORT_BUDGET);
      const vcs = new GitHubVcsAdapter(await budget.connectionFor(await github.connect(c.env), repo));
      const ref = { provider: 'github', owner: repo.owner, name: repo.name, externalId: String(repoId) } as const;
      const repository = await vcs.repository(ref);
      const file = await vcs.files.read(ref, TEAM_CONFIG_IMPORT_PATH, repository.defaultBranch, TEAM_CONFIG_IMPORT_MAX_BYTES);
      if (file === 'not-found' || file === 'too-large' || file.text === null) {
        const detail =
          file === 'not-found'
            ? `${TEAM_CONFIG_IMPORT_PATH} is not on the default branch`
            : file === 'too-large'
              ? `${TEAM_CONFIG_IMPORT_PATH} is larger than ${String(TEAM_CONFIG_IMPORT_MAX_BYTES)} bytes`
              : `${TEAM_CONFIG_IMPORT_PATH} is not UTF-8 text`;
        return teamConfigProblem(c, 'team-config-import-invalid', 422, detail, 'project.yml');
      }
      const draft = teamConfigDraftOf(file.text);
      if (!draft.ok) {
        return teamConfigProblem(c, 'team-config-import-invalid', 422, draft.detail, draft.field);
      }
      const body: TeamConfigImportDto = {
        draft: draft.draft,
        notes: draft.notes,
        source: { path: TEAM_CONFIG_IMPORT_PATH, ref: repository.defaultBranch, sha: file.sha },
      };
      c.header('Cache-Control', 'no-store');
      return c.json(body);
    })

    .get('/:slug/team-config/revisions', trackerAccess(`GET ${P}/team-config/revisions`), async (c) => {
      const row = trackerProjectOfContext(c);
      const page = pageOf(c);
      if (page instanceof Response) {
        return page;
      }
      const rows = await new TeamConfigRepo(c.env.DB).listRevisions(row.slug, page.after, page.limit);
      const shown = rows.slice(0, page.limit);
      const names = await authorNamesOf(c, shown.map((revision) => revision.createdBy));
      const body: TeamConfigRevisionListDto = {
        revisions: shown.map((revision) => summaryOf(revision, names)),
        nextCursor: rows.length > page.limit ? (shown.at(-1)?.revision ?? null) : null,
      };
      return c.json(body);
    })

    .get('/:slug/team-config/revisions/:n', trackerAccess(`GET ${P}/team-config/revisions/:n`), async (c) => {
      const row = trackerProjectOfContext(c);
      const n = c.req.param('n');
      // By (project, revision) only: the revision row's ULID is never a key a request can name (threat model C12).
      const found = REVISION.test(n) ? await new TeamConfigRepo(c.env.DB).findRevision(row.slug, Number(n)) : null;
      if (found === null) {
        return teamConfigProblem(c, 'team-config-revision-not-found', 404, 'The project has no such revision');
      }
      const body: TeamConfigRevisionDto = {
        revision: found.revision,
        config: found.config,
        diff: found.diff,
        createdAt: found.createdAt,
        createdBy: found.createdBy,
        createdByName: await authorNameOf(c, found.createdBy),
        reason: found.reason,
      };
      return c.json(body);
    })

    .get('/:slug/team-config/resolved', trackerAccess(`GET ${P}/team-config/resolved`), async (c) => {
      const row = trackerProjectOfContext(c);
      const actor = policyActorOfContext(c);
      // A job sees the revision its claim stamped, read from its own row: nothing in the request names it (T2).
      const revision =
        actor.kind === 'job'
          ? ((await new JobsRepo(c.env.DB).findInProject(row.slug, actor.jobId))?.teamConfigRevision ?? null)
          : ((await new TeamConfigRepo(c.env.DB).findCurrent(row.slug))?.revision ?? null);
      c.header('Cache-Control', 'no-store');
      return c.json(await resolvedViewOf(c.env.DB, row.slug, revision));
    });
}
