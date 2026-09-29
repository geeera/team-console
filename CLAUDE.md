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
- Design tokens only (Paper Desk, ADR 0002); no raw colours, spacing or durations in components.
