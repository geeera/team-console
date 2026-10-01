import { TestBed } from '@angular/core/testing';
import { NetworkStatus } from './network-status';

describe('NetworkStatus', () => {
  let onLine: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
  });

  afterEach(() => {
    onLine.mockRestore();
  });

  it('starts from navigator.onLine and follows the offline and online events', () => {
    const status = TestBed.inject(NetworkStatus);
    expect(status.online()).toBe(true);

    onLine.mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    expect(status.online()).toBe(false);

    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    expect(status.online()).toBe(true);
  });
});
