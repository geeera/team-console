import { isSpaceSection, isVisibleSpaceSection, spaceLocationOf, spaceUrlOf, VISIBLE_SPACE_SECTIONS } from './space-routes';

describe('spaceUrlOf', () => {
  it('opens the last path, or the default section when there is none', () => {
    expect(spaceUrlOf('a', 'board')).toBe('/p/a/board');
    expect(spaceUrlOf('a', 'artifacts?type=decisions')).toBe('/p/a/artifacts?type=decisions');
    expect(spaceUrlOf('a', '')).toBe('/p/a/questions');
    expect(spaceUrlOf('a', undefined)).toBe('/p/a/questions');
  });

  it('opens the default section instead of a saved `chat` (#203): chat is a placeholder until #17', () => {
    expect(spaceUrlOf('a', 'chat')).toBe('/p/a/questions');
  });

  it('encodes the slug so it cannot add segments', () => {
    expect(spaceUrlOf('a/b', undefined)).toBe('/p/a%2Fb/questions');
  });
});

describe('spaceLocationOf', () => {
  it('reads the slug and the path relative to the space, keeping the query', () => {
    expect(spaceLocationOf('/p/a/chat')).toEqual({ slug: 'a', path: 'chat' });
    expect(spaceLocationOf('/p/a/artifacts?type=decisions#x')).toEqual({
      slug: 'a',
      path: 'artifacts?type=decisions',
    });
    expect(spaceLocationOf('/p/a')).toEqual({ slug: 'a', path: '' });
    expect(spaceLocationOf('/p/a/')).toEqual({ slug: 'a', path: '' });
  });

  it('is null outside the spaces', () => {
    expect(spaceLocationOf('/needs-you')).toBeNull();
    expect(spaceLocationOf('/')).toBeNull();
    expect(spaceLocationOf('/pages/a')).toBeNull();
  });
});

describe('isSpaceSection', () => {
  it('accepts the five sections only', () => {
    expect(isSpaceSection('chat')).toBe(true);
    expect(isSpaceSection('settings')).toBe(false);
    expect(isSpaceSection(1)).toBe(false);
  });
});

describe('isVisibleSpaceSection', () => {
  it('excludes chat while the tab is hidden (#203), but still recognises every other section', () => {
    expect(isVisibleSpaceSection('chat')).toBe(false);
    expect(isVisibleSpaceSection('questions')).toBe(true);
    expect(isVisibleSpaceSection('board')).toBe(true);
    expect(isVisibleSpaceSection('artifacts')).toBe(true);
    expect(isVisibleSpaceSection('demo')).toBe(true);
    expect(isVisibleSpaceSection('settings')).toBe(false);
  });
});

describe('VISIBLE_SPACE_SECTIONS', () => {
  it('keeps tab order and drops chat', () => {
    expect(VISIBLE_SPACE_SECTIONS).toEqual(['questions', 'board', 'artifacts', 'demo']);
  });
});
