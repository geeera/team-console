export interface OrphanWatchOptions {
  /** The parent at start; a different one later means the first is gone. */
  readonly parentPid?: number | undefined;
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

/** The variable `local-stack.ts` names its own pid in, for the server it starts. */
export const STACK_PARENT_PID = 'STACK_PARENT_PID';

/**
 * The pid in `raw`, or `undefined` for anything that is not one. A server whose parent is killed while the server
 * is still loading already sees the re-parented pid in `process.ppid`, and would watch that one for ever (#993);
 * the pid the parent wrote down itself has no such gap.
 */
export function parentPidFrom(raw: string | undefined): number | undefined {
  return raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : undefined;
}

export type StopOutcome =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'timed-out'; readonly afterMs: number };

/**
 * Runs `stop` and answers how it ended, at the latest after `deadlineMs` (#993). An orphaned server has nobody left
 * to kill it, so a `dispose()` that never settles would keep it — and its port — for good. Never rejects: the caller
 * exits whatever the outcome.
 */
export async function stopWithin(stop: () => Promise<unknown>, deadlineMs: number): Promise<StopOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<StopOutcome>((late) => {
    timer = setTimeout(() => late({ kind: 'timed-out', afterMs: deadlineMs }), deadlineMs);
  });
  const stopping = (async (): Promise<StopOutcome> => {
    try {
      await stop();
      return { kind: 'stopped' };
    } catch (error: unknown) {
      return { kind: 'failed', error };
    }
  })();
  try {
    return await Promise.race([stopping, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
