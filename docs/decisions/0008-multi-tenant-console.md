# 0008 — Multi-tenant console and where jobs run

Status: proposed (owner direction in chat, 2026-11-09: the console becomes a paid multi-tenant product; two
execution modes — a customer-installed runner or a hosted runner on the customer's own Anthropic API key; the
owner's team follows the same rules as any customer and depends on no particular machine; billing is designed as a
seam only. Everything below that is not one of those four directions is a team decision under
`reference/decision-policy.md`, reversible with `/reject why`). Date: 2026-11-09. Phase 2 of #309 (umbrella #446;
the architect note of 2026-11-09 on #446 is superseded by this ADR where they differ). Amends
[ADR 0006](0006-console-source-of-truth.md) decisions 1, 6, 8, 10 and 11 and its "Runner and job queue"; the
single-owner model of [ADR 0001](0001-stack-and-architecture.md) decision 7 (Cloudflare Access as the only door)
and [ADR 0003](0003-console-github-app.md) decisions 3–4 (one owner connection per environment). Number 0007 is
held by #386. Threat model: `docs/security/309-threat-model.md`, components C9–C11 added with this ADR.

## Context

ADR 0006 made the console the tracker for one owner and one team, with jobs on the owner's Mac under the owner's
Claude subscription. Two things changed on 2026-11-09:

- **The product.** The console is to be sold to other teams. Every table, route and credential the console has is
  single-tenant today: `projects` has no owner, `owner_connections` is one row per environment, the owner is
  `OWNER_EMAIL` behind Cloudflare Access, the GitHub App installation is "the" installation, and the route matrix
  (#449) knows `owner` and `job` but no account. Retrofitting a tenant boundary after the team-console import and
  after the first customer would mean migrating live rows twice; doing it now means migrating one owner's fixtures.
- **Where Claude runs.** Anthropic's terms for Claude Code (`code.claude.com/docs/en/legal-and-compliance`,
  "Authentication and credential use" and "Can customers offer Claude Code in their products?", read 2026-11-09)
  say: third-party developers may not offer Claude.ai login in their applications, may not route requests through
  Free/Pro/Max/Ultra plan credentials on behalf of their users, and may not collect, store or intermediate Claude.ai
  credentials or session tokens — sign-in must complete through Anthropic's own flow; products that run Claude Code
  must run the unmodified binary, and each end user authenticates with their own API key, subscription or
  third-party-provider credential, billed to them. The Agent SDK overview repeats it: "Anthropic does not allow
  third party developers to offer claude.ai login or rate limits for their products". So a hosted runner may use a
  customer's **API key**, never a customer's subscription; a runner on the customer's own machine may run the
  unmodified CLI however the customer signs in there. The owner adds a rule stricter than the terms: **no path ever
  uses a Claude.ai subscription on our servers**, and the owner's own team gets no special local-Mac path — the
  late-October cloud failure ("organization has disabled Claude subscription access for Claude Code") showed what a
  dependency on one machine or one login costs.

Constraints that stay: $0 until the owner approves spend (Workers Free, D1 Free, Zero Trust Free; the repository is
public); agents never see a secret value other than their own job token (and, inside a job, the inference
credential the job runs on); item text, comments, PR bodies, CI logs and imported content are data, never
instructions; the team-console cutover (#437, Phase 6) must not wait for the whole product to exist.

## Decisions

| # | Decision | Why | Rejected |
| - | -------- | --- | -------- |
| 1 | **Accounts are the tenant.** `accounts` (ULID `id`, `slug`, `name`, `plan`, `entitlements` JSON, timestamps) own `projects` (`+ account_id NOT NULL`), `runners`, `role_keys`, `jobs`, `installations`, `inference_keys` and `audit_events`; every other tracker table stays keyed by `project_slug` and is reached only through its project. `projects.slug` stays **globally unique** (first come, like a package name), so every existing URL, DTO and route keeps its shape and the plugin's `TC_PROJECT` stays a slug. The migration creates one account for the existing owner (`slug = 'owner'`, renamed from the console) and attaches every existing project, connection, installation, runner and job to it; existing routes are unchanged by it. | One foreign key on the handful of account-level tables and a single chokepoint for the rest is less surface than `account_id` on 20 tables; a globally unique slug avoids re-shaping every route and the plugin's client while nothing customer-facing exists yet. | `account_id` denormalised onto every table (a 20-table migration now, before the shape is proven — revisit if the chokepoint test finds a leak); per-account URLs `/a/:account/p/:slug` (changes the plugin's addressing before cutover); one D1 per tenant (Workers bindings are static; the D1 HTTP API would need an API token in the Worker). |
| 2 | **Isolation is one chokepoint, tested like the matrix.** `projects/lookup.ts` takes the request's **account scope** (the accounts the session user is a member of; the one account of a job or runner token) and answers 404 `project-not-found` for any project outside it — the same answer as a slug that does not exist, so nothing is enumerable. `accountAccess` middleware sets the scope before `trackerAccess`; the route matrix gains the account dimension implicitly (an actor is always judged against a project its scope admits). An **account inventory spec** lists every route under `/api/v1/projects/:slug` and `/api/v1/accounts/:id` and fails on one that does not pass through the lookup or the account check; repos that take a `project_slug` never take one from a body — only from the admitted project. Account-level routes (`/api/v1/accounts/:id/...`: members, invites, installations, runners, inference keys, audit) are owner-of-account only. | The #449 matrix proved that a table in code plus an inventory test holds better than per-handler checks; the account check reuses the pattern rather than adding a second grammar. | Row-level checks in every repo (40 places to get wrong); a separate Worker per tenant (not free). |
| 3 | **Sign-in is "Sign in with GitHub" through the environment's existing GitHub App; sessions are the console's own.** `users` (`id`, `provider`, `provider_user_id`, `login`, `email`, `avatar_url`), `sessions` (opaque 256-bit id hashed in D1, 24 h idle / 30 d absolute, `HttpOnly; Secure; SameSite=Lax` cookie, rotated on sign-in), `account_members` (`account_id`, `user_id`, `role ∈ owner \| member`, `invited_by`, `joined_at`), `invites` (hashed token, 7 days, single use, bound to a GitHub login or open). The first sign-in with no membership creates an account with that user as owner (self-service). `OWNER_EMAIL` and the owner's Access identity retire from `/api/*` at the first customer; until then both doors exist and map to the same user row. Cloudflare Access stays in front of **operator** routes only (`/api/v1/admin/*`: plans, entitlements, account list) and, as today, in front of dev/stage as a perimeter. `identity.kind = 'user'` carries `userId` and the membership list; "the owner" in every ADR 0006 rule means **an `owner` member of the project's account**. GitLab sign-in arrives with Phase 5 as a second provider on the same `users` table. | The customers are GitHub users and the OAuth app already exists (ADR 0003's user-to-server flow); no new identity vendor, no email/password to protect; roles stay the two the decision policy knows (owner decides, member works). | Cloudflare Access per customer (no self-service, 50 seats, operator-configured); Auth0/Clerk/WorkOS (a vendor and a free-tier ceiling for a feature GitHub OAuth gives); magic-link email (needs an email provider now — invites are links shown to the inviter instead). |
| 4 | **Installations and owner-grade connections are per account.** `installations` (`account_id`, `provider`, `installation_id`, `account_login`, `linked_by_user_id`, `linked_at`, `suspended_at`) replaces the environment-wide "project installation" (0006 migration): the GitHub App's **setup URL** receives `installation_id` + a signed `state` naming the account, the console verifies through the app JWT that the installation exists and that the signed-in user is an admin of the installed org/user, then links it. A project is created only from a repository of a linked installation. `user_connections` (the ADR 0003 token pair, per user, sealed as today) replaces `owner_connections` and serves owner-grade writes (#386) for the accounts that user owns. Read tokens are minted per installation as today (ADR 0003 decision 6). | One GitHub App per environment for every customer is how GitHub Apps are meant to be installed; the console already holds the app key; per-account linking is one table and one handshake. | A GitHub App per customer (keys in the Worker per tenant); the customer's PAT (owner-grade, not revocable by us). |
| 5 | **Audit is a table.** `audit_events` (`account_id`, `at`, `actor_kind ∈ user \| job \| runner \| system \| operator`, `actor`, `kind`, `target`, `details` JSON, `ip_country`) is append-only and written in the same batch as the action for: sign-in and sign-out, invite created/accepted/revoked, role changes, installation linked/unlinked, runner enrolled/revoked, inference key set/rotated/deleted, hosted mode enabled/disabled, spend-cap changes, cutover switch and rollback, plan/entitlement changes by the operator. Account owners read it (`GET /api/v1/accounts/:id/audit`, cursor-paged); it is never edited and holds no secret values (the redactor runs on `details`). `item_events` stays the per-item audit. | A customer who pays for an agent team needs to see who gave it which key and which repository; the operator needs the same for incidents. | Logs only (not queryable by the customer, not durable). |
| 6 | **Billing is a seam, not a feature.** `accounts.plan ∈ free \| team` and `accounts.entitlements` JSON (`max_projects`, `max_members`, `hosted_runner: bool`, `max_concurrency`, `spend_cap_usd_month`) are read by one function, `entitlementsOf(account)`, that every limit check calls; the operator sets them through the Access-protected admin route; defaults are the free tier. No payment provider, no invoices, no card data. | The limits must exist for isolation and cost control whatever the pricing turns out to be; the pricing is the owner's later decision. | Stripe now (a paid-side surface before a product). |
| 7 | **Two execution modes per account, both on the same job protocol.** **(a) Self-hosted runner**: the customer installs `team-console-runner` (one command — a signed release tarball for macOS and Linux with a checksum, and a container image; `enrol` by the one-time code of ADR 0006). It runs the **unmodified Claude Code CLI**; the customer signs in on their own machine through Anthropic's flow or configures their own API key in the runner's config; **the console never sees, stores, proxies or copies that credential**: the runner passes a credential *location* (an `ANTHROPIC_API_KEY` from its own config, or the customer's Claude config directory mounted read-only into the job sandbox), never a value, and never uploads it. A packaging of the same binary as a **GitHub Actions workflow** (`team-console-runner.yml` in the customer's repository, dispatched by the console through the app's `actions: write` on that repository only, the customer's key in their repository or environment secrets) is the zero-infrastructure form of (a). **(b) Hosted runner**: the console runs the job on infrastructure the operator pays for, using the **customer's own Anthropic API key** (BYOK) stored sealed per account (`inference_keys`: AES-256-GCM under an HKDF subkey of `TOKEN_ENCRYPTION_KEY` with AAD `account:<id>:anthropic`, `key_id`, `last4`, `created_by`, `rotated_at`, `revoked_at`); the key is decrypted only when a job of that account starts, injected into that job's sandbox only, never written to D1 plaintext, logs or events (redactor pattern `sk-ant-`), rotated or revoked by the account owner in one screen; a **spend cap** per account per month (`spend_cap_usd_month`) and per job (`payload.maxUsd`) is enforced from the CLI's reported cost (`--output-format json`, `total_cost_usd`) and the console refuses to start a job past the cap. **No mode ever uses a Claude.ai subscription on our servers**, and the hosted sandbox refuses to start when its environment would carry a Claude OAuth credential. | Anthropic's terms allow exactly these two shapes (the unmodified binary with the end user's own credential; API keys for third-party products); the owner wants no path through our servers on anyone's subscription. One job protocol means the plugin, the matrix and the gate do not know which mode ran the job. | A hosted runner on the customer's subscription (forbidden by the terms and by the owner); the console relaying Claude.ai OAuth (forbidden); a shared operator API key with resale (forbidden: "may not pay for, resell, or intermediate Claude usage"). |
| 8 | **Every job runs in its own sandbox; no state crosses jobs or accounts.** ADR 0006's L3 (two macOS users) becomes one of three **isolation backends** of the runner: `container` (default where a container runtime exists — Docker, Podman or Apple's container runtime; one fresh container per job from the pinned runner image, the clone as its only writable volume, no network to the runner's config, the socket bind-mounted), `user` (ADR 0006's `_tcrunner`/`_tcjob` layout for a Mac without a container runtime), `none` (dev/stage fixture environments only; refused on an account with real projects). Hosted jobs run **one ephemeral machine or container per job** on the chosen provider (decision 9), created by the console at dispatch with a **one-time bootstrap token** (10 minutes, single use) that lets the machine claim exactly that job; the machine is destroyed at `finish` or at `maxMinutes`. A hosted runner identity exists **per account** (`runners.hosted = 1`, enrolled by the console when the account enables hosted mode), so a hosted job's token names the account whose key it runs on, and `jobs.account_id` is checked against `inference_keys.account_id` before a key is decrypted. The cross-job controls of ADR 0006 ("Run": fresh `HOME`/`TMPDIR`, read-only managed settings with hooks disabled, hook-type git-config refusal, the plant-then-verify test) hold inside every backend. | A per-job sandbox is the multi-tenant form of L3: the owner's Mac was one host for one team; a hosted fleet is many accounts on shared infrastructure, where "no `_tcjob` process survives" is not enough — nothing may survive at all, and nothing from account A may be mounted into account B's job. | Shared long-lived workers with a user per account (persistent state, uid management per tenant); Firecracker/VM per job on self-hosted (the container runtime is what customers have). |
| 9 | **Hosted provider: Fly Machines first; Cloudflare Containers when the integration cost beats the price.** Both are **paid** and need the owner's `/approve` before anything is deployed. Fly Machines: a machine exists only for the job's duration, billed per second (shared-cpu-2x / 2 GB ≈ $0.015 per hour → a 90-minute job ≈ $0.02–0.03 plus a few cents of root-fs storage per month; no always-on process because the `api` Worker calls the Machines API at dispatch), Firecracker microVM per job, the image is the runner's own. Cloudflare Containers: needs the Workers Paid plan ($5/month, which also lifts the Worker's own limits) and bills memory/CPU/disk per second beyond 25 GiB-hours included (a 90-minute job at 4 GiB ≈ $0.05–0.10 beyond the included hours); the container is started from the Worker through a Durable Object binding — the simplest wiring but the larger fixed cost and the smaller instance sizes. Decision: implement the dispatch behind a `HostedBackend` interface (`start(job, bootstrapToken, env)`, `destroy(id)`, `status(id)`), ship Fly first, keep Containers as the second implementation. Until approved, hosted mode is `entitlements.hosted_runner = false` for every account and the owner's team runs mode (a). | Pay-per-second with no idle cost matches a queue that is empty most of the day; a microVM per job is the strongest isolation on offer at that price. | GitHub Actions on our account as the hosted runner (2,000 minutes a month on private repositories is 22 ninety-minute jobs; our minutes for customer jobs is intermediation of compute we would have to bill); a free VM (Oracle Always Free) as the fleet (fine for one team, not a product's hosted tier — kept as a self-hosted target); Workers alone (no process, no filesystem). |
| 10 | **The owner's team is account `owner` on the same terms.** Team-console and storify run in mode (a) — the GitHub Actions packaging on the public `team-console` repository (public repositories have no Actions minute charge; each job is an ephemeral GitHub-hosted VM, which satisfies decision 8 with backend `none` *inside* a single-job VM) or a self-hosted runner on any machine the owner chooses — with the owner's **own Anthropic API key** as the inference credential, under the same spend cap as any customer. There is no Mac-only path in the runner, the console or the plugin; ADR 0006's "the runner on the owner's Mac first" is superseded. Consequence the owner must accept: without the Mac and its subscription, running the team costs API tokens (Opus/Sonnet list prices; a development slot can cost single-digit dollars) — the spend cap is the throttle, and `roles.<role>.model` in the runner config trades quota for quality per role. | The owner asked for it; a team that eats its own product finds the installer's gaps before a customer does. | A local-Mac exception (what the owner refused); the owner's subscription on our hosted tier (the terms). |
| 11 | **ADR 0006's cutover prerequisites become: Phases 1a/1a′/1b, Phase 2 (identity, jobs, self-hosted runner with the installer, Settings › Runners), Phase 3a (VCS reads), the account boundary (decisions 1–2, 5) and the job sandbox verified (decision 8), the plugin pre-release, the owner's «да».** The gate stays on GitHub PR reviews until Phase 2-C and 3b land (the staged cutover of the 2026-11-09 architect note on #446: Stage A tracker, Stage B gate); sign-in (decision 3), per-account installations (decision 4), the billing seam (6), hosted mode (7b, 9) and GitLab sign-in follow the cutover and precede the first customer. R1 (ruleset and app write permissions) belongs to Stage B. | The tenant boundary and the audit must exist before rows are imported (migrating one owner's fixtures is cheap; migrating a live tracker and customers is not); everything the owner's single account does not need yet can follow without a data migration, because the owner's user, account and membership rows exist from the first migration. | Finishing the whole product before the cutover (months of GitHub-Issues dependence); cutting over on the single-tenant schema (a second migration of live rows). |

## Data model (migration `0017_accounts`, then `0018_runners_jobs`; numbers = highest on `dev` + 1 at PR open — `0016_item_approval` of #452/#458 is on `dev`)

| Table | Columns | Notes |
| ----- | ------- | ----- |
| `accounts` | `id TEXT PK` (ULID), `slug TEXT UNIQUE` (`^[a-z0-9][a-z0-9-]{1,38}$`), `name`, `plan` (`free` \| `team`), `entitlements TEXT` (JSON, validated by a guard), `created_at`, `suspended_at NULL` | Suspended: reads only, no jobs claimed. |
| `users` | `id TEXT PK`, `provider` (`github` \| `gitlab`), `provider_user_id TEXT`, `login`, `email NULL`, `avatar_url NULL`, `created_at`, `last_seen_at` | UNIQUE (`provider`, `provider_user_id`); `login` is display, the id is identity (ADR 0003 decision 2). |
| `sessions` | `id_hash TEXT PK`, `user_id`, `created_at`, `last_seen_at`, `expires_at`, `ip_country NULL`, `user_agent_hash NULL`, `revoked_at NULL` | 24 h idle, 30 d absolute; rotated on sign-in; "sign out everywhere" revokes by user. |
| `account_members` | `account_id`, `user_id`, `role` (`owner` \| `member`), `invited_by NULL`, `joined_at` | PK (`account_id`, `user_id`); the last `owner` cannot leave or be demoted. |
| `invites` | `token_hash TEXT PK`, `account_id`, `role`, `login NULL` (bound to a GitHub login, or open), `created_by`, `created_at`, `expires_at`, `accepted_by NULL`, `accepted_at NULL`, `revoked_at NULL` | 7 days, single use. |
| `installations` | `id INTEGER PK`, `account_id`, `provider`, `installation_id TEXT`, `account_login`, `linked_by_user_id`, `linked_at`, `suspended_at NULL`, `unlinked_at NULL` | UNIQUE (`provider`, `installation_id`) while linked. Replaces the project-installation columns of 0006. |
| `user_connections` | `user_id PK`, the sealed token pair and lease columns of `owner_connections` | `owner_connections` is copied into it for the owner's user and dropped. |
| `inference_keys` | `account_id`, `provider` (`anthropic`), `key_enc TEXT`, `key_id`, `last4`, `created_by`, `created_at`, `rotated_at NULL`, `revoked_at NULL` | PK (`account_id`, `provider`) while unrevoked; only the hosted dispatcher reads `key_enc`. |
| `audit_events` | `id INTEGER PK`, `account_id NULL` (operator events), `at`, `actor_kind`, `actor`, `kind`, `target NULL`, `details TEXT`, `ip_country NULL` | Append-only (no UPDATE/DELETE path in `@worker/db`, tested). |
| `projects` (altered) | `+ account_id TEXT NOT NULL` → `accounts`, `+ installation_id NULL` → `installations` | Backfilled to the owner's account in the migration. |
| `runners` (ADR 0006, altered) | `+ account_id NOT NULL`, `+ hosted INTEGER NOT NULL DEFAULT 0`, `+ isolation` (`container` \| `user` \| `none`), `+ allowed_projects TEXT` (JSON) | Enrolment codes are created inside an account. |
| `jobs` (ADR 0006, altered) | `+ account_id NOT NULL`, `+ bootstrap_token_hash NULL`, `+ bootstrap_expires_at NULL`, `+ cost_usd REAL NULL`, `+ hosted_instance_id NULL` | `account_id` is copied from the project at enqueue and checked at claim and at key decryption. |
| `account_spend` | `account_id`, `month` (`YYYY-MM`), `usd REAL`, `jobs INTEGER` | PK (`account_id`, `month`); updated at `finish`; read before dispatch. |
| `items.approved_at` (0016, #452/#458, unchanged) | — | The recorded owner approval. The account migration keeps it as is; the `member` actor can never set it (approval stays the effect of an owner decision or an owner write); the "approved text is frozen for a job" rule of the #446 note keys on `approved_at IS NOT NULL`, not on the status; `audit_events` does not duplicate it — `item_events` remains the item's audit. |

## Identity, routes and the matrix

- `authMiddleware` mints `user` from a session cookie (the Access path remains for the owner until decision 3's
  cutover and for `/api/v1/admin/*`), `service` as today, `runner` and `job` per ADR 0006 decision 8 and the #446
  note (opaque job token + the claiming runner's identity; hosted: the bootstrap token claims, then the job token).
  `identity.kind = 'user'` carries `userId` and `memberships: {accountId, role}[]`.
- `accountAccess` resolves the **scope**: a user's memberships; a job's or runner's one account. `projects/lookup.ts`
  takes the scope and answers 404 outside it. `trackerAccess` runs after it; the `owner` policy actor is "a user
  with `role = owner` in the project's account"; a `member` is a new policy actor with reads, `comment`s, `proposed`
  item creation and `requests` — never decisions, asks' answers, approvals, sprints, labels or settings.
- Account routes (`/api/v1/accounts/:id/{members,invites,installations,runners,inference-key,audit,settings}`) are
  owner-of-account only, with the same CSRF rules as every cookie-borne write; `POST /api/v1/accounts` is any
  signed-in user (self-service, rate-limited per user and per IP); `/api/v1/admin/*` is Access only.
- The **account inventory spec** (decision 2) is the acceptance test of every route added from here on.

## Runner, installer and hosted dispatch

- **Installer** (self-hosted): `curl -fsSL https://<console>/install.sh | sh` is refused as a pattern — the
  documented path is a **release asset with a checksum** (`team-console-runner-<version>-<os>-<arch>.tar.gz` +
  `SHA256SUMS` signed with the release key whose public half is in the repository and shown in the console), a
  Homebrew tap formula and a container image by digest. The installer creates the runner user/directories where the
  backend needs them, writes the config, and runs `enrol`. The runner **self-updates only to a release the console
  names** (`GET /api/v1/runner/release`) whose checksum it verifies; the console shows the runner version and
  flags one behind the minimum.
- **Backends** (decision 8) are chosen at `enrol` and reported in `capabilities`; the console refuses to enqueue a
  job of an account with real projects onto a runner whose backend is `none`.
- **Credentials inside a job**: mode (a) — `ANTHROPIC_API_KEY` from the runner's config, or the customer's Claude
  config directory mounted read-only (the runner never opens the files); mode (b) — the account's sealed key,
  decrypted by the dispatcher into the sandbox's environment only. The runner and the console refuse to start a
  hosted job whose environment would carry a Claude.ai OAuth credential (decision 7). Per-role model
  (`roles.<role>.model`) and the usage budget of the #446 note (concurrency, back-off on rate-limit or
  usage-limit output, visible in the console) hold in both modes.
- **Hosted dispatch**: `POST …/jobs` (Run now, a schedule or a webhook) → if the account is hosted and the job's
  kind is not `needs_local`, the Worker mints the bootstrap token, calls `HostedBackend.start` with the runner
  image, `TC_API_URL`, the bootstrap token and the decrypted key, and records `hosted_instance_id`; the machine
  claims, runs `run-once`, finishes, and the Worker destroys it (also from a Cron sweep for anything past
  `maxMinutes + 5`). The spend cap is checked before `start` and the job's cost is added at `finish`.

## Consequences

- Phase 2 grows by the account boundary (T-1, T-2 below) before 2-A, and the runner (2-B) is built for customers from
  the first commit: installer, three backends, no Mac-only code. The #446 note's children are re-cut in the
  2026-11-09 comment that follows this ADR.
- `OWNER_EMAIL`, `owner_connections`, `project_installation` and the Access-only door retire at the first customer
  (decision 3); the team's dev/stage keep Access as a perimeter in front of sign-in.
- The plugin (0.12) is untouched by multi-tenancy: a job token names one account through its project; `TC_PROJECT`
  stays a slug.
- The owner's team costs API tokens from the cutover on (decision 10) unless the owner keeps a self-hosted runner on
  a machine with his subscription — his choice per machine, not a product path.
- `CLAUDE.md`'s rules gain "every account-level table carries `account_id`; every project is reached through
  `projects/lookup.ts` with the request's scope".
- Pricing, invoices, customer support, status page, data export and account deletion are **not** designed here;
  account deletion and export must exist before the first paying customer (a GDPR-shaped obligation) and get their
  own issue.

## Not yet

- Per-tenant D1 or Durable Objects (if the row-level chokepoint ever leaks, the fix is decision 1's rejected
  denormalisation first).
- Email (invites are links; notifications are web push).
- An `admin` role between owner and member; SSO/SAML; audit export.
- Hosted mode on a customer's third-party inference provider (Bedrock, Vertex, Foundry) — the terms allow it; the
  dispatcher's environment is where it would plug in.
- Marketplace listing of the GitHub App; GitLab hosted sign-in (Phase 5).
