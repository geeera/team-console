import { isSpaceSection, spaceLocationOf, spaceUrlOf } from './space-routes';

describe('spaceUrlOf', () => {
  it('opens the last path, or the default section when there is none', () => {
    expect(spaceUrlOf('a', 'chat')).toBe('/p/a/chat');
    expect(spaceUrlOf('a', 'artifacts?type=decisions')).toBe('/p/a/artifacts?type=decisions');
    expect(spaceUrlOf('a', '')).toBe('/p/a/questions');
    expect(spaceUrlOf('a', undefined)).toBe('/p/a/questions');
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
