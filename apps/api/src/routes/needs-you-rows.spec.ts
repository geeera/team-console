import { env } from 'cloudflare:test';
import {
  NEEDS_YOU_MAX_PROJECTS,
  type InboxDto,
  type NeedsYouDto,
  type QuestionsDto,
} from '@shared/contracts';
import { ApiGitHub } from '../github';
import { fetchApi } from '../testing/access-kit';
import { localEnv, stubGitHub } from '../testing/github-kit';
import { issue, readModelGitHub, type RepoState } from '../testing/read-model-kit';
import { seedAccountProject, seedSessionUser, sendAsSession } from '../testing/session-kit';
import {
  seedAsk,
  seedImportedAsk,
  seedItem,
  seedTrackerProject,
  type SeededProject,
} from '../testing/tracker-kit';

// #434 §6: Needs you, the inbox and the questions of a console-tracker project come from D1 rows, cost no GitHub
// subrequest and do not count against the cap; GitHub-backed projects are read as before. Tracker rows are never
// deleted, so this file archives what a case registered instead of clearing the registry.

afterEach(async () => {
  await env.DB.prepare(
    "UPDATE projects SET archived_at = '2026-11-05T00:00:00Z' WHERE archived_at IS NULL",
  ).run();
  vi.restoreAllMocks();
});

async function seedGitHubProjects(count: number, from = 1): Promise<Record<string, RepoState>> {
  const repos: Record<string, RepoState> = {};
  for (let i = from; i < from + count; i += 1) {
    const slug = `gh${String(i).padStart(2, '0')}-${crypto.randomUUID().slice(0, 4)}`;
    await env.DB.prepare(
      'INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at) VALUES (?1, ?2, ?3, 0, ?4)',
    )
      .bind(slug, `geeera/${slug}`, `GitHub ${String(i)}`, `2026-09-30T00:00:${String(i).padStart(2, '0')}Z`)
      .run();
    repos[`geeera/${slug}`] = {
      issues: [issue(1, ['kind:question']), issue(2, ['needs:owner', 'kind:chore'])],
    };
  }
  return repos;
}

/** A console project with a question (asked), a question with an imported ask, a needs:owner chore and a feature. */
async function seedConsoleProject(): Promise<SeededProject & { readonly askId: number }> {
  const project = await seedTrackerProject();
  const asked = await seedItem(project, { title: 'Pay for the domain?', kind: 'question' });
  const ask = await seedAsk(asked.path, {
    category: 'money',
    ask: 'Approve $12 a year?',
    commands: ['approve'],
    recommended: 'approve',
  });
  await seedItem(project, { title: 'Imported question', kind: 'question' });
  await seedImportedAsk(project.slug, 2);
  await seedItem(project, {
    title: 'Rotate the key',
    kind: 'chore',
    status: 'blocked',
    labels: ['needs:owner'],
  });
  await seedItem(project, { title: 'Just a feature', kind: 'feature', status: 'approved' });
  return { ...project, askId: ask.id };
}

describe('GET /api/v1/needs-you over console-tracker rows', () => {
  it('merges row-backed and GitHub-backed projects into one shape, rows by key and with their ask', async () => {
    const stub = stubGitHub(readModelGitHub(await seedGitHubProjects(1)));
    const project = await seedConsoleProject();
    const response = await fetchApi('/api/v1/needs-you', localEnv(), {
      github: new ApiGitHub({ fetch: stub.fetch }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as NeedsYouDto;
    const console = body.items.filter((item) => item.project.slug === project.slug);
    expect(console.map((item) => [item.section, item.key, item.url, item.allowedCommands])).toEqual([
      ['question', `${project.keyPrefix}-1`, null, ['approve']],
      // The imported ask is not the item's ask (R7): the section's commands, no answer line.
      ['question', `${project.keyPrefix}-2`, null, ['approve', 'reject']],
      ['owner', `${project.keyPrefix}-3`, null, ['done']],
    ]);
    expect(console[0]).toMatchObject({
      ask: 'Approve $12 a year?',
      category: 'money',
      recommendation: 'approve',
      authorTrusted: true,
    });
    expect(console[1]).toMatchObject({ ask: null, category: null });
    // #435: a decision must name the open console ask (#443), so the row carries its id; none for the others.
    expect(console.map((item) => item.askId)).toEqual([project.askId, null, null]);
    expect(
      body.items.filter((item) => item.project.slug !== project.slug).every((item) => item.askId === null),
    ).toBe(true);
    // Inbox order first, then registry order: the GitHub project was registered first.
    expect(body.items.map((item) => item.section)).toEqual([
      'question',
      'question',
      'question',
      'owner',
      'owner',
    ]);
    expect(
      body.items.filter((item) => item.project.slug !== project.slug).every((item) => item.key === null),
    ).toBe(true);
    expect(body.projects.find((row) => row.slug === project.slug)).toMatchObject({
      setup: false,
      paused: false,
      pausedUrl: null,
      problem: null,
    });
  });

  it(`reads every console project and caps only the GitHub-backed ones at ${NEEDS_YOU_MAX_PROJECTS}`, async () => {
    const repos = await seedGitHubProjects(NEEDS_YOU_MAX_PROJECTS + 1);
    const first = await seedConsoleProject();
    const second = await seedConsoleProject();
    const stub = stubGitHub(readModelGitHub(repos));
    const body = (await (
      await fetchApi('/api/v1/needs-you', localEnv(), { github: new ApiGitHub({ fetch: stub.fetch }) })
    ).json()) as NeedsYouDto;
    expect(body.projects).toHaveLength(NEEDS_YOU_MAX_PROJECTS + 2);
    expect(body.projects.map((row) => row.slug)).toEqual(expect.arrayContaining([first.slug, second.slug]));
    expect(body.omittedProjects.map((row) => row.name)).toEqual([
      `GitHub ${String(NEEDS_YOU_MAX_PROJECTS + 1)}`,
    ]);
    // Only the GitHub-backed projects cost subrequests: 4 each on a cold isolate.
    expect(stub.calls).toHaveLength(NEEDS_YOU_MAX_PROJECTS * 4);
  });
});

describe('GET /api/v1/projects/:slug/{inbox,questions} of a console project', () => {
  it('answer from rows with no GitHub call, in the DTOs the GitHub path uses', async () => {
    const project = await seedConsoleProject();
    const stub = stubGitHub(readModelGitHub({}));
    const github = new ApiGitHub({ fetch: stub.fetch });
    const inbox = (await (
      await fetchApi(`/api/v1/projects/${project.slug}/inbox`, localEnv(), { github })
    ).json()) as InboxDto;
    expect(inbox).toMatchObject({ setup: false, setupUrl: null, paused: false, pausedUrl: null });
    expect(inbox.items.map((item) => [item.section, item.number, item.key])).toEqual([
      ['question', 1, `${project.keyPrefix}-1`],
      ['question', 2, `${project.keyPrefix}-2`],
      ['owner', 3, `${project.keyPrefix}-3`],
    ]);
    const questions = (await (
      await fetchApi(`/api/v1/projects/${project.slug}/questions`, localEnv(), { github })
    ).json()) as QuestionsDto;
    expect(inbox.items.map((item) => item.askId)).toEqual([project.askId, null, null]);
    expect(questions.items.map((item) => item.askId)).toEqual([project.askId, null, null]);
    expect(questions.items.map((item) => item.allowedCommands)).toEqual([
      ['approve'],
      ['approve', 'reject'],
      ['done'],
    ]);
    expect(stub.calls).toHaveLength(0);
  });

  it('is still a 404 for an unknown project', async () => {
    const response = await fetchApi('/api/v1/projects/nope-434/inbox', localEnv());
    expect(response.status).toBe(404);
  });
});

describe('GET /api/v1/needs-you: the project’s own pause (#739)', () => {
  it('reports `paused: true` for a console-tracker project team_state holds paused', async () => {
    const project = await seedTrackerProject();
    const stub = stubGitHub(readModelGitHub({}));
    const bindings = { github: new ApiGitHub({ fetch: stub.fetch }) };
    const paused = await fetchApi(`/api/v1/projects/${project.slug}/team/pause`, localEnv(), {
      ...bindings,
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'e2e' }),
    });
    expect(paused.status, await paused.text()).toBe(201);

    const body = (await (await fetchApi('/api/v1/needs-you', localEnv(), bindings)).json()) as NeedsYouDto;
    expect(body.projects.find((row) => row.slug === project.slug)).toMatchObject({ paused: true });
  });
});

describe('GET /api/v1/needs-you: canManage (#735)', () => {
  it('is true for the project’s owner and false for a member of the same account', async () => {
    const owner = await seedSessionUser('owner');
    const member = await seedSessionUser('member');
    // Both read the same project: the member joins the owner's account, not the other way round.
    await env.DB.prepare(
      'INSERT INTO account_members (account_id, user_id, role, joined_at) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(owner.account.id, member.userId, 'member', '2026-11-10T00:00:00.000Z')
      .run();
    const project = await seedAccountProject(owner.account, { tracker: 'console' });
    const github = new ApiGitHub({ fetch: stubGitHub(readModelGitHub({})).fetch });

    const asOwner = (await (
      await sendAsSession(owner, 'GET', '/api/v1/needs-you', undefined, { github })
    ).json()) as NeedsYouDto;
    expect(asOwner.projects.find((row) => row.slug === project.slug)).toMatchObject({ canManage: true });

    const asMember = (await (
      await sendAsSession(member, 'GET', '/api/v1/needs-you', undefined, { github })
    ).json()) as NeedsYouDto;
    expect(asMember.projects.find((row) => row.slug === project.slug)).toMatchObject({ canManage: false });
  });
});
