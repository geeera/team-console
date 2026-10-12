import { APP_NAME, appIconDirOf, appNameOf, appShortNameOf, environmentLabelOf } from './app-identity';

describe('app identity per environment', () => {
  it('leaves production unmarked', () => {
    expect(environmentLabelOf('production')).toBeNull();
    expect(appNameOf('production')).toBe(APP_NAME);
    expect(appShortNameOf('production')).toBe('Console');
    expect(appIconDirOf('production')).toBe('/icons/production');
  });

  it.each([
    ['dev', 'Dev', 'Team Console Dev', 'TC Dev'],
    ['stage', 'Stage', 'Team Console Stage', 'TC Stage'],
    ['local', 'Local', 'Team Console Local', 'TC Local'],
  ] as const)('names %s in the label, the name and the short name', (environment, label, name, shortName) => {
    expect(environmentLabelOf(environment)).toBe(label);
    expect(appNameOf(environment)).toBe(name);
    expect(appShortNameOf(environment)).toBe(shortName);
    expect(appIconDirOf(environment)).toBe(`/icons/${environment}`);
  });
});
