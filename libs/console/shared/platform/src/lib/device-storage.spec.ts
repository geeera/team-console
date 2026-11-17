import { deviceStorageOf } from './device-storage';

describe('deviceStorageOf', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('reads, writes and removes a key', () => {
    const storage = deviceStorageOf(window, 'test');

    expect(storage.write('tc.x.v1', 'a')).toBe(true);
    expect(storage.read('tc.x.v1')).toBe('a');
    storage.remove('tc.x.v1');
    expect(storage.read('tc.x.v1')).toBeNull();
  });

  it('answers "nothing stored" with a warning where storage itself throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const blocked = {
      get localStorage(): Storage {
        throw new DOMException('blocked', 'SecurityError');
      },
    } as unknown as Window;
    const storage = deviceStorageOf(blocked, 'test');

    expect(storage.read('tc.x.v1')).toBeNull();
    expect(storage.write('tc.x.v1', 'a')).toBe(false);
    expect(warn).toHaveBeenCalledWith('test: storage unavailable', expect.any(DOMException));
  });

  it('reports a write the quota refuses', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });

    expect(deviceStorageOf(window, 'test').write('tc.x.v1', 'a')).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('works without a window', () => {
    const storage = deviceStorageOf(null, 'test');

    expect(storage.read('tc.x.v1')).toBeNull();
    expect(storage.write('tc.x.v1', 'a')).toBe(false);
  });
});
