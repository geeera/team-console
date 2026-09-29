import importlib.util, pathlib, sys

HERE = pathlib.Path(__file__).parent
OUT = pathlib.Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
base_css = (HERE / 'base.css').read_text()
base_js = (HERE / 'base.js').read_text()
data_js = (HERE / 'data.js').read_text()

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
    <div><div class="note__kicker">Team Console · visual direction {num} of 03 · prototype for approval</div><h1>{name}</h1></div>
    <div class="controls">
      <div class="seg" data-control="view" role="group" aria-label="Layout"><button type="button" data-value="phone">iPhone</button><button type="button" data-value="mac">Mac</button><button type="button" data-value="both">Both</button></div>
      <div class="seg" data-control="theme" role="group" aria-label="Theme"><button type="button" data-value="auto">Auto</button><button type="button" data-value="light">Light</button><button type="button" data-value="dark">Dark</button></div>
      <div class="seg" data-control="motion" role="group" aria-label="Motion"><button type="button" data-value="system">Motion: system</button><button type="button" data-value="reduce">Reduced</button></div>
      <button type="button" class="seg-btn" data-reset>Reset demo</button>
    </div>
  </div>
  <details><summary>Idea, signature moment and token sketch</summary>{note}</details>
</header>
<main class="stage">
  <section class="device device--phone" aria-label="iPhone layout"><div class="device__label">iPhone · 390 pt</div><div class="phone-frame"><div class="app" data-app="phone"></div></div></section>
  <section class="device device--mac" aria-label="Mac layout"><div class="device__label">Mac · window</div><div class="mac-frame"><div class="app" data-app="mac"></div></div></section>
</main>
<script>
{dir_js}
{data_js}
{base_js}
</script>
</body>
</html>
'''

for name in ('d1', 'd2', 'd3'):
    spec = importlib.util.spec_from_file_location(name, HERE / f'{name}.py')
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    D = mod.D
    html = SHELL.format(base_css=base_css, base_js=base_js, data_js=data_js, dir_js=D['js'].strip(), **{k: v for k, v in D.items() if k != 'js'})
    (OUT / D['file']).write_text(html)
    print(D['file'], len(html))
