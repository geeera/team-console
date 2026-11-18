# #775 PR 3b: Run now and the jobs section on every project with an eligible runner. Page spec for build.py.
# Written next to the other issue folders (docs/design/<issue>-<slug>/wireframe.html) with its screenshots.
FILE = '../775-run-now/wireframe.html'
DOC_TITLE = 'Team Console · #775 · Run now everywhere'
KICKER = 'Team Console · #775 · design for approval'
TITLE = 'Run now on every project with a runner'
CSS = ['wide.css', 'runnow.css']
JS = ['wide-i18n.js', 'runnow-i18n.js', 'runnow.js']

NOTE_EN = '''
<div class="note__grid"><div>
<p><b>What you are approving.</b> How “Team jobs” and Run now look on a project that still keeps its tasks in GitHub Issues (#775, PR 3b), once a runner can serve it: iPhone at 375 px first, then the Mac, light and dark, ru and en. Flow, states and copy follow the UX spec on #775 with the architect’s §8 and the security note (R-RUN, Q8). The board is #766’s; nothing new is invented where the app has a part.</p>
<ul>
<li><b>Where it sits.</b> The board’s Runs section (the side column on the Mac, the Runs tab on the iPhone) now holds two blocks: “Team jobs” (<code>tc-board-jobs</code>: Run now, Now and queued, Recent jobs, with <code>tc-job-card</code>) and under it “GitHub run log” (<code>tc-sprint-run-list</code>, unchanged, with Full run log). A console-tracker project shows only the first. The Runs tile in the stats keeps the run log on a GitHub-tracker project (owner question 2).</li>
<li><b>Run now offers six kinds</b>: PM, dev and QA slots, Burn-down, Security audit, Digest. Review and PM chat are allowed by the API and start from their own places; Import and Kickoff are never offered. If the server still refuses a kind, the line under Run says so in clay and nothing is queued.</li>
<li><b>Availability, from the tile DTO</b> (<code>runnerAvailability</code>, the same answer the claim filter gives, so members see it too): <b>ready</b> adds no line; <b>offline</b> and <b>paused</b> are an ochre line above the form (Run still works, the job waits; the owner sees until when and a Runners link); <b>none</b> replaces the form with a block that names the cause and one way out.</li>
<li><b>None.</b> Owner: “No runner serves this project” with Open Settings › Runners. Member: the same title, and who can connect one (the owners, by name). <b>D3</b> on a two-owner account, if the owner answers “no”: the other owner sees “This runner doesn’t serve your projects” with Connect a runner; the runner’s owner sees “Your runner doesn’t serve this project” with Open the runner. Both carry “Why” (a subscription is personal).</li>
<li><b>Members</b> get no form and no header Run: one quiet line “Only the account owner can start jobs — Anna.” The jobs list stays readable; runner names show as the id tail, as today.</li>
<li><b>Motion.</b> Only the queued card slides in (240 ms); reduced motion: a 120 ms fade.</li>
</ul>
<p class="try">Try: press Run in the Runs section (or the header Run, which takes you there). Switch the state to offline and press Run again. Pick “none”, then “member”. Pick a D3 state: the page sets two owners.</p>
</div><dl class="tok">
<dt>Colour</dt><dd>Paper Desk tokens only. Ochre: offline, paused, a running job. Moss: a finished job. Clay: a failed job, a refused Run. Grey: queued, none, the member line.</dd>
<dt>Type</dt><dd>Source Serif 4 for section and card titles; Source Sans 3 for the interface; Source Code Pro for numbers.</dd>
<dt>New tokens</dt><dd>None.</dd>
<dt>New kit parts</dt><dd>One: the “no eligible runner” block (a compact state block with a cause, one action and a Why disclosure). Reused: <code>tc-run-now</code>, <code>tc-job-card</code>/<code>tc-status-card</code>, <code>tc-state-block</code>, the callout, <code>tc-sprint-run-list</code>, #766’s board and phone tabs.</dd>
</dl></div>'''

NOTE_RU = '''
<div class="note__grid"><div>
<p><b>Что вы утверждаете.</b> Как «Задачи команды» и «Запустить» выглядят на проекте, который ещё ведёт задачи в GitHub Issues (#775, PR 3b), когда его может обслужить раннер: сначала iPhone 375 px, потом Mac, светлая и тёмная тема, русский и английский. Сценарий, состояния и тексты — по UX-спеке на #775 с §8 архитектора и заметкой безопасности (R-RUN, Q8). Доска — из #766; где в приложении уже есть деталь, нового не придумано.</p>
<ul>
<li><b>Где это.</b> В разделе «Прогоны» доски (правая колонка на Mac, вкладка «Прогоны» на iPhone) теперь два блока: «Задачи команды» (<code>tc-board-jobs</code>: «Запустить сейчас», «Сейчас и в очереди», «Последние задачи» с <code>tc-job-card</code>) и под ним «Журнал прогонов GitHub» (<code>tc-sprint-run-list</code> без изменений, со ссылкой «Весь журнал прогонов»). На проекте с трекером консоли — только первый. Плитка «Прогоны» в статистике на GitHub-проекте по-прежнему читает журнал (вопрос владельцу 2).</li>
<li><b>«Запустить» предлагает шесть видов</b>: слоты PM, разработки и QA, «Добор задач», «Аудит безопасности», «Сводка». Ревью и чат с PM API разрешает, но запускаются они со своих мест; «Импорт» и «Старт проекта» не предлагаются никогда. Если сервер всё же отклонил вид, строка под кнопкой скажет это цветом глины, и ничего не встанет в очередь.</li>
<li><b>Доступность — из DTO плитки</b> (<code>runnerAvailability</code>, тот же ответ, что даст фильтр claim, поэтому её видят и участники): <b>готов</b> — без строки; <b>не в сети</b> и <b>на паузе</b> — охристая строка над формой («Запустить» работает, задача ждёт; владелец видит, до какого времени, и ссылку «Раннеры»); <b>нет</b> — вместо формы блок, который называет причину и один выход.</li>
<li><b>Нет раннера.</b> Владелец: «Нет раннера для этого проекта» и «Открыть Настройки › Раннеры». Участник: тот же заголовок и кто может подключить раннер (владельцы по имени). <b>D3</b> на аккаунте с двумя владельцами, если ответ «нет»: другой владелец видит «Этот раннер не обслуживает ваши проекты» и «Подключить раннер», владелец раннера — «Ваш раннер не обслуживает этот проект» и «Открыть раннер». У обоих — «Почему так» (подписка личная).</li>
<li><b>Участники</b> не видят формы и «Запустить» в шапке: одна спокойная строка «Запускать задачи может владелец аккаунта — Анна.» Список задач читается; имя раннера — хвост id, как сейчас.</li>
<li><b>Движение.</b> Только новая карточка в очереди выезжает (240 мс); при «Меньше движения» — затухание 120 мс.</li>
</ul>
<p class="try">Попробуйте: нажмите «Запустить» в разделе «Прогоны» (или «Запустить» в шапке — она переведёт туда). Переключите состояние на «не в сети» и запустите ещё раз. Выберите «нет подходящего раннера», затем «участник». Выберите состояние D3 — страница поставит двух владельцев.</p>
</div><dl class="tok">
<dt>Цвет</dt><dd>Только токены Paper Desk. Охра — не в сети, пауза, задача выполняется. Мох — задача завершена. Глина — сбой, отклонённый запуск. Серый — в очереди, нет раннера, строка участника.</dd>
<dt>Шрифты</dt><dd>Source Serif 4 — заголовки разделов и карточек; Source Sans 3 — интерфейс; Source Code Pro — числа.</dd>
<dt>Новые токены</dt><dd>Нет.</dd>
<dt>Новое в ките</dt><dd>Одно: блок «нет подходящего раннера» (компактный state-block с причиной, одним действием и раскрытием «Почему так»). Переиспользуются: <code>tc-run-now</code>, <code>tc-job-card</code>/<code>tc-status-card</code>, <code>tc-state-block</code>, выноска, <code>tc-sprint-run-list</code>, доска и вкладки iPhone из #766.</dd>
</dl></div>'''

STATES = ['ready', 'readyEmpty', 'offline', 'paused', 'none', 'd3', 'd3mine', 'loading', 'error', 'refused']


def demo(OPT):
    return f'''  <div class="demo" role="group" aria-label="Demo states" data-i18n-aria="demo.aria">
    <label><span data-i18n="demo.state">State</span><select id="d-state">{OPT('demo.s', STATES)}</select></label>
    <label><span data-i18n="demo.role">You are</span><select id="d-role">{OPT('demo.r', ['owner', 'member'])}</select></label>
    <label><span data-i18n="demo.tracker">Tracker</span><select id="d-tracker">{OPT('demo.t', ['github', 'console'])}</select></label>
    <label><span data-i18n="demo.owners">Account owners</span><select id="d-owners">{OPT('demo.o', ['one', 'two'])}</select></label>
    <p class="demo__help" data-i18n="demo.help"></p>
  </div>
'''
