import { resolveTeamConfig, type ResolvedTeamConfigDto } from '@shared/contracts';
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
