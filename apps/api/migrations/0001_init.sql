-- Project registry (ADR 0001, decision 20). A later migration takes the highest number on `dev` + 1 when its PR
-- opens and is renumbered on rebase if that number was taken (architect note on #12); 0002–0004 stay unused.
-- Timestamps are ISO 8601 UTC text; ids are GitHub's where they exist.
CREATE TABLE projects (
  slug         TEXT PRIMARY KEY,           -- ^[a-z0-9][a-z0-9-]{1,38}$
  repo         TEXT NOT NULL UNIQUE,       -- owner/name
  display_name TEXT NOT NULL,
  routine_id   TEXT,                       -- trig_… of the PM-chat routine (later)
  cache_epoch  INTEGER NOT NULL DEFAULT 0, -- bumped by hooks to invalidate read models (#9, #12)
  added_at     TEXT NOT NULL,
  archived_at  TEXT
);
