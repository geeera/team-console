-- #799 (QA on #790): 0036 left `projects.created_by` and `runners.enrolled_by` NULL on the rows from before it, so in
-- an account with more than one owner D3 (`runnerServesSql`) lets a subscription runner serve none of those projects,
-- and nobody can widen a runner with no enroller (#795, #827). This fills both columns where the owner is known, and
-- only there; what stays NULL is shown on the runner card (`RunnerDto.unattributedProjects`).
--
-- The value is what the code writes since 0036: the audit actor of the owner who made the row, an owner of its account
-- (D3 compares owners), as a user id — or `access-owner`, the Access owner before the GitHub link, which 0042/0044
-- hand to the linked user when the link is written. Two bases, the audit first:
--
-- 1. `audit` — the row's own audit names it: the latest `project.created` of the slug (the creating user is the
--    actor), or the runner's `runner.enrolled` (the code's creator in `details.createdBy`, since #467; the enrolment
--    door wrote `enrolled_by` from the same value). The named actor counts only while they are still an owner of the
--    account; `access-owner` only in the owner account, as itself while nobody is linked, as the one linked user while
--    that user is an owner, and not at all with two linked users (0042: nobody can tell which). An audit row that names
--    anyone else (a former owner, a member, the local bypass) leaves the row NULL: the evidence says it is not the
--    present owner's, so the next rule never overrides it.
-- 2. `sole-owner` — no such audit row, and the account has exactly one owner: theirs, as #827's claim would record.
--
-- Everything else stays NULL: a multi-owner account with no audit row is never given its "first" owner. Runners only
-- where #827 would let an owner claim them (self-hosted, not GitHub Actions, unrevoked); a hosted or OIDC identity has
-- no enroller by design. Every statement touches NULL rows only, so a second run changes nothing.

DROP VIEW IF EXISTS attribution_backfill_0048;

CREATE VIEW attribution_backfill_0048 AS
SELECT src.row_kind, src.row_id, src.account_id,
  CASE
    WHEN src.named IS NOT NULL THEN
      CASE
        WHEN src.named = 'access-owner' THEN
          CASE
            WHEN src.account_id <> '01M6YSNJ000000000000000001' THEN NULL
            WHEN (SELECT COUNT(*) FROM users WHERE access_subject IS NOT NULL) = 0 THEN 'access-owner'
            WHEN (SELECT COUNT(*) FROM users WHERE access_subject IS NOT NULL) = 1 THEN (
              SELECT u.id FROM users u
              JOIN account_members m ON m.user_id = u.id AND m.account_id = src.account_id AND m.role = 'owner'
              WHERE u.access_subject IS NOT NULL)
            ELSE NULL
          END
        ELSE (SELECT m.user_id FROM account_members m WHERE m.account_id = src.account_id AND m.user_id = src.named AND m.role = 'owner')
      END
    WHEN (SELECT COUNT(*) FROM account_members m WHERE m.account_id = src.account_id AND m.role = 'owner') = 1 THEN
      (SELECT m.user_id FROM account_members m WHERE m.account_id = src.account_id AND m.role = 'owner')
    ELSE NULL
  END AS attributed_to,
  CASE WHEN src.named IS NOT NULL THEN 'audit' ELSE 'sole-owner' END AS basis
FROM (
  SELECT 'project' AS row_kind, p.slug AS row_id, p.account_id AS account_id, (
    SELECT ae.actor FROM audit_events ae
    WHERE ae.account_id = p.account_id AND ae.kind = 'project.created' AND ae.target = p.slug AND ae.actor_kind = 'user'
    ORDER BY ae.id DESC LIMIT 1
  ) AS named
  FROM projects p
  WHERE p.created_by IS NULL
  UNION ALL
  SELECT 'runner', r.id, r.account_id, (
    SELECT json_extract(ae.details, '$.createdBy') FROM audit_events ae
    WHERE ae.account_id = r.account_id AND ae.kind = 'runner.enrolled' AND ae.target = r.id
      AND json_valid(ae.details) AND json_type(ae.details, '$.createdBy') = 'text'
    ORDER BY ae.id DESC LIMIT 1
  )
  FROM runners r
  WHERE r.enrolled_by IS NULL AND r.hosted = 0 AND r.isolation <> 'actions-ephemeral' AND r.revoked_at IS NULL
) src;

-- One audit row per account that gains anything, in the counts of each basis (ids and enums only, as `AuditRepo`).
INSERT INTO audit_events (account_id, at, actor_kind, actor, kind, target, details)
SELECT account_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system', 'migration', 'account.attribution-backfilled', account_id,
  json_object(
    'projectsByAudit', SUM(row_kind = 'project' AND basis = 'audit'),
    'projectsBySoleOwner', SUM(row_kind = 'project' AND basis = 'sole-owner'),
    'runnersByAudit', SUM(row_kind = 'runner' AND basis = 'audit'),
    'runnersBySoleOwner', SUM(row_kind = 'runner' AND basis = 'sole-owner'))
FROM attribution_backfill_0048
WHERE attributed_to IS NOT NULL
GROUP BY account_id
ORDER BY account_id;

-- 0046's column for the runners that gain an enroller here, before they do: an entry whose latest addition another
-- actor than the enroller wrote is not the enroller's, so D3 judges it. Before 0036 a scope write was audited
-- `runner.updated` (`allowedProjects` after, `before`); after it, `runner.scope-changed` (`to`/`from`). An entry with
-- no such row came with the enrolment. This only narrows what the runner serves.
UPDATE runners SET non_enroller_projects = (
  SELECT json_group_array(entry.value) FROM json_each(runners.allowed_projects) entry
  WHERE (
    SELECT ae.actor FROM audit_events ae
    WHERE ae.account_id = runners.account_id AND ae.target = runners.id AND json_valid(ae.details)
      AND (
        (ae.kind = 'runner.scope-changed'
          AND entry.value IN (SELECT value FROM json_each(ae.details, '$.to.allowedProjects'))
          AND entry.value NOT IN (SELECT value FROM json_each(ae.details, '$.from.allowedProjects')))
        OR (ae.kind = 'runner.updated'
          AND entry.value IN (SELECT value FROM json_each(ae.details, '$.allowedProjects'))
          AND entry.value NOT IN (SELECT value FROM json_each(ae.details, '$.before'))))
    ORDER BY ae.id DESC LIMIT 1
  ) <> (SELECT v.attributed_to FROM attribution_backfill_0048 v WHERE v.row_kind = 'runner' AND v.row_id = runners.id)
)
WHERE enrolled_by IS NULL AND project_scope = 'selected' AND allowed_projects <> '[]'
  AND id IN (SELECT row_id FROM attribution_backfill_0048 WHERE row_kind = 'runner' AND attributed_to IS NOT NULL);

UPDATE runners SET enrolled_by = (
  SELECT v.attributed_to FROM attribution_backfill_0048 v WHERE v.row_kind = 'runner' AND v.row_id = runners.id
)
WHERE enrolled_by IS NULL
  AND id IN (SELECT row_id FROM attribution_backfill_0048 WHERE row_kind = 'runner' AND attributed_to IS NOT NULL);

UPDATE projects SET created_by = (
  SELECT v.attributed_to FROM attribution_backfill_0048 v WHERE v.row_kind = 'project' AND v.row_id = projects.slug
)
WHERE created_by IS NULL
  AND slug IN (SELECT row_id FROM attribution_backfill_0048 WHERE row_kind = 'project' AND attributed_to IS NOT NULL);

DROP VIEW attribution_backfill_0048;
