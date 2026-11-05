-- Cross-row guards for 0013/0014 (#443, security review of #440). The repos already write these links only within one
-- item; the schema now refuses anything else, so a bug or a later writer (the Phase 1b import) cannot point a row at
-- another item's or project's row. Item ids are global (INTEGER PRIMARY KEY), and every row's (item_id, project_slug)
-- is tied to its item by 0013/0014's composite keys, so "the same item_id" is also "the same project".
-- None of these messages says "are append-only": that phrase marks a lost race the routes retry
-- (`isAppendOnlyConflict`), and these are bugs that must surface.

-- asks.answered_by_decision_id: only a decision on this item that names this ask (owner_decisions.ask_id), and R7 —
-- an imported ask is answered only by an imported decision, a console ask never by one.
CREATE TRIGGER asks_answer_same_item_update
BEFORE UPDATE OF answered_by_decision_id ON asks
WHEN NEW.answered_by_decision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM owner_decisions
    WHERE id = NEW.answered_by_decision_id
      AND item_id = OLD.item_id
      AND project_slug = OLD.project_slug
      AND ask_id = OLD.id
      AND (via = 'import') = (OLD.source = 'import')
  )
BEGIN
  SELECT RAISE(ABORT, 'asks.answered_by_decision_id must be a decision on this ask of the same source');
END;
-- An ask inserted already answered: the decision must name it, which the decision's own (ask_id, item_id) key makes
-- impossible before the ask exists, so in practice this refuses every answered insert.
CREATE TRIGGER asks_answer_same_item_insert
BEFORE INSERT ON asks
WHEN NEW.answered_by_decision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM owner_decisions
    WHERE id = NEW.answered_by_decision_id
      AND item_id = NEW.item_id
      AND project_slug = NEW.project_slug
      AND ask_id = NEW.id
      AND (via = 'import') = (NEW.source = 'import')
  )
BEGIN
  SELECT RAISE(ABORT, 'asks.answered_by_decision_id must be a decision on this ask of the same source');
END;

-- owner_decisions: R7 at the decision itself (a web or push decision never names an imported ask, an imported one
-- never a console ask), and a reversal only of a team decision of the same item.
CREATE TRIGGER owner_decisions_ask_same_source
BEFORE INSERT ON owner_decisions
WHEN NEW.ask_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM asks
    WHERE id = NEW.ask_id AND item_id = NEW.item_id AND (source = 'import') = (NEW.via = 'import')
  )
BEGIN
  SELECT RAISE(ABORT, 'owner_decisions.ask_id must be an ask of this item of the same source');
END;
CREATE TRIGGER owner_decisions_reversal_same_item
BEFORE INSERT ON owner_decisions
WHEN NEW.reverses_comment_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM comments WHERE id = NEW.reverses_comment_id AND item_id = NEW.item_id AND kind = 'decision'
  )
BEGIN
  SELECT RAISE(ABORT, 'owner_decisions.reverses_comment_id must be a team decision of this item');
END;

-- comments.reversed_by_decision_id (no FK in 0013): only a decision on this item that reverses this very comment,
-- and only on a team decision.
CREATE TRIGGER comments_reversal_same_item_update
BEFORE UPDATE OF reversed_by_decision_id ON comments
WHEN NEW.reversed_by_decision_id IS NOT NULL
  AND (
    OLD.kind <> 'decision'
    OR NOT EXISTS (
      SELECT 1 FROM owner_decisions
      WHERE id = NEW.reversed_by_decision_id AND item_id = OLD.item_id AND reverses_comment_id = OLD.id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'comments.reversed_by_decision_id must be a decision on this item reversing this comment');
END;
CREATE TRIGGER comments_reversal_same_item_insert
BEFORE INSERT ON comments
WHEN NEW.reversed_by_decision_id IS NOT NULL
  AND (
    NEW.kind <> 'decision'
    OR NOT EXISTS (
      SELECT 1 FROM owner_decisions
      WHERE id = NEW.reversed_by_decision_id AND item_id = NEW.item_id AND reverses_comment_id = NEW.id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'comments.reversed_by_decision_id must be a decision on this item reversing this comment');
END;

-- import_map: append-only (decided here for Phase 1b: the map is which row a GitHub object became, and a re-run must
-- never re-point it). Re-running the import inserts the same mapping again: an identical row is skipped silently,
-- so `INSERT` stays idempotent; a different target for a mapped source is refused, and so is `INSERT OR REPLACE`
-- with one (REPLACE deletes the old row without firing a DELETE trigger, so it is stopped before it gets there).
-- The two WHEN clauses are disjoint, so the order SQLite fires them in does not matter.
CREATE TRIGGER import_map_same_again
BEFORE INSERT ON import_map
WHEN EXISTS (
  SELECT 1 FROM import_map
  WHERE project_slug = NEW.project_slug AND source_kind = NEW.source_kind AND source_id = NEW.source_id
    AND target_table = NEW.target_table AND target_id = NEW.target_id
)
BEGIN
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER import_map_never_replaced
BEFORE INSERT ON import_map
WHEN EXISTS (
  SELECT 1 FROM import_map
  WHERE project_slug = NEW.project_slug AND source_kind = NEW.source_kind AND source_id = NEW.source_id
    AND (target_table <> NEW.target_table OR target_id <> NEW.target_id)
)
BEGIN
  SELECT RAISE(ABORT, 'import_map rows are never re-pointed');
END;
CREATE TRIGGER import_map_append_only_update
BEFORE UPDATE ON import_map
BEGIN
  SELECT RAISE(ABORT, 'import_map rows are never re-pointed');
END;
CREATE TRIGGER import_map_append_only_delete
BEFORE DELETE ON import_map
BEGIN
  SELECT RAISE(ABORT, 'import_map rows are never re-pointed');
END;
