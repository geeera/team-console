import { inject } from '@angular/core';
import { CanMatchFn, RedirectCommand, Route, Router, UrlSegment } from '@angular/router';
import { ProjectsStore, spaceUrlOf } from '@console/entities/project';
import { PersistedStateStore } from '@console/shared/persisted-state';

/**
 * `p/:slug` matches only for an active project. Waits for the first project-list load, so a deep
 * link never flashes "not found" before the list is known; a failed load matches nothing.
 */
export const projectExists: CanMatchFn = async (_route: Route, segments: UrlSegment[]) => {
  const projects = inject(ProjectsStore);
  await projects.ready();
  const slug = segments[1]?.path;
  return slug !== undefined && projects.isActive(decodeURIComponent(slug));
};

/** `/` opens the last project's last screen; with no restorable project, the cross-project inbox. */
export const restoreLastPlace: CanMatchFn = async () => {
  const projects = inject(ProjectsStore);
  const state = inject(PersistedStateStore);
  const router = inject(Router);
  await projects.ready();
  state.prune(projects.activeSlugs());
  const slug = state.activeSlug();
  const target = slug === null ? '/needs-you' : spaceUrlOf(slug, state.projectState(slug)?.lastPath);
  return new RedirectCommand(router.parseUrl(target), { replaceUrl: true });
};
