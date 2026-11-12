-- Role key guards (#492, ADR 0006 "Role keys and the gate"; threat model C4) ahead of 2-C, which registers role
-- keys through `POST /runner/keys`. A role key gets the same guarantees as its runner's key: it never changes, its
-- revocation is final, an INSERT cannot replace a row, and revoking a runner revokes its role keys with it.

-- A role key never changes runner, role, key or creation time: a re-keyed row would sign as another machine or role.
CREATE TRIGGER role_keys_identity_kept
BEFORE UPDATE OF id, runner_id, role, public_key_jwk, created_at ON role_keys
BEGIN
  SELECT RAISE(ABORT, 'role keys keep their identity');
END;

CREATE TRIGGER role_keys_revoked_once
BEFORE UPDATE OF revoked_at ON role_keys
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  SELECT RAISE(ABORT, 'a revoked role key stays revoked');
END;

-- `INSERT OR REPLACE` would delete the row it conflicts with (on the id, or on the live key of that runner and role
-- under `role_keys_live`) without firing a delete trigger. Both conflicts are refused here, before that happens.
CREATE TRIGGER role_keys_never_replaced
BEFORE INSERT ON role_keys
WHEN EXISTS (SELECT 1 FROM role_keys WHERE id = NEW.id)
  OR (NEW.revoked_at IS NULL AND EXISTS (
    SELECT 1 FROM role_keys WHERE runner_id = NEW.runner_id AND role = NEW.role AND revoked_at IS NULL
  ))
BEGIN
  SELECT RAISE(ABORT, 'role keys are never replaced');
END;

-- A revoked runner gets no new live key. Otherwise a key registered after revocation would outlive it.
CREATE TRIGGER role_keys_runner_live
BEFORE INSERT ON role_keys
WHEN NEW.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM runners WHERE id = NEW.runner_id AND revoked_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'a role key needs a live runner');
END;

-- Revoking a runner revokes its live role keys at the same time, whichever statement revoked it.
CREATE TRIGGER runners_revoke_role_keys
AFTER UPDATE OF revoked_at ON runners
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  UPDATE role_keys SET revoked_at = NEW.revoked_at WHERE runner_id = NEW.id AND revoked_at IS NULL;
END;
