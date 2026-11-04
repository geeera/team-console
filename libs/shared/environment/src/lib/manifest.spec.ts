import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ENVIRONMENT_MANIFEST } from './manifest.generated';

// The console and the Worker read the manifest through this generated copy; it must never drift from the YAML.
describe('manifest.generated.ts', () => {
  it('equals .product-team/environment-manifest.yml (rerun scripts/generate-manifest.mjs when this fails)', () => {
    const yaml = readFileSync(
      join(import.meta.dirname, '../../../../../.product-team/environment-manifest.yml'),
      'utf8',
    );
    expect(ENVIRONMENT_MANIFEST).toEqual(parse(yaml));
  });
});
