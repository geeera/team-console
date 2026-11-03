import {
  isArtifactType,
  isArtifactsPartial,
  isGitHubPageUrl,
  type ArtifactDto,
  type ArtifactsPartial,
} from '@shared/contracts';

export type Artifact = ArtifactDto;

/** One answer of `GET /api/v1/projects/:slug/artifacts`, checked. */
export interface ArtifactsSnapshot {
  readonly items: readonly Artifact[];
  readonly loadedAt: string;
  readonly partial: readonly ArtifactsPartial[];
}

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An item the console can show: a known type, text fields, and a link that is a github.com page. */
export function isArtifact(value: unknown): value is Artifact {
  return (
    isRecord(value) &&
    isArtifactType(value['type']) &&
    typeof value['title'] === 'string' &&
    isGitHubPageUrl(value['url']) &&
    (value['updatedAt'] === null || typeof value['updatedAt'] === 'string') &&
    (value['source'] === 'file' || value['source'] === 'issue' || value['source'] === 'config') &&
    (value['state'] === null || value['state'] === 'open' || value['state'] === 'closed') &&
    (value['number'] === undefined || isIssueNumber(value['number'])) &&
    (value['awaitingApproval'] === undefined || typeof value['awaitingApproval'] === 'boolean')
  );
}

function isIssueNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * The checked snapshot, or `null` when the body is not the read model's shape. A single item that fails the check
 * (a link off github.com, a type this build does not know) is left out rather than failing the whole list.
 */
export function artifactsSnapshotOf(body: unknown): ArtifactsSnapshot | null {
  if (!isRecord(body) || !Array.isArray(body['items']) || typeof body['loadedAt'] !== 'string') {
    return null;
  }
  const partial = body['partial'];
  if (partial !== undefined && !Array.isArray(partial)) {
    return null;
  }
  return {
    items: body['items'].filter(isArtifact),
    loadedAt: body['loadedAt'],
    partial: (partial ?? []).filter(isArtifactsPartial),
  };
}
