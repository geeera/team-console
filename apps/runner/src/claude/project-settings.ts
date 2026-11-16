import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { LaunchRefusal } from '../jobs/refusal';

/**
 * The clone's own Claude Code settings (#592 item 3): `disableAllHooks` stops hooks, but the CLI still runs the
 * command-type settings of a project `.claude/settings.json` in `-p` mode (checked against 2.1.322: a project
 * `apiKeyHelper` ran with the managed settings passed). A branch could carry one, so a clone that has any is refused
 * before the CLI starts. Unreadable, symlinked or malformed settings are refused too: the runner cannot vouch for them.
 */

export const PROJECT_SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const;

/** Settings whose value is a shell command the CLI runs on its own (hooks are off through the managed settings). */
export const COMMAND_SETTINGS = [
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'otelHeadersHelper',
  'statusLine',
  'fileSuggestion',
] as const;

const isErrno = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

const refuse = (detail: string): LaunchRefusal => new LaunchRefusal('project-settings-refused', detail);

async function readSettingsFile(path: string, label: string): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT')) {
      return null;
    }
    if (isErrno(error, 'ELOOP')) {
      throw refuse(`${label} is a symlink`);
    }
    throw refuse(`${label} could not be read`);
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw refuse(`${label} is not a regular file`);
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** Throws a `project-settings-refused` refusal when the clone's project settings carry a command-type setting. */
export async function refuseProjectSettingsCommands(clone: string): Promise<void> {
  const dir = join(clone, '.claude');
  let isSymlink: boolean;
  try {
    isSymlink = (await lstat(dir)).isSymbolicLink();
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT')) {
      return;
    }
    throw refuse('.claude could not be read');
  }
  if (isSymlink) {
    throw refuse('.claude is a symlink');
  }
  for (const file of PROJECT_SETTINGS_FILES) {
    const label = `.claude/${file}`;
    const text = await readSettingsFile(join(dir, file), label);
    if (text === null) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // The CLI silently drops invalid settings in `-p` mode; the runner does not guess what it would have read.
      throw refuse(`${label} is not valid JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw refuse(`${label} is not a JSON object`);
    }
    const found = COMMAND_SETTINGS.filter((key) => Object.hasOwn(parsed, key));
    if (found.length > 0) {
      throw refuse(`${label} sets ${found.join(', ')}`);
    }
  }
}
