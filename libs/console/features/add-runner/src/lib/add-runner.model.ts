import {
  RELEASE_HOST,
  RELEASE_REPOSITORY,
  RUNNER_INSTALLED_LAUNCHER,
  type EnrolmentIntentDto,
  type RunnerProjectScope,
} from '@shared/contracts';

/** Where the runner is going to work: a Mac takes the intent path, Linux hands over to the code dialog (decision 1). */
export type RunnerPlatform = 'mac' | 'linux';

/** The four steps of the sheet (spec §0.3); the end states belong to the step they ended on. */
export type WizardStep = 'params' | 'command' | 'confirm' | 'online';
export const WIZARD_STEPS: readonly WizardStep[] = ['params', 'command', 'confirm', 'online'];

/** Why a request ended without a runner: each offers «Новая команда». */
export type WizardEnd = 'expired' | 'withdrawn' | 'rejected';

/** Owner decision 4: the Claude sign-in sits between the approval and the first signal. */
export const SLOW_AFTER_MS = 5 * 60_000;
/** The countdown is a display: it moves once a minute and is never a live region. */
export const COUNTDOWN_TICK_MS = 60_000;

/** What the sheet closes with, for the page to act on (the wizard never imports another feature). */
export type AddRunnerOutcome =
  | { readonly kind: 'closed'; readonly enrolled: boolean }
  | {
      readonly kind: 'code';
      readonly name: string;
      readonly projectScope: RunnerProjectScope;
      readonly allowedProjects: readonly string[];
    }
  | { readonly kind: 'pick-projects'; readonly runnerId: string };

/** The runbook a customer can read (this repository is public), at the branch production ships from. */
const RUNBOOK = `https://${RELEASE_HOST}/${RELEASE_REPOSITORY}/blob/main/docs/runbooks/runner.md`;
export const RUNBOOK_INSTALL_URL = `${RUNBOOK}#get-a-release-and-verify-it-both-backends`;
export const RUNBOOK_UPDATE_URL = `${RUNBOOK}#update-decision-10-rr13`;

export const SELF_CHECK_COMMAND = `sudo ${RUNNER_INSTALLED_LAUNCHER} self-check`;
export const RUNNER_LOG_PATH = '/Users/_tcrunner/logs/runner.log';

/** «7K2Q-M9XD» as a screen reader should compare it: «7 K 2 Q, дефис, M 9 X D». */
export function fingerprintSpokenOf(fingerprint: string, dashWord: string): string {
  return fingerprint
    .split('-')
    .map((half) => half.split('').join(' '))
    .join(`, ${dashWord}, `);
}

/** «Германия (DE)» in the UI language; `null` when the edge named no country or the name is unknown. */
export function countryLabelOf(code: string | null, lang: string): string | null {
  if (code === null) {
    return null;
  }
  try {
    const name = new Intl.DisplayNames([lang], { type: 'region' }).of(code);
    return name === undefined || name === code ? code : `${name} (${code})`;
  } catch {
    // A runtime without DisplayNames still shows the code the edge gave.
    return code;
  }
}

/** Whole minutes left, rounded up, never below zero. */
export function minutesLeftOf(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 60_000));
}

/** Whether the intent asks for a decision: a bound machine, still within its ten minutes. */
export function isAwaitingApproval(intent: EnrolmentIntentDto | null): intent is EnrolmentIntentDto & {
  readonly fingerprint: string;
} {
  return intent !== null && intent.state === 'bound' && intent.fingerprint !== null;
}
