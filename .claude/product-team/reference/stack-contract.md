# Stack-agnostic contract

Source: SPEC decisions 6, 7, 11. The plugin ships no stack templates. Instead every product — new or adopted —
satisfies this contract, and every skill talks to the product only through it.

## `.product-team/project.yml`

The single machine-readable description of the product. Template: `.claude/product-team/templates/project.yml`.

| Key | Meaning |
| --- | ------- |
| `name`, `repo` | Product name, `owner/repo` on GitHub |
| `mode` | `new` (after `kickoff`) or `adopted` (after `adopt`) |
| `stack` | Free text + link to the decision record that chose it |
| `commands.install/lint/test/build/e2e/storybook` | Shell commands run from the repo root. Must exit non-zero on failure. `e2e` accepts `BASE_URL` |
| `environments.dev/stage/production.url` | Public URLs of each deployed branch |
| `decisions_dir` | Where decision records live (the project's own folder when adopted) |
| `design.tokens`, `design.storybook_url` | Token source file(s), deployed Storybook |
| `sprint.length_days`, `sprint.freeze_days` | 14 and 2 unless the owner decided otherwise |
| `caps` | Optional overrides of the default caps |
| `team.console_app_slugs` | Optional: the team console's GitHub App slugs; owner requests to the PM count only when one of them posted the request (`reference/workflow.md` → Owner requests) |

Skills fail loudly when a key they need is missing — they never guess a command.

## Required in the repository

1. **Branches** `main`, `stage`, `dev` exist; default branch for PRs is `dev`.
2. **CI** (GitHub Actions) on every PR to `dev`/`stage`: `lint`, `test`, `build`, security (secret scan, SAST,
   dependency audit); `e2e` with a11y assertions when UI or API paths changed. Superseded runs cancelled.
3. **Deploy** from Actions per branch to managed free tiers. Credentials only in GitHub Secrets.
4. **Container**: a `Dockerfile` that builds and runs the app, even if the current host does not use it.
5. **E2E suite** runnable against any environment via `BASE_URL` — QA uses it on `stage`.
6. **Docs**: `CLAUDE.md` (how to work in this repo), decision records, `.product-team/owner-checklist.md`.
7. **Design** (products with a UI): tokens as the single source of style, UI kit on a headless library,
   Storybook deployed with `dev`.

## Environments on free tiers (examples, not defaults)

Frontend: Vercel / Cloudflare Pages / Netlify. Backend: Render / Fly.io / Cloudflare Workers.
Database: Neon / Supabase. The choice is recorded per product; free-tier limits are listed in the decision so
the team notices before hitting them.
