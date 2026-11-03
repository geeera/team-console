import { setAppBadge } from './app-badge';

describe('setAppBadge', () => {
  it('sets the count on the icon', async () => {
    const setBadge = vi.fn().mockResolvedValue(undefined);
    await expect(setAppBadge({ setAppBadge: setBadge, clearAppBadge: vi.fn() }, 3)).resolves.toBe('set');
    expect(setBadge).toHaveBeenCalledWith(3);
  });

  it('clears the icon at 0 instead of showing a zero', async () => {
    const setBadge = vi.fn();
    const clearBadge = vi.fn().mockResolvedValue(undefined);
    await expect(setAppBadge({ setAppBadge: setBadge, clearAppBadge: clearBadge }, 0)).resolves.toBe('cleared');
    expect(clearBadge).toHaveBeenCalledOnce();
    expect(setBadge).not.toHaveBeenCalled();
  });

  it('treats a count that is not a positive integer as 0', async () => {
    const clearBadge = vi.fn().mockResolvedValue(undefined);
    await expect(setAppBadge({ clearAppBadge: clearBadge }, Number.NaN)).resolves.toBe('cleared');
    await expect(setAppBadge({ clearAppBadge: clearBadge }, -2)).resolves.toBe('cleared');
  });

  it('is a no-op where the Badging API is missing', async () => {
    await expect(setAppBadge({}, 4)).resolves.toBe('unsupported');
    await expect(setAppBadge({}, 0)).resolves.toBe('unsupported');
  });

  it('reports the browser’s refusal and leaves the icon alone', async () => {
    const setBadge = vi.fn().mockRejectedValue(new DOMException('not allowed', 'NotAllowedError'));
    await expect(setAppBadge({ setAppBadge: setBadge }, 2)).resolves.toBe('refused');
  });

  it('lets anything else through: it is a bug, not an answer', async () => {
    const setBadge = vi.fn().mockRejectedValue(new TypeError('boom'));
    await expect(setAppBadge({ setAppBadge: setBadge }, 2)).rejects.toThrow('boom');
  });
});
