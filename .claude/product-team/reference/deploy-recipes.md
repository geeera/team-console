# Deploy recipes (free tiers, GitHub Actions only)

Source: SPEC decisions 7, 8. Cloud agent sessions cannot SSH or run provider CLIs with the owner's
credentials, so **every deploy is a GitHub Actions job**; credentials live in GitHub Environments
(`dev`, `stage`, `production`) and agents only reference `secrets.NAME`.

Free-tier limits change. When a recipe is chosen, `devops` checks the provider's current limits (sleep on
idle, build minutes, bandwidth, storage, rows) and records them in the stack decision so the team notices
before hitting them. Start from `.claude/product-team/templates/workflows/deploy.yml`.

## Shape every recipe shares

| Branch | GitHub Environment | Trigger |
| ------ | ------------------ | ------- |
| `dev` | `dev` | push (after a merged PR) |
| `stage` | `stage` | push (stage cut, `fix/*`) |
| `main` | `production` | push (release, hotfix) — plus `workflow_dispatch` with a `ref` for rollback |

- Build once per push, deploy the artifact that was built; tag production releases.
- Each environment has its own URL written to `.product-team/project.yml` → `environments.*.url`.
- A post-deploy smoke check hits the URL; a failed check fails the job (the release is not "done").
- Migrations run in the deploy job, before traffic moves, and must be backward compatible for one release
  (expand → migrate → contract), so a rollback never needs a down-migration.
- Secrets per environment; the owner creates the accounts and tokens (owner checklist), agents never do.

## Recipes

### Static frontend (SPA, docs, Storybook)
**Cloudflare Pages** via `cloudflare/wrangler-action` (`pages deploy <dir> --project-name … --branch <env>`).
Secrets: `CLOUDFLARE_API_TOKEN` (Pages edit only), `CLOUDFLARE_ACCOUNT_ID`. Branch deploys give each
environment its own URL. Alternatives: Netlify (`netlify deploy --prod` with `NETLIFY_AUTH_TOKEN`), GitHub
Pages (public repos, or any repo on paid plans).

### Container web service / API
**Render** with a deploy hook per environment: build and push the image to GHCR (`docker/build-push-action`,
`GITHUB_TOKEN`), then `curl -fsS -X POST "$RENDER_DEPLOY_HOOK"` with the image tag. Secret per environment:
`RENDER_DEPLOY_HOOK`. Free instances sleep when idle — acceptable for dev/stage, state it for production.
Alternatives: **Fly.io** (`superfly/flyctl-actions`, `FLY_API_TOKEN`, one app per environment), **Koyeb**.
Cloudflare Workers for APIs that fit the Workers runtime (`wrangler deploy --env <env>`).

### Database
**Neon** Postgres: one project, a branch per environment (`dev`, `stage`) off `main`; connection strings as
`DATABASE_URL` per GitHub Environment. `neondatabase/create-branch-action` can create short-lived branches
for PR previews. Alternative: **Supabase** (one project per environment on the free plan — check the project
limit).

### Object storage
**Cloudflare R2** (S3-compatible, no egress fees): a bucket per environment, keys `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`.

### Background workers, queues, heavy media
Free tiers rarely fit long-running CPU work (ffmpeg, image pipelines, ML). Options, cheapest first:
1. run the worker inside the web service process on a timer, if the load is tiny;
2. GitHub Actions `workflow_dispatch`/`repository_dispatch` jobs for occasional batch work (counts against
   Actions minutes);
3. a small always-free VM (e.g. Oracle Cloud Always Free) deployed by Actions over a deploy key — the one
   case where SSH from Actions is acceptable, with the key in the environment's secrets;
4. a paid plan — a `kind:question` for the owner with the monthly cost.

## When nothing free fits
Say so early: open a `kind:question` with `needs:owner`, the cheapest paid option and its monthly cost, and what
the product loses without it. Never quietly degrade production.
