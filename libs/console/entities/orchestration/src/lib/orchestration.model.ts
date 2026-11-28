import type { OrchestrationDto } from '@shared/contracts';

// The DTO and its guard are the contract's (#1039); this slice re-exports them so a screen imports one barrel.
export { isOrchestrationDto, type OrchestrationDto, type OrchestrationState } from '@shared/contracts';

/** A run is on: a step or a child is live or due, it waits for the owner, or (slice 2) it is stopping. */
export function isRunActive(run: OrchestrationDto): boolean {
  return run.state !== 'idle';
}
