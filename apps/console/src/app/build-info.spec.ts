import { version } from '../../../../package.json';
import { buildInfo } from './build-info';

describe('buildInfo', () => {
  it('falls back to "local" when __TC_BUILT_AT__ is not defined by the build (vitest never sets it)', () => {
    // CI production builds replace __TC_BUILT_AT__ via the `define` option on apps/console's build target
    // (patched by deploy.yml with the real timestamp); vitest never runs that step, so this pins the fallback.
    expect(buildInfo.builtAt).toBe('local');
  });

  it('reads the version from the workspace package.json', () => {
    expect(buildInfo.version).toBe(version);
  });
});
