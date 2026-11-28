import type { OrchestrationDto } from '@shared/contracts';

/** Ids that pass `isUlid`, for specs and stories. */
export const ORCHESTRATION_FIXTURE_IDS = {
  run: '01M6YSNJ00000000000000R001',
  step: '01M6YSNJ00000000000000S001',
} as const;

/** No run: what Stop answers and what a project that never started one reads. */
export function idleOrchestrationFixture(): OrchestrationDto {
  return {
    runId: null,
    steps: 0,
    state: 'idle',
    liveStepId: null,
    children: { queued: 0, running: 0, finished: 0, failed: 0 },
  };
}

/** A run on its first step, as Start answers it; `overrides` for the other states. */
export function runningOrchestrationFixture(overrides: Partial<OrchestrationDto> = {}): OrchestrationDto {
  return {
    runId: ORCHESTRATION_FIXTURE_IDS.run,
    steps: 1,
    state: 'running',
    liveStepId: ORCHESTRATION_FIXTURE_IDS.step,
    children: { queued: 0, running: 0, finished: 0, failed: 0 },
    ...overrides,
  };
}
