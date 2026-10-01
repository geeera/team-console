import type { InboxDto, InboxItemDto, QuestionDto, QuestionsDto } from '@shared/contracts';
import { ANSWERS, askOf, kindOf, sectionOf, sectionRank } from '@shared/owner-grammar';
import type { IssueRecord } from './github-records';
import { githubUrlOrNull, isTrustedAuthor } from './untrusted-text';

/**
 * The owner's inbox for one repository, as the plugin's `scripts/inbox` builds it and `brief.needs` lists it:
 * open issues without pull requests, the inbox and the run-log issues left out, classified, sorted by
 * section order and then issue number.
 */

/** The issues `scripts/inbox` classifies (`mine`). */
function ownerFacing(issues: readonly IssueRecord[]): IssueRecord[] {
  return issues.filter(
    (issue) =>
      !issue.isPullRequest && !issue.labels.includes('team:inbox') && !issue.labels.includes('team:run-log'),
  );
}

interface Classified {
  readonly issue: IssueRecord;
  readonly item: InboxItemDto;
}

function classified(issues: readonly IssueRecord[]): Classified[] {
  const found: Classified[] = [];
  for (const issue of ownerFacing(issues)) {
    const section = sectionOf(issue.labels, kindOf(issue.labels));
    if (section === null) {
      continue;
    }
    found.push({
      issue,
      item: {
        section,
        number: issue.number,
        title: issue.title,
        url: githubUrlOrNull(issue.htmlUrl),
        // brief.needs: an empty answer line is no answer line (`issue.get("ask") or …` → None).
        ask: askOf(issue.body) || null,
        authorTrusted: isTrustedAuthor(issue),
      },
    });
  }
  return found.sort(
    (a, b) => sectionRank(a.item.section) - sectionRank(b.item.section) || a.item.number - b.item.number,
  );
}

/** `brief.needs` over a repository's open issues. */
export function needsOf(openIssues: readonly IssueRecord[]): InboxItemDto[] {
  return classified(openIssues).map(({ item }) => item);
}

export interface InboxInput {
  /** The repository's open issues (pull requests may be in the list; they are dropped). */
  readonly openIssues: readonly IssueRecord[];
  /** `team.reviewer_logins` of project.yml: empty means the agents may act as the owner. */
  readonly reviewerLogins: readonly string[];
  /** `owner/name`, already validated (`RepoName.fullName`): the owner checklist link is built from it. */
  readonly repoFullName: string;
}

export function buildInbox(input: InboxInput): InboxDto {
  // `scripts/inbox`: any open issue labelled team:paused (the run log) pauses the team.
  const paused = input.openIssues.find(
    (issue) => !issue.isPullRequest && issue.labels.includes('team:paused'),
  );
  const setup = input.reviewerLogins.length === 0;
  return {
    items: needsOf(input.openIssues),
    setup,
    setupUrl: setup
      ? `https://github.com/${input.repoFullName}/blob/HEAD/.product-team/owner-checklist.md`
      : null,
    paused: paused !== undefined,
    pausedUrl: paused === undefined ? null : githubUrlOrNull(paused.htmlUrl),
  };
}

/** Question cards: every inbox item with its body and the answers the owner grammar allows for its section. */
export function buildQuestions(openIssues: readonly IssueRecord[]): QuestionsDto {
  return {
    items: classified(openIssues).map(({ issue, item }): QuestionDto => ({
      ...item,
      body: issue.body,
      allowedCommands: ANSWERS[item.section],
    })),
  };
}
