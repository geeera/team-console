/** A registered product repository (ADR 0001, decision 20) as the client sees it. */
export interface ProjectDto {
  readonly slug: string;
  /** `owner/name` on GitHub. */
  readonly repo: string;
  readonly displayName: string;
  /** ISO 8601 UTC. */
  readonly addedAt: string;
}
