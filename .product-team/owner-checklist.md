# Owner checklist

One-time setup only the owner can do. Agents never see secret values; they reference `secrets.NAME` in
workflows. Tick an item by editing this file in a PR, or comment `/approve` on the linked question issue.

## Accounts (free tiers only)
Listed in ADR 0001 → Consequences; the `devops` foundation issue turns this into step-by-step instructions.
- [ ] Cloudflare account, Zero Trust team (free), `workers.dev` subdomain
- [ ] Cloudflare API token for GitHub Actions (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)
- [ ] Access applications for the app Workers — one-time PIN to your email (`OWNER_EMAIL`)
- [ ] One Access service token for e2e on stage
- [ ] Fine-grained GitHub token for the Worker, listing every product repository (ADR 0001, decision 6)
- [ ] Per product: a webhook to the hooks Worker (shared secret) and a PM-chat routine with an API trigger token

- [x] GitHub repository `geeera/team-console` (public), default branch `dev`; `main`, `stage`, `dev` exist
- [ ] Hosting account(s): <!-- e.g. Vercel / Cloudflare Pages / Render / Fly.io — filled at kickoff -->
- [ ] Database account: <!-- e.g. Neon / Supabase -->

## Secrets (Settings → Secrets and variables → Actions)
| Secret | What for | Where to create it | Done |
| ------ | -------- | ------------------ | ---- |
<!-- rows added by devops; one row per secret -->

## Security hardening (recommended before the first release)

Out of the box every agent acts as your GitHub account: the merge gate and your `/approve`, `/go` comments are
conventions an agent could imitate (the inbox shows a standing "Security setup" item until this is done).

1. **Reviewing account.** Create a GitHub machine account (one free machine account per person is allowed).
   Give it write access to this repository, no admin. Create a fine-grained token for it: this repository only,
   Pull requests read/write, Contents read, Issues read. Put its login in `team.reviewer_logins` in
   `.product-team/project.yml` — from then on only its verdicts count in `scripts/pr gate`.
2. **Separate cloud environment for reviews.** In claude.ai/code create an environment `reviewers` with the
   variable `PT_REVIEW_TOKEN` = that token, and point the `slot-qa` routine at it. Keep `slot-pm` and `slot-dev`
   in the default environment, which has no reviewer token — so a developer agent cannot post a counted verdict.
   (Every role inside one session shares that session's tokens; separation only works between environments.)
3. **Your own commands.** While the agents' GitHub identity is your account, an agent can write a comment that
   looks like yours; the team therefore only takes a release **go** from the demo page or from a comment older
   than the current run. Full separation needs the agents on their own identity as well.
4. **Server-side enforcement (costs money or visibility).** Rulesets that require a review from the reviewing
   account are not available for private repositories on GitHub's free plan. Options: GitHub Pro (paid — needs
   your `/approve` on the budget question) or making the repository public. Until then `branch-guard.yml`
   reports, after the fact, any change that reached `dev`, `stage` or `main` without a merged PR.

## Daily digest on your phone (5 minutes)

The agents write to GitHub as your account, and GitHub never notifies you about your own comments — so their
questions would not reach your phone. `owner-digest.yml` sends the pinned "Needs you" list once a day instead.
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
