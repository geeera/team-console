# Usage: python3 build.py <out-dir> [d1 d2 d3]  (no names: build all three)
import importlib.util, json, pathlib, sys

HERE = pathlib.Path(__file__).parent
OUT = pathlib.Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
ONLY = sys.argv[2:] or ['d1', 'd2', 'd3']
base_css = (HERE / 'base.css').read_text()
base_js = (HERE / 'base.js').read_text()
data_js = (HERE / 'data.js').read_text()
i18n_js = (HERE / 'i18n.js').read_text()

LANG_SEG = ('<div class="seg" data-control="lang" role="group" aria-label="Language" data-i18n-aria="page.lang">'
            '<button type="button" data-value="ru" lang="ru" aria-label="Русский">RU</button>'
            '<button type="button" data-value="en" lang="en" aria-label="English">EN</button></div>')

SHELL = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Team Console · Direction {num} · {name}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{fonts}">
<style>
/* ===== tokens: {name} ===== */
:root{{{shared}{light}
}}
:root[data-theme=dark]{{{dark}
}}
@media (prefers-color-scheme:dark){{:root:not([data-theme=light]){{{dark}
}}}}
{base_css}
/* ===== character: {name} ===== */
{css}
</style>
</head>
<body>
<header class="note">
  <div class="note__row">
    <div><div class="note__kicker" data-i18n="page.kicker" data-i18n-num="{num}">Team Console · visual direction {num} of 03 · prototype for approval</div><h1>{name}</h1></div>
    <div class="controls">
      <div class="seg" data-control="view" role="group" aria-label="Layout" data-i18n-aria="page.layout"><button type="button" data-value="phone">iPhone</button><button type="button" data-value="mac">Mac</button><button type="button" data-value="both" data-i18n="page.both">Both</button></div>
      <div class="seg" data-control="theme" role="group" aria-label="Theme" data-i18n-aria="page.theme"><button type="button" data-value="auto" data-i18n="page.auto">Auto</button><button type="button" data-value="light" data-i18n="page.light">Light</button><button type="button" data-value="dark" data-i18n="page.dark">Dark</button></div>
      {lang_seg}
      <div class="seg" data-control="motion" role="group" aria-label="Motion" data-i18n-aria="page.motion"><button type="button" data-value="system" data-i18n="page.motionSystem">Motion: system</button><button type="button" data-value="reduce" data-i18n="page.motionReduce">Reduced</button></div>
      <button type="button" class="seg-btn" data-reset data-i18n="page.reset">Reset demo</button>
    </div>
  </div>
  <details><summary data-i18n="page.summary">Idea, signature moment and token sketch</summary>{note}</details>
</header>
<main class="stage">
  <section class="device device--phone" aria-label="iPhone layout" data-i18n-aria="page.phoneAria"><div class="device__label">iPhone · 390 pt</div><div class="phone-frame"><div class="app" data-app="phone"></div></div></section>
  <section class="device device--mac" aria-label="Mac layout" data-i18n-aria="page.macAria"><div class="device__label" data-i18n="page.macLabel">Mac · window</div><div class="mac-frame"><div class="app" data-app="mac"></div></div></section>
</main>
<script>
const LANGS = {langs};
{dir_js}
{i18n_js}
{data_js}
{base_js}
</script>
</body>
</html>
'''

for name in ONLY:
    spec = importlib.util.spec_from_file_location(name, HERE / f'{name}.py')
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    D = dict(mod.D)
    langs = D.pop('langs', ['en'])
    note_ru = D.pop('note_ru', None)
    if note_ru:
        D['note'] = f'<div data-lang="en" lang="en">{D["note"]}</div><div data-lang="ru" lang="ru">{note_ru}</div>'
    html = SHELL.format(base_css=base_css, base_js=base_js, data_js=data_js, i18n_js=i18n_js, dir_js=D.pop('js').strip(),
                        langs=json.dumps(langs), lang_seg=LANG_SEG if len(langs) > 1 else '', **D)
    (OUT / D['file']).write_text(html)
    print(D['file'], len(html))
