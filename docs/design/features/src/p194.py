# #194 All projects: repositories from the connected GitHub installation, with Add. Page spec for build.py.
FILE = '194-github-repositories.html'
DOC_TITLE = 'Team Console · #194 · All projects: add from GitHub'
KICKER = 'Team Console · #194 · design for approval'
TITLE = 'All projects: add from GitHub'
CSS = ['settings.css', 'repos.css']
JS = ['repos-i18n.js', 'repos.js']

NOTE_EN = '''
<div class="note__grid"><div>
<p><b>What you are approving.</b> How All projects looks with the repositories your console’s GitHub App can see, and how one becomes a project with one tap (#194). This follows your decisions: the list lives on <b>All projects</b>, under your own projects; Settings keeps only settings; after an add the main button is <b>Done</b>. Flow, states and copy come from the UX spec; this page decides how they look and move, on iPhone first and on the Mac, light and dark, ru and en.</p>
<ul>
<li><b>Your projects first, then “Available on GitHub”.</b> The tiles stay as they are today. A thin rule and the serif heading start the GitHub section, with a one-line lead (which app, which account) and a visible <b>Refresh</b>. Every “Add project” entry point (the iPhone Projects sheet, the Mac sidebar, empty states) opens All projects scrolled to this heading.</li>
<li><b>Rows you can act on come first.</b> Each row shows the name in serif, the owner in mono and a <b>Private</b> marker as text with a small lock. Add sits on the right as a 44 px outlined button in moss ink, so a column of Add buttons stays calm. Projects and archived ones follow under a small “Already in the console” heading: a project row is one link (“Project ›”); an archived row reads “Archived” and has no control, in secondary ink that passes AA in both themes.</li>
<li><b>Long lists fold.</b> With more than 12 addable repositories the list shows the first 10 and “Show 38 more”, so your projects and “Add by name” are never buried on the phone. Names wrap; nothing is cut with an ellipsis.</li>
<li><b>Add opens a sheet over the list</b> (a bottom sheet on iPhone, a centred dialog on the Mac) with #24’s checklist and result notes unchanged: moss when added, the ink stamp when all five steps are done, clay when nothing was saved. Done is primary and keeps you on the list; the row turns “Project ›” with a drawn check, and the new tile settles into your projects above.</li>
<li><b>Close it while it checks</b> and the row says “Checking…”; the result lands on the row. A refusal leaves an ochre line “Not added: step 3 is missing · See why ›” that reopens the result.</li>
<li><b>Every state has its own block</b>: loading skeleton, partial note with the GitHub link, app sees nothing, app not installed, GitHub down, rate limit with the time, broken app credential, offline with the list kept or with nothing loaded, and “Connect GitHub first” inside the section (no list request). “Add by name” stays collapsed at the end and opens the same sheet.</li>
</ul>
<p class="try">Try on iPhone: tap the “All projects” title → Add project. Then Add on <code>storify</code>, <code>newsletter</code> and <code>fieldnote</code>. Set “Your projects: none yet” and “Repository list: long (48)”. The bar reaches every state.</p>
<p><b>One question for the team (not for this approval):</b> “Open setup” and a project row lead to the #24 setup page, which lived under Settings. With Settings for settings only, the architect and the UX designer place that page (for example inside the project space); the look here does not change.</p>
</div><dl class="tok">
<dt>Colour</dt><dd>Paper Desk tokens only: moss (<code>--accent-text</code>) for Add and “Project ›”, <code>--bg-sunken</code> for the Private marker and the partial note, ochre (<code>--warning-*</code>) for “Not added”, clay (<code>--danger-*</code>) for load errors, <code>--text-2</code> for archived rows. Text pairs are AA in both themes, the archived row included.</dd>
<dt>Type</dt><dd>Source Serif 4 for headings and repository names, Source Sans 3 for the interface, Source Code Pro for the owner login and paths. All OFL; no new fonts.</dd>
<dt>Tokens</dt><dd>One new: <code>--sheet-dialog-w</code> 560 px for the Add dialog on the Mac (the 440 px confirmation width is too narrow for the checklist). Everything else is existing: 44 px target, spacing scale, <code>--r-sheet</code>, <code>--scrim</code>, motion durations.</dd>
<dt>Kit</dt><dd>Sheet (with a footer slot for actions), List / ListRow with a row action, StateBlock, Banner, Chip, Button, Field, Toast. A <code>ListRow</code> “trailing text” variant (“Project ›”, “Archived”) and a sheet footer are the only kit additions.</dd>
<dt>Motion</dt><dd>Sheet rises 380 ms (dialog settles 240 ms); checklist steps ink in, in order; the stamp on “ready”; the row’s check draws once; the new tile fades up 6 px. Reduced motion: 120 ms fades, no spinner turn, no skeleton pulse.</dd>
</dl></div>'''

NOTE_RU = '''
<div class="note__grid"><div>
<p><b>Что вы утверждаете.</b> Как выглядят «Все проекты» вместе с репозиториями, которые видит GitHub-приложение консоли, и как один из них становится проектом в одно касание (#194). Всё по вашим решениям: список живёт на экране <b>«Все проекты»</b>, под вашими проектами; в «Настройках» остаются только настройки; после добавления главная кнопка — <b>«Готово»</b>. Сценарий, состояния и тексты — по UX-спеке; здесь решается, как это выглядит и двигается — сначала на iPhone, потом на Mac, в светлой и тёмной теме, на русском и английском.</p>
<ul>
<li><b>Сначала ваши проекты, потом «Доступны на GitHub».</b> Плитки проектов — как сейчас. Раздел GitHub начинается тонкой линией и заголовком с засечками, под ним одна строка — какое приложение и какой аккаунт — и видимая кнопка <b>«Обновить»</b>. Все входы «Добавить проект» (лист «Проекты» на iPhone, боковая панель на Mac, пустые состояния) открывают «Все проекты» сразу на этом заголовке.</li>
<li><b>Сначала то, с чем можно что-то сделать.</b> В строке — имя с засечками, владелец моноширинным и пометка <b>«Приватный»</b> словом и маленьким замком. «Добавить» справа — контурная кнопка 44 px цвета мха, поэтому столбец кнопок выглядит спокойно. Проекты и архив — ниже, под небольшим заголовком «Уже в консоли»: строка проекта — одна ссылка («Проект ›»), строка в архиве — «В архиве», без кнопок, вторичными чернилами с контрастом AA в обеих темах.</li>
<li><b>Длинный список сворачивается.</b> Если репозиториев для добавления больше 12, видны первые 10 и «Показать ещё 38», поэтому на телефоне ваши проекты и «Добавить по имени» не тонут. Имена переносятся, многоточием ничего не обрезается.</li>
<li><b>«Добавить» открывает лист поверх списка</b> (снизу на iPhone, диалог по центру на Mac) с чек-листом и заметками-итогами из #24 без изменений: мох — добавлено, чернильный штамп — все пять шагов готовы, глина — ничего не сохранено. «Готово» — главная кнопка и оставляет вас в списке; строка становится «Проект ›» с прорисованной галочкой, а новая плитка появляется среди ваших проектов выше.</li>
<li><b>Если закрыть лист во время проверки,</b> строка показывает «Проверяем…», и итог приходит в строку. После отказа остаётся охристая строка «Не добавлен: не хватает шага 3 · Почему ›» — она снова открывает итог.</li>
<li><b>У каждого состояния свой блок:</b> скелетон загрузки, заметка о неполном списке со ссылкой на GitHub, приложение ничего не видит, приложение не установлено, GitHub не отвечает, лимит запросов со временем, сломан ключ приложения, нет сети со списком и без, «Сначала подключите GitHub» прямо в разделе (список не запрашивается). «Добавить по имени» свёрнуто в конце и открывает тот же лист.</li>
</ul>
<p class="try">Попробуйте на iPhone: нажмите заголовок «Все проекты» → «Добавить проект». Потом «Добавить» у <code>storify</code>, <code>newsletter</code> и <code>fieldnote</code>. Поставьте «Ваши проекты: пока нет» и «Список репозиториев: длинный (48)». Панель демо открывает любое состояние.</p>
<p><b>Вопрос команде (не для этого согласования):</b> «Открыть настройку» и строка проекта ведут на страницу настройки проекта из #24, которая была в «Настройках». Раз «Настройки» теперь только для настроек, архитектор и UX-дизайнер решат, где эта страница (например, в пространстве проекта); вид здесь от этого не меняется.</p>
</div><dl class="tok">
<dt>Цвет</dt><dd>Только токены Paper Desk: мох (<code>--accent-text</code>) — «Добавить» и «Проект ›», <code>--bg-sunken</code> — пометка «Приватный» и заметка о неполном списке, охра (<code>--warning-*</code>) — «Не добавлен», глина (<code>--danger-*</code>) — ошибки загрузки, <code>--text-2</code> — строки в архиве. Контраст текста AA в обеих темах, включая архив.</dd>
<dt>Шрифты</dt><dd>Source Serif 4 — заголовки и имена репозиториев, Source Sans 3 — интерфейс, Source Code Pro — логин владельца и пути. Все под OFL, новых шрифтов нет.</dd>
<dt>Токены</dt><dd>Один новый: <code>--sheet-dialog-w</code> 560 px — ширина диалога добавления на Mac (440 px диалога-подтверждения мало для чек-листа). Остальное — существующие: цель касания 44 px, шкала отступов, <code>--r-sheet</code>, <code>--scrim</code>, длительности анимации.</dd>
<dt>Кит</dt><dd>Sheet (со слотом под кнопки внизу), List / ListRow с действием в строке, StateBlock, Banner, Chip, Button, Field, Toast. Новое в ките — только вариант ListRow с текстом в конце («Проект ›», «В архиве») и подвал у Sheet.</dd>
<dt>Движение</dt><dd>Лист выезжает 380 мс (диалог — 240 мс); шаги чек-листа прорисовываются по порядку; штамп на «готов»; галочка в строке рисуется один раз; новая плитка проявляется со сдвигом 6 px. При «Меньше движения» — затухание 120 мс, без вращения и пульсации скелетона.</dd>
</dl></div>'''


# The demo state bar; OPT(key, values) renders translated <option>s.
def demo(OPT):
    return f'''  <div class="demo" role="group" aria-label="Demo states" data-i18n-aria="demo.aria">
    <label><span data-i18n="demo.screen">Open</span><select id="d-screen"><option value="">—</option>{OPT('demo.s', ['top', 'entry', 'byName', 'sheetChecking', 'sheetYml', 'sheetSaved', 'sheetReady', 'sheetGithub', 'sheetRate', 'sheetAuth', 'sheetLost', 'sheetDup', 'rowChecking', 'rowNotAdded'])}</select></label>
    <label><span data-i18n="demo.projects">Your projects</span><select id="d-projects">{OPT('demo.p', ['some', 'none'])}</select></label>
    <label><span data-i18n="demo.conn">GitHub</span><select id="d-conn">{OPT('demo.c', ['connected', 'none', 'lost'])}</select></label>
    <label><span data-i18n="demo.list">Repository list</span><select id="d-list">{OPT('demo.l', ['loaded', 'long', 'partial', 'loading', 'empty', 'notInstalled', 'github', 'rate', 'auth', 'offline', 'offlineNone'])}</select></label>
    <label><span data-i18n="demo.add">Add result</span><select id="d-add">{OPT('demo.a', ['auto', 'yml', 'app', 'saved', 'ready', 'github', 'rate', 'auth', 'lost', 'dup'])}</select></label>
    <button type="button" class="seg-btn" id="d-return" data-i18n="demo.return">Back from GitHub</button>
    <p class="demo__help" data-i18n="demo.help"></p>
  </div>
'''
