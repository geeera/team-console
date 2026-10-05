# #29 Team commands, the rest after #114: sprint, requests to the PM, batch approve, snooze, status, entry points.
# Page spec for build.py.
FILE = '29-team-commands.html'
DOC_TITLE = 'Team Console · #29 · Team commands: sprint, requests, batch approve, notifications'
KICKER = 'Team Console · #29 · design for approval'
TITLE = 'Team commands: sprint, requests to the PM, batch approve, notifications'
CSS = ['commands.css', 'commands29.css']
JS = ['commands-i18n.js', 'commands29-i18n.js', 'commands29.js']

NOTE_EN = '''
<div class="note__grid"><div>
<p><b>What you are approving.</b> The rest of the Commands panel after #114 (pause and Run now are already approved and appear here unchanged), on iPhone first and on Mac, light and dark, ru and en. Flow and copy follow the #29 UX spec, rescoped by plan #112: moving an issue between sprints and up or down the queue is a <b>request the PM honours</b>; the console never sets the sprint itself, and tier changes are gone.</p>
<ul>
<li><b>The status card</b> at the top of the panel says everything in words: state, sprint with demo and freeze, done so far, what is in progress, how many questions wait for you, the last and the next run.</li>
<li><b>Sprint</b>: Move the demo (a date with the freeze days shown live; past dates and dates after the next sprint are refused; a warning if freeze would start at once) and Start the next sprint (the default date is two weeks after the current demo; once it exists, the row just says so).</li>
<li><b>Ask the PM about an issue</b>: pick an issue, then ask to move it to the current or next sprint or the backlog, and up or down the queue. A line above the button reads back what you are asking for. The request is recorded on the issue as yours; until the PM acts, the board and the picker show an ochre “waiting for the PM”, and the PM’s answer shows up in the picker.</li>
<li><b>Approve team recommendations</b>: one dialog with everything that is safe to approve together, ticked by default; what was left out (money, release, legal, access, a design, or a recommendation to reject) is listed with the reason. If GitHub drops some, only those stay with Try again.</li>
<li><b>Snooze notifications</b> for one project on all your devices: for an hour, until 9:00, for a week, or until you turn them back on, with urgent ones still coming by default. No confirmation, and one tap turns them back on. A snoozed project shows a bell with an ink slash and the words in All projects and the sidebar.</li>
<li><b>Ways in</b>: Commands in the space (<kbd>K</kbd> on the Mac), the Commands button on every All projects card, “Approve team recommendations (N)” in Needs you, and on the board: Move demo by the sprint title, Ask on each issue, Pause / Resume at the foot. A command from outside the panel answers with a toast.</li>
<li><b>Motion</b>: a moved demo date turns like a desk-calendar leaf, a new “waiting for the PM” chip settles in, approved cards slide off Needs you before the result note draws its tick, and the snooze bell’s slash is drawn in ink. Reduced motion: 120 ms fades. There is no stamp here either.</li>
</ul>
<p class="try">Try on iPhone: Commands → Move (pick a date inside the freeze, then a past one) → Ask the PM: Pick an issue → #45 → Next sprint, Up → Send. Open the Board tab: #45 now waits for the PM. Then Needs you → Approve team recommendations, untick one, Approve. Tap the project name for All projects and open fieldnote’s Commands: its notifications are snoozed. Set “Next command” to “changed meanwhile” to see the conflict and partial states.</p>
</div><dl class="tok">
<dt>Colour</dt><dd>Paper Desk tokens only: moss for the next action and “done”, ochre for what waits (a request for the PM, freeze, snoozed), clay for failures, grey for “nothing changed” and what was left out.</dd>
<dt>Type</dt><dd>Source Serif 4 for titles, the request read-back and question titles; Source Sans 3 for the interface; Source Code Pro only for issue numbers. All OFL.</dd>
<dt>Tokens</dt><dd>Nothing new beyond #24 and #114. The date and every option row are 44 pt targets on iPhone.</dd>
<dt>Kit</dt><dd>Reused from #114: the panel frame, command rows with a reason when off, async confirmation, Receipt, Toast. New: an option list (radio rows) and a three-way segmented choice, a checkbox list with a “left out” disclosure, a “waiting” chip, the issue picker (search + list).</dd>
<dt>Motion</dt><dd>base 240 ms for the leaf turn, the chip and the slide-off (stagger 70 ms); slow 380 ms for the ink strokes; only transform, opacity and stroke move.</dd>
</dl></div>'''

NOTE_RU = '''
<div class="note__grid"><div>
<p><b>Что утверждаешь.</b> Остальную часть панели «Команды» после #114 (пауза и «Запустить сейчас» уже одобрены и показаны здесь без изменений) — сначала на iPhone, потом на Mac, в светлой и тёмной теме, на русском и английском. Сценарий и тексты — по UX-спеке #29 с поправкой плана #112: перенос задачи между спринтами и вверх или вниз по очереди — это <b>просьба, которую учитывает PM</b>. Консоль сама спринт не меняет, смены уровня сложности больше нет.</p>
<ul>
<li><b>Карточка статуса</b> вверху панели говорит всё словами: состояние, спринт с датой демо и заморозкой, сколько готово, что в работе, сколько вопросов ждут тебя, последний и следующий прогон.</li>
<li><b>Спринт</b>: «Перенести демо» — дата, под ней сразу видны дни заморозки. Прошедшие даты и даты позже следующего спринта не принимаются; если заморозка начнётся сразу, будет предупреждение. «Начать следующий спринт» — по умолчанию через две недели после текущего демо; когда спринт уже создан, строка просто говорит об этом.</li>
<li><b>Попросить PM о задаче</b>: выбираешь задачу и просишь перенести её в текущий или следующий спринт или в бэклог, поднять или опустить в очереди. Над кнопкой — строка, которая повторяет просьбу словами. Просьба записывается в задачу от твоего имени. Пока PM не ответил, на доске и в списке задач горит охристое «ждёт PM», а ответ PM виден в списке.</li>
<li><b>Одобрить советы команды</b>: один диалог со всем, что безопасно одобрить разом, галочки уже стоят. Что не вошло (деньги, релиз, юридическое, доступы, дизайн или совет отклонить), перечислено с причиной. Если GitHub часть не принял, в диалоге остаются только они и кнопка «Повторить».</li>
<li><b>Отложить уведомления</b> одного проекта на всех устройствах: на час, до 9:00, на неделю или пока не включишь; срочное по умолчанию всё равно приходит. Без подтверждения, включить обратно — одно касание. У отложенного проекта во «Всех проектах» и в боковой панели — колокольчик, перечёркнутый чернилами, и слова.</li>
<li><b>Откуда открывается</b>: «Команды» в пространстве проекта (<kbd>K</kbd> на Mac), кнопка «Команды» на каждой карточке «Всех проектов», «Одобрить советы команды (N)» в «Ждут тебя» и доска: «Перенести демо» у названия спринта, «Попросить» у каждой задачи, «Приостановить / Возобновить» внизу. Если команда отдана не из панели, итог приходит всплывающей заметкой.</li>
<li><b>Движение</b>: перенесённая дата демо перелистывается, как листок настольного календаря; новая метка «ждёт PM» мягко появляется; одобренные карточки уезжают из «Ждут тебя», и галочка итога прорисовывается чернилами; у колокольчика прорисовывается черта. При «Меньше движения» — затухание 120 мс. Штампа здесь тоже нет.</li>
</ul>
<p class="try">Попробуй на iPhone: «Команды» → «Перенести» (выбери дату в заморозке, потом прошедшую) → «Попросить PM о задаче»: «Выбрать задачу» → #45 → «Следующий», «Выше» → «Отправить просьбу». Открой вкладку «Доска»: у #45 теперь «ждёт PM». Потом «Ждут тебя» → «Одобрить советы команды», сними одну галочку, «Одобрить». Нажми на название проекта — откроются «Все проекты»; открой «Команды» у fieldnote: его уведомления отложены. Поставь «Следующая команда: изменилось за это время», чтобы увидеть конфликт и частичный итог.</p>
</div><dl class="tok">
<dt>Цвет</dt><dd>Только токены Paper Desk: мох — следующее действие и «сделано», охра — то, что ждёт (просьба к PM, заморозка, отложенные уведомления), глина — ошибки, серый — «ничего не изменилось» и то, что не вошло.</dd>
<dt>Шрифты</dt><dd>Source Serif 4 — заголовки, строка с просьбой и названия вопросов; Source Sans 3 — интерфейс; Source Code Pro — только номера задач. Все под OFL.</dd>
<dt>Токены</dt><dd>Новых нет, кроме добавленных в #24 и #114. Дата и каждая строка выбора — цель касания 44 pt на iPhone.</dd>
<dt>Кит</dt><dd>Из #114: рамка панели, строки команд с причиной, почему выключено, подтверждение с ожиданием, Receipt, тост. Новое: список вариантов (строки-радио) и выбор из трёх сегментов, список с галочками и раскрывашкой «не вошли», метка «ждёт», выбор задачи (поиск и список).</dd>
<dt>Движение</dt><dd>обычно 240 мс — перелистывание даты, метка и уход карточек (шаг 70 мс); медленно 380 мс — линии чернилами; двигаются только transform, opacity и прорисовка линий.</dd>
</dl></div>'''


# The demo state bar; OPT(key, values) renders translated <option>s.
def demo(OPT):
    return f'''  <div class="demo" role="group" aria-label="Demo states" data-i18n-aria="demo.aria">
    <label><span data-i18n="demo.screen">Screen</span><select id="d-screen"><option value="">—</option>{OPT('demo.s', ['space', 'panel', 'board', 'all', 'needs', 'demo', 'next', 'pick', 'form', 'batch', 'snooze'])}</select></label>
    <label><span data-i18n="demo.proj">Team</span><select id="d-proj">{OPT('demo.p', ['running', 'owner', 'team'])}</select></label>
    <label><span data-i18n="demo.data">Status</span><select id="d-data">{OPT('demo.d', ['ok', 'loading', 'error', 'offline', 'noperm', 'nopush'])}</select></label>
    <label><span data-i18n="demo.outcome">Next command</span><select id="d-outcome">{OPT('demo.o', ['ok', 'error', 'rate', 'conflict'])}</select></label>
    <label><input type="checkbox" id="d-freeze"><span data-i18n="demo.freeze">Freeze days</span></label>
    <label><input type="checkbox" id="d-nosprint"><span data-i18n="demo.nosprint">No current sprint</span></label>
    <label><input type="checkbox" id="d-next"><span data-i18n="demo.nextExists">Next sprint already exists</span></label>
    <label><input type="checkbox" id="d-nosafe"><span data-i18n="demo.nosafe">Nothing safe to approve</span></label>
    <p class="demo__help" data-i18n="demo.help"></p>
  </div>
'''
