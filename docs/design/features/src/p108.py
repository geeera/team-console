# #108 Board by sprint: current, next and backlog. Page spec for build.py.
FILE = '108-board-by-sprint.html'
DOC_TITLE = 'Team Console · #108 · Board by sprint'
KICKER = 'Team Console · #108 · design for approval'
TITLE = 'Board by sprint: current, next and backlog'
CSS = ['board.css', 'sprints.css']
JS = ['sprints-i18n.js', 'sprints.js']

NOTE_EN = '''
<div class="note__grid"><div>
<p><b>What you are approving.</b> How the board looks once it shows three sections: the current sprint, the next sprint and the backlog (#108). The flow, states and copy come from the UX spec on #108 (wireframe in #255); this page decides the look, iPhone first, then the Mac, light and dark, ru and en. The board stays read-only: no dragging, no moving.</p>
<ul>
<li><b>The current sprint stays #18 as it ships.</b> A small caps kicker “Current sprint” now sits over “Sprint 03”, and the line under it reads “Demo 13 Oct · 7 open”, so all three sections read the same way. Tiles, legend, lanes and Move demo are unchanged.</li>
<li><b>The next sprint and the backlog are folders on the desk.</b> Each is a manila strip with a small tab. It has the kicker, the name in the serif (“Sprint 04”, “Tasks without a sprint”), the demo date, and one inked button, <b>Show tasks</b>. A closed folder loads nothing. Open, the strip turns to paper white, the button becomes <b>Hide</b> with its chevron turned, “5 open” joins the date, and the lanes sit under the strip. Each folder has its own lane switcher on the iPhone (#134); a folder with one lane has none.</li>
<li><b>Each row adds the kind word</b> under the title (Feature, Bug, Chore, Finding, Wow, Question), in all three sections. It is a word, not an icon. An issue with no kind label has no word.</li>
<li><b>A request still waiting for the PM is an ochre slip</b> clipped to the row: “Request: the next sprint · waiting for the PM since Oct 6”, with a dot, a hairline outline and the words. It is never colour alone. Rows with a slip come first in their lane. The slip goes away once the PM handles the request. The board never says “applied” or “declined”; the PM’s answer is on the issue the row opens.</li>
<li><b>Every state stays inside its folder.</b> Loading is a caption with a small ring over three skeleton rows. Errors are a clay block with Try again. “GitHub asks to wait” is ochre and says when it tries again. Offline is a quiet sunken block. Empty is a dashed card that says what happens next. With no next sprint, the strip says so and has no button. A partial backlog gets an ochre margin note with “The whole backlog on GitHub ↗” and shows no count. A lane over 30 rows ends with “Show 30 more · 42 left” across the foot of its card.</li>
<li><b>The deep link</b> <code>?section=backlog</code> (from #107’s receipt) opens the backlog, scrolls it under the top bar, focuses its heading, and the strip glows moss once and settles.</li>
</ul>
<p class="try">Try it on iPhone: tap <b>Show tasks</b> on Sprint 04, then on the backlog, and switch lanes in each. Use the demo bar to pick other outcomes (error, 429, offline, partial, large, not created), and press “Open the board again”: the folders you left open load by themselves.</p>
</div><dl class="tok">
<dt>Colour</dt><dd>Paper Desk tokens only. <code>--surface-2</code> and <code>--border</code> for a closed folder, <code>--surface</code> for an open one. Ink (<code>--text</code> on <code>--bg</code>) for Show tasks. Ochre (<code>--warning-soft</code>/<code>--warning-text</code>) for the request slip, 429 and the partial note. Clay (<code>--danger-*</code>) for errors, <code>--bg-sunken</code> for offline, moss (<code>--accent-soft</code>) for the arrival glow. AA in both themes, and the slip passes in dark too.</dd>
<dt>Type</dt><dd>Source Serif 4 for the section names, Source Sans 3 for the rest: the kicker in caps <code>--fs-xs</code> with <code>--ls-caps</code>, the kind word in semibold <code>--fs-xs</code>. No new fonts.</dd>
<dt>Tokens</dt><dd>Proposed for the kit: <code>--folder-tab-w</code> 56 px, <code>--folder-tab-h</code> 6 px, <code>--row-stagger</code> 24 ms. Everything else exists: <code>--control-h-touch</code>, <code>--r-md</code>/<code>--r-lg</code>/<code>--r-pill</code>, <code>--space-*</code>, <code>--shadow-1</code>, <code>--dur-fade</code>, <code>--dur-pulse</code>.</dd>
<dt>Kit</dt><dd>Reused: <code>tc-lanes</code>/<code>tc-lane</code> (#134), <code>tc-list-row</code> (the slip goes in <code>tc-row-subtitle</code>), <code>StateBlock</code> with <code>compact</code> for the in-section states, Button, Icon. New in the kit, before the feature uses it: a <code>Disclosure</code> section header (kicker, heading, meta, toggle with <code>aria-expanded</code>/<code>aria-controls</code>, a <code>folder</code> look). <code>StateBlock</code> also gets <code>wait</code> and <code>offline</code> tones.</dd>
<dt>Motion</dt><dd>Opening a folder never animates height. The content fades in (120 ms), and its first rows rise 4 px with a 24 ms stagger (240 ms). The chevron turns in 240 ms. The arrival glow fades out over 1.6 s. With reduced motion: the fade only, no rise, no glow, a static ring and skeletons.</dd>
</dl></div>'''

NOTE_RU = '''
<div class="note__grid"><div>
<p><b>Что вы утверждаете.</b> Как выглядит доска, когда на ней три раздела: текущий спринт, следующий спринт и бэклог (#108). Сценарий, состояния и тексты взяты из UX-спеки #108 (вайрфрейм в #255). Здесь решается внешний вид: сначала iPhone, потом Mac, в светлой и тёмной теме, на русском и английском. Доска по-прежнему только показывает: ничего не перетаскивается и не переносится.</p>
<ul>
<li><b>Текущий спринт остаётся таким, как в #18.</b> Над «Sprint 03» появилась надпись капителью «Текущий спринт», а под ним строка «Демо 13 окт · 7 открытых». Так все три раздела читаются одинаково. Плитки, легенда, дорожки и «Перенести демо» не меняются.</li>
<li><b>Следующий спринт и бэклог — папки на столе.</b> Каждая выглядит как полоска плотной бумаги с маленьким ярлыком. На ней надпись капителью, название с засечками («Sprint 04», «Задачи без спринта»), дата демо и одна кнопка, залитая чернилами: <b>«Показать задачи»</b>. Закрытая папка ничего не загружает. Когда папка открыта:
  <ul>
  <li>полоска становится белой, как лист;</li>
  <li>кнопка меняется на <b>«Скрыть»</b>, стрелка поворачивается;</li>
  <li>к дате добавляется «5 открытых»;</li>
  <li>под полоской появляются дорожки.</li>
  </ul>
  На iPhone у каждой папки свой переключатель дорожек (#134). Если дорожка одна, переключателя нет.</li>
<li><b>В каждой строке под названием — тип задачи:</b> «Функция», «Ошибка», «Техзадача», «Находка», «Вау», «Вопрос». Так во всех трёх разделах. Это слово, а не значок. Если у задачи нет метки типа, слова нет.</li>
<li><b>Ваша просьба, которую PM ещё не разобрал, — охристая полоска на строке:</b> «Просьба: в следующий спринт · ждёт PM с 6 окт». У неё есть точка, тонкая рамка и слова, так что смысл понятен не только по цвету.
  <ul>
  <li>Строки с просьбой стоят первыми в своей дорожке.</li>
  <li>Полоска исчезает, когда PM разобрал просьбу.</li>
  <li>Доска сама не пишет «применено» или «отклонено». Ответ PM — в задаче, которую открывает строка.</li>
  </ul></li>
<li><b>Все состояния остаются внутри своей папки.</b>
  <ul>
  <li>Загрузка: подпись с маленьким кольцом и три строки-заготовки.</li>
  <li>Ошибка: блок цвета глины с кнопкой «Повторить».</li>
  <li>«GitHub просит подождать»: охристый блок, в нём время следующей попытки.</li>
  <li>Нет сети: тихий утопленный блок.</li>
  <li>Пусто: карточка с пунктирной рамкой, в ней — что будет дальше.</li>
  <li>Следующего спринта нет: полоска говорит об этом, кнопки нет.</li>
  <li>Бэклог загрузился не целиком: охристая заметка на полях со ссылкой «Весь бэклог на GitHub ↗», а число открытых не показывается.</li>
  <li>В дорожке больше 30 задач: внизу её карточки кнопка «Показать ещё 30 · осталось 42».</li>
  </ul></li>
<li><b>Ссылка</b> <code>?section=backlog</code> (из квитанции #107) открывает бэклог и прокручивает его под верхнюю панель. Фокус встаёт на заголовок, а полоска один раз мягко подсвечивается зелёным и гаснет.</li>
</ul>
<p class="try">Попробуйте на iPhone: нажмите <b>«Показать задачи»</b> у Sprint 04, потом у бэклога, и переключите дорожки в каждом. В панели демо выберите другие исходы (ошибка, 429, нет сети, частично, большой, не создан). Потом нажмите «Открыть доску заново»: папки, которые вы оставили открытыми, загрузятся сами.</p>
</div><dl class="tok">
<dt>Цвет</dt><dd>Только токены Paper Desk. Закрытая папка — <code>--surface-2</code> и <code>--border</code>, открытая — <code>--surface</code>. «Показать задачи» — чернила (<code>--text</code> на <code>--bg</code>). Охра (<code>--warning-soft</code>/<code>--warning-text</code>) — полоска просьбы, 429 и заметка о неполном бэклоге. Глина (<code>--danger-*</code>) — ошибки, <code>--bg-sunken</code> — нет сети, мох (<code>--accent-soft</code>) — подсветка по ссылке. Контраст AA в обеих темах, у полоски просьбы и в тёмной.</dd>
<dt>Шрифты</dt><dd>Source Serif 4 для названий разделов, Source Sans 3 для остального: надпись над названием капителью <code>--fs-xs</code> с <code>--ls-caps</code>, тип задачи полужирным <code>--fs-xs</code>. Новых шрифтов нет.</dd>
<dt>Токены</dt><dd>Предлагаю добавить в кит: <code>--folder-tab-w</code> 56 px, <code>--folder-tab-h</code> 6 px, <code>--row-stagger</code> 24 мс. Остальное уже есть: <code>--control-h-touch</code>, <code>--r-md</code>/<code>--r-lg</code>/<code>--r-pill</code>, <code>--space-*</code>, <code>--shadow-1</code>, <code>--dur-fade</code>, <code>--dur-pulse</code>.</dd>
<dt>Кит</dt><dd>Используются как есть: <code>tc-lanes</code>/<code>tc-lane</code> (#134), <code>tc-list-row</code> (полоска просьбы — в <code>tc-row-subtitle</code>), <code>StateBlock</code> с <code>compact</code> для состояний внутри раздела, Button, Icon. Новое в ките — до того, как им воспользуется фича: заголовок раздела <code>Disclosure</code> (надпись, заголовок, строка с датой, кнопка с <code>aria-expanded</code>/<code>aria-controls</code>, вид «папка»). У <code>StateBlock</code> появляются тона <code>wait</code> и <code>offline</code>.</dd>
<dt>Движение</dt><dd>Высота при открытии папки не анимируется. Содержимое проявляется (120 мс), первые строки поднимаются на 4 px одна за другой с шагом 24 мс (240 мс). Стрелка поворачивается за 240 мс. Подсветка по ссылке гаснет за 1,6 с. При «Меньше движения» — только проявление: без подъёма и подсветки, кольцо и заготовки неподвижны.</dd>
</dl></div>'''


# The demo state bar; OPT(key, values) renders translated <option>s.
def demo(OPT):
    return f'''  <div class="demo" role="group" aria-label="Demo states" data-i18n-aria="demo.aria">
    <label><span data-i18n="demo.current">Current sprint</span><select id="d-cur">{OPT('demo.o', ['loaded', 'nosprint'])}</select></label>
    <label><span data-i18n="demo.next">Next sprint</span><select id="d-next">{OPT('demo.o', ['loaded', 'empty', 'none', 'loading', 'error', 'rate', 'offline'])}</select></label>
    <label><span data-i18n="demo.backlog">Backlog</span><select id="d-back">{OPT('demo.o', ['loaded', 'large', 'partial', 'empty', 'loading', 'error', 'rate', 'offline'])}</select></label>
    <label><input type="checkbox" id="d-req" checked> <span data-i18n="demo.req">Requests waiting for the PM</span></label>
    <button type="button" class="seg-btn" id="d-reopen" data-i18n="demo.reopen">Open the board again</button>
    <button type="button" class="seg-btn" id="d-deep" data-i18n="demo.deep">Open ?section=backlog</button>
    <p class="demo__help" data-i18n="demo.help"></p>
  </div>
'''
