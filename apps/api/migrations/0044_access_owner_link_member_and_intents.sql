-- #899, round 2 of #838 (0042). Two gaps in the hand-over the Access–GitHub link makes:
--
-- 1. 0042 handed the owner account's `access-owner` rows to the one linked user without asking whether that user
--    belongs to the account. Only the Access owner can be linked today, but the rule lived outside the database. Now
--    the linked user must hold a membership of the owner account, in every place 0042 judged the hand-over: the two
--    link triggers, the runner enrolled later from an old code, and the exception to the 0036 enroller rule. A link
--    written before the membership (a user row inserted already linked cannot have one yet) hands over when the
--    membership is written, so the order of the two writes does not matter.
--
-- 2. An enrolment intent the owner made as `access-owner` and had not finished was left live but unreachable: the
--    intent routes match `created_by` with the caller's actor, which is the user id after the link, so the owner could
--    neither approve nor withdraw it and the runner kept polling it. `created_by` is never rewritten (0037, R-INT-6),
--    so the intent is not moved to the user: the hand-over withdraws it instead, and the owner makes a new one. An
--    approved intent is left alone: its runner exists and is handed over with the rest.
--
-- The audit row `auth.access-actor-adopted` gains `intents`, the number withdrawn. No backfill: an intent lives ten
-- minutes, and rows 0042 already moved cannot be told from rows the user made.

DROP TRIGGER runners_enrolled_by_kept;
CREATE TRIGGER runners_enrolled_by_kept
BEFORE UPDATE OF enrolled_by ON runners
WHEN OLD.enrolled_by IS NOT NULL
  AND NOT (
    OLD.enrolled_by = 'access-owner'
    AND OLD.account_id = '01M6YSNJ000000000000000001'
    AND (SELECT COUNT(*) FROM users WHERE access_subject IS NOT NULL) = 1
    AND NEW.enrolled_by IS (SELECT id FROM users WHERE access_subject IS NOT NULL)
    AND EXISTS (SELECT 1 FROM account_members WHERE account_id = '01M6YSNJ000000000000000001' AND user_id = NEW.enrolled_by)
  )
BEGIN
  SELECT RAISE(ABORT, 'runners keep their identity');
END;

DROP TRIGGER users_access_link_adopts_owner_actor;
CREATE TRIGGER users_access_link_adopts_owner_actor
AFTER UPDATE OF access_subject ON users
WHEN OLD.access_subject IS NULL AND NEW.access_subject IS NOT NULL
  AND (SELECT COUNT(*) FROM users WHERE access_subject IS NOT NULL) = 1
  AND EXISTS (SELECT 1 FROM account_members WHERE account_id = '01M6YSNJ000000000000000001' AND user_id = NEW.id)
BEGIN
  INSERT INTO audit_events (account_id, at, actor_kind, actor, kind, target, details)
  SELECT '01M6YSNJ000000000000000001', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system', 'access-link',
         'auth.access-actor-adopted', NEW.id,
         json_object(
           'runners', (SELECT COUNT(*) FROM runners WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner'),
           'projects', (SELECT COUNT(*) FROM projects WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner'),
           'intents', (SELECT COUNT(*) FROM runner_enrolment_requests WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner' AND state IN ('pending', 'bound') AND julianday(expires_at) > julianday('now')))
  WHERE EXISTS (SELECT 1 FROM runners WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner')
     OR EXISTS (SELECT 1 FROM projects WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner')
     OR EXISTS (SELECT 1 FROM runner_enrolment_requests WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner' AND state IN ('pending', 'bound') AND julianday(expires_at) > julianday('now'));
  UPDATE runners SET enrolled_by = NEW.id WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner';
  UPDATE projects SET created_by = NEW.id WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner';
  UPDATE runner_enrolment_requests SET state = 'withdrawn', withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner' AND state IN ('pending', 'bound') AND julianday(expires_at) > julianday('now');
END;

DROP TRIGGER users_access_insert_adopts_owner_actor;
CREATE TRIGGER users_access_insert_adopts_owner_actor
AFTER INSERT ON users
WHEN NEW.access_subject IS NOT NULL
  AND (SELECT COUNT(*) FROM users WHERE access_subject IS NOT NULL) = 1
  AND EXISTS (SELECT 1 FROM account_members WHERE account_id = '01M6YSNJ000000000000000001' AND user_id = NEW.id)
BEGIN
  INSERT INTO audit_events (account_id, at, actor_kind, actor, kind, target, details)
  SELECT '01M6YSNJ000000000000000001', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system', 'access-link',
         'auth.access-actor-adopted', NEW.id,
         json_object(
           'runners', (SELECT COUNT(*) FROM runners WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner'),
           'projects', (SELECT COUNT(*) FROM projects WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner'),
           'intents', (SELECT COUNT(*) FROM runner_enrolment_requests WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner' AND state IN ('pending', 'bound') AND julianday(expires_at) > julianday('now')))
  WHERE EXISTS (SELECT 1 FROM runners WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner')
     OR EXISTS (SELECT 1 FROM projects WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner')
     OR EXISTS (SELECT 1 FROM runner_enrolment_requests WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner' AND state IN ('pending', 'bound') AND julianday(expires_at) > julianday('now'));
  UPDATE runners SET enrolled_by = NEW.id WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner';
  UPDATE projects SET created_by = NEW.id WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner';
  UPDATE runner_enrolment_requests SET state = 'withdrawn', withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner' AND state IN ('pending', 'bound') AND julianday(expires_at) > julianday('now');
END;

-- The membership written after the link: the same hand-over, to the same one linked user.
CREATE TRIGGER account_members_insert_adopts_owner_actor
AFTER INSERT ON account_members
WHEN NEW.account_id = '01M6YSNJ000000000000000001'
  AND (SELECT COUNT(*) FROM users WHERE access_subject IS NOT NULL) = 1
  AND NEW.user_id IS (SELECT id FROM users WHERE access_subject IS NOT NULL)
BEGIN
  INSERT INTO audit_events (account_id, at, actor_kind, actor, kind, target, details)
  SELECT '01M6YSNJ000000000000000001', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system', 'access-link',
         'auth.access-actor-adopted', NEW.user_id,
         json_object(
           'runners', (SELECT COUNT(*) FROM runners WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner'),
           'projects', (SELECT COUNT(*) FROM projects WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner'),
           'intents', (SELECT COUNT(*) FROM runner_enrolment_requests WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner' AND state IN ('pending', 'bound') AND julianday(expires_at) > julianday('now')))
  WHERE EXISTS (SELECT 1 FROM runners WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner')
     OR EXISTS (SELECT 1 FROM projects WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner')
     OR EXISTS (SELECT 1 FROM runner_enrolment_requests WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner' AND state IN ('pending', 'bound') AND julianday(expires_at) > julianday('now'));
  UPDATE runners SET enrolled_by = NEW.user_id WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner';
  UPDATE projects SET created_by = NEW.user_id WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner';
  UPDATE runner_enrolment_requests SET state = 'withdrawn', withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner' AND state IN ('pending', 'bound') AND julianday(expires_at) > julianday('now');
END;

DROP TRIGGER runners_access_owner_adopted;
CREATE TRIGGER runners_access_owner_adopted
AFTER INSERT ON runners
WHEN NEW.enrolled_by = 'access-owner'
  AND NEW.account_id = '01M6YSNJ000000000000000001'
  AND (SELECT COUNT(*) FROM users WHERE access_subject IS NOT NULL) = 1
  AND EXISTS (SELECT 1 FROM account_members WHERE account_id = '01M6YSNJ000000000000000001' AND user_id = (SELECT id FROM users WHERE access_subject IS NOT NULL))
BEGIN
  UPDATE runners SET enrolled_by = (SELECT id FROM users WHERE access_subject IS NOT NULL) WHERE id = NEW.id;
END;
