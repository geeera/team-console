-- Hardening of `items.approved_at` (#457, from the PR #458 security re-review). 0016's triggers make a workable item
-- carry an approval but accept any non-NULL value, set in any status. These close that for direct SQL writes too:
-- the value is a UTC timestamp as the Worker writes it, and it is only ever set while the item enters a workable
-- status, which is the one moment `planItemUpdate` / `ItemsRepo.create` record it.
--
-- SQLite cannot add a CHECK to an existing column without rebuilding `items` (and with it every foreign key and
-- trigger that names it), so the checks are BEFORE triggers with the same effect on every INSERT and UPDATE.
-- Rows already there are left as 0016 wrote them: their values came from `item_events.at` / `items.created_at`.

-- `YYYY-MM-DDTHH:MM:SSZ` or `YYYY-MM-DDTHH:MM:SS.sssZ` (`Date.prototype.toISOString`), and a real calendar time:
-- the strftime round trip refuses anything it cannot read and 2026-02-30, which it normalises to March. Built from
-- lengths and substrings because D1 refuses a GLOB pattern as long as the whole shape; `IS`, not `=`, so a value
-- strftime cannot read (NULL) fails the check instead of making the whole condition NULL.
CREATE TRIGGER items_approval_is_timestamp_insert
BEFORE INSERT ON items
WHEN NEW.approved_at IS NOT NULL AND NOT (
  typeof(NEW.approved_at) = 'text'
  AND strftime('%Y-%m-%dT%H:%M:%S', NEW.approved_at) IS substr(NEW.approved_at, 1, 19)
  AND ((length(NEW.approved_at) = 20 AND substr(NEW.approved_at, 20) = 'Z')
       OR (length(NEW.approved_at) = 24 AND substr(NEW.approved_at, 20, 1) = '.'
           AND substr(NEW.approved_at, 21, 3) GLOB '[0-9][0-9][0-9]' AND substr(NEW.approved_at, 24) = 'Z')))
BEGIN
  SELECT RAISE(ABORT, 'items.approved_at must be a UTC timestamp');
END;

CREATE TRIGGER items_approval_is_timestamp_update
BEFORE UPDATE OF approved_at ON items
WHEN NEW.approved_at IS NOT NULL AND NOT (
  typeof(NEW.approved_at) = 'text'
  AND strftime('%Y-%m-%dT%H:%M:%S', NEW.approved_at) IS substr(NEW.approved_at, 1, 19)
  AND ((length(NEW.approved_at) = 20 AND substr(NEW.approved_at, 20) = 'Z')
       OR (length(NEW.approved_at) = 24 AND substr(NEW.approved_at, 20, 1) = '.'
           AND substr(NEW.approved_at, 21, 3) GLOB '[0-9][0-9][0-9]' AND substr(NEW.approved_at, 24) = 'Z')))
BEGIN
  SELECT RAISE(ABORT, 'items.approved_at must be a UTC timestamp');
END;

-- The approval is recorded as the item enters work, never on a proposed or done item: a direct write cannot mark an
-- item approved and leave it where a job would later reopen it into work as if the owner had said yes. An importer
-- records a done item's approval the same way, through its workable status first.
CREATE TRIGGER items_approval_needs_workable_insert
BEFORE INSERT ON items
WHEN NEW.approved_at IS NOT NULL AND NEW.status NOT IN ('approved', 'in-progress', 'qa', 'blocked')
BEGIN
  SELECT RAISE(ABORT, 'items.approved_at is set only while the item enters a workable status');
END;

CREATE TRIGGER items_approval_needs_workable_update
BEFORE UPDATE OF approved_at ON items
WHEN OLD.approved_at IS NULL AND NEW.approved_at IS NOT NULL
  AND NEW.status NOT IN ('approved', 'in-progress', 'qa', 'blocked')
BEGIN
  SELECT RAISE(ABORT, 'items.approved_at is set only while the item enters a workable status');
END;
