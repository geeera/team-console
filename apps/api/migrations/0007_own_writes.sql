-- Comments the console wrote with the owner's token (#10; ADR 0001 decisions 5, 10 and 19). The api Worker
-- records each owner write right after GitHub accepted it: #12's hooks Worker drops the delivery of such a comment
-- (the owner's own answer is never pushed back to the owner), and the answer route answers a repeat of the same
-- body within 60 s from `body_hash` instead of posting it twice. #10 merged before #12, so the table lives here and
-- #12's reserved 0003_webhooks keeps only its own tables.
CREATE TABLE own_writes (
  comment_id   INTEGER PRIMARY KEY NOT NULL, -- GitHub's comment id
  repo         TEXT NOT NULL,                -- owner/name as registered
  issue_number INTEGER NOT NULL,
  kind         TEXT NOT NULL,                -- 'answer' | 'chat'
  body_hash    TEXT,                         -- SHA-256 hex of repo, issue and body; NULL where no replay is needed
  url          TEXT NOT NULL,                -- the comment's html_url, answered again on a replay
  created_at   TEXT NOT NULL                 -- ISO 8601 UTC, like 0001
);
CREATE INDEX own_writes_recent ON own_writes (repo, issue_number, created_at);

-- An owner write in flight, taken before the POST so that two taps arriving together post once. Released once the
-- write is recorded or was refused before GitHub could write; after a timeout or a 5xx GitHub may have written it,
-- so the claim holds until `expires_at` and a retry inside that window cannot post a second copy.
CREATE TABLE own_write_claims (
  body_hash  TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL                -- epoch milliseconds
);
