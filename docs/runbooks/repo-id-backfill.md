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
