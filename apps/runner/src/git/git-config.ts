import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { LaunchRefusal } from '../jobs/refusal';
import { runGit, type GitRunner } from './git';

/**
 * Git config a job could leave behind to run code in, or redirect the transport or refs of, the next one (ADR 0008
 * decision 7, threat model C3 cross-job row (b), C4 "vendored plugin swapped"). The launch is refused when the
 * mirror's or the clone's effective config holds any key, or any value, outside what the runner's own git commands
 * write (#694, #721): a deny-list kept missing keys of the same class (`http.sslVerify`, `http.curloptResolve`,
 * `sequence.editor`, ...), and an unpinned value such as `remote.origin.fetch=+refs/heads/evil:refs/heads/main` moves
 * the default branch the plugin is vendored from. The `system` scope is the host administrator's file (Apple's git
 * ships `credential.helper=osxkeychain` there) and no job can write it, so it is not judged; every other scope is.
 */

export interface GitConfigEntry {
  readonly scope: string;
  readonly origin: string;
  /** As git prints it: section and variable lower-cased, a subsection as written. */
  readonly key: string;
  readonly value: string;
}

/** The repository being judged: the bare mirror or a job's clone, both with `origin` at `originUrl`. */
export interface ExpectedRepository {
  readonly kind: 'mirror' | 'clone';
  readonly originUrl: string;
  /** The runner's own credential helper, the one helper accepted; null when it has none. */
  readonly allowedHelper: string | null;
}

/** `section[.subsection].variable`; git compares section and variable case-insensitively, a subsection exactly. */
interface ConfigKey {
  readonly section: string;
  readonly subsection: string | null;
  readonly variable: string;
}

function parseKey(key: string): ConfigKey {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first === -1) {
    return { section: key.toLowerCase(), subsection: null, variable: '' };
  }
  return {
    section: key.slice(0, first).toLowerCase(),
    subsection: first === last ? null : key.slice(first + 1, last),
    variable: key.slice(last + 1).toLowerCase(),
  };
}

/** A rule's subsection that matches any (a branch name); null matches a key without one. */
export const ANY_SUBSECTION: unique symbol = Symbol('any subsection');

export interface AllowedKeyRule {
  readonly label: string;
  readonly section: string;
  /** Compared exactly, as git does: `remote.ORIGIN.url` is not `remote.origin.url`. */
  readonly subsection: string | null | typeof ANY_SUBSECTION;
  readonly variables: readonly string[];
  readonly accepts: (value: string, expected: ExpectedRepository, subsection: string | null) => boolean;
}

const BOOLEAN = ['true', 'false'];
const oneOf =
  (values: readonly string[]) =>
  (value: string): boolean =>
    values.includes(value);

/** The refspec each kind is made with; any other maps upstream refs elsewhere (#721). */
export const MIRROR_REFSPEC = '+refs/*:refs/*';
export const CLONE_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';

/**
 * What `git clone --mirror --template=`, `git fetch`, `git clone` from the mirror and `git remote set-url` write into
 * a repository's own config (sha1 and sha256, files and reftable refs), with the values they write. Each is plain
 * data: none names a program, a hook, an include, a transport setting or a foreign ref. Data, with a spec row each.
 */
export const ALLOWED_GIT_KEYS: readonly AllowedKeyRule[] = [
  {
    label: 'core.repositoryFormatVersion',
    section: 'core',
    subsection: null,
    variables: ['repositoryformatversion'],
    accepts: oneOf(['0', '1']),
  },
  {
    label: 'core.bare',
    section: 'core',
    subsection: null,
    variables: ['bare'],
    accepts: (value, expected) => value === (expected.kind === 'mirror' ? 'true' : 'false'),
  },
  {
    label: 'core filesystem flags',
    section: 'core',
    subsection: null,
    variables: ['filemode', 'ignorecase', 'precomposeunicode', 'symlinks', 'logallrefupdates'],
    accepts: oneOf(BOOLEAN),
  },
  {
    label: 'extensions.objectFormat',
    section: 'extensions',
    subsection: null,
    variables: ['objectformat'],
    accepts: oneOf(['sha1', 'sha256']),
  },
  {
    label: 'extensions.refStorage',
    section: 'extensions',
    subsection: null,
    variables: ['refstorage'],
    accepts: oneOf(['files', 'reftable']),
  },
  // Only `origin`, the one remote the runner makes, spelled exactly so: `remote.ORIGIN` is another remote.
  {
    label: 'remote.origin.url',
    section: 'remote',
    subsection: 'origin',
    variables: ['url'],
    accepts: (value, expected) => value === expected.originUrl,
  },
  {
    label: 'remote.origin.fetch',
    section: 'remote',
    subsection: 'origin',
    variables: ['fetch'],
    accepts: (value, expected) => value === (expected.kind === 'mirror' ? MIRROR_REFSPEC : CLONE_REFSPEC),
  },
  {
    label: 'remote.origin.mirror',
    section: 'remote',
    subsection: 'origin',
    variables: ['mirror'],
    accepts: (value, expected) => expected.kind === 'mirror' && value === 'true',
  },
  {
    label: 'remote.origin.tagOpt',
    section: 'remote',
    subsection: 'origin',
    variables: ['tagopt'],
    accepts: (value, expected) => expected.kind === 'mirror' && value === '--no-tags',
  },
  {
    label: 'branch.<name>.remote',
    section: 'branch',
    subsection: ANY_SUBSECTION,
    variables: ['remote'],
    accepts: (value, expected) => expected.kind === 'clone' && value === 'origin',
  },
  {
    label: 'branch.<name>.merge',
    section: 'branch',
    subsection: ANY_SUBSECTION,
    variables: ['merge'],
    accepts: (value, expected, subsection) => expected.kind === 'clone' && value === `refs/heads/${subsection ?? ''}`,
  },
];

const ruleOf = (key: ConfigKey): AllowedKeyRule | undefined =>
  ALLOWED_GIT_KEYS.find(
    (rule) =>
      rule.section === key.section &&
      rule.variables.includes(key.variable) &&
      (rule.subsection === ANY_SUBSECTION ? key.subsection !== null : rule.subsection === key.subsection),
  );

/** Why `entry` is refused, or null when it is allowed. */
function refusalOf(entry: GitConfigEntry, expected: ExpectedRepository): string | null {
  const key = parseKey(entry.key);
  if (key.section === 'credential' && key.variable === 'helper') {
    return expected.allowedHelper !== null && entry.value === expected.allowedHelper ? null : 'foreign credential helper';
  }
  const rule = ruleOf(key);
  if (rule === undefined) {
    return 'not allow-listed';
  }
  return rule.accepts(entry.value, expected, key.subsection) ? null : 'unexpected value';
}

/** Parses `git config --list --show-scope --show-origin --null`: `scope NUL origin NUL key LF value NUL`. */
export function parseGitConfigList(output: string): GitConfigEntry[] {
  const fields = output.split('\0');
  const entries: GitConfigEntry[] = [];
  for (let at = 0; at + 2 < fields.length; at += 3) {
    const scope = fields[at] ?? '';
    const origin = fields[at + 1] ?? '';
    const pair = fields[at + 2] ?? '';
    const newline = pair.indexOf('\n');
    entries.push({
      scope,
      origin,
      key: newline === -1 ? pair : pair.slice(0, newline),
      value: newline === -1 ? '' : pair.slice(newline + 1),
    });
  }
  return entries;
}

/** The refused keys (reasons and keys only, never values: a URL may carry a credential) of a config listing. */
export function refusedGitConfig(entries: readonly GitConfigEntry[], expected: ExpectedRepository): string[] {
  const refused = new Set<string>();
  for (const entry of entries) {
    if (entry.scope === 'system') {
      continue;
    }
    const reason = refusalOf(entry, expected);
    if (reason !== null) {
      refused.add(`${entry.key} (${reason}, ${entry.scope})`);
    }
  }
  return [...refused];
}

/**
 * Reads the effective config of `gitDir` as the job will see it (`env` carries the job's HOME, so the job's global
 * file is judged too) and refuses the launch on any key or value outside the allow-list.
 */
export async function assertCleanGitConfig(
  gitDir: string,
  env: Readonly<Record<string, string>>,
  expected: ExpectedRepository,
  git: GitRunner = runGit,
): Promise<void> {
  const output = await git(
    ['--git-dir', gitDir, 'config', '--list', '--show-scope', '--show-origin', '--null'],
    env,
  );
  const refused = refusedGitConfig(parseGitConfigList(output), expected);
  if (await hasAlternates(gitDir)) {
    refused.push('objects/info/alternates (alternate object store)');
  }
  if (refused.length > 0) {
    throw new LaunchRefusal('git-config-refused', `git config refused: ${refused.join(', ')}`);
  }
}

/** An alternates file points git at another object store, for example one a job planted; it is not config. */
async function hasAlternates(gitDir: string): Promise<boolean> {
  try {
    await lstat(join(gitDir, 'objects', 'info', 'alternates'));
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
