import { localFakeOriginOf } from './local-fake-origin';

describe('localFakeOriginOf', () => {
  it('honours a loopback http(s) origin on a local run only', () => {
    expect(localFakeOriginOf({ ENVIRONMENT: 'local' }, 'http://127.0.0.1:9997/x')).toEqual({
      kind: 'fake',
      origin: 'http://127.0.0.1:9997',
    });
    expect(localFakeOriginOf({ ENVIRONMENT: 'local' }, 'http://localhost:1')).toMatchObject({ kind: 'fake' });
    for (const environment of ['dev', 'stage', 'production']) {
      expect(localFakeOriginOf({ ENVIRONMENT: environment }, 'http://127.0.0.1:9997')).toEqual({
        kind: 'off',
      });
    }
  });

  it('is off when unset or blank', () => {
    expect(localFakeOriginOf({ ENVIRONMENT: 'local' }, undefined)).toEqual({ kind: 'off' });
    expect(localFakeOriginOf({ ENVIRONMENT: 'local' }, '  ')).toEqual({ kind: 'off' });
  });

  it.each(['https://evil.example', 'not a url', 'file:///etc/passwd', 'ftp://127.0.0.1'])(
    'refuses %s on a local run',
    (value) => {
      expect(localFakeOriginOf({ ENVIRONMENT: 'local' }, value)).toEqual({ kind: 'invalid' });
    },
  );
});
