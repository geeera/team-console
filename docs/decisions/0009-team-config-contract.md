# 0009 — Team configuration as a versioned contract per project

Status: proposed (owner request in the hub chat, 2026-11-16, recorded on #630 and approved there; the addendum of
the same day adds the access source and the cost presets. Everything below that is not marked as an owner decision
is a team decision under `reference/decision-policy.md`, reversible with `/reject why`). Date: 2026-11-16.
Amends [ADR 0006](0006-console-source-of-truth.md) decision 9 (`.product-team/project.yml` as the home of the
review policy and caps) and extends [ADR 0008](0008-multi-tenant-console.md) decisions 5 (audit), 7 (execution
modes and credentials), 9 (spend) and 12 (runner placement). Number 0007 is held by #386.

## Context

The team's setup is fixed in three places none of which the console owns:

- **Models** are pinned in the plugin's agent frontmatter (`agents/*.md`: `fullstack-dev-light` → Sonnet 5,
  `fullstack-dev` → Opus 5.5, `fullstack-dev-heavy` → Fable 5.1, `scribe` → Haiku 4.5) and, for the job roles the
  runner launches itself, in `apps/runner/src/claude/roles.ts` (`ROLE_MODELS`, overridable per runner through
  `config.roles.<role>.model`). A project cannot change them; a customer with two projects cannot run one cheaply.
- **Gate policy, caps and rhythm** live in the repository's `.product-team/project.yml`: `review.qa|reviewer:
  always|code|never`, `review.code_paths`, `review.max_rework_rounds`, `caps.<mode>.dev_tasks|parallel_devs`,
  `sprint.length_days|freeze_days`, `owner.language`. The plugin's `pr gate` reads the block from the PR's base
  branch (`ptlib/project.py` → `review_policy_from_text`), `backlog next` reads caps and freeze days from the
  working tree. Changing any of it is a commit; the console has no say and no history of who changed what.
- **Roles** cannot be switched off per project, and nothing says which roles must stay on.

The 2026-11-16 addendum adds what the owner considers decisive for customers: API-key-only execution is too
expensive, so a project must say whether it runs on a subscription (self-hosted only) or a BYOK key, and the model
spend must be steerable with presets, cost levers and hard limits. The numbers behind the presets come from #631.

What already exists and is **not** redesigned here: runner placement (`projects.runner_policy`, ADR 0008 decision
12), the runner's own pause on usage or rate limits (migration 0028, #571), the per-job `maxMinutes` on `jobs`
(0022) and the runner's kill at that limit, the per-job read budget (#537) and the sprint-read cap (#546),
`audit_events` (ADR 0008 decision 5) and the contract-fixture mechanism of #610 (`apps/api/fixtures/tracker/*`
replayed by `contract-fixtures.spec.ts`, vendored into the plugin behind `tests/contract/console.lock`).

## Decisions

| # | Decision | Why | Rejected |
| --- | -------- | --- | -------- |
| 1 | **One schema, `team-config/v1`, owned by `@shared/contracts`** (`lib/team-config.ts`): the TypeScript type, the guard `isTeamConfig` (unknown members, unknown roles and out-of-range values are refused with the failing path — never ignored), `resolveTeamConfig(stored \| null)` (preset + overrides → the effective view, pure and deterministic) and the presets. The console validates with it on write, the runner imports it (`scope:runner → shared` is allowed), the plugin replays the fixtures written from it. A `schema` member names the version; a document with another version is 422 `team-config-schema`. | One guard shared by three consumers is the only way "unknown fields refused" holds everywhere; the runner already imports `@shared/contracts` (`JobDto`). | A JSON Schema file validated by three validators (drift in three places); the plugin as the schema's owner (the console writes it, the plugin only reads). |
| 2 | **Fields** (full shape in "Schema"): `preset`, `access.source`, `roles.<role>` (`enabled`, `model`, `effort`, `max_parallel`, `max_minutes`, `max_turns`), `gates` (`qa`, `reviewer`, `code_paths`, `max_rework_rounds`), `caps.<normal\|burn\|freeze>` (`dev_tasks`, `parallel_devs`), `sprint` (`length_days`, `freeze_days`), `language`, `budget` (`monthly_usd`), `cost` (`prompt_caching`, `batch_api`, `reviewer_context`). Every value comes from an allow-list or a bounded integer. **Roles that are never off**: `orchestrator`, `pm`, `dev`, `qa`, `reviewer` (the guard refuses `enabled: false`); `security` cannot be configured at all — the security verdict is required whenever `pr security-check` says so, exactly as today. `gates.qa|reviewer` admit `always \| code` only: today's `never` is dropped (deviation from the 0.11 template, recorded, see "Migration"). Runner placement stays in `runner_policy` (one home, its own audit row); Settings › Team links to it. | What the owner asked for, bounded so a typo or an injected value cannot name an arbitrary model or a 10 000-minute job; the mandatory roles are what the gate (ADR 0006 decision 6) rests on. | Free-text model ids (a cost blow-up and a flag-injection surface); `security: never` (the gate would depend on a per-project switch); duplicating `runner_policy` into the contract. |
| 3 | **Access source per project: `subscription` or `api_key`.** `subscription` is admitted only where no hosted or Actions path can ever run the project: the console refuses (422 `access-source-hosted`) a `subscription` save while the project's effective `runner_policy` admits a `runners.hosted = 1` runner or while `projects.dispatch` (0031, #668) is `actions`, and refuses the reverse change to the policy or dispatch while the source is `subscription`; the claim statement additionally filters `access_source = 'api_key' OR runners.hosted = 0`. The **runner** compares the resolved `access.source` with its own `config.credential.kind` (`api-key` ↔ `api_key`; `setup-token` or `claude-config-dir` ↔ `subscription`) and refuses the launch on a mismatch (`LaunchRefusal('credential-source-mismatch')`, the kind name only). **The console never sees, stores, relays or infers the credential**: it learns an enum the owner typed, nothing from the runner. Settings shows the plain warning next to `subscription` from the addendum (ru reference copy). `api_key` on a hosted runner still needs H-1's `inference_keys`; until then `api_key` means the runner's own `api-key` file (ADR 0008 decision 7a). | ADR 0008 decisions 7 and 10: a subscription only on the customer's own host, never on ours; the two refusals make the invariant structural rather than a runbook line. | Detecting the source from the runner (the console would learn which credential exists — exactly what decision 7 forbids); one account-wide source (the owner's two projects may differ). |
| 4 | **Model presets `economy`, `recommended`, `max` fill `roles.<role>.model` and `effort`; a role may be overridden one at a time** (then `preset: custom` is derived, never stored as a preset). `recommended` is **exactly today's table** (`reference/schedule-and-models.md` + `ROLE_MODELS`), so a project with no stored config behaves as before. Allowed model ids are the four pinned ids of that table (`MODEL_ALLOW_LIST`, no aliases), with per-role bounds: `security` never Fable (plugin SPEC decision 13); `orchestrator`, `pm`, `qa`, `security` never Haiku; `scribe` is the only role that may run on Haiku. A preset's values are data in `@shared/contracts` and change by PR with a changelog line, so the plugin's lock and the runner catch the change. | The owner wants a cheap setting that still protects the roles the gate depends on; a preset is a diff in one file. | Presets as separate schema versions; per-account presets (per project is what the owner asked). |
| 5 | **Cost levers apply only under `api_key` and are enforced by the runner**: `prompt_caching` (keep the per-role prefix byte-stable — the fixed `promptOf` template, the read-only plugin root and managed settings already do this; the runner refuses a job-specific settings mutation while it is on and reports `cost.prompt_caching` in the job's `started` event), `reviewer_context: diff \| repo` (`review` jobs on `diff` get a clone with `--filter=blob:none --depth 1` of the base and head only; the plugin's reviewer reads `pr diff`, `pr files` and the item's criteria and never walks the tree), `batch_api` (accepted and stored in v1, **not applied yet**: the Claude Code CLI has no Batch mode, so the runner reports `cost.batch_api: not-applied` until a non-interactive path for `audit`, `digest` and regression `review` exists — its own issue). Under `subscription` the levers are shown greyed and ignored. | The addendum names these three; two can be enforced today, the third is a stored intention with an honest status rather than a silent no-op. | Dropping `batch_api` until it works (the owner would have to migrate the schema to add it); enforcing in the plugin only (a job could skip it). |
| 6 | **Hard limits.** `roles.<role>.max_minutes` becomes `jobs.max_minutes` at enqueue (the console; `Run now`'s own `maxMinutes` may only lower it) and is the runner's kill as today; `roles.<role>.max_turns` is passed as `--max-turns` by the runner; `roles.<role>.max_parallel` is a claim-time filter (count of this role's live jobs on the project). `budget.monthly_usd` is **the console's**: `project_spend` (`project_slug`, `month`, `spent_usd`, `jobs`) is reconciled at `finish` from `metrics.total_cost_usd` (the CLI's own figure, data from inside the sandbox — a floor, not a cap; the hard cap stays the customer's Anthropic workspace limit, ADR 0008 decision 9); when `spent_usd ≥ monthly_usd` the console pauses the project (`team_state.paused_by = 'system:budget'`, like `system:failure-streak`), refuses claims, and the Needs-you read model shows one «Бюджет исчерпан» row with the figures and a resume action; resume by the owner clears it for the month, raising the budget does too. `null` means no budget. Under `subscription` the figure is the CLI's estimate and the stop still applies if a budget is set. | The addendum's "stop with a Needs you item"; `team_state` already has the pause and the claim already honours it, so the budget stop is one more reason, not a new mechanism. | A reservation per job (ADR 0008 decision 9's `reserved_usd` — kept for hosted dispatch, where the console starts the machine; a self-hosted runner pulls, so there is nothing to reserve); killing the in-flight job at the cent (it loses the work; the next claim is the boundary). |
| 7 | **Revisions are append-only and a job carries the one it ran with.** `team_configs` holds the current document per project; every write inserts a `team_config_revisions` row (`revision` = previous + 1, the full document, the JSON-diff against the previous one, `created_by` user id, `reason`), both in the write's batch with the `audit_events` row `team-config.changed` (ids, the revision numbers and the changed paths only — never values, ADR 0008 decision 5). **A change applies at the next claim, never in flight**: `JobsRepo.claim` stamps `jobs.team_config_revision` with the current revision and the claim response carries the resolved view; a running job never re-reads it (the resolved-view route answers a job with the revision its token names). Enqueue reads `enabled` and `max_minutes` too, so a disabled role is never queued; a queued job whose role was disabled since is refused at claim with a `notice` and `cancelled`. | Traceability: a verdict or a dev job is explained by the config that produced it; "next job" is the only boundary a pull-based runner can honour without a kill. | Mutable single row (no "who changed what"); applying to in-flight jobs (a half-switched model mid-session is undefined behaviour). |
| 8 | **Storage: migration `0032_team_config.sql`** (0031 is #668's): `team_configs` (`project_slug PK → projects`, `revision INTEGER NOT NULL`, `config TEXT NOT NULL` with `json_valid` and `≤ 16 KB`, `updated_at`, `updated_by`), `team_config_revisions` (`id ULID PK`, `project_slug`, `revision`, `config`, `diff TEXT`, `reason TEXT NULL ≤ 500`, `created_at`, `created_by`, UNIQUE (`project_slug`, `revision`), append-only by triggers incl. `*_never_replaced`), `project_spend` (PK (`project_slug`, `month`), `spent_usd REAL ≥ 0`, `jobs INTEGER ≥ 0`), `jobs.team_config_revision INTEGER NULL`, `projects.access_source TEXT NOT NULL DEFAULT 'subscription' CHECK IN ('subscription','api_key')` (denormalised from the document for the claim `WHERE`, kept equal by the write batch), `team_state.paused_by` admits `system:budget` (already free text ≤ 255 — a CHECK is not added; the reason list lives in `@shared/contracts`). No row for a project means `recommended`. Repos `TeamConfigRepo` and `ProjectSpendRepo` in `@worker/db`. | SQLite's shape for "current + history" with the account rules of ADR 0008 (reached only through the project). | A column per field (every preset change is a migration); the document only in `revisions` with a `MAX()` read (slower claim). |
| 9 | **API** (route-scope rows in `route-scope.ts`, all `project`; the matrix decides the actor): `GET …/team-config` (owner and member: the stored document, `revision`, `preset`, the resolved view and an `ETag "<revision>"`), `PUT …/team-config` (**owner only**; body `{config, reason?}` with `If-Match: "<revision>"`, 412 `team-config-stale`, 422 `team-config-invalid` with `field`, 422 `access-source-hosted`; answers the new revision), `POST …/team-config/reset` (owner; `{preset}`), `POST …/team-config/import` (owner; builds a document from the default branch's `project.yml` through `@worker/vcs` `files.read` and answers it as a **draft** for `PUT` — never saves), `GET …/team-config/revisions[?after=&limit=]` and `GET …/team-config/revisions/:n` (owner and member), `GET …/team-config/resolved` (owner, member **and the project's job**: a matrix `READ` row in `JOB_READ_MODEL_ROUTES`; a job gets the view of `jobs.team_config_revision`, never the document, the budget, the revision history or `reason`). A job on every other route of the group is 403 `owner-only` from `jobScopeMiddleware`. The runner needs no route: the claim response gains `teamConfig: ResolvedTeamConfigDto` and `teamConfigRevision`. | Owner-only writes and a job that sees only its resolved view are the acceptance criteria of #630's security line; the inventory spec makes a forgotten row unreachable. | A job reading the document (it would learn the budget and who changed what); a separate runner route (one more call per claim). |
| 10 | **Contract fixtures as #610**: every route of decision 9 writes `apps/api/fixtures/team-config/*.json` (`get.recommended`, `put.changed`, `put.stale`, `put.invalid`, `put.access-source-hosted`, `reset.economy`, `import.draft`, `revisions.list`, `resolved.job`, `resolved.other-project`, `claim.with-config`), replayed by `routes/team-config/contract-fixtures.spec.ts`; the plugin's `fixtures` CI job diffs the directory at `tests/contract/console.lock`, the runner's `run-job.spec.ts` feeds `claim.with-config` to the launch. A preset or allow-list change is a fixture change, so all three consumers see it in one diff. | The mechanism exists and has caught drift once already; a second directory costs one import line. | A second lock for the runner (it lives in this repository and imports the type). |
| 11 | **`project.yml` becomes import-only for `review`, `caps`, `sprint` and `owner.language`** on a console-tracker project (amends ADR 0006 decision 9): the owner imports once from Settings › Team (`import` → review the draft → save), after which the plugin reads the resolved view and `project.yml`'s copies are documentation. `commands`, `environments`, `design`, `stack`, `decisions_dir`, `name`, `repo`, `mode`, `team.plugin_ref` stay in the repository: they describe the code, not the team. Agent frontmatter keeps its `model:` as the plugin's default for a run with no console (the `recommended` preset is generated from the same table and `roles.spec.ts` keeps them equal). | Decision 9 of ADR 0006 kept the review block in the repository so a PR could not relax its own gate; an owner-only, audited D1 row is a stronger guard — a PR cannot touch it at all. | Two-way sync (ADR 0006 rejected it for the tracker and the same reasons hold); keeping the gate in both places (which one wins is a question every bug would ask). |
| 12 | **The plugin reads the config from the console only inside a job** — when `TC_API_URL`, `TC_JOB_TOKEN` and `TC_PROJECT` are set (`ptlib/console.py` `config()`), `backlog next`, `pr gate` and `slot-context` call `GET …/team-config/resolved` once per run and act on it: caps and tiers (`tiers.effective` keeps its guard rails; a tier whose dev role is disabled folds to `dev`), `agent:<name>` issues of a disabled role are skipped with a reason line, the gate's `policy` comes from `gates`, `language` replaces `owner.language`. Without those variables (0.11 and 0.12 alike, GitHub-tracker projects, local runs) the plugin reads `project.yml` as today. **Nothing changes for the installed 0.11**: it never calls the route, the console serves `recommended` for a project with no row, and the import draft is built so that saving it leaves the plugin's behaviour identical. 0.12 warns once per run when `project.yml`'s imported keys differ from the resolved view («drift») and does not act on them. | One client, one grammar (ADR 0006 decision 9); the environment variables are already the only switch the plugin has, so no mode flag is added. | A `tracker:` key in `project.yml` deciding the source (a PR could flip it); the plugin refusing to run without the console (kills local and GitHub-tracker use). |

## Schema

```jsonc
{
  "schema": "team-config/v1",
  "preset": "recommended",                  // economy | recommended | max | custom (derived, see decision 4)
  "access": { "source": "subscription" },   // subscription | api_key
  "roles": {                                // every key of apps/api/src/auth/job-roles.ts JOB_ROLES; no other key
    "orchestrator": { "enabled": true, "model": "claude-opus-5-5", "effort": "high",
                      "max_parallel": 1, "max_minutes": 90, "max_turns": 400 },
    "dev-heavy":    { "enabled": true, "model": "claude-fable-5-1", "effort": "high",
                      "max_parallel": 1, "max_minutes": 120, "max_turns": 400 },
    "scribe":       { "enabled": true, "model": "claude-haiku-4-5-20251001", "effort": "low",
                      "max_parallel": 2, "max_minutes": 15, "max_turns": 40 }
    // … one entry per role; a missing role takes the preset's entry, an unknown role is refused
  },
  "gates": { "qa": "always", "reviewer": "code",
             "code_paths": ["apps/**", "libs/**", "tools/**"], "max_rework_rounds": 1 },
  "caps": { "normal": { "dev_tasks": 2, "parallel_devs": 2 },
            "burn":   { "dev_tasks": 5, "parallel_devs": 3 },
            "freeze": { "dev_tasks": 0, "parallel_devs": 1 } },
  "sprint": { "length_days": 14, "freeze_days": 2 },
  "language": "ru",                         // ru | en
  "budget": { "monthly_usd": null },        // null | 1..100000, whole dollars
  "cost": { "prompt_caching": true, "batch_api": false, "reviewer_context": "diff" }
}
```

Bounds (in the guard, one constant each): `effort ∈ low | medium | high`; `max_parallel 1..5`; `max_minutes
1..720` (= `JOB_MAX_MINUTES_MAX`); `max_turns 1..1000`; `code_paths` ≤ 20 globs ≤ 200 chars, no `..`;
`max_rework_rounds 0..3`; `dev_tasks 0..10`; `parallel_devs 1..5`; `length_days 7..28`; `freeze_days 0..7` and
`< length_days`; the document ≤ 16 KB. `MODEL_ALLOW_LIST` = `claude-fable-5-1`, `claude-opus-5-5`,
`claude-sonnet-5`, `claude-haiku-4-5-20251001`.

Presets (`effort` follows the model: Fable/Opus `high`, Sonnet `medium`, Haiku `low`; limits as `recommended`
unless #631 says otherwise):

| Role | economy | recommended (today) | max |
| ---- | ------- | ------------------- | --- |
| `architect`, `dev-heavy` | Opus 5.5 | Fable 5.1 | Fable 5.1 |
| `dev` | Sonnet 5 | Opus 5.5 | Fable 5.1 |
| `orchestrator`, `pm`, `qa`, `ux-designer`, `ui-designer` | Sonnet 5 | Opus 5.5 | Opus 5.5 |
| `security` | Sonnet 5 | Opus 5.5 | Opus 5.5 (never Fable) |
| `dev-light`, `reviewer`, `devops`, `analyst` | Sonnet 5 | Sonnet 5 | Opus 5.5 |
| `scribe` | Haiku 4.5 | Haiku 4.5 | Sonnet 5 |

`ResolvedTeamConfigDto` (what a job and the runner see): `revision`, `access.source`, `roles` (effective entries,
every role present), `gates`, `caps`, `sprint`, `language`, `cost` — **no** `budget`, `preset` or `reason`.

## Where each field is enforced

| Field | Console (api Worker) | Runner | Plugin (0.12, inside a job) |
| ----- | -------------------- | ------ | --------------------------- |
| `access.source` | save refusals and the claim filter (decision 3) | launch refusal on credential-kind mismatch | — |
| `roles.*.enabled` | no enqueue for a disabled role; claim cancels a stale queued one | — | skips `agent:<role>` issues; folds tiers |
| `roles.*.model`, `effort` | allow-list and per-role bounds on write | `--model`, effort in managed settings; the per-runner `config.roles` override is **removed** (the console is the one source) | `tiers.py` reports the model it got, pins nothing |
| `roles.*.max_parallel` | claim-time count per role and project | — | — |
| `roles.*.max_minutes` | `jobs.max_minutes` at enqueue (Run now may lower) | the kill, as today | — |
| `roles.*.max_turns` | bounds on write | `--max-turns` | — |
| `gates.*` | stored; the future `GET …/prs/:n/gate` (2-C) reads it | — | `pr gate` policy and `why` |
| `caps.*`, `sprint.*`, `language` | bounds; `GET …/sprint-freeze` answers from it when a row exists | — | `backlog next` caps and freeze, picker, inbox language |
| `budget.monthly_usd` | `project_spend` at `finish`, the `system:budget` pause, the Needs-you row | reports `total_cost_usd` in `finish.metrics` | — |
| `cost.*` | bounds | prefix stability, diff-only clone, `batch_api` status event | reviewer reads diff + criteria only |

## Migration

1. **Console**: 0032 adds the tables; no row is created. `resolveTeamConfig(null)` = `recommended` with
   `access.source = 'subscription'` (the owner's two projects run on his subscription, ADR 0008 decision 10; a
   customer account created after T-3 defaults to `api_key` through `entitlementsOf`, since a hosted path may
   exist for it — the default is a function of the account's plan, not a schema constant).
2. **Import** from Settings › Team: `POST …/team-config/import` reads `project.yml` on the default branch
   (`review`, `caps`, `sprint`, `owner.language`) and the agent frontmatter table (`recommended`), maps `qa|reviewer:
   never` to `code` with a note in the draft (the one lossy mapping), and the owner saves it as revision 1 with
   `reason: 'import'`. Repeatable until the first manual edit.
3. **Plugin 0.12**: `backlog next`, `pr gate`, `slot-context` read the resolved view inside a job; the agent
   frontmatter and `templates/project.yml` keep their values as the no-console default; `review.qa|reviewer: never`
   is deprecated in the template with a changelog line. 0.11 is untouched (decision 12).
4. **Runner**: `config.roles` is removed from `config.json` (a config carrying it is refused at start with the
   line that says why); `ROLE_MODELS` becomes the fallback for a claim without `teamConfig` (an older console),
   kept equal to `recommended` by `roles.spec.ts`.
5. **CLAUDE.md** gains: "team configuration is `team-config/v1` in D1 (ADR 0009); `project.yml`'s `review`,
   `caps`, `sprint`, `owner.language` are import-only on a console-tracker project; a preset or allow-list change
   is a fixture change under `apps/api/fixtures/team-config/`".

## Consequences

- The gate policy leaves the repository (ADR 0006 decision 9 amended); `pr gate` on a console-tracker project
  depends on the console being reachable, which a job already does for everything else.
- Three consumers share one guard and one fixture directory; a preset change is reviewed once and lands in the
  runner by release and in the plugin by lock bump.
- The runner's `config.roles` override disappears — a runner host cannot quietly upgrade a project's model.
- `budget.monthly_usd` is a floor from the CLI's own figure; the sentence in Settings says so and points at the
  Anthropic workspace limit (ADR 0008 decision 9).
- Settings › Team is a new page in `console-pages-settings` with `@console/features/team-config` (role list with
  toggles and model pickers, preset reset, access-source switch with its warning, revision history with diffs);
  UX spec is #630's third deliverable and goes through `ux-designer` before the UI PR.

## Not yet

- `batch_api` execution (decision 5); per-account defaults for the contract (per project is enough for two
  projects and the first customer); a `GET …/team-config/effective-cost` estimate (after #631's numbers); a
  per-role spend split in `project_spend`; schema `team-config/v2` (a renamed or removed field is a new version
  with `resolveTeamConfig` upgrading v1 documents on read, never a mutation of stored rows).
