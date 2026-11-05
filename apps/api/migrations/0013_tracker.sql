-- The console's own tracker, core tables (#410; ADR 0006 "Data model", decisions 1-5). Asks, owner decisions and the
-- recreated owner requests are a later migration (Phase 1a'). Timestamps are ISO 8601 UTC text. Enumerations are
-- CHECK constraints so a row the API would refuse cannot be written by any other path either; text columns carry the
-- ADR's bounds (length() counts characters). Comments and item events are append-only, enforced by triggers.

-- Which tracker a project uses. `github`: Issues are the tracker and every tracker write is refused (409
-- `tracker-not-cut-over`). A project leaves `github` only with a key prefix (items are `TC-310`), and the labels seed
-- is written in the same batch (`TrackerProjectsRepo.switchTracker`). `next_item_number` is bumped by one
-- `UPDATE … RETURNING` per new item, so two creates never share a number; a failed create leaves a gap, as GitHub does.
ALTER TABLE projects ADD COLUMN provider TEXT NOT NULL DEFAULT 'github' CHECK (provider IN ('github', 'gitlab'));
ALTER TABLE projects ADD COLUMN key_prefix TEXT
  CHECK (key_prefix IS NULL OR (length(key_prefix) BETWEEN 2 AND 5 AND key_prefix NOT GLOB '*[^A-Z]*'));
ALTER TABLE projects ADD COLUMN tracker TEXT NOT NULL DEFAULT 'github'
  CHECK (tracker IN ('github', 'cutover', 'console') AND (tracker = 'github' OR key_prefix IS NOT NULL));
ALTER TABLE projects ADD COLUMN next_item_number INTEGER NOT NULL DEFAULT 1 CHECK (next_item_number >= 1);
ALTER TABLE projects ADD COLUMN cutover_at TEXT;
ALTER TABLE projects ADD COLUMN default_branch TEXT;
-- SQLite cannot add a UNIQUE column; NULLs stay distinct, so only set prefixes are unique per environment.
CREATE UNIQUE INDEX projects_key_prefix ON projects (key_prefix);

-- The project's label set: the plugin's `LABELS` (builtin = 1, `labelsSeed` in @worker/db) plus the owner's own.
CREATE TABLE labels (
  project_slug TEXT NOT NULL REFERENCES projects (slug),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 50),
  color        TEXT NOT NULL CHECK (length(color) = 6 AND color NOT GLOB '*[^0-9a-f]*'),
  description  TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 100),
  builtin      INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
  PRIMARY KEY (project_slug, name)
);

CREATE TABLE sprints (
  id           INTEGER PRIMARY KEY,
  project_slug TEXT NOT NULL REFERENCES projects (slug),
  number       INTEGER NOT NULL CHECK (number >= 1),
  title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 256),   -- `Sprint NN`
  due_on       TEXT,                                                    -- YYYY-MM-DD, the demo day
  state        TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  description  TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 65536),
  created_at   TEXT NOT NULL,
  closed_at    TEXT,
  CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
  UNIQUE (project_slug, number),
  -- The target of items' composite key: an item can only be planned into a sprint of its own project.
  UNIQUE (id, project_slug)
);

-- Status, kind, severity, tier and sprint are columns (ADR decision 3); every other label is an `item_labels` row.
CREATE TABLE items (
  id              INTEGER PRIMARY KEY,
  project_slug    TEXT NOT NULL REFERENCES projects (slug),
  number          INTEGER NOT NULL CHECK (number >= 1),
  kind            TEXT NOT NULL CHECK (kind IN ('feature', 'bug', 'chore', 'finding', 'wow', 'question')),
  status          TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'in-progress', 'qa', 'done', 'blocked')),
  severity        TEXT CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  tier            TEXT CHECK (tier IN ('light', 'standard', 'heavy')),
  sprint_id       INTEGER,
  title           TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 256),
  body            TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 65536),
  closed_at       TEXT,
  closed_reason   TEXT CHECK (closed_reason IN ('done', 'not-planned', 'duplicate')),
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('owner', 'job', 'runner', 'system', 'import')),
  created_by      TEXT NOT NULL,                     -- display only: 'owner', a role name or an imported login
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),  -- `If-Match` (412 `item-version`)
  source          TEXT NOT NULL DEFAULT 'console' CHECK (source IN ('console', 'import')),
  source_url      TEXT,
  -- `status = 'done'` closes the item as done; a closed item always says why, an open one never does.
  CHECK ((closed_at IS NULL) = (closed_reason IS NULL)),
  CHECK (status <> 'done' OR closed_reason IS 'done'),
  CHECK (closed_reason IS NOT 'done' OR status = 'done'),
  UNIQUE (project_slug, number),
  UNIQUE (id, project_slug),
  FOREIGN KEY (sprint_id, project_slug) REFERENCES sprints (id, project_slug)
);
CREATE INDEX items_status ON items (project_slug, status);
CREATE INDEX items_sprint ON items (project_slug, sprint_id);

-- Flags only: the column-backed prefixes never become rows, so an item has exactly one status, kind, tier, severity.
CREATE TABLE item_labels (
  item_id      INTEGER NOT NULL,
  project_slug TEXT NOT NULL,
  name         TEXT NOT NULL CHECK (
    name NOT GLOB 'status:*' AND name NOT GLOB 'kind:*' AND name NOT GLOB 'tier:*' AND name NOT GLOB 'sev:*'
  ),
  PRIMARY KEY (item_id, name),
  FOREIGN KEY (item_id, project_slug) REFERENCES items (id, project_slug),
  FOREIGN KEY (project_slug, name) REFERENCES labels (project_slug, name)
);

CREATE TABLE comments (
  id                      INTEGER PRIMARY KEY,
  item_id                 INTEGER NOT NULL REFERENCES items (id),
  kind                    TEXT NOT NULL CHECK (kind IN ('comment', 'decision', 'note')),
  author_kind             TEXT NOT NULL CHECK (author_kind IN ('owner', 'job', 'runner', 'system', 'import')),
  author                  TEXT NOT NULL,             -- display only, never an authorisation input
  job_id                  TEXT,
  body                    TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 65536),
  created_at              TEXT NOT NULL,
  source                  TEXT NOT NULL DEFAULT 'console' CHECK (source IN ('console', 'import')),
  source_url              TEXT,
  reversed_by_decision_id INTEGER                    -- an owner's /reject of a team decision (Phase 1a')
);
CREATE INDEX comments_item ON comments (item_id, created_at);

-- The audit of every item change (ADR decision 5): `before`/`after` hold the changed fields only, as JSON.
CREATE TABLE item_events (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items (id),
  at         TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner', 'job', 'runner', 'system', 'import')),
  actor      TEXT NOT NULL,
  job_id     TEXT,
  kind       TEXT NOT NULL CHECK (kind IN (
    'created', 'edited', 'status', 'labels', 'sprint', 'closed', 'reopened', 'commented', 'decided', 'asked',
    'answered', 'requested', 'handled', 'pr-linked', 'imported'
  )),
  before     TEXT CHECK (before IS NULL OR json_valid(before)),
  after      TEXT CHECK (after IS NULL OR json_valid(after))
);
CREATE INDEX item_events_item ON item_events (item_id, at);

-- Append-only (threat model #408, Phase 1a): no UPDATE or DELETE reaches these rows, whatever the caller. The one
-- update a comment ever gets is its reversal mark, set once.
CREATE TRIGGER comments_append_only_update
BEFORE UPDATE OF id, item_id, kind, author_kind, author, job_id, body, created_at, source, source_url ON comments
BEGIN
  SELECT RAISE(ABORT, 'comments are append-only');
END;
CREATE TRIGGER comments_reversal_once
BEFORE UPDATE OF reversed_by_decision_id ON comments
WHEN OLD.reversed_by_decision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'comments are append-only');
END;
CREATE TRIGGER comments_append_only_delete
BEFORE DELETE ON comments
BEGIN
  SELECT RAISE(ABORT, 'comments are append-only');
END;
CREATE TRIGGER item_events_append_only_update
BEFORE UPDATE ON item_events
BEGIN
  SELECT RAISE(ABORT, 'item_events are append-only');
END;
CREATE TRIGGER item_events_append_only_delete
BEFORE DELETE ON item_events
BEGIN
  SELECT RAISE(ABORT, 'item_events are append-only');
END;
-- Items are closed, never deleted: their events and comments must keep pointing at a row.
CREATE TRIGGER items_never_deleted
BEFORE DELETE ON items
BEGIN
  SELECT RAISE(ABORT, 'items are closed, never deleted');
END;
-- `INSERT OR REPLACE` / `REPLACE INTO` deletes the conflicting row without firing DELETE triggers (recursive
-- triggers are off), so an insert that would replace a row is refused here. A plain insert never conflicts on these
-- keys, so it is unaffected; an explicit duplicate key now fails here instead of on the constraint.
CREATE TRIGGER comments_never_replaced
BEFORE INSERT ON comments
WHEN EXISTS (SELECT 1 FROM comments WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'comments are append-only');
END;
CREATE TRIGGER item_events_never_replaced
BEFORE INSERT ON item_events
WHEN EXISTS (SELECT 1 FROM item_events WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'item_events are append-only');
END;
-- Items also replace through their UNIQUE (project_slug, number).
CREATE TRIGGER items_never_replaced
BEFORE INSERT ON items
WHEN EXISTS (
  SELECT 1 FROM items WHERE id = NEW.id OR (project_slug = NEW.project_slug AND number = NEW.number)
)
BEGIN
  SELECT RAISE(ABORT, 'items are closed, never deleted');
END;

-- `Idempotency-Key` on tracker writes (ADR 0006 "API and authorisation", 24 h; the `own_write_claims` pattern). A
-- pending row (`status` NULL) is a claim held for a short while; the write's own batch completes it, so a key is done
-- exactly when its rows exist. A replay answers the resource `result_ref` names; a different request under the same
-- key is refused by `request_hash`.
CREATE TABLE idempotency_keys (
  key          TEXT PRIMARY KEY NOT NULL,
  request_hash TEXT NOT NULL,                 -- SHA-256 hex of method, path and body
  status       INTEGER,                       -- the first answer's HTTP status; NULL while the write is in flight
  result_kind  TEXT CHECK (result_kind IN ('item', 'sprint', 'comment', 'label')),
  result_ref   TEXT,                          -- item or sprint number, comment id or label name
  created_at   TEXT NOT NULL,
  expires_at   INTEGER NOT NULL               -- epoch milliseconds
);
CREATE INDEX idempotency_keys_expiry ON idempotency_keys (expires_at);
