import {
  isReservedSlug,
  isValidSlug,
  routineSecretName,
  slotSecretNames,
  slugFromRepoName,
} from './project-slug';

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

describe('slotSecretNames (#114)', () => {
  it('upper-cases the slug, turns - into _ and appends the slot', () => {
    expect(slotSecretNames('storify', 'dev')).toEqual({
      token: 'SLOT_TOKEN_STORIFY_DEV',
      routine: 'SLOT_ROUTINE_STORIFY_DEV',
    });
    expect(slotSecretNames('team-console', 'pm')).toEqual({
      token: 'SLOT_TOKEN_TEAM_CONSOLE_PM',
      routine: 'SLOT_ROUTINE_TEAM_CONSOLE_PM',
    });
  });

  it('never collides with another project chat token (storify-dev vs storify / dev)', () => {
    expect(slotSecretNames('storify', 'dev').token).not.toBe(routineSecretName('storify-dev'));
  });
});
