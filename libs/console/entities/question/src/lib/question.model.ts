import type {
  AnswerCommand,
  InboxItemDto,
  OwnerCategory,
  NeedsYouDto,
  NeedsYouItemDto,
  NeedsYouProjectDto,
  NeedsYouProjectProblem,
  NeedsYouProjectRef,
  QuestionDto,
  QuestionsDto,
  Section,
  TeamRecommendation,
} from '@shared/contracts';
import { ANSWERS, isAnswerCommand, isOwnerCategory, isTeamRecommendation } from '@shared/owner-grammar';

/**
 * One card the owner can answer, from either read model (#35): `GET /needs-you` (no body) or
 * `GET /projects/:slug/questions` (with the body). Every text field is untrusted issue text and is rendered as
 * plain text only; `url` is used only when it is on github.com.
 */
export interface QuestionItem {
  readonly project: NeedsYouProjectRef;
  readonly section: Section;
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly ask: string | null;
  /** `null` in "Needs you", which carries no bodies. */
  readonly body: string | null;
  readonly authorTrusted: boolean;
  readonly allowedCommands: readonly AnswerCommand[];
  /** From the item's `owner:*` label (#220); what a batch of approvals may take. */
  readonly category: OwnerCategory | null;
  /** The team's recommendation as the server read the answer line (#220). */
  readonly recommendation: TeamRecommendation | null;
}

/** A project whose inbox "Needs you" could not read; the others are still listed. */
export interface QuestionProjectProblem {
  readonly project: NeedsYouProjectRef;
  readonly problem: NeedsYouProjectProblem;
}

/**
 * A project whose security setup is not done (`team.reviewer_logins` empty, #205): the owner checklist on GitHub,
 * or `null` when the server's link is not a github.com page.
 */
export interface QuestionProjectSetup {
  readonly project: NeedsYouProjectRef;
  readonly url: string | null;
}

export interface NeedsYouView {
  readonly items: readonly QuestionItem[];
  /** Slugs whose inbox was read in this response; answers for other projects are left alone. */
  readonly readSlugs: readonly string[];
  readonly problems: readonly QuestionProjectProblem[];
  readonly setups: readonly QuestionProjectSetup[];
  readonly omitted: readonly NeedsYouProjectRef[];
}

const SECTIONS: ReadonlySet<string> = new Set(Object.keys(ANSWERS));
const GITHUB_PREFIX = 'https://github.com/';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSection(value: unknown): value is Section {
  return typeof value === 'string' && SECTIONS.has(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isProjectRef(value: unknown): value is NeedsYouProjectRef {
  return (
    isRecord(value) &&
    typeof value['slug'] === 'string' &&
    value['slug'] !== '' &&
    typeof value['name'] === 'string'
  );
}

function isCommandList(value: unknown): value is AnswerCommand[] {
  return Array.isArray(value) && value.every(isAnswerCommand);
}

function isInboxItem(value: unknown): value is InboxItemDto {
  return (
    isRecord(value) &&
    isSection(value['section']) &&
    typeof value['number'] === 'number' &&
    Number.isSafeInteger(value['number']) &&
    value['number'] > 0 &&
    typeof value['title'] === 'string' &&
    isNullableString(value['url']) &&
    isNullableString(value['ask']) &&
    typeof value['authorTrusted'] === 'boolean' &&
    (value['category'] === null || isOwnerCategory(value['category'])) &&
    (value['recommendation'] === null || isTeamRecommendation(value['recommendation']))
  );
}

function isNeedsYouItem(value: unknown): value is NeedsYouItemDto {
  return (
    isInboxItem(value) &&
    isRecord(value) &&
    isProjectRef(value['project']) &&
    isCommandList(value['allowedCommands'])
  );
}

function isQuestion(value: unknown): value is QuestionDto {
  return (
    isInboxItem(value) &&
    isRecord(value) &&
    typeof value['body'] === 'string' &&
    isCommandList(value['allowedCommands'])
  );
}

function isProjectProblem(value: unknown): value is NeedsYouProjectProblem {
  return (
    isRecord(value) &&
    typeof value['type'] === 'string' &&
    typeof value['title'] === 'string' &&
    typeof value['status'] === 'number'
  );
}

function isNeedsYouProject(value: unknown): value is NeedsYouProjectDto {
  return (
    isProjectRef(value) &&
    isRecord(value) &&
    (value['problem'] === null || isProjectProblem(value['problem']))
  );
}

export function isNeedsYouDto(value: unknown): value is NeedsYouDto {
  return (
    isRecord(value) &&
    Array.isArray(value['items']) &&
    value['items'].every(isNeedsYouItem) &&
    Array.isArray(value['projects']) &&
    value['projects'].every(isNeedsYouProject) &&
    Array.isArray(value['omittedProjects']) &&
    value['omittedProjects'].every(isProjectRef)
  );
}

export function isQuestionsDto(value: unknown): value is QuestionsDto {
  return isRecord(value) && Array.isArray(value['items']) && value['items'].every(isQuestion);
}

/** The server already allows only github.com links (`githubUrlOrNull`); the client does not take that on trust. */
export function safeGitHubUrl(url: string | null): string | null {
  return url !== null && url.startsWith(GITHUB_PREFIX) ? url : null;
}

// `owner/name` as the registry stores it (#15): GitHub's login and repository-name characters only.
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/**
 * The issue's page on GitHub from the project registry's `repo` and an issue number, or null. For an item the read
 * model no longer lists (answered or closed meanwhile): the repository comes from the server, the number is an
 * integer, and nothing of a URL fragment or route is copied into the link.
 */
export function githubIssueUrlOf(repo: string, number: number): string | null {
  if (!REPO.test(repo) || !Number.isSafeInteger(number) || number < 1) {
    return null;
  }
  const url = new URL(`/${repo}/issues/${String(number)}`, GITHUB_PREFIX);
  return url.origin === 'https://github.com' ? url.href : null;
}

/**
 * The commands a card offers: the server's list, but only those the owner grammar allows for the section, so a
 * card never offers an answer the endpoint would refuse with `answer-not-allowed`.
 */
function offeredCommands(section: Section, allowed: readonly AnswerCommand[]): readonly AnswerCommand[] {
  const grammar = ANSWERS[section];
  return allowed.filter((command) => grammar.includes(command));
}

export function needsYouViewOf(dto: NeedsYouDto): NeedsYouView {
  return {
    items: dto.items.map((item) => ({
      project: { slug: item.project.slug, name: item.project.name },
      section: item.section,
      number: item.number,
      title: item.title,
      url: safeGitHubUrl(item.url),
      ask: item.ask,
      body: null,
      authorTrusted: item.authorTrusted,
      allowedCommands: offeredCommands(item.section, item.allowedCommands),
      category: item.category,
      recommendation: item.recommendation,
    })),
    readSlugs: dto.projects.filter((project) => project.problem === null).map((project) => project.slug),
    problems: dto.projects.flatMap((project) =>
      project.problem === null
        ? []
        : [{ project: { slug: project.slug, name: project.name }, problem: project.problem }],
    ),
    // Only `true` counts: the guard leaves `setup` unchecked, so a malformed value never invents a warning.
    setups: dto.projects.flatMap((project) =>
      project.setup === true && project.problem === null
        ? [
            {
              project: { slug: project.slug, name: project.name },
              url: typeof project.setupUrl === 'string' ? safeGitHubUrl(project.setupUrl) : null,
            },
          ]
        : [],
    ),
    omitted: dto.omittedProjects,
  };
}

export function projectQuestionsOf(project: NeedsYouProjectRef, dto: QuestionsDto): QuestionItem[] {
  return dto.items.map((item) => ({
    project: { slug: project.slug, name: project.name },
    section: item.section,
    number: item.number,
    title: item.title,
    url: safeGitHubUrl(item.url),
    ask: item.ask,
    body: item.body,
    authorTrusted: item.authorTrusted,
    allowedCommands: offeredCommands(item.section, item.allowedCommands),
    category: item.category,
    recommendation: item.recommendation,
  }));
}
