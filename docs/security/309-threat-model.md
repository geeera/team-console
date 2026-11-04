# #309 threat model — the console as the source of truth

Issue #408 (Phase 0 of #309). Date: 2026-11-04. Author: the security role. Reviews the target architecture in
[ADR 0006](../decisions/0006-console-source-of-truth.md) (`docs/decisions/0006-console-source-of-truth.md`, PR #412,
not merged when this was written; section names below are the ADR's). The security review of PR #412 asked for
changes. Its findings 1–9 are referred to here as **R1–R9**, and this model assumes the ADR is amended as they
ask. Where an amendment has not landed, the row's residual says so. Builds on the earlier models of ADR 0001
decision 8 and ADR 0003 decision 8, which stay in force for what they cover (Access, the SPA, the `api` and
`hooks` Workers, owner OAuth).

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
| Claude Code credential of the job user (only with a dedicated job user) | the owner's Claude subscription | the runner's config, injected into the job | the job | `claude setup-token` again; revoke in claude.ai |
| The owner's own credentials on the Mac (`gh` token in the Keychain, SSH keys, browser profiles, `~/.zshenv` app keys until Phase 6) | owner, on GitHub and beyond | the owner's macOS user | any process running as the owner | out of scope of the console; see C4 |
| The tracker (D1 rows), verdicts, job events | integrity of every decision | D1 of the team's environment | `api` Worker | D1 Time Travel (7 days on the Free plan) for restore; append-only tables |
| `.product-team/project.yml` on the default branch | the review policy and `commands` the jobs run | the repository | anyone who can merge | reviewed PRs only (gate + R1 ruleset) |

**Agents never see secret values.** The job environment is `TC_API_URL`, `TC_JOB_TOKEN`, `TC_RUNNER_SOCKET`, the
worktree and `PATH`, plus the Claude Code credential once jobs run as their own user. The job token is a credential
the job is meant to hold. It names one role and one project and is useless off-host once R4 lands. No key path, app
key, service token, VCS app key, owner token or `TOKEN_ENCRYPTION_KEY` is passed to a job. Whether a job can *reach*
one anyway depends on the operating-system boundary between the runner and the job (C4). Until the dedicated job
user exists, the honest statement is "agents are not given secret values", not "agents cannot read them".

## Trust boundaries

| # | Boundary | Crossed by |
| - | -------- | ---------- |
| TB1 | Internet → Cloudflare Access → `api` Worker | owner (Access JWT), runner (service token + runner JWT), jobs (via the runner, R4) |
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
| **The orchestrator (or the dev agent in the same Claude Code session) obtains a reviewer token** through `POST …/jobs/:id/children` and approves its own work | S, E | R2: reviewer roles are never children. They run only as top-level `review` jobs enqueued by the console with payload `{pr, head_sha, role}`. The console refuses a verdict whose job lineage includes a job that pushed to that PR's head. | Phase 2 API, Phase 2 runner v0, plugin 0.12 (`slot-qa` enqueues reviews instead of dispatching them) | Low after R2; **Critical** without it, because the session that wrote the code approves it |
| A reviewer job of project A, or of PR 1, approves PR 2 or project B | E | R6: `pr` must be in the job's project and equal the review job's payload; `head_sha` must equal the payload's and the PR's current head | Phase 2 API | Low |
| **Replay of a signed verdict** (an old approval on a new head, the same approval twice, an approval from another environment) | T | Signed `head_sha` + check against the current head (409 `verdict-stale-head`); `nonce` UNIQUE (409 `verdict-replay`); `issued_at` ≤ 10 min; `pr` names provider/owner/repo/number; the job must be running. Add `env` (the console's `aud`) to the signed payload so a dev-environment signature is never valid on production. | ADR "Role keys and the gate"; `env` field: Phase 2 API | Low |
| A same-user process reads the role key files and signs anything | S, E | Dedicated job user (C4, "Dedicated macOS user") | Phase 4 (prerequisite of the first cutover) | **High** until then |
| A job on a concurrent runner slot reads another job's token from its environment (`ps eww` shows environments of the same user's processes; verify on macOS 26) | S | `max_concurrency = 1` on the Mac. A per-job uid (`_tcjob1…n`) or container before concurrency > 1. | Phase 4 | Low at concurrency 1 |
| The review text (`body`) is altered after signing | T | `body` is stored beside the signature, not in it. Sign `sha256(body)` in the payload so the text the owner reads is the text that was signed. | Phase 2 API | Low |
| Who approved what cannot be shown later | R | Verdict rows keep `payload`, `signature`, `role_key_id`; the public key stays in D1 after revocation | Phase 2 API | Low |

### C4 — Runner, enrolment and the runner host

| Threat | STRIDE | Mitigation | Where | Residual |
| ------ | ------ | ---------- | ----- | -------- |
| **A stolen runner credential** (Access token pair + runner key copied off the Mac) | S, E | Both are needed (Access, then the runner JWT whose runner's `access_token_id` equals the token's id). Revoke = `runners.revoked_at` + delete the service token in Zero Trust; revoking cancels claimed jobs and revokes role keys. Runner JWT `exp` ≤ 5 min with `jti` reuse refused (R9b). Settings › Runners shows `last_seen_at` and the host, so an unexpected second poller is visible. The console alerts the owner on a claim from a new IP country (Access logs the source). | Phase 2 API, Phase 4 | **High**: the pair gives every role's job tokens and per-job write tokens for every claimed job until revoked. Detection is by the owner. |
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
| A job pushes a workflow that exfiltrates repository or environment secrets on `push` | E, I | R8: `workflows: write` only for an item flagged for it (that PR already needs `security`). Deploy secrets only in GitHub Environments with deployment-branch policies; `production` with required reviewers; PR workflows use no secrets (already true). | Phase 3 | Medium (a flagged job still holds it for an hour) |
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

## Required scenarios (issue #408)

| Scenario | Rows | Outcome after the ADR amendments |
| -------- | ---- | -------------------------------- |
| A dev key forging a QA / REVIEW / SECURITY verdict | C3 rows 1–3, C4 row 2 | refused at the console (role), at the key agent (role), and structurally (no reviewer children, lineage check). With the same macOS user it still holds the keys, hence the job user. |
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
| **L3** | **Runner as a LaunchDaemon under `_tcrunner`; jobs as `_tcjob` (no admin, no login shell, own home, no access to the owner's home); one sudoers rule `_tcrunner ALL=(_tcjob) NOPASSWD: <the job-exec wrapper>`; the socket in a directory `_tcrunner:_tcjob 0750`; keys and config `_tcrunner` 0600; worktrees owned by `_tcjob`; toolchain read-only for `_tcjob`** | reads of runner and owner secrets; tampering with the runner or the plugin | owner admin steps once (create two users, install the daemon); a Claude Code credential for `_tcjob` (`claude setup-token`, a declared job secret); the Homebrew/Node toolchain must be readable by `_tcjob` | **recommended**; prerequisite of the first cutover; Phase 4 |
| L4 | Jobs in a Linux VM or container on the Mac (Lima/Docker), the same image as the server runner | everything L3 stops, and kernel-level isolation | RAM/CPU on the Mac, a VM to keep updated | the server-runner path; optional later |

With L3 the remaining exposure inside a job is its own token (useless off-host with R4), the per-job write token (R1
bounds it) and the Claude Code credential. That credential gives use of the owner's subscription, not their
accounts. It is rotatable and recorded as a Medium residual. Concurrency above 1 needs a uid per slot or L4 (C3
row 6).

## Mitigations by phase (criteria to copy into the phase issues)

| Phase / issue | Criteria |
| ------------- | -------- |
| 1a (#410) | `tracker` gate (409 `tracker-not-cut-over`); bounded columns and plain-text rendering; `If-Match` versioning; append-only `comments`/`item_events` (no UPDATE/DELETE path in `@worker/db`, tested); `policy.ts` transition table for owner-semantic status and flags (R5); CSRF on every owner write. |
| 1a′ (new) | `owner_decisions`/`owner_requests` owner-only (403 for `job`/`runner`, inventory test); decisions apply their effects in the same transaction; one open ask per item; per-job ask/comment caps; `via` enum matches what is written. |
| 1b import + cutover screen (new) | Deterministic import, no LLM; imported owner commands never authorise (R7); non-collaborator items import as `proposed`; counts and the refusal on a mismatch; pending decisions re-confirmed by the owner; imported text rendered plain. |
| Plugin 0.12 | `slot-qa` and rework rounds enqueue `review` jobs instead of dispatching reviewers in-process (R2); `console.py` calls go to the runner proxy, never to the internet directly (R4); no key path or secret in any script's environment. |
| 2 API (new) | `policy.ts` + inventory spec incl. `/children`; children never reviewer roles; verdict checks: role, token-role match, runner's unrevoked key, signature, `issued_at`, nonce, current head, PR ∈ project, PR/head = job payload, lineage not the author, `env` in the payload, `sha256(body)` signed; gate computed server-side and re-run in `merge`; enrolment code entropy, constant-time compare, rate limit; runner JWT `jti`; job tokens accepted only with the claiming runner's identity; CSRF exemption only for bearer identities; job project scope. |
| 2 runner v0 (new) | The key agent signs only for a token it launched and only that token's role, refuses others with a `notice`; API proxy on the socket (R4); credential helper and plugin outside the worktree; event redactor; reviewer roles get read tokens only. |
| 3 adapter (new) | Job tokens minted with the minimal permission set, never `checks`/`statuses`/`administration`/`actions`; `workflows: write` only on a flagged item; `team-console/gate` status from the console; owner `access` question for the ruleset (PR required, gate check from the console app, no bypass, no force-push or deletion) on `dev`/`stage`/`main`; deploy secrets in environment-scoped secrets with branch policies; ADR 0003 decision 8 asset row updated; `files.read` path rule. |
| 4 scheduling + daemon (new) | L3 job user (prerequisite of cutover); `max_concurrency = 1` until per-slot uids; lease and kill at `maxMinutes`; event batching and per-job caps; runner presence and new-runner push; per-runner project allow-list; runner installed from a tagged release, not writable by the job user. |
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
| RR9 | The R1–R9 amendments have not landed in ADR 0006 yet | High until they do | PR #412 is in review | the architect |

## Questions for the owner

1. **Dedicated job user (L3)** — may the team ask you, when Phase 4 is planned, to create two macOS users
   (`_tcrunner`, `_tcjob`) and install the runner as a system daemon (an admin password, once)? Without it the Mac
   runner stays on dev with fixtures.
2. **Branch ruleset (R1)** — may the team ask you, when Phase 3 is planned, to enable a ruleset on `dev`, `stage`
   and `main` that requires a PR and the console's gate check and allows no bypass, not even for your account?
   Your own releases would then go through the console's merge as well.
3. **Claude Code credential** — is a long-lived `claude setup-token` for the job user acceptable on your
   subscription, rotated on suspicion?
