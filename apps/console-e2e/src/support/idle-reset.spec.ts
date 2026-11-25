import { request as playwrightRequest, type APIRequestContext, type APIResponse } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchResendingIdleResets, isIdleReset, resendingIdleResets, SENDING_METHODS } from './idle-reset';

// Node fetch wraps the reset as the cause of «fetch failed».
function fetchReset(): TypeError {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });
}

const RESET = new Error(
  'apiRequestContext.post: socket hang up\nCall log:\n  - → POST http://127.0.0.1:8400/x',
);

describe('isIdleReset', () => {
  it('recognises Playwright’s reused socket closed before the server read it', () => {
    expect(isIdleReset(RESET)).toBe(true);
    expect(isIdleReset(new Error('apiRequestContext.get: read ECONNRESET'))).toBe(true);
  });

  it('recognises Node fetch’s reset by the cause’s message or its code', () => {
    expect(isIdleReset(fetchReset())).toBe(true);
    expect(
      isIdleReset(
        Object.assign(new TypeError('fetch failed'), {
          cause: new Error('other side closed: socket hang up'),
        }),
      ),
    ).toBe(true);
    expect(isIdleReset(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe(
      true,
    );
  });

  it('leaves other errors alone', () => {
    expect(isIdleReset(new Error('apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:8400'))).toBe(false);
    expect(
      isIdleReset(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        }),
      ),
    ).toBe(false);
    expect(isIdleReset('socket hang up')).toBe(false);
    expect(isIdleReset(new Error('fetch failed'))).toBe(false);
  });
});

describe('fetchResendingIdleResets', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function fakeFetch(answers: (Response | Error)[]): ReturnType<typeof vi.fn> {
    const mock = vi.fn(() => {
      const next = answers.length > 1 ? answers.shift() : answers[0];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    });
    globalThis.fetch = mock as unknown as typeof fetch;
    return mock;
  }

  it('sends a request whose socket was reset once more, with the same arguments', async () => {
    const mock = fakeFetch([fetchReset(), new Response(null, { status: 204 })]);

    const answer = await fetchResendingIdleResets(
      'http://127.0.0.1:1/_fake/milestones',
      { method: 'DELETE' },
      0,
    );

    expect(answer.status).toBe(204);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock).toHaveBeenLastCalledWith('http://127.0.0.1:1/_fake/milestones', { method: 'DELETE' });
  });

  it('resends a GET too: no proxy retries it any more', async () => {
    const mock = fakeFetch([fetchReset(), new Response('{}', { status: 200 })]);

    expect((await fetchResendingIdleResets('http://127.0.0.1:1/_fake/state')).status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('hands back every answer, a 500 included, and lets every other error through', async () => {
    const broken = fakeFetch([new Response('{"error":"internal"}', { status: 500 })]);
    const answer = await fetchResendingIdleResets('http://127.0.0.1:1/x', { method: 'POST' }, 0);
    expect(await answer.text()).toBe('{"error":"internal"}');
    expect(broken).toHaveBeenCalledTimes(1);

    const down = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const refused = fakeFetch([down]);
    await expect(fetchResendingIdleResets('http://127.0.0.1:1/x', { method: 'POST' }, 0)).rejects.toBe(down);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('resends once only: a second reset is the outcome', async () => {
    const second = fetchReset();
    const mock = fakeFetch([fetchReset(), second, new Response('ok')]);

    await expect(fetchResendingIdleResets('http://127.0.0.1:1/x', { method: 'POST' }, 0)).rejects.toBe(
      second,
    );
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

function response(status: number, body: string): APIResponse {
  return { status: () => status, text: () => Promise.resolve(body) } as unknown as APIResponse;
}

describe('resendingIdleResets', () => {
  function client(answers: Record<string, (APIResponse | Error)[]>): {
    api: APIRequestContext;
    calls: Record<string, number>;
  } {
    const calls: Record<string, number> = {};
    const method = (name: string) => () => {
      calls[name] = (calls[name] ?? 0) + 1;
      const queue = answers[name] ?? [];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    };
    const api = {
      get: vi.fn(method('get')),
      head: vi.fn(method('head')),
      post: vi.fn(method('post')),
      put: vi.fn(method('put')),
      patch: vi.fn(method('patch')),
      delete: vi.fn(method('delete')),
      fetch: vi.fn(method('fetch')),
      dispose: vi.fn(() => Promise.resolve()),
    } as unknown as APIRequestContext;
    return { api, calls };
  }

  it('sends a POST whose socket was reset once more and hands back the second answer', async () => {
    const created = response(201, '{"runnerId":"r1"}');
    const { api, calls } = client({ post: [RESET, created] });

    const answer = await resendingIdleResets(api, 0).post('/api/v1/runner/enrol', { data: {} });

    expect(answer).toBe(created);
    expect(calls['post']).toBe(2);
    expect(api.post).toHaveBeenLastCalledWith('/api/v1/runner/enrol', { data: {} });
  });

  it('resends every method, GET and HEAD included', async () => {
    const ok = response(200, 'ok');
    const { api, calls } = client({
      get: [RESET, ok],
      head: [RESET, ok],
      patch: [RESET, ok],
      fetch: [RESET, ok],
    });
    const wrapped = resendingIdleResets(api, 0);

    expect(await wrapped.get('/a')).toBe(ok);
    expect(await wrapped.head('/a')).toBe(ok);
    expect(await wrapped.patch('/a')).toBe(ok);
    expect(await wrapped.fetch('/a')).toBe(ok);
    expect(calls).toEqual({ get: 2, head: 2, patch: 2, fetch: 2 });
  });

  it('waits before the resend so the client has evicted the rest of the expiring burst', async () => {
    vi.useFakeTimers();
    try {
      const ok = response(200, 'ok');
      const { api, calls } = client({ post: [RESET, ok] });
      const pending = resendingIdleResets(api, 250).post('/x');
      await vi.advanceTimersByTimeAsync(200);
      expect(calls['post']).toBe(1);
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toBe(ok);
      expect(calls['post']).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resends once only: a second reset is the outcome', async () => {
    const { api, calls } = client({ delete: [RESET, RESET, response(200, 'ok')] });

    await expect(resendingIdleResets(api, 0).delete('/y')).rejects.toBe(RESET);
    expect(calls).toEqual({ delete: 2 });
  });

  it('passes every answer, 4xx and 5xx alike, and every other error through untouched; keeps dispose', async () => {
    const refused = response(422, '{"error":"invalid"}');
    const broken = response(500, 'Error: Network connection lost.');
    const down = new Error('apiRequestContext.fetch: connect ECONNREFUSED 127.0.0.1:8400');
    const { api, calls } = client({ post: [refused], delete: [broken], fetch: [down] });
    const wrapped = resendingIdleResets(api, 0);

    expect(await wrapped.post('/a')).toBe(refused);
    expect(await wrapped.delete('/b')).toBe(broken);
    await expect(wrapped.fetch('/c')).rejects.toBe(down);
    await wrapped.dispose();
    expect(calls).toEqual({ post: 1, delete: 1, fetch: 1 });
    expect(api.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('SENDING_METHODS', () => {
  it('names every public method of the client Playwright ships except the two that send nothing', async () => {
    const api = await playwrightRequest.newContext();
    try {
      const prototype: object = Object.getPrototypeOf(api) as object;
      const methods = Object.getOwnPropertyNames(prototype).filter(
        (name) => name !== 'constructor' && !name.startsWith('_'),
      );

      expect(methods.sort()).toEqual([...SENDING_METHODS, 'dispose', 'storageState'].sort());
    } finally {
      await api.dispose();
    }
  });
});
