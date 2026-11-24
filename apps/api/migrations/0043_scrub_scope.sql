-- The owner's scrub beyond an item's title and body (#477, finding 5 of the security review of #474). A secret can
-- also sit in a comment, an ask, the PM's reason on a request, or an `imported` event (#437), and those rows were
-- append-only with no way to clean them. Each guard below is recreated to admit exactly one more update: the text
-- column replaced by the marker `[scrubbed]`, every other column as it was. Nothing else about the rows changes; no
-- table is rebuilt and no row is touched by this migration.
--
-- Sprints need no guard here: `sprints.title` and `description` were never append-only (0013), so the sprint scrub
-- (`SprintsRepo.scrub`) is an ordinary update, audited in `audit_events`.

-- item_events: 0029's trigger with `imported` beside `created` and `edited`. An import event carries the imported
-- text under `title` and `body`, the same members the scrub masks.
DROP TRIGGER item_events_append_only_update;
CREATE TRIGGER item_events_append_only_update
BEFORE UPDATE ON item_events
WHEN NOT (
  OLD.kind IN ('created', 'edited', 'imported')
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

-- comments: 0013's trigger refused every update of these columns. The body may now become the marker, and only in an
-- update that keeps every other column, the reversal mark included (that one has its own triggers: 0013, 0015).
DROP TRIGGER comments_append_only_update;
CREATE TRIGGER comments_append_only_update
BEFORE UPDATE OF id, item_id, kind, author_kind, author, job_id, body, created_at, source, source_url ON comments
WHEN NOT (
  NEW.body IS '[scrubbed]'
  AND NEW.id IS OLD.id
  AND NEW.item_id IS OLD.item_id
  AND NEW.kind IS OLD.kind
  AND NEW.author_kind IS OLD.author_kind
  AND NEW.author IS OLD.author
  AND NEW.job_id IS OLD.job_id
  AND NEW.created_at IS OLD.created_at
  AND NEW.source IS OLD.source
  AND NEW.source_url IS OLD.source_url
  AND NEW.reversed_by_decision_id IS OLD.reversed_by_decision_id
)
BEGIN
  SELECT RAISE(ABORT, 'comments are append-only');
END;

-- asks: the same for 0014's trigger and the `ask` text. The answer and the withdrawal keep their own once-only
-- triggers and may not ride in a scrub.
DROP TRIGGER asks_append_only_update;
CREATE TRIGGER asks_append_only_update
BEFORE UPDATE OF id, project_slug, item_id, category, ask, commands, recommended, job_id, created_at, source ON asks
WHEN NOT (
  NEW.ask IS '[scrubbed]'
  AND NEW.id IS OLD.id
  AND NEW.project_slug IS OLD.project_slug
  AND NEW.item_id IS OLD.item_id
  AND NEW.category IS OLD.category
  AND NEW.commands IS OLD.commands
  AND NEW.recommended IS OLD.recommended
  AND NEW.job_id IS OLD.job_id
  AND NEW.created_at IS OLD.created_at
  AND NEW.source IS OLD.source
  AND NEW.answered_by_decision_id IS OLD.answered_by_decision_id
  AND NEW.withdrawn_at IS OLD.withdrawn_at
)
BEGIN
  SELECT RAISE(ABORT, 'asks are append-only');
END;

-- item_requests: the PM's answer is still set once; afterwards its `reason` may become the marker while who handled
-- it, the result and the time stay. The other columns keep 0014's unconditional trigger, and a request nobody has
-- handled has no reason to mask (the table's CHECK keeps the four handled columns NULL together).
DROP TRIGGER item_requests_handled_once;
CREATE TRIGGER item_requests_handled_once
BEFORE UPDATE OF handled_by_job_id, result, reason, handled_at ON item_requests
WHEN OLD.handled_at IS NOT NULL
  AND NOT (
    NEW.reason IS '[scrubbed]'
    AND NEW.handled_by_job_id IS OLD.handled_by_job_id
    AND NEW.result IS OLD.result
    AND NEW.handled_at IS OLD.handled_at
  )
BEGIN
  SELECT RAISE(ABORT, 'item_requests are append-only');
END;
