import { runnerReleaseChannelOf } from '@shared/contracts';
import type { UpdatePolicy } from '../config/config';
import { UpdateError, applyUpdate, checkForUpdate, type ApplyDeps, type CheckDeps } from './update';

/**
 * `update.policy = auto` (ADR 0008 decision 10): the runner looks for a release when it starts and, while idle, at
 * most every `AUTO_UPDATE_INTERVAL_MS`; a verified one is installed and the runner exits so its service (KeepAlive /
 * `Restart=always`) starts the new binary. A refusal or a failure is logged and the runner keeps running the version
 * it has: an update never stops jobs. `notify` and `off` make no request here: Settings › Runners already shows the
 * release and `belowMinimum`, and the operator runs `update`. Auto stays on the installed version's channel: a runner
 * on a stable release never moves onto a pre-release by itself (#604); `update` by hand still may.
 */

export const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface AutoUpdateDeps {
  readonly policy: UpdatePolicy;
  readonly check: Omit<CheckDeps, 'policy'>;
  readonly apply: ApplyDeps;
  readonly now: () => Date;
  readonly log: (line: string) => void;
}

/** Returns a function the loop calls when idle; it resolves `true` once a new version is installed. */
export function autoUpdater(deps: AutoUpdateDeps): () => Promise<boolean> {
  let lastCheck: number | null = null;
  return async () => {
    if (deps.policy !== 'auto') {
      return false;
    }
    const now = deps.now().getTime();
    if (lastCheck !== null && now - lastCheck < AUTO_UPDATE_INTERVAL_MS) {
      return false;
    }
    lastCheck = now;
    try {
      const check = await checkForUpdate({ ...deps.check, policy: deps.policy });
      if (check.kind !== 'available') {
        return false;
      }
      if (runnerReleaseChannelOf(check.current) === 'stable' && runnerReleaseChannelOf(check.target) !== 'stable') {
        throw new UpdateError(
          'channel-mismatch',
          `the console names the pre-release ${check.target} and this runner is on the stable channel (${check.current}); run \`update\` to install it by hand`,
        );
      }
      await applyUpdate(check.target, deps.apply);
      deps.log(`updated ${check.current} → ${check.target}; exiting so the service starts the new version`);
      return true;
    } catch (error: unknown) {
      if (!(error instanceof Error)) {
        throw error;
      }
      // Logged, then the current version keeps claiming; the next interval tries again.
      deps.log(`auto-update skipped: ${error.message}`);
      return false;
    }
  };
}
