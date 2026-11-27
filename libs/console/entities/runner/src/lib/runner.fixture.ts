import type { EnrolmentIntentDto, RunnerDto } from '@shared/contracts';

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
    projectScope: 'selected',
    allowedProjects: ['team-console'],
    servedProjects: [{ slug: 'team-console', accessSource: 'subscription', fit: true }],
    enrolledAt: '2026-11-10T09:00:00.000Z',
    lastSeenAt: '2026-11-11T09:58:00.000Z',
    lastSeenCountry: 'UA',
    online: true,
    suspect: null,
    revokedAt: null,
    belowMinimum: false,
    enrolledByYou: false,
    enrolledByName: null,
    pause: null,
    enroller: 'recorded',
    canWiden: true,
    unattributedProjects: 0,
    ...overrides,
  };
}

/** An enrolment intent's id in the Worker's ULID shape. */
export const ENROLMENT_INTENT_FIXTURE_ID = '01M6YSNJ00000000000000N001';

/**
 * An intent as `GET …/enrolment-intents/:intent` answers it (#634 PR 4), `bound` by a Mac by default; `pending()` and
 * the other states are overrides.
 */
export function enrolmentIntentFixture(overrides: Partial<EnrolmentIntentDto> = {}): EnrolmentIntentDto {
  return {
    id: ENROLMENT_INTENT_FIXTURE_ID,
    state: 'bound',
    name: 'Mac',
    projectScope: 'all',
    allowedProjects: [],
    isolation: 'user',
    createdAt: '2026-11-11T10:00:00.000Z',
    expiresAt: '2026-11-11T10:10:00.000Z',
    host: { os: 'darwin', arch: 'arm64', hostname: 'Kirills-MacBook-Pro.local' },
    version: '0.3.0',
    fingerprint: '7K2Q-M9XD',
    boundAt: '2026-11-11T10:02:00.000Z',
    boundCountry: 'DE',
    runnerId: null,
    ...overrides,
  };
}

/** The same intent before any machine bound it. */
export function pendingIntentFixture(overrides: Partial<EnrolmentIntentDto> = {}): EnrolmentIntentDto {
  return enrolmentIntentFixture({
    state: 'pending',
    host: null,
    version: null,
    fingerprint: null,
    boundAt: null,
    boundCountry: null,
    ...overrides,
  });
}
