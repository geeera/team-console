import { env } from 'cloudflare:test';
import { compactVerify, importJWK } from 'jose';
import type { FetchLike } from '@worker/github';
import type { ApiEnv } from '../env';

/** Test-only: a scripted api.github.com behind the app flow, with sentinel tokens (#9 threat row 3). */

export const INSTALLATION_ID = 777;
// Assembled at run time so the repository's secret scanners never see a token-shaped literal.
export const TOKEN_SENTINEL = ['ghs', 'TESTSENTINEL'].join('_');

export interface GitHubCall {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
}

export type ReadHandler = (call: GitHubCall) => Response | Promise<Response>;

export interface StubGitHub {
  readonly fetch: FetchLike;
  readonly calls: GitHubCall[];
  /** Calls that were not the installation lookup or the mint. */
  readonly reads: () => GitHubCall[];
  readonly minted: () => number;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const INSTALLATION_PATH = /^\/repos\/[^/]+\/[^/]+\/installation$/;

/**
 * Installation lookup, `GET /app` and mint answer like GitHub (tokens `ghs_TESTSENTINEL<n>`); every other request
 * goes to `read`. `installation` replaces the lookup's answer (a 404 for "not installed"), `app` the answer of
 * `GET /app` (a 404 for "GitHub knows no such app"), `installations` the answer of `GET /app/installations` (#194),
 * which otherwise goes to `read` too.
 */
export function stubGitHub(
  read: ReadHandler,
  installation?: () => Response,
  app?: () => Response,
  installations?: () => Response,
): StubGitHub {
  const calls: GitHubCall[] = [];
  let minted = 0;
  const fetch: FetchLike = async (input, init) => {
    const call: GitHubCall = {
      url: new URL(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    if (call.method === 'GET' && INSTALLATION_PATH.test(call.url.pathname)) {
      return installation?.() ?? json(200, { id: INSTALLATION_ID });
    }
    if (call.method === 'GET' && call.url.pathname === '/app') {
      return app?.() ?? json(200, { id: Number(env.GITHUB_APP_ID), slug: 'team-console-test' });
    }
    if (call.method === 'GET' && call.url.pathname === '/app/installations' && installations !== undefined) {
      return installations();
    }
    if (
      call.method === 'POST' &&
      call.url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`
    ) {
      minted += 1;
      return json(201, {
        token: `${TOKEN_SENTINEL}${minted}`,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    }
    return read(call);
  };
  return {
    fetch,
    calls,
    minted: () => minted,
    reads: () =>
      calls.filter(
        (call) =>
          !INSTALLATION_PATH.test(call.url.pathname) &&
          call.url.pathname !== '/app' &&
          !call.url.pathname.startsWith('/app/'),
      ),
  };
}

/** Verifies the app JWT with the generated test key's public half; returns its claims. */
export async function verifyAppJwt(authorization: string | null): Promise<Record<string, unknown>> {
  const jwt = authorization?.replace(/^Bearer /, '') ?? '';
  const key = await importJWK(JSON.parse(env.TEST_GITHUB_APP_PUBLIC_JWK) as Record<string, unknown>, 'RS256');
  const { payload } = await compactVerify(jwt, key);
  return JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
}

/** Local bindings as the pool sets them (auth bypass, generated app key), with overrides. */
export function localEnv(
  overrides: Partial<Record<keyof ApiEnv, string | undefined>> &
    Readonly<Record<string, string | undefined>> = {},
): ApiEnv {
  return { ...env, ...overrides } as ApiEnv;
}

/** D1 storage is isolated per spec file, not per test: each test starts from an empty registry. */
export async function resetProjects(): Promise<void> {
  await env.DB.prepare('DELETE FROM projects').run();
}

export async function seedProject(slug: string, repo: string, epoch = 0): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at) VALUES (?1, ?2, ?3, ?4, ?5)',
  )
    .bind(slug, repo, slug, epoch, '2026-09-30T00:00:00Z')
    .run();
}
