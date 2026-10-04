# ADR 0002: Visual direction — Paper Desk

Status: accepted (2026-09-29, owner). Builds on [ADR 0001](0001-stack-and-architecture.md).

## Context

The owner's reference is the interaction model of the Claude Code desktop app (conversation first, projects in a
sidebar, decisions as cards inside the conversation), without copying its brand. The `ui-designer` offered three
directions as interactive prototypes (`docs/design/directions/`, published on GitHub Pages).

## Decisions

| # | Decision | Why | Rejected |
| - | -------- | --- | -------- |
| 1 | **Paper Desk** is the visual direction: warm paper neutrals, a serif voice for the PM, one moss-green accent, quiet motion, the "stamp" as the signature moment when a decision is answered | The owner liked it; closest to the reference's calm | Switchboard (denser, board-first), Signal (bolder, louder) |
| 2 | **The interface is bilingual (ru, en)**, chosen by the user, defaulting to the device language | The owner works in Russian | English-only UI |

## Consequences

- The design tokens and the UI kit follow the Paper Desk token sketch in `01-paper-desk.html`.
- Every user-facing string goes through the i18n layer from the first component; Russian is the reference copy.

## Not yet

- Proposed by the designer, not yet approved by the owner: sidebar sprint-progress bars and monospaced ids on the
  board, both from Switchboard.
