-- The operator's stop of a write path (#759 PR 4, SEC 4; ADR 0008 decision 7(a′) amendment). A row here switches the
-- named path off on the next request, without a deploy: `actions-setup-write` is the console's write to a customer
-- repository (branch, workflow file, pull request). The path runs only while its reviewed wrangler var allows it AND no
-- row stops it, so this table can only switch a path off; switching one on stays a reviewed change of the var.
--
-- Written by the operator alone, with `wrangler d1 execute` (docs/runbooks/deploy-and-rollback.md › "Stop the Actions
-- setup write"); no route of the Worker inserts, updates or deletes a row, so a stolen session cannot lift a stop.
CREATE TABLE operator_stops (
  name       TEXT PRIMARY KEY NOT NULL CHECK (name IN ('actions-setup-write')),
  stopped_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', stopped_at) IS substr(stopped_at, 1, 19) AND substr(stopped_at, -1) = 'Z'
  ),
  -- Why, for whoever lifts it later: an incident or issue reference. Never a secret.
  reason     TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200)
);
