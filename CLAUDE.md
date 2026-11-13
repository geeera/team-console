# Team Console — guidance for coding agents

A control panel for the product team (the product-team plugin): questions, PM chat, sprint board, designs — as a
PWA on iPhone and Mac. Read first: `docs/product-brief.md`, `docs/decisions/` (0001 stack and architecture, 0002
visual direction, 0006 the console as the source of truth — the #309 target architecture), `.product-team/project.yml`. Deploy and rollback: `docs/runbooks/deploy-and-rollback.md`.

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
- Accounts are the tenant (ADR 0008, #466): every account-level table carries `account_id`; every route registered on
  the api Worker declares a scope rule in `apps/api/src/auth/route-scope.ts` and `route-scope.spec.ts` fails on one
  that does not; every project is reached through `projects/lookup.ts` with the request's scope (404
  `project-not-found` outside it, the same as a missing slug); listings use `scopedProjectsOf`; repos never take a
  `project_slug` or `account_id` from a body; the hooks Worker matches repositories by id and requires
  `installations.account_id = projects.account_id`; `audit_events.details` holds ids and enums only.

## Workspace
Node 22 (`.nvmrc`), npm, `npm ci` only — versions are pinned exactly, no `^`. Nx 23 / Angular 22 (Nx 22 does not
support Angular 22). Commands: `npx nx run-many -t lint`, `-t test`, `-t build`; a single project with
`npx nx test console-pages-settings`. Unit tests are Vitest through `@analogjs/vitest-angular`; the app is zoneless.

The root `package.json` declares `sideEffects: ["*.css"]`, so the bundler drops any module none of whose exports is
used. This rules out bare side-effecting imports (`import './x'`) in any lib or app source, stylesheets aside: a
polyfill, guard or interceptor registered that way would vanish from the build silently. Register it from an export
the app calls (a provider, an initializer). The barrels the shell reaches eagerly (`@console/shared/ui`,
`@console/entities/project`, `@console/entities/push`) are `export * from './…'` lines only, never
`export { X } from`, because with code splitting esbuild puts a named re-export's whole file into the importer's
chunk (#123). When a file holds private parts too, its public names go into a `*.public.ts` sibling, and the barrel
re-exports that file. `tools/workspace-checks/src/initial-bundle.spec.ts` guards all of this (the `sideEffects`
value, no bare imports, the barrel shape) along with the 500 kB initial and 4 kB component-style budgets.

npm is pinned to `package.json#packageManager` (10.9.9; `engines.npm` allows 10.x only) — the lockfile must be
written by npm 10, npm 11 rewrites it.

CI on every PR into dev/stage/main (ADR 0001 decision 18): `ci.yml` job `lint-test-build` runs `nx affected -t
lint|test|build` with `NX_BASE`/`NX_HEAD` from `nrwl/nx-set-shas` (merge-base of the PR's base branch and the PR
merge commit), and `nx run-many` instead when the PR touches `.github/workflows/`, `package.json`, the lockfile,
`.nvmrc`, `nx.json`, `tsconfig.base.json`, `eslint.config.mjs` or `vitest.config.mts`, and on every PR into
stage/main; the job's "Nx scope" notice says which. `security.yml`: `secret-scan` (gitleaks; on a PR only the
PR's own commits, `git log <base>..HEAD` from the merge commit's first parent — every PR commit with its own diff,
so a secret added and removed inside the PR is still found, while another open PR's branch is never judged against
this PR's `.gitleaksignore` (#171); on a push to dev/stage/main, where it is the only job, the full `git log --all`
of the clone — every branch and tag; the "secret-scan scope" notice says which), `sast` (Semgrep),
`dependency-audit` (`node tools/ci/audit-gate.mjs`, wrapping `npm audit --json`). Every action in
`.github/workflows/` is pinned by full commit SHA; the PR workflows use no secrets. A leaked secret:
rotate/revoke it first (the public history keeps it), then delete the branch and push a clean one (no
force-push onto shared branches), or — if it already reached a long-lived branch — add its fingerprint (from
the red run's log) to `.gitleaksignore` in a reviewed PR.
A synthetic test value (a sentinel token, a generated test key, a published test vector — never a real
credential) that gitleaks still flags on a commit already on a long-lived branch gets the same treatment as a
leaked secret, minus the rotation: one `.gitleaksignore` entry per red finding, as the exact fingerprint
(`commit:file:rule:line`) from that run's log, never a path or rule alone (an entry never masks a different
finding, even on the same file). Prefer a line-level `gitleaks:allow` comment on the line itself when the value
is staying (e.g. a fixed test vector from a spec like RFC 8291 Appendix A) — then later commits need no entry.
Going forward, a spec builds a synthetic secret-shaped value at run time (string concatenation, a generated
key pair) instead of writing one as a literal, so gitleaks has nothing to flag on new commits and no new
`.gitleaksignore` entry is ever needed for it.
Dependabot (`.github/dependabot.yml`) proposes github-actions updates weekly, grouped into one PR into `dev`;
those PRs go through the same gate as any other (CI + QA/REVIEW/SECURITY).

`dependency-audit` fails on any high/critical `npm audit` advisory except one with a matching, unexpired entry
in `.audit-allowlist.json` (`tools/ci/audit-gate.mjs`, unit-tested by `tools/ci/audit-gate.test.mjs`, spawned
end to end from a path with a space by `tools/ci/audit-gate.e2e.test.mjs`) — a narrow, time-boxed exception for
an advisory with no fix yet (owner decision, never added unilaterally). A match requires both the entry's
`ghsaId` and `package` to equal the advisory's; one entry never masks a different advisory, even on the same
package. An allowlist entry's `expires` must be a real calendar date in strict `YYYY-MM-DD` form, at most 90
days from today — the gate fails closed on anything it cannot parse or validate (a missing/unknown advisory
severity, an `npm audit` exit that yields no parsed advisories, a malformed allowlist). The allowlist is empty today (#395 removed the
`GHSA-vfj7-8cjw-p6xm`/`braces` entry of #177 once `npm audit --json` stopped reporting it). An entry, when the
owner grants one, is removed in the PR that makes its advisory go away (bump the dependency, confirm with `npm
audit --json` locally) — never left to expire — with a comment on its issue saying so.
Transitive fixes the lockfile cannot reach inside a parent's range are exact `overrides` in `package.json` (#395:
`miniflare.undici`, `nx.follow-redirects`, `@cloudflare/vitest-pool-workers.zod`); the deprecated
`@angular-devkit/build-angular` and `@angular/platform-browser-dynamic` (Storybook peers) are pinned there to the
Angular release too, since npm otherwise resolves them to the last non-deprecated major and fails on the peers.

Layout, tags and aliases (architect note on #3 — binding; the boundary lint enforces the tags):

```
apps/console                 type:app  scope:console  layer:app        (Angular PWA)
apps/console-e2e             type:e2e  scope:console                   (#14)
apps/api, apps/hooks         type:app  scope:worker                    (#6)
apps/runner                  type:app  scope:runner                    (#568: the runner CLI, Node 22, one-file bundle)
libs/console/<layer>/<slice> type:lib  scope:console  layer:<layer>    @console/<layer>/<slice>
libs/worker/<name>           type:lib  scope:worker                    @worker/<name>
libs/shared/<name>           type:lib  scope:shared                    @shared/<name>
tools/<name>                 type:tool scope:tooling                   (workspace checks, no runtime code)
```

Layers import downward only (`app → pages → widgets → features → entities → shared`), never their own layer
(`shared → shared` is the one exception), so features never import features. Scopes: `console → console|shared`,
`worker → worker|shared`, `runner → runner|shared`, `shared → shared`. A project whose tags match no constraint cannot import any project.
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
`Field`/`FieldControl`, `DatePicker` (#307: typed `ДД.ММ.ГГГГ` + a CDK-overlay calendar popover, a `Sheet` below 520 px; CVA with ISO `YYYY-MM-DD`; `ConfirmInput.type: 'date'` renders it; `tools/design-lint` fails on any native date/time input), `Icon`, `List`/`ListRow`, `Sheet` service (bottom sheet on the phone, dialog elsewhere, on the
CDK dialog; `confirm()`; `size: 'full'` fills the screen / `--sheet-full-w × --sheet-full-h` and hands the scrolling to
the content, #277; footer actions are `tcSheetFooter="primary" | "secondary"` templates and the frame renders them
in reading order — primary on top on the phone, Cancel then primary in the dialog row — so DOM, Tab and visual
order agree, #282; a bare `tcSheetFooter` is free-form), `Spinner`, `StateBlock`, `Tooltip` (non-interactive, `aria-hidden`), `TopBar`; Storybook in `.storybook/` with theme, motion and language
toolbars: `npx nx storybook console-shared-ui` on :4400, `npx nx build-storybook console-shared-ui` into
`dist/storybook/console-shared-ui` — the `storybook` contract command), `@console/shared/i18n` (Transloco,
`ru.json`/`en.json`; the app calls `provideConsoleAppI18n()` — every catalogue a lazy chunk, #433 — and specs and
Storybook `provideConsoleI18n()`, Russian inline and synchronous), `@console/shared/config` (`APP_CONFIG`), `@console/shared/api`
(`provideConsoleApi()` with the interceptor chain; `accessSessionInterceptor` sends every `/api` call with `redirect:
'manual'` and the `ngsw-bypass` header, and when `isAccessSessionExpired` says Access wants a new login — a redirect,
a `*.cloudflareaccess.com` URL, 401/403 with a non-JSON body, 401 `access-missing|access-unverified`, a 2xx HTML page —
sets `AccessSession.expired`; the app root then shows «Сессия истекла — войдите снова», whose button is a full-page
navigation to the same URL with `?ngsw-bypass=1` (stripped again in `main.ts`), #284). `/cdn-cgi/**` stays out of
`ngsw-config.json`: Access sets its cookie on `/cdn-cgi/access/authorized`, and an app shell served there locks the
owner out. Build time reaches the app through the build `define`
`__TC_BUILT_AT__` (defaults to `local`); the version comes from `package.json`.

Spaces shell (#23): `@console/shared/persisted-state` (`PersistedStateStore` over `localStorage` key `tc.state.v1`,
guarded by `isPersistedStateV1`, debounced writes, immediate for the chat draft, flushed on `visibilitychange`/`pagehide`;
never sent to the Worker), `@console/entities/project` (`ProjectsStore` — `ready()` gates the `p/:slug` `canMatch`
guard; `NeedsYouCounts` polls `GET /api/v1/needs-you` per minute while visible; `spaceUrlOf`/`spaceLocationOf`),
`@console/features/project-switcher` (pinned first, the rest collapsible, badge), `@console/widgets/app-shell` (sidebar
≥ 900 px, top bar + `Sheet` below; owns the scrolling `<main>` and restores its position per project screen), pages
`project-space` (tabs; every section maps to its page in `SECTION_PAGES`; chat is still a placeholder), `project-not-found`,
`needs-you`, `overview`, `settings` (language switch). Routes and the two guards live in `apps/console/src/app/`.

Questions (#16): `@console/entities/question` (read-model guards, `QuestionsApi`, `QuestionCard` — issue text only by
interpolation, untrusted items marked), `@console/features/answer-question` (`AnswerQuestion`: exactly
`allowedCommands`; confirm for go, a reason sheet for reject/no-go/override, a warning before any answer on an untrusted
item; failures branch on the problem `type`; Retry repeats the same body so the endpoint replays),
`@console/widgets/question-list` (Needs you and `/p/:slug/questions`; stamp, then a receipt). `AnsweredItems` in
`@console/entities/project` (`localStorage` `tc.answered.v1`, 6 h) keeps answered items out of the badges while GitHub
still lists them. Kit: `Recommendation`, `Receipt`.
Question context (#276): `InboxItemDto.context` (`QuestionContextDto`, so on inbox, questions and Needs you) is
`questionContextOf` in `@worker/read-models` — the body's `## Кратко|Вопрос|Почему|Если одобрить|Если отклонить|Цена и риск`
(or `Summary|Question|Why|If approved|If rejected|Cost and risk`) as bounded plain text for interpolation only (markup,
tag-like runs, the answer line and invisible characters removed — never tc-markdown or innerHTML; fences close only on
the same marker, #288; GitHub's 65,536 cut first), read only for trusted authors, `structured: false` + the first
paragraph when no heading is there. `markdownToPlainText` and `withoutInvisibles` (controls, zero-width, bidi, fillers,
tag characters; applied to every title DTO, #287, and shown with `dir="auto"` + the shared `unicode-bidi: isolate` rule
in `base.css`) live in `@shared/plain-text` (worker and console). The card
(`QuestionCard`) shows summary title + «На GitHub:», question, verb + why, `[tc-question-previews]` (design only, team items
only; `question-list`'s `QuestionDesignPreviews` fills it, #290: three screens via `previewScreensOf` + `DesignPreview [screen]`,
«+N», «Все экраны (N)», opening the viewer on that screen with the card's `AnswerQuestion` as its `actions`), outcomes (from the sections, else the answer line's options via `askOutcomesOf`), cost, actions,
details; the raw answer line is never rendered on any surface.

Sprint board (#18, read-only): `@console/entities/sprint` (`isSprintDto`, `SprintApi`, `statusColumnsOf` — lanes counted as
`backlog list` counts them, `SprintItemList`), `@console/widgets/sprint-board` (`/p/:slug/board`; loading, no sprint,
empty, error and 429 with an automatic retry at `Retry-After`). Kit: `Lanes`/`Lane` (a tab list of lanes on the phone, `[(selected)]` by `key`),
`Stats`/`Stat`, `ListRow` `external`. CI per open PR (#131): `SprintPullRequestDto.ci` (`success|failure|pending|none|unknown`)
from one `commits/{sha}/check-runs?filter=latest` read per PR head (`ciStateOf` in `@worker/read-models`, the plugin's
`checks.summarise` for check runs; fixtures `fixtures/check-runs.json`), cached 60 s per sha, under the sprint route's
`SubrequestBudget` (`SPRINT_GITHUB_BUDGET` 44): a PR past it, or one GitHub refuses, is `unknown`. Console: `SprintCiChip`,
`ciSummaryOf` (the board's "CI" tile). Run state (#132): `SprintDto.team` (`TeamRunDto`: `running|paused|failing|unknown`,
`runLogUrl`, the last 5 runs `running|finished|failed|unknown`) from `ProjectReads.teamRun()` — the run log's latest 200
comments through `readRunLog`, `teamRunOf` (`overviewTeamStateOf` + `recentRunsOf` of `@worker/run-log`), cached 30 s as
`team-run`, one entry with the overview's team state; read with the lists, before CI, ≤ 4 subrequests. A run a team entry
was edited on is `unknown`, never `failed` (`shownStateOf`); a run log GitHub refuses or the budget stops is `unknown`.
Mock: `MockRepository.comments` (the run log #22 of geeera/team-console); fake GitHub `POST /_fake/comment`. Console:
`SprintRunList`, `TEAM_RUN_ICONS` (the "Run log" tile).

Sprint commands (#218, #29 slice 1): `POST /api/v1/projects/:slug/sprint/demo-date` and `…/sprint/next`
(`routes/sprint-commands.ts`, `owner-only`) PATCH/POST the milestone on the owner's token exactly as `backlog sprint
create` writes it (`due_on: <day>T12:00:00Z`, title `Sprint NN` = highest of all milestones + 1), deciding on a live
`state=all` milestones read in Kyiv days (`team/sprint-plan.ts`, `sprint.freeze_days` via `freezeDaysOf`; the freeze is
`calendar.freeze_window`: demo − N through demo day); 409 `sprint-none|changed|unchanged|exists`, 422
`sprint-date-past|after-next|early`, flat extensions. `TeamStatusDto` gains `sprint`, `progress`, `calendar` (`null` when
the milestones read failed). Console: `@console/features/sprint-controls` (`SprintControls`, a `Sheet.confirm` with a
checked date field: `ConfirmInput.type/value/min/max/check`, `ConfirmFailure.refill`), the panel's Sprint group and the
board's "Move demo"; the command failure model (`commandFailureOf`, `CommandOutcome`) lives in
`@console/entities/team-run`. Fake GitHub: `seedMilestones`, milestone writes, `/_fake/milestones` (`DELETE …?repo=` /
`clearFakeMilestones` drops a seed so the mock answers again). The mock's milestones carry `due_in_days` (served as
`due_on` relative to the day of the read, `milestoneAt`, #382) — never a fixed date a spec can outlive.

Requests to the PM (#219, ADR 0005, #29 slice 2): `POST|GET /api/v1/projects/:slug/issues/:number/request`
(`routes/owner-request.ts`; POST `owner-only`) posts one comment on the owner's token through `postOwnerAnswer` (`own_writes.kind
= 'request'`, 60 s replay) — `requestComment` of `@shared/owner-grammar` (first line `<!-- pt-owner-request {canonical json} -->`,
a human line in `owner.language`, the italic trailer; golden `fixtures/owner-requests.json` from the plugin's `ownerrequests.py`) —
and never a milestone, label or status; 409 `issue-changed` (`milestone`) / `issue-closed` / `sprint-none`, 422
`sprint-next-missing` / `request-not-issue`. D1 `owner_requests` (migration 0012, `OwnerRequestsRepo`) is a display cache only:
newest row per issue, never an input to a write or an authorisation decision. A request is handled by a
`pt-owner-request-handled` first-line marker from a `type: Bot` login in `TRUSTED_BOT_LOGINS` (`handledRequestOf` in
`@worker/read-models`): the hooks Worker on `issue_comment.created`, the GET on the newest comments — the last page
plus the one before a short last, at least 100 (unedited only; `requested_at` is GitHub's `created_at` of the request
comment, so both sides of the "after the request" check are on GitHub's clock, #269/#270).
`SprintIssueDto.request`, `TeamStatusDto.pendingRequests`, `GET …/requests` (the picker). Console:
`@console/features/request-change` (`RequestChange`: picker, then the one-request form), the panel's Issues group, the board's
"Ask the PM" and «ждёт PM» chip. `team.console_app_slugs` in `.product-team/project.yml` is the plugin's trust root for requests: `[team-console-dev]` only (owner, 2026-10-07); stage and production join after #152.

Own tracker, core (#410, ADR 0006 Phase 1a; no UI and no import yet): `routes/tracker/{items,comments,sprints,labels}.ts`
under `/api/v1/projects/:slug/` — `GET|POST items`, `GET|PATCH items/:key` (`TC-310` or `310`; `ETag`/`If-Match:
"<version>"`, 428 `item-version-required`, 412 `item-version`), `GET items/:key/events`, `GET|POST items/:key/comments`
(append-only, no edit route), `GET|POST sprints`, `GET|PATCH sprints/:number` (`Sprint NN`, or the optional one-line `title` of `POST`, ≤ `SPRINT_TITLE_MAX_LENGTH`, #457), `GET|POST labels`. D1 only,
behind the route matrix (#444, below), reads included; their freeze hints read project.yml's `sprint.freeze_days` from `GET
/projects/:slug/sprint-freeze` (`SprintFreezeDaysDto`, the shared cached project.yml read, #457) instead. Console (#457): `ItemsApi.decide|freezeDays|createSprint({dueOn,title})` in `@console/entities/item`; every tracker problem slug is mapped once, in `trackerFailureOf` (`KIND_BY_PROBLEM`), and `AnswerClient.decide` and the batch dialog read only its kinds; `TC-n` items in the batch dialog are approved one decision each (with the open `askId`, a key per item), GitHub items stay on `answers/batch`. Every write, in
this order: 404 project → 409 `tracker-not-cut-over` while `projects.tracker = 'github'` → `Idempotency-Key` (400
`idempotency-key`; `tracker/idempotency.ts` over `idempotency_keys`, completed inside the write's own batch, 24 h; per
identity (#462: the row key is a hash of the identity kind + owner login | job project, role and id, then the client key; the request hash
covers that scope too), so another identity's same key is a fresh request;
replay answers the resource with `Idempotent-Replayed: true`, 409 `idempotency-in-flight`, 422
`idempotency-key-reused`) → body checks from `@shared/contracts` (`checkCreateItemInput` …, 422 `*-invalid` with
`field`; titles through `withoutInvisibles`; 413 over 512 KB, labels 4 KB) → the transition table
`auth/policy.ts` (`transitionRefusal`: owner-semantic status/flags — approving, `design:approved`, `owner:*`, closing
`team:demo` — are 403 `transition-owner-only` for any job, `workflow-change` owner/`security` only, removing
`release-blocker`/`security` needs `security`/`pm`, `dev*`/`qa` only the status of a held item; once `approved_at` is
set, `title`/`body` are 403 `transition-owner-only` reason `edit-after-approval` for every job while `kind`, `severity`,
`tier`, `sprint` stay the editing roles' (#462, `changesText`/`changesPlanning`); the owner may make every change) → one D1 batch with its `item_events` rows, one per kind of change — the lifecycle (`status|closed|reopened`) apart from `labels|sprint|edited` (`tracker/item-change.ts` plans the columns and the before/after of the
changed fields). Lists: `?after=&limit≤100`, items also `status|kind|severity|tier|sprint(=N|none)|label|state`. DTOs
`ItemDto`, `TrackerSprintDto`, `CommentDto`, `ItemEventDto`, `LabelDto` (separate from the GitHub-backed board DTOs).
Specs seed a fresh project per case (`testing/tracker-kit.ts`; `send(…, { job })` sends as the local job stand-in).
Asks, owner decisions and requests (#434, Phase 1a′): `routes/tracker/{asks,decisions,requests}.ts` — `GET|POST
items/:key/asks` (job-only: any role but `dev*`, the owner 403 `ask-role`; replaces the open ask and sets
`owner:<category>` in its batch, `askEffectOf`), `GET|POST items/:key/decisions` (owner-only, `via: web|push`, no
`If-Match`; section by `sectionOf`, commands from the open console ask or `ANSWERS`, 409 `ask-not-open|ask-imported`,
effects by `decisionEffectOf` through `planItemUpdate` in one batch, a moved version re-read once then 409
`item-changed`), `GET|POST items/:key/requests` (owner-only, no sprint logic) and `POST requests/:id/handled` (`pm` job
only, 409 `request-handled`); the job-only writes refuse every deployed identity until Phase 2.
Route matrix and the local job stand-in (#444, ADR 0006 decision 11; Phase 2 keeps the table and swaps the token):
`auth/tracker-matrix.ts` (`TRACKER_MATRIX`, one row per tracker route) enforced by `trackerAccess(route)` in
`auth/tracker-access.middleware.ts`, which replaces `ownerOnlyMiddleware` on every tracker route — an identity that
can act on no account (the service, a job off the bypass) 403 `owner-only` before anything is read; the project
through the scoped lookup (a job's other project, a user's other account and a missing slug are one 404
`project-not-found`, never 403); the policy actor in the project's account (`policyActorOf(identity, env, accountId)`:
an `owner` member → `owner`, a `member` → `member`, none → 403 `owner-only`); then the row's 403: reads owner +
member + any role; a member's writes are refused by the row (`member-role`) until the tracker tables know a `user`
actor kind (T-3) — the policy for them (`proposed` items, `comment`s) is already in `transitionRefusal`/
`commentKindRefusal`; `POST|PATCH items` any role, judged by `transitionRefusal` (holds = the item's
number in the job's `items`; R2: `qa`/`reviewer`/`security` never set or clear `qa:changes-requested|review-failed|tier-up`,
`verdict-flag`); comments any role, `kind: comment|note|decision` (`commentKindRefusal`: the owner `comment` only,
`decision` not as `dev-light`, 403 `comment-kind`); sprints owner + `pm` (403 `sprint-role`); labels, decisions, requests
owner only; asks any role but `dev*` (`ask-role`); handled `pm` only. `jobScopeMiddleware` (on `/api/*` after auth)
refuses a job on every non-matrix route (403 `owner-only`; `isTrackerMatrixRoute` matches `c.req.path` exactly, the
path the non-strict router already stripped of one trailing slash, #462); CSRF exempts the bearer `job` identity only (JSON still
required). The job identity's only minter is the local stand-in (`auth/local-job.ts`): under `isLocalBypass` alone,
`Authorization: Bearer local-job.<base64url({"role","project_slug","job_id","items"})>` (exact members, a role of
`auth/job-roles.ts`, ≤ 100 items) is that job; `JobRole` is typed through `Identity`, `PolicyActor` and the matrix
(`job: Record<JobRole, boolean>` per row), and the role groups (`EDITING_ROLES`, `STATUS_ONLY_ROLES`, `REVIEWER_ROLES`,
`DEVELOPER_ROLES`) are defined once there from a `Record<JobRole, traits>`, so a new role must be decided (#462); any other `Authorization` there is 401 `job-token-invalid` (never the
owner); a stand-in anywhere else is 401 `job-token-refused`; `policyActorOf` maps a `job` only under the bypass too.
`tracker-matrix.spec.ts` proves every row × owner, each role, another project's job and the service.
Secrets and the scrub (#462, ADR 0008 row 2-0): `@shared/redaction` (`findSecret`, `redactSecrets(text, mode)`, `JOB_TOKEN_PREFIX`, `ENROLMENT_CODE_PREFIX`; GitHub `gh[pousr]_`/`github_pat_`, `glpat-`, JWTs (judged run by run: the text is split into runs of the JWT alphabet, a run without two dots is skipped, and the shape is tested at each `eyJ` inside a run, so a JWT glued to a preceding character is still masked and a 64 KB `eyJ…` run costs one pass, #474/#488), PEM and PGP private keys, `tcj_` job tokens and `TC_JOB_TOKEN=`, `tce_` enrolment codes, `sk-ant-`, `npm_`, `AKIA`/`ASIA`; no word-boundary anchors, so a token glued to a word still matches) is the one pattern list for the API's 422 check (`strict`: the whole shape), the Worker logger and `AuditRepo` (`loose`: the prefix with any tail, so a cut-off credential is still masked — except where a short tail is a word: `npm_` keeps its full shape and `gh[pousr]_` needs 12+ base62 characters, so `ghs_foo` stays readable, #492; `@worker/core`'s `redact` is `redactSecrets(…, 'loose')` plus its own header-name and URL-query rules, #467) and the runner's event redactor. A job's free text — item `title`/`body`, comment `body`, ask `ask`, sprint `title`/`description`, the PM's `reason` — matching one (after `withoutInvisibles` and every `Default_Ignorable_Code_Point` removed) is 422 `body-secret` with `field` and `kind`, never the value (`tracker/body-secret.ts`), checked after the route's authorisation (comment kind, transition table: their 403 first); encoded or split tokens are out of reach, so this is not the boundary (RR11); the owner's text is not judged. `POST items/:key/events/scrub` (owner only, matrix row; `{}` or no body, `Idempotency-Key`) masks `title`/`body` in the item's `created`/`edited` events (`ItemEventsRepo.scrub`) and answers 201 with the `scrubbed` event (`after: {events, fields}`); the console hides that event in the history.
Plugin feeds, pr links and job read models (#445, #529): `GET decisions` (`routes/tracker/decisions.ts`, matrix `READ`) is the
project-wide decisions feed (`backlog reversals`). `GET requests` has two handlers on one path: with `?state=` it is the
tracker's project-wide list (`guardedProjectRequests` in `routes/tracker/requests.ts`, behind its matrix row), without it
the owner's GitHub list (#219, `project-read-models.ts`); a job reaches only the `?state=` form — `jobScopeMiddleware`
refuses the bare path (403 `owner-only`) through `isJobRoute(method, path, hasQuery)` and the matrix's
`JOB_QUERY_REQUIRED`, so the handler holds no refusal of its own. `POST items/:key/pr-links` (`routes/tracker/pr-links.ts`,
`backlog link-pr`; the developer holding the item or the orchestrator, `pr-link-role`/`item-not-held`) writes a
`pr-linked` event `{number, url, headRef}` with the URL the server built; a repeat of the same PR answers the first link
(200 same branch, 409 `pr-link-conflict` other branch) without asking GitHub. Only a new link is checked on the provider
after the body/URL checks and before any write (`findPullRequest` in `read-models/pull-request-sync.ts`: the registered
repository by id, then the adapter's `pullRequests.get`, budget 5, never the read cache; `repoIdOf` in
`read-models/repo-id.ts`, 409 `repo-id-unknown`): no such PR is 422 `pr-link-invalid` `field: number`, another head
branch `field: headRef`; a GitHub rate limit (429 `Retry-After`) or outage (502) throws, so nothing is written and the
idempotency key is released for the retry. Migration 0025's partial UNIQUE index `item_events_pr_link` (`item_id`,
`after.number`, `kind = 'pr-linked'`) keeps two concurrent links to one event: `ItemEventsRepo.linkPr` answers `false`
on it and the loser answers like a repeat. `JOB_READ_MODEL_ROUTES` (`auth/tracker-matrix.ts`: `GET inbox|questions|sprint`)
are the read models a job reads besides the matrix, through the scoped `findProject` (another project 404); every other
read model refuses a job in `jobScopeMiddleware`.

VCS adapter, reads (#463, ADR 0006 decision 7 / "VCS adapter", ADR 0008 row 3a): `@worker/vcs` (provider-neutral types,
`VcsAdapter`, `VcsWebhooks`, `VcsError` with `kind` and the provider's problem, `mapVcsError` in `createApiApp`'s
`mapError`) and `@worker/vcs-github` (`GitHubVcsAdapter` over `GitHubClient` + `GitHubAppAuth.tokenSourceFor`, the
read-only per-repository token; one list page per call from our own `page`/`per_page`, never a followed `Link`;
`repository`, `branches.get|list`, `files.read` (`githubContentsPath(repo, path, ref)`), `pullRequests.get|list|files`,
`ci.status` (`ciStateOf`); every write and `credentials.gitToken` throw 403 `vcs-write-forbidden` before any request
until 3b; `githubWebhooks.verify|parse` — the HMAC check moved here from `apps/hooks`, which imports no credential).
The hooks Worker upserts `pull_requests` from `pull_request` deliveries and marks a head's CI stale on
`workflow_run.completed`; `GET /api/v1/projects/:slug/prs[?state=open|closed|merged|all&after=&limit=&fresh=1]` and
`GET …/prs/:number[?fresh=1]` (`routes/pull-requests.ts`, matrix READ rows) read D1, `fresh=1` (or a number D1 lacks)
first syncs through the adapter (`read-models/pull-request-sync.ts`, `SubrequestBudget` 40/6, 30 s per epoch). Mock
GitHub: `pulls/{n}`, `pulls/{n}/files` (`pullFiles`), `branches`, paged pull lists with `base`; `MOCK_FIXTURES`.

Artifacts (#19, read-only): `GET /api/v1/projects/:slug/artifacts[?fresh=1]` (`routes/artifacts.ts`, `read-models/artifact-reads.ts`)
reads decisions (`decisions_dir` listing + first `#` heading, ≤ 30 file reads), designs (`ux-spec`/`design:*` issues,
`docs/design` one level deep, `design.storybook_url` if on github.com) and `team:demo` issues through `ReadCache`
(60 s issues / 600 s contents, keyed by `cache_epoch`), each type on its own: a failed one is listed in `partial`. Pure
readers in `@worker/read-models` `lib/artifacts/` (snapshot `fixtures/artifacts_snapshot.py`). Console:
`@console/entities/artifact` (`ArtifactsStore`, `ArtifactList`), `@console/features/artifact-search`
(`filterArtifacts`, `ArtifactSearch`), page `ArtifactsSectionPage` (`?type=&q=`, mirrored to `artifactFilter`).

Designs and demo (#20): `/p/:slug/demo` (`DemoSectionPage`) lists the `design` and `release` sections of
`GET /projects/:slug/questions` through `QuestionList` (`sections`, `embedOrigins`) and answers them with the same
`AnswerQuestion` and answer route. With `embedOrigins`, a team-authored item's `QuestionCard` renders its body through
`<tc-markdown>` (`@console/shared/markdown`; it lazy-loads `renderMarkdown` — `marked` + DOMPurify, allow-listed
tags/attributes, https/mailto/# links only, images become links labelled through i18n, every link `target=_blank
rel="noopener noreferrer"`; never bypass Angular's sanitiser; the barrel must not import the renderer statically, so
Questions and Needs you never download it) and previews the body's first link (`previewTargetOf`) in the kit `Frame`.
Items from outside the team stay plain text with no preview. `Frame` is the only place a frame `src` is built:
`frameSrcOf` (kit `frame/frame-src.ts`) requires https, no credentials, a DNS host outside IP/loopback inside the
`_headers` `frame-src` families (no `'self'` there), never the console's own origin, and `new URL(src).origin` exactly
in `GET /projects/:slug/embed-origins` (`EmbedOriginsApi`: `design.storybook_url` only — stage is link-only because it
sits behind Cloudflare Access, owner decision 2026-10-05 on #188 — and never the request's own origin); the
sandbox never has `allow-top-navigation`, `referrerpolicy="no-referrer"`, no `allow`. Anything else is a "can't be
shown here" note with an Open link.

Design viewer (#277, spec §R shared with #276): `GET /api/v1/projects/:slug/designs/:issue` (`routes/designs.ts`,
`read-models/design-reads.ts`) lists the png/jpeg/webp/gif files (never SVG) under `docs/design/**` whose path has a
segment starting with `N-`, from one `git/trees/{sha}?recursive=1` read at the head of the open pull request that
links #N (`linkingPullRequestOf`: `#N` in body/title or a `N-…` branch segment), else the default branch head —
`DesignManifestDto` in `@shared/contracts`, captions from an optional `screens.json`, ≤ 40 files, images over 5 MB
listed as `tooLarge`. `…/designs/:issue/:sha/file?path=` serves one listed screen's bytes (`GitHubClient.getBytes`
on `git/blobs/{sha}` with the installation token, so private repositories work) only after the magic bytes agree
with the type its name claims, with `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `inline` and
`private, max-age=86400`; 404 for any other path, 413 over the cap (manifest or stream), 415 on a
mismatch. Pure parts in `@worker/read-models` `lib/designs/` (`designFilesOf`, `designManifestOf`,
`imageTypeOfBytes`). Mock: `MockRepository.binaryFiles` (base64; `fixtures/design-images.mjs` regenerates them),
`git/trees`, `git/blobs`, `branches/{name}`. Console: `@console/entities/design` (`DesignManifests` store shared by
every reader, `DesignPreview` — the first screen as a decorative `<img>` for rows and the #276 cards —,
`DesignSummary`), `@console/features/design-viewer` (`DesignViewer.open({ slug, issue, title, actions?, screen?, mode? })` on the
kit `Sheet` with `size: 'full'`: «Картинки» / «Все экраны» / «Интерактивно», the iPhone/Mac switch, ←/→ and a swipe,
a zoom toggle; the HTML wireframe is framed only through the embed-origins gate in the kit `Frame`'s `profile="design"`
— `sandbox="allow-scripts"` alone, never `srcdoc` — else the «нельзя показать» state). Artifacts' design rows
(`ArtifactDto.number` / `awaitingApproval`) are button rows with the preview and summary projected by the page.

All projects (#27, read-only): `GET /api/v1/overview` (`routes/overview.ts`) builds one row per active project from the
same cached reads (`buildOverviewRow` in `@worker/read-models`; team state by `team/team-health.ts` from the run log's
latest 200 comments, cached 30 s) under a per-request `SubrequestBudget` (44 GitHub subrequests; a project it cannot
finish is its own `github-request-budget` row). Console: `OverviewApi` in `@console/entities/project`, page
`console-pages-overview` (tiles link to `/p/:slug/board`); kit `Meter`. Commands from All projects (#222): every card's
"Commands for {name}" button (the tile's `[tc-tile-actions]` slot) opens the same `@console/widgets/commands-panel` —
`CommandsPane` beside the page on a wide screen (also the space's pane), `CommandsSheet` on the phone; K on a focused
card (`isCommandsShortcut`, shared with the space) opens it for that card, closing returns focus to the card's button.
`OverviewProjectReadDto.snooze` (D1, `snoozeOf`) feeds the card's struck-bell line and is pushed into
`ProjectsStore.applySnooze`, which the cards then read, so a snooze changed from the panel shows at once.

Repositories from GitHub (#194, ADR 0003 decisions 2(a)/6 as amended): `GET /api/v1/github/installation/repositories[?fresh=1]`
(`routes/installation-repositories.ts`, a read mounted before the owner-only connection routes) → 403 `github-owner-not-connected`
before any JWT when no owner is connected; the installation by `account.id` = the pinned `user_id` (`installationIdForAccount`,
`GET /app/installations`, never a login; none → 409 `github-app-not-installed` + `installUrl`); the installation-wide token
(`listTokenSourceFor`, mint body exactly `{permissions:{metadata:'read'}}`, cache key `installation:<id>`, `kind:
'installation-list'`) is accepted only by `GitHubClient.listInstallationRepositories` (fixed path, `Link` only to
`/installation/repositories`); every generic client method refuses it before any fetch. ≤ 10 pages under
`SubrequestBudget(20)` (`listConnectionFor`), `partial` when the cap or the budget stops it; GitHub's part cached 60 s, the
registry merged per request from D1. Console: `@console/entities/installation-repository` (store, guard, `repositoryGroupsOf`),
`AddProject`/`AddJob`/`AddRepositorySheet` in `@console/features/add-project`, `@console/widgets/github-repositories`
(`GitHubRepositoriesBlock` + presenter `RepositoryListView`, stories in the kit Storybook) on All projects; every "Add
project" entry point is `ADD_PROJECT_URL` (`/overview#add-project`); Settings holds settings only. Kit: `SheetFooter`,
`Sheet.open({ width: 'wide' })` (`--sheet-dialog-w`), `ListRow` `link`/`label`/`muted`/`tc-row-trailing-text`/`tc-row-detail`.

Team commands (#114): `routes/team-commands.ts` (`GET /projects/:slug/team/status`, `POST …/team/pause|resume` on the
owner's token, byte-for-byte `runlog pause`/`resume`, 60 s replay from `own_writes`; `POST …/runs {slot}` fires the
slot's routine once, never retried, behind the run log (paused, 3-hour overlap) and the 15-minute `slot_requests` lock
of migration 0008). `readRunLog` (`team/run-log-reader.ts`) reads the newest ≤ 10 pages of comments from the issue's comment count
and fails closed (`RunLogIncompleteError` → 503 `run-log-incomplete`; `unknown` on the board/overview) when it did not
reach the list's end or a paused log's pause record lies before that window (#143). `@worker/run-log` ports `ptlib/runstate.py` (fixtures from `libs/worker/run-log/fixtures/generate.py`
— rerun after every `vendor` update); `@worker/routines` is the only client of the routines API (`ROUTINES_FAKE_ORIGIN`
+ `nx run api:fake-routines` locally, never the real one). Secrets `SLOT_TOKEN_<SLUG>_<SLOT>` / `SLOT_ROUTINE_<SLUG>_<SLOT>`
(`slotSecretNames`). Console: `@console/entities/team-run` (`TeamStatusStore`), `@console/features/team-commands`
(`TeamCommands`: one `Sheet.confirm` per command), `@console/widgets/commands-panel` (pane, phone sheet, paused banner);
kit `Banner`, `Button[off]`, `Receipt` tone `warning`, `Sheet.confirm` with `items`/`input`/`ConfirmFailure`, `--dur-pulse`.
Console pause guard (#141): the plugin's `runlog start` does not count the owner's own pause in a run log the team's
bot opened, so `POST …/team/pause` answers 409 `pause-unreliable` there, `TeamStatusDto.pauseHolds` turns Pause off with
the reason, and `pauseLiftsAtNextRun` replaces "paused by you" when the next run would lift the label. The one switch is
`PLUGIN_COUNTS_OWNER_PAUSE` in `@worker/run-log` (`owner-pause.ts`); `fixtures/owner-pause.json` (the real `cmd_start`
over the issue's reproduction) fails the golden spec until the switch agrees with the vendored plugin.

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
Webhooks (#12): `apps/hooks` `POST /hooks/github` — 405 → 503 `webhook-misconfigured` (empty `WEBHOOK_SECRET`) → 413 (1 MB read) →
401 (strict `sha256=` HMAC, `WEBHOOK_SECRET` + `WEBHOOK_SECRET_PREVIOUS`) → dedupe (`WebhookDeliveriesRepo`, delivery id and body
SHA-256) → registry row + `installation_id` → `cache_epoch` bump → `own_writes` → author gate (`isTrustedAuthor`) → pure `mapEvent`
(`questionNotification` / `linkNotification`) sent in `waitUntil` by `webPushSenders` (the same `PushSender`, VAPID vars and
`PUSH_FAKE_ORIGIN` as the api; `pushFetch` in `@worker/push`, `localFakeOriginOf` in `@worker/core`). Logs carry `{deliveryId, event,
repo, status}` only. Locally `nx serve hooks -- --var WEBHOOK_SECRET:<throwaway>` plus the push `--var`s above.
Environment identity (#237): one console build for every environment. The api Worker answers `/manifest.webmanifest`
(name «Team Console Dev|Stage|Local», short «TC …»; production unchanged) and `/brand/favicon.ico|apple-touch-icon.png`
from `ENVIRONMENT` (`routes/app-identity.ts`, `run_worker_first`); the icon sets are static files in
`apps/console/public/icons/<env>/`, generated with a bottom band by `tools/env-icons/generate.py` (Pillow, rerun when the
production icon changes). None of those Worker paths may enter `ngsw-config.json` (a hash mismatch breaks the SW
install). Names live in `@shared/contracts` (`appNameOf`, `environmentLabelOf`); the app sets `<title>` and
`apple-mobile-web-app-title` from `DeploymentStore`, the shell shows `EnvironmentMark` (`@console/entities/app-info`), and
`PushSender` takes the `environment` and prefixes titles «[Dev] …» (`forEnvironment` in `@worker/push`).
Environment setup (#104): `.product-team/environment-manifest.yml` (#102) reaches code as
`@shared/environment`'s `manifest.generated.ts` (`node libs/shared/environment/scripts/generate-manifest.mjs` after
every manifest change; `manifest.spec.ts` fails until the two agree). `environmentRowsOf(env, slugs)` expands it into
rows by place (`api`, `github-vars`, `projects`, `hooks`, `github-secrets`, `repo`, `local`; the row id is the guide's
URL); a row's `binding` is what that environment's own api Worker can read, null for what it cannot see.
`GET /api/v1/environment/status` (`routes/environment.ts`, owner-only — the service identity gets 403) answers
`{ environment, items: [{ id, status: set|missing, optional }] }` from `environmentStatusOf` — presence only (an empty
string is missing), never a value, length, prefix or hash; optional items never count as missing (`countedMissingOf`).
The DTO, its guard and `setupCommandOf` live in `status-dto.ts`, which imports no manifest, so the Settings chunk never
carries the guide prose (the barrel is `export *` only). Console:
`@console/entities/environment` (`EnvironmentStatusStore`, in memory only; `environmentViewOf`, `entryChipOf`), the
Settings "Environment" row, and `/settings/environment/:env[/:place/:name | /project/:slug/:name]` in
`console-pages-settings` (lazy chunks; list-detail from a 900 px page). Its `env.*` copy is
`entities/environment/src/lib/copy/{ru,en}.json`, merged into Transloco by the `environmentCopyReady` guard — never in
the inline `ru.json` (#337); a chunk that cannot load is reported to `ErrorHandler` and both screens show
`settings.common.envFailed` with Try again instead of raw keys (`ENVIRONMENT_COPY_LOADER` is the specs' seam). Kit: `CopyCode`, `Tabs [dense]`, `TabPanel [note]`. The fix command is
`setupCommandOf` (`setup --env <env>[ --rotate| --check]`) until #103 fixes the invocation.
PWA updates (#306): `AppUpdates` (`apps/console/src/app/app-updates.ts`, started by `provideAppUpdates()`) asks `SwUpdate`
on start, on `visibilitychange` to visible and every 5 min while visible. A version found by a start/resume check is
activated and reloaded at once when the page is quiet (no `Sheet.hasOpen()`, no `hasUnsavedField`, app stable within
3 s); otherwise `UpdateBanner` shows «Доступна новая версия · Обновить», and a pending update is taken on the next quiet
resume. `unrecoverable` (at once) or a `Hash mismatch` install failure (like an update: at once when quiet, else on the
next quiet start/resume, #311): delete the `ngsw:` caches, unregister, one navigation with `ngsw-bypass` (`localStorage` `tc.sw-recovery.v1` allows one heal per 10 min). `_headers` serves `/`, `/index.html`, every
client-side route (one rule each, `pwa.spec.ts` checks them against `app.routes.ts`), `ngsw.json`, `ngsw-worker.js` and
`safety-worker.js` with `Cache-Control: no-cache` (the assets layer answers them, never the Worker code). E2e
`pwa-updates.e2e.ts` serves a derived build B (`writeNextBuild`/`routeDeploys` in `support/service-worker.ts`).

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
`push_test_sends`); `0010_webhooks` #12 = `webhook_deliveries` + `projects.access_lost_at`; `0011_project_snooze` #221; `0012_owner_requests` #219; `0013_tracker` #410 (ADR 0006 tracker core: `projects` + `provider|tracker|key_prefix|next_item_number|cutover_at|default_branch`, `labels`, `sprints`, `items`, `item_labels`, `comments`, `item_events`, `idempotency_keys`; enumerations as CHECKs, comments/events append-only and items never deleted by triggers; repos `TrackerProjectsRepo`/`LabelsRepo`/`SprintsRepo`/`ItemsRepo`/`CommentsRepo`/`ItemEventsRepo`/`IdempotencyKeysRepo` in `@worker/db`, each write one batch with its event; `LABELS_SEED` from `libs/worker/db/scripts/generate-labels-seed.py` — rerun after every `vendor` update); `0014_decisions` #434 (`asks`, `owner_decisions`, `item_requests` — the ADR's recreated `owner_requests`, named apart from 0012's live table — and the `import_map` stub, append-only by triggers incl. the `*_never_replaced` guards; `idempotency_keys` rebuilt by copy for `ask|decision|request`; repos `AsksRepo`/`OwnerDecisionsRepo`/`ItemRequestsRepo`/`InboxRepo`); `0015_decision_guards` #443 (triggers: an ask is answered, and a team decision reversed, only by a decision on the same item that names it; R7 in the schema — a web/push decision never answers an imported ask; `import_map` append-only, an identical re-insert skipped, a re-point refused; their messages never say "are append-only", which `isAppendOnlyConflict` keeps for lost races); `0016_item_approval` #452 (`items.approved_at`, set once as an item first enters a workable status, never changed); `0017_item_approval_guards` #457 (triggers: `approved_at` is a `toISOString` UTC timestamp and is set only while the status is workable); `0018_accounts` #465 (ADR 0008 T-1: `accounts`, `users`, `sessions`, `account_members`, `invites`, `installations`, `user_connections` (empty until T-4 moves `owner_connections`), `audit_events` (append-only by triggers incl. `audit_events_never_replaced`), `projects.account_id` (NOT NULL, default the owner account `OWNER_ACCOUNT_ID` of `@shared/contracts`; existence, "never changes account" and "keeps its projects" by triggers) and `projects.repo_id`; the last owner kept, `users.access_subject` written once, an unlinked installation never revived; `*_never_replaced` guards on `accounts`, `users`, `projects`, `account_members`, `installations` and `audit_events`, so REPLACE cannot bypass the UPDATE triggers and `ON CONFLICT` aborts there (writers select, then insert or update); session and invite times are CHECKed UTC timestamps; audit `details` ≤ 4096 bytes; repos `AccountsRepo`/`UsersRepo`/`InstallationsRepo`/`AuditRepo` (+ `auditEventStatement` for the action's own batch; no UPDATE/DELETE of `audit_events` in `@worker/db`, a source scan tests it) in `@worker/db`, #473; backfill: the `owner` account always, its user and owner membership only from exactly one GitHub user in `owner_connections` (fail closed; `email` stays NULL, OWNER_EMAIL is not visible to SQL), an `installations` row per project installation, `system` audit rows. No route reads them before T-2 #466); `0019_event_scrub` #462 (`item_events` rebuilt by copy for the `scrubbed` kind, its append-only update trigger now admitting exactly the scrub — `title`/`body` of a `created`/`edited` event set to `[scrubbed]`, every other column and member unchanged; `idempotency_keys` rebuilt by copy for `event`); `0020_pull_requests` #463 (ADR 0008 row 3a: `pull_requests`, a rebuildable mirror of the VCS, UNIQUE (`project_slug`, `number`), CI per `head_sha` with `ci_stale`; `PullRequestsRepo` in `@worker/db` — an upsert that keeps the later provider `updated_at`, resets CI on a moved head and writes nothing when the delivery's repository id is not `projects.repo_id`); `0021_runners` #467 (ADR 0008 row 2-A: `runners`, `runner_enrolments`, `runner_nonces`, `role_keys`, `rate_limits` — see "Runners" below; `RunnersRepo`/`RateLimitsRepo` in `@worker/db`); `0022_jobs` #467 (`jobs`, `job_events`, `team_state`, `projects.runner_policy`, `accounts.default_runner_policy` — see "Jobs and job tokens" below; `JobsRepo`/`TeamStateRepo`); `0023_role_key_guards` #492 (triggers only, see Runners); `0024_role_key_delete_guard` #522 (trigger only: a role key is never deleted); `0025_pr_link_unique` #529 (`item_events.duplicate_of`, set only by the migration on links an earlier race duplicated — a new row carrying it is refused, the append-only trigger freezes it — and the partial UNIQUE index `item_events_pr_link` over unmarked `pr-linked` rows). No number is reserved — a new
migration takes the highest number on `dev` + 1 when its PR opens and is renumbered on rebase if that number was taken,
so 0002–0004 stay unused). The answer route (#10) is `routes/answer.ts`
(`POST /api/v1/projects/:slug/issues/:number/answer`, owner-only): section re-derived from the live issue with
`@shared/owner-grammar` (a byte-for-byte port of the plugin's `backlog answer` and `commands.command_lines`, proven by
fixtures that `libs/shared/owner-grammar/fixtures/generate.py` writes from the vendored plugin — rerun it after every
`vendor` update, a spec fails until you do), owner check, then the comment on the owner's token through
`GitHubClient.postJson` (one refresh on 401, never retried after a timeout or 5xx), 60 s replay from `own_writes` (`ANSWER_REPLAY_WINDOW_MS`); a Retry later than that after the first attempt (counted from the first, however many Retries came between) first re-reads the item through `POST …/answer/lookup` (#120: same live issue read and problems, then the console's own write of exactly that answer since it was first sent, or `null` — nothing written), so `AnswerQuestion` shows the receipt instead of posting twice. The owner connection (#59, ADR 0003 decisions 3–4) is
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
`src/testing/access-kit.ts` to sign tokens and stub the JWKS). Log `identity.kind` only, never the email or token
(nor a job stand-in's token or payload).
Account scope (#466, ADR 0008 decision 2, T-2): before the Access check, a live `__Host-tc_session` cookie
(`auth/session.ts`: 43 base64url characters, SHA-256 looked up in `sessions`, unrevoked and unexpired; T-3 creates
them) mints `{kind: 'user', door: 'session', userId, memberships}` with the memberships read from `account_members`
per request; a cookie that is not a live session grants nothing and the request goes on to Access. The Access owner
is `{door: 'access'}` and owns the `owner` account by construction (`ACCESS_OWNER_MEMBERSHIPS`, the door — never an
email comparison), plus the memberships of the user row whose `access_subject` equals the JWT `sub` (the explicit
link of decision 3, T-3). `isOwnerIdentity` (push, the owner connection, environment, team/sprint commands, snooze,
batch answers, `POST /projects` and `GET /github/installation/repositories` — the last two judge repositories
against the environment owner's connection and list its installation, #482 review) is the Access door and the local
bypass only: those routes act on the environment-wide owner connection and devices until T-4 binds them per user,
so a session user gets 403 `owner-only` there whatever it owns. On top of it, every owner-grade write on a project
(`PATCH`/archive in the registry, answers and the batch, team pause/resume/run, sprint commands, snooze, owner
requests) calls `projectOwnerRefusal` after `findProject`: the identity must be an `owner` of the project's account
(403 `account-owner-only` for a member, and for the Access owner on an account its linked user is merely a member
of); the service identity keeps its own gates. `scopeOf(identity, env)` (`auth/scope.ts`): a user its account ids, the local bypass and the service identity
the owner account, a job its own slug, anything else nothing. `routeScopeMiddleware` (after `jobScopeMiddleware`)
answers 404 `not-found` for a path `ROUTE_SCOPES` does not list and refuses an identity whose scope cannot hold the
rule (`project` | `projects` | `account` | `own-user` | `operator` | `runner` | `public`); `route-scope.spec.ts`
walks `app.routes`, fails on an unlisted route, and proves for every `project` route that a user of another account
is answered exactly as for a slug that does not exist. `GET /api/v1/accounts/:id/{settings,members,audit}`
(`routes/accounts.ts`): owner-of-account; a non-member (the service identity included) 404 `account-not-found`, a
member 403 `account-owner-only`. `POST /api/v1/projects` creates in the caller's one owner membership (several:
`accountId` in the body, which must be one of them; else 403 `account-owner-only`), links the installation to that
account first (`InstallationsRepo.link`; another account's → 409 `installation-other-account`), records
`projects.repo_id` from `GET /repos/{repo}` and audits `project.created` (`details`: ids only); a lost race answers
409 `slug-taken` | `repo-taken` (the 0018 trigger mapped in `ProjectsRepo.create`, never a 500); `GET …/setup`
backfills `repo_id` once for rows registered before 0018; update and archive audit `project.updated` (field names)
and `project.archived`. Hooks (`routes/github.ts`): a repository delivery is routed by `repository.id`
(`findActiveByRepoId`; a row with `repo_id IS NULL` is matched by name and its registered installation once, which
records the id — after the account invariant below passed, since the id is permanent), then refused unless the
row's installation is the delivery's and `installations.findLinked` names the row's account (`ignored:
installation-mismatch`); installation events touch the linked account's rows only and match a repository by the id
the payload carries (`RepositoryMatch`: by name only for a row whose `repo_id` is still unset).
Runners (#467, ADR 0008 row 2-A, migration `0021_runners`: `runners` with `account_id`, `name`, an Ed25519 public
JWK only, `host`, `capabilities`, `hosted`, `isolation` (`container|user|actions-ephemeral|none`), `allowed_projects`,
`version`, `pinned_version`, presence and detection columns; `runner_enrolments` (code hashes, single use by trigger);
`runner_nonces` (`jti` replay); `role_keys` (empty until 2-C; migration `0023_role_key_guards` #492: identity kept,
revoked once, never replaced — also not by `INSERT OR REPLACE` on the live runner+role —, no live key for a revoked
runner, and revoking a runner revokes its live role keys by trigger; never deleted, `0024_role_key_delete_guard` #522); `rate_limits` (fixed-window D1 counters)). The runner's
door is `auth/runner-auth.ts`, taken by `authMiddleware` for every `/api/v1/runner/*` path before anything else: an
EdDSA runner JWT in `Authorization` alone mints `{kind: 'runner', runnerId, accountId, allowedProjects, isolation,
capabilities}` — signed by the enrolled key, `sub` the runner id, `aud` `team-console:<ENVIRONMENT>`
(`runnerAudienceOf`), `exp` ≤ 5 min after `iat`, `jti` consumed into `runner_nonces` (401 `runner-jwt-missing|invalid|
expired|replayed`, `runner-revoked`; 429 `rate-limited` past 120 calls per runner per minute); no Access header,
cookie or local bypass is read there (Access in front of dev/stage is the edge's perimeter, optional for customers).
Every accepted call is a sighting (`RunnersRepo.sight`: `last_seen_*`, `seen_countries`; a call from a new
`CF-IPCountry` or a second source-address hash inside five minutes marks the runner suspect once with a `runner.suspect`
audit row — threat model C4 detection; the push follows when subscriptions are per account, T-4). `POST
/api/v1/runner/enrol` (`routes/runner.ts`, rule `enrolment`: no identity, CSRF-exempt like the bearer kinds) takes the
one-time code (`tce_` + 43 base64url characters, SHA-256 in D1, compared in constant time, 10 minutes, used once by the
0021 trigger; one 401 `enrolment-code-invalid` for malformed, unknown, expired and used; 10 attempts per source
address and 300 per environment per minute from `rate_limits`, since a WAF rule cannot apply on workers.dev) plus the
runner's public JWK, host, capabilities, backend and version — the name and `allowed_projects` are the owner's from the
code; `none` is 422 `runner-isolation-none` on production. `GET /api/v1/runner/release` names `RUNNER_RELEASE_VERSION`/
`RUNNER_MINIMUM_VERSION` (vars). Owner-of-account routes (`routes/account-runners.ts`, rule `account`): `POST
/api/v1/accounts/:id/runners/enrolment-code` (`{name, allowedProjects}`; 422 `allowed-projects-invalid` for a slug that
is not an active project of this account), `GET …/runners` (`RunnerDto`: no key material), `PATCH …/runners/:runner`
(`allowedProjects`, same check), `POST …/runners/:runner/revoke` (409 `runner-revoked` twice), `POST
…/runners/:runner/clear-suspect` (#492; 409 `runner-not-suspect` | `runner-revoked`; audit `runner.suspect-cleared`),
`RunnerListDto.pendingEnrolments` (unused, unexpired codes: `id` is the code's SHA-256, never the code) and `POST
…/runners/enrolment-codes/:enrolment/withdraw` (#492; deletes the pending row, 204; one 404 `enrolment-not-found` for
malformed, foreign, used, expired or gone; audit `enrolment-code.withdrawn`) — both writes conditional, the audit row
on `changes()` (`auditedWrite` in `audit.repo.ts`, #522: the write and its audit row as one adjacent pair, the only way to the `changes()` condition, which `enrol` uses too); another account's runner id is 404 `runner-not-found`. A runner's scope (`scopeOf`) is its `allowed_projects` inside its own account.
`newUlid`/`sha256Hex` live in `@worker/core`. The redactor masks `tce_` codes and the JWT; `runner.spec.ts` proves no
code, key or JWT reaches a log line.
Settings › Runners (#464, ADR 0008 row 2-E part A): `GET /api/v1/accounts` (rule `projects`: the caller's own
memberships with the role, from `membershipsOf` alone; none for the service identity) tells the console which account
to address; `RunnerListDto.release` (`runnerReleaseOf(env)`, shared with `GET /runner/release`) and
`RunnerDto.belowMinimum` (`isRunnerVersionBelow`: SemVer precedence, a non-SemVer label counts as below) flag a runner
under `RUNNER_MINIMUM_VERSION`. Console: `@console/entities/runner` (`RunnersApi` — every answer through its guard
in `@shared/contracts`, failures through `runnerFailureOf`/`runnerFailureKeyOf`; `RunnersStore`, in memory only, the
first owned account, `forbidden` for a member or no account; `RunnerCard`, `RunnerProjectsPicker`, `runnerFixture`),
`@console/features/enrol-runner` (the code lives in the dialog only; the command is `enrolCommandOf`, `null` for
anything that could carry a shell metacharacter), `@console/features/manage-runner` (allowed projects, revoke behind a
danger confirm; #492: clear a suspect mark behind a confirm, withdraw a pending code from the page's pending list), `@console/features/runner-policy` (`RunnerPolicyEditor` per account or project scope; `PUT null`
returns a project to the account default; a saved account default bumps the project editor's `revision`, which
refreshes its summary and keeps unsaved edits); page `/settings/runners` in `console-pages-settings` (lazy). The e2e
stack sets `RUNNER_RELEASE_VERSION`/`RUNNER_MINIMUM_VERSION` (0.3.0/0.2.0) for `runners.e2e.ts`. The runner's own
paused/usage-limit state is not shown yet: the runner reports none until 2-B.
Run now and the job view (#464 part B): on a console-tracker project (`isOnConsoleTracker` in `@console/entities/project`:
`cutover|console`) the board's "Run log" tile and runs section read `GET …/jobs` instead of the GitHub run log
(`SprintBoardProject.isOnConsoleTracker`; a GitHub project's board is unchanged and reads no jobs). `@console/entities/job`
(`JobsApi` — answers through `isJobDto|isJobListDto|isJobEventListDto` in `@shared/contracts`, failures through
`jobFailureOf`/`jobFailureKeyOf`, 409 `job-exists`/`tracker-not-cut-over` worded apart; `JobsStore`, provided by the
board, polls every 10 s with a job live and every 60 s otherwise, only while the page is visible, events incrementally
for held jobs; `jobsTileOf`; `JobCard`, runner text interpolated as one plain line via `withoutInvisibles`),
`@console/features/run-now` (`RunNow`: `RUN_NOW_KINDS`, the kinds the API runs from the kind alone). Runner names come
from `RunnersStore` (a member sees a short id).
Jobs and job tokens (#467, ADR 0008 row 2-A part 3, migration `0022_jobs`: `jobs` (ULID id, `account_id` copied from the
project and kept equal by trigger, `kind`, `role`, `payload` (`items`), `state` with final states kept by trigger,
`dedupe_key` unique while live, `dispatch`, `runner_id`, `token_hash`, `attempt`, lease and timing columns, the hosted
and Actions columns for H-2/2-B), `job_events` (append-only, `seq` per job, ≤ 16 KB payloads, 5000 per job),
`team_state`, `projects.runner_policy`, `accounts.default_runner_policy`). Owner routes behind the matrix (`routes/jobs.ts`):
`POST /projects/:slug/jobs` (Run now; `{kind, items?, needsLocal?, maxMinutes?, role?}`; 409 `tracker-not-cut-over` on a
GitHub project, 409 `job-exists` while a slot job of that kind is live — no `Idempotency-Key`, the dedupe key is the
replay guard; audit `job.dispatched`), `GET …/jobs[?state=&after=&limit=]`, `GET …/jobs/:id`, `GET …/jobs/:id/events`
(reads for the owner, a member and the project's own job), `GET|PUT …/runner-policy` and `GET|PUT /accounts/:id/runner-policy`
(ADR 0008 decision 12: `{mode: any}` | `{mode: pinned, runner}` | `{mode: failover, preferred, fallback, offline_after_seconds}`,
`checkRunnerPolicy`; a policy naming a runner that is not an unrevoked runner of the account is 422 `runner-policy-invalid`;
audit `runner.policy-changed`). `POST …/team/pause|resume` on a console-tracker project writes `team_state` (`TeamStateDto`,
409 `team-already-paused|team-not-paused`, audit `team.paused|resumed`; the write is conditional on the state and the
audit row on `changes()`, so of two racing requests one wins and the other is 409, #492) instead of the GitHub run log. Runner routes
(`routes/runner-jobs.ts`, rule `runner`): `POST /runner/jobs/claim` first requeues lapsed leases (`JobsRepo.requeueLapsed`:
once back to `queued` with a `notice`, the second lapse `lost` with a `failed` event and a streak count), then
`JobsRepo.claim` — one UPDATE whose subquery holds `jobs.account_id = runner.account_id`, the runner's `allowed_projects`,
no suspended account or archived project, `team_state.paused_at IS NULL`, `needs_local` vs `capabilities.local`, and the
policy (`COALESCE(projects.runner_policy, accounts.default_runner_policy)`: `any`, `pinned` to this runner, `failover`
as the preferred or as a fallback while the preferred is revoked or silent past `offline_after_seconds`) — 200
`{job, jobToken (tcj_ + 43 base64url, SHA-256 in jobs.token_hash), leaseSeconds: 300}` or 204 `Retry-After: 60`; a `none`
runner is 403 `runner-isolation-none` on production; audit `job.claimed` with the country. `POST …/jobs/:id/heartbeat`
(extends the lease), `…/events` (`{events: [{level, kind, payload}]}`, ≤ 50 per batch, every string through the shared
redactor in loose mode, `started` marks the job running), `…/finish` (`{result: finished|failed, summary, metrics?, acted?}`;
the token dies; audit `job.finished`; `TeamStateRepo.recordOutcome` counts the streak and the third failure in a row
pauses the project as `system:failure-streak`, resume clears it) — another runner's job is 404 `job-not-found`, a done one
409 `job-finished`, a lapsed lease 409 `job-lease-expired`. The job identity (`auth/job-auth.ts`, R4): `Authorization:
Bearer tcj_…` only together with the claiming runner's JWT in `X-Runner-Jwt` (401 `job-runner-missing`, the runner door's
401/429, 401 `job-token-invalid`, 403 `job-runner-mismatch`, 401 `job-lease-expired`); it mints `{kind: 'job', source:
'token', role, projectSlug, jobId, items}` from the job row, valid in every environment, while the local stand-in
(`source: 'stand-in'`) stays bypass-only; its scope is the job's project (`jobScopeMiddleware` confines it to the matrix).
Revoking a runner cancels its live jobs in the revoke batch (`JobsRepo.cancelForRunnerStatements`). `runner-jobs.spec.ts`
proves the two-account claim, the allow-list, the pause, every policy mode, the lapse and streak, and that no job token
reaches a log line. Deferred from the row: `POST /runner/oidc-exchange` (no dispatcher before 2-B PR 4 / owner decision 9)
and the orchestrator's pause (plugin 0.12).
`pull_requests` (#463) under the same scope: `PullRequestsRepo.upsert`/`markCiStale` write only when the write's
repository id equals the project's recorded `repo_id` (a row without one takes nothing — fail closed; the hooks
Worker backfills it from a matching delivery, the api Worker through `ensureRepoId` before a sync, 409
`repo-id-unknown` when the provider's id is another project's); `refOf` passes `repo_id` as the `RepoRef.externalId`,
so the adapter refuses a name that now points elsewhere; `?fresh=1` (and the first read of a number the console does
not hold) is the account's — a job gets 403 `fresh-role` and the rows D1 holds.

Runner (`apps/runner`, ADR 0008 row 2-B, #568–#572; operator guide `docs/runbooks/runner.md`): a Node 22 CLI bundled to
one file with no runtime dependency (`bundle.spec.ts`) — `install`, `enrol`, `run-once`, `run --loop`, `update`,
`version`. State lives in `TC_RUNNER_HOME` (`config.json`, `keys/`, `credentials/`, `state.json`, all 0600 under a
home only its user may write); backends `user` (macOS job user via the one sudoers rule to `bin/job-exec`),
`container` (one `--rm`, read-only container per job, image pinned by digest) and `none` (fixtures). Releases come
only from `.github/workflows/release-runner.yml` on a `v*` tag (owner-only by ruleset; the `release` environment; no
secrets): per-platform tarballs with `SHA256SUMS` and build-provenance attestations, the GHCR image signed with cosign
keyless. The identity a release must carry is compiled into the binary (`apps/runner/src/update/release-identity.ts`;
changing the repository, workflow path or ref shape is a security change) and `update` delegates the check to
`gh attestation verify`; it refuses without `gh`, on a failed verification, a lower version, one below the console's
`minimumVersion`, or `config.update.policy = off` (`update.spec.ts`). `TC_RUNNER_VERSION` stamps the version at build
time (`build.mjs`). No agent pushes a `v*` tag or runs that workflow.

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
`stack.reset()` / `seed()` for a fresh database; logs in `tmp/console-e2e/worker-<workerIndex>/` (one directory per Playwright worker process, cleared once per run; each `wrangler dev` lifetime is appended between `===` marker lines, wrangler's own debug log sits beside it as `*.wrangler-debug.log`, and a test fails with the reason when a stack server crashed or exited while it ran, #230). `E2E_PORT_BASE=<port>` packs each worker into three ports from there (api, fake GitHub, fake push; inspectors on system-picked ports) for runs beside other local stacks. Specs live in `src/*.e2e.ts`, find
controls through `ru()` (the ru.json copy) and `data-testid`, wait on conditions only, and fail on any request off the
app origin, any uncaught page error and any serious/critical axe violation (`expectAccessible`). `BASE_URL` (+
`CF_ACCESS_CLIENT_ID/SECRET` for stage) runs the suite against a running target; specs that reset data or need the
fake GitHub skip themselves there, `smoke.e2e.ts` is the read-only part. The Access token (#142,
`support/access-headers.ts`) reaches the target's origin only — never `extraHTTPHeaders`: a context route fetches each
target request itself with no redirect followed, and the `request` fixture adds it per call (`page.request` carries
none, so a spec for such a target uses `request`); with the token set the run keeps no trace and no HTML report, and
`tools/workspace-checks` fails on any workflow job with the token or a `BASE_URL` that uploads an artifact.
Worker tests run in workerd through `@cloudflare/vitest-pool-workers` (`SELF.fetch`, an isolated in-memory D1
migrated in `src/test-setup.ts`); `apps/api/test-assets` stands in for the Angular build. `wrangler`,
`@cloudflare/vitest-pool-workers` and `compatibility_date` move together (one workerd for dev, Docker and tests) —
one exception (#230): `wrangler` is 4.130.0 for `wrangler dev` (e2e, Docker, `nx build`), the first release where a
dropped dev-proxy connection no longer kills the dev server, while `@cloudflare/vitest-pool-workers` 0.22.0 (the
latest release) keeps its own nested wrangler 4.124.0 and `deploy.yml` still pins 4.124.0. Realign when a pool
release catches up.
