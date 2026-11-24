import { describe, expect, it } from 'vitest';
import { describeOptions } from './local-stack';
import { parseServeWorkerOptions, type ServeWorkerOptions } from './serve-worker-options.mts';

const api: ServeWorkerOptions = {
  config: 'apps/api/wrangler.jsonc',
  env: 'dev',
  script: 'dist/apps/api/main.js',
  port: 8800,
  inspectorPort: 0,
  persistTo: '/tmp/stack/api-state',
  vars: { ENVIRONMENT: 'local', TOKEN_ENCRYPTION_KEY: 'c2VjcmV0LW9mLXRoaXMtcnVu' },
};

describe('parseServeWorkerOptions', () => {
  it('reads back the options local-stack.ts wrote', () => {
    expect(parseServeWorkerOptions(JSON.stringify(api))).toEqual(api);
  });

  it('accepts a config without an env block', () => {
    const fake = { ...api, env: undefined, vars: {} };
    expect(parseServeWorkerOptions(JSON.stringify(fake))).toEqual({ ...fake, env: undefined });
  });

  it('throws when the variable is missing or empty', () => {
    expect(() => parseServeWorkerOptions(undefined)).toThrow('SERVE_WORKER_OPTIONS is not set');
    expect(() => parseServeWorkerOptions('')).toThrow('SERVE_WORKER_OPTIONS is not set');
  });

  it('throws on text that is not JSON', () => {
    expect(() => parseServeWorkerOptions('{config:')).toThrow(SyntaxError);
  });

  it.each([
    ['a missing script', { ...api, script: undefined }],
    ['an empty config', { ...api, config: '' }],
    ['a port that is not an integer', { ...api, port: 8800.5 }],
    ['a port out of range', { ...api, port: 70_000 }],
    ['a port given as text', { ...api, inspectorPort: '0' }],
    ['a var that is not text', { ...api, vars: { GITHUB_MOCK: true } }],
    ['vars as a list', { ...api, vars: ['ENVIRONMENT:local'] }],
    ['an empty env', { ...api, env: '' }],
  ])('throws on %s', (_case, options) => {
    expect(() => parseServeWorkerOptions(JSON.stringify(options))).toThrow(
      'does not hold a valid set of options',
    );
  });
});

describe('describeOptions', () => {
  it('names the vars but never logs their values', () => {
    const line = describeOptions(api);

    expect(line).toContain('--var TOKEN_ENCRYPTION_KEY:…');
    expect(line).not.toContain(api.vars['TOKEN_ENCRYPTION_KEY']);
    expect(line).toContain('--config apps/api/wrangler.jsonc --env dev --port 8800');
  });
});
