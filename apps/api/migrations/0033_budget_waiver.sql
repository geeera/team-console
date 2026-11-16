-- The budget stop (#684, ADR 0009 d.6). `project_spend` (0032) is reconciled at `finish`; once a month's spend reaches
-- `budget.monthly_usd` the claim, the OIDC exchange and the Actions dispatch refuse the project's jobs and `finish`
-- pauses the team (`team_state.paused_by = 'system:budget'`). "Resume this month" lifts that pause and waives the
-- budget for the rest of the month: the waiver is the month's own, so the next month starts under the budget again.
ALTER TABLE project_spend ADD COLUMN waived_at TEXT CHECK (
  waived_at IS NULL
  OR (strftime('%Y-%m-%dT%H:%M:%S', waived_at) IS substr(waived_at, 1, 19) AND substr(waived_at, -1) = 'Z')
);
