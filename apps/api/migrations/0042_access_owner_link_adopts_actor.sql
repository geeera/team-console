-- #838: before the Access–GitHub link the Access owner acts as the shared audit name `access-owner`, so that is what
-- `runners.enrolled_by` and `projects.created_by` hold for what they made. After the link they act as their user id,
-- and D3 (`runnerServesSql`, `scopeWriteAllowedSql`) compares those columns with each other and with the caller: the
-- owner's own runners would stop serving their own projects, for good, since 0036 keeps an enroller once written.
--
-- So the link hands the owner's `access-owner` rows to the linked user, in the link's own statement (any writer of
-- `users.access_subject` — the T-3 link, or a hand-run UPDATE — gets it), audited once. Only while exactly one user is
-- linked: the Access door admits `OWNER_EMAIL` alone, so that user is the Access owner; with two, nobody can tell
-- which, and the rows stay as they are rather than go to the wrong person. Only in the owner's account, the one
-- account the Access door reaches (`ACCESS_OWNER_MEMBERSHIPS`).
--
-- Left alone on purpose: `audit_events.actor` (history, append-only), and a pending code or intent whose
-- `created_by` is `access-owner` (0021/0037 keep them; a code becomes a runner below, an intent is re-made).

-- The 0036 rule with one exception: `access-owner` may become the one linked user's id. Every other change of a
-- recorded enroller is still refused.
DROP TRIGGER runners_enrolled_by_kept;
CREATE TRIGGER runners_enrolled_by_kept
BEFORE UPDATE OF enrolled_by ON runners
WHEN OLD.enrolled_by IS NOT NULL
  AND NOT (
    OLD.enrolled_by = 'access-owner'
    AND OLD.account_id = '01M6YSNJ000000000000000001'
    AND (SELECT COUNT(*) FROM users WHERE access_subject IS NOT NULL) = 1
    AND NEW.enrolled_by IS (SELECT id FROM users WHERE access_subject IS NOT NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'runners keep their identity');
END;

-- The link, by UPDATE (a user row that signed in with GitHub first) or by INSERT (a row made already linked).
CREATE TRIGGER users_access_link_adopts_owner_actor
AFTER UPDATE OF access_subject ON users
WHEN OLD.access_subject IS NULL AND NEW.access_subject IS NOT NULL
  AND (SELECT COUNT(*) FROM users WHERE access_subject IS NOT NULL) = 1
BEGIN
  INSERT INTO audit_events (account_id, at, actor_kind, actor, kind, target, details)
  SELECT '01M6YSNJ000000000000000001', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system', 'access-link',
         'auth.access-actor-adopted', NEW.id,
         json_object(
           'runners', (SELECT COUNT(*) FROM runners WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner'),
           'projects', (SELECT COUNT(*) FROM projects WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner'))
  WHERE EXISTS (SELECT 1 FROM runners WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner')
     OR EXISTS (SELECT 1 FROM projects WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner');
  UPDATE runners SET enrolled_by = NEW.id WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner';
  UPDATE projects SET created_by = NEW.id WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner';
END;

CREATE TRIGGER users_access_insert_adopts_owner_actor
AFTER INSERT ON users
WHEN NEW.access_subject IS NOT NULL
  AND (SELECT COUNT(*) FROM users WHERE access_subject IS NOT NULL) = 1
BEGIN
  INSERT INTO audit_events (account_id, at, actor_kind, actor, kind, target, details)
  SELECT '01M6YSNJ000000000000000001', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system', 'access-link',
         'auth.access-actor-adopted', NEW.id,
         json_object(
           'runners', (SELECT COUNT(*) FROM runners WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner'),
           'projects', (SELECT COUNT(*) FROM projects WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner'))
  WHERE EXISTS (SELECT 1 FROM runners WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner')
     OR EXISTS (SELECT 1 FROM projects WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner');
  UPDATE runners SET enrolled_by = NEW.id WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner';
  UPDATE projects SET created_by = NEW.id WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner';
END;

-- A runner enrolled after the link from a code the owner made before it: the code says `access-owner`, the runner
-- gets the linked user, as the rows above did.
CREATE TRIGGER runners_access_owner_adopted
AFTER INSERT ON runners
WHEN NEW.enrolled_by = 'access-owner'
  AND NEW.account_id = '01M6YSNJ000000000000000001'
  AND (SELECT COUNT(*) FROM users WHERE access_subject IS NOT NULL) = 1
BEGIN
  UPDATE runners SET enrolled_by = (SELECT id FROM users WHERE access_subject IS NOT NULL) WHERE id = NEW.id;
END;

-- A link made before this migration (a hand-run UPDATE): the same hand-over, once.
INSERT INTO audit_events (account_id, at, actor_kind, actor, kind, target, details)
SELECT '01M6YSNJ000000000000000001', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system', 'access-link',
       'auth.access-actor-adopted', (SELECT id FROM users WHERE access_subject IS NOT NULL),
       json_object(
         'runners', (SELECT COUNT(*) FROM runners WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner'),
         'projects', (SELECT COUNT(*) FROM projects WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner'))
WHERE (SELECT COUNT(*) FROM users WHERE access_subject IS NOT NULL) = 1
  AND (EXISTS (SELECT 1 FROM runners WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner')
    OR EXISTS (SELECT 1 FROM projects WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner'));
UPDATE runners SET enrolled_by = (SELECT id FROM users WHERE access_subject IS NOT NULL)
WHERE account_id = '01M6YSNJ000000000000000001' AND enrolled_by = 'access-owner'
  AND (SELECT COUNT(*) FROM users WHERE access_subject IS NOT NULL) = 1;
UPDATE projects SET created_by = (SELECT id FROM users WHERE access_subject IS NOT NULL)
WHERE account_id = '01M6YSNJ000000000000000001' AND created_by = 'access-owner'
  AND (SELECT COUNT(*) FROM users WHERE access_subject IS NOT NULL) = 1;
