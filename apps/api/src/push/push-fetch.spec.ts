import { localEnv } from '../testing/github-kit';
import { PushMisconfiguredError, pushFetch } from './push-fetch';

describe('pushFetch', () => {
  const seen: string[] = [];
  const base = async (input: string): Promise<Response> => {
    seen.push(input);
    return new Response(null, { status: 201 });
  };

  beforeEach(() => {
    seen.length = 0;
  });

  it('sends a push to the fake service as <fake>/<host><path> on a local run', async () => {
    const transport = pushFetch(localEnv({ PUSH_FAKE_ORIGIN: 'http://127.0.0.1:9997' }), base);
    await transport('https://web.push.apple.com/abc?x=1', { method: 'POST' });
    expect(seen).toEqual(['http://127.0.0.1:9997/web.push.apple.com/abc?x=1']);
  });

  it('refuses to forward anything that is not a push-service endpoint', async () => {
    const transport = pushFetch(localEnv({ PUSH_FAKE_ORIGIN: 'http://127.0.0.1:9997' }), base);
    await expect(transport('https://evil.example/x', { method: 'POST' })).rejects.toThrow(TypeError);
    expect(seen).toEqual([]);
  });

  it.each(['dev', 'stage', 'production'])('ignores the variable on %s', (environment) => {
    expect(pushFetch(localEnv({ ENVIRONMENT: environment, PUSH_FAKE_ORIGIN: 'http://127.0.0.1:9997' }), base)).toBe(base);
  });

  it('uses the real transport when the variable is unset', () => {
    expect(pushFetch(localEnv({ PUSH_FAKE_ORIGIN: undefined }), base)).toBe(base);
  });

  it.each(['https://evil.example', 'not a url', 'file:///etc/passwd'])('refuses %s as a fake origin', (origin) => {
    expect(() => pushFetch(localEnv({ PUSH_FAKE_ORIGIN: origin }), base)).toThrow(PushMisconfiguredError);
  });
});
