import type { RunnerWorkflowPins } from './render';

/**
 * The version pins of a runner workflow file the console did not render: the one on a repository's default branch,
 * before a bump PR replaces it (#759 PR 4; security note row "RUNNER_VERSION bump points customers at a tampered or
 * older runner"). The file is the customer's, so it is never parsed as YAML here and nothing but digits and dots is
 * taken from it: a pin is read only when its `NAME: x.y.z` line occurs exactly once, else it is `null`.
 */

export type RunnerWorkflowPin = keyof RunnerWorkflowPins;

export const RUNNER_WORKFLOW_PIN_NAMES: Readonly<Record<RunnerWorkflowPin, string>> = Object.freeze({
  runner: 'RUNNER_VERSION',
  node: 'NODE_VERSION',
  claudeCode: 'CLAUDE_CODE_VERSION',
});

export const RUNNER_WORKFLOW_PINS: readonly RunnerWorkflowPin[] = ['runner', 'node', 'claudeCode'];

export type ReadRunnerWorkflowPins = { readonly [K in RunnerWorkflowPin]: string | null };

/** The workflow is a few kilobytes; a longer text is not read at all. */
const MAX_LENGTH = 64 * 1024;

function pinLineOf(name: string): RegExp {
  // Each part of a version is at most 5 digits, so the match is bounded whatever the file holds.
  return new RegExp(`^[ \\t]+${name}:[ \\t]*(['"]?)(\\d{1,5}\\.\\d{1,5}\\.\\d{1,5})\\1[ \\t]*$`, 'gm');
}

export function readRunnerWorkflowPins(text: string): ReadRunnerWorkflowPins {
  const read = (pin: RunnerWorkflowPin): string | null => {
    if (text.length > MAX_LENGTH) {
      return null;
    }
    const matches = [...text.matchAll(pinLineOf(RUNNER_WORKFLOW_PIN_NAMES[pin]))];
    return matches.length === 1 ? (matches[0]?.[2] ?? null) : null;
  };
  return { runner: read('runner'), node: read('node'), claudeCode: read('claudeCode') };
}

/** -1, 0 or 1 as `left` is lower than, equal to or higher than `right`; both are `x.y.z` of digits. */
export function compareVersions(left: string, right: string): number {
  const parts = (version: string): number[] => version.split('.').map((part) => Number(part));
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The pins a bump would lower: those the current file names with a higher version than the console's rendering.
 * A pin the current file does not name (`null`) cannot be compared and is not listed.
 */
export function loweredPinsOf(current: ReadRunnerWorkflowPins, next: RunnerWorkflowPins): RunnerWorkflowPin[] {
  return RUNNER_WORKFLOW_PINS.filter((pin) => {
    const now = current[pin];
    return now !== null && compareVersions(next[pin], now) < 0;
  });
}
