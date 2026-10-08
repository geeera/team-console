import { PendingTasks } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SwUpdate, UnrecoverableStateEvent, VersionEvent } from '@angular/service-worker';
import { PAGE_LOCATION } from '@console/shared/api';
import { Sheet } from '@console/shared/ui';
import { Subject } from 'rxjs';
import {
  AppUpdates,
  QUIET_WAIT_MS,
  RECOVERY_GUARD_KEY,
  RECOVERY_GUARD_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_PLATFORM,
  UpdatePlatform,
} from './app-updates';

const READY: VersionEvent = {
  type: 'VERSION_READY',
  currentVersion: { hash: 'a' },
  latestVersion: { hash: 'b' },
};

class FakeSwUpdate {
  isEnabled = true;
  readonly versionUpdates = new Subject<VersionEvent>();
  readonly unrecoverable = new Subject<UnrecoverableStateEvent>();
  /** What the next checks resolve with; a check that finds a version emits VERSION_READY first, as ngsw does. */
  nextCheck: 'none' | 'ready' | 'fail' = 'none';
  readonly checkForUpdate = vi.fn(async (): Promise<boolean> => {
    if (this.nextCheck === 'fail') {
      throw new Error('offline');
    }
    if (this.nextCheck === 'ready') {
      this.versionUpdates.next(READY);
      return true;
    }
    return false;
  });
  readonly activateUpdate = vi.fn(async (): Promise<boolean> => true);
}

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('AppUpdates', () => {
  let sw: FakeSwUpdate;
  let storage: MemoryStorage;
  let platform: UpdatePlatform & {
    reload: ReturnType<typeof vi.fn>;
    clearWorkerCaches: ReturnType<typeof vi.fn>;
    unregisterWorkers: ReturnType<typeof vi.fn>;
  };
  let now: number;
  let assigned: string[];
  let isSheetOpen: boolean;
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    sw = new FakeSwUpdate();
    storage = new MemoryStorage();
    now = 1_000_000;
    assigned = [];
    isSheetOpen = false;
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    platform = {
      clearWorkerCaches: vi.fn(async () => undefined),
      unregisterWorkers: vi.fn(async () => undefined),
      reload: vi.fn(),
      now: () => now,
      storage,
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: SwUpdate, useValue: sw },
        { provide: UPDATE_PLATFORM, useValue: platform },
        { provide: Sheet, useValue: { hasOpen: () => isSheetOpen } },
        {
          provide: PAGE_LOCATION,
          useValue: {
            href: 'https://console.test/p/a/questions#12',
            assign: (url: string) => assigned.push(url),
          },
        },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  function start(): AppUpdates {
    const updates = TestBed.inject(AppUpdates);
    updates.start();
    return updates;
  }

  async function resume(): Promise<void> {
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
  }

  describe('checks', () => {
    it('checks on start and on every return to the foreground, not on hiding', async () => {
      start();
      await flush();
      expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);

      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
      expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);

      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
      expect(sw.checkForUpdate).toHaveBeenCalledTimes(2);
    });

    it('checks on the interval while visible and skips it while hidden', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      start();
      await flush();
      expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
      await flush();
      expect(sw.checkForUpdate).toHaveBeenCalledTimes(2);

      visibility = 'hidden';
      vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
      await flush();
      expect(sw.checkForUpdate).toHaveBeenCalledTimes(2);
    });

    it('does nothing without an enabled service worker', async () => {
      sw.isEnabled = false;
      const updates = start();
      await resume();

      expect(sw.checkForUpdate).not.toHaveBeenCalled();
      expect(updates.ready()).toBe(false);
    });

    it('starts once however often start() is called', async () => {
      const updates = start();
      updates.start();
      await flush();

      expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);
    });

    it('logs a failed check and keeps checking', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      sw.nextCheck = 'fail';
      const updates = start();
      await flush();
      expect(error).toHaveBeenCalledWith('[updates] the start check failed', expect.any(Error));
      expect(updates.ready()).toBe(false);

      sw.nextCheck = 'none';
      await resume();
      expect(sw.checkForUpdate).toHaveBeenCalledTimes(2);
    });
  });

  describe('a version found while the app is in use', () => {
    it('shows the banner and does not reload on its own', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const updates = start();
      await flush();

      sw.nextCheck = 'ready';
      vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
      await flush();

      expect(updates.ready()).toBe(true);
      expect(platform.reload).not.toHaveBeenCalled();
    });

    it('shows the banner for a version the worker found by itself', async () => {
      const updates = start();
      await flush();

      sw.versionUpdates.next(READY);

      expect(updates.ready()).toBe(true);
      expect(platform.reload).not.toHaveBeenCalled();
    });

    it('«Обновить» activates the update and reloads, and hides the banner meanwhile', async () => {
      const updates = start();
      await flush();
      sw.versionUpdates.next(READY);

      const done = updates.activate();
      expect(updates.ready()).toBe(false);
      await done;

      expect(sw.activateUpdate).toHaveBeenCalledTimes(1);
      expect(platform.reload).toHaveBeenCalledTimes(1);
    });

    it('«Обновить» still reloads when activation fails, since a new page gets the new version anyway', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      sw.activateUpdate.mockRejectedValueOnce(new Error('no newer version'));
      const updates = start();
      await flush();

      await updates.activate();

      expect(error).toHaveBeenCalled();
      expect(platform.reload).toHaveBeenCalledTimes(1);
    });

    it('takes the pending update on the next resume when the page is quiet', async () => {
      const updates = start();
      await flush();
      sw.versionUpdates.next(READY);

      await resume();

      expect(sw.activateUpdate).toHaveBeenCalledTimes(1);
      expect(platform.reload).toHaveBeenCalledTimes(1);
      expect(updates.ready()).toBe(false);
    });

    it('keeps the banner on resume while a sheet is open', async () => {
      const updates = start();
      await flush();
      sw.versionUpdates.next(READY);
      isSheetOpen = true;

      await resume();

      expect(platform.reload).not.toHaveBeenCalled();
      expect(updates.ready()).toBe(true);
    });
  });

  describe('a version found on start or resume', () => {
    it('activates at once on start when nothing would be lost, without showing the banner', async () => {
      sw.nextCheck = 'ready';
      const updates = start();
      expect(updates.ready()).toBe(false);
      await flush();

      expect(sw.activateUpdate).toHaveBeenCalledTimes(1);
      expect(platform.reload).toHaveBeenCalledTimes(1);
    });

    it('activates at once on resume when nothing would be lost', async () => {
      start();
      await flush();
      sw.nextCheck = 'ready';

      await resume();

      expect(platform.reload).toHaveBeenCalledTimes(1);
    });

    it('shows the banner instead while a sheet is open', async () => {
      isSheetOpen = true;
      sw.nextCheck = 'ready';
      const updates = start();
      await flush();

      expect(platform.reload).not.toHaveBeenCalled();
      expect(updates.ready()).toBe(true);
    });

    it('shows the banner instead while a field holds typed text', async () => {
      const field = document.createElement('textarea');
      document.body.append(field);
      field.value = 'half a reason';
      sw.nextCheck = 'ready';
      const updates = start();
      await flush();

      expect(platform.reload).not.toHaveBeenCalled();
      expect(updates.ready()).toBe(true);
    });

    it('shows the banner instead while the owner is in a field, even an empty one', async () => {
      const field = document.createElement('input');
      document.body.append(field);
      field.focus();
      sw.nextCheck = 'ready';
      const updates = start();
      await flush();

      expect(platform.reload).not.toHaveBeenCalled();
      expect(updates.ready()).toBe(true);
    });

    it('waits for a request in flight, and shows the banner when it does not settle in time', async () => {
      const removeTask = TestBed.inject(PendingTasks).add();
      sw.nextCheck = 'ready';
      const updates = start();
      await flush();
      expect(platform.reload).not.toHaveBeenCalled();
      expect(updates.ready()).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, QUIET_WAIT_MS + 100));
      expect(platform.reload).not.toHaveBeenCalled();
      expect(updates.ready()).toBe(true);
      removeTask();
    });

    it('activates once a request in flight settles within the wait', async () => {
      const removeTask = TestBed.inject(PendingTasks).add();
      sw.nextCheck = 'ready';
      start();
      await flush();
      expect(platform.reload).not.toHaveBeenCalled();

      removeTask();
      await flush();
      expect(platform.reload).toHaveBeenCalledTimes(1);
    });
  });

  describe('a broken service worker', () => {
    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    it('on unrecoverable: clears the worker caches, unregisters it and loads the page once past it', async () => {
      start();
      await flush();

      sw.unrecoverable.next({ type: 'UNRECOVERABLE_STATE', reason: 'Failed to retrieve hashed resource' });
      await flush();

      expect(platform.clearWorkerCaches).toHaveBeenCalledTimes(1);
      expect(platform.unregisterWorkers).toHaveBeenCalledTimes(1);
      expect(assigned).toEqual(['https://console.test/p/a/questions?ngsw-bypass=1#12']);
      expect(storage.getItem(RECOVERY_GUARD_KEY)).toBe(String(now));
    });

    it('heals a version that failed to install on a hash mismatch, but not on another failure', async () => {
      start();
      await flush();

      sw.versionUpdates.next({
        type: 'VERSION_INSTALLATION_FAILED',
        version: { hash: 'b' },
        error: 'Error: Network error',
      });
      await flush();
      expect(assigned).toEqual([]);

      sw.versionUpdates.next({
        type: 'VERSION_INSTALLATION_FAILED',
        version: { hash: 'b' },
        error: 'Error: Hash mismatch (cacheBustedFetchFromNetwork): /main.js',
      });
      await flush();
      expect(platform.unregisterWorkers).toHaveBeenCalledTimes(1);
      expect(assigned).toHaveLength(1);
    });

    it('heals once per event burst', async () => {
      start();
      await flush();

      sw.unrecoverable.next({ type: 'UNRECOVERABLE_STATE', reason: 'one' });
      sw.unrecoverable.next({ type: 'UNRECOVERABLE_STATE', reason: 'two' });
      await flush();

      expect(assigned).toHaveLength(1);
    });

    it('does not heal again within the guard window after the reload, and does once it has passed', async () => {
      storage.setItem(RECOVERY_GUARD_KEY, String(now - RECOVERY_GUARD_MS + 1));
      start();
      await flush();

      sw.unrecoverable.next({ type: 'UNRECOVERABLE_STATE', reason: 'again' });
      await flush();
      expect(platform.unregisterWorkers).not.toHaveBeenCalled();
      expect(assigned).toEqual([]);

      TestBed.resetTestingModule();
      storage.setItem(RECOVERY_GUARD_KEY, String(now - RECOVERY_GUARD_MS));
      TestBed.configureTestingModule({
        providers: [
          { provide: SwUpdate, useValue: sw },
          { provide: UPDATE_PLATFORM, useValue: platform },
          { provide: Sheet, useValue: { hasOpen: () => false } },
          {
            provide: PAGE_LOCATION,
            useValue: { href: 'https://console.test/', assign: (url: string) => assigned.push(url) },
          },
        ],
      });
      start();
      await flush();
      sw.unrecoverable.next({ type: 'UNRECOVERABLE_STATE', reason: 'later' });
      await flush();
      expect(assigned).toEqual(['https://console.test/?ngsw-bypass=1']);
    });

    it('never heals without storage for the guard', async () => {
      platform = { ...platform, storage: null };
      TestBed.overrideProvider(UPDATE_PLATFORM, { useValue: platform });
      start();
      await flush();

      sw.unrecoverable.next({ type: 'UNRECOVERABLE_STATE', reason: 'broken' });
      await flush();

      expect(platform.unregisterWorkers).not.toHaveBeenCalled();
      expect(assigned).toEqual([]);
    });

    it('still loads the page past the worker when clearing or unregistering fails', async () => {
      platform.clearWorkerCaches.mockRejectedValueOnce(new Error('denied'));
      platform.unregisterWorkers.mockRejectedValueOnce(new Error('denied'));
      start();
      await flush();

      sw.unrecoverable.next({ type: 'UNRECOVERABLE_STATE', reason: 'broken' });
      await flush();

      expect(assigned).toHaveLength(1);
    });
  });
});
