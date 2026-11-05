-- Asks, owner decisions, owner requests and the import map stub (#434; ADR 0006 Phase 1a', "Data model" with the
-- amendments recorded there). Same style as 0013: enumerations and bounds are CHECKs, every row points at an item of
-- its own project through the composite (item_id, project_slug) key, and the rows are append-only by triggers.
-- Asks, decision texts and request payloads are data: bounded and shape-checked here, never interpreted.

-- Questions to the owner (formerly `pt-ask`). Written by a job (`POST …/items/:key/asks`), never by the owner. One
-- open ask per item; a new ask withdraws the open one in the same batch. `source = 'import'` is a GitHub-era ask that
-- the owner re-confirms on the cutover screen; it is never listed in Needs you nor answered as is (R7).
CREATE TABLE asks (
  id                      INTEGER PRIMARY KEY,
  project_slug            TEXT NOT NULL REFERENCES projects (slug),
  item_id                 INTEGER NOT NULL,
  category                TEXT NOT NULL CHECK (category IN ('money', 'scope', 'release', 'access', 'legal', 'design')),
  ask                     TEXT NOT NULL CHECK (length(ask) BETWEEN 1 AND 2048),
  -- A JSON array of the plugin's ANSWERABLE commands; its members are checked by `asks_commands_answerable`
  -- (a CHECK cannot read json_each).
  commands                TEXT NOT NULL CHECK (json_valid(commands) AND json_type(commands) = 'array'),
  -- The team's recommendation, one of `commands` (the batch approve needs it); checked by the same trigger.
  recommended             TEXT,
  job_id                  TEXT CHECK (job_id IS NULL OR length(job_id) BETWEEN 1 AND 64),
  created_at              TEXT NOT NULL,
  source                  TEXT NOT NULL DEFAULT 'console' CHECK (source IN ('console', 'import')),
  answered_by_decision_id INTEGER REFERENCES owner_decisions (id),
  withdrawn_at            TEXT,
  CHECK (answered_by_decision_id IS NULL OR withdrawn_at IS NULL),
  FOREIGN KEY (item_id, project_slug) REFERENCES items (id, project_slug),
  -- The target of owner_decisions' (ask_id, item_id): a decision can only answer an ask on its own item.
  UNIQUE (id, item_id)
);
CREATE UNIQUE INDEX asks_open_per_item ON asks (item_id) WHERE answered_by_decision_id IS NULL AND withdrawn_at IS NULL;
CREATE INDEX asks_item ON asks (item_id, id);

-- The owner's decisions (formerly the owner's answer line). Written only by the owner identity through the API
-- (`via` web or push); `via = 'import'` rows come only from the import writer (Phase 1b), are history, and drive
-- nothing (R7). `idempotency_key` is the client's key, kept for the audit; NULL only on an imported row.
CREATE TABLE owner_decisions (
  id                  INTEGER PRIMARY KEY,
  project_slug        TEXT NOT NULL REFERENCES projects (slug),
  item_id             INTEGER NOT NULL,
  ask_id              INTEGER,
  command             TEXT NOT NULL CHECK (command IN ('approve', 'reject', 'go', 'no-go', 'done', 'override', 'resume')),
  text                TEXT NOT NULL DEFAULT '' CHECK (length(text) <= 2000),
  decided_at          TEXT NOT NULL,
  via                 TEXT NOT NULL CHECK (via IN ('web', 'push', 'import')),
  idempotency_key     TEXT UNIQUE,
  reverses_comment_id INTEGER REFERENCES comments (id),
  source_url          TEXT,
  CHECK (via = 'import' OR idempotency_key IS NOT NULL),
  CHECK (via = 'import' OR source_url IS NULL),
  FOREIGN KEY (item_id, project_slug) REFERENCES items (id, project_slug),
  FOREIGN KEY (ask_id, item_id) REFERENCES asks (id, item_id)
);
CREATE INDEX owner_decisions_item ON owner_decisions (project_slug, item_id, id);

-- The owner's requests to the PM (ADR 0005, recreated as the record). Named apart from 0012's `owner_requests`,
-- which `routes/owner-request.ts`, apps/hooks and `request-handled.ts` read until Phase 6; a rename here would race
-- the deploy. `payload` is the canonical JSON of `@shared/owner-grammar` (`canonicalRequest`). The newest row per
-- item is the pending one: a query, not a column. The PM's answer fills the four handled columns once, together.
CREATE TABLE item_requests (
  id                INTEGER PRIMARY KEY,
  project_slug      TEXT NOT NULL REFERENCES projects (slug),
  item_id           INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('sprint', 'priority')),
  payload           TEXT NOT NULL CHECK (
    json_valid(payload) AND length(payload) <= 256 AND json_extract(payload, '$.kind') = kind
  ),
  requested_at      TEXT NOT NULL,
  handled_by_job_id TEXT CHECK (handled_by_job_id IS NULL OR length(handled_by_job_id) BETWEEN 1 AND 64),
  result            TEXT CHECK (result IN ('applied', 'declined')),
  reason            TEXT CHECK (reason IS NULL OR length(reason) <= 1024),
  handled_at        TEXT,
  CHECK (
    (handled_by_job_id IS NULL) = (result IS NULL)
    AND (result IS NULL) = (reason IS NULL)
    AND (reason IS NULL) = (handled_at IS NULL)
  ),
  FOREIGN KEY (item_id, project_slug) REFERENCES items (id, project_slug)
);
CREATE INDEX item_requests_item ON item_requests (item_id, id);

-- The import's idempotent re-runs (Phase 1b writes it): which console row a GitHub issue, milestone, comment or PR
-- became. Table only in this migration.
CREATE TABLE import_map (
  project_slug TEXT NOT NULL REFERENCES projects (slug),
  source_kind  TEXT NOT NULL CHECK (source_kind IN ('issue', 'milestone', 'comment', 'pr')),
  source_id    TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 64),
  target_table TEXT NOT NULL CHECK (length(target_table) BETWEEN 1 AND 64),
  target_id    TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 64),
  PRIMARY KEY (project_slug, source_kind, source_id)
);

-- asks: the commands are ANSWERABLE, unique and at least one; the recommendation is one of them.
CREATE TRIGGER asks_commands_answerable
BEFORE INSERT ON asks
WHEN json_array_length(NEW.commands) NOT BETWEEN 1 AND 6
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.commands)
    WHERE type <> 'text' OR value NOT IN ('approve', 'done', 'go', 'no-go', 'override', 'reject')
  )
  OR (SELECT COUNT(DISTINCT value) FROM json_each(NEW.commands)) <> json_array_length(NEW.commands)
  OR (NEW.recommended IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.commands) WHERE value = NEW.recommended))
BEGIN
  SELECT RAISE(ABORT, 'asks.commands must be ANSWERABLE commands and recommended one of them');
END;

-- asks: append-only. The only updates are the answer and the withdrawal, each from NULL once (the CHECK above keeps
-- them apart); `INSERT OR REPLACE` would delete the conflicting row (an open ask through the partial index, too)
-- without firing a DELETE trigger, so a conflicting insert is refused before it gets there.
CREATE TRIGGER asks_append_only_update
BEFORE UPDATE OF id, project_slug, item_id, category, ask, commands, recommended, job_id, created_at, source ON asks
BEGIN
  SELECT RAISE(ABORT, 'asks are append-only');
END;
CREATE TRIGGER asks_answered_once
BEFORE UPDATE OF answered_by_decision_id ON asks
WHEN OLD.answered_by_decision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'asks are append-only');
END;
CREATE TRIGGER asks_withdrawn_once
BEFORE UPDATE OF withdrawn_at ON asks
WHEN OLD.withdrawn_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'asks are append-only');
END;
CREATE TRIGGER asks_append_only_delete
BEFORE DELETE ON asks
BEGIN
  SELECT RAISE(ABORT, 'asks are append-only');
END;
CREATE TRIGGER asks_never_replaced
BEFORE INSERT ON asks
WHEN EXISTS (
  SELECT 1 FROM asks
  WHERE id = NEW.id
     OR (item_id = NEW.item_id AND answered_by_decision_id IS NULL AND withdrawn_at IS NULL
         AND NEW.answered_by_decision_id IS NULL AND NEW.withdrawn_at IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'asks are append-only');
END;

-- owner_decisions: fully append-only.
CREATE TRIGGER owner_decisions_append_only_update
BEFORE UPDATE ON owner_decisions
BEGIN
  SELECT RAISE(ABORT, 'owner_decisions are append-only');
END;
CREATE TRIGGER owner_decisions_append_only_delete
BEFORE DELETE ON owner_decisions
BEGIN
  SELECT RAISE(ABORT, 'owner_decisions are append-only');
END;
CREATE TRIGGER owner_decisions_never_replaced
BEFORE INSERT ON owner_decisions
WHEN EXISTS (SELECT 1 FROM owner_decisions WHERE id = NEW.id OR idempotency_key = NEW.idempotency_key)
BEGIN
  SELECT RAISE(ABORT, 'owner_decisions are append-only');
END;

-- item_requests: append-only except the PM's answer, set once.
CREATE TRIGGER item_requests_append_only_update
BEFORE UPDATE OF id, project_slug, item_id, kind, payload, requested_at ON item_requests
BEGIN
  SELECT RAISE(ABORT, 'item_requests are append-only');
END;
CREATE TRIGGER item_requests_handled_once
BEFORE UPDATE OF handled_by_job_id, result, reason, handled_at ON item_requests
WHEN OLD.handled_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'item_requests are append-only');
END;
CREATE TRIGGER item_requests_append_only_delete
BEFORE DELETE ON item_requests
BEGIN
  SELECT RAISE(ABORT, 'item_requests are append-only');
END;
CREATE TRIGGER item_requests_never_replaced
BEFORE INSERT ON item_requests
WHEN EXISTS (SELECT 1 FROM item_requests WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'item_requests are append-only');
END;

-- idempotency_keys: 0013 pins `result_kind` to four values and SQLite cannot alter a CHECK, so the table is rebuilt.
-- Rows are copied, not dropped: keys of in-flight writes from the previous deploy must still replay.
CREATE TABLE idempotency_keys_new (
  key          TEXT PRIMARY KEY NOT NULL,
  request_hash TEXT NOT NULL,                 -- SHA-256 hex of method, path and body
  status       INTEGER,                       -- the first answer's HTTP status; NULL while the write is in flight
  result_kind  TEXT CHECK (result_kind IN ('item', 'sprint', 'comment', 'label', 'ask', 'decision', 'request')),
  result_ref   TEXT,                          -- item or sprint number, comment, ask, decision or request id, label name
  created_at   TEXT NOT NULL,
  expires_at   INTEGER NOT NULL               -- epoch milliseconds
);
INSERT INTO idempotency_keys_new (key, request_hash, status, result_kind, result_ref, created_at, expires_at)
  SELECT key, request_hash, status, result_kind, result_ref, created_at, expires_at FROM idempotency_keys;
DROP TABLE idempotency_keys;
ALTER TABLE idempotency_keys_new RENAME TO idempotency_keys;
CREATE INDEX idempotency_keys_expiry ON idempotency_keys (expires_at);
