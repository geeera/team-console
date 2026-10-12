-- Snoozed notifications per project (#221, architect note on #29 §5). The hooks Worker drops a snoozed project's
-- push unless it is urgent and urgent ones are allowed. `snoozed_until` NULL while `snoozed_at` is set means
-- "until turned back on". An expired snooze needs no cleanup: every reader compares `snoozed_until` with its clock.
ALTER TABLE projects ADD COLUMN snoozed_at TEXT;                                  -- ISO 8601 UTC; NULL = not snoozed
ALTER TABLE projects ADD COLUMN snoozed_until TEXT;                               -- ISO 8601 UTC
ALTER TABLE projects ADD COLUMN snooze_allows_urgent INTEGER NOT NULL DEFAULT 1;  -- 1 = urgent pushes still arrive
