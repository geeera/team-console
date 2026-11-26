-- Console-driven orchestration, data model (#1039, slice 1a of #633; ADR 0010 decision 5 amends ADR 0006 "Data
-- model"). `jobs.kind` was a CHECK, which SQLite cannot alter, so every new kind meant a rebuild of the queue. It now
-- references the `job_kinds` lookup: this is the last rebuild for a kind, the next one is an INSERT. Validation stays
-- in the schema (defence in depth beside `isJobKind`), as `labels` does for flags.

CREATE TABLE job_kinds (
  kind TEXT PRIMARY KEY NOT NULL CHECK (length(kind) BETWEEN 1 AND 32)
);
-- The ten kinds of 0022's CHECK, then the step of a console run and one developer item of it.
INSERT INTO job_kinds (kind) VALUES
  ('slot-pm'), ('slot-dev'), ('slot-qa'), ('burn'), ('audit'), ('review'), ('chat'), ('kickoff'), ('import'),
  ('digest'), ('orchestrate'), ('task');

-- The rebuild. D1 cannot switch `foreign_keys` off inside a migration, so the checks are deferred to the end of its
-- transaction: `job_events.job_id` and the self-reference `parent_job_id` point at `jobs` throughout. The rows wait in
-- a plain copy while `jobs` is dropped and created again under its own name, never renamed: the drop counts every
-- `job_events` row and child as a pending violation, and only rows inserted into a table named `jobs` settle that
-- count (a renamed table would not, and the commit would fail). No other table's reference is rewritten either.
PRAGMA defer_foreign_keys = true;

CREATE TABLE jobs_rebuild AS SELECT * FROM jobs;
DROP TABLE jobs;

CREATE TABLE jobs (
  id                   TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26 AND id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  account_id           TEXT NOT NULL REFERENCES accounts (id),
  project_slug         TEXT NOT NULL REFERENCES projects (slug),
  kind                 TEXT NOT NULL REFERENCES job_kinds (kind),
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
  bootstrap_token_hash TEXT,
  bootstrap_expires_at TEXT,
  actions_run_id       TEXT,
  hosted_instance_id   TEXT,
  reserved_usd         REAL,
  cost_usd             REAL,
  dispatched_at        TEXT CHECK (
    dispatched_at IS NULL
    OR (strftime('%Y-%m-%dT%H:%M:%S', dispatched_at) IS substr(dispatched_at, 1, 19) AND substr(dispatched_at, -1) = 'Z')
  ),
  team_config_revision INTEGER CHECK (team_config_revision IS NULL OR team_config_revision >= 1),
  CHECK ((state IN ('claimed', 'running')) = (runner_id IS NOT NULL AND lease_until IS NOT NULL AND token_hash IS NOT NULL)
         OR state NOT IN ('queued', 'claimed', 'running'))
);
-- Before any trigger exists on the new table: the rows were admitted by them once and are copied as they are.
INSERT INTO jobs (
  id, account_id, project_slug, kind, role, payload, priority, state, requested_by, dedupe_key, needs_local,
  parent_job_id, dispatch, runner_id, token_hash, attempt, max_minutes, created_at, claimed_at, lease_until,
  started_at, finished_at, result, bootstrap_token_hash, bootstrap_expires_at, actions_run_id, hosted_instance_id,
  reserved_usd, cost_usd, dispatched_at, team_config_revision
)
SELECT
  id, account_id, project_slug, kind, role, payload, priority, state, requested_by, dedupe_key, needs_local,
  parent_job_id, dispatch, runner_id, token_hash, attempt, max_minutes, created_at, claimed_at, lease_until,
  started_at, finished_at, result, bootstrap_token_hash, bootstrap_expires_at, actions_run_id, hosted_instance_id,
  reserved_usd, cost_usd, dispatched_at, team_config_revision
FROM jobs_rebuild;
DROP TABLE jobs_rebuild;

-- The seven indexes, as 0022, 0031 and 0035 created them.
CREATE UNIQUE INDEX jobs_dedupe_live ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'claimed', 'running');
CREATE INDEX jobs_queue ON jobs (state, priority, created_at);
CREATE INDEX jobs_project ON jobs (project_slug, created_at);
CREATE INDEX jobs_runner ON jobs (runner_id, state);
CREATE UNIQUE INDEX jobs_token ON jobs (token_hash) WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX jobs_actions_run ON jobs (actions_run_id) WHERE actions_run_id IS NOT NULL;
CREATE INDEX jobs_account_live ON jobs (account_id, state);

-- The six triggers, as 0022, 0031 and 0032 created them (the drop took them with the old table).
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
CREATE TRIGGER jobs_actions_run_kept
BEFORE UPDATE OF actions_run_id ON jobs
WHEN OLD.actions_run_id IS NOT NULL AND NEW.actions_run_id IS NOT OLD.actions_run_id
BEGIN
  SELECT RAISE(ABORT, 'a job keeps its Actions run');
END;
CREATE TRIGGER jobs_subscription_never_dispatched
BEFORE INSERT ON jobs
WHEN NEW.dispatch IN ('actions', 'hosted')
  AND (SELECT access_source FROM projects WHERE slug = NEW.project_slug) IS NOT 'api_key'
BEGIN
  SELECT RAISE(ABORT, 'access-source-hosted: a subscription project is never dispatched to Actions or a hosted runner');
END;

-- The run lock (ADR 0010 decision 2): NULL is idle, else the run's ULID, which every step and child carries as
-- `payload.run`. `orchestrate_steps` counts the run's steps against `ORCHESTRATE_MAX_STEPS`.
ALTER TABLE team_state ADD COLUMN orchestrate_run_id TEXT CHECK (
  orchestrate_run_id IS NULL
  OR (length(orchestrate_run_id) = 26 AND orchestrate_run_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
);
ALTER TABLE team_state ADD COLUMN orchestrate_steps INTEGER NOT NULL DEFAULT 0 CHECK (orchestrate_steps >= 0);
