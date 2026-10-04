import type { InboxDto, QuestionsDto, SprintDto } from '@shared/contracts';
import type { ProjectRow } from '@worker/db';
import { GitHubClient, githubPath, readCacheKey, type RepoName } from '@worker/github';
import {
  PROJECT_CONFIG_MAX_BYTES,
  ProjectConfigError,
  buildInbox,
  buildQuestions,
  buildSprint,
  isGitHubIssue,
  isGitHubMilestone,
  isGitHubPullRequest,
  issueRecordOf,
  milestoneRecordOf,
  parseProjectConfig,
  pickCurrentSprint,
  pullRequestRecordOf,
  sprintToday,
  type IssueRecord,
  type MilestoneRecord,
  type ProjectConfig,
  type PullRequestRecord,
} from '@worker/read-models';
import type { ApiEnv } from '../env';
import type { ApiGitHub, GitHubConnection } from '../github';
import { readProjectYmlFile, type ProjectYmlFile } from '../projects/repository-checks';

/** Issues, pull requests and milestones change with every team run: 60 s (ADR 0001 decision 22). */
const LIST_TTL_SECONDS = 60;
/** project.yml changes rarely: 600 s. */
const CONFIG_TTL_SECONDS = 600;

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
 *   sprint    = milestones 1 + sprint issues ≤ LIST_MAX_PAGES + pulls 1 → ≤ 7
 *   current sprint (the overview) = sprint without the pulls             → ≤ 6
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

  async questions(): Promise<QuestionsDto> {
    return buildQuestions(await this.openIssues());
  }

  async sprint(): Promise<SprintDto> {
    const [milestones, openPullRequests] = await Promise.all([this.milestones(), this.openPullRequests()]);
    const milestone = pickCurrentSprint(milestones, sprintToday(this.now()));
    const milestoneIssues = milestone === null ? [] : await this.milestoneIssues(milestone.number);
    return buildSprint({ milestone, milestoneIssues, openPullRequests });
  }

  /** The current sprint without the repository's pull requests (the overview, #27): one read fewer. */
  async currentSprint(): Promise<SprintDto> {
    const milestone = pickCurrentSprint(await this.milestones(), sprintToday(this.now()));
    const milestoneIssues = milestone === null ? [] : await this.milestoneIssues(milestone.number);
    return buildSprint({ milestone, milestoneIssues, openPullRequests: [] });
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
