import { TestBed } from '@angular/core/testing';
import { emptyPersistedState, parsePersistedState } from './persisted-state.model';
import {
  memoryPersistedStateStorage,
  PERSISTED_STATE_STORAGE,
  PersistedStateStorage,
} from './persisted-state.storage';
import { PERSISTED_STATE_WRITE_DELAY_MS, PersistedStateStore } from './persisted-state.store';

describe('PersistedStateStore', () => {
  function setup(storage: PersistedStateStorage = memoryPersistedStateStorage()) {
    TestBed.configureTestingModule({ providers: [{ provide: PERSISTED_STATE_STORAGE, useValue: storage }] });
    return { store: TestBed.inject(PersistedStateStore), storage };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts from the stored state and round-trips a change', () => {
    const stored = memoryPersistedStateStorage(
      JSON.stringify({ ...emptyPersistedState(), activeSlug: 'a', pinned: ['a'] }),
    );
    const { store, storage } = setup(stored);
    expect(store.activeSlug()).toBe('a');
    expect(store.pinned()).toEqual(['a']);

    store.setLastPath('a', 'chat');
    store.setScroll('a', 'chat', 340);
    vi.advanceTimersByTime(PERSISTED_STATE_WRITE_DELAY_MS);

    expect(parsePersistedState(storage.read()).projects['a']).toEqual({
      lastPath: 'chat',
      scroll: { chat: 340 },
      chatDraft: '',
    });
  });

  it('writes at most once per window for scroll and path updates', () => {
    const storage = memoryPersistedStateStorage();
    const write = vi.spyOn(storage, 'write');
    const { store } = setup(storage);

    store.setScroll('a', 'questions', 10);
    store.setScroll('a', 'questions', 20);
    store.setLastPath('a', 'questions');
    expect(write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(PERSISTED_STATE_WRITE_DELAY_MS);
    expect(write).toHaveBeenCalledTimes(1);
    expect(parsePersistedState(storage.read()).projects['a']?.scroll['questions']).toBe(20);
  });

  it('writes the chat draft immediately', () => {
    const storage = memoryPersistedStateStorage();
    const { store } = setup(storage);

    store.setChatDraft('a', 'unsent');

    expect(parsePersistedState(storage.read()).projects['a']?.chatDraft).toBe('unsent');
  });

  it('flushes pending changes when the page is hidden', () => {
    const storage = memoryPersistedStateStorage();
    const { store } = setup(storage);
    store.setActiveSlug('b');
    expect(storage.read()).toBeNull();

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(parsePersistedState(storage.read()).activeSlug).toBe('b');
  });

  it('flushes pending changes on pagehide', () => {
    const storage = memoryPersistedStateStorage();
    const { store } = setup(storage);
    store.setActiveSlug('c');

    window.dispatchEvent(new Event('pagehide'));

    expect(parsePersistedState(storage.read()).activeSlug).toBe('c');
  });

  it('discards a stored state with an old version or a wrong shape and starts fresh', () => {
    const { store } = setup(memoryPersistedStateStorage(JSON.stringify({ version: 0, activeSlug: 'a' })));
    expect(store.activeSlug()).toBeNull();
    expect(store.projects()).toEqual({});
  });

  it('keeps the artifacts filter per project and empties it once cleared', () => {
    const { store, storage } = setup();

    store.setArtifactFilter('a', { type: 'design', q: 'lanes' });
    vi.advanceTimersByTime(PERSISTED_STATE_WRITE_DELAY_MS);
    expect(parsePersistedState(storage.read()).projects['a']?.artifactFilter).toEqual({
      type: 'design',
      q: 'lanes',
    });

    store.setArtifactFilter('a', { q: '' });
    vi.advanceTimersByTime(PERSISTED_STATE_WRITE_DELAY_MS);
    expect(store.projectState('a')?.artifactFilter).toEqual({});
  });

  it('toggles pins in pin order and the collapsed flag', () => {
    const { store } = setup();

    store.togglePin('b');
    store.togglePin('a');
    expect(store.pinned()).toEqual(['b', 'a']);
    expect(store.isPinned('a')).toBe(true);

    store.togglePin('b');
    expect(store.pinned()).toEqual(['a']);

    store.setCollapsed(true);
    expect(store.collapsed()).toBe(true);
  });

  it('prunes projects, pins and the active slug that are no longer active', () => {
    const { store } = setup();
    store.setActiveSlug('gone');
    store.togglePin('gone');
    store.togglePin('kept');
    store.setLastPath('gone', 'chat');
    store.setLastPath('kept', 'board');

    store.prune(['kept']);

    expect(store.activeSlug()).toBeNull();
    expect(store.pinned()).toEqual(['kept']);
    expect(Object.keys(store.projects())).toEqual(['kept']);
  });

  it('swallows a storage write failure, reports it once and keeps working in memory', () => {
    const storage: PersistedStateStorage = {
      read: () => null,
      write: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store } = setup(storage);

    expect(() => store.setChatDraft('a', 'one')).not.toThrow();
    expect(() => store.setChatDraft('a', 'two')).not.toThrow();

    expect(store.projectState('a')?.chatDraft).toBe('two');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('ignores updates that change nothing, so no write is scheduled', () => {
    const storage = memoryPersistedStateStorage();
    const write = vi.spyOn(storage, 'write');
    const { store } = setup(storage);

    store.setActiveSlug(null);
    store.setCollapsed(false);
    vi.advanceTimersByTime(PERSISTED_STATE_WRITE_DELAY_MS);

    expect(write).not.toHaveBeenCalled();
  });
});
