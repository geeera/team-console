import { ANSWERS } from '@shared/owner-grammar';
import edgeCases from '../../fixtures/edge-cases.json';
import edgeCasesExpected from '../../fixtures/edge-cases.expected.json';
import storify from '../../fixtures/storify.json';
import storifyExpected from '../../fixtures/storify.expected.json';
import teamConsole from '../../fixtures/team-console.json';
import teamConsoleExpected from '../../fixtures/team-console.expected.json';
import {
  isGitHubIssue,
  isGitHubMilestone,
  isGitHubPullRequest,
  issueRecordOf,
  milestoneRecordOf,
  pullRequestRecordOf,
  type IssueRecord,
} from './github-records';
import { buildInbox, buildQuestions } from './inbox';
import { parseProjectConfig } from './project-config';
import { buildSprint, pickCurrentSprint } from './sprint';

// Golden tests (#35): the read models equal what the vendored plugin computes from the same GitHub JSON. The
// `.expected.json` files are written by `python3 libs/worker/read-models/fixtures/golden.py` from the plugin's own
// Python; team-console.json and storify.json are snapshots of real product repositories (storify anonymised).

interface Fixture {
  readonly repo: string;
  readonly today: string;
  readonly projectYml: string;
  readonly openIssues: readonly unknown[];
  readonly milestones: readonly unknown[];
  readonly milestoneIssues: Readonly<Record<string, readonly unknown[]>>;
  readonly openPulls: readonly unknown[];
}

interface ExpectedItem {
  readonly section: string;
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly ask: string | null;
}

interface Expected {
  readonly inbox: {
    readonly reviewerLogins: readonly string[];
    readonly items: readonly ExpectedItem[];
    readonly setup: boolean;
    readonly setupUrl: string | null;
    readonly paused: boolean;
    readonly pausedUrl: string | null;
  };
  readonly sprint: {
    readonly milestone: { readonly number: number; readonly title: string; readonly dueOn: string } | null;
    readonly issues?: readonly {
      readonly number: number;
      readonly status: string | null;
      readonly kind: string | null;
      readonly state: string;
    }[];
    readonly byStatus?: Readonly<Record<string, number>>;
    readonly planned?: number;
    readonly shipped?: number;
    readonly carriedOver?: number;
    readonly byTier?: Readonly<Record<string, unknown>>;
  };
}

function issues(raw: readonly unknown[]): IssueRecord[] {
  return raw.map((value) => {
    if (!isGitHubIssue(value)) {
      throw new Error(`fixture issue of an unexpected shape: ${JSON.stringify(value).slice(0, 80)}`);
    }
    return issueRecordOf(value);
  });
}

// The plugin keeps any html_url; the read models keep only github.com pages (#9 threat row 4).
function sanitisedUrl(url: string | null): string | null {
  return url !== null && url.startsWith('https://github.com/') ? url : null;
}

const CASES: readonly (readonly [string, Fixture, Expected])[] = [
  ['team-console', teamConsole, teamConsoleExpected],
  ['storify', storify, storifyExpected],
  ['edge-cases', edgeCases, edgeCasesExpected],
];

describe.each(CASES)('golden: %s', (_name, fixture, expected) => {
  const openIssues = issues(fixture.openIssues);
  const config = parseProjectConfig(fixture.projectYml);

  it('reads team.reviewer_logins as the plugin does', () => {
    expect(config.reviewerLogins).toEqual(expected.inbox.reviewerLogins);
  });

  it('builds the inbox the plugin builds: same items, same order, same answer lines, same flags', () => {
    const inbox = buildInbox({
      openIssues,
      reviewerLogins: config.reviewerLogins,
      repoFullName: fixture.repo,
    });

    expect(inbox.items.map(({ section, number, title, ask }) => ({ section, number, title, ask }))).toEqual(
      expected.inbox.items.map(({ section, number, title, ask }) => ({ section, number, title, ask })),
    );
    expect(inbox.items.map((item) => item.url)).toEqual(
      expected.inbox.items.map((item) => sanitisedUrl(item.url)),
    );
    expect({
      setup: inbox.setup,
      setupUrl: inbox.setupUrl,
      paused: inbox.paused,
      pausedUrl: inbox.pausedUrl,
    }).toEqual({
      setup: expected.inbox.setup,
      setupUrl: expected.inbox.setupUrl,
      paused: expected.inbox.paused,
      pausedUrl: sanitisedUrl(expected.inbox.pausedUrl),
    });
  });

  it('lists the same items as questions, each with the answers brief.ANSWERS allows', () => {
    const questions = buildQuestions(openIssues);

    expect(questions.items.map((item) => [item.section, item.number])).toEqual(
      expected.inbox.items.map((item) => [item.section, item.number]),
    );
    for (const item of questions.items) {
      expect(item.allowedCommands).toEqual(ANSWERS[item.section]);
    }
  });

  it('picks the sprint and counts it as the plugin does', () => {
    const milestones = fixture.milestones.map((value) => {
      if (!isGitHubMilestone(value)) {
        throw new Error('fixture milestone of an unexpected shape');
      }
      return milestoneRecordOf(value);
    });
    const milestone = pickCurrentSprint(milestones, fixture.today);
    const sprint = buildSprint({
      milestone,
      milestoneIssues:
        milestone === null ? [] : issues(fixture.milestoneIssues[String(milestone.number)] ?? []),
      openPullRequests: fixture.openPulls.map((value) => {
        if (!isGitHubPullRequest(value)) {
          throw new Error('fixture pull request of an unexpected shape');
        }
        return pullRequestRecordOf(value);
      }),
    });

    expect(sprint.milestone === null ? null : { ...sprint.milestone, url: undefined }).toEqual(
      expected.sprint.milestone === null ? null : { ...expected.sprint.milestone, url: undefined },
    );
    if (expected.sprint.milestone === null) {
      return;
    }
    expect(sprint.issues.map(({ number, status, kind, state }) => ({ number, status, kind, state }))).toEqual(
      expected.sprint.issues,
    );
    expect(sprint.byStatus).toEqual(expected.sprint.byStatus);
    expect({
      planned: sprint.planned,
      shipped: sprint.shipped,
      carriedOver: sprint.carriedOver,
      byTier: sprint.byTier,
    }).toEqual({
      planned: expected.sprint.planned,
      shipped: expected.sprint.shipped,
      carriedOver: expected.sprint.carriedOver,
      byTier: expected.sprint.byTier,
    });
  });
});

describe('golden fixtures cover what they claim to', () => {
  it('the team-console snapshot holds the owner items of the live inbox (#31) on 2026-09-30', () => {
    expect(teamConsoleExpected.inbox.items.map((item) => item.number)).toEqual([21, 46]);
  });

  it('the edge cases hit every section, an untrusted author and a non-GitHub url', () => {
    const sections = new Set(edgeCasesExpected.inbox.items.map((item) => item.section));
    expect([...sections].sort()).toEqual(['design', 'local', 'owner', 'question', 'release']);
    expect(
      issues(edgeCases.openIssues).some((issue) => issue.number === 14 && issue.authorAssociation === 'NONE'),
    ).toBe(true);
    expect(edgeCasesExpected.inbox.items.some((item) => item.url?.startsWith('javascript:'))).toBe(true);
  });
});
