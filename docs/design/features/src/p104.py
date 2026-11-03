# #104 Environment setup: status and a step-by-step guide per item (never values). Page spec for build.py.
FILE = '104-environment-setup.html'
DOC_TITLE = 'Team Console · #104 · Environment setup'
KICKER = 'Team Console · #104 · design for approval'
TITLE = 'Environment setup'
CSS = ['settings.css', 'env.css']
JS = ['env-i18n.js', 'env.js']

NOTE_EN = '''
<div class="note__grid"><div>
<p><b>What you are approving.</b> How the Environment setup screen looks and moves (phase A of the UX spec on #104: status and guides). You can see it on iPhone first and on Mac, in light and dark, in ru and en. The flow, states and copy follow the UX spec and its wireframe (#223). Phase B, entering values and Publish, waits for the ADR “Publishing secrets from the console” and will get its own design for approval. The summary card already leaves room for its “Enter values” button.</p>
<ul>
<li><b>Entry in Settings.</b> A new “Environment” section between Notifications and Projects, with one row: a key mark, “Environment setup”, the environment in monospace and a status chip (Checking… / Missing: 4 / All set / Not checked). When the push key is missing, the Notifications card turns ochre and links straight to that key’s guide.</li>
<li><b>Four index tabs</b> on a sunken strip: dev · stage · production · local. This console’s tab has a moss dot and the words “this console”. All four fit 390 pt.</li>
<li><b>One summary slip.</b> When something is missing it is a dashed to-do slip with the count in an ochre circle, one command with Copy and “Go to the first missing one”. When nothing is missing it is a plain sheet with a moss tick. Under a dashed rule it says how many items setup checks, with the <code>--check</code> command.</li>
<li><b>Rows are the names themselves</b>, in monospace and wrapped, never cut. Under each name is what it is for, then the status as a word plus an icon: Set (moss ✓), Missing (ochre !) or Not visible here (grey, crossed eye). A missing row has an ochre rule on the left and its one-line fix with Copy. Optional items carry a small-caps “optional” tag and never count as missing.</li>
<li><b>The guide reads like a short letter.</b> The name in monospace, then the tags (status, kind, where it lives, who makes it, who needs it), then the italic never-value line with a lock. The purpose is in the serif. “Where to get it” is numbered steps with the dashboard links. Permissions are a checked list, gotchas are ochre margin notes, and “How to set it” is a card with the command that fits the status. On iPhone the guide is its own page; on Mac it opens beside the list and Esc closes it.</li>
<li><b>Signature moment, reused.</b> When “Check again” finds that the last missing item is now set, the changed chips are re-inked in order and the Paper Desk ink stamp presses onto the summary. Nothing else moves except the page push, the pane slide and the disclosure chevron. With reduced motion everything is a 120 ms fade.</li>
<li><b>No value anywhere.</b> The screen has no field, mask, length, prefix or preview. The only thing shown is whether an item is set.</li>
</ul>
<p class="try">Try on iPhone: Settings → Environment setup → “Go to the first missing one” → open the row → Copy. Then set “Next Check again” to “you ran setup” and press Check again. Switch the tabs to stage and to local. The demo bar reaches every state: loading, failed, offline (both), 403, 429, no projects, projects failed, copy refused, an unknown name in the URL and the deep link from Notifications.</p>
</div><dl class="tok">
<dt>Colour</dt><dd>Paper Desk tokens only. Ochre (warning) means missing: it is a to-do, not an error. Moss means set and is the next action. Grey (sunken) means not visible here or not checked. Clay (danger) is used only when the check itself failed.</dd>
<dt>Type</dt><dd>Source Serif 4 for titles, the summary and the guide’s purpose. Source Sans 3 for the interface. Source Code Pro for names and commands. All OFL.</dd>
<dt>New tokens</dt><dd>Proposed for the kit: Mac list column 440, tab height 52, summary mark 40, guide step mark 24, row rule 3. Reused from #24: spacing 4–40, target 44, stamp 64, stagger 70 ms, fade 120 ms.</dd>
<dt>New kit parts</dt><dd><code>StatusChip</code> tones for set / missing / not visible, with an icon. A plain outline <code>Tag</code>. The kit <code>Lanes</code> tab list in a segmented variant (two-line tab). <code>CodeLine</code> with Copy and the copy-failed note (from #24). A list-detail layout for the Settings column on Mac.</dd>
<dt>Motion</dt><dd>fast 140 · base 240 · slow 380 · stamp 620 ms. Only transform, opacity and stroke draw move. No auto-polling and no looping motion except the skeleton pulse, which stops under reduced motion.</dd>
</dl></div>'''

NOTE_RU = '''
<div class="note__grid"><div>
<p><b>Что вы утверждаете.</b> Как выглядит и двигается экран «Настройка окружения»: фаза A из UX-спеки в #104, то есть статусы и инструкции. Экран показан сначала на iPhone, потом на Mac, в светлой и тёмной теме, на русском и английском. Сценарий, состояния и тексты взяты из UX-спеки и вайрфрейма (#223). Фаза B (ввод значений и «Опубликовать») ждёт ADR «Publishing secrets from the console» и получит отдельный дизайн на утверждение. Место для её кнопки «Ввести значения» в карточке-сводке уже оставлено.</p>
<ul>
<li><b>Вход из «Настроек».</b> Новый раздел «Окружение» между «Уведомлениями» и «Проектами». В нём одна строка: значок ключа, «Настройка окружения», окружение моноширинным шрифтом и чип статуса («Проверяем…» / «Не задано: 4» / «Всё задано» / «Не проверено»). Если не задан ключ пушей, карточка «Уведомления» становится охристой и ведёт прямо в инструкцию к этому ключу.</li>
<li><b>Четыре вкладки-закладки</b> на утоплённой полосе: dev · stage · production · local. На вкладке этой консоли стоят точка цвета мха и подпись «эта консоль». Все четыре помещаются в 390 pt.</li>
<li><b>Одна карточка-сводка.</b> Если чего-то не хватает, это пунктирный листок-дело: число в охристом круге, одна команда с «Копировать» и «К первой незаданной». Если хватает всего, это обычный лист с галочкой цвета мха. Под пунктирной линией написано, сколько настроек проверяет setup, и дана команда с <code>--check</code>.</li>
<li><b>Строки — это сами имена.</b> Они набраны моноширинным шрифтом и переносятся, но никогда не обрезаются. Под именем написано, зачем нужна настройка, а статус показан словом и значком: «Задано» (мох ✓), «Не задано» (охра !), «Отсюда не видно» (серый, перечёркнутый глаз). У незаданной строки слева охристая черта и однострочное исправление с «Копировать». Необязательные настройки помечены капителью «необязательно» и в счёт недостающих не идут.</li>
<li><b>Инструкция читается как короткое письмо.</b> Сначала имя моноширинным шрифтом, потом метки: статус, вид, где живёт, кто создаёт, кому нужна. Затем курсивная строка с замком о том, что значение никогда не показывается. «Зачем» набрано шрифтом с засечками. «Где взять» — пронумерованные шаги со ссылками на нужные страницы. Права даны списком с галочками, подводные камни — охристыми заметками на полях. «Как задать» — карточка с командой под текущий статус. На iPhone инструкция открывается отдельной страницей, на Mac — рядом со списком, Esc её закрывает.</li>
<li><b>Фирменный момент — тот же.</b> Если «Проверить снова» находит, что последняя недостающая настройка теперь задана, изменившиеся чипы по очереди проявляются заново, а на сводку ложится чернильный штамп Paper Desk. Кроме этого двигаются только переход между страницами, выезд панели и стрелка раскрывашки. При «Меньше движения» всё заменяется затуханием на 120 мс.</li>
<li><b>Значений нет нигде.</b> На экране нет ни поля, ни маски, ни длины, ни начала, ни превью. Видно только, задана настройка или нет.</li>
</ul>
<p class="try">Попробуйте на iPhone: «Настройки» → «Настройка окружения» → «К первой незаданной» → откройте строку → «Копировать». Потом поставьте «Следующая „Проверить снова“: вы запустили setup» и нажмите «Проверить снова». Переключите вкладки на stage и на local. Панель демо открывает любое состояние: загрузка, ошибка, нет сети (оба варианта), 403, 429, нет проектов, проекты не загрузились, отказ буфера обмена, неизвестное имя в адресе и ссылка из «Уведомлений».</p>
</div><dl class="tok">
<dt>Цвет</dt><dd>Только токены Paper Desk. Охра (warning) — «не задано»: это дело, а не ошибка. Мох — «задано» и следующее действие. Серый (утоплённый) — «отсюда не видно» или «не проверено». Глина (danger) — только если не удалась сама проверка.</dd>
<dt>Шрифты</dt><dd>Source Serif 4 — заголовки, сводка и «Зачем» в инструкции. Source Sans 3 — интерфейс. Source Code Pro — имена и команды. Все под OFL.</dd>
<dt>Новые токены</dt><dd>Предлагаю в кит: колонка списка на Mac 440, высота вкладки 52, значок сводки 40, значок шага инструкции 24, черта строки 3. Из #24 взяты: отступы 4–40, цель касания 44, штамп 64, шаг задержки 70 мс, затухание 120 мс.</dd>
<dt>Новое в ките</dt><dd>Тона <code>StatusChip</code> для «задано / не задано / не видно» со значком. Простая контурная <code>Tag</code>. Сегментный вариант списка вкладок <code>Lanes</code> из кита (вкладка в две строки). <code>CodeLine</code> с «Копировать» и заметкой о неудачном копировании (из #24). Раскладка «список и деталь» для колонки «Настроек» на Mac.</dd>
<dt>Движение</dt><dd>быстро 140 · обычно 240 · медленно 380 · штамп 620 мс. Двигаются только transform, opacity и прорисовка линий. Нет автоопроса и нет зацикленного движения, кроме пульса скелетона, который при «Меньше движения» выключается.</dd>
</dl></div>'''


# The demo state bar; OPT(key, values) renders translated <option>s.
def demo(OPT):
    return f'''  <div class="demo" role="group" aria-label="Demo states" data-i18n-aria="demo.aria">
    <label><span data-i18n="demo.screen">Open</span><select id="d-screen"><option value="">—</option>{OPT('demo.s', ['settings', 'env', 'tabOther', 'tabLocal', 'gVapid', 'gCf', 'gOwner', 'gAud', 'gRoutine', 'gApp', 'gGen', 'gUnknown', 'deep'])}</select></label>
    <label><span data-i18n="demo.this">This console runs on</span><select id="d-this"><option value="dev">dev</option><option value="stage">stage</option><option value="production">production</option></select></label>
    <label><span data-i18n="demo.call">Status call</span><select id="d-call">{OPT('demo.c', ['ok', 'loading', 'error', 'offline', 'offline0', 'forbidden', 'rate'])}</select></label>
    <label><input type="checkbox" id="d-all"><span data-i18n="demo.allSet">Everything visible is set</span></label>
    <label><span data-i18n="demo.proj">Projects</span><select id="d-proj">{OPT('demo.p', ['two', 'none', 'error'])}</select></label>
    <label><span data-i18n="demo.next">Next Check again</span><select id="d-next">{OPT('demo.n', ['same', 'fixed', 'error'])}</select></label>
    <label><input type="checkbox" id="d-copy"><span data-i18n="demo.copyFail">Clipboard refuses</span></label>
    <p class="demo__help" data-i18n="demo.help"></p>
  </div>
'''
