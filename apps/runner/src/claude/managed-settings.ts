import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Claude Code settings the runner owns (ADR 0008 decision 8, threat model C3 cross-job row (a)): every hook off, so a
 * `SessionStart` hook a job plants in a user or project settings file never runs, and no auto-update. Passed with
 * `--settings`; on `user`/`container` the same file is also installed at the CLI's managed path (2-B-3). Rewritten
 * before every job (a tampered copy never survives) and left without write bits.
 */

export const MANAGED_SETTINGS_FILE = 'managed-settings.json';

export const MANAGED_SETTINGS = {
  disableAllHooks: true,
  env: { DISABLE_AUTOUPDATER: '1' },
} as const;

export const managedSettingsPathOf = (home: string): string => join(home, MANAGED_SETTINGS_FILE);

export async function writeManagedSettings(home: string): Promise<string> {
  const path = managedSettingsPathOf(home);
  await rm(path, { force: true });
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o444,
  );
  try {
    await handle.writeFile(`${JSON.stringify(MANAGED_SETTINGS, null, 2)}\n`, 'utf8');
    await handle.chmod(0o444);
  } finally {
    await handle.close();
  }
  return path;
}
