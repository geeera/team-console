import type { OrchestrationStatus } from '@console/entities/orchestration';
import { ORCHESTRATE_MAX_STEPS, type OrchestrationDto, type RunnerAvailability } from '@shared/contracts';

/** What the one button does now: Start with no run, Stop while a run is on (running, waiting for the owner, stopping). */
export type ControlsAction = 'start' | 'stop';

export interface ControlsInput {
  readonly status: OrchestrationStatus;
  readonly run: OrchestrationDto | null;
  /** The jobs list's `runnerAvailability` (#775); `null` while unknown, which never blocks Start (#812). */
  readonly availability: RunnerAvailability | null;
  /** A Start or Stop is on its way. */
  readonly isPending: boolean;
}

export interface ControlsView {
  readonly action: ControlsAction;
  /** Shows the spinner: the first read or a command is on its way. */
  readonly isBusy: boolean;
  /** The press does nothing; `reasonKey`, when set, is the visible reason the button points at. */
  readonly isOff: boolean;
  readonly reasonKey: string | null;
  /** The line above the button: where the run stands. */
  readonly stateKey: string;
  readonly stateParams: Readonly<Record<string, string>>;
}

const STATE_KEYS: Readonly<Record<OrchestrationDto['state'], string>> = {
  idle: 'orchestration.state.idle',
  running: 'orchestration.state.running',
  'waiting-owner': 'orchestration.state.waitingOwner',
  stopping: 'orchestration.state.stopping',
};

/**
 * The controls' state (#1042), pure so every branch is a table row in the spec. A failed read with no run shows
 * Start: if a run is on after all, the Worker answers `orchestration-active` and the line says so. Only Start is held
 * back for «no runner» — Stop is server-side and must work whatever the runners do. `stopping` (slice 2) waits.
 */
export function controlsViewOf(input: ControlsInput): ControlsView {
  const { status, run, availability, isPending } = input;
  const isLoading = status === 'idle' || status === 'loading';
  const action: ControlsAction = run !== null && run.state !== 'idle' ? 'stop' : 'start';
  const params = { steps: String(run?.steps ?? 0), max: String(ORCHESTRATE_MAX_STEPS) };
  const stateKey = isLoading
    ? 'orchestration.state.loading'
    : run === null
      ? 'orchestration.state.unknown'
      : STATE_KEYS[run.state];
  const hasNoRunner = action === 'start' && availability === 'none';
  const isStopping = run?.state === 'stopping';
  return {
    action,
    isBusy: isLoading || isPending,
    isOff: isLoading || isPending || hasNoRunner || isStopping,
    reasonKey: hasNoRunner ? 'orchestration.reason.noRunner' : null,
    stateKey,
    stateParams: params,
  };
}
