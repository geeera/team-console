import { budgetOf, presetViewOf, resolveTeamConfig, type TeamConfig, type TeamConfigDto } from '@shared/contracts';

/** A `GET …/team-config` view as the Worker builds it, for specs and stories (never shipped through the barrel). */
export function teamConfigViewOf(
  config: TeamConfig | null,
  extras: Partial<Pick<TeamConfigDto, 'revision' | 'canManage' | 'subscriptionBlocked' | 'updatedByName'>> = {},
): TeamConfigDto {
  const revision = extras.revision ?? (config === null ? 0 : 1);
  return {
    config,
    revision,
    preset: presetViewOf(config),
    budget: budgetOf(config),
    resolved: resolveTeamConfig(config, { revision, accessSource: config?.access?.source ?? 'api_key' }),
    updatedAt: config === null ? null : '2026-11-14T09:00:00.000Z',
    updatedBy: config === null ? null : 'local-owner',
    updatedByName: extras.updatedByName ?? null,
    canManage: extras.canManage ?? true,
    subscriptionBlocked: extras.subscriptionBlocked ?? false,
  };
}
