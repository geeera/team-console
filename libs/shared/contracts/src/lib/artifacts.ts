/**
 * The Artifacts space (#19): what the team produced for a project, normalised from GitHub without a table of our
 * own. Titles are GitHub text (render as plain text only); `url` is always a github.com page.
 */

export const ARTIFACT_TYPES = ['decision', 'design', 'demo'] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** Where an artifact was found: a file in the repository, an issue, or a link in project.yml. */
export type ArtifactSource = 'file' | 'issue' | 'config';

export interface ArtifactDto {
  readonly type: ArtifactType;
  readonly title: string;
  readonly url: string;
  /** ISO timestamp; `null` for files, which the Contents listing does not date. */
  readonly updatedAt: string | null;
  readonly source: ArtifactSource;
  /** The issue's state; `null` for files and links. */
  readonly state: 'open' | 'closed' | null;
}

/**
 * What a response is missing: a type whose read failed, `decision-titles` when some decisions are listed by file
 * name only, `design-files` when docs/design has more folders than one read lists.
 */
export type ArtifactsPartial = ArtifactType | 'decision-titles' | 'design-files';

export const ARTIFACTS_PARTIALS: readonly ArtifactsPartial[] = [
  'decision',
  'design',
  'demo',
  'decision-titles',
  'design-files',
];

export interface ArtifactsResponse {
  readonly items: readonly ArtifactDto[];
  /** When the Worker assembled this answer (ISO). */
  readonly loadedAt: string;
  readonly partial?: readonly ArtifactsPartial[];
}

export function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(value);
}

export function isArtifactsPartial(value: unknown): value is ArtifactsPartial {
  return typeof value === 'string' && (ARTIFACTS_PARTIALS as readonly string[]).includes(value);
}
