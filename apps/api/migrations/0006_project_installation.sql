-- #15, ADR 0003 decisions 5 and 6: the console app's installation on the project's repository, stored when the
-- registry validates the repository; #12 accepts a delivery only when its `installation.id` equals it.
-- Nullable: rows registered before the app existed have none until they are added again.
-- 0002–0005 are reserved for #11, #12, the PM chat and #59, so parallel PRs do not collide.
ALTER TABLE projects ADD COLUMN installation_id INTEGER;
