-- Runner checks (#1059, architect note §1; security note S1–S12). A check is a runner-addressed probe, not a job: it
-- names one runner by id, is delivered through that runner's own claim poll (only when that poll declares the kind),
-- runs a fixed command compiled into the signed runner, and is reported on its own route. It never touches `jobs`,
-- `job_events`, `team_state`, budgets, concurrency or placement, so no row here is read by the claim SQL.
--
-- Stored states: queued → running → passed | failed, and queued → failed. `failed` always has a reason: one the runner
-- reported, or one the server set (`not-picked-up`, `lost`, `runner-revoked`). A version string leaves the host only
-- on a pass. Timestamps are ISO 8601 UTC text, CHECKed as 0021's.

CREATE TABLE runner_checks (
  id             TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26 AND id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  account_id     TEXT NOT NULL REFERENCES accounts (id),
  runner_id      TEXT NOT NULL REFERENCES runners (id),
  -- A CHECK, not a lookup table: the table is tiny and short-lived, so a rebuild for a new kind is cheap.
  kind           TEXT NOT NULL CHECK (kind IN ('smoke')),
  -- The audit actor of the owner who asked (as `runners.enrolled_by`); never rewritten.
  requested_by   TEXT NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 255),
  state          TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'passed', 'failed')),
  -- `RUNNER_REPORTED_CHECK_REASONS` and `RUNNER_EXPIRED_CHECK_REASONS` of @shared/contracts, nothing else.
  reason         TEXT CHECK (reason IS NULL OR reason IN (
    'credential-missing', 'credential-unreadable', 'credential-not-allowed',
    'claude-not-configured', 'claude-not-executable', 'claude-failed', 'claude-output-unrecognised',
    'timeout', 'host-not-ready',
    'not-picked-up', 'lost', 'runner-revoked'
  )),
  -- The shape the shared bounded regex admits, as a second fence: no markup, whitespace or control character.
  claude_version TEXT CHECK (
    claude_version IS NULL
    OR (length(claude_version) BETWEEN 1 AND 64 AND claude_version NOT GLOB '*[^0-9A-Za-z.+-]*')
  ),
  duration_ms    INTEGER CHECK (duration_ms IS NULL OR (typeof(duration_ms) = 'integer' AND duration_ms BETWEEN 0 AND 120000)),
  created_at     TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', created_at) IS substr(created_at, 1, 19) AND substr(created_at, -1) = 'Z'
  ),
  picked_at      TEXT CHECK (
    picked_at IS NULL
    OR (strftime('%Y-%m-%dT%H:%M:%S', picked_at) IS substr(picked_at, 1, 19) AND substr(picked_at, -1) = 'Z')
  ),
  finished_at    TEXT CHECK (
    finished_at IS NULL
    OR (strftime('%Y-%m-%dT%H:%M:%S', finished_at) IS substr(finished_at, 1, 19) AND substr(finished_at, -1) = 'Z')
  ),
  CHECK ((reason IS NOT NULL) = (state = 'failed')),
  CHECK (claude_version IS NULL OR state = 'passed'),
  CHECK (state <> 'passed' OR claude_version IS NOT NULL),
  CHECK ((finished_at IS NOT NULL) = (state IN ('passed', 'failed'))),
  CHECK (duration_ms IS NULL OR state IN ('passed', 'failed')),
  -- A queued check was never picked up; a running or passed one was.
  CHECK (state <> 'queued' OR picked_at IS NULL),
  CHECK (state NOT IN ('running', 'passed') OR picked_at IS NOT NULL)
);
-- At most one check in flight per runner, by the schema: a double click or two tabs converge on it.
CREATE UNIQUE INDEX runner_checks_live ON runner_checks (runner_id) WHERE state IN ('queued', 'running');
-- The hourly caps (per runner and per account) and the 30-day prune.
CREATE INDEX runner_checks_account ON runner_checks (account_id, created_at);
CREATE INDEX runner_checks_runner ON runner_checks (runner_id, created_at);

-- C9: a check is of the runner's own account, whoever writes it.
CREATE TRIGGER runner_checks_account_is_runners
BEFORE INSERT ON runner_checks
WHEN NOT EXISTS (SELECT 1 FROM runners WHERE id = NEW.runner_id AND account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'runner_checks.account_id must be the runner''s account');
END;
-- What a check is and who asked for it is never rewritten.
CREATE TRIGGER runner_checks_identity_kept
BEFORE UPDATE OF id, account_id, runner_id, kind, requested_by, created_at ON runner_checks
BEGIN
  SELECT RAISE(ABORT, 'a runner check keeps its identity');
END;
-- The state only moves forward, and a final state stays final (a late finish never overwrites `lost`).
CREATE TRIGGER runner_checks_state_forward
BEFORE UPDATE ON runner_checks
WHEN OLD.state IN ('passed', 'failed') OR (NEW.state IS NOT OLD.state AND NOT (
  (OLD.state = 'queued' AND NEW.state IN ('running', 'failed'))
  OR (OLD.state = 'running' AND NEW.state IN ('passed', 'failed'))
))
BEGIN
  SELECT RAISE(ABORT, 'a runner check only moves forward');
END;
-- `INSERT OR REPLACE` would rewrite a check without firing an UPDATE trigger (see 0018 `users_never_replaced`).
CREATE TRIGGER runner_checks_never_replaced
BEFORE INSERT ON runner_checks
WHEN EXISTS (SELECT 1 FROM runner_checks WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'a runner check keeps its identity');
END;

-- Deletion (0047's pattern: triggers, not `ON DELETE CASCADE`, which SQLite cannot add to the parents' keys). A check
-- goes with its runner, with its account, and with the user who asked for it (`requested_by` names a user id or a
-- door's shared actor; it is never rewritten, so the row goes rather than outlives its requester). The audit keeps
-- the history of every check; nothing references these rows.
CREATE TRIGGER runners_delete_runner_checks
BEFORE DELETE ON runners
BEGIN
  DELETE FROM runner_checks WHERE runner_id = OLD.id;
END;
CREATE TRIGGER accounts_delete_runner_checks
BEFORE DELETE ON accounts
BEGIN
  DELETE FROM runner_checks WHERE account_id = OLD.id;
END;
CREATE TRIGGER users_delete_runner_checks
BEFORE DELETE ON users
BEGIN
  DELETE FROM runner_checks WHERE requested_by = OLD.id;
END;
