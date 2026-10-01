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
`npx nx test console-pages-settings`. Unit tests are Vitest through `@analogjs/vitest-angular`; the app is zoneless.

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
CDK dialog; `confirm()`), `Spinner`, `StateBlock`, `Tooltip` (non-interactive, `aria-hidden`), `TopBar`; Storybook in `.storybook/` with theme, motion and language
toolbars: `npx nx storybook console-shared-ui` on :4400, `npx nx build-storybook console-shared-ui` into
`dist/storybook/console-shared-ui` — the `storybook` contract command), `@console/shared/i18n` (Transloco,
`ru.json`/`en.json`, `provideConsoleI18n()`), `@console/shared/config` (`APP_CONFIG`), `@console/shared/api`
(`provideConsoleApi()` with the interceptor chain; `accessSessionInterceptor` reloads once per 30 s to re-run the
Access login when an `/api` call fails with status 0, a non-JSON body or 401 `access-missing|access-unverified`). Build time reaches the app through the build `define`
`__TC_BUILT_AT__` (defaults to `local`); the version comes from `package.json`.

Spaces shell (#23): `@console/shared/persisted-state` (`PersistedStateStore` over `localStorage` key `tc.state.v1`,
guarded by `isPersistedStateV1`, debounced writes, immediate for the chat draft, flushed on `visibilitychange`/`pagehide`;
never sent to the Worker), `@console/entities/project` (`ProjectsStore` — `ready()` gates the `p/:slug` `canMatch`
guard; `NeedsYouCounts` polls `GET /api/v1/needs-you` per minute while visible; `spaceUrlOf`/`spaceLocationOf`),
`@console/features/project-switcher` (pinned first, the rest collapsible, badge), `@console/widgets/app-shell` (sidebar
≥ 900 px, top bar + `Sheet` below; owns the scrolling `<main>` and restores its position per project screen), pages
`project-space` (tabs + section placeholders; `?e2e-tall=1` renders 60 rows in dev builds), `project-not-found`,
`needs-you`, `overview`, `settings` (language switch). Routes and the two guards live in `apps/console/src/app/`.

Questions (#16): `@console/entities/question` (read-model guards, `QuestionsApi`, `QuestionCard` — issue text only by
interpolation, untrusted items marked), `@console/features/answer-question` (`AnswerQuestion`: exactly
`allowedCommands`; confirm for go, a reason sheet for reject/no-go/override, a warning before any answer on an untrusted
item; failures branch on the problem `type`; Retry repeats the same body so the endpoint replays),
`@console/widgets/question-list` (Needs you and `/p/:slug/questions`; stamp, then a receipt). `AnsweredItems` in
`@console/entities/project` (`localStorage` `tc.answered.v1`, 6 h) keeps answered items out of the badges while GitHub
still lists them. Kit: `Recommendation`, `Receipt`.

Sprint board (#18, read-only): `@console/entities/sprint` (`isSprintDto`, `SprintApi`, `statusColumnsOf` — lanes counted as
`backlog list` counts them, `SprintItemList`), `@console/widgets/sprint-board` (`/p/:slug/board`; loading, no sprint,
empty, error and 429 with an automatic retry at `Retry-After`). Kit: `Lanes`/`Lane` (a tab list of lanes on the phone, `[(selected)]` by `key`),
`Stats`/`Stat`, `ListRow` `external`.

Team commands (#114): `routes/team-commands.ts` (`GET /projects/:slug/team/status`, `POST …/team/pause|resume` on the
owner's token, byte-for-byte `runlog pause`/`resume`, 60 s replay from `own_writes`; `POST …/runs {slot}` fires the
slot's routine once, never retried, behind the run log (paused, 3-hour overlap) and the 15-minute `slot_requests` lock
of migration 0008). `@worker/run-log` ports `ptlib/runstate.py` (fixtures from `libs/worker/run-log/fixtures/generate.py`
— rerun after every `vendor` update); `@worker/routines` is the only client of the routines API (`ROUTINES_FAKE_ORIGIN`
+ `nx run api:fake-routines` locally, never the real one). Secrets `SLOT_TOKEN_<SLUG>_<SLOT>` / `SLOT_ROUTINE_<SLUG>_<SLOT>`
(`slotSecretNames`). Console: `@console/entities/team-run` (`TeamStatusStore`), `@console/features/team-commands`
(`TeamCommands`: one `Sheet.confirm` per command), `@console/widgets/commands-panel` (pane, phone sheet, paused banner);
kit `Banner`, `Button[off]`, `Receipt` tone `warning`, `Sheet.confirm` with `items`/`input`/`ConfirmFailure`, `--dur-pulse`.

Web push, server (#11; the client is #36): `@worker/push` — `checkPushSubscription` (endpoint allow-list: `https:`, push-service
hosts only, no IP literal or port; `p256dh` 65 bytes `0x04`, `auth` 16 bytes), `checkVapidConfig`, `questionNotification` /
`testNotification` (ngsw `notification` payloads; the tap URL is built only here, `/p/{slug}/questions#{n}` or `/needs-you`; text
cleaned and cut to 120), the `ru|en` copy in `copy.ts` («вы»), and `PushSender.sendToAll(store, message)` (sequential; 404/410
delete, 5 failures in a row delete, success resets; never follows redirects). Payload encryption and the VAPID JWT come from
`@block65/webcrypto-web-push` (WebCrypto only; RFC 8291 Appendix A pinned in `encryption.spec.ts`). Routes in `routes/push.ts`
(`GET /api/v1/push/config`, `GET|PUT|DELETE …/subscriptions`, `POST …/test` once per 30 s), owner-only; `PushSubscriptionsRepo` /
`PushTestSendsRepo` in `@worker/db`. Vars `VAPID_PUBLIC_KEY` (empty in the repo, from deploy.yml) and `VAPID_SUBJECT` (an https URL),
secret `VAPID_PRIVATE_KEY`; any of them unusable → 503 `push-misconfigured`. Locally `nx run api:fake-push` (127.0.0.1:9997,
`@worker/push/testing`'s `FakePushService`: hands out subscriptions, decrypts every delivery, verifies the JWT) + `--var
PUSH_FAKE_ORIGIN:http://127.0.0.1:9997` and a throwaway pair from `node tools/owner-setup/vapid-keygen.js` as `--var`s; never a
real push service.

## Workers (#6)

`apps/api` (Hono; serves the SPA from `dist/apps/console/browser` as static assets with `run_worker_first:
["/api", "/api/*"]`, owns `/api/v1/*`; CSP, anti-framing, `nosniff` and Referrer-Policy for every asset response come
from `apps/console/public/_headers` (#118) — a new origin, iframe or inline script needs a change there) and `apps/hooks` (public, `/healthz` and later `/hooks/*`). Both are built by
`createWorkerApp()` from `@worker/core`: `X-Request-Id` in/out, a per-request redacting logger (`c.get('logger')`),
RFC 9457 bodies via `problem(c, { type, title, status, detail?, retryAfter? })` for every error, including 404/500.
DTOs and `ProblemDetails` live in `@shared/contracts`; D1 access in `@worker/db` (`ProjectsRepo`, parameterised
queries only). GitHub (#9, ADR 0003 decision 6) only through `@worker/github`: `GitHubAppAuth` (app JWT via Web
Crypto, PKCS#8 key only, per-repo installation tokens downscoped to read-only, cached per isolate) →
`GitHubClient(fetch, tokenSource)` with paths built by `` githubPath`/repos/${parseRepoName(row.repo)}` `` (never a raw
string, never a client-chosen repo); throw `GitHubError` and `createApiApp`'s `mapError` answers its problem; reads go
through `ReadCache` keyed `readCacheKey({ environment, slug, epoch, type })`. The api Worker's per-isolate GitHub state
is `ApiGitHub` (`apps/api/src/github.ts`); `GITHUB_MOCK=true` (local only) swaps api.github.com for the fixture GitHub
in `libs/worker/github/fixtures`. Migrations live only in `apps/api/migrations` (`0001_init` = `projects`;
`0005_owner_connections` #59; `0006_project_installation` #15 adds `projects.installation_id`; `0007_own_writes` #10 =
`own_writes` + `own_write_claims`, which #12 reuses; `0008_slot_requests` #114; `0009_push_subscriptions` #11 (`push_subscriptions` +
`push_test_sends`); `0010_webhooks` #12 = `webhook_deliveries` + `projects.access_lost_at`. No number is reserved — a new
migration takes the highest number on `dev` + 1 when its PR opens and is renumbered on rebase if that number was taken,
so 0002–0004 stay unused). The answer route (#10) is `routes/answer.ts`
(`POST /api/v1/projects/:slug/issues/:number/answer`, owner-only): section re-derived from the live issue with
`@shared/owner-grammar` (a byte-for-byte port of the plugin's `backlog answer` and `commands.command_lines`, proven by
fixtures that `libs/shared/owner-grammar/fixtures/generate.py` writes from the vendored plugin — rerun it after every
`vendor` update, a spec fails until you do), owner check, then the comment on the owner's token through
`GitHubClient.postJson` (one refresh on 401, never retried after a timeout or 5xx), 60 s replay from `own_writes`. The owner connection (#59, ADR 0003 decisions 3–4) is
`apps/api/src/owner/`: `ApiGitHub.ownerConnection(env, logger)` is the `OwnerTokenSource` for owner writes (refresh
under the D1 lease; an unusable row → 403 `github-owner-not-connected` with `connectUrl`), routes in
`routes/github-connection.ts` (refused for the service identity), AES-GCM helpers (`importMasterKey`,
`sealText`/`openText`) in `@worker/core`; `assertRepoOwnedBy` (409 `github-owner-mismatch`) in `@worker/github`. Locally,
`npx nx serve fake-github` (`tools/fake-github`, the fake from `@worker/github/testing`) + `--var
GITHUB_FAKE_ORIGIN:http://127.0.0.1:9999` (honoured only with `ENVIRONMENT=local`) runs the flow without GitHub. The
registry (#15) is `routes/project-registry.ts` + `src/projects/`: adding validates repo format → app installed → repo
owner (the connected account's login and pinned id, through `OwnerConnectionSource` over the #59 connection) →
`project.yml` before the one D1 write; refusals are problems with a `step` extension member (`problem(c, { …,
extensions })`); `ROUTINE_TOKEN_<SLUG>` is checked for presence only. The read models (#35) are `@worker/read-models` (pure ports of the plugin's `inbox`/`brief.needs`/`metrics`, golden-tested against `fixtures/*.expected.json` written by `fixtures/golden.py` from the vendored plugin; `parseProjectConfig` = safe YAML through `yaml`, 64 KB cap, no tags or aliases) over #10's `@shared/owner-grammar` (`sectionOf`, `kindOf`, `ANSWERS`, plus `askOf`/`INBOX_ORDER`/`sectionRank` from `lib/inbox.ts`), served by `routes/project-read-models.ts` (`/projects/:slug/{inbox,questions,sprint}`) and `routes/needs-you.ts` through `read-models/project-reads.ts` (subrequest budget per endpoint documented there). `wrangler.jsonc` has `env.dev|stage|production`
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
`npx nx serve hooks` (:8788, depends on `api:migrate`) runs against the *same* local D1 as `nx serve api`: both
targets' `wrangler dev`/`migrate` commands pass `--persist-to .wrangler/state`, a workspace-root directory shared by
both apps instead of wrangler's per-app default (`apps/<app>/.wrangler`) — so a row the api Worker writes locally is
immediately visible to the hooks Worker (#50; needed by #12). Deploys are unaffected: `--persist-to` is a local
wrangler dev/CLI flag, never a `wrangler.jsonc` setting.

E2e (#14): `npx nx e2e console-e2e` (builds first; browsers once with `npx playwright install chromium webkit`).
Projects `iphone` (Chromium, 390 px), `desktop` (1440 px), `iphone-webkit` (the demo path only). Each Playwright
worker starts its own stack in `apps/console-e2e/src/stack/local-stack.ts` — the fake GitHub plus the Docker image's
command (`wrangler dev dist/apps/api/main.js`, fresh local D1, mock mode) wired to it — and specs call
`stack.reset()` / `seed()` for a fresh database; logs in `tmp/console-e2e/worker-N/`. Specs live in `src/*.e2e.ts`, find
controls through `ru()` (the ru.json copy) and `data-testid`, wait on conditions only, and fail on any request off the
app origin, any uncaught page error and any serious/critical axe violation (`expectAccessible`). `BASE_URL` (+
`CF_ACCESS_CLIENT_ID/SECRET` for stage) runs the suite against a running target; specs that reset data or need the
fake GitHub skip themselves there, `smoke.e2e.ts` is the read-only part.
Worker tests run in workerd through `@cloudflare/vitest-pool-workers` (`SELF.fetch`, an isolated in-memory D1
migrated in `src/test-setup.ts`); `apps/api/test-assets` stands in for the Angular build. `wrangler`,
`@cloudflare/vitest-pool-workers` and `compatibility_date` move together (one workerd for dev, Docker and tests).
