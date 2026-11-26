-- #824 (SECURITY review of #822): #795 judges a scope write against the runner's access declaration at write time,
-- and the runner re-declares on every claim poll. Another owner could add their project while the runner declared
-- `api_key` only; once it declared `subscription`, the entry stayed and the enroller's subscription served it.
--
-- So each runner records which of its `allowed_projects` entries an owner other than its enroller added. D3 applies to
-- those entries as it does to `all` (`runnerServesSql`): on a runner that can serve a subscription, in an account with
-- more than one owner, such an entry serves only a project the enroller created. The entry stays in the list, so the
-- owner's choice comes back the moment the runner declares `api_key` only again; the enroller adopts one by removing
-- and adding it. Kept by `RunnersRepo.setScope`, which stores `[]` under `all` (the scope is the one truth there).

ALTER TABLE runners ADD COLUMN non_enroller_projects TEXT NOT NULL DEFAULT '[]' CHECK (
  json_valid(non_enroller_projects) AND json_type(non_enroller_projects) = 'array'
  AND (project_scope = 'selected' OR non_enroller_projects = '[]')
);

-- The entries already there, from the audit trail: an entry whose latest addition (`runner.scope-changed` whose `to`
-- lists it and whose `from` does not) was written by another actor than the enroller. An entry with no such row came
-- with the enrolment, so it is the enroller's. This only narrows. Not derived, so left as they are: rows from before
-- `enrolled_by` (0036), whose writer counted as the enroller while the account had one owner; and an addition audited
-- as `access-owner` on a runner whose enroller is now the linked user's id (0042), which reads as another actor's and
-- so errs on the side of the narrower scope.
UPDATE runners SET non_enroller_projects = (
  SELECT json_group_array(entry.value) FROM json_each(runners.allowed_projects) entry
  WHERE (
    SELECT ae.actor FROM audit_events ae
    WHERE ae.account_id = runners.account_id AND ae.kind = 'runner.scope-changed' AND ae.target = runners.id
      AND json_valid(ae.details)
      AND entry.value IN (SELECT value FROM json_each(ae.details, '$.to.allowedProjects'))
      AND entry.value NOT IN (SELECT value FROM json_each(ae.details, '$.from.allowedProjects'))
    ORDER BY ae.id DESC LIMIT 1
  ) <> runners.enrolled_by
)
WHERE enrolled_by IS NOT NULL AND project_scope = 'selected' AND allowed_projects <> '[]';
