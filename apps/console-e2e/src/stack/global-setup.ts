import { rmSync } from 'node:fs';
import { SERVERS_DIR, STACKS_DIR } from './local-stack';
import { stopStaleServers } from './stale-servers';

/**
 * Stacks are named by Playwright worker (`worker-<workerIndex>`), so a run leaves one directory per worker it started,
 * including those restarted after a failure. Clearing them once per run keeps the CI artifact to this run's stacks.
 * Before that, the servers a killed run left on this run's ports are stopped (#982): the records die with the
 * directory.
 */
export default async function globalSetup(): Promise<void> {
  const stale = await stopStaleServers(SERVERS_DIR);
  if (stale.length > 0) {
    process.stderr.write(`console-e2e: stopped servers an earlier run left behind: ${stale.join(', ')}\n`);
  }
  rmSync(STACKS_DIR, { recursive: true, force: true });
}
