-- The queue order of the console tracker (#456, architect note; #409 §2.2 First / Up / Down): one sparse integer
-- `rank` per item, global to the project, gap 1024. Every view filters first and then orders by (rank, number); a
-- lane is the open items of one (sprint_id, status). Backfilled as number × 1024, so today's order stays as it is,
-- and a new item is created at number × 1024 — always the end of its queue. Up / Down swap ranks with the lane
-- neighbour and use no gap; First writes min(rank) − 1024; a midpoint with no room left (a later drag-to-position)
-- rebalances the project to row_number × 1024 in the same batch.
ALTER TABLE items ADD COLUMN rank INTEGER NOT NULL DEFAULT 0;
UPDATE items SET rank = number * 1024;
CREATE INDEX items_rank ON items (project_slug, rank);

-- A row never keeps the column default: the repo writes the rank with the number, and a writer that forgets (an
-- import, a seed) would otherwise put its item first in every lane. The fallback is the same end-of-queue rank.
CREATE TRIGGER items_rank_defaulted
AFTER INSERT ON items
WHEN NEW.rank = 0
BEGIN
  UPDATE items SET rank = NEW.number * 1024 WHERE id = NEW.id;
END;

-- Event kind `reordered` (`before`/`after` = {rank}). 0013 pins `item_events.kind` with a CHECK and SQLite cannot
-- alter one, so the table is rebuilt as 0019 did: rows copied with their ids (0025's `duplicate_of` included), then
-- the indexes and the append-only triggers recreated exactly as 0019 and 0025 left them. Nothing references
-- `item_events`.
CREATE TABLE item_events_new (
  id           INTEGER PRIMARY KEY,
  item_id      INTEGER NOT NULL REFERENCES items (id),
  at           TEXT NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('owner', 'job', 'runner', 'system', 'import')),
  actor        TEXT NOT NULL,
  job_id       TEXT,
  kind         TEXT NOT NULL CHECK (kind IN (
    'created', 'edited', 'status', 'labels', 'sprint', 'closed', 'reopened', 'commented', 'decided', 'asked',
    'answered', 'requested', 'handled', 'pr-linked', 'imported', 'scrubbed', 'reordered'
  )),
  before       TEXT CHECK (before IS NULL OR json_valid(before)),
  after        TEXT CHECK (after IS NULL OR json_valid(after)),
  duplicate_of INTEGER
);
INSERT INTO item_events_new (id, item_id, at, actor_kind, actor, job_id, kind, before, after, duplicate_of)
  SELECT id, item_id, at, actor_kind, actor, job_id, kind, before, after, duplicate_of FROM item_events;
DROP TABLE item_events;
ALTER TABLE item_events_new RENAME TO item_events;
CREATE INDEX item_events_item ON item_events (item_id, at);
CREATE UNIQUE INDEX item_events_pr_link ON item_events (item_id, json_extract(after, '$.number'))
WHERE kind = 'pr-linked' AND duplicate_of IS NULL;

-- 0025's trigger: the scrub of a created or edited event is the one update; everything else is refused.
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
  AND NEW.duplicate_of IS OLD.duplicate_of
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
CREATE TRIGGER item_events_duplicate_of_migration_only
BEFORE INSERT ON item_events
WHEN NEW.duplicate_of IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'item_events.duplicate_of is set by migration 0025 only');
END;
