import {
  DEFAULT_FREEZE_DAYS,
  type InboxDto,
  type QuestionsDto,
  type SprintCalendarDto,
  type SprintCiState,
  type SprintDto,
  type SprintListsDto,
  type SprintProgressDto,
  type TeamRunDto,
  type TeamSprintDto,
} from '@shared/contracts';
import type { ProjectRow } from '@worker/db';
import { GitHubClient, GitHubError, githubPath, readCacheKey, type RepoName } from '@worker/github';
import {
  PROJECT_CONFIG_MAX_BYTES,
  ProjectConfigError,
  buildInbox,
  buildQuestions,
  buildSprint,
  checkRunsPageOf,
  ciStateOf,
  embedOriginsOf,
  isGitHubCheckRunsPage,
  isGitHubIssue,
  isGitHubMilestone,
  isGitHubPullRequest,
  issueRecordOf,
  milestoneRecordOf,
  parseProjectConfig,
  pickCurrentSprint,
  pullRequestRecordOf,
  sprintSummary,
  sprintToday,
  type IssueRecord,
  type MilestoneRecord,
  type ProjectConfig,
  type PullRequestRecord,
} from '@worker/read-models';
import type { ApiEnv } from '../env';
import type { ApiGitHub, GitHubConnection } from '../github';
import { freezeDaysOf } from '../projects/project-yml';
import { readProjectYmlFile, type ProjectYmlFile } from '../projects/repository-checks';
import { calendarOf, sprintPlanOf, teamSprintOf } from '../team/sprint-plan';
import { RunLogUnavailableError, readRunLog } from '../team/run-log-reader';
import { UNKNOWN_TEAM_RUN, teamRunOf } from '../team/team-health';

/** Issues, pull requests and milestones change with every team run: 60 s (ADR 0001 decision 22). */
const LIST_TTL_SECONDS = 60;
/** A running check finishes within minutes; the board should notice about as soon as a list change. */
const CHECKS_TTL_SECONDS = 60;
/** project.yml changes rarely: 600 s. */
const CONFIG_TTL_SECONDS = 600;
/** The sprint part of `TeamStatusDto` (#218). */
export interface SprintStatus {
  readonly sprint: TeamSprintDto | null;
  readonly progress: SprintProgressDto | null;
  readonly calendar: SprintCalendarDto;
}

/** Every milestone, open and closed, in one page (a product keeps far fewer than 100). Uncached: callers decide. */
export async function readAllMilestones(client: GitHubClient, repo: RepoName): Promise<MilestoneRecord[]> {
  const raw = await client.paginate(
    githubPath`/repos/${repo}/milestones?state=all&per_page=${100}`,
    isGitHubMilestone,
    { maxPages: 1 },
  );
  return raw.map(milestoneRecordOf);
}

/** `sprint.freeze_days` of a project.yml read; a missing or undecodable file is the plugin's default. */
export function freezeDaysOfFile(file: ProjectYmlFile | null): number {
  return file === null || file.text === null ? DEFAULT_FREEZE_DAYS : freezeDaysOf(file.text);
}

/** The run state may be this old on the overview and the board; the Commands panel reads it fresh. */
const TEAM_RUN_TTL_SECONDS = 30;
/** The run log's latest 200 comments: the failure streak, an active pause and the last runs are always among them. */
const RUN_LOG_PAGES = 2;

/**
 * Pages of 100 read from a list: 3 pages = 300 open issues and pull requests, more than a product repository keeps
 * open. Bounded so "Needs you" stays within the Worker's 50 subrequests (see routes/needs-you.ts).
 */
export const LIST_MAX_PAGES = 3;

/**
 * Subrequests per project read, cold isolate and empty read cache (a cached installation token saves the first two):
 *   installation lookup 1 + token mint 1, then
 *   inbox     = open issues ≤ LIST_MAX_PAGES + project.yml 1           → ≤ 6
 *   questions = open issues ≤ LIST_MAX_PAGES                            → ≤ 5
 *   team run  = project.yml 1 + the run-log issue 1 + comments ≤ RUN_LOG_PAGES                → ≤ 4
 *   sprint    = milestones 1 + sprint issues ≤ LIST_MAX_PAGES + pulls 1 + team run ≤ 4 → ≤ 11,
 *               then one check-runs read per open pull request (#131), capped by the route's SubrequestBudget
 *   current sprint (the overview) = milestones and sprint issues only     → ≤ 6
 *   sprint status (the Commands panel, #218) = all milestones 1 + sprint issues ≤ LIST_MAX_PAGES
 *               + project.yml 1 (shared, often cached)                  → ≤ 7
 * Reads are shared through the read cache: inbox, questions and "Needs you" read the same `open-issues` entry.
 */
export class ProjectReads {
  private client: Promise<GitHubClient> | undefined;

  constructor(
    private readonly github: ApiGitHub,
    private readonly env: ApiEnv,
    private readonly project: ProjectRow,
    private readonly repo: RepoName,
    private readonly now: () => number = () => Date.now(),
    /** The transport and token minting to read through; the overview passes one that counts its budget. */
    private readonly connection?: GitHubConnection,
  ) {}

  async inbox(): Promise<InboxDto> {
    const [openIssues, config] = await Promise.all([this.openIssues(), this.config()]);
    return buildInbox({
      openIssues,
      reviewerLogins: config.reviewerLogins,
      repoFullName: this.repo.fullName,
    });
  }

  /** The open issues (no pull requests) the owner may ask the PM about (#219), newest first; shares `open-issues`. */
  async requestableIssues(): Promise<{ number: number; title: string }[]> {
    const issues = await this.openIssues();
    return issues
      .filter((issue) => !issue.isPullRequest)
      .map((issue) => ({ number: issue.number, title: issue.title }))
      .sort((a, b) => b.number - a.number);
  }

  async questions(): Promise<QuestionsDto> {
    return buildQuestions(await this.openIssues());
  }

  async sprint(): Promise<SprintDto> {
    const [milestones, openPullRequests, team] = await Promise.all([
      this.milestones(),
      this.openPullRequests(),
      this.boardTeamRun(),
    ]);
    const milestone = pickCurrentSprint(milestones, sprintToday(this.now()));
    const milestoneIssues = milestone === null ? [] : await this.milestoneIssues(milestone.number);
    // After the lists and the run log, so a budget that runs out costs CI states, never the board.
    const ciStates = await this.ciStatesOf(openPullRequests);
    return { ...buildSprint({ milestone, milestoneIssues, openPullRequests, ciStates }), team };
  }

  /**
   * The team's run state and latest runs from the run log (#27, #132), shared by the overview and the board and
   * cached 30 s: the run log's latest 200 comments hold the failure streak, an active pause and the last runs. A run
   * log the team did not open (or several) is `unknown`. Costs project.yml (shared with the config, often cached),
   * the issue or the labelled list, and at most two pages of comments.
   */
  teamRun(): Promise<TeamRunDto> {
    return this.cached('team-run', TEAM_RUN_TTL_SECONDS, async () => {
      try {
        const file = await this.projectYmlFile();
        const projectYml = file === null ? null : (file.text ?? '');
        const connection = this.connection ?? (await this.github.connect(this.env));
        const view = await readRunLog(connection, this.repo, {
          latestCommentPages: RUN_LOG_PAGES,
          projectYml,
        });
        return teamRunOf(view, this.now());
      } catch (error: unknown) {
        if (error instanceof RunLogUnavailableError) {
          return UNKNOWN_TEAM_RUN;
        }
        throw error;
      }
    });
  }

  /**
   * The board's run state: a run log GitHub refuses or the budget stops is `unknown` (not cached, so the next load
   * reads it), never an error of the board, as with a pull request's CI.
   */
  private async boardTeamRun(): Promise<TeamRunDto> {
    try {
      return await this.teamRun();
    } catch (error: unknown) {
      if (error instanceof GitHubError) {
        return UNKNOWN_TEAM_RUN;
      }
      throw error;
    }
  }

  /**
   * Each pull request's CI, in list order (newest first), so a budget that runs out leaves the oldest `unknown`. A
   * read GitHub refuses (no Checks permission on a private repository, a rate limit) or the budget stops is also
   * `unknown` for that row only; what was read is cached, so the next load goes on from there.
   */
  private async ciStatesOf(pulls: readonly PullRequestRecord[]): Promise<Map<number, SprintCiState>> {
    const states = await Promise.all(
      pulls.map(async (pull): Promise<[number, SprintCiState]> => [pull.number, await this.ciStateOf(pull)]),
    );
    return new Map(states);
  }

  private async ciStateOf(pull: PullRequestRecord): Promise<SprintCiState> {
    const sha = pull.headSha;
    if (sha === null) {
      return 'unknown';
    }
    try {
      // Keyed by commit: a push to the pull request is a new key, not a stale entry.
      return await this.cached(`check-runs-${sha}`, CHECKS_TTL_SECONDS, async () => {
        const client = await this.connect();
        const page = await client.getJson(
          githubPath`/repos/${this.repo}/commits/${sha}/check-runs?filter=latest&per_page=${100}`,
          isGitHubCheckRunsPage,
        );
        return ciStateOf(checkRunsPageOf(page));
      });
    } catch (error: unknown) {
      if (error instanceof GitHubError) {
        return 'unknown';
      }
      throw error;
    }
  }

  /** The current sprint without the repository's pull requests (the overview, #27): one read fewer. */
  async currentSprint(): Promise<SprintListsDto> {
    const milestone = pickCurrentSprint(await this.milestones(), sprintToday(this.now()));
    const milestoneIssues = milestone === null ? [] : await this.milestoneIssues(milestone.number);
    return buildSprint({ milestone, milestoneIssues, openPullRequests: [] });
  }

  /**
   * The Commands panel's sprint (#218): the current sprint with its freeze and the next one, done / total of its
   * work issues as the board counts them, and what the sprint forms validate against. Through the read cache, so
   * it is at most a minute old; the commands themselves decide on a live read.
   */
  async sprintStatus(): Promise<SprintStatus> {
    const [milestones, file] = await Promise.all([this.allMilestones(), this.projectYmlFile()]);
    const plan = sprintPlanOf(milestones, sprintToday(this.now()), freezeDaysOfFile(file));
    let progress: SprintProgressDto | null = null;
    if (plan.current !== null) {
      const issues = (await this.milestoneIssues(plan.current.number)).filter(
        (issue) => !issue.isPullRequest,
      );
      const summary = sprintSummary(issues);
      progress = { done: summary.shipped, total: summary.planned };
    }
    return { sprint: teamSprintOf(plan), progress, calendar: calendarOf(plan) };
  }

  private cached<T>(type: string, ttlSeconds: number, fill: () => Promise<T>): Promise<T> {
    const key = readCacheKey({
      environment: this.env.ENVIRONMENT,
      slug: this.project.slug,
      epoch: this.project.cache_epoch,
      type,
    });
    return this.github.readCache.getOrFill(key, ttlSeconds, fill);
  }

  /** The read-only client for this project, shared by every read of one request. */
  async connect(): Promise<GitHubClient> {
    this.client ??= (async () => {
      const { auth, fetch } = this.connection ?? (await this.github.connect(this.env));
      return new GitHubClient(fetch, auth.tokenSourceFor(this.repo));
    })();
    return this.client;
  }

  private openIssues(): Promise<IssueRecord[]> {
    return this.cached('open-issues', LIST_TTL_SECONDS, async () => {
      const client = await this.connect();
      const raw = await client.paginate(
        githubPath`/repos/${this.repo}/issues?state=open&per_page=${100}`,
        isGitHubIssue,
        { maxPages: LIST_MAX_PAGES },
      );
      return raw.map(issueRecordOf);
    });
  }

  private milestoneIssues(milestone: number): Promise<IssueRecord[]> {
    return this.cached(`sprint-issues-${milestone}`, LIST_TTL_SECONDS, async () => {
      const client = await this.connect();
      const raw = await client.paginate(
        githubPath`/repos/${this.repo}/issues?state=all&milestone=${milestone}&per_page=${100}`,
        isGitHubIssue,
        { maxPages: LIST_MAX_PAGES },
      );
      return raw.map(issueRecordOf);
    });
  }

  private milestones(): Promise<MilestoneRecord[]> {
    return this.cached('milestones', LIST_TTL_SECONDS, async () => {
      const client = await this.connect();
      const raw = await client.paginate(
        githubPath`/repos/${this.repo}/milestones?state=open&per_page=${100}`,
        isGitHubMilestone,
        { maxPages: 1 },
      );
      return raw.map(milestoneRecordOf);
    });
  }

  private allMilestones(): Promise<MilestoneRecord[]> {
    return this.cached('milestones-all', LIST_TTL_SECONDS, async () =>
      readAllMilestones(await this.connect(), this.repo),
    );
  }

  private openPullRequests(): Promise<PullRequestRecord[]> {
    return this.cached('open-pulls', LIST_TTL_SECONDS, async () => {
      const client = await this.connect();
      const raw = await client.paginate(
        githubPath`/repos/${this.repo}/pulls?state=open&per_page=${100}`,
        isGitHubPullRequest,
        { maxPages: 1 },
      );
      return raw.map(pullRequestRecordOf);
    });
  }

  /**
   * `EmbedOriginsDto` (#20), from the shared project.yml read; a missing or unusable file embeds nothing, and the
   * console's own origin (`consoleOrigin`, the request's) is never one of them.
   */
  async embedOrigins(consoleOrigin: string): Promise<string[]> {
    const file = await this.projectYmlFile();
    return file === null || file.text === null ? [] : embedOriginsOf(file.text, consoleOrigin);
  }

  /**
   * project.yml through the Contents API (never raw.githubusercontent.com, #9 row 1); `null` when there is none.
   * One read for the config and for the overview's run log, which looks up its pinned issue there (#27).
   */
  projectYmlFile(): Promise<ProjectYmlFile | null> {
    return this.cached('project-yml', CONFIG_TTL_SECONDS, async () =>
      readProjectYmlFile(await this.connect(), this.repo),
    );
  }

  /**
   * The config, size-checked from GitHub's `size` before decoding. A missing file reads as "no reviewers": the setup
   * item stays until it is fixed.
   */
  config(): Promise<ProjectConfig> {
    return this.cached('project-config', CONFIG_TTL_SECONDS, async () => {
      const file = await this.projectYmlFile();
      if (file === null) {
        return { reviewerLogins: [] };
      }
      if (file.size > PROJECT_CONFIG_MAX_BYTES) {
        throw new ProjectConfigError('too-large');
      }
      if (file.text === null) {
        throw new ProjectConfigError('not-yaml');
      }
      return parseProjectConfig(file.text);
    });
  }
}
