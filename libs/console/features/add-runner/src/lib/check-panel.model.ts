import { UNKNOWN_CHECK_REASON, type RunnerCheck, type RunnerCheckOutcome } from '@console/entities/runner';
import type { RunnerCheckReason } from '@shared/contracts';
import type { RunnerPlatform } from './add-runner.model';

/**
 * What the «Проверка раннера» panel shows (#1059 PR 3, UX §12.4, C0–C9). Built from a check, a start's refusal or
 * the watch; never from a code on the wire, so an unknown code can only ever be `unknown`.
 */
export type CheckView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'queued'; readonly slow: boolean }
  | { readonly kind: 'running' }
  | { readonly kind: 'passed'; readonly version: string | null }
  | { readonly kind: 'offline'; readonly cause: 'offline' | 'notPickedUp' | 'lost' }
  | {
      readonly kind: 'claude';
      readonly cause: 'notConfigured' | 'notExecutable' | 'failed' | 'unrecognised';
    }
  | { readonly kind: 'credential'; readonly cause: 'missing' | 'unreadable' | 'notAllowed' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'host' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'gaveUp' }
  | { readonly kind: 'paused' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'outdated' }
  | { readonly kind: 'rateLimited'; readonly until: number };

export type CheckViewKind = CheckView['kind'];

/** C2's sub-line turns to «пока не взял» after this long in `queued` (pickup can take up to 150 s). */
export const CHECK_QUEUED_SLOW_MS = 30_000;
/**
 * N8: the automatic start's one silent retry of a `runner-outdated`, in case the runner's declaration had not been
 * stored yet when it came on line.
 */
export const CHECK_OUTDATED_RETRY_MS = 10_000;

type ReasonView = Exclude<CheckView, { readonly kind: 'rateLimited' }>;

/** Every reason the console knows maps to a state (§12.9); `rate-limited` needs its time and is the caller's. */
const REASON_VIEWS: Readonly<Record<Exclude<RunnerCheckReason, 'rate-limited'>, ReasonView>> = {
  'runner-offline': { kind: 'offline', cause: 'offline' },
  'not-picked-up': { kind: 'offline', cause: 'notPickedUp' },
  lost: { kind: 'offline', cause: 'lost' },
  'claude-not-configured': { kind: 'claude', cause: 'notConfigured' },
  'claude-not-executable': { kind: 'claude', cause: 'notExecutable' },
  'claude-failed': { kind: 'claude', cause: 'failed' },
  'claude-output-unrecognised': { kind: 'claude', cause: 'unrecognised' },
  'credential-missing': { kind: 'credential', cause: 'missing' },
  'credential-unreadable': { kind: 'credential', cause: 'unreadable' },
  'credential-not-allowed': { kind: 'credential', cause: 'notAllowed' },
  timeout: { kind: 'timeout' },
  'host-not-ready': { kind: 'host' },
  'runner-paused': { kind: 'paused' },
  'runner-revoked': { kind: 'revoked' },
  'runner-check-unsupported': { kind: 'unsupported' },
  'runner-outdated': { kind: 'outdated' },
};

export function checkViewOfReason(
  reason: Exclude<RunnerCheckReason, 'rate-limited'> | RunnerCheckOutcome,
): ReasonView {
  return reason === UNKNOWN_CHECK_REASON ? { kind: 'unknown' } : REASON_VIEWS[reason];
}

/** A refusal slug of `POST …/checks` as a state, or `null` when it is none of the start's own refusals. */
export function checkViewOfRefusal(slug: string | null): ReasonView | null {
  switch (slug) {
    case 'runner-offline':
    case 'runner-outdated':
    case 'runner-paused':
    case 'runner-revoked':
    case 'runner-check-unsupported':
      return REASON_VIEWS[slug];
    default:
      return null;
  }
}

export function checkViewOf(check: RunnerCheck, queuedSlow: boolean): CheckView {
  switch (check.state) {
    case 'queued':
      return { kind: 'queued', slow: queuedSlow };
    case 'running':
      return { kind: 'running' };
    case 'passed':
      return { kind: 'passed', version: check.claudeVersion };
    case 'failed':
      return checkViewOfReason(check.reason ?? UNKNOWN_CHECK_REASON);
  }
}

/** C1–C3: a check in flight; the panel is `aria-busy` and the button reads «Проверяем…». */
export function isCheckInFlight(view: CheckView): boolean {
  return view.kind === 'starting' || view.kind === 'queued' || view.kind === 'running';
}

/** C7 revoked, C7 unsupported and C8 offer no «Проверить снова»: pressing it could not change the answer. */
export function offersCheckRetry(view: CheckView): boolean {
  return view.kind !== 'revoked' && view.kind !== 'unsupported' && view.kind !== 'outdated';
}

/** The state's title key (§12.6), for the panel and for `check.live.failed`. */
export function checkTitleKeyOf(view: CheckView, platform: RunnerPlatform): string {
  const prefix = 'runners.wizard.check.';
  switch (view.kind) {
    case 'idle':
      return `${prefix}idle`;
    case 'starting':
      return `${prefix}starting`;
    case 'queued':
      return `${prefix}queued`;
    case 'running':
      return `${prefix}running`;
    case 'credential':
      return `${prefix}credential.${platform === 'linux' ? 'titleLinux' : 'titleMac'}`;
    case 'unknown':
      // §12.4: the generic state reads as «Машина не готова» with its own body.
      return `${prefix}host.title`;
    case 'rateLimited':
      // C9 is its message alone, with the time it ends (`{{time}}`).
      return `${prefix}rateLimited`;
    default:
      return `${prefix}${view.kind}.title`;
  }
}

/** The tone of the state's callout (§12.4 «Severity and tone»): never `danger`. */
export function checkToneOf(view: CheckView): 'neutral' | 'success' | 'warning' | null {
  switch (view.kind) {
    case 'idle':
    case 'starting':
    case 'queued':
    case 'running':
      return null;
    case 'passed':
      return 'success';
    // Nothing the owner did wrong and nothing that affects jobs: C7 paused, C7 unsupported, C8.
    case 'paused':
    case 'unsupported':
    case 'outdated':
      return 'neutral';
    default:
      return 'warning';
  }
}
