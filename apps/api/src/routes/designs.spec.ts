import { DESIGN_IMAGE_MAX_BYTES, isProblemDetails, problemSlugOf, type DesignManifestDto } from '@shared/contracts';
import { MemoryReadCache } from '@worker/github';
import { ApiGitHub } from '../github';
import {
  SERVICE_TOKEN_ID,
  accessEnv,
  createSigningKey,
  fetchApi,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
} from '../testing/access-kit';
import {
  TOKEN_SENTINEL,
  json,
  localEnv,
  resetProjects,
  seedProject,
  stubGitHub,
  type GitHubCall,
  type StubGitHub,
} from '../testing/github-kit';
import { pull } from '../testing/read-model-kit';
import { DESIGN_FILE_HEADERS, dispositionFileNameOf } from './designs';

// #277 through the routes in workerd: discovery at the linking pull request's head or the default branch, the
// manifest, and the file endpoint's refusals (path outside the set, SVG/HTML, wrong magic bytes, size cap), its
// headers, and the installation token on every GitHub read (private repositories).

const REPO = 'geeera/team-console';
const ISSUE = 90004;
const FOLDER = `docs/design/${ISSUE}-demo-screen`;
const PR_SHA = '1'.repeat(40);
const DEV_SHA = '2'.repeat(40);
const RAW = 'application/vnd.github.raw+json';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF_MAGIC = [...'GIF89a'].map((c) => c.charCodeAt(0));
const png = (tail: string) => Uint8Array.from([...PNG_MAGIC, ...new TextEncoder().encode(tail)]);
const gif = (tail: string) => Uint8Array.from([...GIF_MAGIC, ...new TextEncoder().encode(tail)]);

interface Blob {
  readonly path: string;
  readonly bytes: Uint8Array;
  /** The size the tree announces; defaults to the bytes' length. */
  readonly size?: number;
}

const BLOBS: readonly Blob[] = [
  { path: `${FOLDER}/phone-02-detail.png`, bytes: png('detail') },
  { path: `${FOLDER}/phone-01-list.png`, bytes: png('list') },
  { path: `${FOLDER}/mac-01-list.jpg`, bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) },
  // Named .png, bytes of a GIF: listed (the name is honest enough to list), refused when fetched.
  { path: `${FOLDER}/phone-03-fake.png`, bytes: gif('not png') },
  // Listed as too large; its bytes are never asked for.
  { path: `${FOLDER}/phone-04-huge.png`, bytes: png('huge'), size: DESIGN_IMAGE_MAX_BYTES + 1 },
  // Announced small, but the stream is longer than the cap.
  { path: `${FOLDER}/phone-05-liar.png`, bytes: png('x'.repeat(DESIGN_IMAGE_MAX_BYTES)), size: 10 },
  { path: `${FOLDER}/logo.svg`, bytes: new TextEncoder().encode('<svg onload="alert(1)"/>') },
  { path: `${FOLDER}/wireframe.html`, bytes: new TextEncoder().encode('<!doctype html>') },
  {
    path: `${FOLDER}/screens.json`,
    bytes: new TextEncoder().encode(JSON.stringify([{ file: 'phone-01-list.png', title: 'Список' }])),
  },
  { path: 'docs/design/other/1-x.png', bytes: png('other issue') },
  { path: '.product-team/project.yml', bytes: new TextEncoder().encode('name: x\n') },
];

const shaOf = (path: string): string => {
  const index = BLOBS.findIndex((blob) => blob.path === path);
  return `${String(index + 1).padStart(2, '0')}${'c'.repeat(38)}`;
};

interface World {
  /** The open pull requests; by default one links the issue. */
  readonly pulls?: readonly Record<string, unknown>[];
  /** Replaces the tree answer (e.g. 404 for a repository the app cannot see). */
  readonly tree?: () => Response;
  readonly truncated?: boolean;
}

function handlerFor(world: World): (call: GitHubCall) => Response {
  const pulls = world.pulls ?? [
    pull(176, PR_SHA, { body: `Closes #${ISSUE}`, head: { sha: PR_SHA, ref: 'design/90004-demo' } }),
  ];
  return (call) => {
    const path = call.url.pathname.replace(`/repos/${REPO}`, '');
    if (path === '' && call.url.pathname === `/repos/${REPO}`) {
      return json(200, { default_branch: 'dev' });
    }
    if (path === '/branches/dev') {
      return json(200, { name: 'dev', commit: { sha: DEV_SHA } });
    }
    if (path === '/pulls') {
      return json(200, pulls);
    }
    const tree = /^\/git\/trees\/([0-9a-f]{40})$/.exec(path);
    if (tree !== null) {
      if (world.tree !== undefined) {
        return world.tree();
      }
      return json(200, {
        sha: tree[1],
        truncated: world.truncated === true,
        tree: BLOBS.map((blob) => ({
          path: blob.path,
          type: 'blob',
          sha: shaOf(blob.path),
          size: blob.size ?? blob.bytes.byteLength,
        })),
      });
    }
    const blob = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(path);
    if (blob !== null) {
      const found = BLOBS.find((candidate) => shaOf(candidate.path) === blob[1]);
      if (found === undefined) {
        return json(404, { message: 'Not Found' });
      }
      if (call.headers.get('accept') !== RAW) {
        return json(200, { encoding: 'base64', content: '' });
      }
      return new Response(found.bytes, { status: 200, headers: { 'Content-Type': 'application/vnd.github.raw' } });
    }
    return json(404, { message: 'Not Found' });
  };
}

function setup(world: World = {}): { github: ApiGitHub; stub: StubGitHub } {
  const stub = stubGitHub(handlerFor(world));
  return { stub, github: new ApiGitHub({ fetch: stub.fetch, readCache: new MemoryReadCache() }) };
}

const manifestPath = (issue: number | string = ISSUE) => `/api/v1/projects/tc/designs/${issue}`;
const filePath = (path: string, sha = PR_SHA, issue: number | string = ISSUE) =>
  `/api/v1/projects/tc/designs/${issue}/${sha}/file?path=${encodeURIComponent(path)}`;

async function manifest(github: ApiGitHub, issue: number | string = ISSUE): Promise<Response> {
  return fetchApi(manifestPath(issue), localEnv(), { github });
}

async function file(github: ApiGitHub, path: string, sha = PR_SHA): Promise<Response> {
  return fetchApi(filePath(path, sha), localEnv(), { github });
}

async function problemSlug(response: Response): Promise<string> {
  const body: unknown = await response.json();
  if (!isProblemDetails(body)) {
    throw new Error('not a problem');
  }
  return problemSlugOf(body.type);
}

const blobReads = (stub: StubGitHub) => stub.reads().filter((call) => call.url.pathname.includes('/git/blobs/'));

beforeEach(async () => {
  await resetProjects();
  await seedProject('tc', REPO);
});

describe('GET /api/v1/projects/:slug/designs/:issue', () => {
  it('lists the png/jpeg/webp/gif screens of the issue at the linking pull request head, in file-name order, never the SVG', async () => {
    const { github, stub } = setup();
    const response = await manifest(github);

    expect(response.status).toBe(200);
    const body = (await response.json()) as DesignManifestDto;
    expect(body.sha).toBe(PR_SHA);
    expect(body.ref).toBe('pull-request');
    expect(body.partial).toBe(false);
    expect(body.screens.map((screen) => screen.file)).toEqual([
      'mac-01-list.jpg',
      'phone-01-list.png',
      'phone-02-detail.png',
      'phone-03-fake.png',
      'phone-04-huge.png',
      'phone-05-liar.png',
    ]);
    expect(body.screens[0]).toEqual({
      path: `${FOLDER}/mac-01-list.jpg`,
      file: 'mac-01-list.jpg',
      caption: 'list',
      device: 'mac',
      type: 'jpeg',
      size: 7,
      tooLarge: false,
      url: `https://github.com/${REPO}/blob/${PR_SHA}/${FOLDER}/mac-01-list.jpg`,
    });
    // screens.json names this one.
    expect(body.screens[1]?.caption).toBe('Список');
    expect(body.screens.find((screen) => screen.file === 'phone-04-huge.png')?.tooLarge).toBe(true);
    expect(body.interactive).toEqual({
      path: `${FOLDER}/wireframe.html`,
      url: `https://geeera.github.io/team-console/${ISSUE}-demo-screen/wireframe.html`,
    });
    expect(JSON.stringify(body)).not.toContain('.svg');
    // lookup + mint + pulls + tree + screens.json
    expect(stub.calls).toHaveLength(5);
    expect(stub.reads().every((call) => call.headers.get('authorization') === `Bearer ${TOKEN_SENTINEL}1`)).toBe(
      true,
    );
  });

  it('reads the default branch head when no open pull request links the issue', async () => {
    const { github, stub } = setup({ pulls: [pull(1, '3'.repeat(40), { body: 'Closes #5' })] });
    const body = (await (await manifest(github)).json()) as DesignManifestDto;

    expect(body.sha).toBe(DEV_SHA);
    expect(body.ref).toBe('default-branch');
    expect(body.screens).toHaveLength(6);
    expect(stub.reads().map((call) => call.url.pathname)).toEqual([
      `/repos/${REPO}/pulls`,
      `/repos/${REPO}`,
      `/repos/${REPO}/branches/dev`,
      `/repos/${REPO}/git/trees/${DEV_SHA}`,
      `/repos/${REPO}/git/blobs/${shaOf(`${FOLDER}/screens.json`)}`,
    ]);
  });

  it('answers an issue without files with an empty manifest, and a truncated tree as partial', async () => {
    // Issue 1 owns docs/design/other/1-x.png; issue 2 owns nothing.
    const empty = (await (await manifest(setup().github, 2)).json()) as DesignManifestDto;
    expect(empty).toMatchObject({ issue: 2, screens: [], interactive: null, partial: false });

    const cut = (await (await manifest(setup({ truncated: true }).github)).json()) as DesignManifestDto;
    expect(cut.partial).toBe(true);
  });

  it('answers a second request from the read cache', async () => {
    const { github, stub } = setup();
    await manifest(github);
    const before = stub.reads().length;
    await manifest(github);
    expect(stub.reads()).toHaveLength(before);
  });

  it.each(['0', '-1', '1.5', 'x', '12345678901', '1%2F2'])('404 design-file-not-found for issue %s', async (issue) => {
    const { github, stub } = setup();
    const response = await manifest(github, issue);
    expect(response.status).toBe(404);
    expect(await problemSlug(response)).toBe('design-file-not-found');
    expect(stub.calls).toEqual([]);
  });

  it('passes a repository GitHub does not show the app through as 404 github-not-found', async () => {
    const { github } = setup({ tree: () => json(404, { message: 'Not Found' }) });
    const response = await manifest(github);
    expect(response.status).toBe(404);
    expect(await problemSlug(response)).toBe('github-not-found');
  });

  it('404 project-not-found for an unknown slug before any GitHub call', async () => {
    const { github, stub } = setup();
    const response = await fetchApi('/api/v1/projects/nope/designs/1', localEnv(), { github });
    expect(response.status).toBe(404);
    expect(await problemSlug(response)).toBe('project-not-found');
    expect(stub.calls).toEqual([]);
  });
});

describe('GET /api/v1/projects/:slug/designs/:issue/:sha/file', () => {
  it('serves a listed image with its exact type, nosniff, a sandboxing CSP, inline and immutable', async () => {
    const { github, stub } = setup();
    const response = await file(github, `${FOLDER}/phone-01-list.png`);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png('list'));
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBe(String(png('list').byteLength));
    expect(response.headers.get('x-content-type-options')).toBe(DESIGN_FILE_HEADERS['X-Content-Type-Options']);
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('content-disposition')).toBe('inline; filename="phone-01-list.png"');
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');

    // The private-repository path: the blob is read with the installation token and the raw media type.
    const blob = blobReads(stub).find((call) => call.url.pathname.endsWith(shaOf(`${FOLDER}/phone-01-list.png`)));
    expect(blob?.headers.get('authorization')).toBe(`Bearer ${TOKEN_SENTINEL}1`);
    expect(blob?.headers.get('accept')).toBe(RAW);
    // Discovery at the sha the client named, with no pull request lookup: tree + screens.json + the blob.
    expect(stub.reads().map((call) => call.url.pathname)).toEqual([
      `/repos/${REPO}/git/trees/${PR_SHA}`,
      `/repos/${REPO}/git/blobs/${shaOf(`${FOLDER}/screens.json`)}`,
      `/repos/${REPO}/git/blobs/${shaOf(`${FOLDER}/phone-01-list.png`)}`,
    ]);
  });

  it('serves a jpeg with image/jpeg', async () => {
    const response = await file(setup().github, `${FOLDER}/mac-01-list.jpg`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
  });

  it.each([
    ['a traversal to a file outside the set', `${FOLDER}/../../.product-team/project.yml`],
    ['an encoded traversal', `${FOLDER}/%2e%2e/%2e%2e/.product-team/project.yml`],
    ['a file of the repository outside docs/design', '.product-team/project.yml'],
    ["another issue's file", 'docs/design/other/1-x.png'],
    ['an SVG in the folder', `${FOLDER}/logo.svg`],
    ['the HTML wireframe', `${FOLDER}/wireframe.html`],
    ['screens.json itself', `${FOLDER}/screens.json`],
    ['a file that is not there', `${FOLDER}/phone-99.png`],
    ['a path with a different case', `${FOLDER}/PHONE-01-LIST.PNG`],
  ])('refuses %s with 404 and reads no blob', async (_label, path) => {
    const { github, stub } = setup();
    const response = await file(github, path);
    expect(response.status).toBe(404);
    expect(await problemSlug(response)).toBe('design-file-not-found');
    // Discovery may read screens.json; the requested file is never asked for.
    expect(blobReads(stub).map((call) => call.url.pathname)).toEqual([
      `/repos/${REPO}/git/blobs/${shaOf(`${FOLDER}/screens.json`)}`,
    ]);
  });

  it('refuses a file whose bytes are not the image its name claims with 415, and sends no bytes', async () => {
    const { github } = setup();
    const response = await file(github, `${FOLDER}/phone-03-fake.png`);
    expect(response.status).toBe(415);
    expect(await problemSlug(response)).toBe('design-file-type-mismatch');
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  it('refuses a file the manifest marks too large with 413 before reading it', async () => {
    const { github, stub } = setup();
    const response = await file(github, `${FOLDER}/phone-04-huge.png`);
    expect(response.status).toBe(413);
    expect(await problemSlug(response)).toBe('design-file-too-large');
    expect(blobReads(stub).some((call) => call.url.pathname.endsWith(shaOf(`${FOLDER}/phone-04-huge.png`)))).toBe(
      false,
    );
  });

  it('refuses a body that outgrows the cap while streaming, whatever the tree said, with 413', async () => {
    const response = await file(setup().github, `${FOLDER}/phone-05-liar.png`);
    expect(response.status).toBe(413);
    expect(await problemSlug(response)).toBe('design-file-too-large');
  });

  it('400 without a path, 404 for a sha that is not a commit sha', async () => {
    const { github, stub } = setup();
    const noPath = await fetchApi(`/api/v1/projects/tc/designs/${ISSUE}/${PR_SHA}/file`, localEnv(), { github });
    expect(noPath.status).toBe(400);
    expect(await problemSlug(noPath)).toBe('design-file-path-missing');
    for (const sha of ['dev', 'A'.repeat(40), '1'.repeat(39), '..']) {
      const response = await file(github, `${FOLDER}/phone-01-list.png`, sha);
      expect(response.status).toBe(404);
      expect(await problemSlug(response)).toBe('design-file-not-found');
    }
    expect(stub.calls).toEqual([]);
  });

  it('never caches a problem: the next request after a GitHub failure reads again', async () => {
    let failures = 1;
    const stub = stubGitHub((call) => {
      if (call.url.pathname.includes('/git/trees/') && failures-- > 0) {
        return json(503, { message: 'unavailable' });
      }
      return handlerFor({})(call);
    });
    const github = new ApiGitHub({ fetch: stub.fetch, readCache: new MemoryReadCache() });
    expect((await file(github, `${FOLDER}/phone-01-list.png`)).status).toBe(502);
    expect((await file(github, `${FOLDER}/phone-01-list.png`)).status).toBe(200);
  });
});

describe('Access: the owner and the dev service identity', () => {
  it.each([
    ['the owner', {}],
    ['the service identity', { email: undefined, common_name: SERVICE_TOKEN_ID }],
  ])('%s reads the manifest and a file (reads, not owner-only)', async (_who, claims) => {
    const jwks = stubJwksServer();
    const teamDomain = uniqueTeamDomain();
    const key = await createSigningKey();
    jwks.set(teamDomain, { keys: [key.publicJwk] });
    const token = await signAccessToken(key, teamDomain, { claims });
    const { github } = setup();
    const headers = { 'Cf-Access-Jwt-Assertion': token };

    const listed = await fetchApi(manifestPath(), accessEnv(teamDomain), { github, headers });
    expect(listed.status).toBe(200);
    const served = await fetchApi(filePath(`${FOLDER}/phone-01-list.png`), accessEnv(teamDomain), { github, headers });
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    vi.restoreAllMocks();
  });

  it('401 without a JWT on a deployed environment', async () => {
    const teamDomain = uniqueTeamDomain();
    const { github, stub } = setup();
    const response = await fetchApi(filePath(`${FOLDER}/phone-01-list.png`), accessEnv(teamDomain), { github });
    expect(response.status).toBe(401);
    expect(stub.calls).toEqual([]);
  });
});

describe('dispositionFileNameOf', () => {
  it('keeps plain names and replaces anything a user agent might choke on', () => {
    expect(dispositionFileNameOf('phone-01-list.png')).toBe('phone-01-list.png');
    expect(dispositionFileNameOf('экран 1".png')).toBe('______1_.png');
    expect(dispositionFileNameOf('')).toBe('design');
  });
});
