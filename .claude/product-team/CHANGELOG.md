# Changelog

Products follow the `stable` channel (or a pinned tag, `team.plugin_ref` in `.product-team/project.yml`): the
first `slot-pm` of the day runs `vendor self-update` and opens a PR with the entries in between. Breaking changes (a renamed label, a changed script contract, a new required
`project.yml` key) are marked **Breaking** with the migration step.

## 0.10.1

- **Security: edited owner comments no longer count** (geeera/team-console#60). GitHub keeps a comment's author when
  someone else edits its body, so anyone with Issues write — the team app, the review app, a collaborator — could
  turn an old owner comment into `/go`, `/approve` or `/resume` and have it read as the owner's. Owner statements
  (`backlog answers`, `backlog reversals`, `demo-page decisions`, the run log's `/resume`, "done" reports) now count
  only when nobody but the owner ever edited them, checked against GitHub's edit history (GraphQL
  `userContentEdits`, `lastEditedAt` + `editor`). Anything edited by another login, by a deleted account, or with
  more history than can be checked is ignored; when the history cannot be fetched only comments the REST timestamps
  show unedited count.
- `backlog answers` adds `ignored` (owner comments with a command that do not count, and why), `done` (verified
  "done" reports; `slot-pm` reads these instead of any `<!-- pt-owner-done -->` comment), `body` (whether the issue
  body is the owner's own words, and who edited it when) and `history_error`. `backlog show` marks edited comments.
- The run log trusts run entries and pause records only when no one outside the team edited them (a pause record
  holds the routine prompts `resume` re-creates). `runlog start` answers `unverified` (exit 3, do no work) when the
  edit history cannot be read — **Breaking** for custom run protocols: treat `unverified` like `paused`.
- The checked text comes from the same GraphQL read as its edit history (REST body only as the fallback), and a
  comment REST shows edited but GraphQL does not is ignored. An edit GitHub reports without history entries counts
  as unchecked. GitHub Enterprise Server without `fullDatabaseId` is read by comment URL instead of failing.
- Team decisions are dated only by decision comments of the team's logins that nobody else edited (`backlog
  reversals`, `brief`), so another Issues writer cannot bury an owner `/reject` under a newer marker. `backlog
  decide` refuses while such a reversal is open unless given `--handles-reversal <comment_id>`; `backlog comment`
  refuses decision markers. `reversals` entries carry `comment_id`.
- The run log is `team.run_log_issue` in `project.yml` (new key; kickoff/adopt write it), else the single
  `team:run-log` issue the team or owner opened; several candidates → every `runlog` command (and `brief`) refuses.
  **Migration**: add `team.run_log_issue: <number>` to `.product-team/project.yml` (`runlog url` shows it). Rotation
  is documented in `reference/schedule-and-models.md`. `brief` reads only the team's unedited run-log entries.
- Deleted owner commands: `runlog finish --acted ISSUE:COMMENT_ID` records the commands a run acted on; the new
  `backlog vanished [--days 30]` (once per run) lists any that were deleted since. `slot-pm` and `demo-apply` pass
  `--acted`.
- Decision comments count only when they start with the marker. `decide --handles-reversal` writes "Answers your
  /reject: <link>" into the decision, and `brief` lists such answers under `answered_rejects`.
- A labelled run-log issue opened by anyone else, or a pinned `team.run_log_issue` not opened by the team or the
  owner, makes the scripts refuse instead of opening a new log.
- Same-account mode is unchanged: the agents are the owner's login there, so their edits look like the owner's
  (`reference/identities.md`, "does not isolate"), and so is anyone holding the owner's credentials, including the
  team console's owner user token.

## 0.10.0

- **Agents on their own GitHub identities** (`reference/identities.md`): an optional **team app** every script and
  push acts as, and a **review app** only verdicts are posted as. Configure with `PT_TEAM_APP_ID` +
  `PT_TEAM_APP_KEY_FILE` / `PT_TEAM_APP_KEY` (base64 or raw PEM) and the same `PT_REVIEW_APP_*` variables. The app
  JWT is signed with the `openssl` CLI; installation tokens are scoped to the product repository and cached until
  shortly before they expire. `GH_TOKEN` / `GITHUB_TOKEN` / `gh auth token` and `PT_REVIEW_TOKEN` keep working when
  no app is configured; a half-configured app is an error, never a silent fallback to the owner's token.
- The app JWT is signed with the `openssl` CLI; an inline key reaches openssl through a pipe and never touches the
  disk; `*_KEY_FILE` paths expand `~`. Processes the scripts start (git, openssl, gh) never inherit
  `PT_*_APP_KEY*`, `PT_OWNER_TOKEN` or `PT_REVIEW_TOKEN`.
- `pr gate` / `pr merge`: with the review app configured only its bot's verdicts count; the gate fails when the
  review bot is the team bot (also caught when the two ids are a numeric id and an `Iv…` client id of one app) or
  when `team.reviewer_logins` lists the team bot. `team.reviewer_logins` is read from the PR's base branch, accepts
  `name[bot]` logins (quote them) and rejects anything that is not a GitHub login. The same-account warning appears
  only when it is same-account.
- Owner answers: only the owner's own comments count. With the team app, `backlog answer` (team chat) posts with a
  dedicated `PT_OWNER_TOKEN` of the owner (never `GH_TOKEN`/`GITHUB_TOKEN`/`gh auth`) and refuses without it.
  `same_account` stays true (fail closed) in any session holding a credential that resolves to the owner.
- `pr commit -m … [git commit args]` commits as the team app's bot (nothing is committed if the bot cannot be looked
  up; `--author` is refused); plain `git commit` without the app. `pr push [--branch B]` pushes only `feature/`,
  `fix/`, `hotfix/`, `chore/`, `backmerge/`, `revert/`, `design/` and `docs/` branches, never forced, straight to
  `https://github.com/<repo>.git` as the app: the token only in `GIT_CONFIG_*` env (never argv, `.git/config` or
  output), global/system git config ignored, repository-local `insteadOf`/`pushInsteadOf` rewrites refused. Where
  only a session git proxy reaches GitHub it fails loudly instead of falling back. Plain `git push -u origin B`
  without the app. Developers, designers, devops, `slot-pm` (self-update) and `slot-qa` commit and push through
  them.
- The run log accepts entries from the team bot on a log opened by the owner, so switching keeps its history.
- Migration (optional): create the two apps and set the variables per the owner checklist; add
  `'<product>-review[bot]'` to `team.reviewer_logins`.

## 0.9.3

- Designs are published by `design-pages.yml` (GitHub Actions → Pages) from `docs/design` after a PR is merged;
  designers commit prototypes and wireframes by PR and never push to `gh-pages` (the first team-console run was
  rightly stopped from doing that).

## 0.9.2

Found in the first scheduled run on geeera/team-console.
- Scripts no longer write `__pycache__` into the product repository (cloud sessions flagged it as untracked and
  spent turns deleting it); the vendored copy also carries its own `.gitignore`.
- `backlog edit N --title/--body-file`: grooming can fix an issue's title and criteria in place instead of adding
  comments; a question's answer line is preserved.

## 0.9.1

- `backlog label N -name` removed nothing and failed: argparse read `-name` as an option. Label removal works again
  (it is used by slot-pm, slot-qa and the design flow).
- A missing `--body-file` is a clear error instead of a traceback.
- Decision policy: tasks only the owner can do are `kind:chore` + `needs:owner` (answered "done"), not questions.

## 0.9.0

- **Team chat** (SPEC decision 17): the owner talks to the team in one pinned Claude Code session per product
  instead of GitHub issues. "What's new" gives a briefing of what changed since last time and walks through the
  owner's decisions one at a time; plain answers ("да", "нет, потому что…") are written as the commands the team
  reads, marked as given in the chat; requests for work become issues. `team-chat` skill, `scripts/brief`,
  `backlog answer`. `kickoff` and `adopt` walk the owner through creating the chat; the digest points to it.
- Answers are typed by item: questions and designs take approve/reject, the demo issue go/no-go/override, action
  items (accounts, secrets, local work) only "done" — never an approval. Each answer quotes the owner's words, is
  written on one line (no smuggled commands), and only on an open item waiting for the owner. Scheduled runs never
  call `backlog answer`. The briefing counts runs that died as failed and marks up to the brief the owner heard.

## 0.8.0

- **Decision policy** (`reference/decision-policy.md`): the owner decides only money, scope, release, access,
  legal and design approvals. `backlog create --kind question` requires `--owner-category` and `--ask` (the answer
  line, first in the issue) and refuses anything else; `backlog decide` records a team decision (`team-decided`,
  FYI in the digest, reversible with `/reject`); `backlog ask` fixes existing questions. `slot-pm` re-triages open
  questions and closes the team's own.
- **Daily digest to the phone**: `owner-digest.yml` + `scripts/digest` send the pinned inbox through Telegram or ntfy
  every morning, and at once on demo day. Needed because GitHub never notifies you about comments made with your
  own account — which is how the agents write.
- **Inbox**: answer line per question, "Decided by the team (FYI)", owner language (`owner.language: ru`).
- `backlog reversals`: team decisions the owner answered with `/reject`; `slot-pm` reopens them.
- `scripts/workflows run FILE`. New labels `owner:*`, `team-decided`. Run `backlog init` once; add
  `owner-digest.yml` and one digest channel (owner checklist).
- **Breaking** — `backlog create --kind question` now requires `--owner-category` and `--ask`. Existing questions
  keep working; `slot-pm` adds the answer line to the ones that stay the owner's.

## 0.7.0

- **Pause and resume by asking.** `pause` (the owner says "pause development") switches off this repository's
  routines and scheduled workflows (e.g. Renovate), labels the run log `team:paused` and records exactly what was
  switched off; `resume` ("продолжим") switches that back on, re-creates a routine deleted meanwhile, proposes a
  new sprint when every sprint is in the past, and lifts the pause. Routines are disabled, not deleted — the API
  cannot delete them, and disabled routines use no quota.
- `runlog pause | pause-record | resume`, `scripts/workflows list | disable | enable`.

## 0.6.0

Fixes from the storify security review (geeera/storify#89–#92) and two REVIEW findings.

- **Self-update is verified against git, not trusted.** `pr merge --ci-only` on a `chore/product-team-*` PR fetches
  the PR head (it must equal the sha being merged), diffs its tree from the merge base, fetches the plugin commit
  named in the manifest, reads the version from that release's `plugin.json`, requires the tag `v<version>` to
  point at it, requires it to be newer than the installed version (and equal to a pinned `plugin_ref`), and then
  requires every changed path to be a regular file with exactly the release's blob and mode. Files only the old
  install had may only be deleted; `.claude/settings*.json` anywhere is never accepted. Branch operations also
  require the head branch to live in this repository.
- **`security-check` covers agent tooling and gate config**: any `.claude/` directory, `.product-team/project.yml`,
  `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `CODEOWNERS`.
- **`reviewer_logins` accepts YAML block lists** (`- login`); a value that cannot be read now fails the gate
  instead of silently accepting every account.
- When the agents' account cannot be identified, the team assumes it is the owner's (same-account mode).
- **Same-account mode is visible**: `backlog answers` and `pr gate` report it, the inbox keeps a "Security setup"
  item, and a release **go** is then taken only from the demo page or a comment older than the run.
- **Reviewer token**: `pr review` posts as `PT_REVIEW_TOKEN` when present; the owner checklist describes the
  reviewing account and a separate cloud environment for `slot-qa`.
- **Untrusted content**: the run protocol and every agent treat issue/PR text, logs and web pages as data.
  `pm` reads the web and so no longer edits files.
- Self-update PRs must be named `chore/product-team-<version>` and contain only generated files; migrations that
  touch anything else go in a separate reviewed PR.

## 0.5.0

- **Tiers**: the architect sizes every approved issue (`tier:light|standard|heavy`) in `slot-pm`; `backlog next`
  sends it to `fullstack-dev-light` (Sonnet 5), `fullstack-dev` (Opus 5.5) or `fullstack-dev-heavy` (Fable 5.1).
  Guard rails in code: default `standard`; no `light` in the burn window or hotfixes; two failed review rounds
  raise the tier; security-labelled work never on Fable; product specialists keep their own model.
- `sprint-metrics` reports planned, shipped and raised issues per tier.
- New labels `tier:light`, `tier:standard`, `tier:heavy`, `review-failed`, `tier-up`. Run `backlog init` once.

## 0.4.0

- **Team**: `ux-designer` and `ui-designer` replace `designer`; new `reviewer` (code quality, Sonnet) and
  `security` (OWASP, threat models, deep audit, Opus); `qa` keeps acceptance, accessibility and polish.
- **Review gate in code**: `pr gate` / `pr merge` require CI plus `QA:` and `REVIEW:` approvals on the current
  head, and `SECURITY:` when `pr security-check` finds sensitive paths, dependency or CI changes, or a `security`
  label. Branch operations and the self-update PR use `pr merge --ci-only`.
- **Product specialists**: `agent:<name>` routes an issue to the project's own `.claude/agents/<name>.md`.
- New label `ux-spec`. Run `backlog init` once in each product.
- **Migration** — if the product has its own `.claude/agents/` files named `ux-designer`, `ui-designer`,
  `reviewer` or `security`, self-update stops and asks the owner (nothing is overwritten); rename them first.
- Optional `team.reviewer_logins` in `project.yml`: with a separate reviewing account, only its verdicts count.
- **Breaking** — `designer` is gone; self-update removes it. Open issues waiting on a design keep working (the
  next `slot-pm` starts them at the UX step).
- `fullstack-dev` runs on Opus 5.5 in every mode; `fullstack-dev-senior` is removed (self-update deletes it from
  products). `backlog next` always names `fullstack-dev`.

## 0.3.0

- **Cloud runs load the team from the product repository.** `scripts/vendor install` copies agents, skills,
  scripts and references into the product's `.claude/`; cloud sessions load project agents and skills from the
  clone but never install plugins listed in `.claude/settings.json`. `vendor self-update` (first `slot-pm` of the
  day) opens a PR when the `stable` channel moves, so products pick up releases by themselves.
- **No `gh` CLI needed.** Scripts talk to the GitHub REST API with `GH_TOKEN`; new `scripts/pr` covers create,
  view, checks, diff, review, update-branch and merge (merge refuses unless CI passes).
- **Breaking** — in products the skills are `/slot-pm`, `/slot-dev`, `/slot-qa` (project skills), not
  `/product-team:…`. Migration: run `vendor install .` in the product, delete the `product-team` entries from its
  `.claude/settings.json`, point each routine at the product repository only with the new command.
- **Breaking** — `templates/claude-settings.json` is gone (it never worked for cloud runs).

## 0.2.0

- `backlog next`: the development plan is code with tests (`scripts/ptlib/picker.py`) — production defects,
  P0/P1 and release blockers first, then QA rework, then sprint work up to the cap; `needs:*`, unapproved
  designs and missing architect notes are skipped with a reason.
- `hotfix` skill: P0/P1 in production goes `hotfix/*` → `main`, independent QA, back-merge to `stage` and
  `dev`; rollback is a PR or a manual deploy of the previous ref.
- `inbox`: one pinned "Needs you" issue, rewritten by every run.
- Run log records duration and per-run metrics; `runlog stats` and `sprint-metrics` feed the demo.
- Templates: `branch-guard.yml` (an issue for the owner when a protected branch moves without a PR),
  `deploy.yml` (per-environment deploy, rollback trigger, smoke check); `reference/deploy-recipes.md`.
- PRs are brought up to date with their base before QA; conflicts in generated files are regenerated.
- New labels: `architect-note`, `qa:changes-requested`, `needs:local`, `needs:owner`, `in-production`,
  `team:inbox`, `team:guard`. Run `backlog init` once in each product to create them.
- The plugin repository has CI: unit tests and static checks of agents, skills and manifests.

## 0.1.0

- First release: role agents, slot skills, backlog adapter, run log, slot context, demo page.
