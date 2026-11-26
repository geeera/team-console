# 0010 — Console-driven orchestration

Status: accepted (owner decisions recorded 2026-11-26 on #1039: `ORCHESTRATE_MAX_STEPS = 20`, not the 40 the
architect note asked about, because every step is an orchestrator-model turn on the owner's own subscription;
Stop is a **hard cancel** — a graceful "finish the current job, start nothing new" mode is slice 2; and the owner
approved proceeding on team-console's own GitHub-tracker Stage A gate with the `PT_*` credential residual
recorded, answering question 4 of the #633 architect note. Everything else below that is not one of those three
decisions is a team decision under `reference/decision-policy.md`, reversible with `/reject why`). Date:
2026-11-26. Implementation note: the architect note on #633 (§1, decisions 1–7). Slice 1a of #633 (`api + db +
contracts`, shipped as migration #1046 and routes/contracts/wake #1047, both merged to `dev`; part of #1039).
Amends [ADR 0006](0006-console-source-of-truth.md) "Data model" (the `jobs.kind` row now references `job_kinds`,
migration 0045) and "Runner and job queue" (the `…/jobs/:id/children` route row now exists; `team_state` gains
`orchestrate_run_id`/`orchestrate_steps`). Threat model: `docs/security/309-threat-model.md`, rows C2 and C8
below.

## Context

ADR 0006 gives the team a headless orchestrator (`slot-*`/`burn`/`kickoff` jobs, role `orchestrator`) and a job
queue, but the orchestrator still runs as one long process that dispatches developers and reviewers as **local
subagents** inside its own session — sharing its token, environment and clone — because `POST
…/jobs/:id/children` did not exist. The Mac runner also runs one job at a time (`max_concurrency = 1`, ADR 0006):
a long-lived orchestrator that *waits* for a child would deadlock its own children on that runner. #633 asks the
console itself to drive a run: the owner starts it from the API, a step enqueues real child jobs, a child's
`finish` wakes the next step, and Stop cancels the run. This ADR records the decisions that make that possible
without a waiting process and without widening the trust boundaries ADR 0006 (R1–R9) and ADR 0008 (decisions 1–9)
already set.

## Decisions

| # | Decision | Why | Rejected |
| - | -------- | --- | -------- |
| 1 | **Orchestration is a chain of short `orchestrate` step jobs, not one long job.** A step does one pass: read the run's state, enqueue child jobs, (slice 1c) request reviews and merge what passed, write a summary, finish. It never waits for a child. The console **wakes** the next step when the run has work and nothing is live: on a child's `finish` (any outcome) in slice 1a, and (slice 2) on an owner answer or resume. | A waiting orchestrator deadlocks its own children on a one-slot runner; steps also give "ends on a chunk boundary" for free. | A waiting orchestrator with `maxConcurrency ≥ 2` on the Mac (ADR 0006 forbids it on the `user` backend); a Durable Object or Worker loop driving the agent (the Worker is not where a model runs). |
| 2 | **A run is a server-side record, not a process.** `team_state.orchestrate_run_id` (NULL = idle) is the lock; every step and child carries `payload.run`; `parent_job_id` stays the lineage (ADR 0006 R2). **Stop clears the run and cancels its live jobs in one batch — a hard cancel** (owner decision 2026-11-26; a graceful stop that finishes the current job first is slice 2). A step that finds nothing to do finishes with `result.metrics.next ∈ 'owner' \| 'done'` and the run waits or ends; **`ORCHESTRATE_MAX_STEPS = 20`** (owner decision 2026-11-26, not the architect note's 40) ends a run that would loop (threat model C8). | The lock the owner sees must be a row a wake and a Stop can both act on atomically; a one-day step budget the owner can reason about in subscription turns. | Reusing `requested_by` for lineage (ADR 0006 follows it to the root; this needs child-token parentage); an unbounded run (threat model C8). |
| 3 | **One live orchestrator per project, the existing partial unique index.** `dedupeKeyOf` (`routes/jobs.ts`) returns `<slug>:orchestrator` for every kind whose role is `orchestrator` — `slot-*`, `burn`, `kickoff` **and** `orchestrate` — so Run now of a slot and a console run cannot overlap, the same rule as `runlog start` → `overlap` for a human orchestrator. **The claim SQL is not touched**: `JobsRepo.claim`, `claim-admission.ts` and `access-source.ts` are unchanged; the lock is the dedupe index, not a claim term. | Reuses a control that already exists and is tested; a claim-side change would touch the hottest, riskiest query in the queue for no new guarantee. | A second dedupe key per orchestrator kind (would let a slot and a console run overlap — the opposite of the point). |
| 4 | **Role work is a `task` child job; reviewer roles stay top-level `review` jobs.** `POST …/jobs/:id/children` mints `task` jobs for **`TASK_ROLES` = `dev` \| `dev-light` \| `dev-heavy` only** (never `qa`, `reviewer`, `security` — structural, R2); the child gets its own token, config revision, `max_minutes` and model (from the role's resolved team config) and an `audit_events` row. Reviews stay slice 1c's `…/prs/:number/reviews`. The runner launching `orchestrate`/`task`/`review` jobs with the Agent tool disallowed is the runner PR (out of scope here; see "Out of scope"). | "Never a reviewer child" is enforced the same way #612 already enforces "never a reviewer sub-job": a route that cannot mint that role, not a convention. | Letting a step mint any role as a child (would let an `orchestrate` step mint its own reviewer, defeating R2). |
| 5 | **`job_kinds` lookup table replaces the `jobs.kind` CHECK.** Migration 0045 rebuilds `jobs` once more (the last rebuild for a kind) with `kind TEXT NOT NULL REFERENCES job_kinds (kind)`; every later kind is one `INSERT`. The ten existing kinds plus `orchestrate` and `task` are seeded. | SQLite cannot `ALTER` a `CHECK`; the next kind after this one costs one row, not a rebuild of the hottest table. | Extending the CHECK again (the same rebuild cost at the next kind); dropping schema-level validation (defence in depth stays, as `labels` has it). |
| 6 | **Prompt stays byte-stable; the step reads its payload from the console.** The runner's `promptOf` keeps interpolating item numbers only (threat model C8, ADR 0009 decision 5's caching); the runner adds `TC_JOB_ID` to the job env (an identifier, not a credential); the skill reads `GET …/jobs/:id` and `GET …/jobs/:id/children` for everything else. Plugin and runner work are out of scope here. | Keeps the one injection-bounded prompt shape ADR 0009 already protects for caching; nothing from item text, a comment or a PR body reaches a child's prompt as free text — `CreateChildJobInput` is enums and numbers only (decision 4). | A payload interpolated into the prompt text (reopens the injection surface the fixed template closes). |
| 7 | **Stage A gate stays GitHub-era** for a project on the GitHub tracker — team-console itself, until #437. A step runs `pr gate`/`pr merge` under `merge-authority` exactly as a slot job does today; review children (slice 1c) post GitHub verdicts with `pr review`. Verdict rows, role keys and the console merge are Stage B/2-C and are not pulled in by this slice. **Owner decision 2026-11-26**: proceed on this basis before #437, with the `PT_*` credential residual recorded (Consequences, and threat model C2). | Nothing in slice 1 needs the console-side gate; building it now would be ahead of #437 for no slice-1 requirement. | Blocking slice 1 on #437 (the console-side gate is Stage B/2-C work, unrelated to whether a run is a chain of jobs). |

## Data model (amends ADR 0006 "Data model")

The `jobs.kind` row of ADR 0006's table is superseded: `kind` is no longer a `CHECK (kind IN (…))`, it is
`REFERENCES job_kinds (kind)` (migration `0045_job_kinds_orchestration.sql`). `job_kinds (kind TEXT PRIMARY KEY)`
is seeded with the ten kinds the CHECK named plus `orchestrate` and `task`. The migration rebuilds `jobs` with
`PRAGMA defer_foreign_keys = true` (the self-reference `parent_job_id` and `job_events.job_id` both point at it)
and recreates its seven indexes and its triggers under the same names, never a rename (a renamed table would not
settle the deferred foreign-key count and the transaction would fail to commit). `team_state` gains
`orchestrate_run_id TEXT` (NULL = idle, a 26-character ULID CHECK) and `orchestrate_steps INTEGER NOT NULL DEFAULT
0`. `apps/api/migrations/0045_job_kinds_orchestration.sql` is the migration; its own spec compares
`sqlite_master` of a fresh local D1 against the expected index and trigger list.

ADR 0006's "Runner and job queue" row for `…/jobs/:id/children` ("presented with the claiming runner's identity")
is no longer a future row: the route exists (below), minting `task` jobs for non-verdict roles only, exactly as
that row already described.

## API (shipped in slice 1a)

Six routes, behind the route-scope and tracker-matrix rows (`apps/api/src/auth/route-scope.ts`,
`apps/api/src/auth/tracker-matrix.ts`), every write with its own `audit_events` row holding ids and enums only:

- `POST …/orchestration/start` (owner only): takes the run lock and enqueues **its first step in the same batch
  as the lock** (`OrchestrationRepo.start`) — Start does not go through the wake at all; 409
  `orchestration-active` on a second start, the existing `run-paused` shape while the team is paused.
- `POST …/orchestration/stop` (owner only): clears the lock and, in the same batch, hard-cancels every queued,
  claimed or running job the run holds (`result.reason = 'orchestration-stopped'`, token cleared); 409
  `orchestration-idle` when there is no run.
- `GET …/orchestration` (read): an `OrchestrationDto` — `runId`, `steps`, `state` (`idle` \| `running` \|
  `waiting-owner` \| `stopping`), `liveStepId`, `children` counts. **`state` has no `paused` value**: pause is
  `team_state.paused_at`, a separate axis the console UI combines with `OrchestrationDto.state` itself (slice
  1d), not something this DTO encodes.
- `POST …/jobs/:id/children` (the orchestrator job, of itself only — `child-not-own-job` otherwise): mints `task`
  jobs for `TASK_ROLES`, one per item, `dedupeKey = <slug>:task:<item>` (one live child per item, across steps
  and runs), `requestedBy = job:<parent>`, inheriting `accountId`/`projectSlug`/`needsLocal` from the **parent
  job row**, never the request. Up to `JOB_ITEMS_MAX` (100) items per call.
- `GET …/jobs/:id/children` (read, cursor-paged).
- `POST …/jobs/:id/cancel` (owner only): a hard cancel of one live job (any kind, any role) with its token
  cleared in the statement and its queued children cancelled with it; 409 `job-not-cancellable` once it has
  ended.

**The wake is server code with no model input** (`apps/api/src/jobs/orchestration-wake.ts`): `wakeDecisionOf` is
a pure function over `{runId, steps, liveStep, liveChildren, lastStepResult, paused}`; it reads `jobs` and
`team_state` rows only, and an unknown or missing `result.metrics.next` reads as `children` rather than stalling
the run. **Its only call site in slice 1a is the runner's `finish` route** (`routes/runner-jobs.ts`, after the
finish batch): `wakeAfterFinish` wraps it so a wake failure is logged, not turned into an error the runner would
retry — the run then waits for the next finish or for Stop. Two children finishing at once meet at the step's
dedupe key (`<slug>:orchestrator`): one wake enqueues the next step, the other's batch fails whole and answers
"no step" (`WakeOutcome = 'run-moved'`).

**The claim is untouched.** `JobsRepo.claim`, `claim-admission.ts` and `access-source.ts` carry no orchestration
term; a step and a child are ordinary jobs claimed by the existing query, and the one-orchestrator-per-project
rule is the dedupe index (decision 3), never a claim predicate.

**Cutover gating.** `orchestrate` and `task` are in `JOB_KINDS_BEFORE_CUTOVER` (#775): team-console runs its own
console runs on the GitHub tracker, as every other job kind does, until #437.

## Consequences

- **Recovery is slice 2.** Because the wake's only trigger in 1a is a child's `finish`, a run can be left with
  nothing live and no step queued if the last live child is cancelled (owner cancel, or Stop racing a `finish`)
  or if a wake call itself fails (logged, not retried) — the run then sits idle-but-locked until the owner's
  Stop. A periodic recovery sweep that re-wakes a stalled run is explicitly slice 2, not this PR.
- **Two known gaps**, both accepted for slice 1a and left as follow-ups:
  1. `liveOrchestratorParentOf` and the `…/jobs/:id/children` matrix row both check the caller's **role**
     (`orchestrator`), not its **kind**. Any live orchestrator-role job — `slot-pm`/`slot-dev`/`slot-qa`, `burn`,
     `kickoff`, not only `orchestrate` — can mint `task` children through this route today, exactly as a console
     step can. Those children's `payload.run` is `null` (a slot job carries no run), so **Stop does not cancel
     them** — the owner cancels each by its own id through `POST …/jobs/:id/cancel`. Narrowing the route to
     `kind = 'orchestrate'` only is an open follow-up, filed against #633 slice 2.
  2. **No cap on total children per run** beyond the per-item dedupe (one live child per item, across steps) and
     the per-request limit of `JOB_ITEMS_MAX` (100). A run that keeps minting new items each step is bounded only
     by `ORCHESTRATE_MAX_STEPS` and the role's `max_parallel`, not by a run-wide child count.
- **Stage A credential residual, more visible.** Every job of a GitHub-tracker project — a `task` child
  included — still receives its runner's configured `env.passthrough` `PT_*` keys (needed for `pr
  push|merge|review`), so a `task` child could in principle call `pr merge`. This is unchanged in *kind* from
  today's `slot-dev` subagents (the #446 note's residual); it is only more *visible* because children are now a
  named console concept rather than in-process subagents. It is removed at Stage B/3b, when the console itself
  holds the merge. The CLI credential residual stays RR6/RR11 (`docs/security/309-threat-model.md`), unchanged by
  this slice.
- ADR 0006's "Runner and job queue" row for `…/jobs/:id/children` is no longer a forward reference; this ADR is
  what fills it in.
- `CLAUDE.md`'s "Jobs and job tokens" section is amended in the same PR: `jobs.kind` is described as the
  `job_kinds` lookup, not a CHECK, and a Rules bullet names the orchestration lock, the children route and
  `ORCHESTRATE_MAX_STEPS`.

## Rejected alternatives

- A waiting orchestrator process with `maxConcurrency ≥ 2` on the Mac runner (ADR 0006 forbids it on the `user`
  backend: same-user processes can read each other's environment).
- A Durable Object or a Worker Cron loop driving the agent directly (the Worker is not where a model runs; it can
  only enqueue and read rows, which is exactly what the wake does).
- Letting a step mint a child of any role, trusting the route's caller to never ask for a verdict role (rejected
  the same way #612 rejected reviewer sub-jobs: a route that cannot do it beats a convention that says not to).
- Extending the `jobs.kind` CHECK again instead of a lookup table (pays the same rebuild cost at the very next
  kind).
- A second dedupe key for `orchestrate` instead of folding it into the existing `<slug>:orchestrator` key (would
  let Run now of a slot and a console run overlap on one project).
- `ORCHESTRATE_MAX_STEPS = 40` as the architect note first asked the owner about; the owner set it to 20
  (2026-11-26), closer to a day's orchestrator-model turns on his own subscription.
- A graceful Stop ("finish the current job, start nothing new") in this slice; the owner accepted a hard cancel
  for 1a and asked for graceful stop as slice 2 (question 3 of the #633 architect note).

## Out of scope (follow-ups, not this PR)

- The runner PR: `SKILLS`/`ROLE_MODELS` for `orchestrate`/`task`, `--disallowedTools` (no local subagents) for
  `orchestrate`/`task`/`review`, `TC_JOB_ID` in the job env, `kind-unknown` refusal, `MIN_RUNNER_VERSION` — waits
  on #801 and lands in Sprint 06.
- Plugin skills `orchestrate` and `task` (1b), `review` and `pr request-reviews` (1c) — product-team-plugin,
  owner merge.
- Start/Stop buttons in the console UI (1d).
- Slice 2: wake on an owner answer or on resume, the recovery sweep, a "Needs you" row for `waiting-owner`.
- Slice 3: a live run view (steps, children, events). Slice 4: scheduled start.
- Narrowing `…/jobs/:id/children` to `kind = 'orchestrate'` (gap 1 above); a run-wide child cap (gap 2 above).

## References

- Architect note on #633 (implementation note; §1 decisions 1–7, §3, §4, §5, §7, §9 questions 3 and 4).
- #1039 (this slice's tracking issue), #1046 (migration PR), #1047 (api/contracts/wake PR).
- [ADR 0006](0006-console-source-of-truth.md) "Data model", "Runner and job queue"; [ADR 0008](0008-multi-tenant-console.md); [ADR 0009](0009-team-config-contract.md) decision 5 (prompt caching).
- `docs/security/309-threat-model.md`, rows C2 and C8.
