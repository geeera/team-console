import { describe, expect, it } from 'vitest';
import { accessHeadersFromEnv, accessRunOptions, isTargetOrigin } from './access-headers';

// Dummy values, built at run time so nothing here looks like a credential.
const ID = ['dummy', 'id'].join('-');
const SECRET = ['dummy', 'secret'].join('-');

describe('accessHeadersFromEnv', () => {
  it('returns both headers when both variables are set', () => {
    expect(accessHeadersFromEnv({ CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET })).toEqual({
      'CF-Access-Client-Id': ID,
      'CF-Access-Client-Secret': SECRET,
    });
  });

  it.each([
    {},
    { CF_ACCESS_CLIENT_ID: ID },
    { CF_ACCESS_CLIENT_SECRET: SECRET },
    { CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: SECRET },
    { CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: '' },
  ])('returns null unless both are non-empty: %o', (env) => {
    expect(accessHeadersFromEnv(env)).toBeNull();
  });
});

describe('isTargetOrigin', () => {
  const target = 'https://team-console-stage.example.dev';

  it.each([
    [`${target}/api/v1/healthz`, true],
    ['/api/v1/healthz', true],
    [`${target}:443/x`, true],
    ['https://team-console-stage.example.dev.evil.test/x', false],
    ['http://team-console-stage.example.dev/x', false],
    ['https://team-console-stage.example.dev:8443/x', false],
    ['https://other.example.dev/x', false],
    ['//other.example.dev/x', false],
    ['data:text/plain,hi', false],
  ])('%s → %s', (url, expected) => {
    expect(isTargetOrigin(url, target)).toBe(expected);
  });

  it('is false for an unparseable target', () => {
    expect(isTargetOrigin('/x', 'not a url')).toBe(false);
  });
});

describe('accessRunOptions', () => {
  it('keeps traces of failures and the HTML report without the Access token', () => {
    expect(accessRunOptions(null)).toEqual({ trace: 'retain-on-failure', htmlReport: true });
  });

  it('turns traces and the HTML report off with the Access token', () => {
    expect(accessRunOptions({ 'CF-Access-Client-Id': ID, 'CF-Access-Client-Secret': SECRET })).toEqual({
      trace: 'off',
      htmlReport: false,
    });
  });
});
