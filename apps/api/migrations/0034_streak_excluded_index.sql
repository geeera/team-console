-- The exclusion-budget counts of #701/#705 (follow-up from their review, #726): on every finish that claims a
-- limit, `recordOutcome` counts the account's `job.streak-excluded` rows of the last hour twice (per runner and
-- per project), both against `audit_events_account (account_id, id)`, so their cost grows with the account's whole
-- audit log. A partial index of the rows that matter to both counts, narrowed to `account_id` and the window's
-- `at` bound; `actor`/`details.slug` stay residual filters over the few rows the index already narrowed to.
CREATE INDEX audit_events_streak_excluded ON audit_events (account_id, at) WHERE kind = 'job.streak-excluded';
