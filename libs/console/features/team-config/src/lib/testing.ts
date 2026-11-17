import {
  TEAM_SLOTS,
  budgetOf,
  presetViewOf,
  resolveTeamConfig,
  type TeamConfig,
  type TeamConfigDto,
  type TeamStatusDto,
} from '@shared/contracts';

/** A `GET …/team-config` view as the Worker builds it, for specs and stories (never shipped through the barrel). */
export function teamConfigViewOf(
  config: TeamConfig | null,
  extras: Partial<Pick<TeamConfigDto, 'revision' | 'canManage' | 'subscriptionBlocked' | 'updatedByName' | 'reason'>> = {},
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
    reason: extras.reason ?? null,
    canManage: extras.canManage ?? true,
    subscriptionBlocked: extras.subscriptionBlocked ?? false,
  };
}

/** A `GET …/team/status` answer the guard accepts, for the budget callout and the waived month. */
export function teamStatusOf(overrides: Partial<TeamStatusDto> = {}): TeamStatusDto {
  return {
    state: 'running',
    pausedAt: null,
    runLogUrl: null,
    ownerConnected: true,
    environment: 'local',
    snooze: { snoozed: false },
    checkedAt: '2026-11-16T12:00:00.000Z',
    sprint: null,
    progress: null,
    calendar: null,
    pendingRequests: 0,
    pauseHolds: true,
    pauseLiftsAtNextRun: false,
    budget: null,
    slots: TEAM_SLOTS.map((slot) => ({
      slot,
      setup: 'present' as const,
      secrets: { token: `SLOT_TOKEN_${slot}`, routine: `SLOT_ROUTINE_${slot}` },
      lastRun: null,
      lock: null,
    })),
    ...overrides,
  };
}
