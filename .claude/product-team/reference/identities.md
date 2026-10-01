# Identities: the agents on their own GitHub Apps

Out of the box the agents act as the owner's GitHub account (**same-account mode**). That works, but two things
only hold by convention:

- a verdict in the merge gate (`QA:`, `REVIEW:`, `SECURITY:`) is a comment by the same account that wrote the code,
  so the gate cannot tell a reviewer's approval from a developer approving itself;
- an owner command (`/approve`, `/go`, …) is a comment by the owner's account, so an agent could write one — or
  edit an old comment of the owner's into one: GitHub keeps the original author on an edited comment.

Two GitHub Apps give the agents identities of their own. GitHub then records who wrote what, and the scripts check it.

## The two apps

| App | Used by | Writes as | What it unlocks |
| --- | ------- | --------- | --------------- |
| **Team app** | every script and every push (`gh.token()`, `pr push`) | `<team-slug>[bot]` | owner commands count only from the owner's login; commits, issues and PRs are visibly the team's; GitHub notifies the owner about the team's comments |
| **Review app** | `pr review` (verdicts) | `<review-slug>[bot]` | `pr gate` / `pr merge` count only verdicts by this bot |

Permissions (repository permissions; everything else "No access"; Metadata read-only is added by GitHub):

| Permission | Team app | Review app |
| ---------- | -------- | ---------- |
| Contents | Read and write | Read |
| Issues | Read and write | Read and write |
| Pull requests | Read and write | Read and write |
| Workflows | Read and write | — |
| Actions | Read and write | Read |
| Checks | Read | Read |
| Commit statuses | Read | Read |

Workflows write lets the team change `.github/workflows/` by PR; Actions write lets it pause and trigger workflows
(`scripts/workflows`). The scripts use the review app only for review comments today; its Issues write keeps a
reviewer able to comment its findings on the issue.

## Create them (owner, once per product, ~10 minutes)

For each app: GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.

1. Name: e.g. `<product>-team` and `<product>-review` (the slug becomes the bot login `<slug>[bot]`). Homepage URL:
   the repository URL.
2. Webhook: untick **Active** — nothing listens for events.
3. Repository permissions: the table above. Where can it be installed: **Only on this account**.
4. Create, note the **App ID** (About section), then **Generate a private key** — a `.pem` file downloads.
5. **Install App** → your account → **Only select repositories** → the product repository. Nothing else: a token
   is scoped to the one repository anyway, but an installation on other repositories is a standing grant.
6. Put the review bot's login in `.product-team/project.yml`, so sessions without the review key still know which
   verdicts count:

   ```yaml
   team:
     reviewer_logins: ['<product>-review[bot]']   # quote it: [bot] is YAML flow syntax
   ```

   Only the **review** bot belongs there (or a separate reviewing machine account) — never the team bot, your own
   login or anyone who writes code. Sessions without the team app's key cannot tell which bot is the team's, so
   the gate cannot catch a team bot listed here; with the key it refuses it.

## Environment contract

| Variable | Meaning |
| -------- | ------- |
| `PT_TEAM_APP_ID` | team app id (numeric) |
| `PT_TEAM_APP_KEY_FILE` **or** `PT_TEAM_APP_KEY` | path to its `.pem` (`~` is expanded), **or** the PEM itself — base64 (one line, for cloud env vars) or raw |
| `PT_REVIEW_APP_ID` | review app id; must be a different app (checked by bot login, so a numeric id and an `Iv…` client id of one app are caught too) |
| `PT_REVIEW_APP_KEY_FILE` **or** `PT_REVIEW_APP_KEY` | as above, for the review app |
| `PT_OWNER_TOKEN` | only in the team-chat session: a fine-grained token of **your** account (this repository, Issues read/write) that `backlog answer` posts your answers with |

Precedence: `gh.token()` uses the team app when `PT_TEAM_APP_ID` is set, otherwise `GH_TOKEN`, `GITHUB_TOKEN`,
`gh auth token` as before. `gh.review_token()` uses the review app, otherwise `PT_REVIEW_TOKEN` (a reviewing machine
account), otherwise none (verdicts go out with the team token). A half-configured app (id without key, bad key, app
not installed) is an error, never a silent fallback to the owner's token. In app mode your answers are posted only
with `PT_OWNER_TOKEN` — never with `GH_TOKEN`, `GITHUB_TOKEN` or `gh auth`, which may be in a session for other
reasons.

The app's JWT is signed with the `openssl` CLI (present in macOS and the cloud images). An inline key never touches
the disk: openssl reads it from a pipe handed to that one process. Installation tokens live an hour; a script mints
one on first use and reuses it until five minutes before it expires. Scripts never print key material or tokens,
and the processes they start (git, openssl, gh) get an environment without `PT_*_APP_KEY*`, `PT_OWNER_TOKEN` and
`PT_REVIEW_TOKEN`.

## Local setup

```bash
mkdir -p ~/.config/product-team && chmod 700 ~/.config/product-team
mv ~/Downloads/<product>-team.*.pem ~/.config/product-team/<product>-team.pem
chmod 600 ~/.config/product-team/*.pem
export PT_TEAM_APP_ID=123456
export PT_TEAM_APP_KEY_FILE=~/.config/product-team/<product>-team.pem
```

Keep the review key out of your everyday shell; set it only where reviews run. To answer through the team chat,
also `export PT_OWNER_TOKEN=…` (your fine-grained token) in that shell only.

## Cloud setup (claude.ai/code environments)

Environment variables are single-line, so give the key as base64:

```bash
base64 < <product>-team.pem | tr -d '\n'     # paste the output as PT_TEAM_APP_KEY
```

- **Default environment** (routines `slot-pm`, `slot-dev`): `PT_TEAM_APP_ID` + `PT_TEAM_APP_KEY`. No review app, no
  personal token of yours (`PT_OWNER_TOKEN`, `GH_TOKEN`), no `gh auth` as you.
- **`reviewers` environment** (routine `slot-qa`): the team app **and** `PT_REVIEW_APP_ID` + `PT_REVIEW_APP_KEY`.
  Only this environment can post a verdict that counts. No personal token either.
- **Team-chat environment** (if the team chat runs in the cloud): the team app plus `PT_OWNER_TOKEN`. That session
  can write as you, so it reports `same_account: true` (below) — keep it separate from the scheduled environments.

Delete the downloaded `.pem` files once they are stored; rotate a key by generating a new one in the app's
settings and deleting the old one there.

## What changes for the team

- **Owner commands** count only when your login wrote them (`commands.parse`, the demo decisions block, reversals
  of team decisions, the `/resume` on the run log, "done" reports). A bot comment that quotes you is never read as
  your answer.
- **Edited comments**: GitHub keeps the author of a comment when someone else edits its body, and anyone with
  Issues write on the repository can — the team app, the review app, a collaborator, any other app with that
  permission. A comment of yours counts only if **nobody but you ever edited it**. The scripts read each issue's
  edit history (GraphQL `userContentEdits`, `lastEditedAt` + `editor`): a comment edited by any other login, by a
  deleted account, or with more edits than one page of history shows, is ignored, and `backlog answers` lists it
  under `ignored` with the reason. When the history cannot be fetched (`history: rest-only`, see below) only
  comments whose REST `updated_at` is exactly `created_at` (no slack: an edit made within any tolerance would
  count) count — **a comment you edited
  yourself included**, because REST cannot say who edited it; the rest are ignored, `history_error` says why, and
  the fix is always the same: write the command again in a new comment. The same check covers the issue body
  (`backlog answers` → `body.owner_statement`, and `body.edited_at`/`editors`: an approval given before someone
  else rewrote the question is an approval of the old text) and the team's own run-log entries and pause records
  (edits allowed only by the team's logins). Reactions are never read as approvals. The text that is checked
  comes from the same GraphQL read as its history (REST only as the fallback above), and when REST shows an edit
  that GraphQL does not, the comment is ignored as well.
- **Without GraphQL (Claude Code cloud sessions).** Cloud sessions answer every call to `api.github.com/graphql`
  with HTTP 403 ("GitHub GraphQL is not available from Claude Code sessions; use the REST API"), so the scheduled
  routines never have the edit history. The scripts notice the 403 once per process and run in REST-only mode
  (`history: rest-only` in `runlog start`/`finish`/`status`, `backlog answers` and `backlog vanished`): everything
  works, and the trust rule is the one above — unedited counts, edited does not, whoever edited. What that means
  in practice: the run log is append-only (`finish` adds a comment, so no team entry is ever edited); an entry
  that *was* edited supplies nothing — it never creates a run, never changes a run's start or slot, and only
  flags the run of the same id it postdates as `trusted: false`, which makes an ended run `unknown` (not a
  failure; it breaks a failure streak, so an old edited entry can never pause the team for good) and leaves a
  run still `started` in progress (the overlap guard holds); entries 0.10.2 and older edited in place are simply
  not runs here; an edited pause record is no record (`runlog pause-record` → `null`; pause again); an issue
  **body** is never an owner statement without the edit history (its `updated_at` moves with every label, so REST
  cannot clear it even when the timestamps happen to match): `body.owner_statement` is `false`, `body.body` is
  `null` and `body.reason` says so — a question's text is read from the issue, but approvals come only from
  comments. Pinning the inbox issue is a GraphQL mutation: in the cloud it is skipped with a warning and the
  issue is found by its `team:inbox` label instead.
- **Team decisions** are dated only by decision comments of the team's own logins that nobody else edited, so a
  marker posted or edited in by someone else cannot bury your `/reject`; `backlog decide` refuses a new decision
  while your reversal is open unless it names it (`--handles-reversal`).
- **The run log** is pinned (`team.run_log_issue`, which must have been opened by the team or you) or the single
  labelled issue the team or you opened. An issue someone else opens and labels is never the log, and while one
  exists without a team log the scripts refuse rather than open a second log — pin the right one.
- **Team decisions** count only as comments that *start* with the decision marker, so a status `--reason` or an
  answer that quotes the marker is never one.
- **Deleted commands**: GitHub keeps no trace of a deleted comment. Runs record the ids of the commands they acted
  on (`runlog finish --acted`), and `backlog vanished` (once per run) lists any of them that is gone, for you to
  look at — the team does not act on it again.
- **Answered reversals**: a decision that answers your `/reject` says so on its first lines ("Answers your
  /reject: <link>"), and the team-chat brief lists it under `answered_rejects`.
- **`same_account`** (`backlog answers`, the inbox, the gate warning) is true when an agent in the session can write
  as you: the agents' own identity is your account, **or**, in app mode, any personal credential in the session
  (`PT_OWNER_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `gh auth`) resolves to your login. Only a session with none of those
  is false, and only then does the same-run caution in `slot-pm` and `demo-apply` fall away. Only a 401/403 from
  GitHub rules a credential out; an outage (5xx, timeout, network) cannot, so it counts as `true`.
- **`backlog answer`** (team chat) posts with `PT_OWNER_TOKEN` and refuses when it is missing or not yours —
  otherwise the answer would be the bot's and would not count.
- **Verdicts**: with the review app configured, `pr gate` counts only `<review-slug>[bot]`; the login list in
  `project.yml` cannot widen that. Without the key in a session it falls back to `team.reviewer_logins`, read from
  the PR's **base branch** (a PR cannot name its own reviewers). The gate fails when the review bot is the team bot or
  when `team.reviewer_logins` lists the team bot.
- **Commits**: `scripts/pr commit -m "…" [git commit args]` runs `git commit` as
  `<slug>[bot] <id+slug[bot]@users.noreply.github.com>`, linked to the bot on GitHub. When the bot cannot be looked
  up it commits nothing; `--author` is refused. Reusing a commit (`--amend`, `-C`, `-c`, `--reuse-message`,
  `--reedit-message`) adds `--reset-author`, so an amended commit of yours becomes the bot's. `pr commit --help`
  shows `pr`'s help. Without a team app it is a plain `git commit`.
- **Pushing**: `scripts/pr push [--branch B]` pushes team branches only (`feature/`, `fix/`, `hotfix/`, `chore/`,
  `backmerge/`, `revert/`, `design/`, `docs/`), never forced, straight to `https://github.com/<repo>.git` as the team
  app:
  - the token reaches git only through `GIT_CONFIG_*` environment variables — not argv, not `.git/config`, not the
    output — and credential helpers are off for the call, so a rejected token fails instead of pushing as you;
  - global and system git config are ignored for the call (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`):
    that is where a session proxy's `insteadOf` rewrite lives, and a rewritten URL would lose the auth header and
    let the proxy push with its own credentials while the script reported the bot;
  - a repository-local `url.*.insteadOf`/`pushInsteadOf` that matches the URL is refused, and git's own resolution
    of the URL must come back unchanged.

  **Cloud sessions whose network only reaches GitHub through the session's git proxy** cannot push as the app:
  `pr push` then fails loudly — it never falls back to the proxy. Allow `github.com` in the environment's network
  settings. Without a team app `pr push` is a plain `git push -u origin B`.
- Pushes by an app token trigger workflows (unlike Actions' `GITHUB_TOKEN`), so CI runs on the team's PRs as before.
- The run log accepts entries from the log's author and from the team bot, so a log opened before the switch keeps
  its history. The inbox's standing "Security setup" item disappears once no agent can act as you.

## What this does and does not isolate

It does:
- make the author of every comment, review, commit and push visible and checkable — self-approval and imitated owner
  commands stop counting;
- make edits checkable: an owner comment rewritten by the team app, the review app or a collaborator (an old "ok"
  turned into `/go`, `/approve` or `/resume`) stops counting;
- keep your personal token out of the scheduled environments entirely, and flag any session that has one;
- confine a leaked installation token to one repository and one hour.

It does not:
- separate roles **inside one session**. Every agent in a session sees the same environment variables: in the
  `reviewers` environment a developer agent started by `slot-qa` could read the review key and post a verdict, and
  in the team-chat session any agent could use `PT_OWNER_TOKEN` to write as you. Separation is between
  environments, not between subagents (SPEC: identity limits);
- hide the keys from anything else in the session. The scripts strip them from the processes *they* start, but the
  agents' own shell commands, the project's contract commands (`lint`, `test`, `build`), package scripts and
  dependencies they run all inherit the session's environment and can read `PT_*_APP_KEY` and `PT_OWNER_TOKEN`;
- protect the app keys from anyone who can edit the cloud environment or read your machine;
- tell your edits from an agent's **in same-account mode**. There the agents *are* your login, so a comment they
  edit still reads as edited by you and counts; the edit check only separates you from the apps and from other
  collaborators;
- help against **anyone holding your own credentials**: `PT_OWNER_TOKEN`, your `gh auth`, a `GH_TOKEN` of yours,
  and the team console's **owner user access token** (`ghu_…`, minted by the `team-console-<env>` app through the
  OAuth flow and stored encrypted in the console's `api` Worker — geeera/team-console ADR 0003). Every write with
  those *is* you, edits included; the console's app key alone (Issues write as `team-console-<env>[bot]`) is
  caught by this check like any other bot;
- notice a command deleted **before** the team saw it: GitHub keeps no trace of a deleted comment, and only
  commands a run acted on are recorded. A command someone deletes in between simply never happened for the team;
- avoid false rejections of genuine comments: an issue comment's REST `updated_at` can also move without a body
  edit (e.g. when it is hidden/minimized, and possibly with some reactions). GraphQL then shows no edit while REST
  does, and the comment is ignored ("REST shows it edited but the edit history shows no edit") — failing closed.
  Recovery: write the command again in a new comment;
- protect what GitHub itself does not record: a revision someone deletes from a comment's history still shows who
  made it, but the check trusts GitHub's edit history as complete. A comment with more than 50 edits is ignored
  rather than half-checked;
- enforce anything server-side. Rulesets that require the review bot's approval need GitHub Pro or a public
  repository; `branch-guard.yml` still reports changes that reached `dev`, `stage` or `main` without a merged PR.

## Troubleshooting

| Error says | Fix |
| ---------- | --- |
| `openssl` command is not installed | install OpenSSL/LibreSSL, or unset `PT_*_APP_ID` |
| neither a PEM private key nor base64 of one | re-encode with `base64 < key.pem \| tr -d '\n'` |
| openssl could not sign | the file is not the app's RSA private key |
| GitHub rejected the JWT | wrong app id for this key, or the clock is off by more than a minute (`date -u`) |
| is not installed on owner/repo | app settings → Install App → add the repository |
| may not get a token | the installation does not include the repository, or a permission is missing |
| are the same app | `PT_REVIEW_APP_ID` names the team app; create a separate review app |
| an owner answer must be posted with …'s own token in PT_OWNER_TOKEN | set `PT_OWNER_TOKEN` in the team-chat session, or answer on GitHub |
| refusing to push: … rewrites … / git would push to … | remove the repository-local `insteadOf`; in the cloud, allow direct `github.com` access |
| git push as …[bot] … failed | the network cannot reach `github.com` directly, or the app lacks Contents/Workflows write |
| `answers` → `ignored`: it was edited by … | someone else changed your comment; write the command again in a new comment |
| `history: rest-only` / `history_error`: GraphQL is unavailable in this session | expected in Claude Code cloud sessions (GraphQL is blocked there): edited comments are ignored, unedited ones count; nothing to fix |
| `history: rest-only` / `history_error`: anything else | GitHub's GraphQL API did not answer (outage, or a token without Issues read); the run went on with REST timestamps; the next run retries GraphQL |
| `answers` → `ignored`: it may have been edited and its edit history could not be fetched | you (or anyone) edited the comment and this session has no edit history; write the command again in a new comment |
| `inbox update`: warning: could not pin | pinning needs GraphQL; pin the "Needs you" issue by hand once, the scripts find it by label |
