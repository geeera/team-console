import { rmSync } from 'node:fs';
import { SERVERS_DIR, STACKS_DIR, WORKSPACE_ROOT } from './local-stack';
import { realDirectoriesBelow } from './private-directory';
import { stopStaleServers, type StopStaleOptions } from './stale-servers';

export interface EarlierRun {
  /** The checkout: trusted, the directories below it are checked. */
  readonly root: string;
  readonly stacksDir: string;
  readonly serversDir: string;
}

/**
 * Stops the servers an earlier run left on this run's ports (#982), then clears its stacks: the records die with the
 * directory. Every directory from `root` down to `stacksDir` is checked first (#1019), so with a link on the way
 * nothing is read or removed behind it and the old state stays as it was.
 */
export async function clearEarlierRun(run: EarlierRun, options: StopStaleOptions = {}): Promise<string[]> {
  realDirectoriesBelow(run.root, run.stacksDir);
  const stale = await stopStaleServers(run.serversDir, options);
  rmSync(run.stacksDir, { recursive: true, force: true });
  return stale;
}

/**
 * Stacks are named by Playwright worker (`worker-<workerIndex>`), so a run leaves one directory per worker it started,
 * including those restarted after a failure. Clearing them once per run keeps the CI artifact to this run's stacks.
 */
export default async function globalSetup(): Promise<void> {
  const stale = await clearEarlierRun({
    root: WORKSPACE_ROOT,
    stacksDir: STACKS_DIR,
    serversDir: SERVERS_DIR,
  });
  if (stale.length > 0) {
    process.stderr.write(`console-e2e: stopped servers an earlier run left behind: ${stale.join(', ')}\n`);
  }
}
