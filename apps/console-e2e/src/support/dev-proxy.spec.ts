import type { APIRequestContext, APIResponse } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import { isDevProxyDrop, retryingDevProxyDrops } from './dev-proxy';

function response(status: number, body: string): APIResponse {
  return { status: () => status, text: () => Promise.resolve(body) } as unknown as APIResponse;
}

const DROP = response(500, 'Error: Network connection lost.');

describe('isDevProxyDrop', () => {
  it('recognises the proxy’s own 500 for a dropped connection to the Worker', async () => {
    expect(await isDevProxyDrop(DROP)).toBe(true);
    expect(await isDevProxyDrop(response(500, 'Error: Network connection lost\n'))).toBe(true);
  });

  it('leaves every other answer alone, a Worker 500 included', async () => {
    expect(await isDevProxyDrop(response(500, '{"error":"internal"}'))).toBe(false);
    expect(await isDevProxyDrop(response(503, 'Your worker restarted mid-request.'))).toBe(false);
    expect(await isDevProxyDrop(response(201, 'Error: Network connection lost.'))).toBe(false);
  });
});

describe('retryingDevProxyDrops', () => {
  function client(answers: Record<string, APIResponse[]>): { api: APIRequestContext; calls: Record<string, number> } {
    const calls: Record<string, number> = {};
    const method =
      (name: string) =>
      (...args: unknown[]) => {
        calls[name] = (calls[name] ?? 0) + 1;
        const queue = answers[name] ?? [];
        return Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]);
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

    const answer = await retryingDevProxyDrops(api).post('/api/v1/runner/enrol', { data: {} });

    expect(answer).toBe(created);
    expect(calls['post']).toBe(2);
    expect(api.post).toHaveBeenLastCalledWith('/api/v1/runner/enrol', { data: {} });
  });

  it('retries once only: a second drop is the answer', async () => {
    const { api, calls } = client({ put: [DROP, DROP, response(200, 'ok')] });

    expect(await retryingDevProxyDrops(api).put('/x')).toBe(DROP);
    expect(calls['put']).toBe(2);
  });

  it('passes an unrelated 5xx and every 4xx through untouched', async () => {
    const refused = response(422, '{"error":"invalid"}');
    const broken = response(500, '{"error":"internal"}');
    const { api, calls } = client({ post: [refused], delete: [broken] });
    const wrapped = retryingDevProxyDrops(api);

    expect(await wrapped.post('/a')).toBe(refused);
    expect(await wrapped.delete('/b')).toBe(broken);
    expect(calls).toEqual({ post: 1, delete: 1 });
  });

  it('never resends a GET or HEAD (wrangler retries those itself) and keeps dispose', async () => {
    const { api, calls } = client({ get: [DROP], head: [DROP] });
    const wrapped = retryingDevProxyDrops(api);

    expect(await wrapped.get('/a')).toBe(DROP);
    expect(await wrapped.head('/a')).toBe(DROP);
    await wrapped.dispose();
    expect(calls).toEqual({ get: 1, head: 1 });
    expect(api.dispose).toHaveBeenCalledTimes(1);
  });
});
