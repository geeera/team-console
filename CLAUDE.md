# Team Console — guidance for coding agents

A control panel for the product team (the product-team plugin): questions, PM chat, sprint board, designs — as a
PWA on iPhone and Mac. Read first: `docs/product-brief.md`, `docs/decisions/` (0001 stack and architecture, 0002
visual direction), `.product-team/project.yml`.

## Rules
- The team works through `.claude/product-team/` (vendored plugin) — backlog in GitHub Issues, every change a PR to
  `dev`, the review gate before merge. Nobody pushes to `dev`, `stage` or `main`.
- Frontend follows Feature-Sliced Design as Nx libraries with `enforce-module-boundaries`; strict TypeScript; shared
  code only with 2+ consumers.
- Every user-facing string goes through i18n (ru is the reference copy, en second). No hard-coded UI text.
- The GitHub token lives only in the Worker; the client never sees it. Secrets only in GitHub Environments /
  `wrangler secret`; this repository is public.
- Owner answers written by the app use the plugin's grammar exactly (`libs/shared/owner-grammar`).
- Design tokens only (Paper Desk, ADR 0002); no raw colours, spacing, durations or z-index in components —
  `tools/design-lint` (part of `nx run-many -t lint`) fails on one in any `libs/console/**` or `apps/console` css.

## Workspace
Node 22 (`.nvmrc`), npm, `npm ci` only — versions are pinned exactly, no `^`. Nx 23 / Angular 22 (Nx 22 does not
support Angular 22). Commands: `npx nx run-many -t lint`, `-t test`, `-t build`; a single project with
`npx nx test console-pages-hello`. Unit tests are Vitest through `@analogjs/vitest-angular`; the app is zoneless.

npm is pinned to `package.json#packageManager` (10.9.9; `engines.npm` allows 10.x only) — the lockfile must be
written by npm 10, npm 11 rewrites it.

CI on every PR into dev/stage/main (ADR 0001 decision 18): `ci.yml` job `lint-test-build` runs `nx affected -t
lint|test|build` with `NX_BASE`/`NX_HEAD` from `nrwl/nx-set-shas` (merge-base of the PR's base branch and the PR
merge commit), and `nx run-many` instead when the PR touches `.github/workflows/`, `package.json`, the lockfile,
`.nvmrc`, `nx.json`, `tsconfig.base.json`, `eslint.config.mjs` or `vitest.config.mts`, and on every PR into
stage/main; the job's "Nx scope" notice says which. `security.yml`: `secret-scan` (gitleaks over `git log --all`
of the clone — every branch and tag of the repo plus this PR's merge ref, not other PRs), `sast` (Semgrep),
`dependency-audit` (`npm audit --audit-level=high`). Every action in `.github/workflows/` is pinned by full commit
SHA; the PR workflows use no secrets. A leaked secret: rotate/revoke it first (the public history keeps it), then
delete the branch and push a clean one (no force-push onto shared branches), or — if it already reached a
long-lived branch — add its fingerprint (from the red run's log) to `.gitleaksignore` in a reviewed PR.
Dependabot (`.github/dependabot.yml`) proposes github-actions updates weekly, grouped into one PR into `dev`;
those PRs go through the same gate as any other (CI + QA/REVIEW/SECURITY).

Layout, tags and aliases (architect note on #3 — binding; the boundary lint enforces the tags):

```
apps/console                 type:app  scope:console  layer:app        (Angular PWA)
apps/console-e2e             type:e2e  scope:console                   (#14)
apps/api, apps/hooks         type:app  scope:worker                    (#6)
libs/console/<layer>/<slice> type:lib  scope:console  layer:<layer>    @console/<layer>/<slice>
libs/worker/<name>           type:lib  scope:worker                    @worker/<name>
libs/shared/<name>           type:lib  scope:shared                    @shared/<name>
tools/<name>                 type:tool scope:tooling                   (workspace checks, no runtime code)
```

Layers import downward only (`app → pages → widgets → features → entities → shared`), never their own layer
(`shared → shared` is the one exception), so features never import features. Scopes: `console → console|shared`,
`worker → worker|shared`, `shared → shared`. A project whose tags match no constraint cannot import any project.
Every lib exports through `src/index.ts`; there is no wildcard alias, so deep imports do not resolve.

Generate a lib with its tags and alias in one go, e.g.

```
npx nx g @nx/angular:library libs/console/features/answer --name=console-features-answer \
  --importPath=@console/features/answer --tags=type:lib,scope:console,layer:features \
  --prefix=tc --style=css --unitTestRunner=vitest-analog --standalone --skipModule --skipPackageJson
```

then delete the generated placeholder component, keep `src/index.ts` as the only public API, and set
`angular({ tsconfig: 'tsconfig.spec.json' })` in the lib's `vite.config.mts` (see an existing lib). Generators emit
an explicit `lint` target in `project.json`; remove it — `@nx/eslint/plugin` infers it.

Shared libs that exist: `@console/shared/ui` (Paper Desk kit — tokens in `src/tokens/tokens.css` + `breakpoints.ts`,
global `src/styles/base.css` and `overlay.css`; primitives `Button`/`IconButton`, `Card` (with the stamp), `Chip`,
`Field`/`FieldControl`, `Icon`, `List`/`ListRow`, `Sheet` service (bottom sheet on the phone, dialog elsewhere, on the
CDK dialog; `confirm()`), `Spinner`, `StateBlock`, `TopBar`; Storybook in `.storybook/` with theme, motion and language
toolbars: `npx nx storybook console-shared-ui` on :4400, `npx nx build-storybook console-shared-ui` into
`dist/storybook/console-shared-ui` — the `storybook` contract command), `@console/shared/i18n` (Transloco,
`ru.json`/`en.json`, `provideConsoleI18n()`), `@console/shared/config` (`APP_CONFIG`), `@console/shared/api`
(`provideConsoleApi()` with the interceptor chain; `accessSessionInterceptor` reloads once per 30 s to re-run the
Access login when an `/api` call fails with status 0, a non-JSON body or 401 `access-missing|access-unverified`). Build time reaches the app through the build `define`
`__TC_BUILT_AT__` (defaults to `local`); the version comes from `package.json`.

## Workers (#6)

`apps/api` (Hono; serves the SPA from `dist/apps/console/browser` as static assets with `run_worker_first:
["/api", "/api/*"]`, owns `/api/v1/*`) and `apps/hooks` (public, `/healthz` and later `/hooks/*`). Both are built by
`createWorkerApp()` from `@worker/core`: `X-Request-Id` in/out, a per-request redacting logger (`c.get('logger')`),
RFC 9457 bodies via `problem(c, { type, title, status, detail?, retryAfter? })` for every error, including 404/500.
DTOs and `ProblemDetails` live in `@shared/contracts`; D1 access in `@worker/db` (`ProjectsRepo`, parameterised
queries only). GitHub (#9, ADR 0003 decision 6) only through `@worker/github`: `GitHubAppAuth` (app JWT via Web
Crypto, PKCS#8 key only, per-repo installation tokens downscoped to read-only, cached per isolate) →
`GitHubClient(fetch, tokenSource)` with paths built by `` githubPath`/repos/${parseRepoName(row.repo)}` `` (never a raw
string, never a client-chosen repo); throw `GitHubError` and `createApiApp`'s `mapError` answers its problem; reads go
through `ReadCache` keyed `readCacheKey({ environment, slug, epoch, type })`. The api Worker's per-isolate GitHub state
is `ApiGitHub` (`apps/api/src/github.ts`); `GITHUB_MOCK=true` (local only) swaps api.github.com for the fixture GitHub
in `libs/worker/github/fixtures`. Migrations live only in `apps/api/migrations` (`0001_init` = `projects`; `0006_project_installation` #15 adds
`projects.installation_id`; `0002_push_subscriptions` #11, `0003_webhooks` #12, `0004_chat_wakeups`,
`0005_owner_connections` #59 are reserved). The registry (#15) is `routes/project-registry.ts` + `src/projects/`:
adding validates repo format → app installed → repo owner (behind `OwnerConnectionSource`; until #59 the
`OWNER_GITHUB_LOGIN` var, which `nx serve api` and the Dockerfile set to the mock fixtures' owner `geeera`) →
`project.yml` before the one D1 write; refusals are problems with a `step` extension member (`problem(c, { …,
extensions })`); `ROUTINE_TOKEN_<SLUG>` is checked for presence only. `wrangler.jsonc` has `env.dev|stage|production`
with non-secret vars only; secrets (`WEBHOOK_SECRET`, `VAPID_PRIVATE_KEY`, `ROUTINE_TOKEN_*`, `OWNER_EMAIL`, and per
ADR 0003 `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` — `GITHUB_TOKEN` is gone with
the PAT) are declared in each app's `src/env.ts` and set with `wrangler secret put`. `AUTH_MODE:local` + `ENVIRONMENT:local`
are passed only as `--var` flags by `nx serve api` and the Dockerfile — `tools/workspace-checks` fails if either
appears in an `env.*` block. Auth (#8, ADR 0001 decision 7) is one seam in `apps/api/src/auth/`, mounted once on `/api/*`
before every router: `authMiddleware` verifies `Cf-Access-Jwt-Assertion` with `jose` against
`https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (RS256 only; `iss`, `aud`, `exp`/`iat` required, `nbf`; owner
email or, on dev/stage with `ALLOW_SERVICE_TOKEN=true`, the service token pinned by `ACCESS_SERVICE_TOKEN_ID`) and
sets `c.get('identity')`; every failure is a 401 problem (`access-missing|unverified|forbidden|misconfigured`), and
empty or malformed Access vars fail closed. `csrfMiddleware` then requires `Sec-Fetch-Site: same-origin` (or an own
`Origin`) and JSON bodies on writes (403 `csrf`, 415). Only `ENVIRONMENT=local` + `AUTH_MODE=local` together skip
the JWT check (the api vitest config binds both so route specs run; `auth.middleware.spec.ts` uses
`src/testing/access-kit.ts` to sign tokens and stub the JWKS). Log `identity.kind` only, never the email or token.

Commands: `npx nx serve api` (builds the console, applies migrations, `wrangler dev` on :8787), `npx nx run
api:migrate` (fresh local D1), `npx nx build api` (`tsc --noEmit` + `wrangler deploy --dry-run`), `docker build -t
team-console . && docker run --rm -p 127.0.0.1:8787:8787 team-console` (the e2e target: same bundle, local D1, `:8787`).
Worker tests run in workerd through `@cloudflare/vitest-pool-workers` (`SELF.fetch`, an isolated in-memory D1
migrated in `src/test-setup.ts`); `apps/api/test-assets` stands in for the Angular build. `wrangler`,
`@cloudflare/vitest-pool-workers` and `compatibility_date` move together (one workerd for dev, Docker and tests).
