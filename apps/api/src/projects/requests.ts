import type { AddProjectStep, UpdateProjectRequest } from '@shared/contracts';
import { InvalidRepoNameError, parseRepoName, type RepoName } from '@worker/github';
import { isReservedSlug, isValidSlug, slugFromRepoName } from './slug';

/** Validation of the registry's request bodies (#15). Nothing here echoes the input back: it may be hostile. */

export interface RequestRefusal {
  readonly refused: true;
  readonly step: AddProjectStep | null;
  readonly detail: string;
}

export interface AddProject {
  readonly repo: RepoName;
  readonly slug: string;
  readonly displayName: string;
}

export interface UpdateProject {
  readonly displayName?: string;
  readonly routineId?: string | null;
}

const MAX_DISPLAY_NAME = 80;
// Routine trigger ids (`trig_…`) of the PM-chat routine; the value becomes a URL segment in #26.
const ROUTINE_ID = /^trig_[A-Za-z0-9_-]{1,100}$/;
/** C0/C1 controls and the bidi overrides that could make a name render as something else. */
function hasUnsafeCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    const isBidiOverride = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    if (isControl || isBidiOverride) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuse(step: AddProjectStep | null, detail: string): RequestRefusal {
  return { refused: true, step, detail };
}

function displayNameOf(value: unknown): string | RequestRefusal {
  if (typeof value !== 'string') {
    return refuse('display-name', 'displayName must be a string');
  }
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_DISPLAY_NAME || hasUnsafeCharacter(name)) {
    return refuse('display-name', `displayName must be 1–${MAX_DISPLAY_NAME} printable characters`);
  }
  return name;
}

export function isRefusal(value: unknown): value is RequestRefusal {
  return isRecord(value) && value['refused'] === true;
}

/** `{ repo, displayName?, slug? }`; unknown members are refused so a typo is not silently ignored. */
export function parseAddProject(body: unknown): AddProject | RequestRefusal {
  if (!isRecord(body)) {
    return refuse('repo-format', 'The body must be a JSON object with repo: "owner/name"');
  }
  const unknown = Object.keys(body).filter((key) => !['repo', 'displayName', 'slug'].includes(key));
  if (unknown.length > 0) {
    return refuse('repo-format', 'Only repo, displayName and slug may be sent');
  }
  const rawRepo = body['repo'];
  let repo: RepoName;
  try {
    repo = parseRepoName(typeof rawRepo === 'string' ? rawRepo.trim() : '');
  } catch (error: unknown) {
    if (!(error instanceof InvalidRepoNameError)) {
      throw error;
    }
    return refuse('repo-format', 'repo must be "owner/name" as on GitHub');
  }

  const rawSlug = body['slug'];
  if (rawSlug !== undefined && typeof rawSlug !== 'string') {
    return refuse('slug', 'slug must be a string');
  }
  const slug = rawSlug ?? slugFromRepoName(repo.name);
  if (!isValidSlug(slug)) {
    return refuse(
      'slug',
      'slug must be 2–39 of a-z, 0-9 and "-", starting and ending with a letter or digit',
    );
  }
  if (isReservedSlug(slug)) {
    return refuse('slug', 'This slug is a console route; choose another one');
  }

  const displayName = body['displayName'] === undefined ? repo.name : displayNameOf(body['displayName']);
  if (isRefusal(displayName)) {
    return displayName;
  }
  return { repo, slug, displayName };
}

/** `{ displayName?, routineId? }` with at least one of them. */
export function parseUpdateProject(body: unknown): UpdateProject | RequestRefusal {
  if (!isRecord(body)) {
    return refuse(null, 'The body must be a JSON object');
  }
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((key) => key !== 'displayName' && key !== 'routineId')) {
    return refuse(null, 'Send displayName and/or routineId, nothing else');
  }
  const request = body as UpdateProjectRequest;
  const update: { displayName?: string; routineId?: string | null } = {};
  if (request.displayName !== undefined) {
    const name = displayNameOf(request.displayName);
    if (isRefusal(name)) {
      return name;
    }
    update.displayName = name;
  }
  if (request.routineId !== undefined) {
    const routineId: unknown = request.routineId;
    if (routineId !== null && (typeof routineId !== 'string' || !ROUTINE_ID.test(routineId))) {
      return refuse(null, 'routineId must be a routine trigger id (trig_…) or null');
    }
    update.routineId = routineId;
  }
  return update;
}
