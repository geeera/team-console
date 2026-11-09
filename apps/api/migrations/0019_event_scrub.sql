-- The owner's scrub of an item's audit trail (#462, ADR 0008 row 2-0; the retention concern of the #428/#429 reviews).
-- `item_events` keeps every before/after for good (ADR 0006 decision 5), so a secret that once reached an item's title
-- or body stays in its `created`/`edited` events after the item itself is corrected. `POST …/items/:key/events/scrub`
-- (owner only) masks `title` and `body` in those events and records a `scrubbed` event: incident response, not a
-- schedule. Everything else stays append-only.
--
-- 0013 pins `item_events.kind` with a CHECK and SQLite cannot alter one, so the table is rebuilt: rows copied with
-- their ids, then the index and the append-only triggers recreated. Nothing references `item_events`.
CREATE TABLE item_events_new (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items (id),
  at         TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner', 'job', 'runner', 'system', 'import')),
  actor      TEXT NOT NULL,
  job_id     TEXT,
  kind       TEXT NOT NULL CHECK (kind IN (
    'created', 'edited', 'status', 'labels', 'sprint', 'closed', 'reopened', 'commented', 'decided', 'asked',
    'answered', 'requested', 'handled', 'pr-linked', 'imported', 'scrubbed'
  )),
  before     TEXT CHECK (before IS NULL OR json_valid(before)),
  after      TEXT CHECK (after IS NULL OR json_valid(after))
);
INSERT INTO item_events_new (id, item_id, at, actor_kind, actor, job_id, kind, before, after)
  SELECT id, item_id, at, actor_kind, actor, job_id, kind, before, after FROM item_events;
DROP TABLE item_events;
ALTER TABLE item_events_new RENAME TO item_events;
CREATE INDEX item_events_item ON item_events (item_id, at);

-- The one update an event ever gets: `title` and `body` of a `created` or `edited` event replaced by the marker, every
-- other column and member as it was. Anything else is refused as before. The expression is the one
-- `ItemEventsRepo.scrub` writes, so a scrub passes and nothing else does; a second scrub is a no-op.
CREATE TRIGGER item_events_append_only_update
BEFORE UPDATE ON item_events
WHEN NOT (
  OLD.kind IN ('created', 'edited')
  AND NEW.id IS OLD.id
  AND NEW.item_id IS OLD.item_id
  AND NEW.at IS OLD.at
  AND NEW.actor_kind IS OLD.actor_kind
  AND NEW.actor IS OLD.actor
  AND NEW.job_id IS OLD.job_id
  AND NEW.kind IS OLD.kind
  AND NEW.before IS json_replace(OLD.before, '$.title', '[scrubbed]', '$.body', '[scrubbed]')
  AND NEW.after IS json_replace(OLD.after, '$.title', '[scrubbed]', '$.body', '[scrubbed]')
)
BEGIN
  SELECT RAISE(ABORT, 'item_events are append-only');
END;
CREATE TRIGGER item_events_append_only_delete
BEFORE DELETE ON item_events
BEGIN
  SELECT RAISE(ABORT, 'item_events are append-only');
END;
CREATE TRIGGER item_events_never_replaced
BEFORE INSERT ON item_events
WHEN EXISTS (SELECT 1 FROM item_events WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'item_events are append-only');
END;

-- idempotency_keys: the scrub's key points at its `scrubbed` event, a result kind 0014 does not admit. Rebuilt as 0014
-- did, rows copied. Those rows are kept only until they expire (24 h): since #462 part 1 a key row is scoped to the
-- caller, so a key written before that deploy never matches a new request and is not replayed.
CREATE TABLE idempotency_keys_new (
  key          TEXT PRIMARY KEY NOT NULL,
  request_hash TEXT NOT NULL,                 -- SHA-256 hex of the caller's scope, method, path and body
  status       INTEGER,                       -- the first answer's HTTP status; NULL while the write is in flight
  result_kind  TEXT CHECK (result_kind IN ('item', 'sprint', 'comment', 'label', 'ask', 'decision', 'request', 'event')),
  result_ref   TEXT,                          -- item or sprint number, comment, ask, decision, request or event id, label name
  created_at   TEXT NOT NULL,
  expires_at   INTEGER NOT NULL               -- epoch milliseconds
);
INSERT INTO idempotency_keys_new (key, request_hash, status, result_kind, result_ref, created_at, expires_at)
  SELECT key, request_hash, status, result_kind, result_ref, created_at, expires_at FROM idempotency_keys;
DROP TABLE idempotency_keys;
ALTER TABLE idempotency_keys_new RENAME TO idempotency_keys;
CREATE INDEX idempotency_keys_expiry ON idempotency_keys (expires_at);
