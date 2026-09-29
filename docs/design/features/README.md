# Feature designs

Designs of single features for owner approval, built on the approved Paper Desk direction (ADR 0002). Each page
is self-contained: open it in a browser, and on a phone it opens straight into the iPhone layout. The top bar
switches iPhone / Mac / Both, theme, RU / EN and reduced motion, and a demo bar reaches every state from the
feature's UX spec.

| File | Issue | What it shows |
|---|---|---|
| [24-settings-projects.html](24-settings-projects.html) | #24 Settings: add and archive a project | Settings › Projects list (loaded, loading, empty, error, offline), New project (invalid input, checking, refused, couldn't check, already listed, archived), the project setup page with the four-step checklist, the archive dialog (and its failure), and the entry points: the Mac sidebar footer and the iPhone Projects sheet |

## Source

`src/` holds the source; the HTML is generated. Tokens, the Paper Desk character CSS and the shared structure
come straight from `../directions/src` (`d1.py`, `base.css`), so a feature design cannot drift from the direction.

```sh
python3 docs/design/features/src/build.py   # writes docs/design/features/24-settings-projects.html
```

Strings live in `src/settings-i18n.js` (ru reference, en second) under the keys of the UX spec, so they can move
into the app's catalogue as they are. Values the Paper Desk sketch has no token for (spacing scale, 44 px target,
16 px input text, stagger, reduced-motion fade) are declared once as tokens at the top of `src/settings.css` and
proposed for the UI kit. Fonts are OFL (Source Serif 4, Source Sans 3, Source Code Pro); icons are inline strokes.
