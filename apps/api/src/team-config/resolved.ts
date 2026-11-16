import {
  JOB_MAX_MINUTES_DEFAULT,
  isTeamRole,
  resolveTeamConfig,
  type ResolvedTeamConfigDto,
} from '@shared/contracts';
import { TeamConfigRepo, type JobRecord } from '@worker/db';

/**
 * The resolved view of one revision of a project (ADR 0009 d.7, d.9): the revision's document, or `recommended` with
 * `projects.access_source` for `null` (a project with no document, or a job claimed before it had one). A revision
 * the project does not have is a broken invariant (0032's triggers), never input, so it throws.
 */
export async function resolvedViewOf(
  db: D1Database,
  projectSlug: string,
  revision: number | null,
): Promise<ResolvedTeamConfigDto> {
  const repo = new TeamConfigRepo(db);
  const accessSource = (await repo.accessSourceOf(projectSlug)) ?? 'subscription';
  if (revision === null) {
    return resolveTeamConfig(null, { revision: 0, accessSource });
  }
  const row = await repo.findRevision(projectSlug, revision);
  if (row === null) {
    throw new Error('a job names a team-config revision its project does not have');
  }
  return resolveTeamConfig(row.config, { revision, accessSource });
}

/** The view of the project's current revision: what a job enqueued now is held to. */
export async function currentResolvedViewOf(db: D1Database, projectSlug: string): Promise<ResolvedTeamConfigDto> {
  const current = await new TeamConfigRepo(db).findCurrent(projectSlug);
  return resolvedViewOf(db, projectSlug, current?.revision ?? null);
}

/** What enqueuing a job of `role` is held to (#684, ADR 0009 d.6). */
export interface RoleEnqueueLimits {
  /** `false`: the role is switched off, so no job of it is queued. */
  readonly enabled: boolean;
  /** `jobs.max_minutes`: the role's `max_minutes`, or the request's when that is lower (never raised past the role's). */
  readonly maxMinutes: number;
}

/**
 * The role's limits for a job enqueued now. `requested` is lowered to the role's `max_minutes`, never refused (threat
 * model C12 row 4, T5); a request naming none takes the role's. A role the schema does not know (none today:
 * `team-config-roles.spec.ts` keeps the two lists equal) keeps the request or the default.
 */
export function roleEnqueueLimitsOf(
  view: ResolvedTeamConfigDto,
  role: string,
  requested: number | null,
): RoleEnqueueLimits {
  if (!isTeamRole(role)) {
    return { enabled: true, maxMinutes: requested ?? JOB_MAX_MINUTES_DEFAULT };
  }
  const settings = view.roles[role];
  return {
    enabled: settings.enabled,
    maxMinutes: requested === null ? settings.max_minutes : Math.min(settings.max_minutes, requested),
  };
}

/** The claim response's members (ADR 0009 d.9): the view of the revision the claim stamped on the job. */
export async function claimTeamConfigOf(
  db: D1Database,
  job: JobRecord,
): Promise<{ readonly teamConfig: ResolvedTeamConfigDto; readonly teamConfigRevision: number | null }> {
  return {
    teamConfig: await resolvedViewOf(db, job.projectSlug, job.teamConfigRevision),
    teamConfigRevision: job.teamConfigRevision,
  };
}
