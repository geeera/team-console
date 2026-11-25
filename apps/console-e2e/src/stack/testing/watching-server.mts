/**
 * Stands in for `serve-worker.mts` in `orphan-watch.integration.spec.ts`: the same watch, wired the same way to
 * `STACK_PARENT_PID`. It begins watching when a line arrives on stdin or stdin ends, so the test decides whether the
 * starter is still alive at that moment — Node ends the stdin of a child only once that child has exited — and
 * reports what it saw on stdout.
 */
import { onOrphaned, parentPidFrom, STACK_PARENT_PID } from '../orphan-watch.mts';

/** Ends a server whose test never came to orphan it; far beyond anything a passing run needs. */
const GIVE_UP_MS = 30_000;

const giveUp = setTimeout(() => {
  process.stdout.write('server gave up\n');
  process.exit(3);
}, GIVE_UP_MS);

let watching = false;

function watch(): void {
  if (watching) {
    return;
  }
  watching = true;
  const parentPid = parentPidFrom(process.env[STACK_PARENT_PID]);
  process.stdout.write(`server watching starter=${parentPid ?? 'none'} ppid=${process.ppid}\n`);
  onOrphaned(
    () => {
      clearTimeout(giveUp);
      process.stdout.write('server orphaned\n');
      process.exit(0);
    },
    { parentPid, intervalMs: 20 },
  );
}

process.stdin.once('data', watch);
process.stdin.once('end', watch);
