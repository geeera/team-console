import type { ProjectDto } from '@shared/contracts';

/**
 * Whether the project's tasks live in the console (#435, ADR 0006): `cutover` or `console`. A project not known yet,
 * or one a registry answer left without `tracker`, counts as GitHub, so nothing console-only is offered by mistake.
 */
export function isOnConsoleTracker(project: Pick<ProjectDto, 'tracker'> | null | undefined): boolean {
  const tracker = project?.tracker;
  return tracker !== undefined && tracker !== 'github';
}
