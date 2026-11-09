# #309 threat model — the console as the source of truth

Issue #408 (Phase 0 of #309). Date: 2026-11-04. Author: the security role. Reviews the target architecture in
[ADR 0006](../decisions/0006-console-source-of-truth.md) (`docs/decisions/0006-console-source-of-truth.md`, PR #412,
reviewed at its head `319037e`; section names below are the ADR's). The security review of PR #412 asked for
changes. Its findings 1–9 are referred to here as **R1–R9**, and all of them landed in the ADR at `319037e`. Where
this model asks for more than that ADR text says, the row names the criterion, and "ADR wording to align" below
lists the differences. Builds on the earlier models of ADR 0001
decision 8 and ADR 0003 decision 8, which stay in force for what they cover (Access, the SPA, the `api` and
`hooks` Workers, owner OAuth). Amended 2026-11-09 with [ADR 0008](../decisions/0008-multi-tenant-console.md)
(multi-tenant console, two execution modes): components C9–C11, residuals RR11–RR14 and owner questions 4–7
below; revised the same day after the SECURITY review of PR #460 (deny-by-default route scope, the Actions
packaging's auth design, hosted network isolation and key release, the spend reservation, the pinned trust root,
sign-in and invite flows, the sealing envelope). "The owner" in every row now means an `owner` member of the
project's account, and "the Mac" rows describe one of the runner's isolation backends (`user`), not the product's
only host. The "Where" column cites ADR 0008's "Delivery" ids (T-1…T-6, H-1, H-2, 2-0, 2-A, 2-B, 2-C, 2-E, 3a,
3b). Owner questions 4–7 were **decided by the owner on 2026-11-09 in the team chat** (recorded on #446) as
recommended.

Severity: **Critical** (owner impersonation or an unreviewed merge into a long-lived branch with no further
barrier), **High** (one control away from that), **Medium** (a bounded integrity, availability or disclosure loss),
**Low** (needs an unlikely precondition or yields little). STRIDE letters: **S**poofing, **T**ampering,
**R**epudiation, **I**nformation disclosure, **D**enial of service, **E**levation of privilege.

## What must hold

1. Only the owner can make an owner decision (approve, reject, go/no-go, override, done, design approval,
   request), and nothing a job, a runner or imported text writes can be read as one.
2. A PR reaches `dev`, `stage` or `main` only when the gate passes on its current head. Every required verdict
   must come from a separate review run of the required role, never from the run that wrote the code.
3. A compromised job (prompt injection, a malicious dependency, a bad model output) is limited to its own role,
   its own project, its own repository and its own lease.
4. Agents never see a secret value other than their own short-lived job token (and, with a dedicated job user, the
   Claude Code credential; see "Dedicated macOS user").

## Assets, storage and rotation

| Asset | Grade | Where it lives | Who can use it | Rotation / revocation |
| ----- | ----- | -------------- | -------------- | --------------------- |
| Owner Access session (`CF_Authorization`, Access JWT) | owner | the owner's browser / PWA | the owner | Access session 24 h; revoke in Zero Trust |
| Owner OAuth token pair (ADR 0003) | owner, on GitHub | D1, sealed with `TOKEN_ENCRYPTION_KEY` (Worker secret) | `api` Worker, owner-grade writes only (#386 after cutover) | revoke the grant on GitHub; disconnect deletes the row |
| GitHub App private key (per env) | repo write on every installed repository from Phase 3 (Contents, Pull requests, Workflows) | `api` Worker secret only | `api` Worker | new key in the app settings, `wrangler secret put`, delete the old key |
| Per-job VCS write token | repo write for one repository, ≤ 1 h | minted by the `api` Worker, handed to the runner, held in the credential helper of one job | the job (through git) | expires in ≤ 1 h; not revocable early on GitHub except by uninstall (residual) |
| Read installation tokens | repo read | Worker memory per request | `api` Worker, import job | ≤ 1 h, never persisted |
| Webhook secret | event forgery (one env) | `hooks` Worker secret | `hooks` Worker | rotate in the app + `wrangler secret put` |
| `CLOUDFLARE_API_TOKEN` | owner-grade (redeploys the `api` Worker) | GitHub Environment secret | `deploy.yml` on long-lived branches | rotate in Cloudflare |
| Runner private key (Ed25519) | runner identity | runner host: the runner's key directory, 0600, the runner user only | the runner process | `runners.revoked_at` + re-enrol; revoke cancels claimed jobs |
| Access service token pair (per runner) | gets through Access on `/api/v1/runner/*` (and, with R4, job routes proxied by the runner) | the runner's config, 0600, the runner user only; the console stores only its id | the runner process | rotate or delete in Zero Trust; re-pin the id on Settings › Runners |
| Role private keys (Ed25519, per runner × role) | sign verdicts of that role | runner host, same directory as the runner key | the key agent inside the runner | `POST /runner/keys` with a new key, old row `revoked_at`; revoking the runner revokes all |
| Job token | one role, one project, one lease | the job process environment (`TC_JOB_TOKEN`) | the job, through the runner's proxy (R4) | lease-bound `exp`; refused after `finish`, `lost`, `cancelled` or a runner revoke |
| Enrolment code | creates a runner | the owner's screen; `runner_enrolments.code_hash` | whoever types it in 10 min | single use, 10 min |
| Claude Code credential of the job user (only with a dedicated job user) | the owner's Claude subscription | `_tcrunner`'s config, 0600. The runner injects it **per job** into the job's environment (or the job's fresh `HOME`, wiped after the job); it never rests in a home `_tcjob` keeps between jobs. | the job, for its lifetime | `claude setup-token` again; revoke in claude.ai |
| The owner's own credentials on the Mac (`gh` token in the Keychain, SSH keys, browser profiles, `~/.zshenv` app keys until Phase 6) | owner, on GitHub and beyond | the owner's macOS user | any process running as the owner | out of scope of the console; see C4 |
| The tracker (D1 rows), verdicts, job events | integrity of every decision | D1 of the team's environment | `api` Worker | D1 Time Travel (7 days on the Free plan) for restore; append-only tables |
| Customer inference key (BYOK, ADR 0008) | the customer's Anthropic spend | D1, sealed under `INFERENCE_KEY_ENCRYPTION_KEY` (a Worker secret separate from `TOKEN_ENCRYPTION_KEY`), AAD per account and key id | the hosted dispatcher only (one repo method); released once into the job's sandbox | rotate/revoke in Settings (new `key_id`); root-key rotation by `root_key_version` |
| `INFERENCE_KEY_ENCRYPTION_KEY` | every customer's inference key in this environment | `api` Worker secret only | `api` Worker | `wrangler secret put` + re-seal on next use; versioned |
| Hosted-provider API token (Fly, scoped to the runner apps) | create/delete machines in every account's runner app; read machine config (which holds **no** key) | `api` Worker secret only | the hosted dispatcher | rotate in the provider; never an org token |
| Bootstrap token (hosted) / GitHub OIDC token (Actions) | claims exactly one job once | the machine's start environment / GitHub's runtime | the machine that presents it, within 10 min / the run | single use; hashed in `jobs.bootstrap_token_hash`; OIDC verified against `run_id` and the job id |
| Session cookie `__Host-tc_session` (ADR 0008) | a customer user | the user's browser | the user | 24 h idle / 30 d absolute; "sign out everywhere"; rotated on sign-in |
| `.product-team/project.yml` on the default branch | the review policy and `commands` the jobs run | the repository | anyone who can merge | reviewed PRs only (gate + R1 ruleset) |

**Agents never see secret values.** The job environment is `TC_API_URL`, `TC_JOB_TOKEN`, `TC_RUNNER_SOCKET`, the
worktree and `PATH`, plus the Claude Code credential the runner injects per job once jobs run as their own user.
`TC_API_URL` is HTTP over the runner's Unix socket, not a TCP loopback port: any local user can reach a loopback
port, while the socket checks the peer uid. The job token is a credential
the job is meant to hold. It names one role and one project and is useless off-host once R4 lands. No key path, app
key, service token, VCS app key, owner token or `TOKEN_ENCRYPTION_KEY` is passed to a job. Whether a job can *reach*
one anyway depends on the operating-system boundary between the runner and the job (C4). Until the dedicated job
user exists, the honest statement is "agents are not given secret values", not "agents cannot read them".

## Trust boundaries

| # | Boundary | Crossed by |
| - | -------- | ---------- |
| TB1 | Internet → Cloudflare Access → `api` Worker | owner (Access JWT), runner (service token + runner JWT), jobs (via the runner, R4: Access must admit the runner's service token on `/api/v1/projects/:slug/*` too, where the Worker still requires the runner JWT **and** the job token) |
| TB2 | `api` Worker → D1 | parameterised repos in `@worker/db`; `policy.ts` decides before any write |
| TB3 | `api` Worker ↔ VCS provider | `VcsAdapter`: app JWT, installation tokens, merge; per-job write tokens out to the runner |
| TB4 | VCS → `hooks` Worker (public) | HMAC-signed webhooks; only `pull_requests`, `ci_state`, `cache_epoch` written |
| TB5 | Runner process ↔ job process (on the runner host) | `TC_RUNNER_SOCKET` (key agent, VCS-token and API proxy), the worktree, the job environment |
| TB6 | Job process ↔ untrusted content | item text, comments, PR bodies, diffs, dependency code, web pages, imported GitHub history |
| TB7 | Job process ↔ the owner's macOS session | the file system, Keychain, `ps`, other processes of the same user |
| TB8 | GitHub Issues (history) → D1 at cutover | the import job, through the adapter's read token |

## STRIDE per component

Each row names its mitigation's home: an ADR section (already decided) or the phase issue whose acceptance criteria
must carry it. "Phase 2 API" and similar refer to the rows of the ADR's "Phases and issues" table.

### C1 — Owner identity (Access, the PWA)

| Threat | STRIDE | Mitigation | Where | Residual |
| ------ | ------ | ---------- | ----- | -------- |
| A job or runner presents itself as the owner | S, E | The owner is only the Access JWT whose `email` = `OWNER_EMAIL`. The service identity never maps to `owner`. `owner_decisions` and `owner_requests` writes refuse every non-owner kind (403), checked in `policy.ts` and inventory-tested. | Phase 1a′ | Low |
| Cross-site request rides the Access cookie to `POST …/decisions` | S | The existing CSRF middleware on every owner write. Runner/job routes are exempt only for bearer identities (R4). A route that accepts both is a test failure. | Phase 1a, Phase 2 API | Low |
| XSS in the SPA posts decisions | E | Unchanged ADR 0003 decision 8 controls (CSP, DOMPurify, plain text for imported and team text, confirmation for `go`/`override`) | existing; Phase 1b screens keep them | Medium (an XSS is an owner session) |
| A decision is disputed later | R | `owner_decisions` is append-only with `decided_at`, `via` and `idempotency_key`; Access logs hold the login | Phase 1a′ | Low |
| A job flips owner-semantic state directly (`status:approved` that needs the owner, `design:approved`, `owner:*`, closing `team:demo`) | E | R5: a transition table in `policy.ts`. These changes happen only as the effect of an `owner_decisions` row in the same transaction. | Phase 1a (status/flags), Phase 1a′ (decision effects) | Low after R5; **High** without it |

### C2 — Tracker API (items, comments, asks, requests, jobs, gate, merge)

| Threat | STRIDE | Mitigation | Where | Residual |
| ------ | ------ | ---------- | ----- | -------- |
| A route nobody classified becomes reachable by `job` or `runner` | E | `policy.ts` matrix + inventory spec that fails on an unclassified route (ADR decision 11). `…/jobs/:id/children` and `chat_messages` routes are listed before their phases (R9g). | Phase 2 API (matrix), every later phase | Low |
| A job reads or writes another project (IDOR across `project_slug`) | I, T | Every job route checks `token.project_slug = :slug`. Jobs with no project (audit, digest) get an explicit read-only cross-project scope. Writes always need a project. | Phase 2 API (R9c) | Low |
| A `dev`/`qa` job edits items it does not hold | T | "Holds" = the job's payload names the item, enforced in `policy.ts`; every change is an `item_events` row with `job_id` | Phase 1a, Phase 2 API | Low |
| Lost update or a stale edit overwrites the owner's change | T | `items.version` + `If-Match` (412 `item-version`) | Phase 1a | Low |
| An over-long or binary body breaks rendering or the D1 row budget | D, T | Bounded columns; plain text / `tc-markdown` rendering; `withoutInvisibles` on display | Phase 1a | Low |
| The team's tracker writes are denied by D1 free limits (a runaway job writes events) | D | `job_events` batching; a per-job event cap with a `notice` and a stop at the cap; per-project write budget alarm in the digest | Phase 4 | Medium (the free tier is the ceiling) |
| `merge` passes a PR whose head changed after the gate | T | Gate re-run inside `merge`; `expectedHeadSha` on the provider call (`conflict`) | Phase 2 API, Phase 3 | Low |
| The gate is relaxed by the PR itself | T, E | Policy read from the default branch only; changed files from the adapter; CI on the exact SHA | Phase 2 API (`@worker/gate`, golden-tested against `review.py` fixtures) | Low |
| Job events or summaries leak a token | I | Redactor on `events`/`finish` for `TC_JOB_TOKEN`, `ghs_`, `glpat-`, `eyJ`, `PRIVATE KEY`; sentinel tests extended | Phase 2 runner v0, Phase 4 (R9d) | Low |

### C3 — Role keys, the key agent and verdicts

| Threat | STRIDE | Mitigation | Where | Residual |
| ------ | ------ | ---------- | ----- | -------- |
| **A dev job forges a QA / REVIEW / SECURITY verdict** with its own token | S, E | The console refuses `POST verdicts` from a non-reviewer role before the signature check (403 `verdict-role`). The key agent signs only with the role of the token presented. | ADR decision 6; Phase 2 API, Phase 2 runner v0 | Low |
| **The orchestrator (or the dev agent in the same Claude Code session) obtains a reviewer token** through `POST …/jobs/:id/children` and approves its own work | S, E | R2: reviewer roles are never children. They run only as top-level `review` jobs enqueued by the console with payload `{pr, head_sha, role}`. The console refuses a verdict whose job lineage includes a job that pushed to that PR's head. The lineage follows **child-token parentage** (a sub-job token's parent, up to the root job), not who enqueued the review. Otherwise every review a slot enqueued would be refused, or a rule weakened to let them pass. The enqueue route (`POST …/prs/:number/reviews`, `orchestrator`) is in the matrix and takes no role or SHA: the console derives the required roles from the gate and `head_sha` from the PR's current head. | Phase 2 API, Phase 2 runner v0, plugin 0.12 (`slot-qa` enqueues reviews instead of dispatching them) | Low after R2; **Critical** without it, because the session that wrote the code approves it |
| A reviewer job of project A, or of PR 1, approves PR 2 or project B | E | R6: `pr` must be in the job's project and equal the review job's payload; `head_sha` must equal the payload's and the PR's current head | Phase 2 API | Low |
| **Replay of a signed verdict** (an old approval on a new head, the same approval twice, an approval from another environment) | T | Signed `head_sha` + check against the current head (409 `verdict-stale-head`); `nonce` UNIQUE (409 `verdict-replay`); `issued_at` ≤ 10 min; `pr` names provider/owner/repo/number; the job must be running. Add `env` (the console's `aud`) to the signed payload so a dev-environment signature is never valid on production. | ADR "Role keys and the gate"; `env` field: Phase 2 API | Low |
| A same-user process reads the role key files and signs anything | S, E | Dedicated job user (C4, "Dedicated macOS user") | Phase 4 (prerequisite of the first cutover) | **High** until then |
| A job on a concurrent runner slot reads another job's token from its environment (`ps eww` shows environments of the same user's processes; verify on macOS 26) | S | `max_concurrency = 1` on the Mac. A per-job uid (`_tcjob1…n`) or container before concurrency > 1. | Phase 4 | Low at concurrency 1 |
| **A job leaves state that runs inside the next job on the same `_tcjob` uid**: a `SessionStart` hook or instructions in `~/.claude/settings.json` / `~/.claude/CLAUDE.md`; `core.hooksPath`, `core.fsmonitor` or `include` in the shared bare mirror; a poisoned `~/.npmrc`, `~/.gitconfig` or shell profile; a `~/Library/LaunchAgents` plist; a detached (`setsid`/double-fork) process that survives the tree kill. The next `review` job runs that code with its own token, passes the peer-uid and token checks and signs `approved`, which undoes R2. Concurrency 1 does not help: the jobs are sequential. | E, T | (a) A fresh per-job `HOME` and `TMPDIR` created by the runner and wiped after the job. `_tcjob`'s account home (`NFSHomeDirectory`) is root-owned and not writable, so launchd and tools find nothing to load. Claude Code runs with runner-owned, read-only **managed settings** with user and project hooks disabled. (b) The bare mirror is owned by `_tcrunner` and read-only to `_tcjob`. Each job gets a fresh clone (or a worktree whose config the runner writes), and the runner refuses to launch when that clone's config holds `core.hooksPath`, `core.fsmonitor`, `include`/`includeIf` or any `*.hooks`-type key. (c) `pkill -9 -u _tcjob` before and after every job, and the runner launches the next job only when no `_tcjob` process remains. (d) A sweep of `_tcjob`-owned files outside the per-job directories (`/tmp`, `/private/var/tmp`, `/Users/Shared`), with removal and a `notice`. (e) A test: one job plants a Claude hook, a git config entry, an `.npmrc` and a detached process, and the next job observes none of them. | Phase 2 runner v0 (a, b, e), Phase 4 (c, d, the L3 layout) | Low after (a)–(e); **High** until then (it defeats reviewer separation) |
| The review text (`body`) is altered after signing | T | `body` is stored beside the signature, not in it. Sign `sha256(body)` in the payload so the text the owner reads is the text that was signed. | Phase 2 API | Low |
| Who approved what cannot be shown later | R | Verdict rows keep `payload`, `signature`, `role_key_id`; the public key stays in D1 after revocation | Phase 2 API | Low |

### C4 — Runner, enrolment and the runner host

| Threat | STRIDE | Mitigation | Where | Residual |
| ------ | ------ | ---------- | ----- | -------- |
| **A stolen runner credential** (the runner key copied off the host; with Access in front, also the service-token pair) | S, E | With Access optional for customer runners (ADR 0008 "Customer runner authentication without Access") **the runner key alone suffices** on `/api/v1/runner/*`, so it is protected as the asset it is: stored in the OS keychain where the runner has one (macOS Keychain with an ACL for the runner binary) or as a 0600 file owned by the runner user (`_tcrunner`, unreadable by `_tcjob` and by the owner's login user); revoke = `runners.revoked_at` (and, where used, deleting the service token in Zero Trust); revoking cancels claimed jobs and revokes role keys. Runner JWT `exp` ≤ 5 min with `jti` reuse refused (R9b). **Detection**: Settings › Runners shows `last_seen_at`, host and the source country of the last claim; the console alerts the owner on a claim from a **new IP country** (`request.cf.country` of the claim request) and on **two pollers using one runner id** (claims or heartbeats from two source addresses inside one lease, or a `jti` sequence that interleaves) and marks the runner suspect until the owner confirms. | 2-A (alerts, keychain/0600), Phase 4 (daemon) | **High, per runner**: the key gives every role's job tokens and per-job write tokens for every job that runner may claim until revoked; the blast radius is one account's `allowed_projects`, and detection is by the owner. |
| **A job reads the runner's secrets on the same host** (same macOS user) | E, I | Dedicated unprivileged job user; the runner and its keys under another user (see the section below) | Phase 4, prerequisite of cutover | **Critical** until then on the team's environment (the job also reaches the owner's `gh` token via `gh auth token`); Medium after |
| A job reaches the owner's own credentials (`gh`, SSH, Keychain, `~/.zshenv` `PT_*_APP_KEY`) | E, I | Same as above; `PT_*` keys retire in Phase 6 | Phase 4, Phase 6 | **Critical** until the job user exists |
| Brute force or theft of an enrolment code | S | ≥ 128-bit code (or rate limit per code and per IP); constant-time hash compare; 10 min; single use; `enrol` passes Access, so the service token is pasted first (R9a); a new runner shows on Settings and in a push | Phase 2 API | Low |
| A rogue runner claims jobs of a project it should not run (a server runner and the Mac) | E | `capabilities` and `payload.runner_id` pinning; per-runner project allow-list on Settings › Runners | Phase 4 | Low |
| A dead or sleeping runner holds the queue | D | Lease 5 min, `lost` → requeue once, `failed` counts the streak | Phase 4 | Low |
| A job outlives its lease or keeps its token after `finish` | E | Token `exp` = lease; refused after `finish`/`lost`/`cancelled`; the runner kills the process tree at `maxMinutes` | Phase 2 API, Phase 4 | Low |
| The runner binary or its dependencies are tampered with | T | `apps/runner` built from a tagged release, `npm ci` with pinned versions, installed under the runner user and not writable by the job user | Phase 4 | Medium (supply chain) |
| The vendored plugin at `team.plugin_ref` is swapped by a job | T | Vendored read-only per job from the default branch's ref, outside the worktree the job can commit | Phase 2 runner v0 | Low |

### C5 — VCS adapter, the app and per-job tokens

| Threat | STRIDE | Mitigation | Where | Residual |
| ------ | ------ | ---------- | ----- | -------- |
| **A job merges or pushes to `dev`/`stage`/`main` directly with its write token, bypassing the gate** | E, T | R1. Job tokens are minted with `contents: write` (+ `pull_requests: write` only if the runner creates PRs) and never `checks`, `statuses`, `administration` or `actions`. The console posts `team-console/gate` on the head SHA. A ruleset on long-lived branches requires a PR and that check with expected source = the console app, has no bypass actors and blocks force-push and deletion. Verify at Phase 3 which permission the merge API needs. | Phase 3 (+ an owner `access` question for the ruleset) | Low after R1; **Critical** without it (no branch protection today) |
| A job pushes a workflow that exfiltrates repository or environment secrets on `push` | E, I | R8: `workflows: write` only for an item flagged `workflow-change` (that PR already needs `security`). Only the owner or the `security` role may set that flag; it is a row of the R5 transition table. Deploy secrets only in GitHub Environments with deployment-branch policies; `production` with required reviewers; PR workflows use no secrets (already true). | Phase 3 | Medium (a flagged job still holds it for an hour) |
| **An approved PR is retargeted** (`dev` → `main`) by a job with `pull_requests: write` and merged, skipping `stage` | E, T | The gate status is **per target branch**: the console posts `team-console/gate/<base>`, and each branch's ruleset requires its own context. On a base change (`pull_request.edited` with `changes.base`) the console marks every gate status on that head `failure`. The gate policy is evaluated against the PR's current base. | Phase 3 | Low after; Medium without it (production's required reviewers remain) |
| A write token leaks from the job | I | ≤ 1 h; per repository; credential helper outside the worktree (R9e); reviewer roles get read only | Phase 2 runner v0, Phase 3 | Medium (GitHub cannot revoke an installation token early except by suspending the installation) |
| The adapter builds a path from untrusted input (path traversal on `files.read`, SSRF via `Link` headers) | T, I | Paths from `RepoRef` only (`githubPath` rule); `Link` follow-up only on the provider host and the same resource path (as ADR 0003's events read) | Phase 3, Phase 5 | Low |
| The app key leaks (now with repository write) | E | Unchanged: one Worker secret, incident runbook; blast radius grows from Issues write to Contents/PR/Workflows write, which the R1 ruleset bounds on long-lived branches. Update ADR 0003 decision 8's asset row. | Phase 3 | High (unchanged grade, wider reach) |
| Repudiation of a push | R | Commits carry the job's bot identity; `job_events` records the `vcs-token` mint with job id, repo and scope | Phase 3 | Low |

### C6 — Webhooks (`hooks` Worker)

| Threat | STRIDE | Mitigation | Where | Residual |
| ------ | ------ | ---------- | ----- | -------- |
| Forged or replayed deliveries | S, T | HMAC per provider (`webhooks.verify`), dedupe by delivery id with `provider`; never writes tracker rows | Phase 3, Phase 5 | Low |
| A forged `pr.synchronize` enqueues review jobs in a loop | D | A delivery only marks `pull_requests` stale. The `api` Worker re-reads the PR through the adapter before enqueuing, and `dedupe_key` per (PR, head, role) holds the line. | Phase 3, Phase 4 | Low |
| The `hooks` Worker gains a credential | E | The existing config test (no `GITHUB_APP_*`, `TOKEN_ENCRYPTION_KEY`) extended to GitLab secrets | Phase 5 | Low |

### C7 — Import and cutover

| Threat | STRIDE | Mitigation | Where | Residual |
| ------ | ------ | ---------- | ----- | -------- |
| **Imported GitHub text becomes an authorisation** (an imported `/approve`, `pt-ask` answer or request marker acts) | S, E | R7. Imported owner commands are history (`comments`, `author_kind = 'import'`), or they go through a dedicated import writer with `via = 'import'` that the picker, the gate and asks logic ignore. The imported status/labels are the state. Pending ones are listed on the cutover screen for the owner to re-confirm. Open `pt-ask`s are re-asked, never re-executed. | Phase 1b import | Low after R7 |
| Content from strangers on a public repository (issues, comments from any GitHub account) enters the tracker as team-looking items | S, T | `source = 'import'` and `author` = the GitHub login, shown as imported. An imported item's status comes only from labels (only collaborators can set labels). Items opened by non-collaborators import as `proposed` regardless of labels. | Phase 1b import | Low |
| Prompt injection in imported text steers the import | E | The import is deterministic code (Worker or runner code with no LLM) | Phase 1b import | Low |
| A count mismatch hides lost or invented items | T | Final delta + per-status, per-sprint and comment counts; the switch is refused on a mismatch | Phase 1b cutover screen | Low |
| A team member edits or deletes a GitHub issue during the freeze | T | Freeze pauses the old plugin; the delta import compares `updated_at` and lists edits since the dry run | Phase 6 | Low |
| Rollback re-enables the old credentials after they were retired, or retirement happens before rollback closes | D | Retire (`SLOT_*`, review app, keys) only after the 14-day window. Until then the old credentials stay valid and are listed on the cutover screen as live. | Phase 6 (R9f) | Medium (two live credential sets for 14 days) |
| Lock comments trip GitHub secondary limits and leave half the issues open | D | Batches, resumable through `import_map` | Phase 6 | Low |

### C8 — Untrusted content inside a role run (prompt injection)

| Threat | STRIDE | Mitigation | Where | Residual |
| ------ | ------ | ---------- | ----- | -------- |
| **Item text, comments, PR bodies, diffs or dependency docs instruct a role to approve, merge, change policy or exfiltrate** | E | Rows are data; the plugin's untrusted-content rule. What a role can do is bounded by the server, whatever the model decides: role-bound token (C2), reviewer separation (R2), PR binding (R6), owner-only transitions (R5), gate-only merges (R1), project scope (R9c), no secrets in reach (job user). | ADR; all phases above | Medium: an injected reviewer can still approve a bad PR it was asked to review. The other required roles and CI are the remaining barrier. |
| Injection makes a job spam rows, asks or pushes to the owner | D | One open ask per item (partial unique index); per-job caps on comments/asks/events; push rate-limited per hour | Phase 1a′, Phase 4 | Low |
| A malicious dependency's install script runs inside the job | E, I | Same boundary as C4 (job user); job token useless off-host (R4) | Phase 4 | Medium |

### C9 — Multi-tenant isolation (ADR 0008 decisions 1–5)

| Threat | STRIDE | Mitigation | Where | Residual |
| ------ | ------ | ---------- | ----- | -------- |
| **A user, job or runner of account A reads or writes a project of account B** (a guessed slug, a job token replayed against another project, a runner claiming another account's job) | S, E, I | **Deny by default** (ADR 0008 decision 2): every route registered on the Hono app declares a scope rule (`project` \| `account` \| `own-user` \| `operator` \| `runner` \| `public`) and the **route inventory spec** walks `app.routes` and fails on one without it — `/needs-you`, `/overview`, `/github/*`, `/push`, `/environment` and every later route included; `projects/lookup.ts` takes the request's scope and answers 404 `project-not-found` outside it (the same answer as a missing slug); **a job's scope is its own project only** (never the account — R4 as in ADR 0006), **a runner's is `allowed_projects`**; `jobs.account_id` is checked at claim against `runners.account_id`; repos never take a `project_slug` or `account_id` from a body | T-2 | Low after the spec; **Critical** without it |
| **A webhook for account A's repository lands on account B's project** (a repository renamed or transferred, a `full_name` reused) | S, T | Invariant in the `hooks` Worker: a delivery reaches a project only if `installations.account_id = projects.account_id` for the delivery's installation **and** the repository matches by **id** (`projects.repo_id`), never by `full_name`; covered by the two-account e2e | T-2 | Low |
| A slug tells one account that another holds it (create conflict) | I | **Accepted** (ADR 0008 decision 1): slugs are public names like package names; nothing behind a slug is enumerable; system slugs are reserved; per-account URLs are the fallback | T-1 | Low (accepted) |
| A member acts as an owner (approves, answers an ask, changes members, sets a key) | E | `member` is its own policy actor with reads, comments, `proposed` items and requests only; every account route is owner-of-account; the last owner cannot be demoted; `items.approved_at` is set only by an owner write or an owner decision's effect | T-2, T-3 | Low |
| **Login CSRF, session swapping or fixation through the OAuth callback** (a GET that changes state) | S | `state` is random, single-use, 10 minutes, bound to a `__Host-tc_preauth` cookie set at `/auth/github/start`, with PKCE; the session is created only when state, cookie and verifier agree; the session cookie is `__Host-tc_session` (`Path=/; Secure; HttpOnly; SameSite=Lax`), rotated on sign-in; the CSRF bearer exemption covers `runner` and `job` and nothing else | T-3 | Low |
| Session theft (cookie exfiltration, a stale session after a role change) | S | Opaque 256-bit session id stored hashed; 24 h idle / 30 d absolute; revocable per user ("sign out everywhere"); memberships are read per request, never cached in the cookie; the CSRF rules of ADR 0001 stay for every cookie-borne write | T-3 | Low |
| The owner's Access identity is linked to the wrong GitHub user (email equality, a spoofed claim) | S, E | The link is an explicit POST made only while the owner is signed in through **both** doors in one session; never by email; `users.access_subject` is written once and audited | T-2, T-3 | Low |
| **An invite link is a bearer credential** (leaked through Referer or logs, replayed, used to gain `owner`) | S, E | Owner-role invites are always bound to a GitHub login; open invites are member-only, ≤ 72 h, revocable; the token travels in the URL fragment, never in a query string, and the logger never records it (tested); a GET confirmation screen, then a POST accept, rate-limited; single use; the acceptance is an `audit_events` row | T-3 | Low |
| An installation is linked to the wrong account (a crafted setup redirect) | S, E | The setup URL's `state` is signed **and** bound to the current session, single-use, short-lived; the console verifies with the **user's own token** (`GET /user/installations`) that this user can access the installation — that it exists is not enough; the link is a POST from the confirmation screen; relinking needs the owner | T-4 | Low |
| The operator (us) reads a customer's tracker | I | Operator routes (`/api/v1/admin/*`) touch plans and entitlements only; the **Worker itself** verifies the Access JWT and an operator allowlist there — a session cookie never satisfies it; there is no operator read of project rows; the operator's D1 access is the Cloudflare account itself (RR14) | T-2, T-5 | Medium (platform trust) |
| Cross-tenant data in shared read models or caches (`cache_epoch`, inbox, overview, needs-you) | I | Read models are built per project through the same lookup; `/overview` and `/needs-you` list the scope's projects only; the two-account e2e asserts a second account sees nothing of the first across webhooks, push, overview, needs-you and the GitHub routes | T-2, 2-E | Low |
| The GitHub App manifest is flipped public before the controls above exist | E | The flip is gated by the **first-customer security gate** of ADR 0008 decision 11 (inventory spec over every route, the two-account e2e, OAuth/setup/invite flow tests, a SECURITY review of the flip, T-6, the RR14 terms, the operator allowlist) | Stage C gate | Low |
| Audit rows are edited or lost | R, T | `audit_events` append-only (no UPDATE/DELETE in `@worker/db`, tested); written in the same batch as the action; the redactor runs on `details` | T-1 | Low |

### C10 — BYOK inference keys and the hosted sandbox (ADR 0008 decisions 7–9)

| Threat | STRIDE | Mitigation | Where | Residual |
| ------ | ------ | ---------- | ----- | -------- |
| **A customer's Anthropic key is read from D1, a log, an event, the provider's machine config or the console** | I | Sealed per ADR 0008 "Sealing": AES-256-GCM, random 96-bit IV per seal, data key HKDF-derived from the **separate** Worker secret `INFERENCE_KEY_ENCRYPTION_KEY` (`info = 'inference-key:v<root_key_version>'`), AAD `account:<id>:anthropic:<key_id>` (a ciphertext cannot be moved between accounts or put back after a rotation), `root_key_version` stored for root rotation; only `last4` and `key_id` are ever returned; `key_enc` is read by **one repo method that only the dispatcher imports** (an import-graph test enforces it); the key is **released once, in the claim response**, to the machine that presents the job's bootstrap token — never in `HostedBackend.start`, never in the provider's machine config or `fly secrets` (app-wide, shared); redactor pattern `sk-ant-` on events, bodies and audit details; sentinel test as `github-sentinel.spec.ts` | H-1, H-2 | Low |
| The key of account A is injected into a job of account B | E, I | `jobs.account_id` (copied from the project at enqueue) must equal `inference_keys.account_id` before release; the hosted runner identity is per account (`runners.hosted = 1`, one per account), so the claiming identity, the job and the key agree or the dispatch is refused and audited | H-1 | Low |
| **Account A's hosted job reaches account B's running machine** (a shared private network, `.internal` DNS) or uses our fleet as an abuse platform | E, I, D | **One Fly app per account** with its own isolated private network (no shared 6PN), **no inbound services**, egress through an **allowlist** (the Anthropic API, GitHub, the console API, declared package registries); the Fly API token the Worker holds is **scoped to the runner apps, never an org token** (an asset row above); on Cloudflare Containers the equivalent is one Durable Object namespace per account and the same egress rules | H-2 | Low after; **High** without it |
| A job inside the sandbox exfiltrates the key it runs on (prompt injection, a dependency) | I | Inherent while the CLI holds the key in its process. Bounded by: the key is the customer's and used on their behalf; the reservation and the CLI's `--max-budget-usd`; rotation and revoke in one screen; **the customer's workspace spend limit in the Anthropic Console, required before hosted mode is enabled**; the machine is deleted at `finish`. **Recommended (H-2 decides with evidence)**: a credential-injecting sidecar under a separate uid with the CLI on `ANTHROPIC_BASE_URL`, so the job process never holds the key. Mode (a) with the customer's Claude config mounted read-only exposes their OAuth refresh token the same way — the customer's choice, stated in the runner docs (RR11) | H-1, H-2, 2-B | **Medium** (RR11) |
| A Claude.ai OAuth credential reaches our servers (a customer pastes a session token, a config mount in hosted mode, a placement policy routing a subscription-backed project to the hosted runner) | — (terms) | The hosted dispatcher refuses to start a job whose environment or mounts carry a Claude OAuth credential (`CLAUDE_CODE_OAUTH_TOKEN`, a `.claude` credentials file); the key form is validated as an API key (`sk-ant-api…`) at upload; the UI says why; the hosted runner runs only on an account's `inference_keys` row (a placement policy cannot give it anything else). Self-hosted: the runner passes credential *locations*, never values, and never uploads them — the owner's own subscription (ADR 0008 decision 10) stays on his hosts under this rule, and Anthropic's own cloud is not a runner host (decision 12: the late-October subscription-access failures and the egress proxy that rewrites GitHub auth, so role identities cannot sign there) | H-1, 2-B | Low |
| **Spend runaway** (a looping job, a job that reports `$0`, concurrent dispatches racing the cap, a stolen key used through our fleet) | D, E | `payload.maxUsd` is **reserved** in `account_spend` at dispatch (refused when `reserved + spent + maxUsd` exceeds the cap) and reconciled at `finish`; the budget is passed to the CLI (`--max-budget-usd`) with `maxMinutes` as the hard kill; `max_concurrency` per account; the owner alerted at 80 %. The reported `total_cost_usd` comes from inside the sandbox and can lie, so **the only hard cap is the customer's Anthropic workspace limit**, required before hosted mode is enabled | H-2 | **Medium** (RR11) |
| Cross-job or cross-account state in the hosted fleet (a leftover volume, a reused or merely stopped machine, a shared cache) | E, I | One ephemeral machine or container per job from the runner's pinned image; no persistent volume; the machine is **deleted** (a stopped machine keeps its rootfs) at `finish` and swept past `maxMinutes + 5`; no shared mirror in hosted mode (a fresh clone each job); the plant-then-verify test runs **across two accounts** on the hosted backend | H-2 | Low |
| The bootstrap token is intercepted and another machine claims the job | S | 10 minutes, single use, hashed in `jobs.bootstrap_token_hash`, bound to the job id and the dispatch's `hosted_instance_id`; a second claim is 409 and audited | H-2 | Low |
| Provider compromise (Fly or Cloudflare) | E, I | Platform trust, same class as the Cloudflare account itself; recorded, not mitigated (RR14) | — | Medium |

### C11 — Runner installer and release supply chain (ADR 0008 decisions 7–8)

| Threat | STRIDE | Mitigation | Where | Residual |
| ------ | ------ | ---------- | ----- | -------- |
| **A tampered runner release** (a replaced tarball, a malicious update, a console that names a bad version) runs on every customer machine with their key and their repositories | T, E | **The trust root is pinned inside the installed runner** (the Sigstore identity of this repository's release workflow on a `v*` tag, or a pinned public key) and changes only through a signed release — never served by the console or read from the repository at run time; releases are built by a **separate, minimal release workflow** (`release-runner.yml`, no deploy secrets) on a **tag protected by a `v*` ruleset**, signed **Sigstore keyless** with **GitHub artifact attestations** (`actions/attest-build-provenance`); container images **cosign-signed** and referenced by digest; the Homebrew tap repository carries the same ruleset and the formula verifies the attestation; the runner self-updates only to the version the console names **and refuses any version lower than the installed one or below a signed minimum**; customers may **pin a version or turn auto-update off** | 2-B | Medium (a compromised release workflow or GitHub identity; no long-lived release key remains) |
| `curl … \| sh` as the documented install | T | Not offered: the documented path is the attested release asset, the Homebrew formula, or the signed image by digest | 2-B | Low |
| A dependency of the runner is compromised (`npm` supply chain) | T, E | `npm ci` from the lockfile with exact versions; the runner bundles to one file at release so the customer installs no `node_modules`; dependency audit in CI; a minimal dependency set is an acceptance criterion of 2-B | 2-B | Medium |
| The installer escalates on the customer's machine | E | The installer creates only the runner's directories and, for the `user` backend, the two local users with the documented single sudoers rule; it never writes outside its prefix; the `container` backend needs no privilege beyond the container runtime | 2-B | Low |
| **The GitHub Actions packaging exposes a credential** (a secret as a `workflow_dispatch` input is public on a public repository; a repository secret is readable by a workflow on any branch a write-capable identity pushes; a dispatch on a non-default `ref` runs that branch's workflow file; `${{ inputs.* }}` in `run:` is script injection; a fork PR's head executes in the VM that holds the key) | I, E, T | Requirements of ADR 0008 decision 7(a′): `workflow_dispatch` only (never `pull_request_target`, `issue_comment`, `workflow_run`); the console dispatches **only on the default branch** with an app token **downscoped to `repository_ids: [repo]` and `permissions: {actions: write}`** (adding the permission is an R1-class owner approval); the key lives in a **GitHub Environment restricted to the default branch**; **no long-lived console credential** — the run presents a **GitHub OIDC token** and the console verifies `iss`, `aud`, `repository_id`, `workflow_ref`, `ref`, `run_id` and the job id before exchanging it for the token of that one job (one exchange per job); the **only input is the job id**, ULID-validated and read through `env:`; `permissions: {contents: read, id-token: write}`, `persist-credentials: false`, actions pinned by SHA, no `actions/cache`, no artifacts; the CLI stream goes to the console's redacted events, the log carries only the job id; fork-head code runs with `npm ci --ignore-scripts` and no tests from that head, or waits for the owner; `::add-mask::` is defence in depth only — a compromised job can encode or send the key | 2-B PR 4 or its own issue — before any customer uses the packaging (no longer a Stage A prerequisite: the owner's team runs on a self-hosted runner, ADR 0008 decision 10) | **Medium** (RR11: the job's process holds the key) |
| **A job claims on the wrong host** (a runner outside the project's placement policy, a revoked or offline runner, a hosted machine taking a job meant for the owner's own host and its subscription) | E, I | ADR 0008 decision 12: the claim statement admits a runner only when the project is in its `allowed_projects` **and** `projects.runner_policy` (or the account default) admits it now (`pinned`, `any`, or `failover` after `offline_after_seconds` without a heartbeat); a claimed job stays with its runner; a revoked runner's claimed jobs are cancelled (ADR 0006); the hosted runner is admitted only by an explicit policy entry and only with an API key — a subscription credential exists on the owner's hosts alone, so no policy can route it to our servers; policy changes are audited | 2-A, 2-E | Low |
| The `actions-ephemeral` backend is claimed by something that is not a fresh GitHub VM | S | The backend is implied by a valid OIDC exchange whose `run_id`/`job_id` match the dispatch; no enrolment code grants it; GitHub discards the VM after the job | 2-A, 2-B | Low |

## Required scenarios (issue #408)

| Scenario | Rows | Outcome after the ADR amendments |
| -------- | ---- | -------------------------------- |
| A dev key forging a QA / REVIEW / SECURITY verdict | C3 rows 1–3 and 7, C4 row 2 | refused at the console (role), at the key agent (role), and structurally (no reviewer children, lineage check, no state carried from one job to the next). With the same macOS user it still holds the keys, hence the job user. |
| A stolen runner credential | C4 row 1 | needs both halves; revocable in one screen plus Zero Trust; High residual, detected by the owner |
| Prompt injection from item text into a role run | C8 | bounded by server-side controls; Medium residual for the role's own verdict |
| Replay of signed verdicts | C3 row 4 | nonce, head, age, PR, environment |
| Import of untrusted GitHub content at cutover | C7 rows 1–3 | history only, no authorisation, deterministic import |

## Dedicated macOS user for jobs (the architect's open point)

ADR 0006 "Runner and job queue" leaves open whether jobs run as a separate user. They must, before the Mac runner
serves the team's environment. As the owner's user, a job can do all of the following, whatever file mode the
key directory has:

- read the runner key and the Access token pair, and so impersonate the runner;
- read every role key;
- connect to the 0600 socket;
- run `gh auth token`, so act as the owner on GitHub with owner-grade write;
- read `~/.zshenv` (the `PT_*_APP_KEY` set-up until Phase 6), SSH keys and browser profiles.

File permissions protect nothing between processes of one user. Mitigation ladder:

| Level | What | Stops | Cost | Verdict |
| ----- | ---- | ----- | ---- | ------- |
| L0 | Same user, 0600 files, separate directory (ADR as written) | nothing from a job | none | not acceptable for the team's environment |
| L1 | Claude Code's sandbox / permission deny rules for the key directory, `~/.ssh`, `~/.config/gh`, the Keychain CLI | casual reads by the model's tools | settings only | defence in depth only: dependency scripts and anything outside Claude Code's tools are not covered |
| L2 | Runner secrets in the Keychain with an ACL for the runner binary | silent reads of those items | small | does not stop `gh auth token`, the socket or `ps`; the job is still the owner |
| **L3** | **Runner as a LaunchDaemon under `_tcrunner`; jobs as `_tcjob` (no admin, no login shell, own home, no access to the owner's home, a root-owned account home and a fresh `HOME` per job); one sudoers rule `_tcrunner ALL=(_tcjob) NOPASSWD: <the job-exec wrapper>`; the socket in a directory `_tcrunner:_tcjob 0750`; keys and config `_tcrunner` 0600; the bare mirror owned by `_tcrunner` and read-only to `_tcjob`, a fresh clone per job; toolchain read-only for `_tcjob`; no `_tcjob` process outlives a job** | reads of runner and owner secrets; tampering with the runner or the plugin | owner admin steps once (create two users, install the daemon); a Claude Code credential for `_tcjob` (`claude setup-token`, held by `_tcrunner` and injected per job); the Homebrew/Node toolchain must be readable by `_tcjob` | **recommended**; prerequisite of the first cutover; Phase 4 |
| L4 | Jobs in a Linux VM or container on the Mac (Lima/Docker), the same image as the server runner | everything L3 stops, and kernel-level isolation | RAM/CPU on the Mac, a VM to keep updated | the server-runner path; optional later |

With L3 the remaining exposure inside a job is its own token (useless off-host with R4), the per-job write token (R1
bounds it) and the Claude Code credential. That credential gives use of the owner's subscription, not their
accounts. It is rotatable and recorded as a Medium residual. One uid shared by sequential jobs is a channel between
them (C3, the cross-job persistence row). L3 is complete only with the per-job `HOME`, the read-only mirror and the
no-leftover-process check. Concurrency above 1 needs a uid per slot or L4 (C3
row 6).

## Mitigations by phase (criteria to copy into the phase issues)

| Phase / issue | Criteria |
| ------------- | -------- |
| 1a (#410) | `tracker` gate (409 `tracker-not-cut-over`); `workflow-change` settable only by the owner or `security` (transition table); bounded columns and plain-text rendering; `If-Match` versioning; append-only `comments`/`item_events` (no UPDATE/DELETE path in `@worker/db`, tested); `policy.ts` transition table for owner-semantic status and flags (R5); CSRF on every owner write. |
| 1a′ (new) | `owner_decisions`/`owner_requests` owner-only (403 for `job`/`runner`, inventory test); decisions apply their effects in the same transaction; one open ask per item; per-job ask/comment caps; `via` enum matches what is written. |
| 1b import + cutover screen (new) | Deterministic import, no LLM; imported owner commands never authorise (R7); non-collaborator items import as `proposed`; counts and the refusal on a mismatch; pending decisions re-confirmed by the owner; imported text rendered plain. |
| Plugin 0.12 | `slot-qa` and rework rounds enqueue `review` jobs instead of dispatching reviewers in-process (R2); `console.py` calls go to the runner proxy, never to the internet directly (R4); no key path or secret in any script's environment. |
| 2 API (new) | `policy.ts` + inventory spec incl. `/children`; children never reviewer roles; verdict checks: role, token-role match, runner's unrevoked key, signature, `issued_at`, nonce, current head, PR ∈ project, PR/head = job payload, lineage (child-token parentage to the root) holds no job that pushed to the head; `POST …/prs/:number/reviews` in the matrix, with roles and `head_sha` derived by the console, never taken from the requester; `env` in the payload, `sha256(body)` signed; gate computed server-side and re-run in `merge`; enrolment code entropy, constant-time compare, rate limit; runner JWT `jti`; job tokens accepted only with the claiming runner's identity; the Access application admits the runner's service token on `/api/v1/projects/:slug/*` for proxied job calls (the Worker still requires the runner JWT and the job token there); CSRF exemption only for bearer identities; job project scope. |
| 2 runner v0 (new) | The key agent signs only for a token it launched and only that token's role, refuses others with a `notice`; API proxy on the socket (R4), with `TC_API_URL` as HTTP over that Unix socket (no TCP loopback port); fresh per-job `HOME`/`TMPDIR` and runner-owned read-only Claude managed settings with user and project hooks disabled; the bare mirror read-only to the job user, a fresh clone per job, launch refused on hook-type git config; the Claude credential injected per job; the plant-then-verify persistence test; credential helper and plugin outside the worktree; event redactor; reviewer roles get read tokens only. |
| 3 adapter (new) | Job tokens minted with the minimal permission set, never `checks`/`statuses`/`administration`/`actions`; `workflows: write` only on a `workflow-change` item; `team-console/gate/<base>` status per target branch from the console, failed on a base change; owner `access` question for the ruleset (PR required, gate check from the console app, no bypass, no force-push or deletion) on `dev`/`stage`/`main`; deploy secrets in environment-scoped secrets with branch policies; ADR 0003 decision 8 asset row updated; `files.read` path rule. |
| 4 scheduling + daemon (new) | L3 job user (prerequisite of cutover); `max_concurrency = 1` until per-slot uids; lease and kill at `maxMinutes`; event batching and per-job caps; runner presence and new-runner push; the owner alerted on a claim from a new IP country; `pkill -9 -u _tcjob` before and after every job and no launch while a `_tcjob` process remains; sweep of `_tcjob`-owned files outside the per-job directories; root-owned `_tcjob` account home; per-runner project allow-list; runner installed from a tagged release, not writable by the job user. |
| 5 GitLab (new) | GitLab protected branches (no one may push, merge only through the console token), external status check for the gate, project access tokens per job with the minimal scope, webhook token verification, the `hooks` config test extended. |
| 6 cutover (new) | Freeze and delta checks; retire old credentials only after the 14-day window; the cutover screen lists live legacy credentials; L3 and R1 verified on the team's environment before the switch. |

## Residual risks

| # | Risk | Severity | Why it stays | Owner of the follow-up |
| - | ---- | -------- | ------------ | ---------------------- |
| RR1 | Jobs run as the owner's macOS user until Phase 4's L3 | **Critical** (only on the team's environment; dev with fixtures is Medium) | L3 needs owner admin steps; until then a job can act as the owner through `gh` | Phase 4; the cutover refuses without it |
| RR2 | A stolen runner credential pair works until the owner revokes it | High | No hardware-bound key on the Mac (Secure Enclave keys are P-256, not Ed25519) | Phase 4 alerting; a later ADR could move the runner key to the Secure Enclave as P-256 |
| RR3 | The app private key has repository write on every installed product | High | The cost of one app per environment (ADR decision 7); bounded by R1 on long-lived branches | ADR 0003 runbook |
| RR4 | An injected reviewer approves the PR it reviews | Medium | A model can be wrong or steered; other roles and CI are the remaining barrier | QA checklists; owner `/go` for releases |
| RR5 | A per-job write token cannot be revoked before it expires | Medium | Provider limit | ≤ 1 h TTL |
| RR6 | The Claude Code credential of `_tcjob` is in the job's reach | Medium | The CLI needs it to run | rotate on suspicion; usage visible in claude.ai |
| RR7 | Two credential sets live during the 14-day rollback window | Medium | The owner's hard-cutover rollback | Phase 6 retire step |
| RR8 | D1 free limits are the availability ceiling | Medium | $0 constraint | Phase 4 budget alarm |
| RR9 | ADR 0006 wording differs from this model in four places (below) | Medium until aligned | landed at `319037e` except these | the architect |
| RR10 | Cross-job state the sweep misses (an unlisted world-writable path, a macOS facility that persists per uid) | Low after the C3 controls | One uid for sequential jobs; L4 or per-job uids remove it | Phase 4; L4 later |
| RR11 | A job can exfiltrate the inference credential it runs on: a BYOK key in hosted mode, the key in the Actions Environment, the customer's own key on a self-hosted runner, or — when the customer chooses to mount their Claude config read-only, and on the owner's own Mac (ADR 0008 decision 10) — a subscription credential: on macOS the `_tcjob` user runs on a long-lived `claude setup-token` (about a year) that an injected job can read and use on the subscription until it is revoked in claude.ai; the reported cost can lie | Medium | The CLI holds the credential in its process (C10 rows 4 and 6, C11 row 5); `::add-mask::` and the redactor do not stop a compromised job; the subscription token has no spend cap, only the plan's limits | the spend reservation, `--max-budget-usd`, rotation, the customer's workspace spend limit as the hard cap; the credential-injecting sidecar evaluated in H-2; the mount and the `setup-token` stated as the customer's (and the owner's) accepted choice in `docs/runbooks/runner.md`, with the revoke path (revoke in claude.ai → `claude setup-token` again as `_tcrunner` → restart the runner) |
| RR12 | Row-level tenancy in one D1: a missed chokepoint is a cross-account read | Low with the deny-by-default inventory spec; Critical without | One database per environment (ADR 0008 decision 1) | T-2; denormalise `account_id` if a leak is ever found |
| RR13 | The release workflow and GitHub's signing identity are the runner fleet's root of trust | Medium | A signed, attested release is the only distribution a customer can verify; no long-lived release key remains (Sigstore keyless) | `v*` tag ruleset, the separate minimal release workflow, the trust root pinned in the binary, customer pin/opt-out; 2-B |
| RR14 | Platform trust: the operator's Cloudflare account and the hosted provider see every tenant's data and sandbox | Medium | Inherent to a hosted product | documented for customers; later ADR for per-tenant encryption of bodies if demanded |

### ADR wording to align

R1–R9 landed in ADR 0006 at `319037e`. Four places differ from this model and should follow it (or be argued in
an amendment):

1. **Claude credential**: the ADR says it is the job user's own credential. This model prefers it held by
   `_tcrunner` and injected per job, so it never rests in a home that sequential jobs share.
2. **Bare mirror ownership**: the ADR's "Run" has `work/<slug>/` owned by `_tcjob`. This model needs it owned by
   `_tcrunner` and read-only to `_tcjob`, with a fresh clone per job.
3. **`TC_API_URL`**: the ADR calls it "the runner's loopback proxy". It should be HTTP over the Unix socket.
4. **Lineage**: the ADR follows `requested_by` to the root. It should follow child-token parentage, and the
   enqueue-review route should be in the matrix with console-derived roles and head.

## Questions for the owner

1. **Dedicated job user (L3)** — may the team ask you, when Phase 4 is planned, to create two macOS users
   (`_tcrunner`, `_tcjob`) and install the runner as a system daemon (an admin password, once)? Without it the Mac
   runner stays on dev with fixtures.
2. **Branch ruleset (R1)** — may the team ask you, when Phase 3 is planned, to enable a ruleset on `dev`, `stage`
   and `main` that requires a PR and the console's gate check and allows no bypass, not even for your account?
   Your own releases would then go through the console's merge as well.
3. **Claude Code credential** — is a long-lived `claude setup-token` for the job user acceptable on your
   subscription, rotated on suspicion? **Decided 2026-11-09 (owner, team chat), per ADR 0008 decision 10**: yes, on
   the owner's own self-hosted runner only — the `_tcjob` user on his Mac (backend `user`) holds a long-lived
   `claude setup-token` (about a year) that an injected job can read and use on his subscription until he revokes
   it in claude.ai; that is the owner's accepted risk for his own team (RR11), never a credential on our servers.
   Revoke path (`docs/runbooks/runner.md`): revoke the token in claude.ai → `claude setup-token` again as
   `_tcrunner` → restart the runner; jobs in flight fail and are requeued once.
4. **Hosted provider and spend** (ADR 0008 decision 9) — **decided 2026-11-09 (owner, team chat)**: Fly Machines
   first (≈ $0.03 per 90-minute job, nothing idle), Cloudflare Containers second; hosted mode is enabled only with a
   **separate spend `/approve`** when H-2 is planned, and only for an account whose Anthropic workspace carries a
   spend limit.
5. **Your team's inference credential** (decision 10) — **decided 2026-11-09 (owner, team chat), revised the same
   day**: for now the team runs on a **self-hosted runner** (backend `user` on the owner's Mac or `container` on a
   machine he owns) signed in with his **personal Claude subscription through Anthropic's flow on that host**; the
   credential never leaves the host and never reaches our servers. Unattended use of a personal subscription token
   is a grey zone under the Consumer Terms (automation clause) and the owner's **accepted risk for his own team**;
   it is never offered to customers on our servers (C10 row 5, ADR 0008 decisions 7 and 12). The earlier choice
   (his own API key under a $50/month cap through the Actions packaging) is withdrawn for now and stays available
   as a switch.
6. **Sign in with GitHub as the only customer door** (decision 3) and the retirement of Cloudflare Access from
   `/api/*` at the first customer — **decided 2026-11-09 (owner, team chat): yes**; Access stays for the operator
   routes (verified by the Worker) and for dev/stage. Also decided the same day: globally unique slugs, the team's
   tracker on production, roles `owner`/`member` only.
7. **Platform trust** (RR14) — **decided 2026-11-09 (owner, team chat)**: the customer terms state, before the first
   customer, that the operator's Cloudflare account and the hosted provider can technically reach their data.
8. **`actions: write` on the GitHub App** (ADR 0008 decision 7a′; an R1-class permission change, minted only as a
   token downscoped to one repository) — **open**; asked with 3b's permission question and before the first
   Actions dispatch of the owner's team.
