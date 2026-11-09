-- The owner's scope approval as a recorded fact (#452, security review of #458). Until now "approved" was inferred
-- from the status: anything past `proposed` counted as approved once. But the release decision closes a proposed
-- `team:demo` item as `done` without approving it, and a job could reopen that item into work. `approved_at` is set,
-- in the same statement as the status, the first time an item reaches a workable status (`approved`, `in-progress`,
-- `qa`, `blocked`). The transition table lets only the owner or an owner decision's effect do that to an item that
-- has no approval, so a set `approved_at` means the owner approved it. It is never cleared or rewritten.
ALTER TABLE items ADD COLUMN approved_at TEXT;

-- Backfill. An item in a workable status got there through the owner (no job identity is deployed yet). A `done`
-- item counts as approved only if its history shows a workable status. A done item without that history (e.g. a
-- demo item closed by the release decision) stays unapproved: fail closed, so only the owner can reopen it into work.
UPDATE items
SET approved_at = COALESCE(
  (SELECT MIN(e.at) FROM item_events e
   WHERE e.item_id = items.id
     AND e.kind IN ('created', 'status', 'closed', 'reopened')
     AND json_extract(e.after, '$.status') IN ('approved', 'in-progress', 'qa', 'blocked')),
  items.created_at)
WHERE items.status IN ('approved', 'in-progress', 'qa', 'blocked');

UPDATE items
SET approved_at = (SELECT MIN(e.at) FROM item_events e
                   WHERE e.item_id = items.id
                     AND e.kind IN ('created', 'status', 'closed', 'reopened')
                     AND json_extract(e.after, '$.status') IN ('approved', 'in-progress', 'qa', 'blocked'))
WHERE items.status = 'done';

-- A workable item always carries its approval; a writer that forgets it fails instead of creating an unapproved
-- item in work.
CREATE TRIGGER items_workable_needs_approval_insert
BEFORE INSERT ON items
WHEN NEW.status IN ('approved', 'in-progress', 'qa', 'blocked') AND NEW.approved_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'items.approved_at must be set for an item in a workable status');
END;

CREATE TRIGGER items_workable_needs_approval_update
BEFORE UPDATE OF status, approved_at ON items
WHEN NEW.status IN ('approved', 'in-progress', 'qa', 'blocked') AND NEW.approved_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'items.approved_at must be set for an item in a workable status');
END;

-- The approval is history: once set, it is kept as it is.
CREATE TRIGGER items_approval_kept
BEFORE UPDATE OF approved_at ON items
WHEN OLD.approved_at IS NOT NULL AND NEW.approved_at IS NOT OLD.approved_at
BEGIN
  SELECT RAISE(ABORT, 'items.approved_at is never cleared or changed');
END;
