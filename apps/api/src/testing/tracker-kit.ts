import { env } from 'cloudflare:test';
import { isProblemDetails, problemSlugOf } from '@shared/contracts';
import { TrackerProjectsRepo } from '@worker/db';
import type { PolicyActor } from '../auth/policy';
import {
  SERVICE_TOKEN_ID,
  accessEnv,
  createSigningKey,
  fetchApi,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
} from './access-kit';
import { localEnv } from './github-kit';

/**
 * Test-only kit for the tracker routes (#410). Tracker rows are append-only and reference their project, so every
 * case seeds its own project instead of clearing tables. Requests go through the whole app with the local bypass
 * (the owner), so the auth seam, CSRF and the owner-only gate all run.
 */

let counter = 0;

export interface SeededProject {
  readonly slug: string;
  readonly keyPrefix: string;
}

/** A registered project still on GitHub Issues. */
export async function seedGitHubProject(): Promise<string> {
  counter += 1;
  const slug = `t${String(counter)}-${crypto.randomUUID().slice(0, 6)}`;
  await env.DB.prepare(
    'INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at) VALUES (?1, ?2, ?3, 0, ?4)',
  )
    .bind(slug, `acme/${slug}`, slug, '2026-11-01T00:00:00Z')
    .run();
  return slug;
}

/** A project on the console's tracker, its builtin labels seeded, items numbered from `nextItemNumber`. */
export async function seedTrackerProject(nextItemNumber = 1): Promise<SeededProject> {
  const slug = await seedGitHubProject();
  const keyPrefix = `T${String.fromCharCode(65 + (counter % 26))}${String.fromCharCode(65 + Math.floor(counter / 26))}`;
  await new TrackerProjectsRepo(env.DB).switchTracker(slug, {
    tracker: 'console',
    keyPrefix,
    nextItemNumber,
    at: '2026-11-01T00:00:00.000Z',
  });
  return { slug, keyPrefix };
}

let keyCounter = 0;

export function newKey(): string {
  keyCounter += 1;
  return `key-${String(keyCounter)}-${crypto.randomUUID()}`;
}

export interface TrackerRequest {
  readonly key?: string | null;
  readonly ifMatch?: string;
  readonly headers?: Record<string, string>;
  readonly policyActor?: PolicyActor;
}

/** A request as the owner's console sends it: same-origin, JSON, a fresh `Idempotency-Key` on writes. */
export async function send(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  options: TrackerRequest = {},
): Promise<Response> {
  const headers: Record<string, string> =
    method === 'GET' ? {} : { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
  const key = options.key === undefined ? newKey() : options.key;
  if (method !== 'GET' && key !== null) {
    headers['Idempotency-Key'] = key;
  }
  if (options.ifMatch !== undefined) {
    headers['If-Match'] = options.ifMatch;
  }
  const policyActor = options.policyActor;
  return fetchApi(path, localEnv(), {
    method,
    headers: { ...headers, ...options.headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    ...(policyActor === undefined ? {} : { trackerPolicyActorOf: () => policyActor }),
  });
}

export async function slugOf(response: Response): Promise<string | null> {
  const body: unknown = await response.clone().json();
  return isProblemDetails(body) ? problemSlugOf(body.type) : null;
}

/** The same request as the dev/stage CI service token: it passes Access, never the owner-only gate. */
export async function sendAsService(method: string, path: string, body?: unknown): Promise<Response> {
  const jwks = stubJwksServer();
  const teamDomain = uniqueTeamDomain();
  const key = await createSigningKey();
  jwks.set(teamDomain, { keys: [key.publicJwk] });
  const token = await signAccessToken(key, teamDomain, {
    claims: { email: undefined, common_name: SERVICE_TOKEN_ID },
  });
  return fetchApi(path, accessEnv(teamDomain), {
    method,
    headers: {
      'Cf-Access-Jwt-Assertion': token,
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
      'Idempotency-Key': newKey(),
    },
    ...(body === undefined || method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
}

/** The same request with no Access token at all: the auth seam answers before any route. */
export async function sendWithoutIdentity(method: string, path: string): Promise<Response> {
  return fetchApi(path, accessEnv(uniqueTeamDomain()), {
    method,
    headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: '{}' }),
  });
}

export async function countRows(
  table: 'items' | 'item_events' | 'item_labels' | 'comments' | 'sprints' | 'labels',
  slug: string,
): Promise<number> {
  const where: Record<typeof table, string> = {
    items: 'project_slug = ?1',
    sprints: 'project_slug = ?1',
    labels: 'project_slug = ?1',
    item_labels: 'project_slug = ?1',
    item_events: 'item_id IN (SELECT id FROM items WHERE project_slug = ?1)',
    comments: 'item_id IN (SELECT id FROM items WHERE project_slug = ?1)',
  };
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where[table]}`)
    .bind(slug)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
