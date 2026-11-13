-- The runner's pause (#571, ADR 0008 decision 9; architect note on #468, PR 4). The runner detects the CLI's usage or
-- rate limit and stops claiming until a reset time; it mirrors that here so the claim skips it too and Settings ›
-- Runners can say so. `paused_until` is ISO 8601 UTC text, compared with julianday() like the other timestamps; a
-- pause whose time has passed is no pause, whatever the row still holds.
--
-- SQLite cannot add a table CHECK to an existing table, so the "both or neither" rule rides on the second column:
-- a column CHECK may name another column of the row, and ADD COLUMN tests it against the rows already there (all
-- NULL, so it holds).

ALTER TABLE runners ADD COLUMN paused_until TEXT CHECK (
  paused_until IS NULL
  OR (strftime('%Y-%m-%dT%H:%M:%S', paused_until) IS substr(paused_until, 1, 19) AND substr(paused_until, -1) = 'Z')
);

ALTER TABLE runners ADD COLUMN pause_reason TEXT CHECK (
  (pause_reason IS NULL OR pause_reason IN ('usage-limit', 'rate-limit', 'manual'))
  AND (pause_reason IS NULL) = (paused_until IS NULL)
);
