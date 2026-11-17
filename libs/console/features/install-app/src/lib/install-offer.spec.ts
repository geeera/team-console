import { TestBed } from '@angular/core/testing';
import { INSTALL_PROMPT_KEY } from './install-memory';
import { InstallOffer, screenOf } from './install-offer';
import { ANDROID_CHROME, configureInstall, IPHONE_SAFARI, MAC_FIREFOX, settle } from './testing.spec-helpers';

describe('InstallOffer', () => {
  beforeEach(() => localStorage.clear());

  async function start(userAgent: string, standalone = false) {
    const world = await configureInstall(userAgent, { displayModeStandalone: standalone });
    const offer = TestBed.inject(InstallOffer);
    return { world, offer };
  }

  async function go(world: Awaited<ReturnType<typeof configureInstall>>, url: string): Promise<void> {
    await world.router.navigateByUrl(url);
    await settle();
  }

  it('reads a screen as its path', () => {
    expect(screenOf('/p/storify/board?item=4#top')).toBe('/p/storify/board');
  });

  it('offers on the landing screen once it is ready, counts the launch and holds the push nudge', async () => {
    const { world, offer } = await start(IPHONE_SAFARI);
    await go(world, '/needs-you');
    offer.present('/needs-you');

    expect(offer.isShownHere()).toBe(true);
    expect(offer.holdsPushNudgeOn('/needs-you')).toBe(true);
    expect(localStorage.getItem(INSTALL_PROMPT_KEY)).toBe('{"ignored":1}');
  });

  it('ends the offer for this launch when the person leaves the screen unanswered', async () => {
    const { world, offer } = await start(IPHONE_SAFARI);
    await go(world, '/needs-you');
    offer.present('/needs-you');
    await go(world, '/p/storify/board');
    offer.present('/p/storify/board');

    expect(offer.isShownHere()).toBe(false);
    // The launch was the card's: the push nudge does not come back in it.
    expect(offer.holdsPushNudgeOn('/needs-you')).toBe(true);
  });

  it('keeps the same screen when only the query changes', async () => {
    const { world, offer } = await start(IPHONE_SAFARI);
    await go(world, '/needs-you');
    offer.present('/needs-you');
    await go(world, '/needs-you?item=3');

    expect(offer.isShownHere()).toBe(true);
  });

  it('never offers when the landing screen is not one that hosts the card', async () => {
    const { world, offer } = await start(IPHONE_SAFARI);
    await go(world, '/settings');
    await go(world, '/needs-you');
    offer.present('/needs-you');

    expect(offer.isShownHere()).toBe(false);
    expect(offer.holdsPushNudgeOn('/needs-you')).toBe(false);
  });

  it('offers nothing inside the installed app or where the browser cannot install', async () => {
    for (const [agent, standalone] of [
      [IPHONE_SAFARI, true],
      [MAC_FIREFOX, false],
    ] as const) {
      TestBed.resetTestingModule();
      const { world, offer } = await start(agent, standalone);
      await go(world, '/needs-you');
      offer.present('/needs-you');

      expect(offer.isShownHere()).toBe(false);
      expect(offer.holdsPushNudgeOn('/needs-you')).toBe(false);
    }
  });

  it('offers nothing on an expired session', async () => {
    const { world, offer } = await start(IPHONE_SAFARI);
    world.expired.set(true);
    await go(world, '/needs-you');
    offer.present('/needs-you');

    expect(offer.isShownHere()).toBe(false);
  });

  it('shows a late Chromium event on the next screen, never above the one being read', async () => {
    const { world, offer } = await start(ANDROID_CHROME);
    await go(world, '/needs-you');
    offer.present('/needs-you');
    expect(offer.holdsPushNudgeOn('/needs-you')).toBe(false);

    world.fireEvent();
    await settle();
    offer.present('/needs-you');
    expect(offer.isShownHere()).toBe(false);
    // The nudge already on the landing screen stays; no other screen gets one this launch.
    expect(offer.holdsPushNudgeOn('/needs-you')).toBe(false);

    await go(world, '/p/storify/board');
    offer.present('/p/storify/board');
    expect(offer.isShownHere()).toBe(true);
    expect(offer.holdsPushNudgeOn('/p/storify/board')).toBe(true);
  });

  it('offers at once when the event came before the landing screen was ready', async () => {
    const { world, offer } = await start(ANDROID_CHROME);
    world.fireEvent();
    await go(world, '/needs-you');
    offer.present('/needs-you');

    expect(offer.isShownHere()).toBe(true);
  });

  it('remembers Not now and Don’t show again, and ends the offer', async () => {
    const { world, offer } = await start(IPHONE_SAFARI);
    await go(world, '/needs-you');
    offer.present('/needs-you');
    offer.answer('never');

    expect(offer.isShownHere()).toBe(false);
    expect(localStorage.getItem(INSTALL_PROMPT_KEY)).toBe('{"choice":"never"}');
  });
});
