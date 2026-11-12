# Repository id backfill (`projects.repo_id`)

Source: #484 (ADR 0008 decision 2, the T-2 follow-up of #482). Webhooks reach a project **by GitHub's repository
id only**: the hooks Worker and `ProjectsRepo.markAccessLost`/`clearAccessLost` no longer match a row by its
`owner/name`. A project registered before migration `0018_accounts.sql` has `repo_id IS NULL` until something
records it, and until then **every delivery for it is dropped fail-closed** (answered `ignored: unregistered`,
nothing written). New projects always get an id: `POST /api/v1/projects` refuses one without it.

The id is recorded by the api Worker's existing setup read, which asks GitHub (`GET /repos/{repo}`, app token,
the project's own registered repository) and writes the id once (the 0018 trigger refuses a later change). This
runbook is that read, done on purpose for every row that still lacks an id.

**Who runs it: the owner.** Agents never run `wrangler` or any D1 command against a remote database (dev, stage
or production). The only `wrangler` call here is a read-only `SELECT`.

## Database names

From `apps/api/wrangler.jsonc` (`d1_databases[].database_name` per environment; `apps/hooks/wrangler.jsonc`
points at the same databases):

| Environment | `--env` | D1 database | Console |
| --- | --- | --- | --- |
| dev | `dev` | `team-console-dev` | `https://team-console-dev.geeera.workers.dev` |
| stage | `stage` | `team-console-stage` | `https://team-console-stage.geeera.workers.dev` |
| production | `production` | `team-console-production` | the production URL, once it exists |

## Steps (per environment)

Run from the repository root on your machine, signed in to Cloudflare (`npx wrangler login`).

### a. Read-only check — which live projects have no id

```
npx wrangler d1 execute team-console-dev --env dev --config apps/api/wrangler.jsonc --remote \
  --command "SELECT slug, repo, access_lost_at FROM projects WHERE archived_at IS NULL AND repo_id IS NULL"
```

For stage and production replace both `team-console-dev` → `team-console-stage` / `team-console-production` and
`--env dev` → `--env stage` / `--env production`. **No rows: done for this environment.** Otherwise go on with
step b for each listed `slug` (rows with `access_lost_at` set: step c first).

### b. Backfill — a fresh setup read per project

For each `slug` from step a, signed in to that environment's console:

1. Open `<console>/settings/projects/<slug>` (for example
   `https://team-console-dev.geeera.workers.dev/settings/projects/storify`).
2. Press **«Проверить снова»** (Check again). That is the setup read with `?fresh=1`, past the 60-second cache:
   `GET /api/v1/projects/<slug>/setup?fresh=1`. Opening that API URL directly in the same signed-in browser does
   the same.
3. The read records the id when GitHub answers the repository. The api Worker logs
   `project repo id backfilled` with `recorded: true` for the slug.
   When the repository GitHub answers is not owned by the connected owner or has another `owner/name`, nothing is
   recorded: the row stays `repo_id IS NULL` and the Worker logs `repo id backfill refused` (no slug). If that is
   because **you** renamed the repository, see [The repository was renamed](#the-repository-was-renamed) below.

Re-run step a until it returns no rows.

### c. Rows with `access_lost_at` set

The app cannot read that repository, so step b records nothing for it. First either:

- **Restore the app's access**: GitHub → the repository owner's Settings → GitHub Apps → the environment's app
  (`team-console-dev` on dev) → Repository access → add the repository. Then do step b for the slug. GitHub's
  `installation_repositories.added` delivery for it arrived while the row had no id, so it was dropped and
  Settings still says access was lost: remove the repository from the app's access and add it again once the id
  is recorded, and the second `added` delivery clears it. (Redelivering the old delivery from the app's
  *Advanced* page does not help — it is answered `duplicate`.)
- **Or archive the project** (Settings → the project → Archive) if it is not needed any more. Archived rows are
  not listed by step a and receive no deliveries anyway.

Then re-run step a.

## The repository was renamed

A row with `repo_id IS NULL` that was registered under a name you then renamed on GitHub never passes step b:
`isBackfillAllowed` (`apps/api/src/projects/repo-id-backfill.ts`) requires GitHub's current `full_name` for the
registered `owner/name` to equal the registered one; a rename makes GitHub answer the new name and the check
refuses on every try (#515). The registered `repo` cannot be edited — `PATCH /projects/:slug` takes only
`displayName`/`routineId`, and `projects.repo`/`projects.slug` are UNIQUE (migration `0001_init.sql`), archived
rows included (`ProjectsRepo.findConflict`, covered by the `projects.repo.spec.ts` test "refuses a second row with
the slug or the repository (any case), archived rows included").

### What you see

- Settings keeps listing the slug under step a's query after pressing **Check again** — `repo_id` stays `NULL`.
- The api Worker logs `repo id backfill refused` (no slug, by design — #504).
- The board misses that project's events: the hooks Worker logs `webhook refused` with `reason: repo-id-missing`
  (no slug) for every delivery of it, because routing is by `repo_id` only (ADR 0008 decision 2) and this row has
  none yet.

### Is it your rename, or did the repository leave your account?

Before recovering anything, open the repository on GitHub and check who owns it now:

- **Still under your account** (the same login/org you see in Settings' GitHub connection) → it is your rename,
  recover it with either option below.
- **Owned by a different account** → it was transferred away, not renamed by you. **Do not try to recover it**:
  `isBackfillAllowed` and `isRepoOwnedBy` (`libs/worker/github/src/lib/owner-check.ts`) refuse by the owner's
  numeric id, not just the login, exactly so a transfer never gets backfilled under your connection. Archive the
  project (Settings → the project → Archive) instead — the owner of that repository, if it is still used for this
  team, re-adds it as a new project.

### Recovery A — rename back, backfill, rename forward again

Verified by code and by the automated suite below, not by an actual GitHub rename (agents do not rename the
owner's repositories or touch a remote environment; this is the owner's own check once, the first time it comes
up):

1. On GitHub, rename the repository back to the name registered in `repo` for this slug (Settings → General →
   Repository name).
2. Do step b above for the slug: open `<console>/settings/projects/<slug>` and press **Check again**. GitHub now
   answers the registered name again, so `isBackfillAllowed` passes and the id is recorded — the same path the
   test "the owner's repository under its name (any case) still records the id"
   (`apps/api/src/routes/project-registry.spec.ts`) exercises; the refusal just before the rename-back matches "the
   same owner under another name records nothing" in the same file.
3. Rename the repository forward to its real new name again.
4. Verify with step a: the slug is no longer listed, and the api Worker log for step 2 has
   `project repo id backfilled` with `recorded: true`.

**Side effect — the registered `repo` stays the old name forever.** Nothing in this path, or afterwards, ever
updates the `repo` column (it is immutable by design, see above); only `repo_id` was recorded. Once the id is set,
routing, pull-request sync and `markAccessLost`/`clearAccessLost` all match by `repo_id` only and keep working
through any later rename (`REPOSITORY_MATCH` in `libs/worker/db/src/lib/projects.repo.ts`; verified by the
`projects.repo.spec.ts` suite, which this PR re-ran). The one thing that does **not** keep working: Settings'
"last event" / "events seen" signal (`ProjectSignalsRepo.eventsFor(project.repo)`,
`libs/worker/db/src/lib/project-signals.repo.ts`) matches `webhook_deliveries.repo` by exact name, and the hooks
Worker records each delivery under GitHub's *current* `full_name` at the time it arrived
(`apps/hooks/src/routes/github.ts`). Because the registered `repo` never catches up to the real current name, that
signal freezes at whatever it last saw before this recovery and never updates again, even though the events
themselves are still correctly routed, processed and shown on the board. Treat it as a known stale value, not a
sign that events stopped arriving — check the project's tracker items/PRs for the real signal instead.

### Recovery B — archive and add again under the new name

Verified the same way: the UNIQUE/archive behaviour below is exercised by the existing local test suite (D1 on
`vitest-pool-workers`, no live GitHub repository needed for this one — it is a database-constraint question, not
a GitHub one):

1. Settings → the project → Archive (`POST /projects/:slug/archive`). This only sets `archived_at`; the row (and
   its `slug`/`repo`) stays in the table forever (0001's `UNIQUE`s have no archived-rows exception).
2. Add it again (`POST /api/v1/projects`) with the repository's current name. Because `repo` differs from the
   archived row's (the old name), the UNIQUE check passes; because `slug` is a separate `TEXT PRIMARY KEY`, you
   must pick a **different slug** — the old one stays taken by the archived row forever (same test as above). The
   add always carries a `repoId` from the read done at add time (`apps/api/src/routes/project-registry.ts`), so the
   new row starts with `repo_id` already set — no backfill ever needed for it.

**What you lose, moving to the new slug:** the routine link (`routineId`), snooze state, and any
bookmarked `/settings/projects/<old-slug>` link or automation keyed on the old slug; audit history before the
move stays attached to the archived slug, separate from the new one's. **What you do not lose:** any webhook
deliveries that already arrived tagged with the new name (e.g. during the time the repository sat renamed before
you noticed) match the new slug's `eventsFor` immediately, since `webhook_deliveries.repo` already carries the
new name.

### How to verify either recovery

- Step a (the read-only `SELECT`) no longer lists the slug (recovery A) or lists only the new slug, not the old
  one (recovery B).
- The api Worker log shows `project repo id backfilled` with `recorded: true` for the slug (recovery A) or
  `project added` for the new slug (recovery B).
- A new change on an issue or pull request in the renamed repository appears on the board for that project.

### Which to use, and whether a code path is still needed

Recovery B leaves a fully working project with no caveat (new id from creation, no stale name) at the cost of a
new slug and the metadata listed above. Recovery A keeps the original slug and every setting, and is fully
correct for routing, sync and access tracking; its only drawback is the frozen "last event" Settings signal. Since
at least one recovery (B) leaves a fully working project, **no code path is needed for this issue** — a
re-link feature (editing `repo` in place, refreshed through a fresh owner-confirmed GitHub read) would remove
recovery A's one caveat, but that is a product decision for a separate issue, not a trigger from this runbook.

## When to run it

| Environment | When | Why |
| --- | --- | --- |
| dev | **Before the #484 PR merges.** The PR says "DO NOT MERGE" until step a returns no rows on dev. | dev already has `repo_id` (0018) and lazy backfill; once the name match is gone, any row still without an id stops receiving webhooks. |
| stage, production | **As a step of the Stage A cutover**, right after that release's deploy has run its D1 migrations (the `D1 migrations (remote, before traffic moves)` step of `deploy.yml`, see [deploy-and-rollback.md](deploy-and-rollback.md#repository-id-backfill-after-migration-0018)). | Neither has 0018 yet: the column arrives in the same cut that removes the name match, so **every** existing project starts with `repo_id IS NULL`. |

On stage and production the window between the deploy and the end of step b is **expected and short**: webhook
deliveries for not-yet-backfilled projects are dropped fail-closed (nothing is written to the wrong project, the
board just misses those events and refreshes on the next read). While any live project still lacks an id the hooks
Worker logs `webhook refused` with `reason: repo-id-missing` (no slug) on each unmatched delivery — those lines stop
once step a is empty. Do steps a–c straight after the deploy goes green; a missed event is fixed by the next change
on that issue or PR, or by **Check again** on the project's page.

## What this does not cover

- Rows that are archived: they are never routed, so they need no id.
- Production before it exists: run the same steps the first time production has projects from before 0018. A
  production database created at or after 0018 has only projects created through `POST /api/v1/projects`, which
  always carry an id, and step a returns nothing.
