import type { APIRequestContext, APIResponse } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import { isDevProxyDrop, isDevProxyReset, retryingDevProxyDrops } from './dev-proxy';

function response(status: number, body: string): APIResponse {
  return { status: () => status, text: () => Promise.resolve(body) } as unknown as APIResponse;
}

// What workerd answers for the proxy's rejected fetch: the message, then a miniflare stack line.
const DROP = response(
  500,
  'Error: Network connection lost.\n    at async Object.fetch (file:///…/miniflare/dist/src/workers/core/entry.worker.js:5204:22)',
);
const RESET = new Error('apiRequestContext.post: socket hang up\nCall log:\n  - → POST http://127.0.0.1:8400/x');

describe('isDevProxyDrop', () => {
  it('recognises the proxy’s own 500 for a dropped connection to the Worker, with or without the stack', async () => {
    expect(await isDevProxyDrop(DROP)).toBe(true);
    expect(await isDevProxyDrop(response(500, 'Error: Network connection lost.'))).toBe(true);
    expect(await isDevProxyDrop(response(500, 'Error: Network connection lost\n'))).toBe(true);
  });

  it('leaves every other answer alone, a Worker 500 included', async () => {
    expect(await isDevProxyDrop(response(500, '{"error":"internal"}'))).toBe(false);
    expect(await isDevProxyDrop(response(500, 'Error: something else\n    at Network connection lost'))).toBe(false);
    expect(await isDevProxyDrop(response(503, 'Your worker restarted mid-request.'))).toBe(false);
    expect(await isDevProxyDrop(response(201, 'Error: Network connection lost.'))).toBe(false);
  });
});

describe('isDevProxyReset', () => {
  it('recognises the reused socket the proxy closed before reading', () => {
    expect(isDevProxyReset(RESET)).toBe(true);
    expect(isDevProxyReset(new Error('apiRequestContext.post: read ECONNRESET'))).toBe(true);
  });

  it('leaves other errors alone', () => {
    expect(isDevProxyReset(new Error('apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:8400'))).toBe(false);
    expect(isDevProxyReset('socket hang up')).toBe(false);
  });
});

describe('retryingDevProxyDrops', () => {
  function client(answers: Record<string, (APIResponse | Error)[]>): {
    api: APIRequestContext;
    calls: Record<string, number>;
  } {
    const calls: Record<string, number> = {};
    const method =
      (name: string) =>
      (...args: unknown[]) => {
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

  it('sends a POST the proxy dropped once more and hands back the second answer', async () => {
    const created = response(201, '{"runnerId":"r1"}');
    const { api, calls } = client({ post: [DROP, created] });

    const answer = await retryingDevProxyDrops(api, 0).post('/api/v1/runner/enrol', { data: {} });

    expect(answer).toBe(created);
    expect(calls['post']).toBe(2);
    expect(api.post).toHaveBeenLastCalledWith('/api/v1/runner/enrol', { data: {} });
  });

  it('sends a POST whose socket the proxy reset once more', async () => {
    const ok = response(200, 'ok');
    const { api, calls } = client({ patch: [RESET, ok] });

    expect(await retryingDevProxyDrops(api, 0).patch('/x')).toBe(ok);
    expect(calls['patch']).toBe(2);
  });

  it('waits before the resend so the pool has evicted the rest of the expiring burst', async () => {
    vi.useFakeTimers();
    try {
      const ok = response(200, 'ok');
      const { api, calls } = client({ post: [DROP, ok] });
      const pending = retryingDevProxyDrops(api, 250).post('/x');
      await vi.advanceTimersByTimeAsync(200);
      expect(calls['post']).toBe(1);
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toBe(ok);
      expect(calls['post']).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries once only: a second drop or reset is the answer', async () => {
    const { api, calls } = client({ put: [DROP, DROP, response(200, 'ok')], delete: [RESET, RESET, response(200, 'ok')] });
    const wrapped = retryingDevProxyDrops(api, 0);

    expect(await wrapped.put('/x')).toBe(DROP);
    await expect(wrapped.delete('/y')).rejects.toBe(RESET);
    expect(calls).toEqual({ put: 2, delete: 2 });
  });

  it('passes an unrelated 5xx, every 4xx and every other error through untouched', async () => {
    const refused = response(422, '{"error":"invalid"}');
    const broken = response(500, '{"error":"internal"}');
    const down = new Error('apiRequestContext.fetch: connect ECONNREFUSED 127.0.0.1:8400');
    const { api, calls } = client({ post: [refused], delete: [broken], fetch: [down] });
    const wrapped = retryingDevProxyDrops(api, 0);

    expect(await wrapped.post('/a')).toBe(refused);
    expect(await wrapped.delete('/b')).toBe(broken);
    await expect(wrapped.fetch('/c')).rejects.toBe(down);
    expect(calls).toEqual({ post: 1, delete: 1, fetch: 1 });
  });

  it('never resends a GET or HEAD (wrangler retries those itself) and keeps dispose', async () => {
    const { api, calls } = client({ get: [DROP], head: [DROP] });
    const wrapped = retryingDevProxyDrops(api, 0);

    expect(await wrapped.get('/a')).toBe(DROP);
    expect(await wrapped.head('/a')).toBe(DROP);
    await wrapped.dispose();
    expect(calls).toEqual({ get: 1, head: 1 });
    expect(api.dispose).toHaveBeenCalledTimes(1);
  });
});
