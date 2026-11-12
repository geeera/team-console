import { env } from 'cloudflare:test';
import {
  isProblemDetails,
  problemSlugOf,
  type AskDto,
  type CreateItemInput,
  type ItemDto,
} from '@shared/contracts';
import { CommentsRepo, ItemsRepo, TrackerProjectsRepo } from '@worker/db';
import {
  SERVICE_TOKEN_ID,
  accessEnv,
  createSigningKey,
  fetchApi,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
} from './access-kit';
import { ApiGitHub } from '../github';
import { json, localEnv, stubGitHub, type GitHubCall, type StubGitHub } from './github-kit';
import { localJobHeader, type TestJob } from './local-job-kit';

/**
 * Test-only kit for the tracker routes (#410). Tracker rows are append-only and reference their project, so every
 * case seeds its own project instead of clearing tables. Requests go through the whole app with the local bypass
 * — the owner, or a job through the local stand-in token (#444) — so the auth seam, CSRF and the route matrix all
 * run.
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
  // Three base-26 letters: a spec file may seed more than 26² projects (the #452 matrices do).
  const letter = (n: number): string => String.fromCharCode(65 + (Math.floor(n) % 26));
  const keyPrefix = `T${letter(counter)}${letter(counter / 26)}${letter(counter / 676)}`;
  await new TrackerProjectsRepo(env.DB).switchTracker(slug, {
    tracker: 'console',
    keyPrefix,
    nextItemNumber,
    at: '2026-11-01T00:00:00.000Z',
  });
  // The provider's id, as setup records it; the pr-link check (#529) reads the repository by it.
  await env.DB.prepare('UPDATE projects SET repo_id = ?2 WHERE slug = ?1')
    .bind(slug, REPO_ID_BASE + counter)
    .run();
  return { slug, keyPrefix };
}

const REPO_ID_BASE = 900_000;

/** The head branch GitHub has for pull request `number`, or `null` when it has no such pull request. */
export type PullRequestHeads = (number: number) => string | null;

/** A response that answers a GitHub call before the scripted world does, or `null` to fall through to it. */
export type ScriptedRead = (call: GitHubCall) => Response | null | Promise<Response | null>;

const REPOSITORY_PATH = /^\/repos\/([^/]+)\/([^/]+)$/;
const PULL_PATH = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/;

/**
 * A scripted GitHub for the pr-link check (#529): every registered repository under its recorded id, and the pull
 * requests `heads` names. `read` answers first when it returns a response (an outage, a rate limit).
 */
export function pullRequestsGitHub(
  heads: PullRequestHeads,
  read?: ScriptedRead,
): { readonly github: ApiGitHub; readonly stub: StubGitHub } {
  const stub = stubGitHub(async (call) => {
    const scripted = (await read?.(call)) ?? null;
    if (scripted !== null) {
      return scripted;
    }
    const repository = REPOSITORY_PATH.exec(call.url.pathname);
    if (repository !== null) {
      const fullName = `${repository[1] ?? ''}/${repository[2] ?? ''}`;
      const row = await env.DB.prepare('SELECT repo_id FROM projects WHERE repo = ?1')
        .bind(fullName)
        .first<{ repo_id: number | null }>();
      return row === null || row.repo_id === null
        ? json(404, { message: 'Not Found' })
        : json(200, { id: row.repo_id, full_name: fullName, default_branch: 'dev', private: true });
    }
    const pull = PULL_PATH.exec(call.url.pathname);
    const number = Number(pull?.[3]);
    const head = pull === null ? null : heads(number);
    if (pull === null || head === null) {
      return json(404, { message: 'Not Found' });
    }
    return json(200, {
      id: 50_000 + number,
      number,
      title: `PR ${String(number)}`,
      state: 'open',
      draft: false,
      head: { ref: head, sha: 'a'.repeat(40), repo: { full_name: `${pull[1] ?? ''}/${pull[2] ?? ''}` } },
      base: { ref: 'dev' },
      user: { login: 'team-console-team' },
      merged_at: null,
      updated_at: '2026-11-12T10:00:00Z',
      html_url: `https://github.com/${pull[1] ?? ''}/${pull[2] ?? ''}/pull/${String(number)}`,
    });
  });
  return { github: new ApiGitHub({ fetch: stub.fetch }), stub };
}

/** The pull request reads a stub served, the repository reads and the token mint left out. */
export function pullRequestReads(stub: StubGitHub): GitHubCall[] {
  return stub.reads().filter((call) => PULL_PATH.test(call.url.pathname));
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
  /** Send as this job (the `local-job.` stand-in) instead of the owner; its project defaults to the path's. */
  readonly job?: TestJob;
  /** The GitHub the app reads through (`pullRequestsGitHub` for a pr link). */
  readonly github?: ApiGitHub;
}

/** A request as the owner's console sends it: same-origin, JSON, a fresh `Idempotency-Key` on writes. */
export async function send(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
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
  if (options.job !== undefined) {
    headers['Authorization'] = localJobHeader(options.job, path);
  }
  return fetchApi(path, localEnv(), {
    method,
    ...(options.github === undefined ? {} : { github: options.github }),
    headers: { ...headers, ...options.headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
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
  table:
    | 'items'
    | 'item_events'
    | 'item_labels'
    | 'comments'
    | 'sprints'
    | 'labels'
    | 'asks'
    | 'owner_decisions'
    | 'item_requests',
  slug: string,
): Promise<number> {
  const where: Record<typeof table, string> = {
    asks: 'project_slug = ?1',
    owner_decisions: 'project_slug = ?1',
    item_requests: 'project_slug = ?1',
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

/** A job of `role` for `send` (#434, #444): sent as the local stand-in token, so the real auth seam mints it. */
export function jobActor(role: string, jobId = 'job-test-1', items: readonly number[] = []): TestJob {
  return { role, jobId, items };
}

export const PM: TestJob = jobActor('pm');

/** An item created by the owner through the API; its key and the API path of the item. */
export async function seedItem(
  project: SeededProject,
  item: Partial<CreateItemInput> = {},
): Promise<{ key: string; path: string }> {
  const response = await send('POST', `/api/v1/projects/${project.slug}/items`, {
    title: 'Item',
    kind: 'question',
    ...item,
  });
  if (response.status !== 201) {
    throw new Error(`seeding an item answered ${String(response.status)}`);
  }
  const { key } = (await response.json()) as ItemDto;
  return { key, path: `/api/v1/projects/${project.slug}/items/${key}` };
}

/** An ask written by the PM job through the API (#434). */
export async function seedAsk(
  itemPath: string,
  ask: { category?: string; ask?: string; commands?: string[]; recommended?: string | null } = {},
): Promise<AskDto> {
  const response = await send(
    'POST',
    `${itemPath}/asks`,
    { category: 'scope', ask: 'Ship it now?', commands: ['approve', 'reject'], ...ask },
    { job: PM },
  );
  if (response.status !== 201) {
    throw new Error(`seeding an ask answered ${String(response.status)}`);
  }
  return (await response.json()) as AskDto;
}

/** A GitHub-era open ask as the import writer (Phase 1b) will store it: `source = 'import'`. */
export async function seedImportedAsk(slug: string, itemNumber: number): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO asks (project_slug, item_id, category, ask, commands, created_at, source)
     SELECT ?1, id, 'scope', 'Imported question?', '["approve","reject"]', '2026-11-01T00:00:00.000Z', 'import'
     FROM items WHERE project_slug = ?1 AND number = ?2 RETURNING id`,
  )
    .bind(slug, itemNumber)
    .first<{ id: number }>();
  if (row === null) {
    throw new Error('seeding an imported ask found no item');
  }
  return row.id;
}

/** A team decision (`comments.kind = 'decision'`, formerly `backlog decide`) on the item, by a job. */
export async function seedTeamDecision(slug: string, itemNumber: number): Promise<number> {
  const item = await new ItemsRepo(env.DB).findByNumber(slug, itemNumber);
  if (item === null) {
    throw new Error('seeding a team decision found no item');
  }
  return new CommentsRepo(env.DB).create(
    item.id,
    { kind: 'decision', body: 'We ship without the export' },
    { kind: 'job', name: 'architect', jobId: 'job-test-2' },
    '2026-11-01T00:00:00.000Z',
  );
}
