# #759 Actions onboarding: run a project on GitHub Actions. Page spec for build.py.
# Written next to the other issue folders (docs/design/<issue>-<slug>/wireframe.html) with its screenshots.
FILE = '../759-actions-onboarding/wireframe.html'
DOC_TITLE = 'Team Console · #759 · Actions onboarding'
KICKER = 'Team Console · #759 · design for approval'
TITLE = 'Actions onboarding: run a project on GitHub Actions'
CSS = ['settings.css', 'env.css', 'projenv.css', 'actions.css']
JS = ['env-i18n.js', 'projenv-i18n.js', 'actions-i18n.js', 'actions.js']

NOTE_EN = '''
<div class="note__grid"><div>
<p><b>What you are approving.</b> How a customer moves a project onto GitHub Actions (#759) without the eight hand-made GitHub settings: iPhone first, then the Mac, light and dark, ru and en. Flow, states and copy follow the UX spec on #759 with the architect’s and security notes (the console never creates the Environment and never sees the key). This page decides how it looks and moves.</p>
<ul>
<li><b>Project setup gains a sibling row.</b> Under the five-step checklist: “Run on GitHub Actions” (a moss play mark, “Jobs in your repository, no machine of yours needed”, chip Off / On / Not ready: N), and under it the operator-only #750 “Project environment” row. A customer sees one row, the operator both. For a project still on its runners the row makes no readiness call.</li>
<li><b>The page</b> <code>/settings/projects/storify/actions</code> is #24’s setup ledger, not #750’s secret list: a numbered job in six steps grouped by where you act. The summary is the setup page’s margin note (ochre “2 steps missing”, moss “All set — just switch it on”, clay drift) with #104’s Checked at · Check again; the GitHub minutes note sits under it.</li>
<li><b>Steps.</b> 1 API key (link to Team). 2 App permissions, with “Which permissions, and why” always there and the ruleset advice. 3 the <code>team-console</code> GitHub environment: four sub-checks, each an icon and a word (done, missing, wrong, warning, not checked), one link to the exact GitHub page and How to do it with Copy for <code>team-console</code>, <code>main</code> and <code>TC_INFERENCE_API_KEY</code>, the key-stays-on-GitHub note in a moss margin. 4 the workflow file: the path with Copy, then one of the PR states. 5 Switch on. 6 the first job, only once it is on. The first step that is not done carries a light ochre wash and opens its How to do it.</li>
<li><b>Step 4’s PR states</b> are one slip (number, title, branch → main, a word tag): open (Open PR #42 on GitHub is primary), older version, left over after a hand commit, and <b>not from the console</b>, drawn in clay with an outline and “Don’t merge it until you’ve checked it”: the page never says “merge” there. Update available is an ochre outline mark that never blocks; below the minimum and a changed file block. With the kill switch on, or without Workflows write, “Show the file” becomes primary and opens the copy path inline: version and sha256, the file in its own scrolling region, Copy, “Create the file on GitHub”.</li>
<li><b>States:</b> loading (titles only, the slow line after 3 s), partial, permissions not accepted (the secret reads “not checked”, never done; the summary never says ready), subscription, no environment, wrong branch rule, reviewers or a timer (a warning, step stays done), repository unverified, all ready, on and waiting, first job done (the #104 ink stamp on the summary), first job failed, drift, the PR refusals (409, 422, 429), console can’t build the file (503), Switch on refused, GitHub unavailable, other error, rate limited, offline with and without a snapshot, 404, and a member’s 403: a lock block, no steps, no GitHub calls.</li>
<li><b>Runners › Where jobs run.</b> The radio never navigates (WCAG 3.2.2). Choosing “On GitHub Actions” checks once and shows a line under the group: Checking the repository…, ready (moss), not ready: N steps (ochre) with “Prepare the repository”, or couldn’t check. Save is aria-disabled while the repository is known not ready and, pressed, takes focus to that link. The server’s <code>actions-not-ready</code> refusal is a clay banner naming the items, with the same link.</li>
<li><b>Motion.</b> Nothing new: page push, disclosures, #24’s ink on steps that turn done after Check again, and #104’s stamp once, for the first green job. Reduced motion: a 120 ms fade.</li>
</ul>
<p class="try">Try on iPhone: Project setup → Run on GitHub Actions → step 3 How to do it → Copy. Step 4: Open a PR with the file. Set Next Check again to “you did the GitHub steps”, press Check again, then Switch on, then Check again once more. In Runners choose On GitHub Actions. The checkbox “Owner question 4” shows step 2 for a separate setup app.</p>
</div><dl class="tok">
<dt>Colour</dt><dd>Paper Desk tokens only. Ochre: a step to do, a warning. Moss: done, on, the next action. Clay: a PR not from the console, drift, a refusal, a failed job. Grey: not checked, loading, the member lock.</dd>
<dt>Type</dt><dd>Source Serif 4 for titles and the summary; Source Sans 3 for the interface and the small-caps words; Source Code Pro for names, branches, the path and the file. All OFL, self-hosted.</dd>
<dt>New tokens</dt><dd>One: <code>--yml-max</code> 240 px, the file region’s height.</dd>
<dt>New kit parts</dt><dd>Sub-check line (icon + small-caps word + text), PR slip, inline file region, readiness line under a radio group. Reused: <code>tc-setup-checklist</code> (ledger, step, mark, word, How to do it), <code>tc-list-row</code> + <code>tc-chip</code>, <code>tc-copy-code</code>, state-block, the margin note and #104’s summary foot.</dd>
<dt>Motion</dt><dd>fast 140 · base 240 · stamp 620 ms; only transform, opacity and stroke draw; one polite announcement per check.</dd>
</dl></div>'''

NOTE_RU = '''
<div class="note__grid"><div>
<p><b>Что вы утверждаете.</b> Как клиент переводит проект на GitHub Actions (#759) без восьми ручных настроек на GitHub: сначала iPhone, потом Mac, светлая и тёмная тема, русский и английский. Сценарий, состояния и тексты — по UX-спеке на #759 с заметками архитектора и безопасности (консоль не создаёт окружение и никогда не видит ключ). Эта страница решает, как это выглядит и двигается.</p>
<ul>
<li><b>В настройке проекта — соседняя строка.</b> Под пятью шагами: «Запуск на GitHub Actions» (знак запуска цвета мха, «Задания в вашем репозитории, без своей машины», чип «Не включено» / «Включено» / «Не готово: N»), под ней — строка «Окружение проекта» из #750, только для оператора. Клиент видит одну строку, оператор — обе. Пока проект на своих раннерах, строка готовность не проверяет.</li>
<li><b>Страница</b> <code>/settings/projects/storify/actions</code> — чек-лист настройки из #24, а не список секретов из #750: работа в шесть пронумерованных шагов, сгруппированных по тому, где вы действуете. Сводка — заметка на полях со страницы настройки (охра «Не хватает 2 шагов», мох «Всё готово — осталось включить», глина при поломке) с низом из #104: «Проверено в…» и «Проверить снова»; под ней — заметка про минуты GitHub.</li>
<li><b>Шаги.</b> 1 — API-ключ (ссылка на «Команду»). 2 — права приложения; «Какие права и зачем» есть всегда, там же совет про ruleset. 3 — окружение GitHub <code>team-console</code>: четыре подпроверки, у каждой значок и слово (готово, нет, неверно, внимание, не проверено), одна ссылка на нужную страницу GitHub и «Как сделать» с «Копировать» для <code>team-console</code>, <code>main</code> и <code>TC_INFERENCE_API_KEY</code>; заметка «ключ только в GitHub» — на полях цвета мха. 4 — файл workflow: путь с «Копировать», затем одно из состояний PR. 5 — «Включить». 6 — первое задание, только после включения. Первый невыполненный шаг подсвечен светлой охрой, его «Как сделать» открыт.</li>
<li><b>Состояния PR в шаге 4</b> — одна карточка (номер, заголовок, ветка → main, метка-слово): открыт («Открыть PR #42 на GitHub» — главная кнопка), прежняя версия, остался после ручного коммита и <b>не от консоли</b> — глиной, с обводкой и «Не мержите его, пока не проверите»; слова «смержите» там нет никогда. «Можно обновить» — охристый контур, не блокирует; версия ниже минимальной и изменённый файл блокируют. Если PR выключены аварийным выключателем или у приложения нет Workflows write, главной становится «Показать файл»: путь копирования раскрывается прямо в шаге — версия и sha256, файл в своей прокручиваемой области, «Копировать», «Создать файл на GitHub».</li>
<li><b>Состояния:</b> загрузка (только заголовки, через 3 с — строка про время), частично, права не приняты (секрет — «не проверено», никогда не «готово»; сводка никогда не говорит «готово»), подписка, нет окружения, неверное правило ветки, одобрение или таймер (предупреждение, шаг остаётся готовым), репозиторий не подтверждён, всё готово, включено и ждём, первое задание прошло (чернильный штамп из #104 на сводке), первое задание не прошло, поломка после включения, отказы PR (409, 422, 429), консоль не может собрать файл (503), отказ «Включить», GitHub недоступен, другая ошибка, слишком часто, нет сети со снимком и без, 404 и 403 участника: блок с замком, без шагов и без запросов к GitHub.</li>
<li><b>«Раннеры» › «Где выполнять задания».</b> Радиокнопка никуда не уводит (WCAG 3.2.2). Выбор «На GitHub Actions» один раз проверяет репозиторий и показывает строку под группой: «Проверяем репозиторий…», готово (мох), не хватает N шагов (охра) со ссылкой «Подготовить репозиторий» или «Не удалось проверить». «Сохранить» — aria-disabled, пока известно, что репозиторий не готов; нажатие переводит фокус на эту ссылку. Отказ сервера <code>actions-not-ready</code> — баннер цвета глины с перечнем пунктов и той же ссылкой.</li>
<li><b>Движение.</b> Ничего нового: переход страницы, раскрытие блоков, чернила #24 на шагах, ставших готовыми после «Проверить снова», и штамп #104 — один раз, на первое зелёное задание. При «Меньше движения» — затухание 120 мс.</li>
</ul>
<p class="try">Попробуйте на iPhone: «Настройка проекта» → «Запуск на GitHub Actions» → шаг 3 «Как сделать» → «Копировать». Шаг 4: «Открыть PR с файлом». Поставьте «Следующая „Проверить снова“: вы сделали шаги на GitHub», нажмите «Проверить снова», затем «Включить» и ещё раз «Проверить снова». В «Раннерах» выберите «На GitHub Actions». Флажок «Вопрос 4» показывает шаг 2 для отдельного приложения настройки.</p>
</div><dl class="tok">
<dt>Цвет</dt><dd>Только токены Paper Desk. Охра — шаг, который надо сделать, предупреждение. Мох — готово, включено, следующее действие. Глина — PR не от консоли, поломка, отказ, неудачное задание. Серый — не проверено, загрузка, замок участника.</dd>
<dt>Шрифты</dt><dd>Source Serif 4 — заголовки и сводка; Source Sans 3 — интерфейс и слова капителью; Source Code Pro — имена, ветки, путь и файл. Все под OFL, шрифты у нас.</dd>
<dt>Новые токены</dt><dd>Один: <code>--yml-max</code> 240 px — высота области с файлом.</dd>
<dt>Новое в ките</dt><dd>Строка подпроверки (значок + слово капителью + текст), карточка PR, встроенная область файла, строка готовности под группой радиокнопок. Переиспользуются: <code>tc-setup-checklist</code> (чек-лист, шаг, знак, слово, «Как сделать»), <code>tc-list-row</code> + <code>tc-chip</code>, <code>tc-copy-code</code>, state-block, заметка на полях и низ сводки из #104.</dd>
<dt>Движение</dt><dd>быстро 140 · обычно 240 · штамп 620 мс; двигаются только transform, opacity и прорисовка линий; одно вежливое объявление на проверку.</dd>
</dl></div>'''

STATES = ['setupOff', 'setupCustomer', 'setupOn', 'setupDrift',
          'loading', 'partial', 'perms', 'subscription', 'envMissing', 'envWrong', 'rulesWarn', 'repoUnverified',
          'ready', 'waiting', 'success', 'runFailed', 'drift',
          'prOpen', 'copy', 'outdated', 'unsupported', 'modified', 'stale', 'foreign', 'leftover', 'prOff', 'misconfigured',
          'prTampered', 'prPerm', 'prRate', 'switchRefused',
          'github', 'error', 'rate', 'offline', 'offline0', 'forbidden', 'notFound',
          'runnersChecking', 'runnersMissing', 'runnersOk', 'runnersFailed', 'runnersRefused']


def demo(OPT):
    return f'''  <div class="demo" role="group" aria-label="Demo states" data-i18n-aria="demo.aria">
    <label><span data-i18n="demo.state">State</span><select id="d-state">{OPT('demo.s', STATES)}</select></label>
    <label><span data-i18n="demo.next">Next Check again</span><select id="d-next">{OPT('demo.n', ['same', 'fixed', 'error'])}</select></label>
    <label><input type="checkbox" id="d-copy"><span data-i18n="demo.copyFail">Clipboard refuses</span></label>
    <label><input type="checkbox" id="d-setupapp"><span data-i18n="demo.setupApp">Owner question 4: a separate setup app</span></label>
    <p class="demo__help" data-i18n="demo.help"></p>
  </div>
'''
