import type { ArtifactDto, ArtifactType, ArtifactsPartial, ArtifactsResponse } from '@shared/contracts';
import type { Logger } from '@worker/core';
import type { ProjectRow } from '@worker/db';
import { GitHubError, githubContentsPath, githubPath, readCacheKey, type RepoName } from '@worker/github';
import {
  DECISION_TITLE_READS,
  DEFAULT_DECISIONS_DIR,
  DEMO_LABEL,
  DESIGN_DIR,
  DESIGN_LABELS,
  DESIGN_SUBFOLDER_READS,
  ProjectConfigError,
  contentsEntriesOf,
  contentsFileTextOf,
  decisionArtifactsOf,
  decisionFilesOf,
  demoArtifactsOf,
  designArtifactsOf,
  designFoldersOf,
  firstHeadingOf,
  isGitHubContentsListing,
  isGitHubIssue,
  issueRecordOf,
  type ContentsEntry,
  type IssueRecord,
} from '@worker/read-models';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { isGitHubProblem } from '../projects/repository-checks';
import type { ProjectReads } from './project-reads';

/** Issue-backed reads follow the team's runs: 60 s (ADR 0001 decision 22, amended by ADR 0004). */
const ISSUE_TTL_SECONDS = 60;
/** Contents listings and file titles change with a merge: 600 s. */
const CONTENTS_TTL_SECONDS = 600;

interface Decisions {
  readonly items: readonly ArtifactDto[];
  /** Some files are listed by name: past the read cap, or their read failed. */
  readonly titlesPartial: boolean;
}

interface DesignFiles {
  readonly entries: readonly ContentsEntry[];
  /** docs/design has more sub-folders than one fill lists. */
  readonly truncated: boolean;
}

interface Outcome {
  readonly items: readonly ArtifactDto[];
  readonly partial: readonly ArtifactsPartial[];
}

function isContentsAnswer(value: unknown): value is unknown {
  return typeof value === 'object' && value !== null;
}

/**
 * The Artifacts space (#19): decisions, designs and demos, each read on its own through the read cache, keyed by the
 * project's `cache_epoch` so #12's webhook bump refills them. A failing type is reported in `partial` while the
 * others still answer; only when all three fail does the first failure become the response's problem.
 *
 * Subrequests, cold isolate and empty cache (an installation token cached saves the first two):
 *   installation lookup 1 + token mint 1 + project.yml 1
 *   decisions = listing 1 + titles ≤ DECISION_TITLE_READS (30)           → ≤ 31
 *   designs   = one read per DESIGN_LABELS (3) + docs/design 1 + ≤ 5 folders → ≤ 9
 *   demo      = team:demo issues 1
 *   total ≤ 44 of the Worker's 50.
 */
export class ArtifactReads {
  constructor(
    private readonly github: ApiGitHub,
    private readonly env: ApiEnv,
    private readonly project: ProjectRow,
    private readonly repo: RepoName,
    private readonly reads: ProjectReads,
    private readonly logger: Logger,
    /** The owner's "Check again": every artifact read fills now instead of answering from the cache. */
    private readonly fresh: boolean,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async all(): Promise<ArtifactsResponse> {
    const settled = await Promise.allSettled([this.decisions(), this.designs(), this.demo()]);
    const types: readonly ArtifactType[] = ['decision', 'design', 'demo'];
    const items: ArtifactDto[] = [];
    const partial: ArtifactsPartial[] = [];
    const failures: unknown[] = [];
    settled.forEach((result, index) => {
      const type = types[index] ?? 'decision';
      if (result.status === 'fulfilled') {
        items.push(...result.value.items);
        partial.push(...result.value.partial);
        return;
      }
      failures.push(result.reason);
      partial.push(type);
      this.logger.warn('artifacts type not read', {
        slug: this.project.slug,
        type,
        problem: problemOf(result.reason),
      });
    });
    if (failures.length === types.length) {
      throw failures[0];
    }
    const loadedAt = new Date(this.now()).toISOString();
    return partial.length === 0 ? { items, loadedAt } : { items, loadedAt, partial };
  }

  private async decisions(): Promise<Outcome> {
    const config = await this.reads.config();
    const dir = config.decisionsDir === undefined ? DEFAULT_DECISIONS_DIR : config.decisionsDir;
    if (dir === null) {
      // decisions_dir is set but not a plain relative path: nothing is asked of GitHub with it.
      throw new ProjectConfigError('schema');
    }
    // Not keyed by the folder: a changed decisions_dir shows within the same 10 minutes project.yml itself is cached.
    const decisions = await this.cached<Decisions>('artifacts-decisions', CONTENTS_TTL_SECONDS, async () => {
      const entries = await this.listing(dir);
      const files = decisionFilesOf(entries);
      const read = files.slice(0, DECISION_TITLE_READS);
      const titles = new Map<string, string | null>();
      let failedReads = 0;
      await Promise.all(
        read.map(async (file) => {
          try {
            titles.set(file.path, await this.headingOf(file.path));
          } catch (error: unknown) {
            if (!(error instanceof GitHubError)) {
              throw error;
            }
            // One unreadable file keeps its name; the list still answers.
            failedReads += 1;
            titles.set(file.path, null);
          }
        }),
      );
      return {
        items: decisionArtifactsOf(files, titles),
        titlesPartial: files.length > read.length || failedReads > 0,
      };
    });
    return { items: decisions.items, partial: decisions.titlesPartial ? ['decision-titles'] : [] };
  }

  private async designs(): Promise<Outcome> {
    const [issues, files, storybookUrl] = await Promise.all([
      this.cached('artifacts-designs', ISSUE_TTL_SECONDS, async () => {
        const lists = await Promise.all(DESIGN_LABELS.map((label) => this.labelledIssues(label)));
        return lists.flat();
      }),
      this.cached<DesignFiles>('artifacts-design-files', CONTENTS_TTL_SECONDS, async () => {
        const root = await this.listing(DESIGN_DIR);
        const folders = designFoldersOf(root);
        const listed = folders.slice(0, DESIGN_SUBFOLDER_READS);
        const nested = await Promise.all(listed.map((folder) => this.listing(folder.path)));
        return { entries: [...root, ...nested.flat()], truncated: folders.length > listed.length };
      }),
      this.storybookUrl(),
    ]);
    return {
      items: designArtifactsOf({ issues, files: files.entries, storybookUrl }),
      partial: files.truncated ? ['design-files'] : [],
    };
  }

  private async demo(): Promise<Outcome> {
    const issues = await this.cached('artifacts-demo', ISSUE_TTL_SECONDS, () =>
      this.labelledIssues(DEMO_LABEL),
    );
    return { items: demoArtifactsOf(issues), partial: [] };
  }

  /** A broken project.yml costs the Storybook link only, not the designs. */
  private async storybookUrl(): Promise<string | null> {
    try {
      return (await this.reads.config()).storybookUrl ?? null;
    } catch (error: unknown) {
      if (error instanceof ProjectConfigError) {
        return null;
      }
      throw error;
    }
  }

  private async labelledIssues(label: string): Promise<IssueRecord[]> {
    const client = await this.reads.connect();
    const raw = await client.paginate(
      githubPath`/repos/${this.repo}/issues?state=all&labels=${label}&per_page=${100}`,
      isGitHubIssue,
      { maxPages: 1 },
    );
    return raw.map(issueRecordOf);
  }

  /** A directory's entries; a missing directory (404) is an empty one, as the Contents API answers it. */
  private async listing(path: string): Promise<ContentsEntry[]> {
    const client = await this.reads.connect();
    try {
      const answer = await client.getJson(githubContentsPath(this.repo, path), isContentsAnswer);
      return isGitHubContentsListing(answer) ? contentsEntriesOf(answer) : [];
    } catch (error: unknown) {
      if (isGitHubProblem(error, 'github-not-found')) {
        return [];
      }
      throw error;
    }
  }

  private async headingOf(path: string): Promise<string | null> {
    const client = await this.reads.connect();
    const answer = await client.getJson(githubContentsPath(this.repo, path), isContentsAnswer);
    const text = contentsFileTextOf(answer);
    return text === null ? null : firstHeadingOf(text);
  }

  private cached<T>(type: string, ttlSeconds: number, fill: () => Promise<T>): Promise<T> {
    const key = readCacheKey({
      environment: this.env.ENVIRONMENT,
      slug: this.project.slug,
      epoch: this.project.cache_epoch,
      type,
    });
    return this.github.readCache.getOrFill(key, ttlSeconds, fill, { fresh: this.fresh });
  }
}

/** Our own problem code for the log line; never a message or content from GitHub. */
function problemOf(error: unknown): string {
  if (error instanceof GitHubError) {
    return error.problem.type;
  }
  if (error instanceof ProjectConfigError) {
    return `project-config-${error.failure}`;
  }
  return 'internal';
}
