/**
 * A project's GitHub repository as the console's app reads it (`GET /api/v1/projects/:slug/repository`, #9).
 * Answering at all proves the app is installed on the repository and its read-only token works.
 */
export interface ProjectRepositoryDto {
  /** `owner/name` as GitHub spells it now (a renamed repository shows its new name). */
  readonly repo: string;
  readonly private: boolean;
  readonly defaultBranch: string;
}
