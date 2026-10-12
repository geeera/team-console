import { restoreScroll } from './scroll-restore';

const VIEWPORT = 500;

/** jsdom does no layout: a scroller (here the content itself) whose height is what the test says, and which clamps scrollTop as browsers do. */
function scroller(contentHeight: number): { main: HTMLElement; grow(to: number): void } {
  const main = document.createElement('main');
  let height = contentHeight;
  let top = 0;
  Object.defineProperties(main, {
    clientHeight: { get: () => VIEWPORT },
    scrollHeight: { get: () => height },
    scrollTop: {
      get: () => top,
      set: (value: number) => (top = Math.max(0, Math.min(value, height - VIEWPORT))),
    },
  });
  document.body.append(main);
  return {
    main,
    grow: (to: number) => {
      height = to;
      main.append(document.createElement('li'));
    },
  };
}

const mutationsDelivered = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('restoreScroll', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it('puts a screen that is already tall enough back at once', () => {
    const { main } = scroller(2_000);

    const restore = restoreScroll(main, main, 300);

    expect(main.scrollTop).toBe(300);
    expect(restore.isPending()).toBe(false);
  });

  it('waits for content that loads later, then applies the saved position', async () => {
    const { main, grow } = scroller(VIEWPORT);

    const restore = restoreScroll(main, main, 300);
    expect(main.scrollTop).toBe(0);
    expect(restore.isPending()).toBe(true);

    grow(700);
    await mutationsDelivered();
    expect(main.scrollTop).toBe(0);
    expect(restore.isPending()).toBe(true);

    grow(2_000);
    await mutationsDelivered();
    expect(main.scrollTop).toBe(300);
    expect(restore.isPending()).toBe(false);
  });

  it('gives up when the owner starts scrolling', async () => {
    const { main, grow } = scroller(VIEWPORT);
    const restore = restoreScroll(main, main, 300);

    main.dispatchEvent(new Event('touchstart', { bubbles: true }));
    grow(2_000);
    await mutationsDelivered();

    expect(restore.isPending()).toBe(false);
    expect(main.scrollTop).toBe(0);
  });

  it('gives up after the restore window', () => {
    vi.useFakeTimers();
    const { main } = scroller(VIEWPORT);
    const restore = restoreScroll(main, main, 300, 1_000);

    vi.advanceTimersByTime(1_000);

    expect(restore.isPending()).toBe(false);
  });

  it('stops when cancelled by the next navigation', async () => {
    const { main, grow } = scroller(VIEWPORT);
    const restore = restoreScroll(main, main, 300);

    restore.cancel();
    grow(2_000);
    await mutationsDelivered();

    expect(main.scrollTop).toBe(0);
  });
});
