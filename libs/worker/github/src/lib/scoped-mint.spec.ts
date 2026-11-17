import type { Logger } from '@worker/core';
import { GitHubAppAuth } from './app-auth';
import { GitHubError } from './errors';
import { createMockGitHub, type MockGitHub } from './mock';
import {
  ENVIRONMENT_READ_PERMISSIONS,
  SCOPED_MINT_KINDS,
  WORKFLOW_PR_PERMISSIONS,
  type ScopedMintAudit,
  type ScopedMintEvent,
  type ScopedMintKind,
} from './scoped-mint';
import type { FetchLike } from './transport';

// #759 (security note, PR 1): the named one-repository mints, against the mock GitHub app. The mock grants every kind
// on geeera/team-console and none of the new ones on geeera/private-product (an installation that kept the old set).

const TEAM_CONSOLE = { installationId: 1001, repositoryId: 900001 };
const PRIVATE_PRODUCT = { installationId: 1001, repositoryId: 900002 };

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: string | undefined;
}

interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly fields: unknown;
}

function recordingLogger(): Logger & { readonly entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const log =
    (level: string) =>
    (message: string, fields?: unknown): void => {
      entries.push({ level, message, fields });
    };
  return { entries, info: log('info'), warn: log('warn'), error: log('error') };
}

function recordingAudit(): { readonly events: ScopedMintEvent[]; readonly audit: ScopedMintAudit } {
  const events: ScopedMintEvent[] = [];
  return {
    events,
    audit: async (event) => {
      events.push(event);
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('mintScoped (#759 named kinds)', () => {
  let mock: MockGitHub;
  const calls: Call[] = [];
  let recordingFetch: FetchLike;

  beforeAll(async () => {
    mock = await createMockGitHub();
    recordingFetch = async (input, init) => {
      calls.push({
        method: init.method ?? 'GET',
        path: new URL(input).pathname,
        body: typeof init.body === 'string' ? init.body : undefined,
      });
      return mock.fetch(input, init);
    };
  });

  beforeEach(() => {
    calls.length = 0;
  });

  const authWith = (options: { setupWrite?: 'enabled' | 'disabled'; logger?: Logger } = {}): GitHubAppAuth =>
    new GitHubAppAuth(mock.credentials, { fetch: recordingFetch, ...options });

  const mintBodies = (): unknown[] =>
    calls.filter((call) => call.path.endsWith('/access_tokens')).map((call) => JSON.parse(call.body ?? '{}'));

  it.each([
    ['actions-dispatch', { actions: 'write' }],
    ['environment-read', { actions: 'read', environments: 'read' }],
    ['workflow-pr', { contents: 'write', workflows: 'write', pull_requests: 'write' }],
  ] as const)('mints a %s token for one repository by id with exactly its permissions', async (kind, permissions) => {
    const token = await authWith({ setupWrite: 'enabled' }).mintScoped(kind, TEAM_CONSOLE, recordingAudit().audit);
    expect(mintBodies()).toEqual([{ repository_ids: [TEAM_CONSOLE.repositoryId], permissions }]);
    expect(token.kind).toBe(kind);
    expect(token.repositoryId).toBe(TEAM_CONSOLE.repositoryId);
  });

  it('holds workflows: write in the workflow-pr set alone', () => {
    expect(WORKFLOW_PR_PERMISSIONS).toEqual({ contents: 'write', workflows: 'write', pull_requests: 'write' });
    expect(ENVIRONMENT_READ_PERMISSIONS).not.toHaveProperty('workflows');
    expect(Object.isFrozen(WORKFLOW_PR_PERMISSIONS)).toBe(true);
    expect(SCOPED_MINT_KINDS).toEqual(['actions-dispatch', 'environment-read', 'workflow-pr']);
  });

  it.each(SCOPED_MINT_KINDS)('never caches a %s token: every call mints anew', async (kind) => {
    const auth = authWith({ setupWrite: 'enabled' });
    const first = await auth.mintScoped(kind, TEAM_CONSOLE, recordingAudit().audit);
    const second = await auth.mintScoped(kind, TEAM_CONSOLE, recordingAudit().audit);
    expect(first.bearer()).not.toBe(second.bearer());
    expect(mintBodies()).toHaveLength(2);
  });

  it('audits the attempt before the mint and the success after it, with ids and enums only', async () => {
    const { events, audit } = recordingAudit();
    let mintsWhenAttempted = -1;
    const token = await authWith().mintScoped('environment-read', TEAM_CONSOLE, async (event) => {
      if (event.outcome === 'attempted') {
        mintsWhenAttempted = mintBodies().length;
      }
      await audit(event);
    });
    expect(mintsWhenAttempted).toBe(0);
    expect(events).toEqual([
      { kind: 'environment-read', ...TEAM_CONSOLE, outcome: 'attempted' },
      { kind: 'environment-read', ...TEAM_CONSOLE, outcome: 'minted' },
    ]);
    expect(JSON.stringify(events)).not.toContain(token.bearer());
  });

  describe('the kill switch on the write kind', () => {
    it('refuses workflow-pr with 503 github-write-disabled by default, before any request, and audits both rows', async () => {
      const { events, audit } = recordingAudit();
      const error = await rejection(authWith().mintScoped('workflow-pr', TEAM_CONSOLE, audit));
      expect(error).toBeInstanceOf(GitHubError);
      expect((error as GitHubError).problem).toMatchObject({ type: 'github-write-disabled', status: 503 });
      expect(calls).toEqual([]);
      expect(events).toEqual([
        { kind: 'workflow-pr', ...TEAM_CONSOLE, outcome: 'attempted' },
        { kind: 'workflow-pr', ...TEAM_CONSOLE, outcome: 'failed', failure: 'write-disabled', githubStatus: null },
      ]);
    });

    it('refuses it with the switch explicitly disabled too', async () => {
      const error = await rejection(authWith({ setupWrite: 'disabled' }).mintScoped('workflow-pr', TEAM_CONSOLE, recordingAudit().audit));
      expect((error as GitHubError).problem.type).toBe('github-write-disabled');
      expect(calls).toEqual([]);
    });

    it.each(['actions-dispatch', 'environment-read'] as const)('leaves %s alone', async (kind) => {
      await expect(authWith().mintScoped(kind, TEAM_CONSOLE, recordingAudit().audit)).resolves.toMatchObject({ kind });
    });
  });

  it.each(SCOPED_MINT_KINDS)(
    'audits a %s mint the installation was not granted as permission-missing (GitHub 422)',
    async (kind: ScopedMintKind) => {
      const { events, audit } = recordingAudit();
      const error = await rejection(authWith({ setupWrite: 'enabled' }).mintScoped(kind, PRIVATE_PRODUCT, audit));
      expect((error as GitHubError).githubStatus).toBe(422);
      expect(events.at(-1)).toEqual({
        kind,
        ...PRIVATE_PRODUCT,
        outcome: 'failed',
        failure: 'permission-missing',
        githubStatus: 422,
      });
    },
  );

  it('refuses and revokes a token GitHub minted broader than asked, audited as scope-mismatch', async () => {
    const revoked: string[] = [];
    const broader: FetchLike = async (input, init) => {
      const path = new URL(input).pathname;
      if (path.endsWith('/access_tokens')) {
        return Response.json(
          {
            token: 'ghs_broader',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: { actions: 'read', environments: 'read', secrets: 'read' },
            repository_selection: 'selected',
            repositories: [{ id: TEAM_CONSOLE.repositoryId }],
          },
          { status: 201 },
        );
      }
      if (init.method === 'DELETE') {
        revoked.push(new Headers(init.headers).get('authorization') ?? '');
        return new Response(null, { status: 204 });
      }
      return mock.fetch(input, init);
    };
    const { events, audit } = recordingAudit();
    const auth = new GitHubAppAuth(mock.credentials, { fetch: broader });
    const error = await rejection(auth.mintScoped('environment-read', TEAM_CONSOLE, audit));
    expect((error as GitHubError).problem.type).toBe('github-unexpected');
    expect(revoked).toEqual(['Bearer ghs_broader']);
    expect(events.at(-1)).toMatchObject({ outcome: 'failed', failure: 'scope-mismatch', githubStatus: 201 });
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'workflow-PR', '', 7, null])(
    'refuses the cast kind %j with a TypeError before the audit hook or GitHub hears anything (SEC 2)',
    async (kind) => {
      const { events, audit } = recordingAudit();
      const minting = authWith({ setupWrite: 'enabled' }).mintScoped(kind as unknown as ScopedMintKind, TEAM_CONSOLE, audit);
      await expect(minting).rejects.toThrow(TypeError);
      expect(events).toEqual([]);
      expect(calls).toEqual([]);
    },
  );

  it('mints nothing when the attempt cannot be audited', async () => {
    const failing: ScopedMintAudit = async () => {
      throw new Error('audit store down');
    };
    await expect(authWith().mintScoped('environment-read', TEAM_CONSOLE, failing)).rejects.toThrow('audit store down');
    expect(calls).toEqual([]);
  });

  it('revokes the token when its success cannot be audited, and hands out nothing', async () => {
    const audit: ScopedMintAudit = async (event) => {
      if (event.outcome === 'minted') {
        throw new Error('audit store down');
      }
    };
    await expect(authWith().mintScoped('environment-read', TEAM_CONSOLE, audit)).rejects.toThrow('audit store down');
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /app/installations/1001/access_tokens',
      'DELETE /installation/token',
    ]);
  });

  it('throws the mint’s own error when its failure cannot be audited, and logs the lost row', async () => {
    const logger = recordingLogger();
    const audit: ScopedMintAudit = async (event) => {
      if (event.outcome === 'failed') {
        throw new TypeError('audit store down');
      }
    };
    const error = await rejection(authWith({ logger }).mintScoped('workflow-pr', TEAM_CONSOLE, audit));
    expect((error as GitHubError).problem.type).toBe('github-write-disabled');
    expect(logger.entries).toEqual([
      {
        level: 'error',
        message: 'scoped mint failure not audited',
        fields: { kind: 'workflow-pr', ...TEAM_CONSOLE, reason: 'TypeError' },
      },
    ]);
  });

  it.each([
    ['a zero installation id', { installationId: 0, repositoryId: 1 }],
    ['a fractional repository id', { installationId: 1, repositoryId: 1.5 }],
    ['a negative repository id', { installationId: 1, repositoryId: -3 }],
  ])('refuses %s before auditing or minting', async (_label, target) => {
    const { events, audit } = recordingAudit();
    await expect(authWith().mintScoped('environment-read', target, audit)).rejects.toThrow(RangeError);
    expect(events).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('keeps the bearer out of JSON and string forms of the token', async () => {
    const token = await authWith().mintScoped('environment-read', TEAM_CONSOLE, recordingAudit().audit);
    expect(JSON.stringify({ token })).not.toContain(token.bearer());
    expect(`${String(token)}`).toBe('[environment-read installation token]');
    expect(JSON.parse(JSON.stringify(token))).toEqual({ kind: 'environment-read', ...TEAM_CONSOLE });
  });

  it('revokes a scoped token so that it no longer reads, and logs a failed revoke by kind without the token', async () => {
    const logger = recordingLogger();
    const auth = authWith({ logger });
    const token = await auth.mintScoped('environment-read', TEAM_CONSOLE, recordingAudit().audit);
    await auth.revokeScoped(token);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/installation/token' });
    // The mock answers 401 to a token it no longer knows, so a second revoke is the failed one.
    await expect(auth.revokeScoped(token)).resolves.toBeUndefined();
    expect(logger.entries).toEqual([
      {
        level: 'warn',
        message: 'environment-read installation token not revoked',
        fields: { installationId: TEAM_CONSOLE.installationId, githubStatus: 401 },
      },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain(token.bearer());
  });
});
