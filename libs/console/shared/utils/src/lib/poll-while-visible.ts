/** While something the view shows is live, it is read this often (#464: a runner polls the queue about every minute). */
export const LIVE_POLL_MS = 10_000;
/** With nothing live, a read a minute is enough to notice a change made elsewhere. */
export const IDLE_POLL_MS = 60_000;

/**
 * Runs `tick` now, then again `delayMs()` after each run ends, only while `document` is visible: a hidden page drops
 * its timer, and coming back runs `tick` at once. `delayMs` is asked after every run, so the cadence follows what
 * the last read found. The returned function stops it; a `tick` still running finishes but schedules nothing.
 * `tick` must not reject: a failed read is the caller's state to keep, not the poller's.
 */
export function pollWhileVisible(
  document: Document,
  tick: () => Promise<void>,
  delayMs: () => number,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let isStopped = false;
  let isVisibilityRunInFlight = false;
  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const schedule = (): void => {
    clear();
    if (isStopped || document.visibilityState !== 'visible') {
      return;
    }
    timer = setTimeout(() => void run(), delayMs());
  };
  const run = async (): Promise<void> => {
    await tick();
    schedule();
  };
  const onVisibility = (): void => {
    if (document.visibilityState !== 'visible') {
      clear();
      return;
    }
    // A tab can fire several visibilitychange events in a row (an alt-tab bounce); one run answers them all.
    if (isVisibilityRunInFlight) {
      return;
    }
    isVisibilityRunInFlight = true;
    void run().finally(() => {
      isVisibilityRunInFlight = false;
    });
  };
  document.addEventListener('visibilitychange', onVisibility);
  void run();
  return () => {
    isStopped = true;
    clear();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
