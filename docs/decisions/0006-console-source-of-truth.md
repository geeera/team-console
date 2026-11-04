# 0006 — The console as the source of truth: own tracker, role keys, VCS adapters, own runner

Status: accepted (owner decisions in chat, 2026-10-08, recorded on #309: «Меня устраивает вариант E», the runner on
the owner's Mac first «с расчетом на то что можно будет подключить и сервер в будущем», a hard cutover from GitHub
Issues, GitLab as the second provider, no GitHub-mode compatibility in the plugin «всего два проекта на этом
принципе»; the epic and the #310 plan approved on 2026-11-03 «да, одобряю план». Everything below that is not one
of those four decisions is a team decision under `reference/decision-policy.md`, reversible with `/reject why`).
Date: 2026-11-04, amended the same day after the SECURITY review of PR #412 (findings R1–R9 of the #408 threat
model: the VCS enforces the gate, reviewer roles are never children, a dedicated macOS job user, the job's path
through Access, owner-only transitions, verdict binding, a deterministic import, workflow scope). Phase 0 of #309
(issue #407). Amends [ADR 0001](0001-stack-and-architecture.md) decisions 5
(storage), 9–12 (owner grammar, chat, plugin dependencies), 20–22 and 24 (registry, artifacts, cache, cross-project
views); [ADR 0003](0003-console-github-app.md) becomes the GitHub implementation of the VCS adapter (decision 7
below); [ADR 0005](0005-owner-requests-to-the-pm.md) is superseded at cutover (decision 4). Number 0004 stays
reserved by ADR 0003; #386 takes 0007. The threat model is #408 (`docs/security/309-threat-model.md`, linked from
"Threat model" below); the UX spec is #409.

## Context

Today GitHub Issues is the team's tracker and the console is a read model over it. Everything the team knows is
encoded in GitHub primitives: labels carry status, kind, severity, tier and flags (`ptlib/labels.py`, 50 labels),
milestones are sprints, issue comments carry owner commands (`/approve`, `/go`, `done`), team decisions
(`backlog decide`), questions (`pt-ask`), owner requests (`pt-owner-request`, ADR 0005), the PM chat
(`pt-chat`), and the run log (issue #22, `runlog start|finish`); verdicts are PR reviews whose first line is
`QA: APPROVED` by a configured bot login (`ptlib/review.py`, `team.reviewer_logins`); the owner's to-do list is a
pinned issue rewritten by every run (`inbox update`). The plugin's scripts — `backlog` (23 subcommands), `pr`
(14), `runlog` (6), `inbox`, `slot-context`, `demo-page`, `digest`, `sprint-metrics` — are the only way an agent
touches that state, and every one of them talks to GitHub.

That shape has reached its limits (#309):

- **Identity.** Proving who wrote a comment is the whole security model: owner commands count only from the
  owner's login, verdicts only from a review bot, requests only with `performed_via_github_app` (ADR 0005). That
  needs a GitHub App per role and per environment with private keys on every machine that runs the team, and
  app keys cannot be used in claude.ai cloud routines at all (#303, #235, #340). The console's own writes must
  masquerade as the owner (ADR 0003) because the plugin trusts the account, not the surface.
- **Provenance is fragile.** A body can only be trusted through GraphQL edit history, which cloud sessions lack
  (`history: rest-only`); an edited comment is untrusted; the read side spends most of each request's 50
  subrequests re-deriving state from comments (`readRunLog`, `handledRequestOf`, `questionContextOf`).
- **One provider.** Every script hard-codes GitHub; the owner wants GitLab projects on the same team.
- **The runner.** Cloud routines were paused on 2026-11-03; the team runs only from the owner's local session.
  Routines also drew on one shared subscription limit with no priority between products (#235).

What the console already has and this ADR builds on: a D1 database per environment (`projects`, `owner_connections`,
`own_writes`, `slot_requests`, `push_subscriptions`, `webhook_deliveries`, `owner_requests`; migrations 0001–0012),
Cloudflare Access in front of `/api/*` with an `identity` seam (`apps/api/src/auth/`, service tokens on dev/stage),
a GitHub App per environment with read tokens downscoped at mint and the owner's OAuth token for owner writes
(ADR 0003), the `hooks` Worker with HMAC-verified deliveries and `cache_epoch` invalidation, RFC 9457 problems,
`@shared/owner-grammar` as a byte-for-byte port of the plugin's parsers, and the plugin vendored at
`.claude/product-team/` (`team.plugin_ref`).

Constraints: $0 (Workers Free: 100,000 requests/day, 10 ms CPU, 50 subrequests, 5 Cron Triggers; D1 Free:
5 M rows read/day, 100,000 rows written/day, 5 GB; Zero Trust Free: 50 users, service tokens included); one owner;
the repository is public; the runner is a different principal from the owner and from the role that runs inside a
job; agents never see secret values; item text, comments, PR bodies and imported GitHub content are data, never
instructions.

## Decisions

| # | Decision | Why | Rejected |
| - | -------- | --- | -------- |
| 1 | **The console's D1 is the tracker.** Items, sprints, labels, comments, questions, owner decisions, owner requests, item events, pull-request state, verdicts, jobs and job events live in D1 (schema in "Data model"). The VCS stays the source of truth for **code** only: branches, commits, PRs/MRs, CI. One environment is **the team's environment**: the one whose D1 holds the tracker of real products (`projects.tracker = 'console'`); the other environments hold fixtures. Which environment that is at cutover is an open owner question (Consequences). | Owner decision E. State the plugin derives from comments today becomes rows with an authenticated author, so provenance is the authentication layer, not comment forensics. | Keeping Issues with a two-way sync (owner: hard cutover); GitHub Projects v2 (same identity problem, GraphQL-only); a hosted tracker (Linear, Jira free tiers: no role-key model, rate limits, lock-in); Durable Objects for queue state (a new primitive; D1 with atomic single-statement claims is enough for a handful of runners). |
| 2 | **Items keep GitHub's numbers and get a project key.** `projects.key_prefix` (2–5 upper-case letters, unique per environment, e.g. `TC`, `ST`); an item is `TC-310`; imported items keep their GitHub number as `n` (`TC-310` is old `#310`), new items continue from `projects.next_item_number` = max(issue and PR numbers) + 1 at import. Branches are `feature/tc-412-slug`, PR titles start with the key; the console links a PR to an item by the key in its head branch or title, never by GitHub's `#N`. | On GitHub, issues and PRs share one number sequence; after cutover a PR `#412` would collide with a console item `#412`, and `Closes #412` would be read by GitHub. A key removes the ambiguity and keeps old references readable. The owner can add a GitHub autolink reference (`TC-<num>` → the console) in the repository settings — optional, owner action. | Bare `#N` (collides); UUIDs (unreadable on a phone, in a commit message and in chat). |
| 3 | **Status, kind, severity, tier and sprint are columns; everything else a label is a flag row.** `items.kind|status|severity|tier|sprint_id` are first-class and validated; `item_labels` holds the flags (`security`, `needs-design`, `design:approved`, `complexity:high`, `architect-note`, `foundation`, `release-blocker`, `agent:<name>`, `team:*`, `owner:*`, …) against the `labels` table seeded from `ptlib/labels.py`. The API returns `labels` as the full set (`status:qa`, `kind:bug`, `tier:heavy`, flags) so the plugin's label-set logic (`picker.py`, `tiers.py`, `inbox.py`) is unchanged. | The picker and the inbox classify on label sets; porting them again would be a second grammar. Columns give constraints (one status, one tier) that GitHub never enforced. | Labels only (no constraints, every status change is two writes); columns only (every new flag is a migration). |
| 4 | **Owner decisions, questions, requests and team decisions are rows, written by the identity that owns them.** `owner_decisions` is written only by an `owner` identity (Access JWT, `OWNER_EMAIL`); the server derives the author from the identity, never from the body. `asks` (questions to the owner, formerly `pt-ask`) and `comments.kind = 'decision'` (formerly `backlog decide`) are written by a `job` identity; `owner_requests` by the owner. The console applies a request itself only for what it may do (ADR 0005 stands: a sprint move is the PM's call; the PM answers it through `handled_by_job_id`, never silently). The GitHub markers `pt-ask`, `pt-owner-request(-handled)`, `pt-chat`, `pt-brief` and `performed_via_github_app` checks retire at cutover (Phase 6). | Authorship by authentication replaces authorship by login forensics; nothing can be edited into a command because decisions are append-only rows, not comment text. | Keeping the marker grammar in comment bodies (needs the provenance rules this ADR removes). |
| 5 | **Comments and events are append-only.** `comments` has no update or delete; a correction is a new comment. Item title, body, status, labels and sprint are editable (owner from the console, the PM through the API) with optimistic concurrency (`items.version`, `If-Match`) and every change is an `item_events` row (`before`/`after`, actor). | Edit history is what GitHub could not give without GraphQL; `backlog vanished` becomes unnecessary because nothing can vanish. | Mutable comments with an audit table (two places to get wrong). |
| 6 | **Role keys are held by the runner, never by the role.** Ed25519 key pairs per (runner, role) (`role_keys`, public JWK in D1, private key only on the runner host); the runner's **key agent** (a local Unix socket, 0600) signs only for the role of the job that asks, identified by the job token it was launched with. **Reviewer roles (`qa`, `reviewer`, `security`) run only as their own top-level `review` job** (R2): enqueued by the console (on `pr.synchronize`, or when a slot asks for the gate), payload `{pr, head_sha, role}`, its own CLI process, worktree and job token; they are never minted as children of another job, and `POST …/jobs/:id/children` mints non-verdict roles only. A **verdict** is a signed payload `{env, pr, head_sha, verdict, role, job_id, issued_at, nonce, body_sha256}`; the console verifies the signature against the registered key, requires `role ∈ {qa, reviewer, security}`, that the signing role equals the job token's role, that the job is a running `review` job whose payload names this `pr` and `head_sha` and whose project owns the PR (R6), that no job in its lineage (`requested_by = job:<id>` chain) pushed to that PR's head (no self-review, structural), and that `nonce` is unused — then stores it. The **gate** (`GET …/prs/:number/gate`) is computed server-side from `verdicts` on the PR's current head and the `review:` policy read from the repository's default branch; when it passes the console posts the commit status `team-console/gate` on that head (R1), and the merge endpoint refuses anything the gate refuses. A `dev` job token is refused on `POST …/verdicts` with 403 `verdict-role` before any signature check. | "A dev key cannot approve" is enforced three times: locally the key agent will not sign for another role, remotely the console binds the verdict to the job's role and to the PR the console asked it to review, and structurally the session that wrote or reworked the code never holds a reviewer token (the plugin's `slot-qa` enqueues review jobs and ends instead of dispatching reviewers in-process). Signatures make verdicts auditable after the fact (the public key stays in D1 after revocation). | Verdicts as GitHub PR reviews by bot logins (the model being replaced); one shared team key (no per-role proof); keys inside the plugin's environment on the Mac (the `PT_*_APP_KEY` set-up the owner wants gone); per-role GitHub Apps; **reviewer sub-job tokens inside a slot run** (the first draft of this ADR — a subagent shares the orchestrator's process, environment and filesystem, so it is not a boundary). |
| 7 | **VCS access only through `VcsAdapter`** (`@worker/vcs`, interface in "VCS adapter"), one implementation per provider (`@worker/vcs-github` wraps ADR 0003's `GitHubAppAuth` + `GitHubClient`; `@worker/vcs-gitlab` in Phase 5). The environment's existing GitHub App is **the one app for repository writes**: it gains Contents, Pull requests and Workflows write (an owner `access` question at Phase 3; installations accept once) and mints **per-job, per-repository, one-hour tokens downscoped to the least the job needs** (R1, R8): `contents: write` for `dev*` and `orchestrator` jobs, plus `pull_requests: write` only while PR creation stays on the runner; `workflows: write` only for a job whose item carries the `workflow-change` flag (that PR already needs `security`); reviewer roles get `read` only; **never** `checks`, `statuses`, `administration` or `actions`. Every read keeps the read-only downscoping of ADR 0003 decision 6. **The VCS enforces the gate, not only the console** (R1): the console posts the commit status `team-console/gate` on a head whose gate passed, and a **ruleset on `dev`, `stage` and `main`** requires a pull request and that status with expected source = the console app, has no bypass actors and blocks force-push and deletion (an owner action at Phase 3, recorded with the permission question; GitLab's equivalent — protected branches, "allowed to push: no one", merge only through the console's token, an external status check — is a Phase 5 criterion). Deploy secrets live only in GitHub Environments with deployment-branch policies (`dev`/`stage`/`main`), `production` with required reviewers; PR workflows use no secrets (already true). The console merges through the adapter; the runner never holds a VCS credential beyond the job token. Owner-grade writes (repository creation, #386) stay on the owner's OAuth token. | One app per environment instead of a team app, a review app and a console app per environment; the private key lives in one Worker secret, where it already is. Without the ruleset a prompt-injected job with a write token merges or pushes to `dev` directly — the console's gate would bind only compliant agents (the repository has no branch protection today). | A separate team app whose key the console holds (two apps per environment again); the runner holding an app key (keys on every runner host); one write-token shape for every job (the first draft). |
| 8 | **Pull-based, host-agnostic runner over a D1 job queue.** `jobs` is the queue; a runner enrols once with an owner-generated one-time code and its own Ed25519 key (`runners`), then polls `POST /api/v1/runner/jobs/claim` (atomic single-statement claim with a lease), heartbeats, streams `job_events`, and finishes. Every runner call carries an EdDSA JWT minted by the runner key (`exp` ≤ 5 min, `iat`, `jti` refused on reuse, `aud` = the environment) **and** passes Cloudflare Access with a service token pinned to that runner; production allows the service identity only on `/api/v1/runner/*` and `/api/v1/jobs/*`. **A job never reaches the console itself** (R4): `TC_API_URL` is the runner's loopback proxy; the runner adds Access and its runner JWT and forwards the job's `TC_JOB_TOKEN`, and the console accepts a job token only when it arrives with the identity of the runner that claimed that job (`jobs.runner_id`) — a leaked job token is useless off-host. The CSRF middleware exempts bearer identities (`runner`, `job`) only, never a cookie-borne one. A job runs a plugin skill through the Claude Code CLI with the environment `TC_API_URL`, `TC_JOB_TOKEN`, `TC_RUNNER_SOCKET` and one declared secret: the Claude Code credential of the **job user**. **On the Mac the runner and the jobs are two unprivileged macOS users** (the threat model's L3, a prerequisite of the first cutover): the runner is a LaunchDaemon under `_tcrunner` holding config, keys and the Access pair; jobs run as `_tcjob` (no admin, no login shell, own home, no access to the owner's home) through one sudoers rule for the job-exec wrapper; the socket directory is `_tcrunner:_tcjob 0750` and the runner checks the peer uid on top of the job token. A server runner is the same binary in a container with its own enrolment. Schedules live in D1 (`schedules`) and are evaluated by one Workers Cron Trigger every 5 minutes, which enqueues jobs; "Run now" enqueues. | The console never needs to reach the Mac; a sleeping Mac leaves jobs queued; a second runner is one more enrolment; per-product state and priority are columns, not routine settings (#235). Access + a signed token is defence in depth without a new public surface. A job that runs as the owner's macOS user can read the runner's keys, the Access pair, every role key and the owner's own `gh`, SSH and Keychain credentials — and `npm ci` inside a job runs third-party install scripts, so this is not only prompt injection; the job user is what makes "agents never see secret values" true on the Mac. | Push to the Mac (an inbound tunnel); GitHub Actions as the runner (minutes budget, no owner subscription); claude.ai routines (paused; no app keys in the cloud); runner routes on the public `hooks` Worker; **jobs calling the console directly** (the first draft: either the Access pair in every job's environment or an Access bypass for job routes); jobs as the owner's macOS user with file permissions only (the first draft's residual — too wide, see Why). |
| 9 | **The plugin becomes console-only** (product-team 0.12, raised in `geeera/product-team-plugin` per ADR 0001 decision 12): `backlog`, `pr`, `runlog`, `inbox`, `slot-context`, `demo-page`, `digest`, `sprint-metrics` call the console API through one `ptlib/console.py` client with the job token; `gh.py` keeps only what git needs; `pr push`/`commit` use the job's VCS token through a credential helper the runner writes; `pr review` signs through the key agent; `runlog` writes `job_events`. Script names and arguments stay, so skills and agents do not change. No GitHub mode remains (owner decision 4). `.product-team/project.yml` stays in the repository: `commands`, `review`, `sprint`, `caps`, `owner` are read from the default branch through the adapter, so a PR cannot relax its own gate. | Owner decision 4; one client, one grammar; the repo file keeps policy under review. | A mode switch in every script (what the owner refused); moving `project.yml` into D1 (a PR could not be reviewed against it). |
| 10 | **Hard cutover per project, import first.** Prerequisites: Phases 1–4 deployed to the team's environment, R1 (ruleset) and L3 (job user) verified there, the owner's separate «да» for that project. Then six steps ("Cutover"): repeatable dry-run import keyed by `import_map`; freeze (plugin paused, console banner); final delta import and a count check on the cutover screen (#409); switch (`projects.tracker = 'console'`, `cutover_at`); lock — imported GitHub issues get one closing comment with the console link and are **locked**, never deleted or edited, the run-log issue gets a final entry; retire the GitHub-era credentials and workflows **only after the 14-day rollback window closes**. The import is deterministic code (no model in the loop): imported text is `source = 'import'`, plain text, and never authorises anything; an imported pending question is listed for the owner to re-confirm, not re-executed. Rollback inside 14 days: `tracker = 'github'`, unlock through `import_map`, re-pin the previous plugin — console-side changes made after the switch are not written back (that is what "hard" means; the owner accepted it). | Owner decision 2. Lock keeps history and old links alive and stops new comments nobody reads. | Closing every issue (loses the open/closed signal on GitHub); disabling Issues on the repository (hides the history; left as an optional owner action after a quiet month); two-way sync. |
| 11 | **Authorisation is a matrix the middleware enforces, not route by route.** Identity kinds: `owner` (Access JWT), `runner` (runner JWT), `job` (job token: `job_id`, `role`, `project_slug`, `exp` = lease). The matrix in "API and authorisation" is a table in code (`apps/api/src/auth/policy.ts`) with an inventory spec that fails on an unclassified route (the `owner-write-inventory.spec.ts` pattern). | One place to read who may do what; the threat model (#408) reviews a table, not 40 handlers. | Per-route checks only. |
| 12 | **Push and digest come from rows, not from GitHub.** `asks` and `owner_decisions` drive the "Needs you" list (a query, no pinned issue), web push (#11) fires on an `asks` insert, the daily digest is a scheduled job that renders from D1 (Phase 4); `owner-digest.yml` and `team:inbox` retire in Phase 6. | The inbox was rewritten by every run because GitHub could not query it; D1 can. | Keeping the pinned issue as a mirror. |

## Data model

Migration `0013_tracker` (#410; the number is the highest on `dev` + 1 when its PR opens, renumbered on rebase).
Timestamps are ISO 8601 UTC text; every table that belongs to a project carries `project_slug` referencing
`projects(slug)`; every write is a parameterised query in `@worker/db` repos. Text columns are bounded
(`title` ≤ 256, `body` ≤ 65,536, a comment ≤ 65,536, a verdict body ≤ 16,384) and stored as the owner or the role
typed them; rendering stays plain text or `tc-markdown` for team-authored text (CLAUDE.md, #20).

| Table | Columns (type, constraint) | Notes |
| ----- | -------------------------- | ----- |
| `projects` (altered) | `+ provider TEXT NOT NULL DEFAULT 'github'`, `+ tracker TEXT NOT NULL DEFAULT 'github'` (`github` \| `cutover` \| `console`), `+ key_prefix TEXT UNIQUE`, `+ next_item_number INTEGER NOT NULL DEFAULT 1`, `+ cutover_at TEXT`, `+ default_branch TEXT` | `tracker` gates every tracker write: `github` → 409 `tracker-not-cut-over`. |
| `labels` | `project_slug`, `name TEXT` (PK with slug), `color`, `description`, `builtin INTEGER` | Seeded from the plugin's `LABELS`; custom labels are the owner's. |
| `sprints` | `id INTEGER PK`, `project_slug`, `number INTEGER`, `title TEXT` (`Sprint NN`), `due_on TEXT` (date), `state` (`open` \| `closed`), `description TEXT`, `created_at`, `closed_at` | UNIQUE (`project_slug`, `number`); the freeze window is computed as today (`freezeDaysOf`). |
| `items` | `id INTEGER PK`, `project_slug`, `number INTEGER`, `kind` (`feature` \| `bug` \| `chore` \| `finding` \| `wow` \| `question`), `status` (`proposed` \| `approved` \| `in-progress` \| `qa` \| `done` \| `blocked`), `severity NULL`, `tier NULL`, `sprint_id NULL` → `sprints`, `title`, `body`, `closed_at NULL`, `closed_reason NULL` (`done` \| `not-planned` \| `duplicate`), `created_by_kind`, `created_by`, `created_at`, `updated_at`, `version INTEGER NOT NULL DEFAULT 1`, `source` (`console` \| `import`), `source_url NULL` | UNIQUE (`project_slug`, `number`). `status = 'done'` sets `closed_at`. `created_by` is a role name, the owner's login or the imported login — display only. |
| `item_labels` | `item_id` → `items`, `name` | PK (`item_id`, `name`); FK to `labels` by (`project_slug`, `name`). |
| `comments` | `id INTEGER PK`, `item_id`, `kind` (`comment` \| `decision` \| `note`), `author_kind` (`owner` \| `job` \| `runner` \| `system` \| `import`), `author TEXT`, `job_id NULL`, `body`, `created_at`, `source`, `source_url NULL`, `reversed_by_decision_id NULL` | Append-only. `decision` = `backlog decide` (team-decided); a `/reject` on it fills `reversed_by_decision_id`. |
| `asks` | `id INTEGER PK`, `item_id`, `category` (`money` \| `scope` \| `release` \| `access` \| `legal` \| `design`), `ask TEXT`, `commands TEXT` (JSON list from `ANSWERS`), `job_id`, `created_at`, `answered_by_decision_id NULL`, `withdrawn_at NULL` | One open ask per item at a time (partial unique index on `answered_by_decision_id IS NULL AND withdrawn_at IS NULL`). |
| `owner_decisions` | `id INTEGER PK`, `project_slug`, `item_id`, `ask_id NULL`, `command` (the plugin's `ANSWERS`: `approve` \| `reject` \| `go` \| `no-go` \| `done` \| `override` \| `resume` \| …), `text TEXT`, `decided_at`, `via` (`web` \| `push` \| `import`), `idempotency_key TEXT UNIQUE`, `reverses_comment_id NULL` | Owner identity only through the API. `via = 'import'` rows are written only by the import writer (never a job route), are history, and are ignored by the picker, the gate, asks and the transition table (R7). Replaces the owner comment line and `own_writes` replay (the key is the client's, 24 h). |
| `owner_requests` (recreated) | `id INTEGER PK`, `item_id`, `kind` (`sprint` \| `priority`), `payload TEXT` (canonical JSON), `requested_at`, `handled_by_job_id NULL`, `result NULL` (`applied` \| `declined`), `reason NULL`, `handled_at NULL` | Was a cache of GitHub comments (0012); becomes the record. Newest per item is the pending one. |
| `item_events` | `id INTEGER PK`, `item_id`, `at`, `actor_kind`, `actor`, `job_id NULL`, `kind` (`created` \| `edited` \| `status` \| `labels` \| `sprint` \| `closed` \| `reopened` \| `commented` \| `decided` \| `asked` \| `answered` \| `requested` \| `handled` \| `pr-linked` \| `imported`), `before TEXT`, `after TEXT` | Append-only audit; feeds `sprint-metrics` and the owner's "what changed". |
| `pull_requests` | `id INTEGER PK`, `project_slug`, `provider`, `external_id TEXT`, `number INTEGER`, `item_id NULL`, `head_ref`, `base_ref`, `head_sha`, `state` (`open` \| `merged` \| `closed`), `draft INTEGER`, `url`, `ci_state` (`success` \| `failure` \| `pending` \| `none` \| `unknown`), `synced_at` | Rebuildable from the adapter and webhooks; UNIQUE (`project_slug`, `number`). Phase 2. |
| `verdicts` | `id INTEGER PK`, `pull_request_id`, `head_sha`, `role` (`qa` \| `reviewer` \| `security`), `verdict` (`approved` \| `changes-requested`), `body`, `job_id`, `role_key_id`, `payload TEXT`, `signature TEXT`, `nonce TEXT UNIQUE`, `created_at` | Newest per (`pull_request_id`, `role`) on the current `head_sha` is the one the gate reads. Phase 2. |
| `runners` | `id TEXT PK` (ULID), `name`, `public_key_jwk TEXT`, `host TEXT` (JSON: `os`, `arch`, `hostname`), `capabilities TEXT` (JSON: `local`, `max_concurrency`, roles), `access_token_id TEXT` (the Access service token id, never the secret), `enrolled_at`, `last_seen_at`, `revoked_at NULL` | Phase 2 (enrolment) / Phase 4 (heartbeat). |
| `runner_enrolments` | `code_hash TEXT PK`, `created_at`, `expires_at`, `used_by_runner_id NULL` | One-time codes the owner generates; 10 minutes. |
| `role_keys` | `id INTEGER PK`, `runner_id`, `role`, `public_key_jwk`, `created_at`, `revoked_at NULL` | UNIQUE (`runner_id`, `role`) while unrevoked. |
| `jobs` | `id TEXT PK` (ULID), `project_slug NULL`, `kind` (`slot-pm` \| `slot-dev` \| `slot-qa` \| `burn` \| `audit` \| `review` \| `chat` \| `kickoff` \| `import` \| `digest`), `payload TEXT`, `priority INTEGER`, `state` (`queued` \| `claimed` \| `running` \| `finished` \| `failed` \| `lost` \| `cancelled`), `requested_by` (`schedule:<id>` \| `owner` \| `webhook` \| `job:<id>`), `dedupe_key TEXT`, `needs_local INTEGER NOT NULL DEFAULT 0`, `runner_id NULL`, `attempt INTEGER`, `created_at`, `claimed_at`, `lease_until`, `started_at`, `finished_at`, `result TEXT` (JSON: summary, metrics, `acted`) | Partial UNIQUE on `dedupe_key` while `state IN ('queued','claimed','running')` is the overlap guard (one `slot-dev` per project). Replaces `slot_requests`. |
| `job_events` | `id INTEGER PK`, `job_id`, `seq INTEGER`, `at`, `level`, `kind` (`started` \| `log` \| `notice` \| `acted` \| `metric` \| `paused` \| `finished` \| `failed`), `payload TEXT` | Append-only run log; batched (one row per ≤ 50 lines or 10 s) to stay inside D1's write budget. |
| `schedules` | `id INTEGER PK`, `project_slug NULL`, `kind`, `weekdays TEXT`, `time TEXT` (`HH:MM`), `timezone`, `enabled INTEGER`, `last_enqueued_at` | Replaces routine schedules (`reference/schedule-and-models.md`). |
| `team_state` | `project_slug PK`, `paused_at NULL`, `paused_by`, `failed_streak INTEGER` | `runlog pause|resume` and the three-failures stop. |
| `imports`, `import_map` | `imports`: `id`, `project_slug`, `source`, `state`, `started_at`, `finished_at`, `since`, `stats TEXT`; `import_map`: `project_slug`, `source_kind` (`issue` \| `milestone` \| `comment` \| `pr`), `source_id TEXT`, `target_table`, `target_id`, PK (`project_slug`, `source_kind`, `source_id`) | Idempotent re-runs; "find the old GitHub issue". Phase 1b. |

Dropped at Phase 6: `slot_requests`, the GitHub-comment semantics of `own_writes` (kept for owner-grade GitHub
writes of #386), the old `owner_requests`. The PM chat (ADR 0001 decision 11) moves to `chat_messages`
(`project_slug`, `author_kind`, `body`, `job_id`, `created_at`) in Phase 4; the demo page is an item with the
`team:demo` flag whose go/no-go is an `owner_decisions` row.

## API and authorisation

Routes under `/api/v1`, JSON, RFC 9457 problems with stable `type` slugs, `Idempotency-Key` on every write that
creates a row (24 h), `If-Match: "<version>"` on item updates (412 `item-version`), cursor pagination
(`?after=<id>&limit≤100`). Identity kinds and what they may do (`policy.ts`, inventory-tested):

| Route | `owner` | `job` (by role) | `runner` |
| ----- | ------- | --------------- | -------- |
| `GET …/projects/:slug/items[/:key]`, `/sprints`, `/prs`, `/items/:key/comments|events` | yes | yes | — |
| `POST|PATCH …/items[/:key]` (create, edit, status, labels, sprint, close) | yes | `pm`, `architect`, `orchestrator`, within the **transition table** (R5): `proposed → approved` where the decision policy makes it the owner's, `design:approved`, `owner:*` and closing a `team:demo` item happen only as the effect of an `owner_decisions` row in the same transaction (403 `transition-owner-only` for a job); removing `release-blocker` or `security` needs `security` or `pm` and writes an `item_events` row; `dev*`/`qa` only `status` of an item they hold | — |
| `POST …/sprints`, `PATCH …/sprints/:id` | yes | `pm` | — |
| `POST …/items/:key/comments` (`kind: comment|note`), `kind: decision` | yes (`comment`) | any role; `decision` any role but `dev-light` | — |
| `POST …/items/:key/asks` | — | any role except `dev*` | — |
| `POST …/items/:key/decisions`, `…/requests` | **owner only** | — | — |
| `POST …/requests/:id/handled` | — | `pm` | — |
| `POST …/prs/:number/verdicts` | — | `qa`, `reviewer`, `security` (signed) | — |
| `GET …/prs/:number/gate`; `POST …/prs/:number/merge` | yes (read) | `orchestrator` (merge, after the gate) | — |
| `POST …/jobs` (Run now), `POST …/team/pause|resume` | yes | `orchestrator` (`pause` on the failure streak) | — |
| `POST /runner/enrol` | — | — | enrolment code |
| `POST /runner/jobs/claim|:id/heartbeat|:id/events|:id/finish|:id/vcs-token` | — | — | yes (own jobs only) |
| `POST …/jobs/:id/children` (a sub-job token) | — | `orchestrator`, for non-verdict roles only (`pm`, `architect`, `dev*`, `devops`, `analyst`, `scribe`, `ux-designer`, `ui-designer`); never `qa`, `reviewer`, `security` | presented with the claiming runner's identity |
| `GET|POST …/projects/:slug/chat` (`chat_messages`, Phase 4) | yes | `pm` (the `chat` job) | — |
| `POST /runner/keys` (register a role key) | — | — | yes |
| `GET /settings/runners`, `POST /settings/runners/enrolment-code`, `…/revoke` | yes | — | — |

Role names are the plugin's agents (`reference/schedule-and-models.md`); the orchestrator (`slot-*`) is a role
too. A job token names exactly one role. A slot run that delegates to a non-verdict role agent asks for a
**sub-job token** (`POST …/jobs/:id/children`, same lease, role fixed, `requested_by = job:<parent>`); it is a
label for audit and least privilege, **not a boundary** — a subagent shares the orchestrator's process,
environment and filesystem. That is why verdict-capable roles are never children (decision 6): a slot that
needs a review enqueues `review` jobs and ends; the next slot run reads the gate. A job reads only its own
project (`project_slug` of the job) and, for a project-less job (`audit`, `digest`), the projects the job's
payload lists explicitly. Problems added: `tracker-not-cut-over`, `transition-owner-only`, `item-version`,
`item-key`, `verdict-role`, `verdict-signature`, `verdict-stale-head`, `verdict-replay`, `verdict-binding`,
`verdict-lineage`, `gate-blocked`, `job-lease-expired`, `job-runner-mismatch`, `runner-revoked`.

## VCS adapter

`@worker/vcs` (interface, types, error model, fixtures), `@worker/vcs-github` (Phase 3), `@worker/vcs-gitlab`
(Phase 5). Provider terms are neutral: "pull request" covers a merge request; `RepoRef` carries `provider`,
`owner`, `name` and the provider's id. The api Worker, the hooks Worker and the import job see only this
interface; `GitHubClient` becomes an implementation detail of `@worker/vcs-github`.

```ts
export interface VcsAdapter {
  readonly provider: 'github' | 'gitlab';
  capabilities(): VcsCapabilities;                 // mergeMethods, draft, checkRuns, fileSizeLimit
  repository(ref: RepoRef): Promise<Repository>;   // defaultBranch, visibility, htmlUrl, externalId
  branches: {
    get(ref: RepoRef, name: string): Promise<Branch | null>;
    list(ref: RepoRef, opts: PageOpts): Promise<Page<Branch>>;
  };
  files: {
    read(ref: RepoRef, path: string, revision: string, max: number): Promise<FileContent | 'not-found' | 'too-large'>;
    tree(ref: RepoRef, revision: string, opts: TreeOpts): Promise<Page<TreeEntry>>;
  };
  pullRequests: {
    get(ref: RepoRef, number: number): Promise<PullRequest | null>;
    list(ref: RepoRef, filter: { state: 'open' | 'closed' | 'all'; base?: string }, opts: PageOpts): Promise<Page<PullRequest>>;
    create(ref: RepoRef, input: { head: string; base: string; title: string; body: string; draft?: boolean }): Promise<PullRequest>;
    files(ref: RepoRef, number: number): Promise<Page<ChangedFile>>;
    updateBranch(ref: RepoRef, number: number): Promise<void>;     // merge base into head, never force
    comment(ref: RepoRef, number: number, body: string): Promise<void>;
    merge(ref: RepoRef, number: number, input: { method: MergeMethod; expectedHeadSha: string; title?: string }): Promise<MergeResult>;
  };
  ci: { status(ref: RepoRef, sha: string): Promise<CiState> };     // success | failure | pending | none | unknown
  webhooks: {
    verify(request: Request, secret: string): Promise<boolean>;
    parse(request: Request): Promise<VcsEvent | null>;            // normalised: pr.opened|synchronize|closed|merged, push, ci.completed, installation.*
  };
  credentials: {
    gitToken(ref: RepoRef, scope: 'read' | 'write', ttlSeconds: number): Promise<ScopedToken>; // per repo, never cached beyond ttl
  };
}
```

Rules: every method takes a `SubrequestBudget` through the adapter's constructor and throws `VcsError` with
`kind ∈ not-found | forbidden | rate-limited(retryAfter) | conflict | unavailable | too-large`, mapped once in
`mapError`; paths are built from `RepoRef` only (the `githubPath` rule); `merge` requires `expectedHeadSha` so a
push between gate and merge fails with `conflict`; `files.read` is what reads `.product-team/project.yml` from the
default branch for the review policy and `commands`. Webhook endpoints become `POST /hooks/:provider`; the
`hooks` Worker keeps its dedupe (`webhook_deliveries` gains `provider`) and only updates `pull_requests`, `ci_state`
and `cache_epoch` — never tracker rows. GitLab specifics (project access token vs OAuth app, `merge_requests`
approvals, pipelines as CI) are Phase 5 decisions inside this interface; the interface changes only if GitLab
cannot express a method, recorded as an amendment.

## Role keys and the gate

- **Keys.** Runner key and role keys are Ed25519 (JWK; `jose` EdDSA in the Worker and Node's `crypto` on the
  runner). Private keys live on the runner host in the **runner user's** home (`_tcrunner` on the Mac:
  `~/Library/Application Support/team-console-runner/<env>/keys/`, 0600, unreadable by the job user, outside
  every git worktree); the enrolment writes them; the console stores public JWKs only. Rotation = `POST
  /runner/keys` with a new key for the role, the old row `revoked_at`; revoking a runner revokes its keys and
  cancels its claimed jobs. Agents (the plugin scripts, the Claude Code process) never get a key path, an app
  key, the Access pair or the owner's credentials: their environment is `TC_API_URL` (the runner's loopback
  proxy), `TC_JOB_TOKEN`, `TC_RUNNER_SOCKET`, the job's working directory, `PATH`, and the job user's own Claude
  Code credential (`claude setup-token`, declared as a job-environment secret, revocable in claude.ai).
- **Key agent and proxy.** `TC_RUNNER_SOCKET` is a Unix domain socket the runner serves in a `_tcrunner:_tcjob
  0750` directory; the runner checks the peer uid (`getpeereid`) and the job token on every request:
  `{ jobToken, op: 'sign-verdict', payload }`, `{ jobToken, op: 'vcs-token', scope }`, or `{ jobToken, op:
  'api', method, path, body }` (R4: every console call of a job goes through here; the runner adds Access and
  its runner JWT). The runner looks the token up in its own table of jobs it launched, signs with that job's role
  key only, answers the console's VCS token for that job's repository only, and forwards API calls only for that
  job. Any other token, uid or role is refused and logged as a notice on the job. The console accepts a job token
  only together with the identity of the runner that claimed the job (`jobs.runner_id`, else 403
  `job-runner-mismatch`), so a job token is useless off-host.
- **Verdict payload** (canonical JSON, sorted keys, no whitespace):
  `{"body_sha256":"…","env":"<console aud>","head_sha":"…","issued_at":"…","job_id":"…","nonce":"…","pr":"<provider>:<owner>/<name>#<number>","role":"qa","v":1,"verdict":"approved"}`;
  `signature` = base64url(Ed25519(payload)). The console accepts it when: the job token is valid, running,
  presented with its runner, and names a `review` job whose payload is exactly this `pr`, `head_sha` and
  `role` (R6, else 409 `verdict-binding`); the PR belongs to the job's project; `role` equals the token's role
  and is a reviewer role; no job in the lineage (`requested_by = job:<id>`, followed to the root) pushed to that
  PR's head (else 403 `verdict-lineage`); the role key is the token's runner's unrevoked key for that role;
  `env` is this environment; the signature verifies; `issued_at` is within 10 minutes; `nonce` is unused;
  `head_sha` is the PR's current head (else 409 `verdict-stale-head`); `sha256(body)` equals `body_sha256`.
  `body` (the review text) is stored beside it.
- **Gate.** `required = policyOf(project.yml on default branch, changed files, security-check)` exactly as
  `ptlib/review.py` decides today (ported to `@worker/gate`, golden-tested against the plugin's fixtures); for each
  required role the newest verdict on the current head must be `approved`; CI must be `success` for that sha. The
  endpoint explains itself (`why`, `policy`) as `pr gate` does. `merge` re-runs the gate inside the same request
  and calls `pullRequests.merge` with `expectedHeadSha`; `--ci-only` is allowed only for `backmerge/`, `stage`
  cut and release PRs as `ci_only_allowed` decides. The plugin's `pr gate`/`pr merge` become thin calls.
- **Owner identity and the job's path through Access** (R4). The owner is Access's verified email (ADR 0001
  decision 7); no job or runner can mint an owner identity. Production keeps `ALLOW_SERVICE_TOKEN` off for
  `/api/*` except `/api/v1/runner/*` and `/api/v1/jobs/*`, where the service identity must additionally present a
  valid runner JWT whose `runners.access_token_id` equals the token's pinned id; a job token on any route is
  accepted only on a request carrying that runner identity. There is no Access bypass for job routes and no
  Access pair in a job's environment. `csrfMiddleware` exempts only requests authenticated by a bearer identity
  (`runner`, `job`); a request with an Access cookie keeps the same-origin and JSON rules as today.

## Runner and job queue

- **Enrolment** (owner, once per runner): the owner creates the runner's Access service token in Zero Trust and
  pins its id on Settings › Runners › "New runner", which then shows a one-time code (≥ 128 bits of entropy,
  10 minutes, single use, stored as a hash compared in constant time, `POST /runner/enrol` rate-limited per code
  and per IP) and the environment's URL. On the Mac, as `_tcrunner`, `team-console-runner enrol --env production`
  first stores the pasted Access pair (config 0600 — the console never sees the secret), then enrols through
  Access with the code, generates the runner key and the role keys, posts the public JWKs and stores the runner
  id. The runner installs as a LaunchDaemon from a tagged release, not writable by the job user.
- **Claim.** `POST /runner/jobs/claim { capabilities }` → `200 { job, jobToken, leaseSeconds }` or `204` with
  `Retry-After` (the poll interval: 20 s while the owner is active, 60 s otherwise). The claim is one statement:
  `UPDATE jobs SET state='claimed', runner_id=?, claimed_at=?, lease_until=?, attempt=attempt+1 WHERE id = (SELECT id
  FROM jobs WHERE state='queued' AND (needs_local=0 OR ?) AND (project_slug IS NULL OR project_slug NOT IN paused)
  AND (project_slug IS NULL OR project_slug IN <the runner's project allow-list>) ORDER BY priority DESC,
  created_at LIMIT 1) RETURNING *`. Priority: urgent (`release-blocker`, P0/P1) → nearest demo → freeze rules →
  the rest, computed when the job is enqueued (`picker.py`'s order). `review` jobs are enqueued by the console
  itself (on `pr.synchronize` for every role the gate requires, or on a slot's request) with
  `payload = {pr, head_sha, role}` and `requested_by = 'webhook' | 'job:<id>'`.
- **Run.** The runner prepares `work/<slug>/` (a bare mirror plus one worktree per job, owned by `_tcjob`,
  fetched with the job's read token), writes the credential helper and its token file in the runner user's
  directory — outside the worktree and outside any path a commit can include — and exposes it to the job through
  the socket (`op: 'vcs-token'`), vendors the plugin at `team.plugin_ref` read-only from the default branch's
  ref, and spawns the Claude Code CLI non-interactively **as the job user** through the job-exec wrapper with
  the skill prompt the job kind names, the job environment and a wall-clock limit (`payload.maxMinutes`,
  default 90; the process tree is killed at the limit). Concurrency per runner is `capabilities.max_concurrency`
  (1 on the Mac until per-slot job users exist — same-user processes can read each other's environment).
  `heartbeat` every 60 s extends the lease (5 min); a lease that lapses marks the job `lost` and requeues it once
  (`attempt ≤ 2`); a job `lost` twice is `failed` and the failure streak counts it.
- **Report.** `events` (batched) and `finish { result: finished|failed, summary, metrics, acted }` pass through
  the runner's redactor before they leave the host and the console's on arrival (`TC_JOB_TOKEN`, `ghs_`,
  `glpat-`, `eyJ`-prefixed tokens, `PRIVATE KEY` blocks — the existing sentinel tests extended). The
  three-failures rule, pause and resume live in `team_state`, read by `claim`. The console's board shows runner
  presence (`last_seen_at` ≤ 5 min), the queue and the current job; "Run now" enqueues with `requested_by =
  'owner'` and the `dedupe_key` refuses a duplicate with 409 `job-exists`; a claim from a new runner or a new
  source country (Access logs) is pushed to the owner.
- **Host-agnostic.** Nothing above names macOS except the user names: the same binary with a Dockerfile
  (`apps/runner/Dockerfile`, the job as a non-root user in the container) is the server runner;
  `capabilities.local = true` is what lets a job with `needs:local` reach the Mac. Two runners split the queue
  by the atomic claim; a job pinned to a runner is `payload.runner_id`; a runner serves only the projects on its
  allow-list (Settings › Runners).
- **Secrets on the Mac**, by user. `_tcrunner`: the Access service token pair, the runner key, the role keys.
  `_tcjob`: its own Claude Code credential and, for the job's lifetime, a job token and a one-hour per-repository
  VCS token reachable through the socket. Not on either: any GitHub/GitLab app key, `TOKEN_ENCRYPTION_KEY`. The
  owner's own macOS user — with its `gh` OAuth token, SSH keys, Keychain, browser profiles and any `PT_*_APP_KEY`
  still in a shell profile — is out of both users' reach; **that separation (L3 in the threat model) is a
  prerequisite of the first cutover**, because without it a job running as the owner can act as the owner
  through `gh` and read every key this model depends on. Until L3 exists the Mac runner serves fixture
  environments only, and #408 carries it as the top residual (RR1).

## Cutover

Per project; team-console first, storify second (Phase 6). Prerequisites: Phases 1–4 merged and deployed to the
team's environment, the R1 ruleset and the L3 job user verified on that environment, product-team 0.12
vendored, the runner enrolled and idle, the owner's separate «да» for that project (#310: «Отключение GitHub
Issues только после вашего отдельного „да"»).

1. **Dry-run import** (`jobs.kind = 'import'`, repeatable, **deterministic code with no model in the loop** —
   Worker or runner code that handles the most untrusted content in the system): milestones → `sprints`;
   issues → `items` (number kept, labels mapped through `labels`, unknown labels created as custom, state and
   `closed_at` kept, `source_url`); comments → `comments` (`author_kind = 'import'`, `author` = login,
   `created_at` kept); `pt-ask` → `asks` (open ones listed on the cutover screen for the owner to re-confirm,
   never re-executed); owner commands the plugin counted (owner login, unedited by REST timestamps — a heuristic
   good enough for history, not for authorisation) → `owner_decisions` with `via = 'import'` through the import
   writer only, ignored by the picker, the gate, asks and the transition table — the imported item's status and
   labels are the state; `pt-owner-request(-handled)` → `owner_requests`; `team-decided` comments →
   `comments.kind = 'decision'`; open and recent PRs → `pull_requests` through the adapter; `import_map` rows for
   all of it. The run log #22 stays on GitHub as an archive (linked from Settings), `job_events` starts fresh.
   Counts and a sample are shown on the cutover screen.
2. **Freeze.** `projects.tracker = 'cutover'`: the old plugin is paused (`runlog pause` on GitHub, the last GitHub
   write), the console shows the banner, Issues writes from the console stop.
3. **Final delta import** since `imports.since`; the screen compares open/closed per status and per sprint and
   the comment count with GitHub and refuses the switch on a mismatch.
4. **Switch.** `tracker = 'console'`, `cutover_at`, `next_item_number`, `key_prefix` confirmed; schedules enabled;
   the first job is `slot-pm`.
5. **Lock.** Each imported issue gets one comment «Перенесено в консоль: <link>» and is locked (`resolved`), in
   batches under GitHub's secondary limits, resumable through `import_map`; the run-log issue gets a final entry.
   Disabling Issues on the repository is an optional owner action after a quiet month.
6. **Retire — only after the 14-day rollback window closes** (Phase 6 PRs): `owner-digest.yml`, the
   `team:inbox` issue, `team.reviewer_logins`, `team.console_app_slugs`, the review app (owner deletes it), the
   team app's `PT_*_APP_KEY` on the Mac, `SLOT_*` secrets, `slot_requests`; ADR 0005's marker rules are
   superseded; `branch-guard.yml` stays (it is about the repository, not the tracker). Until then the GitHub-era
   credentials stay live, and the cutover screen lists them as "legacy, live until <date>" so the owner knows
   what still works.

Rollback inside 14 days: `tracker = 'github'`, unlock through `import_map`, re-pin the previous plugin; nothing is
written back from the console. After 14 days the GitHub side is history.

## Phases and issues

Rows are in **build order** (the phase numbers are the epic's: Phase 3's adapter is built before Phase 2's
gate because the merge goes through it); sizes are the architect's tiers (`reference/schedule-and-models.md`);
`security` where the issue touches keys, identities, imports or VCS writes. The mitigations #408 assigns to a
phase ("Mitigations by phase") are criteria of that issue. The PM opens the issues not yet numbered.

| Phase | Issue | Scope | Tier | Depends on |
| ----- | ----- | ----- | ---- | ---------- |
| 0 | #407 (this), #408 threat model, #409 UX spec | decision | heavy / heavy / standard | — |
| 1a | #410 | migration `0013_tracker` for `projects` (altered), `labels`, `sprints`, `items`, `item_labels`, `comments`, `item_events`; owner-only API for items, sprints, comments, labels; plain-text and bound checks; `tracker` gate; the transition table's status/flag rules (R5) | heavy, security | #407, #408 |
| 1a′ | new | `asks`, `owner_decisions` (`via` incl. `import`), `owner_requests` (recreated), `import_map` stub; decision/ask/request routes; decision effects in the transition table (R5); Needs-you read model from D1 (`inbox.py` port over rows) | heavy, security | #410 |
| 1b | #107, #108 | create from the phone and the board by sprint, console-native (no GitHub write, no request marker: the sprint wish is `owner_requests`) | standard | 1a′, #409 |
| 1b | new | edit item, comment, decide (approve/reject) screens from #409; sprint create/move | standard | 1a′, #409 |
| 1b | plugin | product-team 0.12: `ptlib/console.py`, `backlog`/`inbox`/`slot-context`/`demo-page`/`digest`/`sprint-metrics` on the console API, GitHub mode removed; `slot-qa` enqueues `review` jobs instead of dispatching reviewers in-process (R2) | heavy (plugin repo) | 1a′ |
| 3 | new | `@worker/vcs` + `@worker/vcs-github` over `GitHubAppAuth`/`GitHubClient`; `credentials.gitToken` minted with the least permission set per role, never `checks`/`statuses`/`administration`/`actions`, `workflows: write` only on a `workflow-change` item (R1, R8); `team-console/gate` commit status; owner `access` question for the permission change **and** the ruleset on `dev`/`stage`/`main` (PR required, gate status from the console app, no bypass, no force-push or deletion); deploy secrets in environment-scoped GitHub Environments; `hooks` → `/hooks/github` normalised, `pull_requests` sync; #197 private-repo CI reads | heavy, security | 1a |
| 2 | new | `runners`, `runner_enrolments` (entropy, constant-time compare, rate limit, Access before enrol), `role_keys`, `jobs` (claim/finish/children only), `pull_requests`, `verdicts`; runner JWT (`iat`, `jti`) and job-token middleware (job token only with its runner, R4), `policy.ts` + inventory spec incl. `/children` (never reviewer roles, R2); `POST verdicts` with every check of "Role keys" (R2, R6, `env`, `body_sha256`, lineage), `GET gate` (`@worker/gate` port of `review.py`), `POST merge` through the adapter; CSRF exemption for bearer identities only; Settings › Runners (enrolment code, revoke, project allow-list) | heavy, security | 1a, 3 |
| 2 | new | `apps/runner` v0: `enrol`, `run-once --job <id>`, key agent + API proxy socket with peer-uid check, credential helper outside the worktree, redactor; plugin `pr review|gate|merge|push|commit` on the console | heavy, security | 2 (API) |
| 4 | new | `schedules` + Cron Trigger, claim with priority, pause and allow-list, heartbeat/lease/lost, `job_events` (`runlog` port), `review` jobs enqueued on `pr.synchronize`, **L3 on the Mac**: LaunchDaemon under `_tcrunner`, jobs as `_tcjob` through the job-exec wrapper and one sudoers rule, `max_concurrency = 1`, kill at `maxMinutes`, `Dockerfile` for the server runner, Run now → enqueue, `team_state`; chat → `chat_messages` + `chat` job (#17 lands here); digest job + push from `asks` (#11 reused) | heavy, security | 2, 3 |
| 4 | #109, #238/#386 | analytics over `item_events`/`jobs`; #386 rewritten for the runner (ADR 0007) | standard / heavy | 4 |
| 1b | new | import job (deterministic code, R7) + cutover screen (dry run, counts, pending re-confirmation, switch, lock, legacy credentials list) | heavy, security | 1a′, 3 (adapter reads), #409 |
| 5 | new | `@worker/vcs-gitlab`, GitLab owner connection, `/hooks/gitlab`, registry `provider`; protected branches with "allowed to push: no one", merge only through the console's token, an external status check (R1 for GitLab) | heavy, security | 3, 4 |
| 6 | new | cutover of team-console, then storify (R1 and L3 verified on the team's environment first); retire markers, `owner-digest.yml`, review app, `PT_*` keys, `SLOT_*` only after the 14-day window; ADR 0005 superseded; ADR 0003 decision 8's asset row updated for the app's write reach; plugin 0.12 release | heavy, security | 1b, 4 |

Obsolete by this ADR (the PM closes with the #310 plan): #235, #110, #26, #340, #271, #98, #338 and the
GitHub-read findings #99, #115, #167, #185, #202, #266 where the cutover removes the surface.

## Threat model

Owned by #408 (`docs/security/309-threat-model.md`, PR #415), which this ADR follows: its R1–R9 are the
amendments of 2026-11-04 and its L3 is the Mac's user layout. Boundaries and the controls fixed here: the VCS
enforces the gate (R1: least-privilege job tokens, `team-console/gate` status, the ruleset); no self-review (R2:
reviewer roles only as console-enqueued `review` jobs, lineage check); the runner host (L3: `_tcrunner` /
`_tcjob`, a prerequisite of the first cutover; a stolen Access pair + runner key is the top remaining asset —
`revoked_at`, claimed jobs cancelled, new-runner push); the job's path through Access (R4: proxy through the
runner, job token only with its runner, bearer-only CSRF exemption); owner-only transitions (R5); verdict
binding and replay (R6: PR ∈ project, payload match, `env`, `nonce`, `issued_at`, `head_sha`, `body_sha256`);
the import (R7: deterministic code, imported rows never authorise, pending asks re-confirmed); workflow and
deploy secrets (R8); the small gaps (R9: enrolment entropy and order, `jti`, read scope, redactor, credential
helper location, retire after the window, matrix completeness). Prompt injection from item text, comments and
imported content into a role run stays bounded by rows being data, the plugin's untrusted-content rule, R1 and
L3. The `hooks` Worker keeps its controls and never writes tracker rows. Each mitigation that needs code is a
criterion of the phase issue above; #408's "Mitigations by phase" is the checklist per row.

## Free-tier budget

| Resource | Use | Headroom |
| -------- | --- | -------- |
| D1 writes (100,000/day) | polling writes nothing; a job writes `claimed`, `running`, `finished` + batched events (≤ 1 row/10 s) ≈ 600 rows per 90-minute job; tracker edits are tens per day | ~50 jobs/day before it matters; events batch harder if it does |
| D1 reads (5 M/day) | claim every 20–60 s ≈ 4,320/day/runner; board and lists are indexed queries | fine |
| Workers requests (100,000/day) | runner polling ≈ 4,320/day/runner + heartbeats | fine |
| Cron Triggers (5) | one (`*/5 * * * *`, schedules) | 4 left |
| Subrequests (50/request) | adapter calls are budgeted per request as today; the tracker needs none | the board no longer reads GitHub for items |
| Zero Trust service tokens | one per runner | fine |
| Claude Code on the Mac | the owner's subscription, as the routines drew it; `jobs.priority` and `max_concurrency = 1` are the throttle | the queue shows what waits |

## Consequences

- #410 is larger than one heavy issue: it is split into 1a (tracker core) and 1a′ (decisions, asks, requests,
  Needs-you) above; the PM opens 1a′ and the Phase 1b–6 issues from the table.
- Phase 2 moves ahead of a full runner on purpose: `jobs`, `runners` and the key agent arrive with the gate so the
  gate can be tested end to end with `run-once`; Phase 4 adds scheduling and the daemon.
- The environment that holds the tracker is an **open owner question**: dev is the only deployed console today
  (`console_app_slugs: [team-console-dev]`, production URL empty). The team's recommendation is that real
  products live in **production** (#152) and dev/stage keep fixtures, so a broken `dev` deploy cannot take the
  team's own tracker down; production therefore becomes a prerequisite of the first cutover. Until the owner
  answers, Phases 1–5 are built and verified on dev with fixtures and the fake GitHub.
- The console app's permission change (Contents, Pull requests, Workflows write) **and the ruleset** on `dev`,
  `stage` and `main` (PR required, `team-console/gate` from the console app, no bypass actors, no force-push or
  deletion) are one owner `access` question asked when Phase 3 is planned; until both are in place the console
  merges nothing and the runner pushes nothing. ADR 0003 decision 8's asset row is amended in that PR: the
  app key's reach grows from Issues write to Contents/PR/Workflows write, bounded on long-lived branches by the
  ruleset.
- The dedicated macOS users (L3: `_tcrunner`, `_tcjob`, a LaunchDaemon, one sudoers rule — an admin password
  once) and a `claude setup-token` credential for the job user are owner actions at Phase 4 and a prerequisite of
  the first cutover; #408 asks them. Until then the Mac runner serves fixture environments only.
- Rework rounds change shape: a slot run enqueues `review` jobs and ends instead of dispatching reviewers in the
  same session; the next slot run reads the gate. Reviews therefore cost one more job each, with no shared
  context between the developer and the reviewer — which is the point.
- Items are `TC-310`, not `#310`: branch names, PR titles and the plugin's `link-pr` change in 0.12; the UX spec
  shows the key.
- `.product-team/project.yml` stays the review policy's home; `team.reviewer_logins`, `team.console_app_slugs`,
  `team.run_log_issue` and `team.plugin_ref` change: the first three retire at Phase 6, `plugin_ref` stays.
- `@shared/owner-grammar` shrinks to what the console still writes on GitHub (nothing after Phase 6); the golden
  fixtures move to the API contracts (`@shared/contracts`) and the plugin's `console.py` is tested against the
  same fixtures from the console side.
- ADR 0005's provenance rules are superseded at cutover; ADR 0003's owner-token writes remain for #386
  (repository creation) only. ADR 0001's "GitHub is the source of truth" sentence no longer holds for the tracker.
- `CLAUDE.md`'s first rule ("backlog in GitHub Issues") changes with Phase 6, not before.

## Not yet

- A second owner or a per-project collaborator (Zero Trust's 50 users allow it; the authorisation matrix has no
  such kind on purpose).
- Verdicts mirrored to the VCS as PR comments for humans (one adapter call; decide when someone outside the
  console needs them).
- Durable Objects or Queues for the job queue (if runners grow past a handful, or long-poll claims are wanted).
- Per-slot job users (`_tcjob1…n`) or a Linux VM/container for jobs on the Mac (the threat model's L4) — needed
  only before `max_concurrency > 1`; storing the runner's keys in the macOS Keychain instead of 0600 files.
- GitLab-specific CI (pipelines) and approvals beyond what `VcsAdapter` expresses.
- A native runner UI on the Mac (menu bar); the console is the UI.
