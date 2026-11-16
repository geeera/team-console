import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { LaunchRefusal } from '../jobs/refusal';
import { runGit, type GitRunner } from './git';

/**
 * Git config a job could leave behind to run code in, or redirect the transport of, the next one (ADR 0008 decision
 * 7, threat model C3 cross-job row (b)). The launch is refused when the mirror's or the clone's effective config holds
 * any key outside an allow-list of what the runner's own git commands write (#694): the earlier deny-list kept missing
 * keys of the same class (`http.sslVerify`, `http.curloptResolve`, `sequence.editor`, `pager.<cmd>`, ...). The
 * `system` scope is the host administrator's file (Apple's git ships `credential.helper=osxkeychain` there) and no job
 * can write it, so it is not judged; every other scope is.
 */

export interface GitConfigEntry {
  readonly scope: string;
  readonly origin: string;
  /** As git prints it: section and variable lower-cased, a subsection as written. */
  readonly key: string;
  readonly value: string;
}

export interface AllowedKeyRule {
  readonly label: string;
  readonly test: (key: string) => boolean;
}

const lower = (key: string): string => key.toLowerCase();
const isHelper = (key: string): boolean => {
  const k = lower(key);
  return k === 'credential.helper' || (k.startsWith('credential.') && k.endsWith('.helper'));
};

/** `section.<subsection>.variable`, the subsection being anything (it may itself contain dots). */
const isSubsectionKey = (key: string, section: string, variable: string): boolean => {
  const k = lower(key);
  return k.startsWith(`${section}.`) && k.endsWith(`.${variable}`) && k.length > section.length + variable.length + 2;
};

const oneOf =
  (...keys: readonly string[]) =>
  (key: string): boolean =>
    keys.includes(lower(key));

/**
 * What `git clone --mirror --template=`, `git fetch`, `git clone` from the mirror and `git remote set-url` write into
 * a repository's own config (sha1 and sha256, files and reftable refs). Each key is plain data: none names a program,
 * a hook, an include or a transport setting. Data, with a spec row per entry.
 */
export const ALLOWED_GIT_KEYS: readonly AllowedKeyRule[] = [
  {
    label: 'core repository format',
    test: oneOf(
      'core.repositoryformatversion',
      'core.bare',
      'core.filemode',
      'core.logallrefupdates',
      'core.ignorecase',
      'core.precomposeunicode',
      'core.symlinks',
    ),
  },
  { label: 'extensions.{objectFormat,refStorage}', test: oneOf('extensions.objectformat', 'extensions.refstorage') },
  // Only `origin`, the one remote the runner makes; the mirror's URL is checked against the upstream separately.
  {
    label: 'remote.origin.{url,fetch,mirror,tagOpt}',
    test: oneOf('remote.origin.url', 'remote.origin.fetch', 'remote.origin.mirror', 'remote.origin.tagopt'),
  },
  {
    label: 'branch.*.{remote,merge}',
    test: (key) => isSubsectionKey(key, 'branch', 'remote') || isSubsectionKey(key, 'branch', 'merge'),
  },
];

/** Why `entry` is refused, or null when it is allowed. The runner's own credential helper is the one addition. */
function refusalOf(entry: GitConfigEntry, allowedHelper: string | null): string | null {
  if (isHelper(entry.key)) {
    return allowedHelper !== null && entry.value === allowedHelper ? null : 'foreign credential helper';
  }
  return ALLOWED_GIT_KEYS.some((rule) => rule.test(entry.key)) ? null : 'not allow-listed';
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

/** The refused keys (reasons and keys only, never values) of a config listing. */
export function refusedGitConfig(entries: readonly GitConfigEntry[], allowedHelper: string | null): string[] {
  const refused = new Set<string>();
  for (const entry of entries) {
    if (entry.scope === 'system') {
      continue;
    }
    const reason = refusalOf(entry, allowedHelper);
    if (reason !== null) {
      refused.add(`${entry.key} (${reason}, ${entry.scope})`);
    }
  }
  return [...refused];
}

/**
 * Reads the effective config of `gitDir` as the job will see it (`env` carries the job's HOME, so the job's global
 * file is judged too) and refuses the launch on any key outside the allow-list.
 */
export async function assertCleanGitConfig(
  gitDir: string,
  env: Readonly<Record<string, string>>,
  allowedHelper: string | null,
  git: GitRunner = runGit,
): Promise<void> {
  const output = await git(
    ['--git-dir', gitDir, 'config', '--list', '--show-scope', '--show-origin', '--null'],
    env,
  );
  const refused = refusedGitConfig(parseGitConfigList(output), allowedHelper);
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
