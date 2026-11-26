import {
  RUNNER_WORKFLOW_PINS,
  type ReadRunnerWorkflowPins,
  type RunnerWorkflowPin,
  type RunnerWorkflowRendering,
} from '@shared/actions-workflow';
import type { ActionsWorkflowPrKind } from '@shared/contracts';

/**
 * What the console writes into a customer repository besides the file: the commit message and the pull request's
 * title and body (#759 PR 4; security note row "Workflow content steered by input"). Every word is a constant of this
 * module; the only values are the version pins (digits and dots, checked on both sides) and the rendering's sha256.
 * No project name, login, request text or `@` ever reaches them, so nothing here can mention or notify anyone.
 */

const FILE = '.github/workflows/team-console-runner.yml';
/** Where the runner's releases and their attestations live; the workflow itself verifies the tarball against it. */
const RUNNER_RELEASES = 'https://github.com/geeera/team-console/releases/tag';

const PIN_LABEL: Readonly<Record<RunnerWorkflowPin, string>> = {
  runner: 'Team Console runner',
  node: 'Node.js',
  claudeCode: 'Claude Code CLI',
};

const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;

function versionOf(value: string | null): string | null {
  return value !== null && VERSION.test(value) ? value : null;
}

function sourceOf(pin: RunnerWorkflowPin, version: string): string {
  switch (pin) {
    case 'runner':
      return `${RUNNER_RELEASES}/v${version}`;
    case 'node':
      return `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
    case 'claudeCode':
      // The scope is percent-encoded so the body holds no `@`.
      return `https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code-linux-x64/${version}`;
  }
}

export function workflowPrTitleOf(kind: ActionsWorkflowPrKind, rendering: RunnerWorkflowRendering): string {
  switch (kind) {
    case 'setup':
      return 'Add the Team Console runner workflow';
    case 'bump':
      return `Update the Team Console runner to ${rendering.pins.runner}`;
    case 'restore':
      return 'Restore the Team Console runner workflow';
  }
}

const INTRO: Readonly<Record<ActionsWorkflowPrKind, string>> = {
  setup: `This pull request adds \`${FILE}\`.`,
  bump: `This pull request updates \`${FILE}\` to the versions Team Console pins now.`,
  restore: `This pull request puts \`${FILE}\` back to the file Team Console renders; the one on this branch differs from it.`,
};

/**
 * `current` is what the file on the default branch pins (`null` per pin when it has none, or for a `setup`); it is the
 * customer's file, so each value is checked as a plain version again before it is printed.
 */
export function workflowPrBodyOf(
  kind: ActionsWorkflowPrKind,
  rendering: RunnerWorkflowRendering,
  current: ReadRunnerWorkflowPins | null,
): string {
  const rows = RUNNER_WORKFLOW_PINS.map((pin) => {
    const next = rendering.pins[pin];
    const before = current === null ? null : versionOf(current[pin]);
    const change = before === null ? next : before === next ? `${next} (unchanged)` : `${before} → ${next}`;
    return `| ${PIN_LABEL[pin]} | ${change} | ${sourceOf(pin, next)} |`;
  });
  return [
    INTRO[kind],
    '',
    'Team Console starts this workflow with `workflow_dispatch` to run one queued job of this project on a ' +
      'GitHub-hosted runner, in the `team-console` Environment. The file was rendered by Team Console and opened as a ' +
      'pull request at the account owner’s request. Team Console never merges it and never writes to the default ' +
      'branch: review the file and merge it yourself.',
    '',
    '| Pinned | Version | Where to check it |',
    '|---|---|---|',
    ...rows,
    '',
    'The workflow verifies the runner tarball with `gh attestation verify` against the release workflow of the runner ' +
      'and its tag, and Node.js and the Claude Code CLI by the checksums in the file.',
    '',
    `sha256 of the file: \`${rendering.sha256}\``,
    '',
    'Merge to let Team Console start this project’s jobs on GitHub Actions.',
    '',
  ].join('\n');
}

export function workflowCommitMessageOf(
  kind: ActionsWorkflowPrKind,
  rendering: RunnerWorkflowRendering,
): string {
  return `${workflowPrTitleOf(kind, rendering)}\n\nsha256 ${rendering.sha256}\n`;
}
