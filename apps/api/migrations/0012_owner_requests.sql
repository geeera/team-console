-- Owner requests to the PM (#219, ADR 0005 decision 3): the console's own record of each request comment it posted
-- on the owner's token, and the PM's handled marker once a trusted one names it. A rebuildable index of GitHub
-- comments, never a second source of truth: a row only colours a board row and prefills the form, it never drives a
-- GitHub write or an authorisation decision. The newest row per (slug, issue_number) is the issue's request.
CREATE TABLE owner_requests (
  comment_id         INTEGER PRIMARY KEY NOT NULL, -- GitHub's id of the request comment
  slug               TEXT NOT NULL,                -- the project (its repository is the registry's)
  issue_number       INTEGER NOT NULL,
  kind               TEXT NOT NULL,                -- 'sprint' | 'priority'
  payload            TEXT NOT NULL,                -- the marker's canonical JSON
  url                TEXT NOT NULL,                -- the comment's html_url
  requested_at       TEXT NOT NULL,                -- ISO 8601 UTC, GitHub's created_at of the comment
  handled_comment_id INTEGER,                      -- the PM's handled comment; NULL while pending
  result             TEXT,                         -- 'applied' | 'declined'; NULL while pending
  handled_at         TEXT                          -- ISO 8601 UTC, the handled comment's created_at
);
CREATE INDEX owner_requests_issue ON owner_requests (slug, issue_number, requested_at);
