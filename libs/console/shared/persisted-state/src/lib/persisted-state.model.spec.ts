import {
  emptyPersistedState,
  isPersistedStateV1,
  parsePersistedState,
  PersistedStateV1,
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
  ])('discards a wrong shape: %s', (_name, value) => {
    expect(isPersistedStateV1(value)).toBe(false);
    expect(parsePersistedState(JSON.stringify(value))).toEqual(emptyPersistedState());
  });

  it('keeps unknown slugs (pruning is the store’s job, against the project list)', () => {
    const state = parsePersistedState(JSON.stringify(valid));
    expect(Object.keys(state.projects)).toEqual(['team-console', 'sheltrix']);
  });
});

describe('scrollKeyOf', () => {
  it('drops the query and the fragment', () => {
    expect(scrollKeyOf('artifacts?type=decisions&q=x')).toBe('artifacts');
    expect(scrollKeyOf('needs-you#n12')).toBe('needs-you');
    expect(scrollKeyOf('chat')).toBe('chat');
  });
});
