import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { TEAM_EFFORTS, type TeamEffort } from '@shared/contracts';

/**
 * Claude Code settings the runner owns (ADR 0008 decision 8, threat model C3 cross-job row (a)): every hook off, so a
 * `SessionStart` hook a job plants in a user or project settings file never runs, and no auto-update. Passed with
 * `--settings`; on `user`/`container` the same base is also installed at the CLI's managed path (2-B-3). Rewritten
 * before every job (a tampered copy never survives) and left without write bits.
 */

export const MANAGED_SETTINGS_FILE = 'managed-settings.json';

export const MANAGED_SETTINGS = {
  disableAllHooks: true,
  env: { DISABLE_AUTOUPDATER: '1' },
} as const;

/** What the claim's team configuration adds for one job (ADR 0009 d.5, d.6); both absent without a view. */
export interface JobSettings {
  /** The role's `effort`; `null` leaves the CLI's default. */
  readonly effort: TeamEffort | null;
  /** `false` only when an `api_key` project switched `cost.prompt_caching` off. */
  readonly promptCaching: boolean;
}

export const DEFAULT_JOB_SETTINGS: JobSettings = { effort: null, promptCaching: true };

/**
 * The settings file of one job: the base plus `effortLevel` and, with caching off, `DISABLE_PROMPT_CACHING`. The
 * effort written is the runner's own constant from the enum, never the string the claim carried, so no value from the
 * console reaches the file beyond the choice among three words.
 */
export function jobSettingsOf(settings: JobSettings): Record<string, unknown> {
  const effort = TEAM_EFFORTS.find((level) => level === settings.effort);
  return {
    ...MANAGED_SETTINGS,
    env: { ...MANAGED_SETTINGS.env, ...(settings.promptCaching ? {} : { DISABLE_PROMPT_CACHING: '1' }) },
    ...(effort === undefined ? {} : { effortLevel: effort }),
  };
}

export const managedSettingsPathOf = (home: string): string => join(home, MANAGED_SETTINGS_FILE);

export async function writeManagedSettings(home: string, settings: JobSettings = DEFAULT_JOB_SETTINGS): Promise<string> {
  const path = managedSettingsPathOf(home);
  await rm(path, { force: true });
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o444,
  );
  try {
    await handle.writeFile(`${JSON.stringify(jobSettingsOf(settings), null, 2)}\n`, 'utf8');
    await handle.chmod(0o444);
  } finally {
    await handle.close();
  }
  return path;
}
