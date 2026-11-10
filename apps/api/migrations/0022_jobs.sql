-- Jobs, their run log and the team state (#467, ADR 0008 row 2-A; ADR 0006 "Runner and job queue" with the
-- account, dispatch and placement columns of ADR 0008 "Data model" and decision 12). `jobs` is the queue: a runner
-- claims by one atomic UPDATE that checks the account, the runner's allowed projects, the team pause and the
-- placement policy inside the statement (threat model C9, C11). D1 holds the SHA-256 of a job token, never the token.

CREATE TABLE jobs (
  id                   TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26 AND id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  -- Copied from the project at enqueue (ADR 0008 "Data model"), checked against the runner's account at claim.
  account_id           TEXT NOT NULL REFERENCES accounts (id),
  project_slug         TEXT NOT NULL REFERENCES projects (slug),
  kind                 TEXT NOT NULL CHECK (
    kind IN ('slot-pm', 'slot-dev', 'slot-qa', 'burn', 'audit', 'review', 'chat', 'kickoff', 'import', 'digest')
  ),
  -- The one role the job token names (ADR 0006 decision 11).
  role                 TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 32),
  payload              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  priority             INTEGER NOT NULL DEFAULT 0,
  state                TEXT NOT NULL DEFAULT 'queued' CHECK (
    state IN ('queued', 'claimed', 'running', 'finished', 'failed', 'lost', 'cancelled')
  ),
  requested_by         TEXT NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 255),
  dedupe_key           TEXT CHECK (dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 255),
  needs_local          INTEGER NOT NULL DEFAULT 0 CHECK (needs_local IN (0, 1)),
  parent_job_id        TEXT REFERENCES jobs (id),
  dispatch             TEXT NOT NULL DEFAULT 'pull' CHECK (dispatch IN ('pull', 'actions', 'hosted')),
  runner_id            TEXT REFERENCES runners (id),
  token_hash           TEXT CHECK (token_hash IS NULL OR (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*')),
  attempt              INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_minutes          INTEGER NOT NULL DEFAULT 90 CHECK (max_minutes BETWEEN 1 AND 720),
  created_at           TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', created_at) IS substr(created_at, 1, 19) AND substr(created_at, -1) = 'Z'
  ),
  claimed_at           TEXT,
  lease_until          TEXT CHECK (
    lease_until IS NULL
    OR (strftime('%Y-%m-%dT%H:%M:%S', lease_until) IS substr(lease_until, 1, 19) AND substr(lease_until, -1) = 'Z')
  ),
  started_at           TEXT,
  finished_at          TEXT,
  result               TEXT CHECK (result IS NULL OR (json_valid(result) AND json_type(result) = 'object')),
  -- Hosted (H-2) and Actions (2-B PR 4) dispatch; unused by `pull` jobs.
  bootstrap_token_hash TEXT,
  bootstrap_expires_at TEXT,
  actions_run_id       TEXT,
  hosted_instance_id   TEXT,
  reserved_usd         REAL,
  cost_usd             REAL,
  CHECK ((state IN ('claimed', 'running')) = (runner_id IS NOT NULL AND lease_until IS NOT NULL AND token_hash IS NOT NULL)
         OR state NOT IN ('queued', 'claimed', 'running'))
);
-- The overlap guard (ADR 0006): one live job per dedupe key, e.g. one `slot-dev` per project.
CREATE UNIQUE INDEX jobs_dedupe_live ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'claimed', 'running');
CREATE INDEX jobs_queue ON jobs (state, priority, created_at);
CREATE INDEX jobs_project ON jobs (project_slug, created_at);
CREATE INDEX jobs_runner ON jobs (runner_id, state);
CREATE UNIQUE INDEX jobs_token ON jobs (token_hash) WHERE token_hash IS NOT NULL;

-- A job's account is its project's account, always (threat model C9: the claim compares it with the runner's).
CREATE TRIGGER jobs_account_is_projects
BEFORE INSERT ON jobs
WHEN NOT EXISTS (SELECT 1 FROM projects WHERE slug = NEW.project_slug AND account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'jobs.account_id must be the project''s account');
END;
CREATE TRIGGER jobs_identity_kept
BEFORE UPDATE OF id, account_id, project_slug, kind, role, requested_by, parent_job_id, dispatch, created_at ON jobs
BEGIN
  SELECT RAISE(ABORT, 'jobs keep their identity');
END;
-- A finished, failed, lost or cancelled job never runs again under a new token.
CREATE TRIGGER jobs_final_state_kept
BEFORE UPDATE OF state ON jobs
WHEN OLD.state IN ('finished', 'failed', 'lost', 'cancelled') AND NEW.state IS NOT OLD.state
BEGIN
  SELECT RAISE(ABORT, 'a finished job stays finished');
END;
CREATE TRIGGER jobs_never_replaced
BEFORE INSERT ON jobs
WHEN EXISTS (SELECT 1 FROM jobs WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'jobs are never replaced');
END;

-- The run log of a job (ADR 0006): append-only, numbered per job, payload redacted by the API before it lands.
CREATE TABLE job_events (
  id      INTEGER PRIMARY KEY,
  job_id  TEXT NOT NULL REFERENCES jobs (id),
  seq     INTEGER NOT NULL CHECK (seq >= 1),
  at      TEXT NOT NULL,
  level   TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  kind    TEXT NOT NULL CHECK (
    kind IN ('started', 'log', 'notice', 'acted', 'metric', 'paused', 'finished', 'failed')
  ),
  payload TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(payload) AND json_type(payload) = 'object' AND length(CAST(payload AS BLOB)) <= 16384
  ),
  UNIQUE (job_id, seq)
);
CREATE TRIGGER job_events_append_only_update
BEFORE UPDATE ON job_events
BEGIN
  SELECT RAISE(ABORT, 'job_events are append-only');
END;
CREATE TRIGGER job_events_append_only_delete
BEFORE DELETE ON job_events
BEGIN
  SELECT RAISE(ABORT, 'job_events are append-only');
END;
CREATE TRIGGER job_events_never_replaced
BEFORE INSERT ON job_events
WHEN EXISTS (SELECT 1 FROM job_events WHERE id = NEW.id OR (job_id = NEW.job_id AND seq = NEW.seq))
BEGIN
  SELECT RAISE(ABORT, 'job_events are append-only');
END;

-- `runlog pause|resume` and the three-failures stop (ADR 0006), read by the claim statement.
CREATE TABLE team_state (
  project_slug  TEXT PRIMARY KEY NOT NULL REFERENCES projects (slug),
  paused_at     TEXT,
  paused_by     TEXT CHECK (paused_by IS NULL OR length(paused_by) BETWEEN 1 AND 255),
  failed_streak INTEGER NOT NULL DEFAULT 0 CHECK (failed_streak >= 0),
  updated_at    TEXT NOT NULL,
  CHECK ((paused_at IS NULL) = (paused_by IS NULL))
);

-- Placement (ADR 0008 decision 12): a project's policy, else the account's default, else `any`. Validated by
-- `checkRunnerPolicy`; the runner ids it names are checked against the account's runners at write time.
ALTER TABLE projects ADD COLUMN runner_policy TEXT CHECK (
  runner_policy IS NULL OR (json_valid(runner_policy) AND json_type(runner_policy) = 'object')
);
ALTER TABLE accounts ADD COLUMN default_runner_policy TEXT CHECK (
  default_runner_policy IS NULL OR (json_valid(default_runner_policy) AND json_type(default_runner_policy) = 'object')
);
