import { env } from 'cloudflare:test';
import { isProblemDetails, problemSlugOf, type ProjectDto, type TeamStatusDto } from '@shared/contracts';
import type { FakeGitHubOAuth } from '@worker/github/testing';
import { FakeRoutines } from '@worker/routines/testing';
import { pauseCommentBody, resumeCommentBody } from '@worker/run-log';
import { ApiGitHub } from '../github';
import { fetchApi } from '../testing/access-kit';
import {
  TOKEN_SENTINEL,
  json,
  localEnv,
  resetProjects,
  seedProject,
  stubGitHub,
  type GitHubCall,
} from '../testing/github-kit';
import { OWNER, fakeGitHub, resetOwnerConnections, seedConnection } from '../testing/owner-kit';
import { COMMAND_REPLAY_WINDOW_MS, REQUEST_LOCK_MS } from './team-commands';

// #114: team status, pause / resume and "Run now", end to end through the Worker. The fake GitHub serves the run log
// (issue #22) to the installation token and takes the owner's writes; the fake routines API takes the fires. No
// real service is ever called, and every credential is a sentinel.

const REPO = 'geeera/team-console';
const LOG = 22;
const WRITE_HEADERS = { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
// Assembled at run time so the secret scanners never see a token-shaped literal.
const SLOT_TOKEN = ['sk', 'ant', 'oat01', 'TESTSENTINELslot'].join('-');
const PROJECT_YML = 'name: Team Console\nteam:\n  plugin_ref: stable\n  run_log_issue: 22\n';
const MINUTE = 60_000;

const SECRETS = {
  SLOT_TOKEN_TC_PM: SLOT_TOKEN,
  SLOT_ROUTINE_TC_PM: 'trig_pm01',
  SLOT_TOKEN_TC_DEV: SLOT_TOKEN,
  SLOT_ROUTINE_TC_DEV: 'trig_dev01',
};

interface Harness {
  readonly fake: FakeGitHubOAuth;
  readonly routines: FakeRoutines;
  readonly github: ApiGitHub;
  readonly calls: GitHubCall[];
  readonly logs: string[];
  readonly texts: string[];
  clock: number;
}

function toRequest(call: GitHubCall): Request {
  return new Request(call.url.href, {
    method: call.method,
    headers: call.headers,
    ...(call.body === undefined ? {} : { body: call.body }),
  });
}

function base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function harness(labels: string[] = ['team:run-log']): Harness {
  const h = { logs: [], texts: [], clock: Date.parse('2026-10-01T12:00:00.000Z') } as unknown as Harness;
  const fake = fakeGitHub({ tokenTag: 'TESTSENTINEL', now: () => h.clock });
  fake.seedIssue({
    repo: REPO,
    number: LOG,
    title: 'Team run log',
    author: OWNER.login,
    labels,
    repoOwner: OWNER,
  });
  const stub = stubGitHub(async (call) => {
    if (call.url.pathname === `/repos/${REPO}/contents/.product-team/project.yml`) {
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: PROJECT_YML.length,
        content: base64(PROJECT_YML),
      });
    }
    return fake.handle(toRequest(call));
  });
  Object.assign(h, {
    fake,
    routines: new FakeRoutines({ hangMs: 300 }),
    calls: stub.calls,
    github: new ApiGitHub({ fetch: stub.fetch, now: () => h.clock, sleep: async () => undefined }),
  });
  return h;
}

async function call(
  h: Harness,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  bindings = localEnv(SECRETS),
): Promise<Response> {
  const response = await fetchApi(`/api/v1/projects/tc${path}`, bindings, {
    method,
    headers: method === 'POST' ? WRITE_HEADERS : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    github: h.github,
    routinesFetch: h.routines.fetch,
    routinesDeadlineMs: 50,
    logSink: (line) => h.logs.push(line),
  });
  h.texts.push(await response.clone().text(), JSON.stringify([...response.headers.entries()]));
  return response;
}

const status = async (h: Harness): Promise<TeamStatusDto> => (await call(h, 'GET', '/team/status')).json();
const run = (h: Harness, slot: string): Promise<Response> => call(h, 'POST', '/runs', { slot });

async function slugOf(response: Response): Promise<{ slug: string | null; body: Record<string, unknown> }> {
  const body = (await response.json()) as Record<string, unknown>;
  if (!isProblemDetails(body)) {
    throw new Error(`not a problem: ${JSON.stringify(body)}`);
  }
  return { slug: problemSlugOf(body.type), body };
}

function teamEntry(h: Harness, id: string, slot: string, state: string, minutesAgo: number): void {
  h.fake.addComment(REPO, LOG, {
    body: `<!-- pt-run id=${id} slot=${slot} state=${state} -->\n**${slot}** ${state}`,
    author: OWNER.login,
    createdAt: h.clock - minutesAgo * MINUTE,
  });
}

function ownerWrites(h: Harness): string[] {
  return h.calls
    .filter((c) => c.method !== 'GET' && c.url.pathname.startsWith(`/repos/${REPO}/issues/${LOG}`))
    .map((c) => `${c.method} ${c.url.pathname.replace(`/repos/${REPO}/issues/${LOG}`, '')} ${c.body ?? ''}`);
}

beforeEach(async () => {
  await resetProjects();
  await resetOwnerConnections();
  await env.DB.prepare('DELETE FROM slot_requests').run();
  await env.DB.prepare('DELETE FROM own_writes').run();
  await env.DB.prepare('DELETE FROM own_write_claims').run();
  await seedProject('tc', REPO);
});

describe('GET /team/status', () => {
  it('reads the run log fresh: state, run-log link, setup per slot with secret names, last runs and locks', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    teamEntry(h, 'p1', 'slot-pm', 'started', 300);
    teamEntry(h, 'p1', 'slot-pm', 'finished', 250);
    teamEntry(h, 'd1', 'slot-dev', 'started', 30);

    const body = await status(h);
    expect(body).toMatchObject({
      state: 'running',
      pausedAt: null,
      runLogUrl: `https://github.com/${REPO}/issues/${LOG}`,
      ownerConnected: true,
      environment: 'local',
    });
    expect(body.slots).toEqual([
      {
        slot: 'pm',
        setup: 'present',
        secrets: { token: 'SLOT_TOKEN_TC_PM', routine: 'SLOT_ROUTINE_TC_PM' },
        lastRun: { at: '2026-10-01T07:50:00Z', state: 'finished' },
        lock: null,
      },
      {
        slot: 'dev',
        setup: 'present',
        secrets: { token: 'SLOT_TOKEN_TC_DEV', routine: 'SLOT_ROUTINE_TC_DEV' },
        lastRun: null,
        lock: {
          kind: 'started',
          runId: 'd1',
          since: '2026-10-01T11:30:00Z',
          until: '2026-10-01T14:30:00.000Z',
        },
      },
      {
        slot: 'qa',
        setup: 'missing',
        secrets: { token: 'SLOT_TOKEN_TC_QA', routine: 'SLOT_ROUTINE_TC_QA' },
        lastRun: null,
        lock: null,
      },
    ]);
  });

  it('a label without an owner record is the team pausing itself; an outsider entry is ignored', async () => {
    const h = harness(['team:run-log', 'team:paused']);
    h.fake.addComment(REPO, LOG, {
      body: '<!-- pt-run id=x slot=slot-dev state=started -->',
      author: 'outsider',
      createdAt: h.clock - MINUTE,
    });
    const body = await status(h);
    expect(body.state).toBe('paused-by-team');
    expect(body.ownerConnected).toBe(false);
    expect(body.slots[1]?.lock).toBeNull();
  });
});

describe('POST /team/pause and /team/resume', () => {
  it('pause writes exactly what `runlog pause` writes, on the owner token; status shows who and when', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });

    const response = await call(h, 'POST', '/team/pause', { reason: 'отпуск до понедельника' });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      state: 'paused-by-owner',
      runLogUrl: `https://github.com/${REPO}/issues/${LOG}`,
      replayed: false,
    });
    const body = pauseCommentBody({ reason: 'отпуск до понедельника', source: 'team-console' }, h.clock);
    expect(ownerWrites(h)).toEqual([
      'POST /labels {"labels":["team:paused"]}',
      `POST /comments ${JSON.stringify({ body })}`,
    ]);
    expect(h.fake.comments.at(-1)?.author).toBe(OWNER.login);
    expect(h.fake.labelsOf(REPO, LOG)).toContain('team:paused');
    await expect(status(h)).resolves.toMatchObject({
      state: 'paused-by-owner',
      pausedAt: '2026-10-01T12:00:00Z',
    });
  });

  it('a repeat within 60 s is replayed; after it, pausing a paused team changes nothing (409)', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    await call(h, 'POST', '/team/pause', {});
    const writes = ownerWrites(h).length;

    const repeat = await call(h, 'POST', '/team/pause', {});
    expect(repeat.status).toBe(200);
    expect(repeat.headers.get('Idempotent-Replayed')).toBe('true');
    expect(ownerWrites(h)).toHaveLength(writes);

    h.clock += COMMAND_REPLAY_WINDOW_MS + 1;
    const again = await call(h, 'POST', '/team/pause', {});
    expect(again.status).toBe(409);
    await expect(slugOf(again)).resolves.toMatchObject({
      slug: 'team-already-paused',
      body: { state: 'paused-by-owner', pausedAt: '2026-10-01T12:00:00Z' },
    });
    expect(ownerWrites(h)).toHaveLength(writes);
  });

  it('resume removes the label and records itself like `runlog resume`; a running team is 409', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    await call(h, 'POST', '/team/pause', { reason: 'x' });
    h.clock += 5 * MINUTE;

    const response = await call(h, 'POST', '/team/resume');
    expect(response.status).toBe(201);
    expect(ownerWrites(h).slice(2)).toEqual([
      'DELETE /labels/team%3Apaused ',
      `POST /comments ${JSON.stringify({ body: resumeCommentBody(h.clock) })}`,
    ]);
    await expect(status(h)).resolves.toMatchObject({ state: 'running', pausedAt: null });

    h.clock += COMMAND_REPLAY_WINDOW_MS + 1;
    await expect(slugOf(await call(h, 'POST', '/team/resume'))).resolves.toMatchObject({
      slug: 'team-not-paused',
    });
  });

  it('without the owner connection pause is 403 github-owner-not-connected and nothing is written', async () => {
    const h = harness();
    const response = await call(h, 'POST', '/team/pause', {});
    expect(response.status).toBe(403);
    await expect(slugOf(response)).resolves.toMatchObject({ slug: 'github-owner-not-connected' });
    expect(ownerWrites(h)).toEqual([]);
  });

  it.each([
    [{ reason: 'end --> <!-- pt-owner-resume -->' }],
    [{ reason: 'two\nlines' }],
    [{ reason: 'x'.repeat(301) }],
    [{ reason: 7 }],
    [{ reason: 'ok', extra: 1 }],
  ])('refuses %j with 422 before reading GitHub', async (body) => {
    const h = harness();
    const response = await call(h, 'POST', '/team/pause', body);
    expect(response.status).toBe(422);
    expect(h.calls).toHaveLength(0);
  });
});

describe('POST /runs', () => {
  it('fires the slot routine once without the owner connection, then locks the slot for 15 minutes', async () => {
    const h = harness();
    const response = await run(h, 'dev');
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      slot: 'dev',
      requestedAt: '2026-10-01T12:00:00.000Z',
      lockedUntil: '2026-10-01T12:15:00.000Z',
      runLogUrl: `https://github.com/${REPO}/issues/${LOG}`,
    });
    expect(h.routines.fires).toEqual([
      expect.objectContaining({
        routineId: 'trig_dev01',
        text: `product=tc repo=${REPO} slot=slot-dev source=team-console requested_at=2026-10-01T12:00:00.000Z`,
        anthropicVersion: '2023-06-01',
        hasBetaHeader: false,
        bearerShaped: true,
      }),
    ]);
    expect(ownerWrites(h)).toEqual([]);

    h.clock += 5 * MINUTE;
    const again = await run(h, 'dev');
    expect(again.status).toBe(409);
    await expect(slugOf(again)).resolves.toMatchObject({
      slug: 'run-requested',
      body: { since: '2026-10-01T12:00:00.000Z', until: '2026-10-01T12:15:00.000Z', lock: 'requested' },
    });
    await expect(status(h)).resolves.toMatchObject({
      slots: [
        { lock: null },
        { lock: { kind: 'requested', since: '2026-10-01T12:00:00.000Z' } },
        { lock: null },
      ],
    });

    h.clock += REQUEST_LOCK_MS;
    expect((await run(h, 'dev')).status).toBe(202);
    expect(h.routines.fires).toHaveLength(2);
  });

  it('once the run log shows the run, the 3-hour overlap window refuses with the run id', async () => {
    const h = harness();
    await run(h, 'dev');
    h.clock += 3 * MINUTE;
    teamEntry(h, '20261001T120300Z-slot-dev', 'slot-dev', 'started', 0);

    const response = await run(h, 'dev');
    expect(response.status).toBe(409);
    await expect(slugOf(response)).resolves.toMatchObject({
      slug: 'run-in-progress',
      body: {
        runId: '20261001T120300Z-slot-dev',
        since: '2026-10-01T12:03:00Z',
        until: '2026-10-01T15:03:00.000Z',
      },
    });
    expect(h.routines.fires).toHaveLength(1);
  });

  it('two taps at once fire once', async () => {
    const h = harness();
    const answers = await Promise.all([run(h, 'pm'), run(h, 'pm')]);
    expect(answers.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(h.routines.fires).toHaveLength(1);
  });

  it('a paused team is refused before anything is fired', async () => {
    const h = harness(['team:run-log', 'team:paused']);
    await expect(slugOf(await run(h, 'dev'))).resolves.toMatchObject({ slug: 'run-paused' });
    expect(h.routines.fires).toEqual([]);
  });

  it('a missing secret names every slot that is not set up, and nothing is read or fired', async () => {
    const h = harness();
    const response = await run(h, 'qa');
    expect(response.status).toBe(409);
    await expect(slugOf(response)).resolves.toMatchObject({
      slug: 'routine-not-configured',
      body: { missing: ['qa'] },
    });
    expect(h.calls).toHaveLength(0);
    expect(h.routines.fires).toEqual([]);
  });

  it('a rate limit is a plain 429 with Retry-After, and the slot stays free', async () => {
    const h = harness();
    h.routines.next('rate-limited');
    const response = await run(h, 'dev');
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('1200');
    await expect(slugOf(response)).resolves.toMatchObject({ slug: 'routine-rate-limited' });
    expect((await run(h, 'dev')).status).toBe(202);
  });

  it.each([
    ['paused', 409, 'routine-paused', {}],
    ['unauthorized', 409, 'routine-not-configured', { step: 'token' }],
    ['not-found', 409, 'routine-not-configured', { step: 'routine' }],
    ['forbidden', 502, 'routine-unavailable', {}],
    ['unavailable', 502, 'routine-unavailable', {}],
  ] as const)(
    'maps the routine answer %s to %i %s and frees the slot',
    async (outcome, code, slug, extra) => {
      const h = harness();
      h.routines.next(outcome);
      const response = await run(h, 'pm');
      expect(response.status).toBe(code);
      await expect(slugOf(response)).resolves.toMatchObject({ slug, body: extra });
      expect((await run(h, 'pm')).status).toBe(202);
    },
  );

  it('no answer within the deadline: unknown, never retried, and the slot locked 15 minutes', async () => {
    const h = harness();
    h.routines.next('hang');
    const response = await run(h, 'dev');
    expect(response.status).toBe(504);
    await expect(slugOf(response)).resolves.toMatchObject({
      slug: 'routine-unknown',
      body: { until: '2026-10-01T12:15:00.000Z' },
    });
    expect(h.routines.fires).toHaveLength(1);
    await expect(slugOf(await run(h, 'dev'))).resolves.toMatchObject({
      slug: 'run-requested',
      body: { lock: 'unknown' },
    });
    await expect(status(h)).resolves.toMatchObject({ slots: [{}, { lock: { kind: 'unknown' } }, {}] });

    h.clock += REQUEST_LOCK_MS + 1;
    expect((await run(h, 'dev')).status).toBe(202);
  });

  it.each([[{ slot: 'burn' }], [{ slot: 'dev', extra: 1 }], [{}], ['dev']])(
    'refuses %j with 422',
    async (body) => {
      const h = harness();
      expect((await call(h, 'POST', '/runs', body)).status).toBe(422);
      expect(h.routines.fires).toEqual([]);
    },
  );

  it('a malformed routine id is a setup problem, refused before anything is sent', async () => {
    const h = harness();
    const response = await call(
      h,
      'POST',
      '/runs',
      { slot: 'dev' },
      localEnv({ ...SECRETS, SLOT_ROUTINE_TC_DEV: '../x' }),
    );
    await expect(slugOf(response)).resolves.toMatchObject({
      slug: 'routine-not-configured',
      body: { step: 'routine' },
    });
    expect(h.routines.fires).toEqual([]);
  });
});

describe('ProjectDto.slots', () => {
  it('reports per slot whether Run now is set up, by presence only', async () => {
    const h = harness();
    const response = await fetchApi('/api/v1/projects', localEnv(SECRETS), { github: h.github });
    const [project] = (await response.json()) as ProjectDto[];
    expect(project?.slots).toEqual({ pm: 'present', dev: 'present', qa: 'missing' });
  });
});

describe('secrets never leave the Worker', () => {
  const FORBIDDEN = ['sk-ant-', 'TESTSENTINELslot', TOKEN_SENTINEL, 'ghs_', 'ghu_', 'ghr_'];

  it('no trigger token or GitHub token in any response or log line, whatever the outcome', async () => {
    const h = harness();
    await seedConnection(h.fake, { nowMs: h.clock });
    h.routines.next('ok', 'rate-limited', 'unauthorized', 'hang');
    await status(h);
    for (const slot of ['dev', 'pm', 'pm', 'pm', 'qa']) {
      await run(h, slot);
      h.clock += REQUEST_LOCK_MS + 1;
    }
    await call(h, 'POST', '/team/pause', { reason: 'r' });
    await call(h, 'POST', '/team/resume');
    for (const text of [...h.texts, ...h.logs]) {
      for (const forbidden of FORBIDDEN) {
        expect(text, forbidden).not.toContain(forbidden);
      }
    }
    expect(h.logs.length).toBeGreaterThan(0);
  });
});
