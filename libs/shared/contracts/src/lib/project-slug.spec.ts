import { isReservedSlug, isValidSlug, routineSecretName, slugFromRepoName } from './project-slug';

describe('isValidSlug', () => {
  it.each(['tc', 'storify', 'my-app-2', '0x', 'a'.repeat(39)])('accepts %s', (slug) => {
    expect(isValidSlug(slug)).toBe(true);
  });

  it.each(['', 'a', '-ab', 'ab-', 'Ab', 'a_b', 'a/b', 'a.b', '..', 'a'.repeat(40), 'ab\n'])(
    'refuses %j',
    (slug) => {
      expect(isValidSlug(slug)).toBe(false);
    },
  );
});

describe('isReservedSlug', () => {
  it.each(['needs-you', 'overview', 'settings', 'api'])('reserves %s', (slug) => {
    expect(isReservedSlug(slug)).toBe(true);
  });

  it('does not reserve project names', () => {
    expect(isReservedSlug('storify')).toBe(false);
  });
});

describe('slugFromRepoName', () => {
  it.each([
    ['team-console', 'team-console'],
    ['My_Product.js', 'my-product-js'],
    ['.github', 'github'],
    ['--x--y--', 'x-y'],
    ['a'.repeat(38) + '-b', 'a'.repeat(38)],
    ['x', 'x'],
  ])('%s → %s', (name, slug) => {
    expect(slugFromRepoName(name)).toBe(slug);
  });
});

describe('routineSecretName', () => {
  it('upper-cases the slug and turns hyphens into underscores', () => {
    expect(routineSecretName('my-app-2')).toBe('ROUTINE_TOKEN_MY_APP_2');
  });
});
