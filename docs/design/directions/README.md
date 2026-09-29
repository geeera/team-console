# Visual directions (kickoff step 3)

Three self-contained interactive prototypes. Open any file in a browser; on a phone it opens straight into the
iPhone layout. The toggles at the top switch iPhone / Mac / Both, Auto / Light / Dark, and system / reduced motion,
and "Reset demo" puts everything back.

| File | Direction |
|---|---|
| [01-paper-desk.html](01-paper-desk.html) | **Paper Desk**: quiet, warm paper; serif voice for the PM, moss-green accent |
| [02-switchboard.html](02-switchboard.html) | **Switchboard**: dense, keyboard-first operator board; graphite, signal blue, mono ids |
| [03-signal.html](03-signal.html) | **Signal**: bold grotesque; one vivid violet reserved for "you are needed" |

All three share the same flow, content and behaviour, so only the look and feel differ:
- **Projects are spaces.** Sidebar (Mac) and Projects sheet (iPhone) are grouped Pinned / Projects / a collapsed
  "6 more, nothing needs you" list, with a filter, needs-you badges and running / paused / failing marks. The mock
  has 10 projects: storify, team-console, fieldnote (failing), sheltrix (paused) and 6 quiet ones.
- **Above the spaces:** a cross-project **Needs you** list (each item tagged with its project, the failing
  project first) and **All projects** (status, sprint, demo date, progress, PRs, CI).
- **Inside a space:** the PM conversation with decision cards (#72 action: Done, #13 approve / reject with the
  team's recommendation, #47 design approval with a thumbnail, Sprint 01 go / no-go), the Russian briefing, the
  Sprint 01 board (demo 9 Oct; approved / in progress / QA / done; light / standard / heavy tiers), and
  **Artifacts** grouped by type (designs, demos, ADRs, audits, briefings, releases, deploys) with search and type
  filters.
- **Your place is kept per project:** scroll position, open pane (Mac) and unsent draft come back when you return.
- **Resolving a card** records it as the owner's answer (`#id · time · recorded as owner`), after which the PM
  replies. Every direction has its own signature animation for this, and each one falls back to an instant swap
  with a 120 ms fade under `prefers-reduced-motion` (or the "Reduced" toggle).
- **Mac keys** (click inside the window first): B board, F artifacts, Y needs you, N message, / filter projects;
  with a card focused, press the letter on its buttons (A, R, D, G…).

## Comparison

| | Paper Desk (01) | Switchboard (02) | Signal (03) |
|---|---|---|---|
| **Feel** | Calm, warm, like reading a letter; closest to the reference's restraint | Control room: precise, cool and information-first | Confident and personal; decisions visibly pop |
| **Density** | Low: 15 px body, 20 px gaps, board as a side pane | High: 13.5 px body, 12 px gaps; board open beside the chat, sprint meters in the sidebar | Medium-low: 15.5 px body, large titles, 38–48 px targets |
| **Signature moment** | Ink stamp: the stamp presses onto the card, then the card folds into an italic margin note | Commit to log: a status chip flips in, the card collapses into one mono log line, and the counters roll down | Colour sweep: violet spreads from the tapped button, then the card springs into your own reply bubble |
| **Best on iPhone** | Very good: easy to read, quiet tab bar | Good: the sprint strip under the header is handy, but the text is small for long reading | Best: big targets, floating tab bar, a "N need you" pill |
| **Best on Mac** | Good: roomy, but fewer projects fit on screen | Best: keyboard shortcuts, board and chat side by side, suits 10+ projects | Good: the violet can feel loud when a long session has many open cards |
| **Dark mode** | Warm charcoal, soft and low glare | Near-black graphite, crisp | Deep aubergine; the violet glows |
| **Risk** | Serif Cyrillic in long briefings is less compact; the quiet look could hide urgency (failing runs rely on the banner and a dot) | Can feel like a dev tool rather than a calm companion; small type on the phone; the most motion in the counters | Accent fatigue: if everything glows, nothing does; the spring and colour sweep need care to hit 60 fps on older iPhones |

## Recommendation

**Paper Desk (01) as the base, with two things from Switchboard (02):** the sprint meter under each project in
the sidebar, and mono ids and numbers on the board. Also keep the rolling needs-you counter, but only on the Mac.

Why: the owner asked for something that feels familiar next to the reference. That means conversation first,
a warm neutral palette, one accent, quiet motion and an excellent dark mode, and Paper Desk is the closest match
on each of those. It is also the calmest direction to read on iPhone, which is where most answers will be given.
Its weak spot is scanning many projects at once. The two Switchboard pieces fix that without changing the
character. Signal is the strongest on iPhone, so if the owner wants more personality, its colour sweep could
replace the ink stamp as the signature moment.

## Notes

- Fonts are open-licence only (SIL OFL): Source Serif 4 / Source Sans 3 / Source Code Pro (01), IBM Plex Sans /
  Mono (02), Bricolage Grotesque / Figtree / JetBrains Mono (03). They load from Google Fonts, and offline the
  pages fall back to system fonts. There are no icon sets or image assets: icons are inline strokes drawn for this
  prototype, and the design thumbnail is drawn from the tokens.
- No Anthropic or Claude names, logos, marks, typefaces or brand colours are used. The accents (moss green, signal
  blue, violet) were chosen to stay clear of that palette. The window dots are the generic macOS controls.
- Token contrast is WCAG AA (≥ 4.5:1) in both themes for the checked text/background pairs (text, secondary and tertiary text, accent, status and owner bubbles), including tertiary
  text on sunken surfaces.
- The signature animation animates only `transform`, `opacity`, `clip-path` and background colour; the rest of
  the conversation slides by transform, not layout. The one layout animation is the Mac detail pane (its width).
  Production should switch that to a transform-based slide if profiling shows jank.
- The iPhone and Mac layouts in one file are independent instances, so answering in one does not update the other.
  The real app is backed by GitHub and has a single state.
