import { OWNER_RESUME, PAUSE_MARKER, type RunLogComment } from './run-state';

/**
 * #141 — the one switch for the console's pause guard.
 *
 * `runlog start` works out `paused_since` from the comments of the run log's author and, in app mode, the team's
 * bot (`runlog.team_comments`), never from the repository owner's own comments. The console writes a pause with
 * the owner's token, so in a run log the bot opened that pause does not count: an older owner `/resume` that is
 * newer than the last *team* pause lifts it at the next start (`runstate.resumed_after_pause`), and the team runs on.
 *
 * Set this to `true` once the vendored plugin counts the owner's own unedited `PAUSE_MARKER` / `OWNER_RESUME`
 * comments there: `fixtures/owner-pause.json` (written by `fixtures/generate.py` from the plugin's real `cmd_start`)
 * then shows `paused` for the bot-opened row, and `golden.spec.ts` fails until this switch agrees with it. Nothing
 * else needs to change: the pause route, the status DTO and the reader all ask the functions below.
 */
export const PLUGIN_COUNTS_OWNER_PAUSE = false;

function sameLogin(a: string, b: string): boolean {
  return a !== '' && a.toLowerCase() === b.toLowerCase();
}

/**
 * The logins whose pause and owner-resume markers `runlog start` counts for `paused_since`: the run log's author and
 * the team's bots (`teamBots`; the plugin adds its bot in app mode only, and no bot writes in same-account mode),
 * plus the repository owner once the plugin counts the owner's own markers.
 */
export function pauseMarkerAuthorsOf(logAuthor: string, owner: string, teamBots: Iterable<string>): string[] {
  return [logAuthor, ...teamBots, ...(PLUGIN_COUNTS_OWNER_PAUSE ? [owner] : [])].filter(
    (login) => login !== '',
  );
}

/**
 * Whether a pause the console writes (with the owner's token) holds at the team's next run: always when the owner
 * opened the run log (in either mode the log's author is counted), otherwise only once the plugin counts the
 * owner's own markers. `false` → the pause route answers 409 `pause-unreliable` and the panel says why.
 */
export function consolePauseHolds(logAuthor: string, owner: string): boolean {
  return PLUGIN_COUNTS_OWNER_PAUSE || sameLogin(logAuthor, owner);
}

/**
 * `runlog start`'s `paused_since`: the latest pause or owner-resume marker among `comments` (already screened as
 * unedited) by one of `authors` (`pauseMarkerAuthorsOf`); `''` without one.
 */
export function pausedSinceOf(comments: readonly RunLogComment[], authors: readonly string[]): string {
  const counted = new Set(authors.map((login) => login.toLowerCase()));
  let latest = '';
  for (const comment of comments) {
    const at = comment.createdAt ?? '';
    if (
      counted.has(comment.author.toLowerCase()) &&
      (comment.body.includes(PAUSE_MARKER) || comment.body.includes(OWNER_RESUME)) &&
      at > latest
    ) {
      latest = at;
    }
  }
  return latest;
}

/**
 * `runstate.resumed_after_pause`: an owner `/resume` newer than `paused_since` — the next `runlog start` then takes
 * the `team:paused` label off and proceeds. No `paused_since` → never.
 */
export function resumedAfterPause(pausedSince: string, ownerResumeAt: string): boolean {
  return pausedSince !== '' && ownerResumeAt > pausedSince;
}
