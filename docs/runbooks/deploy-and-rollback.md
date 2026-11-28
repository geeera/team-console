# Deploy and rollback

Source: `.github/workflows/deploy.yml` (ADR 0001 decision 14, #25). Every deploy runs in GitHub Actions —
agents never call `wrangler` or any provider CLI directly, and credentials never leave GitHub Environment
secrets.

## How a deploy starts

| Trigger | Environment | Who |
| --- | --- | --- |
| Push to `dev` (a merged `feature/fix` PR) | `dev` | automatic |
| Push to `stage` (the stage cut, or a `fix/*` back-merge target) | `stage` | automatic |
| Push to `main` (the release PR, or a `hotfix/*` merge) | `production` | automatic |
| `workflow_dispatch` with `environment` + `ref` | the chosen environment | manual — rollback or redeploy |

Every run goes through two jobs:

1. **`guard`** (no secrets, no `environment:`) resolves the target environment, pins the exact commit SHA,
   and — for `workflow_dispatch` only — proves the run was started from that environment's own branch
   (`dev`/`stage`/`main`) and that the `ref` it was given is actually reachable from that branch (never an
   unreviewed commit). It also refuses to continue if either `apps/api/wrangler.jsonc` or
   `apps/hooks/wrangler.jsonc` still has a placeholder D1 database id for that environment.
2. **`deploy`** (`needs: guard`, gated by the GitHub Environment's branch policy and, on `production`, the
   required reviewer) builds once, runs D1 migrations, deploys both Workers, and — on `dev` only — publishes
   Storybook. A post-deploy smoke check fails the job if the environment doesn't answer the way it should
   (see below); a failed smoke check means the release did not happen, not a passing deploy with a warning.

## Smoke checks

- **`api` Worker** (`team-console-<env>.<account>.workers.dev`): every environment sits behind Cloudflare
  Access, so an unauthenticated request must get **401/403** (Worker fail-closed, before Access is
  configured) or a **302 redirect to `*.cloudflareaccess.com`** (once it is). An unauthenticated **200** is a
  broken deploy and fails the job — Access missing is a regression, never a pass.
- **`hooks` Worker** (`team-console-hooks-<env>.<account>.workers.dev`): deliberately public (GitHub webhook
  target, ADR 0001 decision 4) — `/healthz` must answer plain **200**.
- **Storybook** (`dev` only, `team-console-storybook.pages.dev`): no automated smoke check beyond the
  `wrangler pages deploy` step succeeding; check the deployment URL it prints.

## Rollback (and redeploy) procedure

Rolling back is the same `workflow_dispatch` path as a manual redeploy — the only difference is which `ref`
you give it: the previous good commit instead of a newer one. There is no separate "rollback" workflow.

1. Find the previous good commit on the target branch (`git log --oneline origin/<branch>`, or the `sha`
   `guard` printed on an earlier successful run).
2. Start the dispatch **from the target environment's own branch** — `dev` for `dev`, `stage` for `stage`,
   `main` for `production` (`guard` rejects any other combination; see "Verify workflow_dispatch targets its
   own branch and a reviewed commit" in `deploy.yml`). On `production`, `ref` must additionally be an
   existing `v*` release tag.
3. Trigger it:
   - GitHub UI: **Actions → deploy → Run workflow**, pick the branch, fill `environment` and `ref`.
   - `gh` CLI (owner's machine, `gh auth login` already done per the owner checklist):
     ```
     gh workflow run deploy.yml --ref stage -f environment=stage -f ref=<previous-sha-or-tag>
     ```
4. Watch the run: `guard` re-validates the ref is reachable from `stage`/`dev`/`main`'s history, `deploy`
   rebuilds and redeploys that exact commit, reruns D1 migrations (safe — migrations are expand-only per
   release, so redeploying an older commit never needs a down-migration) and reruns the smoke checks.
5. Record the result on the originating issue: run URL, the `ref` rolled back to, and the smoke-check
   outcome.

This repository has no branch protection on the free GitHub plan, so `branch-guard.yml` is the after-the-fact
check — it opens a `sev:critical` issue if `dev`, `stage` or `main` ever moves without a merged PR. A
`workflow_dispatch` deploy does not move any branch, so it never trips that guard; only a direct push would.

### Redeploying the same commit gives installed apps a new version (#333)

A `workflow_dispatch` redeploy of the commit an environment already runs is enough to make an installed PWA
see an update — no fix-PR is needed to "ship a new version" (for a demo of the update banner, or to push a
heal). The "Stamp the console build" step writes the run's own UTC time into `__TC_BUILT_AT__`, which ends up
in the console's `main-*.js`; its content hash (and with it chunk names and `index.html`), and therefore
`ngsw.json`'s `hashTable` all change, and the service worker treats any `ngsw.json` change as a new version.
Checked on #333 by running that step and `nx run console:build:production` twice for one commit (`c909d40`):
`main-Y5GCWT7W.js` → `main-APQHVW6C.js`, a different `index.html` hash and a different set of chunks in
`ngsw.json`. What the owner then sees is `AppUpdates`' behaviour (#306): the app finds it on its 5-minute
check while it stays on screen and shows «Доступна новая версия · Обновить»; if it was in the background, the
next return to it (a resume check) reloads into the new version by itself, without the banner.

```
gh workflow run deploy.yml --ref dev -f environment=dev -f ref=<the sha dev already runs>
```

### Stage-only rehearsal (#25)

The demo (2026-10-16) runs on `dev`; `dev`'s Workers, variables and D1 are never touched to rehearse a
rollback. The rehearsal targets `stage` exclusively:

1. Confirm `stage` has had at least two deploys (so there is a genuinely older `ref` to roll back to) — the
   stage cut from `dev`, then one more change.
2. Dispatch `deploy.yml` with `environment: stage` and `ref` = the commit before the most recent stage
   deploy, started from the `stage` branch.
3. Confirm the run is green (guard + deploy + both smoke checks) and that the deployed commit matches `ref`
   (the "Assert this checkout is exactly the commit guard validated" step prints it).
4. Record the run URL and outcome as a comment on #25.

## Repository id backfill after migration 0018

The first deploy of an environment that runs `0018_accounts.sql` (stage and production: the Stage A cutover
release) adds `projects.repo_id` empty, and webhooks route by that id only (#484). **Right after that deploy's
"D1 migrations (remote, before traffic moves)" step and the smoke checks are green**, the owner runs
[repo-id-backfill.md](repo-id-backfill.md) for that environment until its step a returns no rows. Until then the
hooks Worker drops deliveries for the projects not yet backfilled (fail-closed, expected and short). Rolling back
to a commit before #484 does not undo it: migrations are expand-only, the column and the recorded ids stay.

## Actions setup write: stop and incident (#759)

The console's one write to a customer repository is the workflow pull request (`POST
/api/v1/projects/:slug/actions-setup/workflow-pr`). It runs only while the api Worker's var
`ALLOW_ACTIONS_SETUP_WRITE` is `true` **and** no operator stop is in D1 (ADR 0008, "Amendment (#759)").

**Stop it now, without a deploy** (any operator with the environment's Cloudflare access; takes effect on the next
request, and stays through every later deploy until the row is deleted):

```sh
npx wrangler d1 execute team-console-<env> --env <env> --remote --config apps/api/wrangler.jsonc --command \
  "INSERT INTO operator_stops (name, stopped_at, reason) VALUES ('actions-setup-write', strftime('%Y-%m-%dT%H:%M:%SZ','now'), '<issue or incident reference>')"
```

Check: the route answers 503 `github-write-disabled`; the readiness check and the Copy path keep working, so customers
can still add the file themselves. Lift the stop, once the cause is fixed and recorded on the issue:

```sh
npx wrangler d1 execute team-console-<env> --env <env> --remote --config apps/api/wrangler.jsonc --command \
  "DELETE FROM operator_stops WHERE name = 'actions-setup-write'"
```

The stop can only switch the path off. **Switching it on for an environment is never an incident step**: it is a
reviewed PR (security label) that sets `ALLOW_ACTIONS_SETUP_WRITE` to `true` for that environment in
`apps/api/wrangler.jsonc`, made after the owner has added Contents, Workflows and Pull requests: Read and write to that
environment's GitHub App. Never pass the var with `--var`, never store it as a secret or a GitHub variable
(`tools/workspace-checks` fails on any of those), and do not edit it in the Cloudflare dashboard: the next deploy
overwrites a dashboard edit.

**The alert.** Above 30 attempts across all accounts in an hour the Worker logs `actions setup write volume` at error
level, once per further attempt (Workers Logs, filter `message = "actions setup write volume"`). Treat it as a reason
to look at the audit rows below; if they do not explain it, stop the path first and investigate after.

**Getting notified (#843).** The log line alone tells nobody; the notification is a Cloudflare alert, which can
only be created in the dashboard (wrangler does not configure alerts, and no classic Cloudflare notification type
matches a log message on the free plan). No code in this repository emits it: a web push from the write path would
need a change in `apps/api/src/routes/actions-setup-problems.ts`, a security path.

The logs come from config, not from a dashboard toggle: `"observability": { "enabled": true }` in
`apps/api/wrangler.jsonc`, inherited by `dev`, `stage` and `production` and applied by the next deploy. Do not
switch Workers Logs on or off in the dashboard; the next deploy overwrites it. Free plan: 200,000 log events a day,
3 days of retention; every line the Worker logs is stored at Cloudflare (the logger redacts credentials first).

Owner steps, once per environment where `ALLOW_ACTIONS_SETUP_WRITE` is `true` (today: dev; add stage and production
in the PR that turns the switch on), after that environment has deployed with the config above:

1. Primary, available to every Workers account: Cloudflare dashboard → Workers & Pages → the environment's Worker
   (`team-console-dev`) → Issues (open beta, free) → create an automation that sends issues to a webhook, chat
   service or incident tool you read on your phone. The line is logged at error level, so it surfaces as an issue.
   Issues may **group repeated errors**: a burst of 31+ attempts can arrive as one notification, not one per line;
   open the issue and the Logs view for the count.
2. If your plan has Monitors: create one on the log query `message = "actions setup write volume"`, threshold at
   least 1 match in 1 hour, with the same kind of destination. This one notifies per hour window rather than per
   group. Menu names move; the query and the threshold are what matter.
3. Untested end to end until the owner does it: the real trigger is 31 write attempts in an hour (each account is capped at 20 an hour, so it takes at least two accounts), which is not practical to produce on
   dev. After creating the alert, confirm what you can: the Logs view shows the query working on any past
   `console` line, and the destination received the automation's test message. Treat the first real firing as the
   test, and fix the runbook if it differs.

**When it fires.** In order, stopping at the first step that settles it:

1. List the `project.actions-workflow-pr-attempted|opened|failed` audit rows for the last hour (below). One account
   or project hammering the button, or a script, is the common cause.
2. If they do not explain it, or you cannot tell within a few minutes, **stop the path now with the D1 stop above**
   (`INSERT INTO operator_stops ...`). It needs no deploy and takes effect on the next request. This is the
   kill switch for `ALLOW_ACTIONS_SETUP_WRITE` without a deploy; the var itself is changed only by a reviewed PR.
3. Investigate with the path off; if the app key may be exposed, follow the incident steps below.
4. Lift the stop (`DELETE FROM operator_stops ...` above) once the cause is fixed and recorded on the issue.

**If the app's private key or the api Worker may be compromised.** The app's write permissions make this a High
incident (threat model C11): whoever holds the key mints their own tokens, so the stop above does not contain it.

1. Stop the path (above), so the console itself opens nothing more.
2. Rotate `GITHUB_APP_PRIVATE_KEY`: generate a new key in the App's settings, `wrangler secret put`, delete the old key.
3. **Suspend the App's installations** (the App's settings → Advanced, or each installation's page). A token minted
   before the rotation stays valid for up to an hour; suspending is what ends it early.
4. List what the console did, per account:
   `SELECT at, account_id, actor, kind, target, details FROM audit_events WHERE kind LIKE 'project.actions-workflow-pr-%' ORDER BY id DESC`.
   A repository changed without a matching `…-opened` row was not changed by the console's route.
5. Tell the owners of the affected accounts which repositories to check: branches named `team-console/runner-*`,
   `.github/workflows/` on the default branch, and the `team-console` Environment's deployment-branch rule and key.
   Ask them to rotate `TC_INFERENCE_API_KEY` if the default branch has no ruleset.
6. Unsuspend, lift the stop and record the timeline on the incident issue.

## A secret in tracker text: rotate, then scrub (#462, #477)

A credential ended up in stored tracker text: an item's title or body, a comment, an ask, the PM's reason on a
request, a sprint's title or description, or text the import brought from GitHub. Jobs are refused such text
(422 `body-secret`), and the import runs the same check (`findSecretInText` / `maskSecretsInText` of
`@shared/redaction`), so in practice this is the owner's own paste, or a credential no pattern knows (a password).

**The order is fixed: rotate first, scrub second.** The scrub removes the text from what the console shows and
serves from now on. It is not containment: it cannot reach the copies listed under "What the scrub does not reach",
and until the secret is rotated every one of them is a live credential.

1. **Rotate or revoke the secret at its issuer, now**, before touching the console (GitHub token, API key, the
   `wrangler secret` and GitHub Environment values that hold it, a runner credential in Settings). Check the
   issuer's audit log for use since the time the text was written. From here on the leaked value is dead; the rest
   is hygiene.
2. **Open an incident issue** (label `security`) that says what kind of secret it was, where it was (project, item
   key, comment / ask / request ids, sprint number) and when it was rotated. Never paste the value. This issue is
   also the record of what was scrubbed if D1 is ever restored to an earlier point (see Time Travel below).
3. **Correct the live text** where the console lets you edit it: `PATCH` the item's title and body (the item page).
   This leaves the old text in the item's history; step 4 masks it.
4. **Scrub** (owner only; every job role and the service identity get 403). There is no screen for it yet; from the
   console's own tab (same origin, so the session and CSRF rules apply), in the browser's developer console:

   ```js
   const scrub = (path, body) =>
     fetch(`/api/v1/projects/<slug>/${path}`, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
       body: JSON.stringify(body),
     }).then(async (response) => [response.status, await response.json()]);

   // The old title and body kept by the item's created / edited / imported events (after step 3):
   await scrub('items/<KEY>/events/scrub', {});
   // Comments, asks and request reasons of that item, by id, with or without its history:
   await scrub('items/<KEY>/events/scrub', { events: true, comments: [12], asks: [3], requests: [5] });
   // A sprint's title, description or both:
   await scrub('sprints/<number>/scrub', { fields: ['title', 'description'] });
   ```

   The ids are the `id` members of `GET …/items/<KEY>/comments`, `…/asks` and `…/requests`. Each masked text becomes
   `[scrubbed]` (a sprint title becomes `[scrubbed] <number>`, since titles are unique per project). Nothing else
   of a row changes: author, time, kind, an ask's commands and answer, a request's result all stay, and the
   database refuses any other update of these rows (migration 0043). An id that is not the item's own, or a request
   nobody answered, is 422 and nothing is masked. A request takes at most 50 ids of each kind.
   The body must be valid JSON: a body that does not parse, or is not an object, is 422 and nothing is masked.
5. **Check.** Read the item, its comments, asks, requests and events (or the sprint) again and search for the
   value's first characters. Each scrub leaves a `scrubbed` event on the item (counts and ids, hidden in the
   console's history) and a `tracker.scrubbed` row in the account audit (the item or sprint number, ids and field
   names; never text).
6. **Clean the copies outside D1** that you can reach (next list), and close the incident issue with the timeline.

**What the scrub does not reach** (why step 1 comes first):

- **D1 Time Travel.** Cloudflare keeps every earlier state of the database for point-in-time restore: **7 days on
  the Workers Free plan, 30 days on Workers Paid**. It is always on; there is no setting to switch it off, shorten
  it or delete one moment from it. So the pre-scrub rows exist at Cloudflare for that window after the scrub and then
  expire by themselves. Nothing reads them in place: the only way to them is `wrangler d1 time-travel restore`,
  which overwrites the live database and needs D1 edit rights on the Cloudflare account. A restore prints the
  bookmark of the state it replaced, and restoring to that bookmark undoes the restore. Two consequences:
  - whoever has those rights can bring the text back during the window, so the secret must already be dead;
  - **a restore to a point before the scrub undoes it**, together with its `scrubbed` event and audit row. After any
    Time Travel restore (a rollback of bad data, a rehearsal), re-run every scrub recorded on incident issues newer
    than the restore point. Do not restore past a scrub for convenience.
- **The source on GitHub.** Imported text still stands in the GitHub issue or comment it came from, with GitHub's
  own edit history. Edit or delete it there (and delete the revision from the comment's edit history).
- **What already left the console:** a push notification that quoted the text, a job that read the item while the
  text was there (its transcript and work tree on the runner host, the model provider's request logs), the plugin's
  local files on the owner's machine, any browser tab or screenshot. The owner's decisions (`owner_decisions.text`)
  stay append-only and are not scrubbable; a secret typed there is rotated and left.
- **Exports.** A `wrangler d1 export` or a local copy taken before the scrub keeps the text; delete such files.
- **Logs.** Worker logs and audit rows are redacted by the same pattern list as they are written, so a known token
  shape never reached them; a prefix-less password in a logged field is not recognised, and stored logs cannot be
  edited.

## Owner reconnect: check the fresh token on real GitHub (#831, #901)

A reconnect over an existing connection stores the new token pair, then retires the previous one: it revokes the old
access token and redeems the old refresh token once, so the old chain ends (`OwnerConnection.retirePrevious`). The
specs and the e2e run against the fake GitHub, which assumes what GitHub documents: a redemption ends only its own
pair, and the freshly stored pair stays live. **Real GitHub has not been exercised.** The owner runs this check once
on dev, after the first deploy that carries #887, and again on stage before the first release. Nothing in CI can do
it: it needs the owner's GitHub session.

The console has no button for it, because Settings offers Connect only while nothing is connected. Start it by hand:

1. Open `https://team-console-dev.geeera.workers.dev/settings`, with GitHub shown as connected.
2. In the browser's developer console on that page (same origin, so the CSRF check passes):

   ```js
   const start = await (await fetch('/api/v1/github/connect', { method: 'POST' })).json();
   console.log(start.authorizeUrl);
   ```

   Open the printed address only if it starts with `https://github.com/login/oauth/authorize?`, in the same tab.
   GitHub may ask you to authorize or pass you straight through. The console comes back to Settings with GitHub
   still connected; a refusal shows a notice instead and changes nothing.
3. Workers Logs of `team-console-dev`, for that callback, show these lines in order: `owner reconnect: the previous
   access token was revoked`, `owner reconnect: the previous redeemed access token was revoked`, `owner reconnect:
   the previous refresh chain was ended`, `owner connected`. A `... was not revoked` or `... was not ended` warning
   names its `reason`; an error `owner reconnect: retiring the previous pair failed unexpectedly` is a bug to file.
   Either way the new connection is stored.
4. Within a few minutes, do one thing that writes to GitHub as the owner (answer a question from the console, or
   send a request to the PM) and confirm on GitHub that it arrived under your account.
5. Read the row:

   ```sh
   npx wrangler d1 execute team-console-dev --env dev --remote --config apps/api/wrangler.jsonc --command \
     "SELECT version, connected_at, updated_at FROM owner_connections WHERE environment = 'dev'"
   ```

What the result means:

| Step 4 | Row | Meaning | Do |
| ------ | --- | ------- | -- |
| Worked | `updated_at` equals `connected_at` | The fresh access token was used as stored. GitHub behaves as the fake does. | Record the date in the header comment of `libs/worker/github/src/testing/fake-github-oauth.ts` by a PR. |
| Worked | `updated_at` is later than `connected_at` | GitHub rejected the fresh access token and the console refreshed it (a token lives 8 hours and is refreshed only in its last 30 minutes, so a refresh this early means a 401). The redemption ended more than its own pair. One extra round trip, no outage. | File a `kind:finding` issue: make the fake end every access token of the grant on a redemption, and record the finding in its header comment. |
| Failed with "connection lost" (403 `github-owner-not-connected`) | The row is gone | The redemption ended the new chain too. | Connect again from Settings: with no stored row nothing is retired, so this connection holds. File a `sev:high` bug to stop redeeming the previous refresh token on reconnect. |

Until the first row of the table is recorded in the fake's header comment, treat the reconnect path as unverified
against real GitHub.

## Every repository read fails: the App's new permissions are not accepted (#792)

When a release adds a permission to the console's read token (`INSTALLATION_PERMISSIONS` in
`libs/worker/github/src/lib/app-auth.ts`; #197 added **Checks: read**), every installation of that environment's App
must hold it before the deploy. GitHub refuses to mint a token that asks for a permission the installation has not
accepted (422 on `POST /app/installations/{id}/access_tokens`), so **every repository read of that installation
fails**, not only the new one. An App created before #197 is in this state until its owner adds and accepts
**Checks: read**.

**Before the deploy** (owner checklist, step 10):

1. github.com → Settings → Developer settings → GitHub Apps → `team-console-<env>` → Permissions & events →
   Repository permissions → set the new permission (for #197: **Checks: Read-only**) → Save.
2. Accept it on every installation: the account owner opens the installation's settings page (Settings →
   Integrations → GitHub Apps → the app → Configure) and clicks **Review request → Accept new permissions**. Until an
   installation accepts, it keeps its old permissions.

**If it was missed** (the board says «Новые разрешения приложения консоли не приняты» / "The console app's new
permissions aren't accepted", the overview and Needs you give the same reason, and the api logs show 409
`github-permission-not-accepted` with `githubStatus` 422 or 403):

1. Do steps 1–2 above. On the board, **Open installation settings** goes straight to that installation's settings
   page when the Worker could read it.
2. Retry on the board. Nothing has to be redeployed: the next read mints with the accepted permissions.
3. Do **not** roll back just to get reads working again unless the owner cannot accept soon: the previous release
   does not ask for the permission, but it also lacks what the permission is for.

The console reads the installation's grants (app JWT, no token) only after a refused mint, and reports
`github-permission-not-accepted` only when a permission the read token asks for is missing there; any other 422 stays
502 `github-unexpected`. A 403 "Resource not accessible by integration" on a read or an owner write is reported the
same way, without the settings link (the client does not know the installation there).

## What this does not cover

- **Production** is out of scope for #25 (`stage` → `main` only after the owner's recorded **go** on the
  demo page).
- Enabling Playwright e2e against `stage` is tracked separately (#14) and must fold in the fix from #142
  (Access service-token headers scoped to the target origin only, traces/artifacts off) before any stage
  e2e run — not part of this runbook.
- The stage GitHub App and "Connect GitHub" on stage are an owner chore after the first stage deploy (#152),
  not required for `deploy.yml` itself to work.
