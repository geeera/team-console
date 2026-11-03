import type { MapResult } from './map-event';

/** The project's snooze at the delivery's time (`isSnoozedAt` of `@worker/db`) and whether urgent ones pass. */
export interface SnoozeState {
  readonly isSnoozed: boolean;
  readonly allowsUrgent: boolean;
}

const SNOOZED: MapResult = { kind: 'ignored', reason: 'snoozed' };

/**
 * The snooze gate after `mapEvent` (#221, architect note on #29 §5): a snoozed project's push is dropped unless it
 * is urgent and urgent ones are allowed. Pure; an expired snooze arrives here as `isSnoozed: false`.
 */
export function applySnooze(result: MapResult, snooze: SnoozeState): MapResult {
  if (result.kind !== 'push' || !snooze.isSnoozed) {
    return result;
  }
  return result.urgent && snooze.allowsUrgent ? result : SNOOZED;
}
