export interface OrphanWatchOptions {
  /** The parent at start; a different one later means the first is gone. */
  readonly parentPid?: number;
  readonly currentParentPid?: () => number;
  readonly intervalMs?: number;
}

/**
 * Calls `stop` once when the process that started this one is gone (#982). A stack server leads its own process
 * group, so a Playwright worker killed with SIGKILL — which runs no teardown — used to leave it serving on the
 * worker's ports. The system re-parents an orphan, so a changed parent pid is the signal. Returns the cancel.
 */
export function onOrphaned(stop: () => void, options: OrphanWatchOptions = {}): () => void {
  const currentParentPid = options.currentParentPid ?? (() => process.ppid);
  const parentPid = options.parentPid ?? currentParentPid();
  const timer = setInterval(() => {
    if (currentParentPid() !== parentPid) {
      clearInterval(timer);
      stop();
    }
  }, options.intervalMs ?? 1_000);
  return () => clearInterval(timer);
}
