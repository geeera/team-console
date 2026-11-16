-- Team configuration as a versioned contract per project (ADR 0009 d.7 and d.8, #687). `team_configs` holds the
-- current document of a project (`team-config/v1`, validated by `checkTeamConfig` before it gets here), every write
-- appends one `team_config_revisions` row in the same batch, and `TeamConfigRepo` is the only writer of both and of
-- `projects.access_source`. No row for a project means `recommended` with `projects.access_source`. 0031 is #668's.

CREATE TABLE team_configs (
  project_slug TEXT PRIMARY KEY NOT NULL REFERENCES projects (slug),
  revision     INTEGER NOT NULL CHECK (revision >= 1),
  -- 16 KiB of UTF-8, counted in bytes (`length()` of text counts characters).
  config       TEXT NOT NULL CHECK (
    json_valid(config) AND json_type(config) = 'object' AND length(CAST(config AS BLOB)) <= 16384
  ),
  updated_at   TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', updated_at) IS substr(updated_at, 1, 19) AND substr(updated_at, -1) = 'Z'
  ),
  updated_by   TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 255)
);

-- The current row moves one revision at a time and starts at 1, so it never skips or rewinds the history.
CREATE TRIGGER team_configs_first_revision
BEFORE INSERT ON team_configs
WHEN NEW.revision <> 1
BEGIN
  SELECT RAISE(ABORT, 'a team configuration starts at revision 1');
END;
CREATE TRIGGER team_configs_next_revision
BEFORE UPDATE OF revision ON team_configs
WHEN NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'a team configuration moves one revision at a time');
END;
CREATE TRIGGER team_configs_project_kept
BEFORE UPDATE OF project_slug ON team_configs
BEGIN
  SELECT RAISE(ABORT, 'a team configuration keeps its project');
END;
-- `INSERT OR REPLACE` deletes the conflicting row without firing a DELETE trigger (recursive triggers are off) and
-- would rewind the current revision; refused before it does. The first write is a plain insert that never conflicts.
CREATE TRIGGER team_configs_never_replaced
BEFORE INSERT ON team_configs
WHEN EXISTS (SELECT 1 FROM team_configs WHERE project_slug = NEW.project_slug)
BEGIN
  SELECT RAISE(ABORT, 'a team configuration is never replaced');
END;

-- The history (ADR 0009 d.7): append-only, the full document and its diff against the previous revision, who wrote it
-- and why. Addressed by (project_slug, revision) only; the ULID never appears in a path or a lookup (threat model C12).
-- Deleted with its project by the same path as the project's other rows (T-6), never one by one.
CREATE TABLE team_config_revisions (
  id           TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26 AND id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_slug TEXT NOT NULL REFERENCES projects (slug),
  revision     INTEGER NOT NULL CHECK (revision >= 1),
  config       TEXT NOT NULL CHECK (
    json_valid(config) AND json_type(config) = 'object' AND length(CAST(config AS BLOB)) <= 16384
  ),
  diff         TEXT NOT NULL CHECK (json_valid(diff) AND json_type(diff) = 'array'),
  -- Redacted by the API before it gets here; 500 characters at most.
  reason       TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  created_at   TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', created_at) IS substr(created_at, 1, 19) AND substr(created_at, -1) = 'Z'
  ),
  created_by   TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 255),
  UNIQUE (project_slug, revision)
);
CREATE TRIGGER team_config_revisions_append_only_update
BEFORE UPDATE ON team_config_revisions
BEGIN
  SELECT RAISE(ABORT, 'team_config_revisions are append-only');
END;
CREATE TRIGGER team_config_revisions_append_only_delete
BEFORE DELETE ON team_config_revisions
BEGIN
  SELECT RAISE(ABORT, 'team_config_revisions are append-only');
END;
CREATE TRIGGER team_config_revisions_never_replaced
BEFORE INSERT ON team_config_revisions
WHEN EXISTS (
  SELECT 1 FROM team_config_revisions
  WHERE id = NEW.id OR (project_slug = NEW.project_slug AND revision = NEW.revision)
)
BEGIN
  SELECT RAISE(ABORT, 'team_config_revisions are append-only');
END;
-- A revision is the project's current one, written in the batch that moved it: `team_configs.revision` always equals
-- the highest revision, and no revision exists that the current row never held.
CREATE TRIGGER team_config_revisions_follow_current
BEFORE INSERT ON team_config_revisions
WHEN NEW.revision IS NOT (SELECT revision FROM team_configs WHERE project_slug = NEW.project_slug)
  OR NEW.config IS NOT (SELECT config FROM team_configs WHERE project_slug = NEW.project_slug)
BEGIN
  SELECT RAISE(ABORT, 'a revision is the current team configuration');
END;
CREATE INDEX team_config_revisions_project ON team_config_revisions (project_slug, revision);

-- The month's model spend per project (ADR 0009 d.6), reconciled at `finish` by #684 (PR 2). UTC month `YYYY-MM`.
CREATE TABLE project_spend (
  project_slug TEXT NOT NULL REFERENCES projects (slug),
  month        TEXT NOT NULL CHECK (length(month) = 7 AND month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  spent_usd    REAL NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  jobs         INTEGER NOT NULL DEFAULT 0 CHECK (jobs >= 0),
  PRIMARY KEY (project_slug, month)
);

-- The revision a job ran with, stamped by the claim (ADR 0009 d.7): a change applies to the next claim, never in flight.
ALTER TABLE jobs ADD COLUMN team_config_revision INTEGER CHECK (team_config_revision IS NULL OR team_config_revision >= 1);

-- Denormalised from the document for the claim's WHERE (ADR 0009 d.3, d.8) and kept equal by the write batch. Every
-- existing project runs on the owner's subscription on his own Mac (ADR 0008 decision 10).
ALTER TABLE projects ADD COLUMN access_source TEXT NOT NULL DEFAULT 'subscription'
  CHECK (access_source IN ('subscription', 'api_key'));
-- The column follows the document: it only ever takes the current revision's `access.source`, which is what
-- `TeamConfigRepo` writes in the same batch, right after `team_configs` (threat model C12 row 6).
CREATE TRIGGER projects_access_source_follows_config
BEFORE UPDATE OF access_source ON projects
WHEN NEW.access_source IS NOT OLD.access_source
  AND NEW.access_source IS NOT (
    SELECT json_extract(config, '$.access.source') FROM team_configs WHERE project_slug = NEW.slug
  )
BEGIN
  SELECT RAISE(ABORT, 'projects.access_source follows the team configuration');
END;

-- A subscription never reaches a GitHub Actions or a hosted machine (ADR 0009 d.3): no such job is ever queued for
-- a subscription project, whichever path enqueues it, and a job keeps its dispatch (`jobs_identity_kept`, 0022).
CREATE TRIGGER jobs_subscription_never_dispatched
BEFORE INSERT ON jobs
WHEN NEW.dispatch IN ('actions', 'hosted')
  AND (SELECT access_source FROM projects WHERE slug = NEW.project_slug) IS NOT 'api_key'
BEGIN
  SELECT RAISE(ABORT, 'access-source-hosted: a subscription project is never dispatched to Actions or a hosted runner');
END;
