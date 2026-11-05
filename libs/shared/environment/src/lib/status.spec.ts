import { environmentStatusOf } from './status';
import { countedMissingOf, isBindingSet, isEnvironmentStatusDto, setupCommandOf } from './status-dto';

// Built at run time so no scanner sees a credential-shaped literal.
const SENTINEL = ['SENTINEL', 'value', 'never', 'shown'].join('-');

describe('isBindingSet', () => {
  it.each([
    ['a non-empty string', 'x', true],
    ['an empty string', '', false],
    ['a blank string', '  \n', false],
    ['undefined', undefined, false],
    ['null', null, false],
    ['a JSON var', { a: 1 }, true],
  ])('%s → %s', (_, value, expected) => {
    expect(isBindingSet(value)).toBe(expected);
  });
});

describe('environmentStatusOf', () => {
  const bindings: Record<string, string> = {
    OWNER_EMAIL: SENTINEL,
    ACCESS_AUD: '',
    GITHUB_APP_ID: SENTINEL,
    ROUTINE_TOKEN_STORIFY: SENTINEL,
  };
  const read = (name: string): unknown => bindings[name];

  it('reports set or missing for every row the Worker can see, and nothing else', () => {
    const status = environmentStatusOf('production', read, ['storify']);
    const byId = new Map(status.items.map((item) => [item.id, item.status]));
    expect(status.environment).toBe('production');
    expect(byId.get('api/OWNER_EMAIL')).toBe('set');
    expect(byId.get('github-vars/ACCESS_AUD')).toBe('missing');
    expect(byId.get('github-vars/CONSOLE_GITHUB_APP_ID')).toBe('set');
    expect(byId.get('project/storify/ROUTINE_TOKEN_STORIFY')).toBe('set');
    expect(byId.get('project/storify/SLOT_TOKEN_STORIFY_PM')).toBe('missing');
    expect(byId.has('hooks/WEBHOOK_SECRET')).toBe(false);
    expect(byId.has('github-secrets/CLOUDFLARE_API_TOKEN')).toBe(false);
  });

  it('carries no value, length or prefix of any binding', () => {
    const text = JSON.stringify(environmentStatusOf('production', read, ['storify']));
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(SENTINEL.slice(0, 6));
    expect(text).not.toContain(String(SENTINEL.length));
    for (const item of environmentStatusOf('production', read, ['storify']).items) {
      expect(Object.keys(item).sort()).toEqual(['id', 'optional', 'status']);
    }
  });
});

describe('countedMissingOf', () => {
  it('counts missing items the console needs, never an optional one', () => {
    const status = environmentStatusOf('production', () => undefined, ['storify']);
    const optional = status.items.filter((item) => item.optional);
    expect(optional.map((item) => item.id)).toContain('project/storify/SLOT_TOKEN_STORIFY_PM');
    expect(countedMissingOf(status)).toBe(status.items.length - optional.length);
  });
});

describe('isEnvironmentStatusDto', () => {
  it('accepts what environmentStatusOf builds', () => {
    expect(isEnvironmentStatusDto(environmentStatusOf('production', () => 'x', ['storify']))).toBe(true);
  });

  it.each([
    ['no environment', { items: [] }],
    ['an unknown environment', { environment: 'qa', items: [] }],
    [
      'an unknown status',
      { environment: 'dev', items: [{ id: 'api/OWNER_EMAIL', status: 'maybe', optional: false }] },
    ],
    [
      'an id that is not a row id',
      { environment: 'dev', items: [{ id: '<img>', status: 'set', optional: false }] },
    ],
    ['items that are not a list', { environment: 'dev', items: {} }],
    ['no optional flag', { environment: 'dev', items: [{ id: 'api/OWNER_EMAIL', status: 'set' }] }],
  ])('refuses %s', (_, value) => {
    expect(isEnvironmentStatusDto(value)).toBe(false);
  });
});

describe('setupCommandOf', () => {
  it('builds the set, rotate and check commands', () => {
    expect(setupCommandOf('stage')).toBe('setup --env stage');
    expect(setupCommandOf('stage', 'rotate')).toBe('setup --env stage --rotate');
    expect(setupCommandOf('local', 'check')).toBe('setup --env local --check');
  });
});
