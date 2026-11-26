import { env } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID } from '@shared/contracts';
import claimWithConfig from '../../../fixtures/team-config/claim.with-config.json';
import getRecommended from '../../../fixtures/team-config/get.recommended.json';
import importDraft from '../../../fixtures/team-config/import.draft.json';
import putAccessSourceHosted from '../../../fixtures/team-config/put.access-source-hosted.json';
import putChanged from '../../../fixtures/team-config/put.changed.json';
import putInvalidNested from '../../../fixtures/team-config/put.invalid-nested.json';
import putInvalidRole from '../../../fixtures/team-config/put.invalid-role.json';
import putInvalid from '../../../fixtures/team-config/put.invalid.json';
import putSchema from '../../../fixtures/team-config/put.schema.json';
import putStale from '../../../fixtures/team-config/put.stale.json';
import resetEconomy from '../../../fixtures/team-config/reset.economy.json';
import resolvedJob from '../../../fixtures/team-config/resolved.job.json';
import resolvedOtherProject from '../../../fixtures/team-config/resolved.other-project.json';
import revisionsGet from '../../../fixtures/team-config/revisions.get.json';
import revisionsList from '../../../fixtures/team-config/revisions.list.json';
import type { ApiGitHub } from '../../github';
import { json } from '../../testing/github-kit';
import { enqueueJob, enrolRunner, sendAsRunner, type TestRunner } from '../../testing/runner-kit';
import { pullRequestsGitHub, seedTrackerProject, send, type SeededProject } from '../../testing/tracker-kit';

/*
 * #687 (ADR 0009 d.10): the team-config contract fixtures, one request and its response per file in
 * `apps/api/fixtures/team-config/`, replayed here through the whole app exactly as #610 replays the tracker's
 * (`routes/tracker/contract-fixtures.spec.ts`): the plugin's `fixtures` CI job diffs this directory at its contract
 * lock, and the runner feeds `claim.with-config` to its launch (PR 3). A preset or allow-list change is a fixture
 * change, so every consumer sees it in one diff.
 *
 * A fixture names the project `tc`; the spec seeds a fresh project per fixture and maps the slug both ways. Every
 * `…At` instant and `leaseUntil` read `2026-11-12T10:00:00.000Z`, `instance` reads `request-id`, the job token
 * `tcj_job-token`, and ULIDs are renumbered `0…0n` per member in order of appearance. To update a fixture, run this
 * spec and copy the `actual` it prints into the file's `response`.
 */

interface Fixture {
  readonly route: string;
  readonly as: { readonly kind: string; readonly role: string; readonly items: readonly number[] };
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly ifMatch?: string;
    readonly body?: unknown;
  };
  readonly response: { readonly status: number; readonly body: unknown };
}

interface Seeded {
  /** The project a job belongs to when it is not the path's. */
  readonly projectSlug?: string;
  readonly github?: ApiGitHub;
  readonly runner?: TestRunner;
  /** Undone after the request, so a fixture's state never reaches the next one's project. */
  readonly cleanup?: () => Promise<void>;
}

type Setup = (project: SeededProject) => Promise<Seeded | void>;

const FIXED_AT = '2026-11-12T10:00:00.000Z';
const P = '/api/v1/projects';

async function save(
  project: SeededProject,
  config: unknown,
  ifMatch: string,
  reason?: string,
): Promise<void> {
  const response = await send(
    'PUT',
    `${P}/${project.slug}/team-config`,
    { config, ...(reason === undefined ? {} : { reason }) },
    { ifMatch },
  );
  if (response.status !== 200) {
    throw new Error(`seeding a team configuration answered ${String(response.status)}`);
  }
}

const savedOnce: Setup = async (project) =>
  save(project, { schema: 'team-config/v1', access: { source: 'api_key' } }, '"0"');

const twoRevisions: Setup = async (project) => {
  await save(project, { schema: 'team-config/v1', access: { source: 'api_key' } }, '"0"', 'First import');
  await save(
    project,
    { schema: 'team-config/v1', access: { source: 'api_key' }, preset: 'economy', language: 'en' },
    '"1"',
  );
};

const HOSTED_RUNNER = '01M6YSNJ0000000000HXSTFX01';

/** A hosted runner of the owner's account, which every subscription project with an open policy would admit. */
const hostedRunner: Setup = async () => {
  await env.DB.prepare(
    `INSERT INTO runners (id, account_id, name, public_key_jwk, capabilities, hosted, isolation, allowed_projects, version, enrolled_at)
     VALUES (?1, ?2, 'hosted', ?3, '{"local":false,"maxConcurrency":1}', 1, 'container', '[]', '0.1.0', ?4)`,
  )
    .bind(
      HOSTED_RUNNER,
      OWNER_ACCOUNT_ID,
      JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'f'.repeat(43) }),
      FIXED_AT,
    )
    .run();
  return {
    cleanup: async () => {
      await env.DB.prepare(`UPDATE runners SET revoked_at = ?2 WHERE id = ?1`)
        .bind(HOSTED_RUNNER, FIXED_AT)
        .run();
    },
  };
};

const PROJECT_YML = [
  'name: Acme',
  'review:',
  '  qa: never',
  '  reviewer: code',
  '  code_paths: ["apps/**", "libs/**"]',
  '  max_rework_rounds: 1',
  '  model: claude-fable-5-1',
  'caps:',
  '  burn: { dev_tasks: 4, parallel_devs: 2 }',
  'sprint:',
  '  length_days: 14',
  '  freeze_days: 2',
  'owner:',
  '  language: ru',
  'budget:',
  '  monthly_usd: 100000',
].join('\n');

const withProjectYml: Setup = async () => {
  const bytes = new TextEncoder().encode(PROJECT_YML);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const { github } = pullRequestsGitHub(
    () => null,
    (call) =>
      call.url.pathname.endsWith('/contents/.product-team/project.yml')
        ? json(200, {
            type: 'file',
            size: bytes.length,
            sha: 'c'.repeat(40),
            encoding: 'base64',
            content: btoa(binary),
          })
        : null,
  );
  return { github };
};

const claimable: Setup = async (project) => {
  await save(project, { schema: 'team-config/v1', preset: 'economy', access: { source: 'api_key' } }, '"0"');
  await enqueueJob(project.slug, { kind: 'slot-qa' });
  return { runner: await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [project.slug] }) };
};

const SETUPS: Readonly<Record<string, readonly [Fixture, Setup]>> = {
  'get.recommended': [getRecommended, async () => undefined],
  'put.changed': [putChanged, async () => undefined],
  'put.stale': [putStale, savedOnce],
  'put.invalid': [putInvalid, async () => undefined],
  'put.invalid-role': [putInvalidRole, async () => undefined],
  'put.invalid-nested': [putInvalidNested, async () => undefined],
  'put.schema': [putSchema, async () => undefined],
  'put.access-source-hosted': [putAccessSourceHosted, hostedRunner],
  'reset.economy': [resetEconomy, savedOnce],
  'import.draft': [importDraft, withProjectYml],
  'revisions.list': [revisionsList, twoRevisions],
  'revisions.get': [revisionsGet, twoRevisions],
  'resolved.job': [resolvedJob, savedOnce],
  'resolved.other-project': [
    resolvedOtherProject,
    async () => ({ projectSlug: (await seedTrackerProject()).slug }),
  ],
  'claim.with-config': [claimWithConfig, claimable],
};

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function stabilised(value: unknown, ids: Map<string, Map<string, number>>, key = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stabilised(entry, ids));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([member, entry]) => [
        member,
        stabilised(entry, ids, member),
      ]),
    );
  }
  if (typeof value === 'string' && (key.endsWith('At') || key === 'leaseUntil')) {
    return FIXED_AT;
  }
  if (typeof value === 'string' && key === 'instance') {
    return 'request-id';
  }
  if (typeof value === 'string' && key === 'jobToken') {
    return 'tcj_job-token';
  }
  if (typeof value === 'string' && ULID.test(value)) {
    const seen = ids.get(key) ?? new Map<string, number>();
    ids.set(key, seen);
    const renumbered = seen.get(value) ?? seen.size + 1;
    seen.set(value, renumbered);
    return String(renumbered).padStart(26, '0');
  }
  return value;
}

const toProject = (text: string, project: SeededProject): string =>
  text.replaceAll('/tc/', `/${project.slug}/`);
const fromProject = (text: string, project: SeededProject): string =>
  text.replaceAll(project.slug, 'tc').replaceAll(`acme/${project.slug}`, 'acme/tc');

async function replay(fixture: Fixture, project: SeededProject, seeded: Seeded): Promise<Response> {
  const path = toProject(fixture.request.path, project);
  const method = fixture.request.method as 'GET' | 'POST' | 'PUT';
  if (fixture.as.kind === 'runner') {
    if (seeded.runner === undefined) {
      throw new Error('a runner fixture needs a runner');
    }
    return sendAsRunner(seeded.runner, method, path, fixture.request.body);
  }
  return send(method, path, fixture.request.body, {
    ...(seeded.github === undefined ? {} : { github: seeded.github }),
    ...(fixture.request.ifMatch === undefined ? {} : { ifMatch: fixture.request.ifMatch }),
    ...(fixture.as.kind === 'job'
      ? {
          job: {
            role: fixture.as.role,
            items: fixture.as.items,
            ...(seeded.projectSlug === undefined ? {} : { projectSlug: seeded.projectSlug }),
          },
        }
      : {}),
  });
}

describe('the team-config contract fixtures (#687, as #610)', () => {
  it('has a setup for every fixture and a fixture for every team-config route and the claim', () => {
    expect([...new Set(Object.values(SETUPS).map(([fixture]) => fixture.route))].sort()).toEqual([
      'GET /api/v1/projects/:slug/team-config',
      'GET /api/v1/projects/:slug/team-config/resolved',
      'GET /api/v1/projects/:slug/team-config/revisions',
      'GET /api/v1/projects/:slug/team-config/revisions/:n',
      'POST /api/v1/projects/:slug/team-config/import',
      'POST /api/v1/projects/:slug/team-config/reset',
      'POST /api/v1/runner/jobs/claim',
      'PUT /api/v1/projects/:slug/team-config',
    ]);
  });

  it.each(Object.entries(SETUPS))('%s answers as the fixture says', async (name, [fixture, setup]) => {
    const project = await seedTrackerProject();
    const seeded = (await setup(project)) ?? {};
    let response: Response;
    try {
      response = await replay(fixture, project, seeded);
    } finally {
      await seeded.cleanup?.();
    }
    const text = await response.text();
    const actual = {
      status: response.status,
      body: stabilised(JSON.parse(fromProject(text, project)) as unknown, new Map()),
    };
    if (JSON.stringify(actual) !== JSON.stringify(fixture.response)) {
      console.log(`FIXTURE ${name} ${JSON.stringify(actual)}`);
    }
    expect(actual).toEqual(fixture.response);
  });

  // Threat model C12 row 2: what a job reads is the resolved view and nothing else — a key set, not a snapshot.
  it('keeps resolved.job free of budget, preset, reason, author and diff', () => {
    const body = resolvedJob.response.body as unknown as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'access',
      'caps',
      'cost',
      'gates',
      'language',
      'revision',
      'roles',
      'schema',
      'sprint',
    ]);
    const keysOf = (value: unknown): string[] =>
      typeof value === 'object' && value !== null
        ? Object.entries(value).flatMap(([key, member]) => [key, ...keysOf(member)])
        : [];
    for (const key of ['budget', 'preset', 'reason', 'created_by', 'createdBy', 'diff']) {
      expect(keysOf(body)).not.toContain(key);
    }
  });
});
