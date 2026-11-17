-- The account's entitled concurrency (#746): the pull claim, the Actions dispatch and the OIDC exchange count the
-- account's claimed and running jobs, and its dispatched Actions jobs still queued, inside their own write. Without an
-- index on `account_id` that count reads every job the account ever had; this one narrows it to the account's rows in
-- the three live states.
CREATE INDEX jobs_account_live ON jobs (account_id, state);
