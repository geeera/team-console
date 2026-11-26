import fixtures from '../../fixtures/mock-github.json';
import {
  INSTALLATION_LIST_PERMISSIONS,
  INSTALLATION_PERMISSIONS,
  type GitHubAppCredentials,
} from './app-auth';
import { SCOPED_MINT_KINDS, SCOPED_MINT_PERMISSIONS, type ScopedMintKind } from './scoped-mint';
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
   * #759: text files of another ref (a PR's head commit), by ref and path; `?ref=` names it. A ref not listed here
   * serves `files`, as the one snapshot the mock holds.
   */
  readonly refFiles?: Readonly<Record<string, Readonly<Record<string, string>>>>;
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
  /**
   * `GET …/milestones?state=`. A milestone may carry `due_in_days` instead of `due_on` (#382): it is served with
   * `due_on` at midnight UTC that many days from the day of the read, so the mock's current sprint never expires.
   */
  readonly milestones?: readonly Readonly<Record<string, unknown>>[];
  /**
   * `GET …/pulls?state=&base=` (paged by `per_page`/`page` with a `Link: rel="next"`, #463) and `GET …/pulls/{number}`,
   * which reads one whatever its state.
   */
  readonly pulls?: readonly Readonly<Record<string, unknown>>[];
  /** `GET …/pulls/{number}/files` by pull request number (#463); a listed pull request without an entry has none. */
  readonly pullFiles?: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
  /** `GET …/commits/{sha}/check-runs` (#131), by head sha; a sha not listed has no check runs. */
  readonly checkRuns?: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
  /**
   * #670: the installation grants `actions: write` on this repository, so an Actions dispatch mint by its
   * `repository.id` succeeds and `POST …/actions/workflows/team-console-runner.yml/dispatches` answers 200 with a fresh
   * `workflow_run_id` (204 without `return_run_details`); without it
   * the mint answers 422, as GitHub does for a permission the installation lacks.
   */
  readonly actionsWrite?: boolean;
  /**
   * #759: the installation accepted Environments: read on this repository, so an `environment-read` mint by its id
   * succeeds; without it the mint answers 422. `GET /app/installations/{id}` lists the permissions of the
   * installation's first repository in the fixtures.
   */
  readonly environmentsRead?: boolean;
  /**
   * #759: the installation accepted Contents, Workflows and Pull requests write on this repository, so a `workflow-pr`
   * mint by its id succeeds; without it the mint answers 422. With that token the mock takes the setup's writes and
   * remembers them for the life of the mock: `POST …/git/refs` (a new branch at the default branch's head; 422 when
   * the name is taken), `PUT …/contents/{path}` on a branch created that way, `POST …/pulls` from it and
   * `PATCH …/pulls/{number}`. A write that names no branch, the default branch or a ref the mock did not create is a
   * tripwire (403): the console must make none.
   */
  readonly setupWrite?: boolean;
  /**
   * #759: the repository's GitHub Environments by name. `GET …/environments/{name}` answers `environment` (with `name`
   * added), `…/deployment-branch-policies` lists `branchPolicies`, and `…/secrets/{secret}` is 200 for a name in
   * `secrets`. The secrets list and every `…/variables` path are tripwires: the console reads neither.
   */
  readonly environments?: Readonly<Record<string, MockEnvironment>>;
}

export interface MockEnvironment {
  readonly environment?: Readonly<Record<string, unknown>>;
  readonly branchPolicies?: readonly Readonly<Record<string, unknown>>[];
  /** Secret names only: GitHub never returns a value, and the mock holds none. */
  readonly secrets?: readonly string[];
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
/** The fixture world `createMockGitHub` serves by default; a spec extends it with repositories of its own. */
export const MOCK_FIXTURES: MockFixtures = fixtures;

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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A fixture milestone as GitHub would send it on `nowMs` (#382): `due_in_days` becomes `due_on`, midnight UTC of
 * that many days after the UTC day of `nowMs`; a milestone with a fixed `due_on` is served as written.
 */
export function milestoneAt(
  milestone: Readonly<Record<string, unknown>>,
  nowMs: number,
): Readonly<Record<string, unknown>> {
  const { due_in_days: dueInDays, ...rest } = milestone;
  if (typeof dueInDays !== 'number' || !Number.isSafeInteger(dueInDays)) {
    return milestone;
  }
  const day = new Date(Math.floor(nowMs / DAY_MS) * DAY_MS + dueInDays * DAY_MS);
  return { ...rest, due_on: `${day.toISOString().slice(0, 10)}T00:00:00Z` };
}

/** A list filtered by `state`, `labels`, `milestone` and (pull requests) `base` as GitHub does, before paging. */
function listOf(
  fixture: MockRepository,
  list: 'issues' | 'milestones' | 'pulls',
  query: URLSearchParams,
): readonly Readonly<Record<string, unknown>>[] {
  const items =
    list === 'milestones'
      ? (fixture.milestones ?? []).map((milestone) => milestoneAt(milestone, Date.now()))
      : (fixture[list] ?? []);
  const state = query.get('state') ?? 'open';
  const milestone = query.get('milestone');
  // GitHub's `labels=a,b` lists items carrying every one of them.
  const labels = (query.get('labels') ?? '').split(',').filter((label) => label !== '');
  const base = list === 'pulls' ? query.get('base') : null;
  // #759: GitHub's `head=<owner>:<branch>`; a fixture names the head's owner in `head.repo.owner.login`.
  const head = list === 'pulls' ? query.get('head') : null;
  return items.filter((item) => {
    const itemBase = item['base'];
    if (base !== null && !(isRecord(itemBase) && itemBase['ref'] === base)) {
      return false;
    }
    if (head !== null && headLabelOf(item) !== head) {
      return false;
    }
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

/** `<owner>:<ref>` of a pull request fixture's head, as GitHub's `head` filter matches it. */
function headLabelOf(item: Readonly<Record<string, unknown>>): string | null {
  const head = item['head'];
  if (!isRecord(head) || typeof head['ref'] !== 'string') {
    return null;
  }
  const repo = head['repo'];
  const owner = isRecord(repo) && isRecord(repo['owner']) ? repo['owner']['login'] : undefined;
  return typeof owner === 'string' ? `${owner}:${head['ref']}` : null;
}

/** A per-repository read token, or the installation-wide `metadata` token of the repository list (#194). */
type IssuedToken =
  | { readonly scope: 'repo'; readonly repo: string; readonly expiresAt: number }
  | {
      readonly scope: 'scoped';
      readonly kind: ScopedMintKind;
      readonly repo: string;
      readonly repositoryId: number;
      readonly expiresAt: number;
    }
  | { readonly scope: 'installation'; readonly installationId: number; readonly expiresAt: number };

const LIST_PAGE_MAX = 100;

/** A branch the console created through the mock (#759), with the files committed to it and its head commit. */
interface WrittenBranch {
  headSha: string;
  commits: number;
  readonly files: Map<string, string>;
}

/** What the setup's writes left on one repository: its created branches and the pull requests opened from them. */
interface WrittenState {
  readonly branches: Map<string, WrittenBranch>;
  readonly pulls: Record<string, unknown>[];
}

function parsedBody(body: RequestInit['body']): Record<string, unknown> | null {
  if (typeof body !== 'string') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : null;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

const tripwire = (message: string): Response => json(403, { message: `mock: ${message}` });

function dispatchBodyAsksForRun(body: RequestInit['body']): boolean {
  if (typeof body !== 'string') {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) && parsed['return_run_details'] === true;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return false;
    }
    throw error;
  }
}

/** A run id no other mock dispatch has handed out: random, since a local D1 outlives the isolate that holds a mock. */
function mockRunId(): number {
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint32Array(2));
  // Below 2^53 (a safe integer, as GitHub's int64 ids are in practice) and never 0.
  return (high % 0x1fffff) * 0x100000000 + low + 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The named kind whose permission set a mint body asks for exactly (in any key order), if any. */
function scopedKindOf(permissions: unknown): ScopedMintKind | undefined {
  if (!isRecord(permissions)) {
    return undefined;
  }
  return SCOPED_MINT_KINDS.find((kind) => {
    const wanted = SCOPED_MINT_PERMISSIONS[kind];
    const keys = Object.keys(wanted);
    return (
      Object.keys(permissions).length === keys.length && keys.every((key) => permissions[key] === wanted[key])
    );
  });
}

/** Whether the fixture's installation accepted the permissions of `kind` on this repository. */
function isGranted(fixture: MockRepository, kind: ScopedMintKind): boolean {
  switch (kind) {
    case 'actions-dispatch':
      return fixture.actionsWrite === true;
    case 'environment-read':
      return fixture.environmentsRead === true;
    case 'workflow-pr':
      return fixture.setupWrite === true;
  }
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

/**
 * One page of `items` as GitHub pages a list: `per_page` (default 30, at most 100) and `page`, with a `Link: rel="next"`
 * to the same path and query while items remain.
 */
function pageOf(items: readonly unknown[], url: URL): Response {
  const perPage = Math.min(positiveIntOf(url.searchParams.get('per_page'), 30), LIST_PAGE_MAX);
  const page = positiveIntOf(url.searchParams.get('page'), 1);
  const headers: Record<string, string> = {};
  if (page * perPage < items.length) {
    const next = new URL(url.href);
    next.searchParams.set('page', String(page + 1));
    headers['link'] = `<${next.href}>; rel="next"`;
  }
  return json(200, items.slice((page - 1) * perPage, page * perPage), headers);
}

class MockGitHubServer {
  private readonly issued = new Map<string, IssuedToken>();
  private readonly written = new Map<string, WrittenState>();

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

    // #759: one installation as the app sees it, with the permissions its installer accepted.
    if (
      method === 'GET' &&
      segments.length === 3 &&
      segments[0] === 'app' &&
      segments[1] === 'installations'
    ) {
      return (await this.isValidJwt(bearer))
        ? this.installation(Number(segments[2]))
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

    // #670: `workflow_dispatch` of the runner workflow, with a token minted for exactly this repository.
    if (
      method === 'POST' &&
      segments.length === 7 &&
      segments[0] === 'repos' &&
      segments[3] === 'actions' &&
      segments[4] === 'workflows' &&
      segments[6] === 'dispatches'
    ) {
      const token = this.issued.get(bearer);
      if (token === undefined || token.expiresAt <= Date.now()) {
        return json(401, { message: 'Bad credentials' });
      }
      if (token.scope !== 'scoped' || token.kind !== 'actions-dispatch') {
        return json(403, { message: 'Resource not accessible by integration' });
      }
      if (token.repo.toLowerCase() !== `${segments[1]}/${segments[2]}`.toLowerCase()) {
        return notFound();
      }
      if (segments[5] !== 'team-console-runner.yml') {
        return notFound();
      }
      // #723: GitHub names the run it created when asked to (`return_run_details`), and answers 204 otherwise.
      return dispatchBodyAsksForRun(init.body)
        ? json(200, { workflow_run_id: mockRunId() })
        : new Response(null, { status: 204 });
    }

    // #723: an installation token revokes itself; any later use of it is 401, as at GitHub.
    if (method === 'DELETE' && url.pathname === '/installation/token') {
      const token = this.issued.get(bearer);
      if (token === undefined || token.expiresAt <= Date.now()) {
        return json(401, { message: 'Bad credentials' });
      }
      this.issued.delete(bearer);
      return new Response(null, { status: 204 });
    }

    if (
      method === 'GET' &&
      segments[0] === 'repos' &&
      segments.length >= 5 &&
      segments[3] === 'environments'
    ) {
      return this.environmentRead(bearer, segments);
    }

    // #759: the setup's own calls, with a `workflow-pr` token of exactly this repository.
    const setupToken = this.issued.get(bearer);
    if (segments[0] === 'repos' && setupToken?.scope === 'scoped' && setupToken.kind === 'workflow-pr') {
      if (setupToken.expiresAt <= Date.now()) {
        return json(401, { message: 'Bad credentials' });
      }
      return this.setupWrite(setupToken.repo, method, segments, url, init.body);
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
    const isBranchListRead = segments.length === 4 && segments[3] === 'branches';
    const isPullRead = segments.length === 5 && segments[3] === 'pulls';
    const isPullFilesRead = segments.length === 6 && segments[3] === 'pulls' && segments[5] === 'files';
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
        isBranchRead ||
        isBranchListRead ||
        isPullRead ||
        isPullFilesRead)
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
      // A test tripwire as well: a scoped token is spent on its own few calls, never on another read.
      if (token.scope === 'scoped') {
        return json(403, { message: `mock: the ${token.kind} token must not read this` });
      }
      const fixtureFound = this.repository(repo);
      // A downscoped token sees only its own repository; GitHub answers 404 for the rest.
      if (fixtureFound === undefined || fixtureFound.name.toLowerCase() !== token.repo.toLowerCase()) {
        return notFound();
      }
      const found = {
        name: fixtureFound.name,
        fixture: this.withWrites(fixtureFound.name, fixtureFound.fixture),
      };
      const reply = found.fixture.reply;
      if (reply !== undefined) {
        return json(reply.status, { message: 'mock reply' }, { ...reply.headers });
      }
      if (isContentsRead) {
        const accept = new Headers(init.headers).get('accept') ?? '';
        return this.file(
          found.fixture,
          segments.slice(4).join('/'),
          found.name,
          accept,
          url.searchParams.get('ref'),
        );
      }
      if (isListRead) {
        const items = listOf(found.fixture, listed, url.searchParams);
        // Only pull requests are paged (#463); the other lists stay one page, as the readers built on them expect.
        return listed === 'pulls' ? pageOf(items, url) : json(200, items);
      }
      if (isPullRead || isPullFilesRead) {
        const pull = found.fixture.pulls?.find((item) => String(item['number']) === segments[4]);
        if (pull === undefined) {
          return notFound();
        }
        return isPullRead ? json(200, pull) : pageOf(found.fixture.pullFiles?.[segments[4] ?? ''] ?? [], url);
      }
      if (isBranchListRead) {
        const branch = await this.branch(found.fixture, String(found.fixture.repository?.['default_branch']));
        return branch.ok ? pageOf([(await branch.json()) as Record<string, unknown>], url) : branch;
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
  private async file(
    fixture: MockRepository,
    path: string,
    repo: string,
    accept: string,
    ref: string | null = null,
  ): Promise<Response> {
    const atRef = ref === null ? undefined : fixture.refFiles?.[ref];
    const text = atRef === undefined ? fixture.files?.[path] : atRef[path];
    if (atRef !== undefined && text === undefined) {
      return notFound();
    }
    if (text === undefined) {
      return this.listing(fixture, path, repo);
    }
    const bytes = new TextEncoder().encode(text);
    // #759: the raw media type answers the file's bytes, as GitHub does for a file (not for a folder).
    if (accept.includes('raw')) {
      return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/vnd.github.raw' } });
    }
    return json(200, {
      type: 'file',
      encoding: 'base64',
      path,
      // The blob's object id, as `git/trees` lists it (#463: `files.read` returns it).
      sha: await sha1Hex(`blob:${path}`),
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
      tree: blobs.map((blob) => ({
        path: blob.path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
        size: blob.bytes.byteLength,
      })),
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
      return new Response(found.bytes, {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.github.raw' },
      });
    }
    return json(200, {
      sha,
      size: found.bytes.byteLength,
      encoding: 'base64',
      content: base64Of(found.bytes),
    });
  }

  /** `GET …/branches/{name}` (#277): the default branch with a head sha derived from its name. */
  private async branch(fixture: MockRepository, name: string): Promise<Response> {
    if (fixture.repository?.['default_branch'] !== name) {
      return notFound();
    }
    return json(200, { name, commit: { sha: await sha1Hex(`branch:${name}`) } });
  }

  /**
   * #759: `GET …/environments/{name}`, its `deployment-branch-policies` and one `secrets/{name}`. The Environment and
   * its policies take Actions: read (the repository read token or an `environment-read` token); the secret takes
   * Environments: read, which only the `environment-read` token holds. Listing the secrets or reading variables is
   * a tripwire, since the console must do neither.
   */
  private environmentRead(bearer: string, segments: readonly string[]): Response {
    const token = this.issued.get(bearer);
    if (token === undefined || token.expiresAt <= Date.now()) {
      return json(401, { message: 'Bad credentials' });
    }
    if (token.scope === 'installation' || (token.scope === 'scoped' && token.kind !== 'environment-read')) {
      return json(403, { message: 'mock: this token must not read an Environment' });
    }
    const [, owner = '', name = '', , environmentName = '', ...rest] = segments;
    if (rest.includes('variables')) {
      return json(403, { message: 'mock: the console never reads Environment variables' });
    }
    if (rest.length === 1 && rest[0] === 'secrets') {
      return json(403, { message: 'mock: the console never lists secrets, it reads its one name' });
    }
    const found = this.repository(`${owner}/${name}`);
    if (found === undefined || found.name.toLowerCase() !== token.repo.toLowerCase()) {
      return notFound();
    }
    const environment = found.fixture.environments?.[environmentName];
    if (environment === undefined) {
      return notFound();
    }
    if (rest.length === 0) {
      return json(200, { ...(environment.environment ?? {}), name: environmentName });
    }
    if (rest.length === 1 && rest[0] === 'deployment-branch-policies') {
      const policies = environment.branchPolicies ?? [];
      return json(200, { total_count: policies.length, branch_policies: policies });
    }
    if (rest.length === 2 && rest[0] === 'secrets') {
      if (token.scope !== 'scoped') {
        return json(403, { message: 'Resource not accessible by integration' });
      }
      return environment.secrets?.includes(rest[1] ?? '') === true
        ? json(200, {
            name: rest[1],
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T00:00:00Z',
          })
        : notFound();
    }
    return notFound();
  }

  /** The fixture as the reads see it once the setup wrote: its pull requests, their files and their head commits. */
  private withWrites(name: string, fixture: MockRepository): MockRepository {
    const state = this.written.get(name.toLowerCase());
    if (state === undefined) {
      return fixture;
    }
    const pullFiles: Record<string, readonly Readonly<Record<string, unknown>>[]> = { ...fixture.pullFiles };
    const refFiles: Record<string, Readonly<Record<string, string>>> = { ...fixture.refFiles };
    for (const pull of state.pulls) {
      const head = pull['head'];
      const branch =
        isRecord(head) && typeof head['ref'] === 'string' ? state.branches.get(head['ref']) : undefined;
      if (branch === undefined) {
        continue;
      }
      pullFiles[String(pull['number'])] = [...branch.files.keys()].map((filename) => ({ filename }));
      refFiles[branch.headSha] = Object.fromEntries(branch.files);
    }
    return { ...fixture, pulls: [...state.pulls, ...(fixture.pulls ?? [])], pullFiles, refFiles };
  }

  /**
   * #759: the calls a `workflow-pr` token makes. Anything else it asks for is a tripwire, as is a write outside a
   * branch this mock created.
   */
  private async setupWrite(
    tokenRepo: string,
    method: string,
    segments: readonly string[],
    url: URL,
    rawBody: RequestInit['body'],
  ): Promise<Response> {
    const found = this.repository(`${segments[1]}/${segments[2]}`);
    if (found === undefined || found.name.toLowerCase() !== tokenRepo.toLowerCase()) {
      return notFound();
    }
    const { name, fixture } = found;
    const defaultBranch = String(fixture.repository?.['default_branch']);
    const key = name.toLowerCase();
    const state = this.written.get(key) ?? { branches: new Map<string, WrittenBranch>(), pulls: [] };
    this.written.set(key, state);
    const rest = segments.slice(3);
    const body = parsedBody(rawBody);

    if (method === 'GET' && rest.length === 2 && rest[0] === 'branches') {
      return this.branch(fixture, rest[1] ?? '');
    }
    if (method === 'POST' && rest.join('/') === 'git/refs') {
      const ref = typeof body?.['ref'] === 'string' ? body['ref'] : '';
      const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '';
      const head = await sha1Hex(`branch:${defaultBranch}`);
      if (branch === '' || body?.['sha'] !== head) {
        return json(422, { message: 'Object does not exist' });
      }
      if (branch === defaultBranch || state.branches.has(branch)) {
        return json(422, { message: 'Reference already exists' });
      }
      state.branches.set(branch, { headSha: head, commits: 0, files: new Map() });
      return json(201, { ref, object: { sha: head, type: 'commit' } });
    }
    if (rest[0] === 'contents' && rest.length > 1 && (method === 'GET' || method === 'PUT')) {
      const path = rest.slice(1).join('/');
      const branchName = method === 'GET' ? url.searchParams.get('ref') : body?.['branch'];
      if (typeof branchName !== 'string' || branchName === '') {
        return tripwire('a setup write names its branch; without one GitHub commits to the default branch');
      }
      const branch = state.branches.get(branchName);
      if (branch === undefined) {
        return tripwire('the console writes only to a branch it has just created');
      }
      const current = branch.files.get(path) ?? fixture.files?.[path];
      const currentSha = current === undefined ? null : await sha1Hex(`blob:${path}:${current}`);
      if (method === 'GET') {
        return current === undefined || currentSha === null
          ? notFound()
          : json(200, { type: 'file', path, sha: currentSha, size: current.length });
      }
      const content = typeof body?.['content'] === 'string' ? body['content'] : null;
      if (content === null || typeof body?.['message'] !== 'string') {
        return json(422, { message: 'Invalid request' });
      }
      const given = body['sha'];
      if (currentSha !== null && given !== currentSha) {
        return json(given === undefined ? 422 : 409, { message: 'sha does not match' });
      }
      if (currentSha === null && given !== undefined) {
        return json(422, { message: 'sha was supplied for a file that does not exist' });
      }
      const text = new TextDecoder().decode(Uint8Array.from(atob(content), (char) => char.charCodeAt(0)));
      branch.files.set(path, text);
      branch.commits += 1;
      branch.headSha = await sha1Hex(`commit:${branchName}:${String(branch.commits)}:${text}`);
      return json(currentSha === null ? 201 : 200, {
        content: { path, sha: await sha1Hex(`blob:${path}:${text}`) },
        commit: { sha: branch.headSha },
      });
    }
    if (method === 'POST' && rest.length === 1 && rest[0] === 'pulls') {
      const head = typeof body?.['head'] === 'string' ? body['head'] : '';
      const branch = state.branches.get(head);
      if (branch === undefined || body?.['base'] !== defaultBranch || typeof body['title'] !== 'string') {
        return json(422, { message: 'Validation Failed' });
      }
      const isOpenFrom = (pull: Readonly<Record<string, unknown>>): boolean =>
        pull['state'] === 'open' && isRecord(pull['head']) && pull['head']['ref'] === head;
      if (state.pulls.some(isOpenFrom)) {
        return json(422, { message: 'A pull request already exists for this branch' });
      }
      const numbers = [...state.pulls, ...(fixture.pulls ?? []), ...(fixture.issues ?? [])].map((item) =>
        typeof item['number'] === 'number' ? item['number'] : 0,
      );
      const number = Math.max(9000, ...numbers) + 1;
      const repository = { id: fixture.repository?.['id'], owner: { login: name.split('/')[0] ?? '' } };
      const pull: Record<string, unknown> = {
        number,
        state: 'open',
        title: body['title'],
        body: typeof body['body'] === 'string' ? body['body'] : '',
        html_url: `https://github.com/${name}/pull/${String(number)}`,
        user: { login: 'team-console-local[bot]', type: 'Bot' },
        head: { ref: head, sha: branch.headSha, repo: repository },
        base: { ref: defaultBranch, repo: repository },
        commits: branch.commits,
        changed_files: branch.files.size,
      };
      state.pulls.unshift(pull);
      return json(201, pull);
    }
    if (method === 'PATCH' && rest.length === 2 && rest[0] === 'pulls') {
      const pull = state.pulls.find((item) => String(item['number']) === rest[1]);
      if (pull === undefined) {
        return tripwire('the console closes only a pull request it has just opened');
      }
      if (body?.['state'] === 'closed') {
        pull['state'] = 'closed';
      }
      return json(200, pull);
    }
    return tripwire(`the workflow-pr token must not ask for ${method} ${rest.join('/')}`);
  }

  /** An issue as GitHub sends it: labels as objects. */
  private issue(fixture: MockRepository, number: string): Response {
    const issue = fixture.issues?.find((item) => String(item['number']) === number);
    return issue === undefined ? notFound() : json(200, issue);
  }

  /**
   * `GET /app/installations/{id}`: the first fixture repository on the installation names what was accepted —
   * the read set always, `actions: write`, `environments: read` and the setup write set by its flags.
   */
  private installation(installationId: number): Response {
    const fixture = Object.values(this.fixtures.repositories).find(
      (entry) => entry.installationId === installationId,
    );
    if (fixture === undefined) {
      return notFound();
    }
    const owner = ownerOf(fixture);
    return json(200, {
      id: installationId,
      app_id: Number(MOCK_APP_ID),
      app_slug: 'team-console-local',
      account: owner === null ? null : { id: owner.id, login: owner.login, type: 'User' },
      html_url: `https://github.com/settings/installations/${String(installationId)}`,
      repository_selection: 'selected',
      suspended_at: null,
      permissions: {
        metadata: 'read',
        issues: 'write',
        pull_requests: fixture.setupWrite === true ? 'write' : 'read',
        contents: fixture.setupWrite === true ? 'write' : 'read',
        actions: fixture.actionsWrite === true ? 'write' : 'read',
        ...(fixture.environmentsRead === true ? { environments: 'read' } : {}),
        ...(fixture.setupWrite === true ? { workflows: 'write' } : {}),
      },
    });
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
    // #670, #759: a scoped token, one repository by id, with exactly one named kind's permissions.
    const ids = request['repository_ids'];
    if (Array.isArray(ids)) {
      const wanted = ids.length === 1 && typeof ids[0] === 'number' ? ids[0] : undefined;
      const found = onInstallation.find(([, fixture]) => fixture.repository?.['id'] === wanted);
      const kind = scopedKindOf(request['permissions']);
      if (found === undefined || wanted === undefined || kind === undefined) {
        return json(422, {
          message: 'The console must mint one named permission set for exactly one repository',
        });
      }
      if (!isGranted(found[1], kind)) {
        return json(422, { message: 'The permissions requested are not granted to this installation.' });
      }
      return this.issue201({
        scope: 'scoped',
        kind,
        repo: found[0],
        repositoryId: wanted,
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
    const name = issued.scope === 'installation' ? '' : (issued.repo.split('/')[1] ?? '');
    return json(201, {
      token,
      expires_at: new Date(issued.expiresAt).toISOString(),
      permissions:
        issued.scope === 'repo'
          ? INSTALLATION_PERMISSIONS
          : issued.scope === 'scoped'
            ? SCOPED_MINT_PERMISSIONS[issued.kind]
            : INSTALLATION_LIST_PERMISSIONS,
      repository_selection: issued.scope === 'installation' ? 'all' : 'selected',
      // #317: a repository token lists the one repository it covers, as GitHub's answer does.
      ...(issued.scope === 'repo' ? { repositories: [{ name, full_name: issued.repo }] } : {}),
      ...(issued.scope === 'scoped'
        ? { repositories: [{ id: issued.repositoryId, name, full_name: issued.repo }] }
        : {}),
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
export async function createMockGitHub(mockFixtures: MockFixtures = MOCK_FIXTURES): Promise<MockGitHub> {
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
