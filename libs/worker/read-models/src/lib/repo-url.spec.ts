import { describe, expect, it } from 'vitest';
import { repoUrlOf } from './repo-url';

describe('repoUrlOf', () => {
  it('builds the repository page URL', () => {
    expect(repoUrlOf({ owner: 'acme', name: 'app' })).toBe('https://github.com/acme/app');
  });

  it('encodes each part so it cannot steer the path', () => {
    expect(repoUrlOf({ owner: 'a b', name: 'x/y?z' })).toBe('https://github.com/a%20b/x%2Fy%3Fz');
  });
});
