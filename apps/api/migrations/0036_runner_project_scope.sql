-- Runner project scope (#775, architect note on #634 section 8; threat model C4 row 1, C9, R-SCOPE-1…5). A runner
-- serves either every active project of its account, present and future (`all`), or the list in `allowed_projects`
-- (`selected`). The default here is `selected`: a migration never widens a security scope, so every runner enrolled
-- before this column keeps exactly the list it had; the owner flips a runner to `all` on Settings › Runners. New
-- enrolments default to `all` in the API (owner's wish, SECURITY question 6).
--
-- SQLite cannot add a table CHECK to an existing table; a column CHECK may name another column of the row and ADD
-- COLUMN tests it against the rows already there (all `selected`, so it holds). Under `all` the list is `[]`: the
-- scope is the one truth, never a list beside it (R-SCOPE-5).

ALTER TABLE runners ADD COLUMN project_scope TEXT NOT NULL DEFAULT 'selected' CHECK (
  project_scope IN ('all', 'selected') AND (project_scope = 'selected' OR allowed_projects = '[]')
);

-- Who enrolled the runner (the audit actor of the code's creator), for owner decision D3 (2026-11-17): in an account
-- with more than one owner, a runner signed in with a Claude subscription and scoped to `all` serves only projects
-- the enrolling owner created. NULL on rows from before this column and on identities the OIDC exchange creates.
ALTER TABLE runners ADD COLUMN enrolled_by TEXT CHECK (enrolled_by IS NULL OR length(enrolled_by) BETWEEN 1 AND 255);

-- A runner never changes who enrolled it: D3 would otherwise be rewritten after the fact.
CREATE TRIGGER runners_enrolled_by_kept
BEFORE UPDATE OF enrolled_by ON runners
WHEN OLD.enrolled_by IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'runners keep their identity');
END;

-- The same choice on a pending code: the owner decides the scope at code time, the enrol request cannot choose it.
-- Unused codes from before this column stay `selected` with their list.
ALTER TABLE runner_enrolments ADD COLUMN project_scope TEXT NOT NULL DEFAULT 'selected' CHECK (
  project_scope IN ('all', 'selected') AND (project_scope = 'selected' OR allowed_projects = '[]')
);

CREATE TRIGGER runner_enrolments_scope_kept
BEFORE UPDATE OF project_scope ON runner_enrolments
BEGIN
  SELECT RAISE(ABORT, 'an enrolment code is never rewritten');
END;

-- The audit actor that created the project (D3's other half). NULL on rows from before this column: under D3 such a
-- project is served by an `all` subscription runner only in a one-owner account, or by explicit selection.
ALTER TABLE projects ADD COLUMN created_by TEXT CHECK (created_by IS NULL OR length(created_by) BETWEEN 1 AND 255);
