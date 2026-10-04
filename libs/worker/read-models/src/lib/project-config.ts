import { parseDocument } from 'yaml';
import { githubUrlOrNull } from './untrusted-text';

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
  /**
   * `decisions_dir` (the plugin's default `docs/decisions` when absent); `null` when the value is not a plain
   * relative path. Only the Artifacts space reads it, so a bad value costs that list, never the inbox.
   */
  readonly decisionsDir?: string | null;
  /** `design.storybook_url` when it is a github.com page, else `null` (the console links to github.com only). */
  readonly storybookUrl?: string | null;
}

export const DEFAULT_DECISIONS_DIR = 'docs/decisions';

// Relative, plain segments only: the path is sent to the Contents API and must not walk out of the repository.
const REPO_DIR = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
const REPO_DIR_MAX_LENGTH = 200;

function decisionsDirOf(root: Readonly<Record<string, unknown>>): string | null {
  const value = root['decisions_dir'];
  if (value === undefined || value === null || value === '') {
    return DEFAULT_DECISIONS_DIR;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const dir = value.replace(/\/+$/, '');
  const isPlain = dir.length <= REPO_DIR_MAX_LENGTH && REPO_DIR.test(dir) && !dir.split('/').includes('..');
  return isPlain ? dir : null;
}

function storybookUrlOf(root: Readonly<Record<string, unknown>>): string | null {
  const design = root['design'];
  const url = isPlainObject(design) ? design['storybook_url'] : undefined;
  return typeof url === 'string' ? githubUrlOrNull(url) : null;
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

/** The YAML root of project.yml, size-capped and parsed with the safe profile above; throws `ProjectConfigError`. */
function parseRoot(text: string): Readonly<Record<string, unknown>> {
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
  return root;
}

/** Parses and checks project.yml; any doubt is a `ProjectConfigError`, never a partial config. */
export function parseProjectConfig(text: string): ProjectConfig {
  const root = parseRoot(text);
  return {
    reviewerLogins: reviewerLoginsOf(root),
    decisionsDir: decisionsDirOf(root),
    storybookUrl: storybookUrlOf(root),
  };
}

// Far above any real Storybook or stage URL; a longer value is not one.
const MAX_EMBED_URL_LENGTH = 2048;
// The URL parser lowercases and punycodes hosts; anything outside this set (`*`, `_`, brackets of an IPv6 literal)
// is not a host the console frames.
const EMBED_HOST = /^[a-z0-9.-]+$/;

/**
 * The origin a console frame may load (#20): an absolute `https:` URL without credentials, whose host is plain
 * DNS characters without a trailing dot, reduced to its origin.
 * Anything else, including a non-string, is `null`.
 */
export function embedOriginOf(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  if (text === '' || text.length > MAX_EMBED_URL_LENGTH || !URL.canParse(text)) {
    return null;
  }
  const url = new URL(text);
  if (
    url.protocol !== 'https:' ||
    !EMBED_HOST.test(url.hostname) ||
    url.hostname.endsWith('.') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return null;
  }
  return url.origin;
}

function nestedValue(root: Readonly<Record<string, unknown>>, section: readonly string[]): unknown {
  let value: unknown = root;
  for (const key of section) {
    if (!isPlainObject(value)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}

// The only two project.yml fields whose pages the console may frame; nothing else ever becomes an embed origin.
const EMBED_URL_FIELDS: readonly (readonly string[])[] = [
  ['design', 'storybook_url'],
  ['environments', 'stage', 'url'],
];

/**
 * `EmbedOriginsDto` (#20): the origins of `design.storybook_url` and `environments.stage.url`, deduplicated.
 * Lenient on purpose: an unusable file or field means "nothing to embed", never an error, so the registry and the
 * read models that share the file keep answering.
 */
export function embedOriginsOf(text: string): string[] {
  let root: Readonly<Record<string, unknown>>;
  try {
    root = parseRoot(text);
  } catch (error: unknown) {
    if (error instanceof ProjectConfigError) {
      return [];
    }
    throw error;
  }
  const origins = EMBED_URL_FIELDS.map((field) => embedOriginOf(nestedValue(root, field)));
  return [...new Set(origins.filter((origin): origin is string => origin !== null))];
}
