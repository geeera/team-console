# 0003 — The console's GitHub identity: a GitHub App per environment, owner writes on the owner's own token

Status: accepted (owner decision in chat, 2026-09-29, recorded on #21 and #25: «и GitHub App тоже включай»; the
technical shape below is a team decision under `reference/decision-policy.md`). Date: 2026-09-29. Amends
[ADR 0001](0001-stack-and-architecture.md) decisions 6, 8, 14 and 20. Facts marked "verified" were read from
GitHub's documentation on this date.

## Context

ADR 0001 decision 6 gave the `api` Worker a fine-grained personal access token (PAT) of the owner's account, and
the #9 threat model split it in two (a repo-only PAT for dev/stage, an all-product PAT for production, both as the
Worker secret `GITHUB_TOKEN`). The owner replaced that with "a GitHub App for the console" once the product-team
plugin 0.10.0 moved the agents onto GitHub Apps of their own (`reference/identities.md`).

That plugin change is what makes this decision non-trivial. Since 0.10.0 an owner command (`/approve`, `/go`,
`done`, `/reject why`) **counts only when the comment's author is the owner's login** (`ptlib/commands.parse`, the
demo decisions block, reversals of team decisions). A comment written with a GitHub App *installation* token is
authored by `<app-slug>[bot]`, so an answer the console posted that way would render correctly and be ignored by
the team. The plugin's own team chat has the same problem and solves it by refusing to post an owner answer with
anything but a token of the owner's account (`PT_OWNER_TOKEN`, `gh.owner_token`). The console must land on the
same side of that line.

Facts that shape the decision (verified 2026-09-29):

- A GitHub App has **one installation per account**, with one repository selection. "Install the same app on
  `team-console` for dev/stage and on all product repos for production" is therefore not expressible with one
  app — the split ADR 0001 / #9 wanted needs separate apps.
- An app has **one webhook URL and one webhook secret**, and receives events for every repository it is
  installed on; payloads carry `installation.id`. `issues`/`issue_comment` need Issues read, `pull_request`
  needs Pull requests read, `workflow_run` needs Actions read, `release` and `push` need Contents read;
  `installation_repositories` arrives without any permission.
- Installation access tokens live one hour, are minted with a JWT (RS256, `exp` at most 10 minutes) signed by
  the app's private key, and the mint request may **downscope** the token to named repositories and to a subset
  of the app's permissions. Rate limit: 5,000 requests/hour per installation — a budget separate from the
  owner's account and from the agents' team app.
- **User access tokens** (`ghu_…`, "user-to-server") are minted by the same app through the OAuth web flow
  (PKCE supported) and attribute every write to the user. With "Expire user authorization tokens" on, they live
  8 hours and come with a single-use refresh token (`ghr_…`) valid 6 months; a refresh returns a new pair and
  invalidates the old one. Their reach is the intersection of the app's permissions and installation with the
  user's own access; their rate limit is the user's.
- The `api` Worker sits behind Cloudflare Access (ADR 0001 decision 7, #8): only the owner reaches any
  `/api/*` route, including an OAuth callback. The `hooks` Worker is public and holds no GitHub credential
  (#12 threat row 6).

## Decisions

| # | Decision | Why | Rejected |
| - | -------- | --- | -------- |
| 1 | **One GitHub App per environment**: `team-console-dev`, `team-console-stage`, `team-console` (production), each created by the owner on their account ("Only on this account"), dev and stage **installed only on `geeera/team-console`** (the sandbox product of ADR 0001 decision 16), production installed on the product repositories the console manages. Each environment's `api` Worker holds only its own app's private key. | Per-environment trust zones are exactly what #9's threat model asked of the two PATs, and one app cannot express them (one installation per account); each app also needs its own webhook URL (decision 5) and OAuth callback (decision 3), which are per environment anyway. A leaked stage key reaches the sandbox repo only. | One app for all environments (a stage leak = read access to every product, and one webhook URL cannot feed three `hooks` Workers); one app for dev+stage and one for production (saves one app but dev and stage would share a webhook URL and a private key — the owner's checklist already repeats every step per environment, one more line costs less than a shared secret). |
| 2 | **Two kinds of tokens, split by who is speaking.** (a) **Reads** — issues, PRs, workflow runs, Contents (`project.yml`, `decisions_dir`), releases, milestones, and the Settings screen's "can the console read this repo" check — use **installation tokens**, minted per repository and **downscoped at mint to read-only** (`metadata`, `issues`, `pull_requests`, `contents`, `actions`: read) even though the app itself holds Issues write. (b) **Everything the owner says** — answers and commands (`/approve`, `/reject`, `/go`, `/no-go`, `/override`, `done`, #10), PM chat messages (`<!-- pt-chat:owner -->`, ADR 0001 decision 11), pause/resume — is written with a **user access token of the owner's account** obtained from the same app (decision 3). The console never writes to GitHub as `<slug>[bot]`. | Attribution is the whole point: the plugin counts owner commands only from the owner's login, and the console must not ask the plugin to trust a bot as the owner's proxy (see "Alternatives" below). Downscoping makes the installation token — the credential that exists in memory on every request — unable to write anything, so a captured one is a read leak, not an impersonation. | (a) Everything on the user token: reads would then hang on a refreshable credential the owner can revoke or let lapse (6 months idle), and share the owner's 5,000/hour with the plugin's team-chat session and their own `gh`; no per-installation budget. (b) Owner writes on a fine-grained PAT stored as a Worker secret (`OWNER_GITHUB_TOKEN`, the plugin's `PT_OWNER_TOKEN` shape): no OAuth code, but a second credential type with its own expiry (1 year), a repository list the owner must edit by hand on every new product, and one more secret per environment; the app's installation already is that repository list. Kept as the documented fallback if the OAuth flow cannot ship in the first sprint (`OwnerTokenSource` is an interface — the secret-backed implementation is ten lines), never as the target. (c) **A plugin change that trusts a console bot as an owner proxy**: rejected outright — it would reopen the hole 0.10.0 closed. `commands.parse` would accept a second login; any process with the console's private key (a leaked stage key, an agent session that can read the Worker's secrets, or anyone who can forge the bot's login string in a fixture) could then `/go` a release on every product the app is installed on, and the agents' `same_account` heuristic would have to learn a bot that "is" the owner. Plugin impact of the chosen option: **none**. |
| 3 | **Owner connection = OAuth web flow on the `api` Worker**, once per environment: `GET /api/v1/github/connect` (behind Access + #8's JWT check) redirects to `https://github.com/login/oauth/authorize` with `client_id`, `redirect_uri` = `https://<api host>/api/v1/github/callback`, a random `state` and a PKCE `code_challenge` (S256), both kept in a short-lived `HttpOnly; Secure; SameSite=Lax` cookie signed with `TOKEN_ENCRYPTION_KEY`; the callback checks `state`, exchanges `code` (+ `code_verifier`, `client_secret`) at `https://github.com/login/oauth/access_token`, calls `GET /user` and **refuses any login other than `OWNER_GITHUB_LOGIN`** (a non-secret var per environment in `wrangler.jsonc`), then stores the pair encrypted (decision 4). "Expire user authorization tokens" is **on**; "Request user authorization during installation" and Device Flow are **off**. Disconnect = `DELETE /api/v1/github/connection` (deletes the row; the owner revokes the grant on GitHub → Settings → Applications). | Access already restricts who can reach the callback; `state` + PKCE + the login check are defence in depth against login-CSRF (binding the owner's console to a stranger's account) and code injection. One button in Settings ("Connect GitHub") is the whole owner-facing UX; no token is ever typed or pasted. | Device flow (a code to type, and it needs the app's Device Flow switch on — a second entry point for no gain); pasting a token into Settings (a secret through the client, forbidden by `CLAUDE.md`). |
| 4 | **Storage of the user token pair: D1 table `owner_connections`** (`environment`, `login`, `access_token_enc`, `refresh_token_enc`, `access_expires_at`, `refresh_expires_at`, `version`, `connected_at`, `updated_at`; one row per environment), each token encrypted with **AES-256-GCM** under the Worker secret `TOKEN_ENCRYPTION_KEY` (32 random bytes, base64), a fresh 12-byte IV per write, AAD = `environment:column`. **Refresh**: on use, when the access token has < 30 minutes left, refresh first (`grant_type=refresh_token`) and write the new pair with an optimistic `version` check; a `401` on refresh re-reads the row — if `version` moved, another isolate already refreshed, use its pair; otherwise the grant is gone (revoked, or 6 months idle) → delete the row and answer **403 `github-owner-not-connected`** with the connect URL in the problem's `instance`. No cron: the console is used daily and a refresh token lives six months. Migration: the next free number (`0005_owner_connections.sql`; update the reserved list in `CLAUDE.md` when it lands). | Workers cannot write their own secrets, so the only place a Worker can persist a rotating credential is a store it owns; D1 exists already (ADR 0001 decision 5), and encryption under a secret the database never sees means a D1 dump alone is worthless. The optimistic `version` handles the one real race (two devices answering in the same minute) without a Durable Object. | KV (fine for three writes a day, but a second store next to D1 for nothing); Durable Object storage (not needed for one row); plaintext in D1 (a database export would be an owner credential). |
| 5 | **Webhooks come from the app, not from per-repository hooks.** Each app's webhook is active with URL `https://team-console-hooks-<env>.<account>.workers.dev/hooks/github`, its own secret (the `hooks` Worker secret `WEBHOOK_SECRET` — now one per environment/app instead of one string shared everywhere), events `issues`, `issue_comment`, `pull_request`, `workflow_run`, `release`, `push`, and `installation_repositories` (arrives regardless). Registering a product (ADR 0001 decision 20) no longer includes "add a webhook on the repo": installing the app on the repository is the one owner action that grants reads **and** events. #12's pipeline is unchanged (HMAC over the raw body, dedupe, author gate, routing by `repository.full_name`); it gains one mapping row: `installation_repositories.removed` → mark the matching registry rows `access_lost_at` and push "the console lost access to <repo>". | One place to grant and one to revoke; the shared-secret-across-products weakness the #12 threat model listed (one leak forges events for all products) disappears with it. | Per-repo webhooks with a shared secret (ADR 0001 decision 20 — one more owner step per product and one secret to leak for all of them); app webhooks **and** per-repo hooks (double deliveries). |
| 6 | **Minting in the Worker**: `libs/worker/github/src/app-auth.ts` — no dependency. RS256 JWT via `crypto.subtle` (`RSASSA-PKCS1-v1_5`, SHA-256), claims `iat = now − 60 s`, `exp = now + 9 min`, `iss = GITHUB_APP_ID`; the key comes from the Worker secret `GITHUB_APP_PRIVATE_KEY` **as GitHub downloaded it** (PKCS#1, `BEGIN RSA PRIVATE KEY`) and is wrapped into PKCS#8 in code before `importKey` (`BEGIN PRIVATE KEY` is accepted as is) — the owner converts nothing. Installation id per repository from `GET /repos/{owner}/{repo}/installation` (JWT auth; 404 → `github-app-not-installed`, the Settings screen's "install the app on this repository" state, replacing ADR 0001 decision 20's "PAT cannot read this repo"). Token per repository from `POST /app/installations/{id}/access_tokens` with `repositories: [name]` and the read-only `permissions` of decision 2. **Cache** per isolate: `Map<repo, {token, expiresAt}>`, reused until 5 minutes before expiry (the plugin's margin), never persisted, never logged; a `401` from GitHub on a cached token evicts it and retries once. `GitHubClient` takes a `TokenSource` (`InstallationTokenSource` for reads, `OwnerTokenSource` for writes) instead of a string. | Two HTTP calls and forty lines of Web Crypto do not justify a signed dependency in the credential path of a public repository; the plugin's `ghapp.py` is the reference implementation to mirror (backdated `iat`, 5-minute renewal margin, per-repo tokens). PKCS#1 → PKCS#8 wrapping is a fixed DER prefix and removes an `openssl` step from the owner's checklist. | `@octokit/auth-app` / `universal-github-app-jwt` (works on Workers, but pulls a request stack next to a hand-rolled client that already has stricter redirect rules); storing `installation_id` as a var (one more thing to copy per environment, and it would not detect a removed installation). |
| 7 | **Configuration per environment.** `api` Worker vars (non-secret, in `wrangler.jsonc`): `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `OWNER_GITHUB_LOGIN`. `api` Worker secrets: `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`. `hooks` Worker secret: `WEBHOOK_SECRET` (the app's). **`GITHUB_TOKEN` is removed** from `apps/api/src/env.ts` and the checklist. Local development keeps `GITHUB_MOCK=true`; a developer who needs real GitHub locally puts the **dev** app's values in an untracked `.dev.vars`. Rotation: a new private key is generated in the app (GitHub allows several at once), put with `wrangler secret put`, and the old one deleted from the app — no downtime; a new client secret the same way; rotating `TOKEN_ENCRYPTION_KEY` = the owner presses "Connect GitHub" again. | Every secret is set once with `wrangler secret put`, as ADR 0001 decision 14 prescribes; the public repo carries only ids. | Base64-encoding the PEM (`wrangler secret put NAME < file` takes the multi-line PEM verbatim). |
| 8 | **Threat model rows (ADR 0001 decision 8, #8/#9/#12) updated.** Assets: per-environment app private key (mints **read-only** per-repo tokens; production's reaches every product repo — read blast radius only), app client secret (with a captured `code` → an owner token; needs the callback behind Access **and** the PKCE verifier), the owner token pair in D1 (useless without `TOKEN_ENCRYPTION_KEY`; both together = act as the owner on Issues of the product repos for ≤ 6 months, revocable in one click on GitHub), the app webhook secret (forge events for that environment only). Controls: installation tokens downscoped at mint; owner token only on the write path, refreshed on use, deleted on `401`; callback under Access + JWT + `state` + PKCE + login check; sentinel tests extend from `github_pat_` to `ghs_`, `ghu_`, `ghr_` and the PEM header; the `hooks` Worker still holds no app key or token; `503 github-auth` now means "the app credential is broken" (JWT rejected, app uninstalled, key rotated) and `403 github-owner-not-connected` means "the owner has to press Connect" — the client must tell them apart. | Same assets list, one place, so reviewers check against it. | — |

## Alternatives considered for the attribution problem, in one place

| Option | Verdict |
| ------ | ------- |
| (a) All console traffic on a user access token | Rejected for reads (decision 2); **chosen for owner writes**. |
| (b) Owner writes on a fine-grained PAT secret, installation token for the rest | Same attribution outcome with less code; loses to (a) on operations (manual repo list, yearly expiry, one more secret type). Fallback only. |
| (c) Plugin trusts the console bot as an owner proxy | Rejected: reintroduces bot-authored owner commands the plugin just stopped counting, on every product at once. |

## Consequences

- **#9 (GitHub proxy)**: "PAT-backed" becomes "installation-token-backed"; the client takes a `TokenSource`;
  `app-auth.ts` (JWT, PKCS#1 wrap, per-repo mint, cache) is in scope of #9 or split from it; the sentinel test
  covers the new prefixes; error mapping gains `github-app-not-installed`. Everything else in its note holds.
- **#10 (answer endpoint)**: writes through `OwnerTokenSource`; without a connection it answers
  `403 github-owner-not-connected` and never falls back to any other token. The italic line "Answered by the
  owner in the team console" is unchanged; the comment's author is the owner, so `backlog answers` and the demo
  block count it, exactly like `backlog answer` from the team chat.
- **New issue: "Connect GitHub" flow** (decisions 3–4; `security`): routes `connect`/`callback`/`connection`,
  the `owner_connections` migration, AES-GCM helpers in `libs/worker/core` (2+ consumers: token store and the
  state cookie), the Settings screen state. #10 can merge before it (the endpoint is testable with a fake
  `OwnerTokenSource`), but answering from the console works only after it.
- **#12 (webhooks)**: the secret is the app's; add the `installation_repositories` row; a config test that the
  `hooks` `Env` references neither `GITHUB_TOKEN` nor any `GITHUB_APP_*`.
- **#7 / PR #54 (owner checklist)**: step 6 (two PATs) becomes "three GitHub Apps"; step 7's per-repo webhook
  becomes the app's webhook; the secrets tables drop `GITHUB_TOKEN` and gain `GITHUB_APP_PRIVATE_KEY`,
  `GITHUB_APP_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` on `api`; three non-secret vars land in `wrangler.jsonc`
  by PR (#25).
- **Registering a product** (ADR 0001 decision 20) is now: Settings screen row + install the production app on
  the repo + the routine token. The console shows "install the app" until `GET /repos/…/installation` succeeds.
- **Plugin**: no change needed. The console obeys the same rule as the plugin's team chat: owner words only with
  the owner's own credential. The `same_account` item in the inbox is unaffected (the console is not an agent
  session).
- Free-tier maths: each environment's installation has its own 5,000/hour; owner writes are a handful a day on
  the owner's own limit. Nothing new costs money.

## Not yet

- A second user (a reviewer logging into the console): would need a second `owner_connections` row keyed by
  Access identity and the plugin's `team.reviewer_logins` semantics on the write path.
- The native client: same `TokenSource`s behind the same API; nothing here is web-only.
- Using `installation.id` from webhook payloads to skip the per-repo lookup (an optimisation, not needed for one
  user).
