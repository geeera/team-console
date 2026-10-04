import { FakeRoutines } from '../testing/fake-routines';
import {
  ANTHROPIC_VERSION,
  DEFAULT_RETRY_AFTER_S,
  InvalidRoutineConfigError,
  RoutinesClient,
  type FetchLike,
} from './routines-client';

// Assembled at run time so the secret scanners never see a token-shaped literal; a sentinel, never a real token.
const TOKEN = ['sk', 'ant', 'oat01', 'TESTSENTINELroutine'].join('-');
const REQUEST = { routineId: 'trig_01ABCdef', token: TOKEN, text: 'product=storify slot=dev' };

function setup(options: { hangMs?: number; deadlineMs?: number } = {}): {
  fake: FakeRoutines;
  client: RoutinesClient;
  calls: { url: string; init: RequestInit }[];
} {
  const fake = new FakeRoutines({ hangMs: options.hangMs ?? 200 });
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return fake.fetch(url, init);
  };
  return { fake, calls, client: new RoutinesClient(fetcher, { deadlineMs: options.deadlineMs ?? 50 }) };
}

describe('RoutinesClient.fire', () => {
  it('posts once to the routine URL with the pinned version, no beta header, and the text', async () => {
    const { fake, calls, client } = setup();
    await expect(client.fire(REQUEST)).resolves.toEqual({
      kind: 'fired',
      sessionId: 'session_fake0001',
      sessionUrl: 'https://claude.ai/code/session_fake0001',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/claude_code/routines/trig_01ABCdef/fire');
    expect(fake.fires[0]).toMatchObject({
      routineId: 'trig_01ABCdef',
      text: 'product=storify slot=dev',
      anthropicVersion: ANTHROPIC_VERSION,
      hasBetaHeader: false,
      bearerShaped: true,
    });
  });

  it.each([
    ['rate-limited', { kind: 'rate-limited', retryAfter: 1200 }],
    ['rate-limited-no-header', { kind: 'rate-limited', retryAfter: DEFAULT_RETRY_AFTER_S }],
    ['paused', { kind: 'paused' }],
    ['bad-request', { kind: 'unavailable', status: 400 }],
    ['unauthorized', { kind: 'unauthorized' }],
    ['not-found', { kind: 'not-found' }],
    ['forbidden', { kind: 'unavailable', status: 403 }],
    ['unavailable', { kind: 'unavailable', status: 503 }],
  ] as const)('maps %s', async (outcome, expected) => {
    const { fake, client, calls } = setup();
    fake.next(outcome);
    await expect(client.fire(REQUEST)).resolves.toEqual(expected);
    expect(calls).toHaveLength(1);
  });

  it('gives up after the deadline as unknown and never retries', async () => {
    const { fake, client, calls } = setup({ hangMs: 300, deadlineMs: 30 });
    fake.next('hang');
    await expect(client.fire(REQUEST)).resolves.toEqual({ kind: 'unknown' });
    expect(calls).toHaveLength(1);
  });

  it('a network failure is unknown, and its message (which may quote the request) is dropped', async () => {
    const client = new RoutinesClient(async () => {
      throw new TypeError(`fetch failed for ${TOKEN}`);
    });
    await expect(client.fire(REQUEST)).resolves.toEqual({ kind: 'unknown' });
  });

  it('drops a session URL off claude.ai', async () => {
    const client = new RoutinesClient(async () =>
      Response.json({ claude_code_session_id: 's1', claude_code_session_url: 'javascript:alert(1)' }),
    );
    await expect(client.fire(REQUEST)).resolves.toEqual({ kind: 'fired', sessionId: 's1', sessionUrl: null });
  });

  it.each([
    ['routine', { ...REQUEST, routineId: '../../v1/other' }],
    ['routine', { ...REQUEST, routineId: 'trig_x/fire?' }],
    ['token', { ...REQUEST, token: 'not-a-token' }],
    ['token', { ...REQUEST, token: `${TOKEN}\r\nX-Injected: 1` }],
  ] as const)('refuses a malformed %s before anything is sent', async (part, request) => {
    const { client, calls } = setup();
    await expect(client.fire(request)).rejects.toEqual(new InvalidRoutineConfigError(part));
    expect(calls).toHaveLength(0);
  });
});
