# #750 Environment setup per project, and the operator's console environment. Page spec for build.py.
# Written next to the other issue folders (docs/design/<issue>-<slug>/wireframe.html) with its screenshots.
FILE = '../750-project-environment/wireframe.html'
DOC_TITLE = 'Team Console · #750 · Environment setup per project'
KICKER = 'Team Console · #750 · design for approval'
TITLE = 'Environment setup per project'
CSS = ['settings.css', 'env.css', 'projenv.css']
JS = ['env-i18n.js', 'projenv-i18n.js', 'projenv.js']

NOTE_EN = '''
<div class="note__grid"><div>
<p><b>What you are approving.</b> How environment setup looks once it leaves Settings (#750): each project gets its own screen under project setup, and the console’s own rows move to an operator-only area. iPhone first, then the Mac, light and dark, ru and en. Flow, states and copy follow the UX spec on #750 and your answers (operator area <code>/admin/environment/:env</code>, build now, adding a project still ends on project setup). Everything else is the approved #104 design, reused as it is.</p>
<ul>
<li><b>Project setup gains one row.</b> Right under the five-step checklist: a key mark, “Project environment”, <code>production</code> · project secrets and the #104 chip (Missing: 1 / All set / Checking… / Not checked). On the iPhone the chip moves under the title. Step 5’s “How to fix” ends with the moss link “Open the project environment”. A customer never sees the row.</li>
<li><b>The project screen</b> (<code>/settings/projects/storify/environment</code>) has no tabs: one section per environment that has rows for this project, this console’s first with the moss dot and “this console”. Today that is one section, production. The environments with nothing to set share one quiet dashed line at the end.</li>
<li><b>Inside a section:</b> the #104 summary slip (count in an ochre circle, one <code>setup --env production</code> command, “Go to the first missing one”, Check again), then “Required” and “Optional — for Run now” as small caps headings. The required row carries the ochre rule and its one-line fix; optional rows carry the small caps “optional” tag, never the rule, and never count: when only they are missing the summary is the moss “Everything storify needs in production is set” with a plain “Optional not set: 2”.</li>
<li><b>Guides</b> are the #104 letter: the name in monospace, tags (status, secret, “api Worker · project storify”, you enter it, needed by), the never-value line, What it’s for · What breaks · Where to get it · Lifetime · Gotchas · How to set it. A page of its own on the iPhone (back reads “storify environment”), a pane beside the list on the Mac. The manifest prose is Russian; in English the guide says so once, in a grey note.</li>
<li><b>States:</b> loading (rows already listed, no status word), all set, missing, not visible from here (a dev console shows “Not visible here” and the <code>--check</code> command), failed with Try again, offline with and without a snapshot, rate limited, nothing to set, an unknown project (the setup page’s not-found), a guide name that is not this project’s, and 403: a lock block “The console operator sets this project’s secrets” with no row names at all and a way back to project setup.</li>
<li><b>Operator area.</b> Settings ends with a “Console operator” section: one row, “Console environment”, <code>production</code> · Workers, GitHub, local runs, and the chip. It sits last, above the version line, so it never shifts anything when it appears; a customer’s Settings has no Environment section at all. It opens <code>/admin/environment/production</code>: the #104 screen with its four tabs and the projects group gone. A customer who types the URL gets the lock block “Only the console’s operator can see its environment”.</li>
<li><b>Motion.</b> Nothing new: page push, pane slide and the #104 ink stamp when Check again finds the last required item set. Optional rows never trigger it. Reduced motion: a 120 ms fade.</li>
</ul>
<p class="try">Try on iPhone: Project setup → Project environment → “Go to the first missing one” → open the row → Copy. Back, set “Next Check again” to “you ran setup” and press Check again. Then Settings: the operator section, its console screen, and the customer variants in the State list.</p>
</div><dl class="tok">
<dt>Colour</dt><dd>Paper Desk tokens only. Ochre: missing (a to-do, not an error). Moss: set, this console, the next action. Grey (sunken): not visible here, not checked, the forbidden lock. Clay: only when the check itself failed.</dd>
<dt>Type</dt><dd>Source Serif 4 for titles and the summary; Source Sans 3 for the interface and the small caps sub-headings; Source Code Pro for names, environments and commands. All OFL, self-hosted.</dd>
<dt>New tokens</dt><dd>None. Everything is on #104’s additions (list column 440, summary mark 40, row rule 3) and the base scale.</dd>
<dt>New kit parts</dt><dd>None. Reused: <code>tc-list-row</code> with <code>tc-chip</code> (the two entry rows), StatusChip, Tag, CodeLine, state-block (lock), the #104 summary, row and guide. The section heading with the “this console” dot is the #104 tab label laid flat.</dd>
<dt>Motion</dt><dd>fast 140 · base 240 · stamp 620 ms; only transform, opacity and stroke draw; one polite announcement per check.</dd>
</dl></div>'''

NOTE_RU = '''
<div class="note__grid"><div>
<p><b>Что вы утверждаете.</b> Как выглядит настройка окружения, когда она уходит из «Настроек» (#750): у каждого проекта свой экран внутри настройки проекта, а строки самой консоли переезжают в область оператора. Сначала iPhone, потом Mac, светлая и тёмная тема, русский и английский. Сценарий, состояния и тексты — по UX-спеке на #750 и вашим ответам (область оператора <code>/admin/environment/:env</code>, делаем сейчас, добавление проекта по-прежнему заканчивается на настройке проекта). Всё остальное — утверждённый дизайн #104 без изменений.</p>
<ul>
<li><b>В настройке проекта появляется одна строка.</b> Сразу под пятью шагами: значок ключа, «Окружение проекта», <code>production</code> · секреты проекта и чип из #104 («Не задано: 1» / «Всё задано» / «Проверяем…» / «Не проверено»). На iPhone чип уходит под заголовок. «Как сделать» у шага 5 заканчивается ссылкой цвета мха «Открыть окружение проекта». Клиент эту строку не видит.</li>
<li><b>Экран проекта</b> (<code>/settings/projects/storify/environment</code>) без вкладок: по секции на каждое окружение, где у проекта есть строки, первым — окружение этой консоли с точкой цвета мха и подписью «эта консоль». Сейчас это одна секция, production. Окружения, где задавать нечего, собраны в одну тихую строку под пунктиром в конце.</li>
<li><b>Внутри секции:</b> сводка из #104 (число в охристом круге, одна команда <code>setup --env production</code>, «К первой незаданной», «Проверить снова»), затем «Обязательные» и «Необязательные — для „Запустить сейчас“» капителью. У обязательной строки — охристая черта и однострочное исправление; у необязательных — капитель «необязательно», без черты, и в счёт они не идут: если не хватает только их, сводка зелёная — «Для storify в production задано всё обязательное» — с простой строкой «Необязательных не задано: 2».</li>
<li><b>Инструкции</b> — письмо из #104: имя моноширинным, метки (статус, секрет, «Worker api · проект storify», вводите вы, кому нужен), строка о том, что значение не показывается, затем «Зачем» · «Что сломается» · «Где взять» · «Срок жизни» · «Подводные камни» · «Как задать». На iPhone — отдельная страница (назад — «Окружение storify»), на Mac — панель рядом со списком. Текст из манифеста — на русском; в английском интерфейсе инструкция один раз говорит об этом серой заметкой.</li>
<li><b>Состояния:</b> загрузка (строки уже в списке, без слова статуса), всё задано, не задано, отсюда не видно (консоль dev показывает «Отсюда не видно» и команду с <code>--check</code>), ошибка с «Повторить», нет сети со снимком и без, слишком много проверок, задавать нечего, неизвестный проект (как «не найден» у настройки), имя инструкции не этого проекта, и 403: блок с замком «Секреты проекта задаёт оператор консоли» — без единого имени строки — и путь назад к настройке проекта.</li>
<li><b>Область оператора.</b> «Настройки» заканчиваются разделом «Оператор консоли»: одна строка «Окружение консоли», <code>production</code> · Worker’ы, GitHub, локальный запуск, и чип. Раздел стоит последним, над строкой версии, поэтому, появляясь, ничего не сдвигает; у клиента в «Настройках» раздела про окружение нет совсем. Строка открывает <code>/admin/environment/production</code>: экран #104 с четырьмя вкладками, но уже без группы проектов. Клиент, набравший адрес вручную, видит блок с замком «Окружение консоли видит только её оператор».</li>
<li><b>Движение.</b> Ничего нового: переход страницы, выезд панели и чернильный штамп из #104, когда «Проверить снова» находит последнюю обязательную настройку заданной. Необязательные строки его не вызывают. При «Меньше движения» — затухание 120 мс.</li>
</ul>
<p class="try">Попробуйте на iPhone: «Настройка проекта» → «Окружение проекта» → «К первой незаданной» → откройте строку → «Копировать». Вернитесь, поставьте «Следующая „Проверить снова“: вы запустили setup» и нажмите «Проверить снова». Потом «Настройки»: раздел оператора, экран консоли и варианты для клиента в списке «Состояние».</p>
</div><dl class="tok">
<dt>Цвет</dt><dd>Только токены Paper Desk. Охра — «не задано» (дело, а не ошибка). Мох — «задано», «эта консоль», следующее действие. Серый (утоплённый) — «отсюда не видно», «не проверено», замок 403. Глина — только если не удалась сама проверка.</dd>
<dt>Шрифты</dt><dd>Source Serif 4 — заголовки и сводка; Source Sans 3 — интерфейс и подзаголовки капителью; Source Code Pro — имена, окружения и команды. Все под OFL, шрифты у нас.</dd>
<dt>Новые токены</dt><dd>Нет. Всё стоит на добавлениях #104 (колонка списка 440, значок сводки 40, черта строки 3) и базовой шкале.</dd>
<dt>Новое в ките</dt><dd>Нет. Переиспользуются: <code>tc-list-row</code> с <code>tc-chip</code> (обе строки входа), StatusChip, Tag, CodeLine, state-block (замок), сводка, строка и инструкция из #104. Заголовок секции с точкой «эта консоль» — подпись вкладки из #104, положенная в строку.</dd>
<dt>Движение</dt><dd>быстро 140 · обычно 240 · штамп 620 мс; двигаются только transform, opacity и прорисовка линий; одно вежливое объявление на проверку.</dd>
</dl></div>'''

STATES = ['setup', 'setupAdded', 'missing', 'allSet', 'unseen', 'loading', 'error', 'offline', 'offline0', 'rate', 'forbidden',
          'notFound', 'empty', 'guide', 'guideOpt', 'guideNotFound', 'settings', 'settingsCustomer', 'admin', 'adminOther',
          'adminGuide', 'adminForbidden']


def demo(OPT):
    return f'''  <div class="demo" role="group" aria-label="Demo states" data-i18n-aria="demo.aria">
    <label><span data-i18n="demo.state">State</span><select id="d-state">{OPT('demo.s', STATES)}</select></label>
    <label><span data-i18n="demo.next">Next Check again</span><select id="d-next">{OPT('demo.n', ['same', 'fixed', 'error'])}</select></label>
    <label><input type="checkbox" id="d-copy"><span data-i18n="demo.copyFail">Clipboard refuses</span></label>
    <p class="demo__help" data-i18n="demo.help"></p>
  </div>
'''
