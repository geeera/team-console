import fixtures from '../../fixtures/mock-github.json';
import {
  INSTALLATION_LIST_PERMISSIONS,
  INSTALLATION_PERMISSIONS,
  type GitHubAppCredentials,
} from './app-auth';
import type { OwnerAccount } from './token-source';
import { GITHUB_API_ORIGIN, type FetchLike } from './transport';

/**
 * Mock mode for local runs and e2e (`GITHUB_MOCK=true`): a stand-in for api.github.com that the real code path
 * talks to — the JWT is signed with a key generated here and checked, the installation is looked up, the
 * token is minted with the downscoped body and checked, then scoped to its one repository. Only the transport
 * and the key are fake. Honoured only when `ENVIRONMENT === 'local'` (#9 threat row 7).
 */

export interface MockReply {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface MockRepository {
  readonly installationId: number;
  /** What `GET /repos/{owner}/{repo}` answers. */
  readonly repository?: Readonly<Record<string, unknown>>;
  /** Replaces that answer, to exercise an error row locally. */
  readonly reply?: MockReply;
  /** Text files `GET /repos/{owner}/{repo}/contents/{path}` serves, by path (e.g. `.product-team/project.yml`). */
  readonly files?: Readonly<Record<string, string>>;
  /**
   * Binary files (#277: design images), base64 by path. Listed with `files` by `GET …/git/trees/{sha}?recursive=1`
   * (every sha answers the same tree) and read by blob sha through `GET …/git/blobs/{sha}` with the raw media type.
   */
  readonly binaryFiles?: Readonly<Record<string, string>>;
  /**
   * Issues as GitHub sends them (pull requests included), newest first: `GET …/issues?state=&milestone=` lists
   * them, `GET …/issues/{number}` (the answer route, #10) reads one, `GET …/issues/{number}/comments` (the run log,
   * #114) answers its thread from `comments`, an empty one for an issue not listed there.
   */
  readonly issues?: readonly Readonly<Record<string, unknown>>[];
  /** Comments as GitHub sends them, oldest first, by issue number (the run log #22 on the board, #132). */
  readonly comments?: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
  /**
   * `GET …/issues/{number}/events` by issue number, oldest first (#193: the fixture label's history the service
   * identity's gate reads); an issue listed in `issues` without an entry has no events.
   */
  readonly issueEvents?: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
  /** `GET …/milestones?state=` */
  readonly milestones?: readonly Readonly<Record<string, unknown>>[];
  /** `GET …/pulls?state=` */
  readonly pulls?: readonly Readonly<Record<string, unknown>>[];
  /** `GET …/commits/{sha}/check-runs` (#131), by head sha; a sha not listed has no check runs. */
  readonly checkRuns?: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
}

export interface MockFixtures {
  readonly repositories: Readonly<Record<string, MockRepository>>;
}

export interface MockGitHub {
  readonly credentials: GitHubAppCredentials;
  readonly fetch: FetchLike;
}

export const MOCK_APP_ID = '424242';

/**
 * The connected owner of the mock world: the owner of its fixture repositories. Mock mode has no OAuth, so a local
 * `GITHUB_MOCK=true` run treats this account as connected (never outside ENVIRONMENT=local).
 */
export const MOCK_OWNER_ACCOUNT: OwnerAccount = Object.freeze({ login: 'geeera', userId: 100001 });

const TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const DEFAULT_FIXTURES: MockFixtures = fixtures;

export function isGitHubMockEnabled(env: {
  readonly ENVIRONMENT: string;
  readonly GITHUB_MOCK?: string;
}): boolean {
  return env.ENVIRONMENT === 'local' && env.GITHUB_MOCK === 'true';
}

function base64Of(bytes: ArrayBuffer | Uint8Array): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function bytesOfBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (char) =>
    char.charCodeAt(0),
  );
}

/** A 40-hex object name for the mock's trees and blobs (SHA-1 of a label, never of real content). */
async function sha1Hex(label: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(label));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const notFound = (): Response => json(404, { message: 'Not Found' });

function labelNamesOf(item: Readonly<Record<string, unknown>>): string[] {
  const labels = item['labels'];
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels.map((label: unknown) =>
    typeof label === 'string'
      ? label
      : typeof label === 'object' && label !== null
        ? String((label as Record<string, unknown>)['name'])
        : '',
  );
}

/** One page (the fixtures stay under 100 items) of a list, filtered by `state` and `milestone` as GitHub does. */
function listOf(
  fixture: MockRepository,
  list: 'issues' | 'milestones' | 'pulls',
  query: URLSearchParams,
): readonly Readonly<Record<string, unknown>>[] {
  const items = fixture[list] ?? [];
  const state = query.get('state') ?? 'open';
  const milestone = query.get('milestone');
  // GitHub's `labels=a,b` lists items carrying every one of them.
  const labels = (query.get('labels') ?? '').split(',').filter((label) => label !== '');
  return items.filter((item) => {
    if (state !== 'all' && item['state'] !== state) {
      return false;
    }
    if (labels.length > 0 && !labels.every((label) => labelNamesOf(item).includes(label))) {
      return false;
    }
    if (milestone === null) {
      return true;
    }
    const assigned = item['milestone'];
    return (
      typeof assigned === 'object' &&
      assigned !== null &&
      String((assigned as Record<string, unknown>)['number']) === milestone
    );
  });
}

/** A per-repository read token, or the installation-wide `metadata` token of the repository list (#194). */
type IssuedToken =
  | { readonly scope: 'repo'; readonly repo: string; readonly expiresAt: number }
  | { readonly scope: 'installation'; readonly installationId: number; readonly expiresAt: number };

const LIST_PAGE_MAX = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `owner.id`/`owner.login` of a fixture's `GET /repos/{owner}/{repo}` answer, when it has one. */
function ownerOf(fixture: MockRepository): { id: number; login: string } | null {
  const owner = fixture.repository?.['owner'];
  if (!isRecord(owner) || typeof owner['id'] !== 'number' || typeof owner['login'] !== 'string') {
    return null;
  }
  return { id: owner['id'], login: owner['login'] };
}

/** A positive integer query value, or the fallback. */
function positiveIntOf(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return value !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

class MockGitHubServer {
  private readonly issued = new Map<string, IssuedToken>();

  constructor(
    private readonly fixtures: MockFixtures,
    private readonly publicKey: CryptoKey,
  ) {}

  async handle(input: string, init: RequestInit): Promise<Response> {
    const url = new URL(input);
    if (url.origin !== GITHUB_API_ORIGIN) {
      throw new TypeError('the mock GitHub serves api.github.com only');
    }
    const method = init.method ?? 'GET';
    const bearer = /^Bearer (\S+)$/.exec(new Headers(init.headers).get('authorization') ?? '')?.[1] ?? '';
    const segments = url.pathname.split('/').slice(1).map(decodeURIComponent);

    if (
      method === 'GET' &&
      segments.length === 4 &&
      segments[0] === 'repos' &&
      segments[3] === 'installation'
    ) {
      if (!(await this.isValidJwt(bearer))) {
        return json(401, { message: 'A JSON web token could not be decoded' });
      }
      const found = this.repository(`${segments[1]}/${segments[2]}`);
      return found === undefined ? notFound() : json(200, { id: found.fixture.installationId });
    }

    if (method === 'GET' && url.pathname === '/app') {
      return (await this.isValidJwt(bearer))
        ? json(200, { id: Number(MOCK_APP_ID), slug: 'team-console-local' })
        : json(401, { message: 'A JSON web token could not be decoded' });
    }

    if (method === 'GET' && url.pathname === '/app/installations') {
      return (await this.isValidJwt(bearer))
        ? json(200, this.installations())
        : json(401, { message: 'A JSON web token could not be decoded' });
    }

    if (method === 'GET' && url.pathname === '/installation/repositories') {
      return this.installationRepositories(bearer, url);
    }

    if (
      method === 'POST' &&
      segments.length === 4 &&
      segments[0] === 'app' &&
      segments[1] === 'installations' &&
      segments[3] === 'access_tokens'
    ) {
      if (!(await this.isValidJwt(bearer))) {
        return json(401, { message: 'A JSON web token could not be decoded' });
      }
      return this.mint(Number(segments[2]), typeof init.body === 'string' ? init.body : '');
    }

    const isRepositoryRead = segments.length === 3;
    const isContentsRead = segments.length > 4 && segments[3] === 'contents';
    const listed = segments.length === 4 ? segments[3] : undefined;
    const isListRead = listed === 'issues' || listed === 'milestones' || listed === 'pulls';
    const isIssueRead = segments.length === 5 && segments[3] === 'issues';
    const isCommentsRead = segments.length === 6 && segments[3] === 'issues' && segments[5] === 'comments';
    const isEventsRead = segments.length === 6 && segments[3] === 'issues' && segments[5] === 'events';
    const isCheckRunsRead =
      segments.length === 6 && segments[3] === 'commits' && segments[5] === 'check-runs';
    const isTreeRead = segments.length === 6 && segments[3] === 'git' && segments[4] === 'trees';
    const isBlobRead = segments.length === 6 && segments[3] === 'git' && segments[4] === 'blobs';
    const isBranchRead = segments.length === 5 && segments[3] === 'branches';
    if (
      method === 'GET' &&
      segments[0] === 'repos' &&
      (isRepositoryRead ||
        isContentsRead ||
        isListRead ||
        isIssueRead ||
        isCommentsRead ||
        isEventsRead ||
        isCheckRunsRead ||
        isTreeRead ||
        isBlobRead ||
        isBranchRead)
    ) {
      const repo = `${segments[1]}/${segments[2]}`;
      const token = this.issued.get(bearer);
      if (token === undefined || token.expiresAt <= Date.now()) {
        return json(401, { message: 'Bad credentials' });
      }
      // A test tripwire, not GitHub's behaviour (GitHub answers metadata reads): the list token reads nothing else.
      if (token.scope === 'installation') {
        return json(403, { message: 'mock: the installation list token must not read a repository' });
      }
      const found = this.repository(repo);
      // A downscoped token sees only its own repository; GitHub answers 404 for the rest.
      if (found === undefined || found.name.toLowerCase() !== token.repo.toLowerCase()) {
        return notFound();
      }
      const reply = found.fixture.reply;
      if (reply !== undefined) {
        return json(reply.status, { message: 'mock reply' }, { ...reply.headers });
      }
      if (isContentsRead) {
        return this.file(found.fixture, segments.slice(4).join('/'), found.name);
      }
      if (isListRead) {
        return json(200, listOf(found.fixture, listed, url.searchParams));
      }
      if (isIssueRead) {
        return this.issue(found.fixture, segments[4] ?? '');
      }
      if (isCheckRunsRead) {
        const runs = found.fixture.checkRuns?.[segments[4] ?? ''] ?? [];
        return json(200, { total_count: runs.length, check_runs: runs });
      }
      if (isTreeRead) {
        return this.tree(found.fixture, segments[5] ?? '');
      }
      if (isBlobRead) {
        return this.blob(found.fixture, segments[5] ?? '', new Headers(init.headers).get('accept') ?? '');
      }
      if (isBranchRead) {
        return this.branch(found.fixture, segments[4] ?? '');
      }
      if (isCommentsRead) {
        const issue = this.issue(found.fixture, segments[4] ?? '');
        await issue.body?.cancel();
        return issue.ok ? json(200, found.fixture.comments?.[segments[4] ?? ''] ?? []) : notFound();
      }
      if (isEventsRead) {
        const number = segments[4] ?? '';
        const issue = this.issue(found.fixture, number);
        await issue.body?.cancel();
        return issue.ok ? json(200, found.fixture.issueEvents?.[number] ?? []) : notFound();
      }
      return found.fixture.repository === undefined ? notFound() : json(200, found.fixture.repository);
    }

    return notFound();
  }

  /**
   * The contents API's answer for a file (base64 content, as GitHub sends it) or, for a folder that holds fixture
   * files, its listing: one entry per file or sub-folder directly inside it.
   */
  private file(fixture: MockRepository, path: string, repo: string): Response {
    const text = fixture.files?.[path];
    if (text === undefined) {
      return this.listing(fixture, path, repo);
    }
    const bytes = new TextEncoder().encode(text);
    return json(200, {
      type: 'file',
      encoding: 'base64',
      path,
      size: bytes.byteLength,
      content: base64Of(bytes),
    });
  }

  private listing(fixture: MockRepository, path: string, repo: string): Response {
    const prefix = `${path}/`;
    const entries = new Map<string, { name: string; path: string; type: 'file' | 'dir' }>();
    for (const file of Object.keys(fixture.files ?? {})) {
      if (!file.startsWith(prefix)) {
        continue;
      }
      const [name = '', ...rest] = file.slice(prefix.length).split('/');
      const type = rest.length === 0 ? 'file' : 'dir';
      entries.set(name, { name, path: `${prefix}${name}`, type });
    }
    if (entries.size === 0) {
      return notFound();
    }
    return json(
      200,
      [...entries.values()].map((entry) => ({
        ...entry,
        html_url: `https://github.com/${repo}/${entry.type === 'file' ? 'blob' : 'tree'}/dev/${entry.path}`,
      })),
    );
  }

  /** Every file of the fixture as a blob (path, bytes); `sha` is derived from the path, so it is stable per run. */
  private async blobs(fixture: MockRepository): Promise<{ path: string; sha: string; bytes: Uint8Array }[]> {
    const texts = Object.entries(fixture.files ?? {}).map(([path, text]) => ({
      path,
      bytes: new TextEncoder().encode(text),
    }));
    const binaries = Object.entries(fixture.binaryFiles ?? {}).map(([path, base64]) => ({
      path,
      bytes: Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
    }));
    return Promise.all(
      [...texts, ...binaries].map(async (file) => ({ ...file, sha: await sha1Hex(`blob:${file.path}`) })),
    );
  }

  /**
   * `GET …/git/trees/{sha}?recursive=1` (#277): one listing whatever the sha, as the fixtures hold one snapshot.
   * An unknown-looking sha (not hex) is GitHub's 404 for a tree it does not have.
   */
  private async tree(fixture: MockRepository, sha: string): Promise<Response> {
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return notFound();
    }
    const blobs = await this.blobs(fixture);
    return json(200, {
      sha,
      tree: blobs.map((blob) => ({ path: blob.path, mode: '100644', type: 'blob', sha: blob.sha, size: blob.bytes.byteLength })),
      truncated: false,
    });
  }

  /** `GET …/git/blobs/{sha}`: raw bytes for the raw media type, else GitHub's base64 JSON. */
  private async blob(fixture: MockRepository, sha: string, accept: string): Promise<Response> {
    const found = (await this.blobs(fixture)).find((blob) => blob.sha === sha);
    if (found === undefined) {
      return notFound();
    }
    if (accept.includes('raw')) {
      return new Response(found.bytes, { status: 200, headers: { 'Content-Type': 'application/vnd.github.raw' } });
    }
    return json(200, { sha, size: found.bytes.byteLength, encoding: 'base64', content: base64Of(found.bytes) });
  }

  /** `GET …/branches/{name}` (#277): the default branch with a head sha derived from its name. */
  private async branch(fixture: MockRepository, name: string): Promise<Response> {
    if (fixture.repository?.['default_branch'] !== name) {
      return notFound();
    }
    return json(200, { name, commit: { sha: await sha1Hex(`branch:${name}`) } });
  }

  /** An issue as GitHub sends it: labels as objects. */
  private issue(fixture: MockRepository, number: string): Response {
    const issue = fixture.issues?.find((item) => String(item['number']) === number);
    return issue === undefined ? notFound() : json(200, issue);
  }

  /**
   * `GET /app/installations`: one entry per installation id in the fixtures, its account the owner of the first
   * repository on it that names one. An installation whose fixtures name no owner is not listed.
   */
  private installations(): { id: number; account: { id: number; login: string; type: 'User' } }[] {
    const accounts = new Map<number, { id: number; login: string }>();
    for (const fixture of Object.values(this.fixtures.repositories)) {
      const owner = ownerOf(fixture);
      if (owner !== null && !accounts.has(fixture.installationId)) {
        accounts.set(fixture.installationId, owner);
      }
    }
    return [...accounts.entries()].map(([id, owner]) => ({
      id,
      account: { id: owner.id, login: owner.login, type: 'User' },
    }));
  }

  /**
   * `GET /installation/repositories` with the list token: the installation's fixtures, `per_page`/`page` honoured
   * with a `Link: rel="next"`. A per-repository token gets 403 — a tripwire, since GitHub would list its one
   * repository and a wrong token source would pass unnoticed.
   */
  private installationRepositories(bearer: string, url: URL): Response {
    const token = this.issued.get(bearer);
    if (token === undefined || token.expiresAt <= Date.now()) {
      return json(401, { message: 'Bad credentials' });
    }
    if (token.scope !== 'installation') {
      return json(403, { message: 'mock: a per-repository token must not list the installation' });
    }
    const all = Object.entries(this.fixtures.repositories)
      .filter(([, fixture]) => fixture.installationId === token.installationId)
      .map(([name, fixture]) => ({
        id: typeof fixture.repository?.['id'] === 'number' ? fixture.repository['id'] : 0,
        full_name:
          typeof fixture.repository?.['full_name'] === 'string' ? fixture.repository['full_name'] : name,
        private: fixture.repository?.['private'] === true,
      }));
    const perPage = Math.min(positiveIntOf(url.searchParams.get('per_page'), 30), LIST_PAGE_MAX);
    const page = positiveIntOf(url.searchParams.get('page'), 1);
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    if (page * perPage < all.length) {
      headers['link'] =
        `<${GITHUB_API_ORIGIN}/installation/repositories?per_page=${perPage}&page=${page + 1}>; rel="next"`;
    }
    return json(200, { total_count: all.length, repositories: slice }, headers);
  }

  private repository(fullName: string): { name: string; fixture: MockRepository } | undefined {
    const wanted = fullName.toLowerCase();
    for (const [name, fixture] of Object.entries(this.fixtures.repositories)) {
      if (name.toLowerCase() === wanted) {
        return { name, fixture };
      }
    }
    return undefined;
  }

  private mint(installationId: number, rawBody: string): Response {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json(400, { message: 'Problems parsing JSON' });
    }
    const request = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const repositories = request['repositories'];
    const onInstallation = Object.entries(this.fixtures.repositories).filter(
      ([, fixture]) => fixture.installationId === installationId,
    );
    if (onInstallation.length === 0) {
      return notFound();
    }
    // #194: the installation-wide list token — no `repositories` member and exactly `metadata: read`.
    if (
      !('repositories' in request) &&
      JSON.stringify(request['permissions']) === JSON.stringify(INSTALLATION_LIST_PERMISSIONS)
    ) {
      return this.issue201({
        scope: 'installation',
        installationId,
        expiresAt: Date.now() + TOKEN_LIFETIME_MS,
      });
    }
    const target =
      Array.isArray(repositories) && repositories.length === 1 && typeof repositories[0] === 'string'
        ? onInstallation.find(
            ([name]) => name.split('/')[1]?.toLowerCase() === String(repositories[0]).toLowerCase(),
          )
        : undefined;
    // The console must always downscope: one repository, exactly the read-only permission set.
    if (
      target === undefined ||
      JSON.stringify(request['permissions']) !== JSON.stringify(INSTALLATION_PERMISSIONS)
    ) {
      return json(422, { message: 'The console must mint read-only tokens for exactly one repository' });
    }
    return this.issue201({ scope: 'repo', repo: target[0], expiresAt: Date.now() + TOKEN_LIFETIME_MS });
  }

  private issue201(issued: IssuedToken): Response {
    const token = `ghs_mock${crypto.randomUUID().replace(/-/g, '')}`;
    this.issued.set(token, issued);
    return json(201, {
      token,
      expires_at: new Date(issued.expiresAt).toISOString(),
      permissions: issued.scope === 'repo' ? INSTALLATION_PERMISSIONS : INSTALLATION_LIST_PERMISSIONS,
      repository_selection: issued.scope === 'repo' ? 'selected' : 'all',
    });
  }

  private async isValidJwt(jwt: string): Promise<boolean> {
    const [header, claims, signature, extra] = jwt.split('.');
    if (header === undefined || claims === undefined || signature === undefined || extra !== undefined) {
      return false;
    }
    try {
      const signed = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        this.publicKey,
        bytesOfBase64Url(signature),
        new TextEncoder().encode(`${header}.${claims}`),
      );
      const payload = JSON.parse(new TextDecoder().decode(bytesOfBase64Url(claims))) as Record<
        string,
        unknown
      >;
      const now = Math.floor(Date.now() / 1000);
      const iat = Number(payload['iat']);
      const exp = Number(payload['exp']);
      return signed && payload['iss'] === MOCK_APP_ID && exp > now && iat <= now && exp - iat <= 600;
    } catch {
      // Malformed base64 or JSON: GitHub answers 401 for such a JWT as well.
      return false;
    }
  }
}

/** A fresh fake GitHub with its own app key; the api Worker keeps one per isolate. */
export async function createMockGitHub(mockFixtures: MockFixtures = DEFAULT_FIXTURES): Promise<MockGitHub> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  if (!('privateKey' in keyPair)) {
    throw new Error('RSA key generation returned a single key');
  }
  const exported = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  if (!(exported instanceof ArrayBuffer)) {
    throw new Error('PKCS#8 export returned no bytes');
  }
  const pkcs8 = base64Of(exported);
  const lines = pkcs8.match(/.{1,64}/g) ?? [];
  const server = new MockGitHubServer(mockFixtures, keyPair.publicKey);
  return {
    credentials: {
      appId: MOCK_APP_ID,
      privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`,
    },
    fetch: async (input, init) => server.handle(input, init),
  };
}
