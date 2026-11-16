import { TEAM_CONFIG_BOUNDS, TEAM_CONFIG_PRESET_ROLES, TEAM_CONFIG_PRESETS, TEAM_ROLES } from '@shared/contracts';

/**
 * The claim's role admission (ADR 0009 d.6, d.7; threat model C12 row 5, T6): a WHERE term on the candidate `j`
 * (with `tc`, the project's `team_configs` row, LEFT JOINed). A role the document switched off is never claimed, and
 * a role holding its `max_parallel` live jobs on the project waits; a member the document leaves out comes from its
 * preset, bound as `?8`, and a role no preset knows from the bound's top, `?9`. Roles are matched by `json_each`
 * key, never spliced into a JSON path, so no stored role name can break the statement.
 */
export const ROLE_ADMITTED_SQL = `COALESCE(
    (SELECT json_extract(r.value, '$.enabled') FROM json_each(tc.config, '$.roles') r WHERE r.key = j.role), 1) = 1
  AND (SELECT COUNT(*) FROM jobs live
       WHERE live.project_slug = j.project_slug AND live.role = j.role AND live.state IN ('claimed', 'running'))
    < COALESCE(
        (SELECT json_extract(r.value, '$.max_parallel') FROM json_each(tc.config, '$.roles') r WHERE r.key = j.role),
        (SELECT r.value FROM json_each(?8) pr, json_each(pr.value) r
         WHERE pr.key = COALESCE(json_extract(tc.config, '$.preset'), 'recommended') AND r.key = j.role),
        ?9)`;

/** `{ preset: { role: max_parallel } }` from the shared presets: the data the claim falls back to. */
const PRESET_MAX_PARALLEL = JSON.stringify(
  Object.fromEntries(
    TEAM_CONFIG_PRESETS.map((preset) => [
      preset,
      Object.fromEntries(TEAM_ROLES.map((role) => [role, TEAM_CONFIG_PRESET_ROLES[preset][role].max_parallel])),
    ]),
  ),
);

/** The values of `?8` and `?9` in `ROLE_ADMITTED_SQL`. */
export function roleAdmissionParams(): readonly [string, number] {
  return [PRESET_MAX_PARALLEL, TEAM_CONFIG_BOUNDS.maxParallel.max];
}
