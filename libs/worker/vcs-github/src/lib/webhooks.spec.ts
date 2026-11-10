import { githubWebhooks, parseGitHubDelivery } from './webhooks';

const encoder = new TextEncoder();
const body = '{"action":"opened","number":1}';
const bytes = (text: string): ArrayBuffer => encoder.encode(text).buffer as ArrayBuffer;

async function signatureOf(text: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
  return `sha256=${Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

describe('githubWebhooks.verify', () => {
  it('accepts the HMAC-SHA256 of the exact bytes', async () => {
    await expect(githubWebhooks.verify(bytes(body), await signatureOf(body, 'k'), ['k'])).resolves.toBe(true);
  });

  it('accepts either secret during a rotation, only the listed ones otherwise', async () => {
    const signedWithOld = await signatureOf(body, 'old');
    await expect(githubWebhooks.verify(bytes(body), signedWithOld, ['new', 'old'])).resolves.toBe(true);
    await expect(githubWebhooks.verify(bytes(body), signedWithOld, ['new'])).resolves.toBe(false);
    await expect(githubWebhooks.verify(bytes(body), signedWithOld, [])).resolves.toBe(false);
  });

  it('refuses a valid signature over a re-serialised body', async () => {
    const reserialised = JSON.stringify(JSON.parse(body) as unknown, null, 2);
    await expect(
      githubWebhooks.verify(bytes(reserialised), await signatureOf(body, 'k'), ['k']),
    ).resolves.toBe(false);
  });

  it.each([
    ['missing', null],
    ['undefined', undefined],
    ['empty', ''],
    ['sha1', 'sha1=0123456789abcdef0123456789abcdef01234567'],
    ['short hex', 'sha256=abcdef'],
    ['no prefix', '0'.repeat(64)],
    ['trailing space', `sha256=${'0'.repeat(64)} `],
  ])('refuses a %s header without throwing', async (_name, header) => {
    await expect(githubWebhooks.verify(bytes(body), header, ['k'])).resolves.toBe(false);
  });

  it('refuses the right signature written in upper-case hex', async () => {
    const signature = await signatureOf(body, 'k');
    const upper = `sha256=${signature.slice('sha256='.length).toUpperCase()}`;
    await expect(githubWebhooks.verify(bytes(body), upper, ['k'])).resolves.toBe(false);
  });
});

const REPO = { id: 860001, full_name: 'geeera/storify', default_branch: 'main' };
const HEAD = 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4';

function pull(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5550001,
    number: 77,
    title: 'Release 0.4.0',
    state: 'open',
    draft: false,
    merged_at: null,
    updated_at: '2026-11-09T10:00:00Z',
    html_url: 'javascript:alert(1)',
    head: { ref: 'stage', sha: HEAD, repo: { full_name: 'geeera/storify' } },
    base: { ref: 'main' },
    user: { login: 'geeera', type: 'User' },
    ...extra,
  };
}

function pullRequestDelivery(
  action: string,
  pullRequest: unknown = pull(),
): { event: string; payload: unknown } {
  return {
    event: 'pull_request',
    payload: { action, number: 77, pull_request: pullRequest, repository: REPO, installation: { id: 4711 } },
  };
}

describe('parseGitHubDelivery', () => {
  it('normalises a pull request event, with the page built from the repository and never the payload', () => {
    expect(parseGitHubDelivery(pullRequestDelivery('opened'))).toEqual({
      kind: 'pr.opened',
      repository: { externalId: '860001', fullName: 'geeera/storify' },
      installationId: 4711,
      pullRequest: {
        externalId: '5550001',
        number: 77,
        title: 'Release 0.4.0',
        state: 'open',
        draft: false,
        headRef: 'stage',
        headSha: HEAD,
        baseRef: 'main',
        headRepository: 'geeera/storify',
        authorLogin: 'geeera',
        url: 'https://github.com/geeera/storify/pull/77',
        updatedAt: '2026-11-09T10:00:00.000Z',
      },
    });
  });

  it.each([
    ['reopened', 'pr.reopened'],
    ['synchronize', 'pr.synchronize'],
    ['edited', 'pr.edited'],
    ['ready_for_review', 'pr.ready'],
    ['converted_to_draft', 'pr.draft'],
    ['closed', 'pr.closed'],
  ])('maps %s to %s', (action, kind) => {
    expect(parseGitHubDelivery(pullRequestDelivery(action))?.kind).toBe(kind);
  });

  it('reads a closed pull request with merged_at as merged', () => {
    const event = parseGitHubDelivery(
      pullRequestDelivery('closed', pull({ state: 'closed', merged_at: '2026-11-09T11:00:00Z' })),
    );
    expect(event?.kind).toBe('pr.merged');
    expect(event !== null && 'pullRequest' in event ? event.pullRequest.state : null).toBe('merged');
  });

  it.each([
    ['labeled', pull()],
    ['constructor', pull()],
    ['opened', pull({ head: { ref: 'stage', sha: 'nope' } })],
    ['opened', pull({ head: { ref: '../x', sha: HEAD } })],
    ['opened', pull({ base: { ref: 'main lock' } })],
    ['opened', pull({ state: 'draft' })],
    ['opened', pull({ updated_at: 'yesterday' })],
    ['opened', pull({ id: -1 })],
    ['opened', pull({ title: 'x'.repeat(1025) })],
    ['opened', 'not an object'],
  ])('ignores action %s with an unusable pull request (%#)', (action, pullRequest) => {
    expect(parseGitHubDelivery(pullRequestDelivery(action, pullRequest))).toBeNull();
  });

  it('keeps an unknown author and a deleted fork as null', () => {
    const event = parseGitHubDelivery(
      pullRequestDelivery('opened', pull({ user: null, head: { ref: 'x', sha: HEAD, repo: null } })),
    );
    expect(event !== null && 'pullRequest' in event ? event.pullRequest : null).toMatchObject({
      authorLogin: null,
      headRepository: null,
    });
  });

  it.each([
    ['geeera', 'geeera'],
    ['dependabot[bot]', 'dependabot[bot]'],
    ['team-console-dev[bot]', 'team-console-dev[bot]'],
    ['a'.repeat(39), 'a'.repeat(39)],
    ['a'.repeat(40), null],
    ['', null],
    ['gee era', null],
    ['geeera<b>', null],
    ['geeera‮', null],
    ['geeera[bot][bot]', null],
    ['[bot]', null],
    ['ge/eera', null],
  ])('keeps the author login %j only in GitHub’s login shape (#481)', (login, expected) => {
    const event = parseGitHubDelivery(pullRequestDelivery('opened', pull({ user: { login } })));
    expect(event !== null && 'pullRequest' in event ? event.pullRequest.authorLogin : 'unparsed').toBe(
      expected,
    );
  });

  it('turns a completed workflow run into ci.completed for its head, and ignores other actions', () => {
    const run = (action: string, headSha: unknown) => ({
      event: 'workflow_run',
      payload: { action, workflow_run: { head_sha: headSha, conclusion: 'success' }, repository: REPO },
    });
    expect(parseGitHubDelivery(run('completed', HEAD))).toEqual({
      kind: 'ci.completed',
      repository: { externalId: '860001', fullName: 'geeera/storify' },
      installationId: null,
      sha: HEAD,
    });
    expect(parseGitHubDelivery(run('requested', HEAD))).toBeNull();
    expect(parseGitHubDelivery(run('completed', 'HEAD'))).toBeNull();
  });

  it('reads a push with its ref', () => {
    expect(
      parseGitHubDelivery({ event: 'push', payload: { ref: 'refs/heads/main', repository: REPO } }),
    ).toMatchObject({
      kind: 'push',
      ref: 'refs/heads/main',
    });
    expect(parseGitHubDelivery({ event: 'push', payload: { ref: 'main', repository: REPO } })).toBeNull();
  });

  it('ignores another event, a payload without a usable repository, and a non-object', () => {
    expect(
      parseGitHubDelivery({ event: 'issues', payload: { action: 'opened', repository: REPO } }),
    ).toBeNull();
    expect(
      parseGitHubDelivery({
        ...pullRequestDelivery('opened'),
        payload: { action: 'opened', pull_request: pull() },
      }),
    ).toBeNull();
    expect(
      parseGitHubDelivery({
        event: 'pull_request',
        payload: { action: 'opened', pull_request: pull(), repository: { id: 1, full_name: 'a/b/c' } },
      }),
    ).toBeNull();
    expect(parseGitHubDelivery({ event: 'pull_request', payload: [] })).toBeNull();
  });
});
