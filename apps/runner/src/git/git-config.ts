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
  if (refused.length > 0) {
    throw new LaunchRefusal('git-config-refused', `git config refused: ${refused.join(', ')}`);
  }
}
