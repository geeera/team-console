-- The last judgement of a project's runner workflow file (#874): what "Needs you" reads to say an Actions project's
-- workflow drifted, in one D1 query and with no GitHub call. Written by the readiness check (`GET …/actions-setup`,
-- owner only) after every check, and by the dispatch when GitHub answers that the workflow is missing. Nothing of the
-- file is kept: a status word, the sha256 of the console's rendering it was judged against, and when.
--
-- The row can go stale: a customer's edit on GitHub shows up only at the next check or failed dispatch. A console
-- release is caught without one, because the reader compares the stored sha256 with this deploy's rendering.
-- Availability only, like the check itself: neither the exchange nor the dispatch reads these columns.

ALTER TABLE projects ADD COLUMN actions_workflow_status TEXT CHECK (
  actions_workflow_status IS NULL
  OR actions_workflow_status IN ('ok', 'missing', 'outdated', 'unsupported', 'modified', 'unknown')
);

-- NULL when the writer judged without a rendering (the dispatch's `missing`).
ALTER TABLE projects ADD COLUMN actions_workflow_sha256 TEXT CHECK (
  actions_workflow_sha256 IS NULL
  OR (length(actions_workflow_sha256) = 64 AND actions_workflow_sha256 NOT GLOB '*[^0-9a-f]*')
);

ALTER TABLE projects ADD COLUMN actions_workflow_checked_at TEXT CHECK (
  actions_workflow_checked_at IS NULL
  OR (
    strftime('%Y-%m-%dT%H:%M:%S', actions_workflow_checked_at) IS substr(actions_workflow_checked_at, 1, 19)
    AND substr(actions_workflow_checked_at, -1) = 'Z'
  )
);
