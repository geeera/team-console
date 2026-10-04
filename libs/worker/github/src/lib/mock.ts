import fixtures from '../../fixtures/mock-github.json';
import { INSTALLATION_PERMISSIONS, type GitHubAppCredentials } from './app-auth';
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
   * Issues as GitHub sends them (pull requests included), newest first: `GET …/issues?state=&milestone=` lists
   * them, `GET …/issues/{number}` (the answer route, #10) reads one, `GET …/issues/{number}/comments` (the run log,
   * #114) answers an empty thread for any of them.
   */
  readonly issues?: readonly Readonly<Record<string, unknown>>[];
  /** `GET …/milestones?state=` */
  readonly milestones?: readonly Readonly<Record<string, unknown>>[];
  /** `GET …/pulls?state=` */
  readonly pulls?: readonly Readonly<Record<string, unknown>>[];
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

interface IssuedToken {
  readonly repo: string;
  readonly expiresAt: number;
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
    if (
      method === 'GET' &&
      segments[0] === 'repos' &&
      (isRepositoryRead || isContentsRead || isListRead || isIssueRead || isCommentsRead)
    ) {
      const repo = `${segments[1]}/${segments[2]}`;
      const token = this.issued.get(bearer);
      if (token === undefined || token.expiresAt <= Date.now()) {
        return json(401, { message: 'Bad credentials' });
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
      if (isCommentsRead) {
        const issue = this.issue(found.fixture, segments[4] ?? '');
        await issue.body?.cancel();
        return issue.ok ? json(200, []) : notFound();
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

  /** An issue as GitHub sends it: labels as objects. */
  private issue(fixture: MockRepository, number: string): Response {
    const issue = fixture.issues?.find((item) => String(item['number']) === number);
    return issue === undefined ? notFound() : json(200, issue);
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
    const token = `ghs_mock${crypto.randomUUID().replace(/-/g, '')}`;
    const expiresAt = Date.now() + TOKEN_LIFETIME_MS;
    this.issued.set(token, { repo: target[0], expiresAt });
    return json(201, {
      token,
      expires_at: new Date(expiresAt).toISOString(),
      permissions: INSTALLATION_PERMISSIONS,
      repository_selection: 'selected',
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
