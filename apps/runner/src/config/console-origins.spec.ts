import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiOriginOf } from './config';
import { BUILT_IN_CONSOLE_ORIGINS, isBuiltInConsoleOrigin } from './console-origins';

// R-INT-3: the origins the enrolment confirmation names as the console's identity are compiled in, and they are the
// deployed environments' own `CONSOLE_PUBLIC_ORIGIN`, so a new environment cannot drift from the runner unseen.
const wrangler = readFileSync(join(import.meta.dirname, '../../../api/wrangler.jsonc'), 'utf8');
const deployedOrigins = [...wrangler.matchAll(/"CONSOLE_PUBLIC_ORIGIN":\s*"([^"]*)"/g)].map(
  (match) => match[1],
);

describe('the built-in console origins', () => {
  it('are exactly the deployed environments’ public origins', () => {
    expect(deployedOrigins).toHaveLength(3);
    expect([...BUILT_IN_CONSOLE_ORIGINS].sort()).toEqual([...deployedOrigins].sort());
  });

  it('are https origins in the shape --url resolves to', () => {
    for (const origin of BUILT_IN_CONSOLE_ORIGINS) {
      expect(apiOriginOf(origin)).toBe(origin);
      expect(origin.startsWith('https://')).toBe(true);
    }
  });

  it('take no lookalike, other scheme, port or loopback', () => {
    expect(isBuiltInConsoleOrigin('https://team-console-production.geeera.workers.dev')).toBe(true);
    for (const origin of [
      'https://team-console-production.geeera.workers.dev.evil.example',
      'https://team-console-production-geeera.workers.dev',
      'http://team-console-production.geeera.workers.dev',
      'https://team-console-production.geeera.workers.dev:8443',
      'https://TEAM-CONSOLE-PRODUCTION.geeera.workers.dev',
      'http://127.0.0.1:8787',
    ]) {
      expect(isBuiltInConsoleOrigin(origin)).toBe(false);
    }
  });
});
