import type { RunnerProjectScope, RunnerScopeDto, RunnerSelfDto } from '@shared/contracts';
import type { RunnerConfig } from '../config/config';

/**
 * The scope the runner holds itself to before a job starts (#775): the projects it may serve, as the console answered
 * last. `source` says where the answer came from, for the refusal's message and the log: the console's `self` or
 * `claim`, the Actions `exchange`, or the enrol-time `config` copy while the console has not answered yet.
 */
export interface RunnerScope {
  readonly source: 'self' | 'claim' | 'exchange' | 'config';
  readonly projectScope: RunnerProjectScope;
  /** The effective project list: under `all` the console's answer of the moment, under `selected` the list. */
  readonly projects: readonly string[];
}

/**
 * The enrol-time copy, read as `selected` when the file predates scopes. Under `all` it lists nothing: the console's
 * answer is the only source of the account's projects, so a job that arrives before it is refused rather than guessed.
 */
export function scopeOfConfig(config: Pick<RunnerConfig, 'projectScope' | 'allowedProjects'>): RunnerScope {
  const projectScope = config.projectScope ?? 'selected';
  return { source: 'config', projectScope, projects: projectScope === 'all' ? [] : config.allowedProjects };
}

export function scopeOfSelf(self: RunnerSelfDto): RunnerScope {
  return {
    source: 'self',
    projectScope: self.runner.projectScope,
    projects: self.projects.map((project) => project.slug),
  };
}

export function scopeOfClaim(scope: RunnerScopeDto): RunnerScope {
  return { source: 'claim', projectScope: scope.projectScope, projects: scope.projects };
}
