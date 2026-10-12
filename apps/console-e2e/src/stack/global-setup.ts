import { rmSync } from 'node:fs';
import { STACKS_DIR } from './local-stack';

/**
 * Stacks are named by Playwright worker (`worker-<workerIndex>`), so a run leaves one directory per worker it started,
 * including those restarted after a failure. Clearing them once per run keeps the CI artifact to this run's stacks.
 */
export default function globalSetup(): void {
  rmSync(STACKS_DIR, { recursive: true, force: true });
}
