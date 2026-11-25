/**
 * `target` is a pid, or a process group as `-pgid`; `pid` (always positive) is the child whose liveness decides a
 * `EPERM`. ESRCH (already gone) is what stopping wants. macOS can answer EPERM instead of ESRCH for a process group
 * whose leader already exited (#846): the race between `stop()`'s own exit check and the signal landing. `pid` is
 * re-probed with signal 0 at the moment of the error, so only an EPERM for a process still alive is surfaced —
 * never swallowed silently.
 */
export function signal(target: number, name: NodeJS.Signals, pid: number): void {
  try {
    process.kill(target, name);
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error)) {
      throw error;
    }
    if (error.code === 'ESRCH') {
      return;
    }
    if (error.code === 'EPERM' && !isAlive(pid)) {
      return;
    }
    throw error;
  }
}

/** Whether `pid` still exists, probed with signal 0 (sends nothing). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}
