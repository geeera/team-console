# Usage: python3 build.py            (writes every page listed in PAGES next to src/)
# Each page reads the Paper Desk tokens, character CSS and shared structure straight from the direction sources
# (docs/design/directions/src), so it cannot drift from ADR 0002. kit.css and proto.js are shared by the feature
# pages; everything feature-specific lives in the page's spec (p<issue>.py) and its own css/js.
import importlib.util, pathlib

HERE = pathlib.Path(__file__).parent
DIR_SRC = HERE.parent.parent / 'directions' / 'src'
PAGES = ['p24', 'p114', 'p134', 'p36']


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


D = load(DIR_SRC / 'd1.py', 'd1').D
base_css = (DIR_SRC / 'base.css').read_text()
kit_css = (HERE / 'kit.css').read_text()
proto_js = (HERE / 'proto.js').read_text()

OPT = lambda key, vals: ''.join(f'<option value="{v}" data-i18n="{key}.{v}">{v}</option>' for v in vals)


def build(P):
    css = kit_css + ''.join((HERE / f).read_text() for f in P.CSS)
    i18n, js = ((HERE / f).read_text() for f in P.JS)
    return f'''<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>{P.DOC_TITLE}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{D['fonts']}">
<style>
/* ===== tokens: Paper Desk (generated from docs/design/directions/src/d1.py) ===== */
:root{{{D['shared']}{D['light']}
}}
:root[data-theme=dark]{{{D['dark']}
}}
@media (prefers-color-scheme:dark){{:root:not([data-theme=light]){{{D['dark']}
}}}}
{base_css}
/* ===== character: Paper Desk ===== */
{D['css']}
{css}
</style>
</head>
<body>
<header class="note">
  <div class="note__row">
    <div><div class="note__kicker" data-i18n="page.kicker">{P.KICKER}</div><h1 data-i18n="page.title">{P.TITLE}</h1></div>
    <div class="controls">
      <div class="seg" data-control="view" role="group" aria-label="Layout" data-i18n-aria="page.layout"><button type="button" data-value="phone">iPhone</button><button type="button" data-value="mac">Mac</button><button type="button" data-value="both" data-i18n="page.both">Both</button></div>
      <div class="seg" data-control="theme" role="group" aria-label="Theme" data-i18n-aria="page.theme"><button type="button" data-value="auto" data-i18n="page.auto">Auto</button><button type="button" data-value="light" data-i18n="page.light">Light</button><button type="button" data-value="dark" data-i18n="page.dark">Dark</button></div>
      <div class="seg" data-control="lang" role="group" aria-label="Language" data-i18n-aria="page.lang"><button type="button" data-value="ru" lang="ru" aria-label="Русский">RU</button><button type="button" data-value="en" lang="en" aria-label="English">EN</button></div>
      <div class="seg" data-control="motion" role="group" aria-label="Motion" data-i18n-aria="page.motion"><button type="button" data-value="system" data-i18n="page.motionSystem">Motion: system</button><button type="button" data-value="reduce" data-i18n="page.motionReduce">Reduced</button></div>
      <button type="button" class="seg-btn" data-reset data-i18n="page.reset">Reset demo</button>
    </div>
  </div>
{P.demo(OPT)}  <details><summary data-i18n="page.summary">What you are approving</summary><div data-lang="en" lang="en">{P.NOTE_EN}</div><div data-lang="ru" lang="ru">{P.NOTE_RU}</div></details>
</header>
<main class="stage">
  <section class="device device--phone" aria-label="iPhone layout" data-i18n-aria="page.phoneAria"><div class="device__label">iPhone · 390 pt</div><div class="phone-frame"><div class="app" data-app="phone"></div></div></section>
  <section class="device device--mac" aria-label="Mac layout" data-i18n-aria="page.macAria"><div class="device__label" data-i18n="page.macLabel">Mac · window</div><div class="mac-frame"><div class="app" data-app="mac"></div></div></section>
</main>
<script>
{i18n}
{proto_js}
{js}
</script>
</body>
</html>
'''


for name in PAGES:
    P = load(HERE / f'{name}.py', name)
    html = build(P)
    out = HERE.parent / P.FILE
    out.write_text(html)
    print(out.name, len(html))
