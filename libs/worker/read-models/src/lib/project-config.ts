import { parseDocument } from 'yaml';

/**
 * `.product-team/project.yml` is written by agents and collaborators, so it is untrusted (#9 threat row 9): it is
 * size-capped before parsing, parsed with the YAML 1.2 core schema and nothing else (no custom or language tags,
 * no merge keys, no aliases, one document), and checked against the few fields the read models use.
 */

export const PROJECT_CONFIG_MAX_BYTES = 64 * 1024;

export type ProjectConfigFailure = 'too-large' | 'not-yaml' | 'aliases' | 'schema';

export class ProjectConfigError extends Error {
  constructor(readonly failure: ProjectConfigFailure) {
    super(`project.yml is not usable: ${failure}`);
    this.name = 'ProjectConfigError';
  }
}

export interface ProjectConfig {
  /** `team.reviewer_logins`: accounts that review for the team; empty while the agents may act as the owner. */
  readonly reviewerLogins: readonly string[];
}

// A GitHub login, or an app's bot login (`name[bot]`).
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reviewerLoginsOf(root: Readonly<Record<string, unknown>>): string[] {
  const team = root['team'];
  if (team === undefined || team === null) {
    return [];
  }
  if (!isPlainObject(team)) {
    throw new ProjectConfigError('schema');
  }
  const logins = team['reviewer_logins'];
  if (logins === undefined || logins === null) {
    return [];
  }
  // Anything but a list of logins is refused rather than read as "set": only real reviewers hide the setup item.
  if (!Array.isArray(logins) || !logins.every((login) => typeof login === 'string' && LOGIN.test(login))) {
    throw new ProjectConfigError('schema');
  }
  return logins as string[];
}

/** Parses and checks project.yml; any doubt is a `ProjectConfigError`, never a partial config. */
export function parseProjectConfig(text: string): ProjectConfig {
  if (new TextEncoder().encode(text).byteLength > PROJECT_CONFIG_MAX_BYTES) {
    throw new ProjectConfigError('too-large');
  }
  const document = parseDocument(text, {
    version: '1.2',
    schema: 'core',
    customTags: [],
    resolveKnownTags: false,
    merge: false,
    uniqueKeys: true,
    strict: true,
    prettyErrors: false,
  });
  // An unknown or explicit tag is a warning (TAG_RESOLVE_FAILED); a second document or a duplicate key an error.
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new ProjectConfigError('not-yaml');
  }
  let root: unknown;
  try {
    // No alias is resolved at all, so an alias bomb (billion laughs) cannot expand.
    root = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new ProjectConfigError('aliases');
  }
  if (!isPlainObject(root)) {
    throw new ProjectConfigError('schema');
  }
  return { reviewerLogins: reviewerLoginsOf(root) };
}
