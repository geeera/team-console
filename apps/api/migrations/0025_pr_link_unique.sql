-- One `pr-linked` event per item and pull request (#529, review of #526). `POST …/items/:key/pr-links` checks for
-- an existing link before it writes, but two requests with different idempotency keys could both pass that check
-- and both write. A partial UNIQUE index over (item_id, the link's number) makes the second batch fail; the route
-- then answers the winner's link like any repeat link (200 same branch, 409 other branch).
--
-- Existing duplicates (written by that race before this migration) cannot be deleted: `item_events` is append-only.
-- They are kept and marked instead: `duplicate_of` names the item's first `pr-linked` event of the same number, and
-- the index skips marked rows, so the migration never fails on them. The route and `findPrLink` already answer the
-- first link, so the marked rows change no answer. Nothing but this migration ever sets the column: a new row
-- carrying it is refused, and the append-only trigger now also freezes it.
ALTER TABLE item_events ADD COLUMN duplicate_of INTEGER;

-- The marking is the one update this table gets outside the scrub; the trigger is recreated below with the column.
DROP TRIGGER item_events_append_only_update;

UPDATE item_events
SET duplicate_of = (
  SELECT MIN(earliest.id) FROM item_events AS earliest
  WHERE earliest.item_id = item_events.item_id
    AND earliest.kind = 'pr-linked'
    AND json_extract(earliest.after, '$.number') = json_extract(item_events.after, '$.number')
)
WHERE kind = 'pr-linked'
  AND id > (
    SELECT MIN(earliest.id) FROM item_events AS earliest
    WHERE earliest.item_id = item_events.item_id
      AND earliest.kind = 'pr-linked'
      AND json_extract(earliest.after, '$.number') = json_extract(item_events.after, '$.number')
  );

-- 0019's trigger, plus `duplicate_of` among the columns a scrub must keep.
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

-- A new row never marks itself a duplicate, so it can never step around the index.
CREATE TRIGGER item_events_duplicate_of_migration_only
BEFORE INSERT ON item_events
WHEN NEW.duplicate_of IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'item_events.duplicate_of is set by migration 0025 only');
END;

CREATE UNIQUE INDEX item_events_pr_link ON item_events (item_id, json_extract(after, '$.number'))
WHERE kind = 'pr-linked' AND duplicate_of IS NULL;
