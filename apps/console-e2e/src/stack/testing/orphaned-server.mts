/**
 * Stands in for an orphaned `serve-worker.mts` in `orphan-watch.integration.spec.ts`: it forks an idle process into its
 * own group (its "workerd"), names it on stdout, and ends through the real `stopOrphaned` with a `dispose` that
 * stops the fork, fails, or never settles — as the first argument says.
 */
import { spawn } from 'node:child_process';
import { stopOrphaned } from '../orphan-watch.mts';

/** The fork ends by itself after this long, so a failed test leaves nothing behind. */
const FORK_LIFETIME_MS = 30_000;
const DEADLINE_MS = 200;

const mode = process.argv[2];
const fork = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${FORK_LIFETIME_MS})`], {
  stdio: 'ignore',
});

function dispose(): Promise<void> {
  if (mode === 'hangs') {
    return new Promise<void>(() => undefined);
  }
  if (mode === 'fails') {
    return Promise.reject(new Error('workerd refused'));
  }
  return new Promise<void>((stopped) => {
    fork.once('exit', () => stopped());
    fork.kill('SIGKILL');
  });
}

fork.once('error', (error) => {
  process.stderr.write(`orphaned-server: ${error.message}\n`);
  process.exit(2);
});
fork.once('spawn', () => {
  process.stdout.write(`fork pid=${fork.pid}\n`);
  void stopOrphaned(dispose, DEADLINE_MS);
});
