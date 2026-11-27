import type { RunnerDto } from '@shared/contracts';

/** What the projects dialog may not offer now (#825): the `all` choice, and project rows that may not be ticked. */
export interface ScopeWidening {
  readonly allLocked: boolean;
  readonly lockedSlugs: ReadonlySet<string>;
}

const OPEN: ScopeWidening = { allLocked: false, lockedSlugs: new Set() };

/**
 * #795, #825: an owner who may not widen the runner (`canWiden` false: a subscription runner someone else enrolled)
 * may still keep what it serves or holds now and drop anything, which is what `setScope` accepts from them — never
 * `all` on a runner that is not under `all` already, nor a project outside that set. The ticked rows stay open so the
 * owner can untick an addition the Worker refused.
 */
export function scopeWideningOf(
  runner: RunnerDto,
  canWiden: boolean,
  options: readonly string[],
  selected: readonly string[],
): ScopeWidening {
  if (canWiden) {
    return OPEN;
  }
  const keepable = new Set([
    ...runner.allowedProjects,
    ...runner.servedProjects.map((project) => project.slug),
    ...selected,
  ]);
  return {
    allLocked: runner.projectScope !== 'all',
    lockedSlugs: new Set(options.filter((slug) => !keepable.has(slug))),
  };
}
