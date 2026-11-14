import {
  emptyPersistedState,
  isPersistedStateV1,
  isQuickTaskDraft,
  parsePersistedState,
  PersistedStateV1,
  QuickTaskDraft,
  scrollKeyOf,
} from './persisted-state.model';

const valid: PersistedStateV1 = {
  version: 1,
  activeSlug: 'team-console',
  pinned: ['team-console'],
  collapsed: false,
  projects: {
    'team-console': { lastPath: 'chat', scroll: { chat: 120 }, chatDraft: 'hello' },
    sheltrix: {
      lastPath: 'artifacts?type=decisions',
      scroll: {},
      chatDraft: '',
      artifactFilter: { type: 'decisions' },
      boardTab: 'prs',
      boardFolders: ['sprint:12', 'backlog'],
    },
  },
};

describe('parsePersistedState', () => {
  it('restores a valid version-1 state as is', () => {
    expect(parsePersistedState(JSON.stringify(valid))).toEqual(valid);
  });

  it('starts fresh when nothing is stored', () => {
    expect(parsePersistedState(null)).toEqual(emptyPersistedState());
    expect(parsePersistedState('')).toEqual(emptyPersistedState());
  });

  it('discards garbage that is not JSON without throwing', () => {
    expect(parsePersistedState('{not json')).toEqual(emptyPersistedState());
  });

  it('discards an older version', () => {
    expect(parsePersistedState(JSON.stringify({ ...valid, version: 0 }))).toEqual(emptyPersistedState());
  });

  it.each<[string, unknown]>([
    ['a bare array', []],
    ['a string', 'tc.state'],
    ['pinned that is not a string array', { ...valid, pinned: [1] }],
    ['a missing collapsed flag', { ...valid, collapsed: undefined }],
    ['an activeSlug of the wrong type', { ...valid, activeSlug: 7 }],
    ['a project without chatDraft', { ...valid, projects: { x: { lastPath: '', scroll: {} } } }],
    [
      'a scroll map with a string',
      { ...valid, projects: { x: { lastPath: '', scroll: { a: '1' }, chatDraft: '' } } },
    ],
    [
      'an artifact filter of the wrong shape',
      {
        ...valid,
        projects: { x: { lastPath: '', scroll: {}, chatDraft: '', artifactFilter: { type: 1 } } },
      },
    ],
    [
      'boardFolders that is not a string array',
      { ...valid, projects: { x: { lastPath: '', scroll: {}, chatDraft: '', boardFolders: ['ok', 2] } } },
    ],
  ])('discards a wrong shape: %s', (_name, value) => {
    expect(isPersistedStateV1(value)).toBe(false);
    expect(parsePersistedState(JSON.stringify(value))).toEqual(emptyPersistedState());
  });

  it('keeps unknown slugs (pruning is the store’s job, against the project list)', () => {
    const state = parsePersistedState(JSON.stringify(valid));
    expect(Object.keys(state.projects)).toEqual(['team-console', 'sheltrix']);
  });
});

const quickTaskDraft: QuickTaskDraft = {
  slug: 'team-console',
  title: 'Fix the footer',
  body: '',
  kind: 'bug',
  sprintTarget: 'next',
  idempotencyKey: 'key-1',
  savedAt: '2026-11-14T10:00:00.000Z',
};

describe('isQuickTaskDraft', () => {
  it('accepts a well-shaped draft', () => {
    expect(isQuickTaskDraft(quickTaskDraft)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['not a record', 'draft'],
    ['an unknown kind', { ...quickTaskDraft, kind: 'epic' }],
    ['an unknown sprint target', { ...quickTaskDraft, sprintTarget: 'later' }],
    ['a missing idempotency key', { ...quickTaskDraft, idempotencyKey: undefined }],
    ['a non-string title', { ...quickTaskDraft, title: 7 }],
  ])('rejects %s', (_name, value) => {
    expect(isQuickTaskDraft(value)).toBe(false);
  });
});

describe('parsePersistedState with a quick task draft', () => {
  it('restores a valid draft and discards a malformed one', () => {
    const withDraft = { ...valid, quickTaskDraft: quickTaskDraft };
    expect(parsePersistedState(JSON.stringify(withDraft))).toEqual(withDraft);
    const malformed = { ...valid, quickTaskDraft: { ...quickTaskDraft, kind: 'epic' } };
    expect(parsePersistedState(JSON.stringify(malformed))).toEqual(emptyPersistedState());
  });
});

describe('scrollKeyOf', () => {
  it('drops the query and the fragment', () => {
    expect(scrollKeyOf('artifacts?type=decisions&q=x')).toBe('artifacts');
    expect(scrollKeyOf('needs-you#n12')).toBe('needs-you');
    expect(scrollKeyOf('chat')).toBe('chat');
  });
});
