# Team Console — product brief

Status: agreed with the owner 2026-09-29 (kickoff).

## Problem

The owner runs an autonomous product team (the product-team plugin) on one or more products. Today the owner has to
work through GitHub issues to answer the team, follow a sprint and approve designs — on a phone that is awkward, and
GitHub does not even notify the owner about the team's comments (the agents write as the owner's account). The team
chat in a Claude Code session helps, but it is pull-only and text-only.

## Who

One person: the owner of the products. Not a multi-user product; no public App Store release.

## What v1 does (all four were asked for)

1. **Questions** — every decision the team needs from the owner (money, scope, release, access, legal, design), with
   the team's recommendation, answered in one tap; push notification when something new needs the owner.
2. **Chat with the PM** — write to the team in plain words; the PM answers within minutes (a routine wakes up per
   message; $0, uses the owner's subscription quota) and can turn requests into backlog items.
3. **Sprint board** — per product and across products: issues by status and tier, open PRs, CI, run log health,
   sprint metrics, demo date; pause / resume a product.
4. **Designs and demo** — see designs awaiting approval and the sprint demo page inside the app, approve there.

## Projects are spaces (owner's requirement, 2026-09-29)

There will be many products. Each is a **space** that keeps its own context so nothing gets lost:
- its PM chat with full history, its questions, its sprint board and run health;
- its **artifacts**, grouped by type and searchable within the space: designs and prototypes, demo pages, decision
  records (ADRs), audits, briefings, releases and changelogs, links to deploys;
- its settings (paused or running, schedule, plugin version).

Above the spaces: one cross-project **"Needs you"** list (each item tagged with its project) and an overview of every
project (running / paused / failing, sprint and demo date). Switching projects never loses the place you were in.

## Language (owner's requirement, 2026-09-29)

The interface speaks the user's language: Russian and English in v1, chosen in Settings, defaulting to the device
language, switchable at runtime and remembered. Dates, times and numbers follow the chosen locale. What the team
writes to the owner (PM chat, briefings, answer lines, digest) follows `owner.language` in each product's
`.product-team/project.yml` — Russian for this owner.

## Where

iPhone and Mac equally. v1 is a **PWA** (installed to the Home Screen / Dock; web push on iOS 16.4+). A native
SwiftUI client may follow after a month of use, on the same backend (owner's decision, 2026-09-29).

## Constraints

- Budget $0 (Apple Developer $99/year only if the native client is later judged worth it).
- GitHub stays the single source of truth; the app keeps no database of its own beyond what push and the chat need.
- Answers written by the app are the owner's own — the owner is the only user — and must stay distinguishable and
  auditable (the same rules as `backlog answer`: typed by item, owner's words recorded).
- Public repository: no secrets in code; tokens only in GitHub Secrets / the hosting provider's secret store.

## Not in v1

App Store release, other users, offline editing, analytics beyond the plugin's own metrics, a native client.
