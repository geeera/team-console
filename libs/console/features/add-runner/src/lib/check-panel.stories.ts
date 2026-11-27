import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import type { RunnerPlatform } from './add-runner.model';
import type { CheckView } from './check-panel.model';
import { AddRunnerCheckPanel } from './steps/check-panel';

/** «Проверка раннера» on step 4b (#1059 PR 3, UX §12.4): C0–C9, each C5 reason on Mac and Linux, C9 with a time. */
const meta: Meta = {
  title: 'Features/Add runner/Runner check',
  decorators: [moduleMetadata({ imports: [AddRunnerCheckPanel] })],
};

export default meta;
type Story = StoryObj;

interface PanelArgs {
  readonly view: CheckView;
  readonly platform?: RunnerPlatform;
  readonly browserOnline?: boolean;
  readonly retryReady?: boolean;
  readonly queuedSlow?: boolean;
  readonly canStart?: boolean;
}

const panel = ({
  view,
  platform = 'mac',
  browserOnline = true,
  retryReady = true,
  queuedSlow = false,
  canStart = true,
}: PanelArgs): Story => ({
  render: () => ({
    props: { view, platform, browserOnline, retryReady, queuedSlow, canStart },
    template: `<div style="max-width: var(--sheet-dialog-w)">
      <tc-add-runner-check-panel [view]="view" [platform]="platform" [browserOnline]="browserOnline"
        [retryReady]="retryReady" [queuedSlow]="queuedSlow" [canStart]="canStart" />
    </div>`,
  }),
});

/** C0: not started (the automatic start was not made). */
export const C0Idle = panel({ view: { kind: 'idle' } });
/** C0 offline: «Проверить» is `aria-disabled` with «Нет сети». */
export const C0Offline = panel({ view: { kind: 'idle' }, browserOnline: false });
/** C0 for a caller who may not start a check (a 403 mid-flow): no button. */
export const C0NoPermission = panel({ view: { kind: 'idle' }, canStart: false });
/** C1: the POST is in flight. */
export const C1Starting = panel({ view: { kind: 'starting' } });
/** C2: queued, the first 30 s. */
export const C2Queued = panel({ view: { kind: 'queued', slow: false } });
/** C2 after 30 s in queued. */
export const C2QueuedSlow = panel({ view: { kind: 'queued', slow: true }, queuedSlow: true });
/** C3: running on the runner. */
export const C3Running = panel({ view: { kind: 'running' } });
/** C4 on a Mac: what was found, never «вход проверен». */
export const C4PassedMac = panel({ view: { kind: 'passed', version: '2.1.4' } });
/** C4 on Linux. */
export const C4PassedLinux = panel({ view: { kind: 'passed', version: '2.1.4' }, platform: 'linux' });
/** C4 with a hostile version: shown as text inside `<bdi>`, no element. */
export const C4PassedHostileVersion = panel({
  view: { kind: 'passed', version: '<img src=x onerror=alert(1)>' },
});
/** C5a: the start found the runner offline. */
export const C5aOffline = panel({ view: { kind: 'offline', cause: 'offline' } });
/** C5a: never picked up in 150 s (also a runner downgraded after declaring). */
export const C5aNotPickedUpMac = panel({ view: { kind: 'offline', cause: 'notPickedUp' } });
export const C5aNotPickedUpLinux = panel({
  view: { kind: 'offline', cause: 'notPickedUp' },
  platform: 'linux',
});
/** C5a: picked up, no result. */
export const C5aLost = panel({ view: { kind: 'offline', cause: 'lost' } });
/** C5b on a Mac: install Claude Code, then repeat the setup step. */
export const C5bClaudeNotConfiguredMac = panel({ view: { kind: 'claude', cause: 'notConfigured' } });
export const C5bClaudeNotExecutableMac = panel({ view: { kind: 'claude', cause: 'notExecutable' } });
export const C5bClaudeFailedMac = panel({ view: { kind: 'claude', cause: 'failed' } });
export const C5bClaudeUnrecognisedMac = panel({ view: { kind: 'claude', cause: 'unrecognised' } });
/** C5b on Linux: the runbook, not a command. */
export const C5bClaudeNotExecutableLinux = panel({
  view: { kind: 'claude', cause: 'notExecutable' },
  platform: 'linux',
});
/** C5c on a Mac: the setup line for the sign-in. */
export const C5cCredentialMissingMac = panel({ view: { kind: 'credential', cause: 'missing' } });
/** C5c on a Mac, a saved sign-in that is unreadable or not allowed: the same line with `--replace-credential`. */
export const C5cCredentialUnreadableMac = panel({ view: { kind: 'credential', cause: 'unreadable' } });
export const C5cCredentialNotAllowedMac = panel({ view: { kind: 'credential', cause: 'notAllowed' } });
/** C5c on Linux: the API key and the `--replace-credential` line. */
export const C5cCredentialMissingLinux = panel({
  view: { kind: 'credential', cause: 'missing' },
  platform: 'linux',
});
export const C5cCredentialUnreadableLinux = panel({
  view: { kind: 'credential', cause: 'unreadable' },
  platform: 'linux',
});
export const C5cCredentialNotAllowedLinux = panel({
  view: { kind: 'credential', cause: 'notAllowed' },
  platform: 'linux',
});
/** C5d: Claude did not answer in 30 s. */
export const C5dTimeout = panel({ view: { kind: 'timeout' } });
/** C5e on a Mac and on Linux. */
export const C5eHostMac = panel({ view: { kind: 'host' } });
export const C5eHostLinux = panel({ view: { kind: 'host' }, platform: 'linux' });
/** A reason code this console does not know: the generic state. */
export const UnknownReason = panel({ view: { kind: 'unknown' } });
/** C6: four minutes without a final state. */
export const C6GaveUp = panel({ view: { kind: 'gaveUp' } });
/** C7: paused, revoked (no button), unsupported (no button). */
export const C7Paused = panel({ view: { kind: 'paused' } });
export const C7Revoked = panel({ view: { kind: 'revoked' } });
export const C7Unsupported = panel({ view: { kind: 'unsupported' } });
/** C8: an outdated runner, neutral, with «Как обновить». */
export const C8Outdated = panel({ view: { kind: 'outdated' } });
/** C9: rate-limited until 14:05; the button re-enables itself then. */
export const C9RateLimited = panel({
  view: { kind: 'rateLimited', until: Date.parse('2026-11-27T14:05:00') },
  retryReady: false,
});
