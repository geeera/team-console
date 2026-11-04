import { isWranglerEnvConfig, readWorkerConfig, wranglerConfigReader } from './wrangler-config';

const VALID = {
  name: 'team-console-dev',
  main: 'src/main.ts',
  compatibility_date: '2026-08-15',
  vars: { ENVIRONMENT: 'dev' },
  d1_databases: [{ binding: 'DB', database_name: 'team-console-dev', database_id: 'id' }],
};

describe('readWorkerConfig', () => {
  it('reads a Worker config through the installed wrangler', () => {
    const config = readWorkerConfig('api', 'dev');

    expect(config.name).toBe('team-console-dev');
    expect(config.vars['ENVIRONMENT']).toBe('dev');
  });

  it('fails naming the wrapper when wrangler returns another shape', () => {
    expect(() => readWorkerConfig('hooks', 'stage', () => ({ name: 'x' }))).toThrow(
      /unexpected config shape for apps\/hooks env stage; check tools\/workspace-checks\/src\/support\/wrangler-config\.ts/,
    );
  });

  it('passes the Worker file and the environment to the reader', () => {
    const calls: unknown[] = [];
    readWorkerConfig('hooks', 'production', (args, options) => {
      calls.push({ args, options });
      return VALID;
    });

    expect(calls).toEqual([
      {
        args: { config: expect.stringMatching(/apps\/hooks\/wrangler\.jsonc$/), env: 'production' },
        options: { hideWarnings: true },
      },
    ]);
  });
});

describe('wranglerConfigReader', () => {
  it('fails naming the wrapper when wrangler no longer exports unstable_readConfig', () => {
    expect(() => wranglerConfigReader({ readConfig: () => VALID })).toThrow(
      /no longer exports unstable_readConfig; point tools\/workspace-checks\/src\/support\/wrangler-config\.ts/,
    );
  });

  it("calls the module's reader with the arguments", () => {
    const read = wranglerConfigReader({
      unstable_readConfig: (args: unknown, options: unknown) => ({ args, options }),
    });

    expect(read({ config: 'a.jsonc', env: 'dev' }, { hideWarnings: true })).toEqual({
      args: { config: 'a.jsonc', env: 'dev' },
      options: { hideWarnings: true },
    });
  });
});

describe('isWranglerEnvConfig', () => {
  it('accepts the fields the checks read', () => {
    expect(isWranglerEnvConfig(VALID)).toBe(true);
    expect(
      isWranglerEnvConfig({
        ...VALID,
        d1_databases: [{ ...VALID.d1_databases[0], migrations_dir: 'migrations' }],
      }),
    ).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', [VALID]],
    ['no name', { ...VALID, name: undefined }],
    ['vars as an array', { ...VALID, vars: [] }],
    ['no d1_databases', { ...VALID, d1_databases: undefined }],
    ['a database without an id', { ...VALID, d1_databases: [{ binding: 'DB', database_name: 'x' }] }],
    [
      'a non-string migrations_dir',
      { ...VALID, d1_databases: [{ ...VALID.d1_databases[0], migrations_dir: 1 }] },
    ],
  ])('rejects %s', (_label, value) => {
    expect(isWranglerEnvConfig(value)).toBe(false);
  });
});
