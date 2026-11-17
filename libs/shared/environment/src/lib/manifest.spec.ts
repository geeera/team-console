import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ENVIRONMENT_MANIFEST } from './manifest.generated';
import { PROJECT_SECRETS_ENVIRONMENT } from './status-dto';

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

describe('PROJECT_SECRETS_ENVIRONMENT', () => {
  it('is the one environment every per-project item lives in (the screens that skip the manifest rely on it)', () => {
    const patterns = ENVIRONMENT_MANIFEST.items.filter((item) => item.pattern === true);
    expect(patterns.length).toBeGreaterThan(0);
    for (const item of patterns) {
      expect(item.environments, item.name).toEqual([PROJECT_SECRETS_ENVIRONMENT]);
    }
  });
});
