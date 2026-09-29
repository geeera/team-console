# Workflow: branches, backlog, approvals

Every role and skill follows this. Source: SPEC decisions 1, 4, 5, 14, 16.

## Branches and release

```
feature/<issue>-<slug> ──PR──▶ dev ──cut 2 days before demo──▶ stage ──owner go at demo──▶ main
                                          fix/<issue>-<slug> ──PR──▶ stage (freeze only)
                                                             hotfix/<issue>-<slug> ──PR──▶ main (P0/P1 in production)
```

- Every change arrives as a PR. **Never push directly to `dev`, `stage` or `main`** — private repos on the
  free plan have no branch protection, so this rule is enforced by you, not by GitHub.
- `feature/*` → `dev`: merge only through the **review gate** (`scripts/pr gate`, enforced by `scripts/pr merge`):
  CI green plus the verdicts the PR needs (see [Review gate](#review-gate-proportional-reviews)): `QA: APPROVED`
  from `qa` and `REVIEW: APPROVED` from `reviewer` as `review:` in `project.yml` requires them, and
  `SECURITY: APPROVED` from `security` whenever `scripts/pr security-check` finds auth, data, payment, upload,
  secret, dependency or CI changes.
  Every verdict must be on the current head commit. The orchestrator merges (squash) and moves the issue
  `status:qa` → `status:done`; the developer who wrote it never does. Branch operations (stage cut, release,
  back-merges) and the self-update PR merge with `--ci-only`.
- `stage` is cut from `dev` two days before the sprint milestone's due date (the demo). After the cut only
  `fix/*` PRs targeting `stage` are allowed; each fix is back-merged `stage` → `dev` by a PR.
- `stage` → `main` only after the owner answered **go** on the demo page. The merge PR links the demo issue.
- **Hotfix**: a P0/P1 defect live in production (`in-production`) goes `hotfix/*` from `main` → PR to `main`,
  released without waiting for the demo, then back-merged to `stage` and `dev` (the `hotfix` skill). Rolling back
  is also a PR. The owner is told at once and may override.
- **Stay current before review**: a PR that is behind its base or has conflicts is brought up to date by merging
  the base into the PR branch (no force-push) and re-running CI before QA looks at it. Conflicts in generated
  files are resolved by re-running the generator, never by hand.
- **Branch guard**: `templates/workflows/branch-guard.yml` opens a `sev:critical` issue for the owner whenever
  `dev`, `stage` or `main` moves without a merged PR or is force-pushed — the after-the-fact substitute for
  branch protection.
- Deploys happen only from GitHub Actions: `dev` → dev environment, `stage` → stage environment, `main` →
  production. Agents never call provider CLIs or SSH.
- Forge is GitHub. GitLab-hosted projects are local-mode only (the cloud network cannot reach gitlab.com).
- **Commit and push through the scripts** (`PR` = `.claude/product-team/scripts/pr`): commit with
  `PR commit -m "…" [git commit args]`, push with `PR push [--branch B]` — never a bare `git commit`/`git push`.
  With the team GitHub App configured (`reference/identities.md`) they commit and push as the team's bot
  instead of the owner's account; without it both behave like plain git. `pr push` never forces and pushes only
  team branches: `feature/`, `fix/`, `hotfix/`, `chore/`, `backmerge/`, `revert/`, `design/`, `docs/`.

## Review gate: proportional reviews

Reviews cost a slot and a rework round each; they are sized to the change. `.product-team/project.yml`:

```yaml
review:
  qa: always                 # always | code | never
  reviewer: code             # always | code | never; code = only when the PR changes a path in code_paths
  code_paths: ["apps/**", "libs/**"]
  max_rework_rounds: 1
```

- `pr gate` reads the block from the PR's **base** branch (a PR cannot relax its own gate; a change to
  `project.yml` itself needs SECURITY). Without the block, QA and REVIEW are required on every PR (the behaviour
  before 0.10.2). SECURITY is never configurable: `pr security-check` decides it.
- `code_paths` are globs over repository paths: `**` crosses directories, `*` does not, a pattern without `/`
  matches a file name anywhere (`*.ts`), matching ignores case and a leading `./`. Brace sets (`{a,b}`),
  character classes (`[ab]`) and negation (`!x`) are refused, not guessed. A renamed file counts by its old path
  too. `code` without `code_paths` uses broad defaults (common source roots; source, script, infrastructure,
  markup, style and build-config files anywhere).
- `max_rework_rounds` is **guidance for the orchestrator** (`slot-qa`, `slot-dev`), **not enforced by the gate**:
  `pr gate` only reports it under `policy`; it never passes or fails a PR because of it.
- `pr gate` explains itself: `why` says for each of QA, REVIEW and SECURITY whether it is required and why;
  `policy` shows the rule in force. Start only the reviewers the gate requires.

**Review triage.** Only three things block a merge: a **real bug** (the change does something wrong for a user
or for data), a **real vulnerability**, or an **acceptance criterion that is not met**. Everything else — naming,
structure that works, a missing nice-to-have test, polish, a refactor idea — is approved and filed as a follow-up
issue (`kind:finding` with a severity, or `kind:chore`), linked in the verdict, instead of another round.
Reviewers list blockers first and mark each item `blocker` or `follow-up`. After `max_rework_rounds` rework
rounds a PR goes back only for a blocker that is still open; the remaining non-blockers become follow-up issues and
the PR merges.

**Evidence before review.** The developer runs the real flow end to end — the app started, the changed path
exercised as a user or client would (browser, API call, CLI run) — not only the unit tests, and pastes the evidence
into the PR body under **How it was verified**: the commands, the observed result (output, status codes,
screenshots for UI). For a change with runtime behaviour, QA treats missing evidence as an unmet criterion; docs,
CI or config-only PRs state how they were checked instead.

## Backlog = GitHub Issues, behind the adapter

Always go through `.claude/product-team/scripts/backlog` (see the `backlog` skill). Never call `gh issue`
directly from a slot skill — the adapter is what lets another tracker replace GitHub later.

- **Milestone = sprint.** Title `Sprint NN`, due date = demo day. Two-week sprints.
- **Status** (exactly one per issue):
  `status:proposed` → `status:approved` → `status:in-progress` → `status:qa` → `status:done`,
  plus `status:blocked` (waiting for the owner or an external dependency; the reason is the last comment).
- **Kind**: `kind:feature`, `kind:bug`, `kind:chore`, `kind:finding`, `kind:wow`, `kind:question`.
- **Severity** (bugs and findings): `sev:critical`, `sev:high`, `sev:medium`, `sev:low`.
  P0 = `sev:critical`, P1 = `sev:high`.
- **Flags**: `complexity:high` (architect note first), `architect-note` (the note is on the issue),
  `needs-design`, `design:awaiting-approval`, `design:approved`, `qa:changes-requested`, `foundation`,
  `security`, `ux-blocker`, `release-blocker`, `in-production`, `signature-moment`.
- **Tier** (set by the architect; picks the developer's model): `tier:light`, `tier:standard`, `tier:heavy`;
  `review-failed` and `tier-up` record failed review rounds (see `reference/schedule-and-models.md` → Tiers).
- **Agent**: `agent:<name>` sends the issue to a project-specific agent in `.claude/agents/<name>.md` (e.g. a
  Flutter developer) instead of `fullstack-dev`. The project owns those agents; `vendor` never touches them.
- **Design stages**: `ux-spec` (the UX spec and wireframe are on the issue) → `design:awaiting-approval` →
  `design:approved`.
- **Needs** (cloud runs never pick these up; they go to the owner's inbox): `needs:local` — needs a local
  machine such as a Mac; `needs:owner` — a payment, an account, a legal or product decision.
- **Team**: `team:inbox` (the owner's pinned to-do list), `team:run-log`, `team:paused`, `team:demo`,
  `team:guard`.

Status labels are prefixed (`status:*`) so they never collide with labels an adopted repository already uses.

## Approvals

| What | Where the owner answers | Default when silent |
| ---- | ----------------------- | ------------------- |
| Design of a task | Comment `/approve` or `/reject <why>` on the issue (link sent to the phone) | Stays `status:blocked`; **never auto-approved**. Blocks only that task. |
| Scope (which features exist) | Demo page | Proposed features stay `status:proposed` |
| Release go / no-go | Demo page | No-go |
| P0/P1 bug | No approval needed — fixed immediately; in production via `hotfix` | — |
| Any cost (paid plan, upgrade, domain) | Comment `/approve` on the `kind:question` issue | Work that needs it stops |
| Override of a release blocker | Written reason on the demo issue → recorded as a decision | Blocker stands |

Owner commands in issue comments are case-insensitive and must be written by the repository owner
(the repository's `owner.login`); commands from anyone else are ignored, and so is an owner comment anyone else
ever edited (`reference/identities.md`). Reactions are never approvals.

A command counts only as the **first word of a line** of the owner's own text (indented by at most three spaces,
one tab or non-breaking spaces): not inside a code block or inline code, a `>` quote or an HTML comment, and — in
same-account mode — not in a team comment. An owner comment that looks like a command but is not read as one is
listed by `backlog answers` under `ignored` with `kind: not_read` and the reason (`inside code/quote/comment`,
`starts with a team note header`, `indented 4+ spaces`, `not at line start`, `not a command word`), so a dropped
command is never silent; `kind: edited` marks the security case above. **Team comments** on issues start with a bold role
header — `**Architect note**`, `**PM grooming**`, `**UX spec**`, `**UI design**`, `**Security threat model**`,
`**QA finding**`, `**Developer note**`, `**DevOps note**`, `**Analyst note**`, `**Team note**` (the roles are listed
in `scripts/ptlib/commands.py`, `AGENT_NOTE_ROLES`) — or a script's `<!-- pt-… -->` marker. In same-account mode
agents post as the owner's login, so without the header a quoted `/approve` would read as the owner's; with the
team's GitHub App they cannot post as the owner, and the header does not affect parsing. Every agent starts each
issue comment with its header; write example commands in backticks.

## Findings and release gates

| Severity | When fixed | Blocks release? |
| -------- | ---------- | --------------- |
| Security Critical/High, UX blocker (core flow cannot be completed, data loss, a11y blocker) | Current sprint, no approval | **Yes** (`release-blocker`) |
| Medium | Next sprint, listed on the demo page | No |
| Low | Backlog | No |

A blocker found during the freeze makes the release **no-go automatically**. The owner may override with a
written reason; `demo-apply` records it as a decision.

Checks:
- CI on every PR: lint, tests, build, SAST, dependency audit, secret scan, a11y assertions inside e2e.
- QA review against OWASP ASVS/Top 10 for PRs touching auth, data access, payments or user input.
- Designer UX walkthrough of the key flows on `stage` once per sprint.
- Deep audit (security + a11y + performance + debt) once per sprint in the Saturday burn slot.

## Budget: $0

- Only free tiers. Any paid plan, upgrade, add-on or domain needs an explicit owner `/approve`.
- Hitting a free-tier limit stops **that** work: mark the issue `status:blocked`, open a `kind:question`
  issue explaining the limit and the options, continue with other work.
- GitHub Actions minutes (2,000/month on private repos) are budget: `concurrency` with
  `cancel-in-progress` on PR workflows, `paths` filters on expensive suites, no cron workflows without
  approval.
- Agents never see secret values. They reference `secrets.NAME` in workflows and ask the owner to create the
  secret through the owner checklist.
