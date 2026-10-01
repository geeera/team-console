# #114 Team commands, part 1: pause / resume and "Run now" from the phone. Page spec for build.py.
FILE = '114-team-commands.html'
DOC_TITLE = 'Team Console · #114 · Team commands: pause and run now'
KICKER = 'Team Console · #114 · design for approval'
TITLE = 'Team commands: pause and run now'
CSS = ['commands.css']
JS = ['commands-i18n.js', 'commands.js']

NOTE_EN = '''
<div class="note__grid"><div>
<p><b>What you are approving.</b> How pause / resume and “Run now” look and move in a project space (#114), on iPhone first and on Mac, light and dark, ru and en. Flow, states and copy follow the pause and run-now part of the UX spec on #29 and #114’s criteria; this page decides how they look.</p>
<ul>
<li><b>One way in: Commands.</b> In the project space’s top bar on iPhone (a sheet rises from the bottom) and in its header on Mac (the panel opens on the right, <kbd>K</kbd> toggles it, the chat stays usable). When the project is paused, an ochre banner in the space has its own Resume.</li>
<li><b>The panel says the state in words</b> (Running · Paused by you since 13:52 · Paused itself, in clay), then two groups: Team work, a single Pause ↔ Resume row; and Run now, three rows for planning, development and QA. Each row says when the last run was, or why its button is off.</li>
<li><b>One confirmation per command</b>: what will happen, then a button that names the verb. On iPhone it is a bottom sheet with the primary button nearest your thumb.</li>
<li><b>The result is a margin note at the top of the panel</b>, like an answered card in Paper Desk: moss when done (with the run log link), grey when nothing changed (already paused, a run already in progress), ochre when it is unknown (the run service didn’t answer). A failure keeps the dialog open with the reason and Try again; rate limits name the limit and when you can run again.</li>
<li><b>No trigger token</b> is a to-do, not an error: an ochre card “Run now isn’t set up” with three steps and a Copy line; the Run buttons stay visible, off, with the reason.</li>
<li><b>Motion</b>: the panel slides in, the pause banner drops in, the result’s tick is drawn in ink, a run in progress is a slowly breathing dot. Nothing else moves. Reduced motion: a 120 ms fade and a still dot. No stamp here: the stamp stays with answering questions.</li>
</ul>
<p class="try">Try on iPhone: Commands → Pause → Pause; Resume from the banner; then Commands → Run on Development, and Run again (it is locked for three hours). Set “Next command” to “rate limit: project” or “no answer” and run Planning. Status “no trigger token” shows the setup card. The demo bar reaches every state.</p>
</div><dl class="tok">
<dt>Colour</dt><dd>Paper Desk tokens only: moss for running and for “done”, ochre (warning) for paused by you, a missing setup step and “unknown”, clay (danger) for the team pausing itself and for failures, grey for “nothing changed”.</dd>
<dt>Type</dt><dd>Source Serif 4 for the panel title, the state sentence and result notes; Source Sans 3 for the interface; Source Code Pro only for the command line. All OFL.</dd>
<dt>Tokens</dt><dd>The #24 additions (spacing 4–40, target 44, dialog 440, fade 120 ms) plus a 1600 ms pulse for a running slot. Everything else is already in <code>tokens.css</code>.</dd>
<dt>Kit</dt><dd>Reused: Receipt (result note), StateBlock (loading, error), Field, Button, the #24 disclosure and code line. New: an async confirm (Sending…, error that keeps the dialog open, Try again), disabled-with-reason buttons, a Banner (warning, danger), a Toast, the Commands panel frame (pane on Mac, sheet on iPhone), Receipt tone “warning”.</dd>
<dt>Motion</dt><dd>fast 140 · base 240 · slow 380 · pulse 1600 ms; only transform, opacity and stroke draw.</dd>
</dl></div>'''

NOTE_RU = '''
<div class="note__grid"><div>
<p><b>Что утверждаешь.</b> Как выглядят и двигаются пауза, возобновление и «Запустить сейчас» в пространстве проекта (#114) — сначала на iPhone, потом на Mac, в светлой и тёмной теме, на русском и английском. Сценарий, состояния и тексты — по части UX-спеки #29 про паузу и запуск и по критериям #114; здесь решается, как это выглядит.</p>
<ul>
<li><b>Один вход — «Команды».</b> На iPhone — в верхней панели пространства проекта (снизу выезжает лист), на Mac — в его шапке (панель открывается справа, <kbd>K</kbd> открывает и закрывает её, чат остаётся доступен). Когда проект на паузе, в пространстве висит охристый баннер со своей кнопкой «Возобновить».</li>
<li><b>Панель говорит состояние словами</b> («В работе» · «На паузе по твоей просьбе с 13:52» · «Остановилась сама» цветом глины), потом две группы: «Работа команды» — одна строка «Приостановить» ↔ «Возобновить»; «Запустить сейчас» — три строки: планирование, разработка, проверка. Под каждой — когда был последний прогон или почему кнопка выключена.</li>
<li><b>Одно подтверждение на команду</b>: что произойдёт, потом кнопка с глаголом. На iPhone — лист снизу, главная кнопка ближе к пальцу.</li>
<li><b>Итог — заметка на полях вверху панели</b>, как отвеченная карточка в Paper Desk: мох — сделано (со ссылкой на журнал запусков), серый — ничего не изменилось (уже на паузе, прогон уже идёт), охра — неизвестно (сервис запусков не ответил). При ошибке диалог остаётся открытым с причиной и «Повторить»; лимиты запусков названы словами, с временем, когда можно снова.</li>
<li><b>Нет токена запуска</b> — это дело, а не ошибка: охристая карточка «Запуск отсюда не настроен» с тремя шагами и строкой «Копировать»; кнопки «Запустить» видны, выключены и объясняют почему.</li>
<li><b>Движение</b>: панель выдвигается, баннер паузы опускается, галочка итога прорисовывается чернилами, идущий прогон — медленно «дышащая» точка. Больше ничего не двигается. При «Меньше движения» — затухание 120 мс и неподвижная точка. Штампа здесь нет: он остаётся за ответами на вопросы.</li>
</ul>
<p class="try">Попробуй на iPhone: «Команды» → «Приостановить» → «Приостановить»; возобнови из баннера; потом «Команды» → «Запустить» у разработки и попробуй ещё раз (запуск закрыт на три часа). Поставь «Следующая команда: лимит: проект» или «нет ответа» и запусти планирование. Статус «нет токена запуска» показывает карточку настройки. Панель демо открывает любое состояние.</p>
</div><dl class="tok">
<dt>Цвет</dt><dd>Только токены Paper Desk: мох — «в работе» и «сделано», охра (warning) — пауза по твоей просьбе, недостающий шаг настройки и «неизвестно», глина (danger) — команда остановилась сама и ошибки, серый — «ничего не изменилось».</dd>
<dt>Шрифты</dt><dd>Source Serif 4 — заголовок панели, фраза состояния и заметки-итоги; Source Sans 3 — интерфейс; Source Code Pro — только строка команды. Все под OFL.</dd>
<dt>Токены</dt><dd>Добавки из #24 (отступы 4–40, цель касания 44, диалог 440, затухание 120 мс) и пульс 1600 мс для идущего прогона. Остальное уже есть в <code>tokens.css</code>.</dd>
<dt>Кит</dt><dd>Переиспользую: Receipt (заметка-итог), StateBlock (загрузка, ошибка), Field, Button, раскрывашку и строку кода из #24. Новое: подтверждение с ожиданием («Отправляю…», ошибка не закрывает диалог, «Повторить»), выключенная кнопка с причиной, баннер (warning, danger), тост, рамка панели команд (панель на Mac, лист на iPhone), тон «warning» у Receipt.</dd>
<dt>Движение</dt><dd>быстро 140 · обычно 240 · медленно 380 · пульс 1600 мс; двигаются только transform, opacity и прорисовка линий.</dd>
</dl></div>'''


# The demo state bar; OPT(key, values) renders translated <option>s.
def demo(OPT):
    return f'''  <div class="demo" role="group" aria-label="Demo states" data-i18n-aria="demo.aria">
    <label><span data-i18n="demo.screen">Screen</span><select id="d-screen"><option value="">—</option>{OPT('demo.s', ['space', 'panel', 'pause', 'resume', 'run', 'setup'])}</select></label>
    <label><span data-i18n="demo.proj">Team</span><select id="d-proj">{OPT('demo.p', ['running', 'owner', 'team'])}</select></label>
    <label><span data-i18n="demo.data">Status</span><select id="d-data">{OPT('demo.d', ['ok', 'loading', 'error', 'offline', 'noperm', 'notoken'])}</select></label>
    <label><span data-i18n="demo.outcome">Next command</span><select id="d-outcome">{OPT('demo.o', ['ok', 'error', 'rate', 'rateAccount', 'daily', 'conflict', 'timeout'])}</select></label>
    <label><input type="checkbox" id="d-busy"><span data-i18n="demo.busy">Development run in progress</span></label>
    <label><input type="checkbox" id="d-freeze"><span data-i18n="demo.freeze">Freeze days</span></label>
    <p class="demo__help" data-i18n="demo.help"></p>
  </div>
'''
