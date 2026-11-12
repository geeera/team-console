-- Role keys are never deleted (#522, follow-up of #492). A key ends by revocation, which 0023 keeps final; a deleted
-- row would erase which key signed as which machine and role, and the revocation with it. `INSERT OR REPLACE` deletes
-- without firing this trigger (recursive triggers are off), which `role_keys_never_replaced` (0023) already refuses.
CREATE TRIGGER role_keys_never_deleted
BEFORE DELETE ON role_keys
BEGIN
  SELECT RAISE(ABORT, 'role keys are never deleted');
END;
