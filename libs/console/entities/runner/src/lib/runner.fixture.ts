import type { RunnerDto } from '@shared/contracts';

/** Runner ids in the Worker's ULID shape, for specs and stories. */
export const RUNNER_FIXTURE_IDS = {
  mac: '01M6YSNJ000000000000000R01',
  vps: '01M6YSNJ000000000000000R02',
  old: '01M6YSNJ000000000000000R03',
} as const;

/** A runner as `GET …/runners` answers it, for specs and stories across the runner slices. */
export function runnerFixture(overrides: Partial<RunnerDto> = {}): RunnerDto {
  return {
    id: RUNNER_FIXTURE_IDS.mac,
    name: 'Mac',
    isolation: 'user',
    hosted: false,
    version: '0.2.0',
    pinnedVersion: null,
    host: { os: 'darwin', arch: 'arm64', hostname: 'mac.local' },
    capabilities: { local: true, maxConcurrency: 1 },
    allowedProjects: ['team-console'],
    enrolledAt: '2026-11-10T09:00:00.000Z',
    lastSeenAt: '2026-11-11T09:58:00.000Z',
    lastSeenCountry: 'UA',
    online: true,
    suspect: null,
    revokedAt: null,
    belowMinimum: false,
    ...overrides,
  };
}
