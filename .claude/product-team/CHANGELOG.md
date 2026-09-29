# Changelog

Products follow the `stable` channel (or a pinned tag, `team.plugin_ref` in `.product-team/project.yml`): the
first `slot-pm` of the day runs `vendor self-update` and opens a PR with the entries in between. Breaking changes (a renamed label, a changed script contract, a new required
`project.yml` key) are marked **Breaking** with the migration step.

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
