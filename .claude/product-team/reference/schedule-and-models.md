# Schedule, caps and models

Source: SPEC decisions 2, 3, 13. Timezone: **Europe/Kyiv**. `scripts/slot-context` computes the current mode;
skills read it instead of re-deriving the calendar.

## Slots

| Local time (jittered) | Days | Skill | Mode |
| --------------------- | ---- | ----- | ---- |
| 18:07 | Mon–Fri | `slot-pm` | read owner answers, plan, prepare designs |
| 23:13 | Mon–Thu | `slot-dev` | development (the one heavy run) |
| 04:21 | Tue–Fri | `slot-qa` | QA, fixes, morning summary |
| 23:13 Fri → 19:00 Sun | burn | `slot-dev` at Fri 23:13, Sat 10:37, Sat 23:13, Sun 10:37 · `slot-qa` at Sat 04:21, Sun 04:21, Sun 17:07 · deep audit inside `slot-qa` at Sat 16:43 | burn |

On **freeze days** (the two days before the sprint's due date, after `stage` was cut) `slot-dev` runs
`qa-regression` on `stage` instead of feature development.

The weekly quota resets on **Sunday 20:00 Kyiv**; the burn window uses what is left of it. Runs are jittered
off the hour to avoid the top-of-hour load spike. Cron in routines is usually UTC — Kyiv is UTC+3 in summer
and UTC+2 in winter, so re-check routine times at DST changes; `slot-context` always reports the true local
mode, so a run that fires an hour off still behaves correctly.

## Caps

| Mode | Dev tasks per run | Parallel dev subagents | Dev model |
| ---- | ----------------- | ---------------------- | --------- |
| normal (Mon–Thu) | 2 | 2 | by tier |
| burn (Fri 23:00 – Sun 19:00) | 5 | 3 | by tier, `light` raised to `standard` |
| freeze | 0 features, fixes only | 1 | by tier |

The weekday caps stay conservative so the weekly quota lasts until the burn window; watch `runlog stats` and
lower `caps` in `project.yml` if runs start failing on the usage limit mid-week.

## Tiers — which developer builds an issue

The `architect` sizes every approved issue in `slot-pm`; `backlog next` turns the tier into the agent.

| Tier | Agent | Model | Typical work |
| ---- | ----- | ----- | ------------ |
| `tier:light` | `fullstack-dev-light` | Sonnet 5 | one module, an existing pattern to copy, clear criteria: copy, config, a small UI tweak, a bug with a reproduction, a test gap |
| `tier:standard` (default) | `fullstack-dev` | Opus 5.5 | a feature slice across layers, new tests, a new component on the kit |
| `tier:heavy` | `fullstack-dev-heavy` | Fable 5.1 | cross-cutting or architectural: a new data model or migration, concurrency, performance, hard algorithms, a refactor across modules, unclear edges |

Guard rails, in code (`scripts/ptlib/tiers.py`): no label → `standard`; the burn window and hotfixes have no
`light` work; two failed review rounds (`review-failed`, then `tier-up`) raise the tier one step; security-
labelled work is never built on Fable (it runs on `standard`). Product specialists (`agent:<name>`) keep their own
model. `sprint-metrics` reports shipped and raised issues per tier — if `light` keeps getting raised, size stricter.

P0/P1 bugs and release blockers do not count against the cap. The plan itself comes from `scripts/backlog next`
(`scripts/ptlib/picker.py`): the order and the caps are code with tests, not a judgement call per run.

## Models (pinned IDs, never aliases)

| Model | ID | Used by |
| ----- | -- | ------- |
| Fable 5.1 | `claude-fable-5-1` | `architect`; `kickoff`, `foundation`, ADRs; `fullstack-dev-heavy` |
| Opus 5.5 | `claude-opus-5-5` | orchestrator (`slot-*`, `adopt`, `demo-*`), `pm`, `ux-designer`, `ui-designer`, `qa`, `security`, `fullstack-dev` |
| Sonnet 5 | `claude-sonnet-5` | `fullstack-dev-light`, `reviewer`, `devops`, `analyst`, `qa-runner` (regression) |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | `scribe`: labels, changelog, summary formatting |

Security reviews are never delegated to Fable (its extra cyber safeguards cause refusals) — they go to
`security` on Opus. Project-specific agents (`agent:<name>` issues) use whatever model their own file pins.

Role variants exist only to pin a second model to the same role: `qa-runner` is `qa` on Sonnet for mechanical
regression runs, `scribe` is the Haiku formatter.

## Stop conditions

Every run writes a `started` entry to the run log and closes it with `finished`/`failed`
(`scripts/runlog`). A run that dies on the usage limit leaves a dangling `started`, which counts as failed.

- **3 failed runs in a row** → the next run sets the run log to `paused`, notifies the owner and does no work.
  Work resumes when the owner comments `/resume` on the run-log issue.
- **Which issue is the run log**: `team.run_log_issue` in `.product-team/project.yml` (kickoff/adopt pin it), else
  the one issue labelled `team:run-log` that the team or the owner opened. An issue anyone else opened is never the
  log, and with two candidates every `runlog` command refuses until one is pinned. When the scripts refuse because
  labelled issues exist that neither the team nor the owner opened, recover in one of two ways: remove the
  `team:run-log` label from those issues (whatever pause, `/resume` or failure streak was recorded on them is gone —
  the team starts a fresh log), or pin a log the team or the owner opened as `team.run_log_issue`. Pinning an issue
  anyone else opened is refused.
- **Rotation**: the log is one issue and every run reads all of it (REST and, where available, its GraphQL edit
  history). Each run is two comments (`started`, then `finished`/`failed`; the log is append-only). Past a few
  thousand entries, start a new one: close the old issue, open a new one labelled `team:run-log` (as the team),
  and change `team.run_log_issue` by PR in the same step. Do it while nothing is paused — pause records, `/resume`
  and failure streaks do not carry over.
- A run that finds the previous run of the same slot still `started` less than 3 hours ago exits
  immediately (overlap guard).
- All state is in the repository and in Issues, so the next run resumes where the failed one stopped.
