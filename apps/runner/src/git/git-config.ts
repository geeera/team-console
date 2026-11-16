import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { LaunchRefusal } from '../jobs/refusal';
import { runGit, type GitRunner } from './git';

/**
 * Git config a job could leave behind to run code in the next one (ADR 0008 decision 7, threat model C3 cross-job
 * row (b)). The launch is refused when the mirror's or the clone's effective config holds one of these keys. The
 * `system` scope is the host administrator's file (Apple's git ships `credential.helper=osxkeychain` there) and no
 * job can write it, so it is not judged; every other scope is.
 */

export interface GitConfigEntry {
  readonly scope: string;
  readonly origin: string;
  /** As git prints it: section and variable lower-cased, a subsection as written. */
  readonly key: string;
  readonly value: string;
}

export interface RefusedKeyRule {
  readonly label: string;
  readonly test: (key: string, value: string, allowedHelper: string | null) => boolean;
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

/** Data, with a spec row per entry. */
export const REFUSED_GIT_KEYS: readonly RefusedKeyRule[] = [
  { label: 'core.hooksPath', test: (key) => lower(key) === 'core.hookspath' },
  { label: 'core.fsmonitor', test: (key) => lower(key) === 'core.fsmonitor' },
  { label: 'core.sshCommand', test: (key) => lower(key) === 'core.sshcommand' },
  { label: 'include.*', test: (key) => lower(key).startsWith('include.') },
  { label: 'includeIf.*', test: (key) => lower(key).startsWith('includeif.') },
  {
    label: 'credential.helper (foreign)',
    test: (key, value, allowedHelper) => isHelper(key) && (allowedHelper === null || value !== allowedHelper),
  },
  { label: '*.hooks', test: (key) => lower(key).endsWith('.hooks') },
  // Keys that run a command or redirect the transport (#591): the same cross-job channel as the rows above.
  {
    label: 'filter.*.{clean,smudge,process}',
    test: (key) => {
      const k = lower(key);
      return k.startsWith('filter.') && (k.endsWith('.clean') || k.endsWith('.smudge') || k.endsWith('.process'));
    },
  },
  {
    label: 'remote.*.{uploadpack,receivepack}',
    test: (key) => {
      const k = lower(key);
      return k.startsWith('remote.') && (k.endsWith('.uploadpack') || k.endsWith('.receivepack'));
    },
  },
  { label: 'core.gitProxy', test: (key) => lower(key) === 'core.gitproxy' },
  {
    label: 'url.*.insteadOf',
    test: (key) => {
      const k = lower(key);
      return k.startsWith('url.') && (k.endsWith('.insteadof') || k.endsWith('.pushinsteadof'));
    },
  },
  {
    label: 'protocol.*.allow',
    test: (key) => {
      const k = lower(key);
      return k === 'protocol.allow' || (k.startsWith('protocol.') && k.endsWith('.allow'));
    },
  },
  { label: 'core.pager', test: (key) => lower(key) === 'core.pager' },
  { label: 'diff.external', test: (key) => lower(key) === 'diff.external' },
  // Command-running or redirecting keys git reads during the mirror fetch or the checkout (#645).
  { label: 'core.askPass', test: (key) => lower(key) === 'core.askpass' },
  { label: 'core.editor', test: (key) => lower(key) === 'core.editor' },
  { label: 'core.alternateRefsCommand', test: (key) => lower(key) === 'core.alternaterefscommand' },
  { label: 'remote.*.vcs', test: (key) => isSubsectionKey(key, 'remote', 'vcs') },
  { label: 'remote.*.proxy', test: (key) => isSubsectionKey(key, 'remote', 'proxy') },
  { label: 'http.proxy', test: (key) => lower(key) === 'http.proxy' || isSubsectionKey(key, 'http', 'proxy') },
  { label: 'gpg.*program', test: (key) => lower(key) === 'gpg.program' || isSubsectionKey(key, 'gpg', 'program') },
  { label: 'diff.*.textconv', test: (key) => isSubsectionKey(key, 'diff', 'textconv') },
  { label: 'merge.*.driver', test: (key) => isSubsectionKey(key, 'merge', 'driver') },
  { label: 'submodule.*.update', test: (key) => isSubsectionKey(key, 'submodule', 'update') },
];

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

/** The refused keys (labels and keys only, never values) of a config listing. */
export function refusedGitConfig(entries: readonly GitConfigEntry[], allowedHelper: string | null): string[] {
  const refused = new Set<string>();
  for (const entry of entries) {
    if (entry.scope === 'system') {
      continue;
    }
    const rule = REFUSED_GIT_KEYS.find((candidate) => candidate.test(entry.key, entry.value, allowedHelper));
    if (rule !== undefined) {
      refused.add(`${entry.key} (${rule.label}, ${entry.scope})`);
    }
  }
  return [...refused];
}

/**
 * Reads the effective config of `gitDir` as the job will see it (`env` carries the job's HOME, so the job's global
 * file is judged too) and refuses the launch on any listed key.
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
