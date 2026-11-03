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

## What this does not cover

- **Production** is out of scope for #25 (`stage` → `main` only after the owner's recorded **go** on the
  demo page).
- Enabling Playwright e2e against `stage` is tracked separately (#14) and must fold in the fix from #142
  (Access service-token headers scoped to the target origin only, traces/artifacts off) before any stage
  e2e run — not part of this runbook.
- The stage GitHub App and "Connect GitHub" on stage are an owner chore after the first stage deploy (#152),
  not required for `deploy.yml` itself to work.
