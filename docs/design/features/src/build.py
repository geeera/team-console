# Usage: python3 build.py            (writes ../24-settings-projects.html)
# The design reads the Paper Desk tokens, character CSS and shared structure straight from the direction sources
# (docs/design/directions/src), so it cannot drift from ADR 0002. Everything feature-specific lives here.
import importlib.util, pathlib

HERE = pathlib.Path(__file__).parent
DIR_SRC = HERE.parent.parent / 'directions' / 'src'
spec = importlib.util.spec_from_file_location('d1', DIR_SRC / 'd1.py')
d1 = importlib.util.module_from_spec(spec); spec.loader.exec_module(d1)
D = d1.D
base_css = (DIR_SRC / 'base.css').read_text()
css = (HERE / 'settings.css').read_text()
js = (HERE / 'settings.js').read_text()
i18n = (HERE / 'settings-i18n.js').read_text()

NOTE_EN = '''
<div class="note__grid"><div>
<p><b>What you are approving.</b> The look of Settings › Projects on the approved UX spec (#24): the project list, New project, the project setup page with its four-step checklist, and the archive confirmation, on iPhone and Mac, light and dark, ru and en. Flow, states and copy are the UX spec’s; this page decides only how they look and move.</p>
<ul>
<li><b>The checklist is a ledger.</b> Four numbered steps on one paper sheet. Each step says its status in words (Done, Missing, Checking…, Not checked, Couldn’t check); the mark only repeats it. Missing is ochre, a to-do, not red. A missing step has a one-line fix and a “How to fix” fold with Copy buttons.</li>
<li><b>Results are margin notes.</b> The outcome of a check is a serif note with a coloured rule, like a recorded answer in the chat: moss when added or ready, ochre when steps are left, clay when nothing was saved.</li>
<li><b>Signature moment, reused.</b> When a project becomes ready, the Paper Desk ink stamp presses onto the “ready” note. When a step turns done, its check is drawn in, in step order. Nothing else moves. Reduced motion: a 120 ms fade.</li>
<li><b>Archive is quiet but never the default.</b> A plain “Archive” on each row, a clay-outlined “Archive project” at the bottom of the setup page, and a dialog that opens on Cancel. On iPhone the dialog rises as a sheet.</li>
<li><b>Entry points.</b> Mac: a Settings item in the sidebar footer. iPhone: “Add project” and “Settings” at the bottom of the Projects sheet.</li>
</ul>
<p class="try">Try: on iPhone tap “Settings” in the sheet; add <code>geeera/private-lab</code>, then <code>geeera/newsletter</code> and select Check again twice; open fieldnote and archive it; switch the theme, the language and reduced motion. The demo bar reaches every state.</p>
</div><dl class="tok">
<dt>Colour</dt><dd>Paper Desk tokens only: paper, sheet, ink, moss for the next action, ochre (warning) for missing steps, clay (danger) for “not saved” and archive.</dd>
<dt>Type</dt><dd>Source Serif 4 for titles, names and result notes; Source Sans 3 for the interface; Source Code Pro for owner/repo, paths and commands. All OFL.</dd>
<dt>New tokens</dt><dd>Proposed for the kit: spacing 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40, target 44, input text 16 (no iOS zoom), checklist mark 28, dialog width 440, stagger 70 ms, reduced-motion fade 120 ms.</dd>
<dt>New kit parts</dt><dd>Field (label, hint, error, preview), danger and quiet-danger buttons, alert dialog, skeleton row, code line with Copy, disclosure.</dd>
<dt>Motion</dt><dd>fast 140 · base 240 · slow 380 · stamp 620 ms; only transform, opacity and stroke draw.</dd>
</dl></div>'''

NOTE_RU = '''
<div class="note__grid"><div>
<p><b>Что утверждаешь.</b> Внешний вид «Настройки › Проекты» по утверждённой UX-спеке (#24): список проектов, новый проект, страница настройки проекта с чек-листом из четырёх шагов и подтверждение архивации — на iPhone и Mac, в светлой и тёмной теме, на русском и английском. Сценарий, состояния и тексты — из UX-спеки; здесь решается только то, как это выглядит и двигается.</p>
<ul>
<li><b>Чек-лист — как страница журнала.</b> Четыре пронумерованных шага на одном листе. Статус каждого шага написан словом (Готово, Не хватает, Проверяем…, Не проверено, Не удалось проверить); значок его только повторяет. «Не хватает» — охра, это дело, а не ошибка. У такого шага есть исправление в одну строку и раскрывающееся «Как сделать» с кнопками «Копировать».</li>
<li><b>Результат — заметка на полях.</b> Итог проверки — заметка с засечками и цветной чертой слева, как записанный ответ в чате: мох — добавлено или готово, охра — остались шаги, глина — ничего не сохранено.</li>
<li><b>Фирменный момент — тот же.</b> Когда проект готов, на заметку «готов» ложится чернильный штамп Paper Desk. Когда шаг становится выполненным, его галочка прорисовывается по порядку шагов. Больше ничего не двигается. При уменьшенной анимации — затухание 120 мс.</li>
<li><b>Архивация тихая, но никогда не по умолчанию.</b> Простая кнопка «Архивировать» в каждой строке, «Архивировать проект» цвета глины внизу страницы настройки и диалог, в котором фокус сразу на «Отмене». На iPhone диалог выезжает снизу, как лист.</li>
<li><b>Входы.</b> Mac — пункт «Настройки» внизу боковой панели. iPhone — «Добавить проект» и «Настройки» внизу листа «Проекты».</li>
</ul>
<p class="try">Попробуй: на iPhone нажми «Настройки» в листе; добавь <code>geeera/private-lab</code>, потом <code>geeera/newsletter</code> и дважды нажми «Проверить снова»; открой fieldnote и заархивируй его; переключи тему, язык и «Меньше движения». Панель демо открывает любое состояние.</p>
</div><dl class="tok">
<dt>Цвет</dt><dd>Только токены Paper Desk: бумага, лист, чернила, мох для следующего действия, охра (warning) для недостающих шагов, глина (danger) для «не сохранено» и архивации.</dd>
<dt>Шрифты</dt><dd>Source Serif 4 — заголовки, имена проектов и заметки-результаты; Source Sans 3 — интерфейс; Source Code Pro — owner/repo, пути и команды. Все под OFL.</dd>
<dt>Новые токены</dt><dd>Предлагаю в кит: отступы 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40, цель касания 44, текст в поле 16 (без зума на iOS), значок шага 28, ширина диалога 440, шаг задержки 70 мс, затухание 120 мс при уменьшенной анимации.</dd>
<dt>Новое в ките</dt><dd>Поле (подпись, подсказка, ошибка, превью), кнопки «опасное действие» и «тихое опасное», диалог-предупреждение, строка-скелетон, строка кода с «Копировать», раскрывашка.</dd>
<dt>Движение</dt><dd>быстро 140 · обычно 240 · медленно 380 · штамп 620 мс; двигаются только transform, opacity и прорисовка линий.</dd>
</dl></div>'''

OPT = lambda key, vals: ''.join(f'<option value="{v}" data-i18n="{key}.{v}">{v}</option>' for v in vals)

HTML = f'''<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Team Console · #24 · Settings › Projects</title>
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
    <div><div class="note__kicker" data-i18n="page.kicker">Team Console · #24 · design for approval</div><h1 data-i18n="page.title">Settings › Projects</h1></div>
    <div class="controls">
      <div class="seg" data-control="view" role="group" aria-label="Layout" data-i18n-aria="page.layout"><button type="button" data-value="phone">iPhone</button><button type="button" data-value="mac">Mac</button><button type="button" data-value="both" data-i18n="page.both">Both</button></div>
      <div class="seg" data-control="theme" role="group" aria-label="Theme" data-i18n-aria="page.theme"><button type="button" data-value="auto" data-i18n="page.auto">Auto</button><button type="button" data-value="light" data-i18n="page.light">Light</button><button type="button" data-value="dark" data-i18n="page.dark">Dark</button></div>
      <div class="seg" data-control="lang" role="group" aria-label="Language" data-i18n-aria="page.lang"><button type="button" data-value="ru" lang="ru" aria-label="Русский">RU</button><button type="button" data-value="en" lang="en" aria-label="English">EN</button></div>
      <div class="seg" data-control="motion" role="group" aria-label="Motion" data-i18n-aria="page.motion"><button type="button" data-value="system" data-i18n="page.motionSystem">Motion: system</button><button type="button" data-value="reduce" data-i18n="page.motionReduce">Reduced</button></div>
      <button type="button" class="seg-btn" data-reset data-i18n="page.reset">Reset demo</button>
    </div>
  </div>
  <div class="demo" role="group" aria-label="Demo states" data-i18n-aria="demo.aria">
    <label><span data-i18n="demo.screen">Screen</span><select id="d-screen"><option value="">—</option>{OPT('demo.s', ['entry', 'list', 'new', 'setupMissing', 'setupUnknown', 'setupReady', 'dialog'])}</select></label>
    <label><span data-i18n="demo.list">Project list</span><select id="d-list">{OPT('demo.l', ['normal', 'loading', 'empty', 'error', 'offline'])}</select></label>
    <label><span data-i18n="demo.add">Add result</span><select id="d-add">{OPT('demo.a', ['auto', 'pat', 'yml', 'saved', 'ready', 'github', 'rate', 'token'])}</select></label>
    <label><input type="checkbox" id="d-fail"><span data-i18n="demo.archFail">Archive fails</span></label>
    <button type="button" class="seg-btn" id="d-return" data-i18n="demo.return">Return to the app</button>
    <p class="demo__help" data-i18n="demo.help"></p>
  </div>
  <details><summary data-i18n="page.summary">What you are approving</summary><div data-lang="en" lang="en">{NOTE_EN}</div><div data-lang="ru" lang="ru">{NOTE_RU}</div></details>
</header>
<main class="stage">
  <section class="device device--phone" aria-label="iPhone layout" data-i18n-aria="page.phoneAria"><div class="device__label">iPhone · 390 pt</div><div class="phone-frame"><div class="app" data-app="phone"></div></div></section>
  <section class="device device--mac" aria-label="Mac layout" data-i18n-aria="page.macAria"><div class="device__label" data-i18n="page.macLabel">Mac · window</div><div class="mac-frame"><div class="app" data-app="mac"></div></div></section>
</main>
<script>
{i18n}
{js}
</script>
</body>
</html>
'''
out = HERE.parent / '24-settings-projects.html'
out.write_text(HTML)
print(out.name, len(HTML))
