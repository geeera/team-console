-- Pull requests as the console knows them (#463, ADR 0006 "Data model", ADR 0008 row 3a): a rebuildable mirror of the
-- VCS, filled by the hooks Worker from signed `pull_request` deliveries and by the api Worker on demand through the
-- VCS adapter. Never an input to an authorisation or a merge: the gate (#309 2-C/3b) re-reads the provider first.
-- Timestamps are ISO 8601 UTC from `toISOString`, so they compare as text.
CREATE TABLE pull_requests (
  id           INTEGER PRIMARY KEY,
  project_slug TEXT NOT NULL REFERENCES projects (slug),
  provider     TEXT NOT NULL DEFAULT 'github' CHECK (provider IN ('github', 'gitlab')),
  external_id  TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 64),     -- the provider's pull request id
  number       INTEGER NOT NULL CHECK (number >= 1),
  item_id      INTEGER,                                                          -- the tracker item, linked by 2-C
  title        TEXT NOT NULL CHECK (length(title) <= 1024),                      -- untrusted text, cleaned on read
  author_login TEXT CHECK (author_login IS NULL OR length(author_login) BETWEEN 1 AND 39),
  head_ref     TEXT NOT NULL CHECK (length(head_ref) BETWEEN 1 AND 255),
  head_sha     TEXT NOT NULL CHECK (length(head_sha) = 40 AND head_sha NOT GLOB '*[^0-9a-f]*'),
  base_ref     TEXT NOT NULL CHECK (length(base_ref) BETWEEN 1 AND 255),
  state        TEXT NOT NULL CHECK (state IN ('open', 'merged', 'closed')),
  draft        INTEGER NOT NULL DEFAULT 0 CHECK (draft IN (0, 1)),
  url          TEXT NOT NULL CHECK (url GLOB 'https://*' AND length(url) <= 512),
  -- CI of `head_sha` only: a new head resets it to 'unknown', and a finished run on it marks it stale until re-read.
  ci_state     TEXT NOT NULL DEFAULT 'unknown'
    CHECK (ci_state IN ('success', 'failure', 'pending', 'none', 'unknown')),
  ci_stale     INTEGER NOT NULL DEFAULT 1 CHECK (ci_stale IN (0, 1)),
  updated_at   TEXT NOT NULL,                                                    -- the provider's, orders deliveries
  synced_at    TEXT NOT NULL,                                                    -- when the console last wrote it
  UNIQUE (project_slug, number),
  FOREIGN KEY (item_id, project_slug) REFERENCES items (id, project_slug)
);
CREATE INDEX pull_requests_state ON pull_requests (project_slug, state, number);
CREATE INDEX pull_requests_head ON pull_requests (project_slug, head_sha);
