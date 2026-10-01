# Feature designs

Designs of single features for owner approval, built on the approved Paper Desk direction (ADR 0002). Each page
is self-contained: open it in a browser, and on a phone it opens straight into the iPhone layout. The top bar
switches iPhone / Mac / Both, theme, RU / EN and reduced motion, and a demo bar reaches every state from the
feature's UX spec.

| File | Issue | What it shows |
|---|---|---|
| [24-settings-projects.html](24-settings-projects.html) | #24 Settings: GitHub connection and projects (revised for ADR 0003) | The GitHub connection block (not connected, connected as, lost, loading, failed connect: cancelled, wrong account, unexpected sign-in address; disconnect dialog), a mock of GitHub’s authorize page for the round trip, Projects (loaded, loading, empty, error, offline), New project (connect-first, invalid input, checking, refused by each gating step incl. 409 app-not-installed and owner-mismatch, couldn’t check incl. 503 github-auth and 403 connection lost, already listed, archived), the setup page with the five-step checklist, the archive dialog (and its failure), and the entry points: the Mac sidebar footer and the iPhone Projects sheet |
| [114-team-commands.html](114-team-commands.html) | #114 Team commands, part 1: pause / resume and run now | The Commands entry in the project space (iPhone top bar → sheet, Mac header → pane, <kbd>K</kbd>), the paused banner with Resume (paused by you, paused itself), the panel (loaded, loading, status error, offline, no write access, no trigger token with the setup card), Pause / Resume and Run now for planning, development and QA with one confirmation each, and every outcome: done, nothing changed (already paused, overlap refused), unknown (no answer, locked for the window), service error, rate limits (project, account, daily cap); a run in progress, freeze days |
| [134-board-phone-lanes.html](134-board-phone-lanes.html) | #134 Board on the phone: lanes row as tall as the tallest lane | The phone lane switcher that replaces the sideways lane row of the #18 board (one lane at its own height, a tab list of lanes with counts), today's row for comparison, an empty lane, an unknown status label from GitHub, a #108 preview with a switcher per section, and the unchanged Mac layout |
| [36-web-push.html](36-web-push.html) | #36 Web push client: subscribe button, iOS guide, tap routing and badge | The Notifications block in Settings (checking, off, waiting for the permission answer, turning on, on with Send a test and Turn off, blocked with where to allow it again per platform, not supported, offline, server refused), the iOS “Add to Home Screen” guide with Safari’s toolbar, the nudge on Needs you, mocks of the iOS and Safari permission prompts and of a notification, where a tap leads (a waiting question, one already answered, one closed on GitHub, an archived project, the test push) and the Home Screen badge |

## Source

`src/` holds the source; the HTML is generated. Tokens, the Paper Desk character CSS and the shared structure
come straight from `../directions/src` (`d1.py`, `base.css`), so a feature design cannot drift from the direction.

```sh
python3 docs/design/features/src/build.py   # writes every page listed in PAGES
```

Each page has a spec (`src/p<issue>.py`: notes and the demo bar), its own CSS and JS, and its strings; `src/kit.css` and
`src/proto.js` (helpers, icons, i18n lookup, page controls) are shared by every page. Strings live in `src/settings-i18n.js` / `src/commands-i18n.js` / `src/board-i18n.js` / `src/push-i18n.js` (ru reference, en second) under the keys of the UX spec, so they can move
into the app's catalogue as they are. Values the Paper Desk sketch has no token for (spacing scale, 44 px target,
16 px input text, stagger, reduced-motion fade) are declared once as tokens at the top of `src/kit.css` and
proposed for the UI kit. Fonts are OFL (Source Serif 4, Source Sans 3, Source Code Pro); icons are inline strokes.
