# Owner checklist

One-time setup only the owner can do. Agents never see secret values; they reference `secrets.NAME` in
workflows. Tick an item by editing this file in a PR, or comment `/approve` on the linked question issue.

## Accounts (free tiers only)
- [ ] GitHub repository `OWNER/REPO` exists, default branch `dev`; `main`, `stage`, `dev` branches exist
- [ ] Hosting account(s): <!-- e.g. Vercel / Cloudflare Pages / Render / Fly.io — filled at kickoff -->
- [ ] Database account: <!-- e.g. Neon / Supabase -->

## Secrets (Settings → Secrets and variables → Actions)
| Secret | What for | Where to create it | Done |
| ------ | -------- | ------------------ | ---- |
<!-- rows added by devops; one row per secret -->

## Security hardening (recommended before the first release)

Out of the box every agent acts as your GitHub account (same-account mode): the merge gate and your `/approve`,
`/go` comments are conventions an agent could imitate (the inbox shows a standing "Security setup" item until the
agents have their own identity).

1. **Two GitHub Apps** (recommended; `.claude/product-team/reference/identities.md` has the exact steps and
   permissions). A **team app** the agents write and push as, and a **review app** only reviews post as. Install
   both on this repository only, and put the review bot's login in `team.reviewer_logins` in
   `.product-team/project.yml` (`['<product>-review[bot]']`) — from then on only its verdicts count in
   `scripts/pr gate`, and only comments by your own login count as your commands.
   - [ ] Team app created, installed, `PT_TEAM_APP_ID` + `PT_TEAM_APP_KEY` (base64 of the `.pem`) in every cloud
         environment the team uses
   - [ ] Review app created, installed, `PT_REVIEW_APP_ID` + `PT_REVIEW_APP_KEY` only in the `reviewers` environment
   - [ ] `team.reviewer_logins` lists the review bot
   Alternative without apps: a GitHub machine account with write access and a fine-grained token (this
   repository; Pull requests read/write, Contents read, Issues read) as `PT_REVIEW_TOKEN`, its login in
   `team.reviewer_logins`. That separates verdicts, but the agents still act as you.
2. **Separate cloud environment for reviews.** In claude.ai/code create an environment `reviewers` with the review
   identity (review app, or `PT_REVIEW_TOKEN`) and point the `slot-qa` routine at it. Keep `slot-pm` and `slot-dev`
   in the default environment, which has no review identity — so a developer agent cannot post a counted verdict.
   (Every role inside one session shares that session's variables; separation only works between environments.)
   Never put your own GitHub token (`PT_OWNER_TOKEN`, `GH_TOKEN`) into a scheduled environment once the team app is
   set up: the team would count as acting as you again. Only the team-chat session gets `PT_OWNER_TOKEN`, so your
   answers there can be posted as you.
3. **Your own commands.** While the agents' GitHub identity is your account (no team app), an agent can write a
   comment that looks like yours; the team therefore only takes a release **go** from the demo page or from a
   comment older than the current run. With the team app, only your login's comments count.
4. **Server-side enforcement (costs money or visibility).** Rulesets that require a review from the reviewing
   account are not available for private repositories on GitHub's free plan. Options: GitHub Pro (paid — needs
   your `/approve` on the budget question) or making the repository public. Until then `branch-guard.yml`
   reports, after the fact, any change that reached `dev`, `stage` or `main` without a merged PR.

## Daily digest on your phone (5 minutes)

In same-account mode the agents write to GitHub as your account, and GitHub never notifies you about your own
comments — so their questions would not reach your phone. `owner-digest.yml` sends the pinned "Needs you" list once a day instead.
Pick one channel and put its values in Settings → Secrets and variables → Actions:

- **Telegram** (recommended): message @BotFather → `/newbot` → copy the token into `PT_TELEGRAM_TOKEN`. Send your new
  bot any message, open `https://api.telegram.org/bot<token>/getUpdates` in a browser and copy `chat.id` into
  `PT_TELEGRAM_CHAT`.
- **ntfy** (no account): install the ntfy app, subscribe to a long random topic name, put that name in
  `PT_NTFY_TOPIC`. Anyone who guesses the topic can read it — keep it long and random.

Set `owner.language` in `.product-team/project.yml` to `ru` for the digest and questions in Russian.

## Claude
- [ ] Scheduled routines created for `slot-pm`, `slot-dev`, `slot-qa` (see the plugin README)
- [ ] Project chat created for owner ↔ team conversation
- [ ] One digest channel set up (see "Daily digest on your phone") — GitHub notifications do not show the agents'
      questions while they write as your account

## Budget
Budget is **$0**. Any paid plan, upgrade or domain arrives as a `kind:question` issue; nothing is bought without
your `/approve` there.
