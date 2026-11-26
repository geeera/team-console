-- #821 (security review of #807): an enrolment intent holds the binder's hostname, `bound_country`, key and
-- fingerprint, so it must not outlive what it belongs to. The retention sweep (`EnrolmentIntentsRepo.deleteRetired`,
-- the api Worker's Cron) removes rows a day past every use; these triggers remove them with their account (T-6).
--
-- Triggers, not `ON DELETE CASCADE`: SQLite cannot alter a foreign key, and rebuilding 0037's table would mean
-- recreating its guards and every 0044 trigger that names it. Deleting the children first inside the parent's own
-- DELETE is the same effect, and it is undone with that DELETE when another guard refuses it
-- (`accounts_kept_with_projects`). The audit keeps the history of every intent; nothing references these rows.

-- An account's intents go with it.
CREATE TRIGGER accounts_delete_enrolment_requests
BEFORE DELETE ON accounts
BEGIN
  DELETE FROM runner_enrolment_requests WHERE account_id = OLD.id;
END;

-- An approved intent names its runner (`runner_id`), so a runner deleted before its account (T-6 order: an account
-- with runners cannot go first) takes the intent that made it, which has nothing left to hand over.
CREATE TRIGGER runners_delete_enrolment_requests
BEFORE DELETE ON runners
BEGIN
  DELETE FROM runner_enrolment_requests WHERE runner_id = OLD.id;
END;
