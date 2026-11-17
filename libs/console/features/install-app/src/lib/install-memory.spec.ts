import { TestBed } from '@angular/core/testing';
import {
  INSTALL_PROMPT_KEY,
  InstallMemoryStore,
  memoryAtLaunch,
  OPEN_MEMORY,
  parseInstallMemory,
  serializeInstallMemory,
  snoozedFrom,
} from './install-memory';

const NOW = Date.parse('2026-11-17T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('install memory', () => {
  it('reads nothing, junk and unknown shapes as "no answer yet"', () => {
    expect(parseInstallMemory(null)).toEqual(OPEN_MEMORY);
    expect(parseInstallMemory('{not json')).toEqual(OPEN_MEMORY);
    expect(parseInstallMemory('[]')).toEqual(OPEN_MEMORY);
    expect(parseInstallMemory('{"choice":"snoozed","until":"soon"}')).toEqual(OPEN_MEMORY);
    expect(parseInstallMemory('{"ignored":-2}')).toEqual(OPEN_MEMORY);
  });

  it('round-trips every answer in the spec’s format', () => {
    const snoozed = snoozedFrom(NOW);
    expect(serializeInstallMemory(snoozed)).toBe('{"choice":"snoozed","until":"2026-12-01T10:00:00.000Z"}');
    expect(parseInstallMemory(serializeInstallMemory(snoozed))).toEqual(snoozed);
    expect(parseInstallMemory(serializeInstallMemory({ choice: 'never' }))).toEqual({ choice: 'never' });
    expect(parseInstallMemory(serializeInstallMemory({ choice: 'open', ignored: 2 }))).toEqual({
      choice: 'open',
      ignored: 2,
    });
    expect(serializeInstallMemory(OPEN_MEMORY)).toBeNull();
  });

  it('keeps a snooze for 14 days and lets it expire after', () => {
    const snoozed = snoozedFrom(NOW);

    expect(memoryAtLaunch(snoozed, NOW + 13 * DAY)).toBe(snoozed);
    expect(memoryAtLaunch(snoozed, NOW + 15 * DAY)).toEqual(OPEN_MEMORY);
  });

  it('treats a snooze more than 14 days ahead as expired (the clock was moved back)', () => {
    expect(memoryAtLaunch(snoozedFrom(NOW), NOW - 2 * DAY)).toEqual(OPEN_MEMORY);
  });

  it('snoozes itself for 14 days after three ignored launches, then counts afresh', () => {
    expect(memoryAtLaunch({ choice: 'open', ignored: 2 }, NOW)).toEqual({ choice: 'open', ignored: 2 });
    const auto = memoryAtLaunch({ choice: 'open', ignored: 3 }, NOW);

    expect(auto).toEqual({ choice: 'snoozed', until: '2026-12-01T10:00:00.000Z', auto: true });
    expect(memoryAtLaunch(auto, NOW + 15 * DAY)).toEqual(OPEN_MEMORY);
  });

  it('never expires never', () => {
    expect(memoryAtLaunch({ choice: 'never' }, NOW + 365 * DAY)).toEqual({ choice: 'never' });
  });
});

describe('InstallMemoryStore', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('counts a shown launch and forgets the count once answered', () => {
    const store = TestBed.inject(InstallMemoryStore);
    store.markShown();
    expect(localStorage.getItem(INSTALL_PROMPT_KEY)).toBe('{"ignored":1}');

    store.snooze();
    expect(JSON.parse(localStorage.getItem(INSTALL_PROMPT_KEY) ?? '')).toEqual({
      choice: 'snoozed',
      until: '2026-12-01T10:00:00.000Z',
    });
    expect(store.canOffer()).toBe(false);
  });

  it('writes the automatic snooze when the launch starts', () => {
    localStorage.setItem(INSTALL_PROMPT_KEY, '{"ignored":3}');
    const store = TestBed.inject(InstallMemoryStore);

    expect(store.canOffer()).toBe(false);
    expect(JSON.parse(localStorage.getItem(INSTALL_PROMPT_KEY) ?? '')).toMatchObject({ auto: true });
  });

  it('clears the key once installed', () => {
    localStorage.setItem(INSTALL_PROMPT_KEY, '{"ignored":2}');
    const store = TestBed.inject(InstallMemoryStore);
    store.clear();

    expect(localStorage.getItem(INSTALL_PROMPT_KEY)).toBeNull();
  });

  it('holds the answer for the launch where storage throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const store = TestBed.inject(InstallMemoryStore);
    store.never();

    expect(store.canOffer()).toBe(false);
    expect(store.memory()).toEqual({ choice: 'never' });
    expect(warn).toHaveBeenCalled();
  });
});
