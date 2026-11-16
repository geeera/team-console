-- GitHub Actions dispatch (#668, #573 sub-issue 1; ADR 0008 decision 7(a′), threat model C11 row 5). A project either
-- waits for a pulling runner (`pull`, every project today) or has its jobs dispatched to a workflow run in its own
-- repository (`actions`, switched by the owner in #670). The run presents a GitHub OIDC token to
-- `POST /runner/oidc-exchange`, which writes an ephemeral runner and claims the job in one batch.

ALTER TABLE projects ADD COLUMN dispatch TEXT NOT NULL DEFAULT 'pull' CHECK (dispatch IN ('pull', 'actions'));

-- When the console asked GitHub for the run (#670); NULL for pulled jobs and before the call.
ALTER TABLE jobs ADD COLUMN dispatched_at TEXT CHECK (
  dispatched_at IS NULL
  OR (strftime('%Y-%m-%dT%H:%M:%S', dispatched_at) IS substr(dispatched_at, 1, 19) AND substr(dispatched_at, -1) = 'Z')
);

-- A workflow run claims one job, once: a replayed OIDC token (or a re-run, which keeps its `run_id`) finds its run
-- already recorded and the exchange's batch fails on this index.
CREATE UNIQUE INDEX jobs_actions_run ON jobs (actions_run_id) WHERE actions_run_id IS NOT NULL;

-- The run a job was exchanged to is history: rewriting it would free that `run_id` for a second exchange.
CREATE TRIGGER jobs_actions_run_kept
BEFORE UPDATE OF actions_run_id ON jobs
WHEN OLD.actions_run_id IS NOT NULL AND NEW.actions_run_id IS NOT OLD.actions_run_id
BEGIN
  SELECT RAISE(ABORT, 'a job keeps its Actions run');
END;
