/**
 * `localStorage` for one device-local choice, never sent anywhere. Storage may be unavailable (private browsing, a
 * full quota, a blocked origin): every call then reports a warning under `owner` and answers "nothing stored", so
 * the caller keeps the choice in memory until the app closes, which is the honest fallback.
 */
export interface DeviceStorage {
  read(key: string): string | null;
  /** `false` when the value could not be stored. */
  write(key: string, value: string): boolean;
  remove(key: string): void;
}

export function deviceStorageOf(view: Window | null | undefined, owner: string): DeviceStorage {
  const storage = (() => {
    try {
      return view?.localStorage ?? null;
    } catch (error: unknown) {
      // Reading `localStorage` itself throws where storage is blocked.
      console.warn(`${owner}: storage unavailable`, error);
      return null;
    }
  })();

  return {
    read(key) {
      try {
        return storage?.getItem(key) ?? null;
      } catch (error: unknown) {
        console.warn(`${owner}: could not read ${key}`, error);
        return null;
      }
    },
    write(key, value) {
      if (storage === null) {
        return false;
      }
      try {
        storage.setItem(key, value);
        return true;
      } catch (error: unknown) {
        console.warn(`${owner}: could not store ${key}`, error);
        return false;
      }
    },
    remove(key) {
      try {
        storage?.removeItem(key);
      } catch (error: unknown) {
        console.warn(`${owner}: could not remove ${key}`, error);
      }
    },
  };
}
