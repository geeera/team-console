# #109 Team analytics: the space's Stats tab («Показатели»): runs, sprint, reviews, where the team is stuck.
# Page spec for build.py.
FILE = '109-team-analytics.html'
DOC_TITLE = 'Team Console · #109 · Stats: how the team works'
KICKER = 'Team Console · #109 · design for approval'
TITLE = 'Stats: how the team works'
CSS = ['board.css', 'stats.css']
JS = ['stats-i18n.js', 'stats.js']

NOTE_EN = '''
<div class="note__grid"><div>
<p><b>What you are approving.</b> How the new Stats tab of a project looks (#109): runs, sprint, reviews and where the team is stuck. The flow, states and copy come from the UX spec on #109 (wireframe in #334); this page decides the look, iPhone first, then the Mac, light and dark, ru and en. The tab only shows numbers: it changes nothing and collects nothing new.</p>
<ul>
<li><b>A tab of its own, after Board.</b> “Stats” has a small bar-chart icon. The page title is “How the team works”. Under it one quiet line: the sprint and demo, the team chip (Running, Paused since…, Failing, as on the board), “As of 14:05” and <b>Refresh</b>.</li>
<li><b>Four tiles answer “is anything wrong?” in ten seconds:</b> Blocked, Failed runs, QA first pass, Done. The number is set in the serif, with a quiet second line under it (“oldest 9 d”, “last 14 days”, “6 of 10 PRs”, “Sprint 03”). A tile that needs a look gets an ochre double outline and a “!” before its label, never colour alone. A small arrow says the tile leads down the page. Tapping a tile scrolls to its block, rings the block once in moss (the kit’s arrival ring) and moves focus to its heading.</li>
<li><b>“No data” is a typeface, not a zero.</b> Wherever a number is missing, the serif italic “no data” stands in its place with the reason right under it (“no run log yet”, “nothing in the sprint is closed yet”). Real zeros stay plain numbers.</li>
<li><b>Where the team is stuck.</b> A list card, oldest first. Each row has the number, the title (opens GitHub), a “9 days blocked” chip, and the reason, the last comment, as a margin note in the serif. It is clamped to three lines with “Show the whole reason”. A row blocked for 7 days or more gets the ochre outlined chip. Only github.com links in a reason are links; any other URL stays text. A reason from outside the team carries the dashed “Not from the team” chip. Nothing blocked is a dashed card with a green check.</li>
<li><b>Reviews.</b> Two figures, “QA approved first time 60%” and “Change requests 5”. Then the merged PRs, most rounds first. Rounds are an ink tally (four strokes and a fifth across, like a ledger) and the words “3 rounds”. Above the project’s limit (<code>max_rework_rounds</code> + 1) the tally sits on an ochre outlined slip. Chips: “QA: changes ×1”, “REVIEW: changes ×1”, “review failed” in clay with ✗, “tier raised” in ochre with ↑. Five rows, then “Show 2 more” at the foot of the card.</li>
<li><b>Sprint.</b> A two-part bar: shipped in moss ink, still open as pencil hatching. A screen reader hears the sentence instead. Then Planned / Shipped / Still open, the median cycle time and the by-tier table with #134’s tier icons.</li>
<li><b>Runs, last 14 days.</b> A real table on the Mac, one line per slot on the iPhone (“Development: 18 runs · 3 failed · median 24 min”). Failures are numbers with a word, in clay. A slot without durations reads “no data*” with the footnote. A slot the console doesn’t know shows its raw name (<code>slot-burn</code>). While paused, a quiet note comes first. Entries from outside the team get a dashed note with the count. “The whole run log ↗” closes the block.</li>
<li><b>Every state stays where it happens.</b> The budget stopping a block turns it into an ochre note with <b>Load again</b>, and its tile reads “no data · not all counted”: a partial number is never shown. Whole-page states are one block under the title: clay error with Try again, ochre “GitHub asks to wait” with the time, quiet offline, and the board’s “not installed”. Loading draws the final layout in skeletons. A failed refresh keeps the numbers under an ochre banner.</li>
<li><b>Mac:</b> tiles four across, then two columns (Stuck and Reviews on the left, Sprint and Runs on the right). Tab order and screen reader order equal the iPhone order.</li>
</ul>
<p class="try">Try it on iPhone: tap “Blocked”, then “Show the whole reason”. Tap “QA first pass”, then “Show 2 more”. Press Refresh. Pick other data in the demo bar (paused, no run log, no sprint, day 1, budget stopped, untrusted) and other load states; “Open the link …/stats#runs” loads the page and lands on Runs.</p>
</div><dl class="tok">
<dt>Colour</dt><dd>Paper Desk tokens only. Tiles and cards are <code>--surface</code> on <code>--bg</code> with <code>--border</code>/<code>--border-strong</code>. Moss (<code>--accent</code>) for shipped and the arrival ring. Ochre (<code>--warning-soft</code>/<code>--warning-text</code>) for “needs a look”, long blocks, the round limit, tier raised, the budget note and 429. Clay (<code>--danger-*</code>) for failures, “review failed” and errors. <code>--bg-sunken</code> for offline and the pause note. AA in both themes.</dd>
<dt>Type</dt><dd>Source Serif 4 for the title, block headings, the numbers, “no data” (italic) and the reasons. Source Sans 3 for the rest. Period lines are caps <code>--fs-xs</code> with <code>--ls-caps</code>, numbers <code>tabular-nums</code>. Source Code Pro only for ids and raw slot names. No new fonts.</dd>
<dt>Tokens</dt><dd>Proposed for the kit: <code>--an-meter-h</code> 10 px, <code>--tally-h</code> 14 px, <code>--tally-step</code> 40 ms, <code>--reason-lines</code> 3. Everything else exists: <code>--space-*</code>, <code>--control-h-touch</code>, <code>--r-md</code>/<code>--r-lg</code>/<code>--r-pill</code>, <code>--dur-fade</code>, <code>--dur-sig</code>, <code>--ease-emph</code>.</dd>
<dt>Kit</dt><dd>Reused: <code>Stats</code>/<code>Stat</code>, <code>Chip</code>, <code>Callout</code>, <code>Banner</code>, <code>StateBlock</code>, <code>markArrival</code>, <code>Spinner</code>, tier icons, <code>ListRow</code>. New in the kit before the feature uses it: <code>Stat</code> as an in-page link (<code>href</code>, a ↓ instead of ›) with a <code>marked</code> look; a <code>chart</code> icon for the tab; a two-part <code>Meter</code> (<code>role="img"</code> + label); the <code>Tally</code> glyph; the “no data” text style.</dd>
<dt>Motion</dt><dd>Once per load the numbers fade in (240 ms), the shipped bar draws from the left (620 ms) and the tally strokes ink in one by one (40 ms apart). The tile jump scrolls smoothly and the ring swells once (620 ms). New rows after “Show 2 more” rise 4 px. With reduced motion: instant scroll, no swell, no drawing, fades only, static skeletons and ring.</dd>
</dl></div>'''

NOTE_RU = '''
<div class="note__grid"><div>
<p><b>Что вы утверждаете.</b> Как выглядит новая вкладка проекта «Показатели» (#109): прогоны, спринт, проверки и где застряла команда. Сценарий, состояния и тексты взяты из UX-спеки #109 (вайрфрейм в #334). Здесь решается внешний вид: сначала iPhone, потом Mac, в светлой и тёмной теме, на русском и английском. Вкладка только показывает числа: ничего не меняет и ничего нового не собирает.</p>
<ul>
<li><b>Своя вкладка, сразу после «Доски».</b> У «Показателей» маленький значок-диаграмма. Заголовок страницы — «Как работает команда». Под ним одна тихая строка:
  <ul>
  <li>спринт и дата демо;</li>
  <li>состояние команды — «В работе», «На паузе с…» или «Сбой», как на доске;</li>
  <li>«Данные на 14:05» и кнопка <b>«Обновить»</b>.</li>
  </ul></li>
<li><b>Четыре плитки за десять секунд отвечают «всё ли в порядке».</b> Это «В блокерах», «Сбои прогонов», «QA с первого раза» и «Готово».
  <ul>
  <li>Число набрано с засечками, под ним тихая вторая строка: «самый давний 9 дн.», «за 14 дней», «6 из 10 PR», «Sprint 03».</li>
  <li>Плитка, на которую стоит посмотреть, получает двойную охристую рамку и «!» перед названием. Смысл понятен не только по цвету.</li>
  <li>Маленькая стрелка вниз говорит, что плитка ведёт ниже по странице. Нажатие прокручивает к блоку, один раз обводит его зелёным кольцом и ставит фокус на заголовок.</li>
  </ul></li>
<li><b>«Нет данных» — это начертание, а не ноль.</b> Где числа нет, на его месте стоит «нет данных» курсивом с засечками, а сразу под ним — почему: «журнала ещё нет», «в спринте ещё ничего не закрыто». Настоящие нули остаются обычными числами.</li>
<li><b>«Где застряли».</b> Список в карточке, самые давние сверху. В каждой строке:
  <ul>
  <li>номер и название (открывает GitHub);</li>
  <li>плашка «9 дней в блокере»; от 7 дней она охристая, с рамкой;</li>
  <li>причина — последний комментарий — как заметка на полях с засечками. Она свёрнута до трёх строк, рядом «Показать причину целиком».</li>
  </ul>
  Ссылками в причине становятся только адреса github.com, остальные остаются текстом. Причина от кого-то вне команды помечена пунктирной плашкой «Не от команды». Если блокеров нет — карточка с пунктирной рамкой и зелёной галочкой.</li>
<li><b>«Проверки».</b> Две цифры: «QA одобрил с первого раза 60 %» и «Запросов правок 5». Ниже — смёрженные PR, сначала с наибольшим числом кругов.
  <ul>
  <li>Круги нарисованы чернильными чёрточками, как подсчёт в тетради: четыре палочки и пятая поперёк. Рядом слова «3 круга».</li>
  <li>Если кругов больше, чем допускает проект (<code>max_rework_rounds</code> + 1), чёрточки лежат на охристой плашке с рамкой.</li>
  <li>Плашки: «QA: правки ×1», «REVIEW: правки ×1», «ревью не прошло» (цвет глины, со ✗), «сложность поднята» (охра, со ↑).</li>
  <li>Пять строк, внизу карточки «Показать ещё 2».</li>
  </ul></li>
<li><b>«Спринт».</b> Полоса из двух частей: сделанное — зелёными чернилами, ещё открытое — карандашной штриховкой. Экранный диктор читает вместо неё фразу. Дальше «Запланировано / Сделано / Ещё открыто», медиана цикла и таблица по сложности со значками из #134.</li>
<li><b>«Прогоны» за 14 дней.</b> На Mac — настоящая таблица, на iPhone — строка на слот: «Разработка: 18 прогонов · 3 сбоя · медиана 24 мин».
  <ul>
  <li>Сбои — числа со словом, цветом глины.</li>
  <li>У слота без длительности — «нет данных*» и сноска.</li>
  <li>Незнакомый консоли слот показан своим именем (<code>slot-burn</code>).</li>
  <li>На паузе сверху тихая заметка. Записи не от команды — пунктирная заметка с их числом.</li>
  <li>Внизу ссылка «Весь журнал прогонов ↗».</li>
  </ul></li>
<li><b>Каждое состояние остаётся там, где оно случилось.</b>
  <ul>
  <li>Если лимит запросов остановил блок, блок становится охристой заметкой с кнопкой <b>«Загрузить ещё раз»</b>, а его плитка — «нет данных · посчитаны не все». Неполное число не показывается никогда.</li>
  <li>Состояния всей страницы — один блок под заголовком: ошибка цвета глины с «Повторить», охристое «GitHub просит подождать» со временем, тихое «Нет соединения» и «не установлено», как на доске.</li>
  <li>Загрузка рисует итоговую раскладку заготовками.</li>
  <li>Неудачное обновление оставляет числа на месте, сверху охристая плашка.</li>
  </ul></li>
<li><b>Mac:</b> плитки в один ряд, ниже две колонки: слева «Где застряли» и «Проверки», справа «Спринт» и «Прогоны». Порядок Tab и экранного диктора тот же, что на iPhone.</li>
</ul>
<p class="try">Попробуйте на iPhone: нажмите «В блокерах», потом «Показать причину целиком». Нажмите «QA с первого раза», потом «Показать ещё 2». Нажмите «Обновить». В панели демо выберите другие данные (пауза, нет журнала, нет спринта, первый день, лимит, не от команды) и другие исходы загрузки. «Открыть ссылку …/stats#runs» загружает страницу и приводит к «Прогонам».</p>
</div><dl class="tok">
<dt>Цвет</dt><dd>Только токены Paper Desk. Плитки и карточки — <code>--surface</code> на <code>--bg</code> с <code>--border</code>/<code>--border-strong</code>. Мох (<code>--accent</code>) — сделанное и кольцо прибытия. Охра (<code>--warning-soft</code>/<code>--warning-text</code>) — «стоит посмотреть», долгие блокеры, лимит кругов, поднятая сложность, заметка о лимите запросов и 429. Глина (<code>--danger-*</code>) — сбои, «ревью не прошло» и ошибки. <code>--bg-sunken</code> — нет сети и заметка о паузе. Контраст AA в обеих темах.</dd>
<dt>Шрифты</dt><dd>Source Serif 4 — заголовки, числа, «нет данных» (курсив) и причины. Source Sans 3 — остальное. Строки периода капителью <code>--fs-xs</code> с <code>--ls-caps</code>, числа <code>tabular-nums</code>. Source Code Pro — только номера и сырые имена слотов. Новых шрифтов нет.</dd>
<dt>Токены</dt><dd>Предлагаю добавить в кит: <code>--an-meter-h</code> 10 px, <code>--tally-h</code> 14 px, <code>--tally-step</code> 40 мс, <code>--reason-lines</code> 3. Остальное уже есть: <code>--space-*</code>, <code>--control-h-touch</code>, <code>--r-md</code>/<code>--r-lg</code>/<code>--r-pill</code>, <code>--dur-fade</code>, <code>--dur-sig</code>, <code>--ease-emph</code>.</dd>
<dt>Кит</dt><dd>Используются как есть: <code>Stats</code>/<code>Stat</code>, <code>Chip</code>, <code>Callout</code>, <code>Banner</code>, <code>StateBlock</code>, <code>markArrival</code>, <code>Spinner</code>, значки сложности, <code>ListRow</code>. Новое в ките — до того, как им воспользуется фича: <code>Stat</code> как ссылка внутри страницы (<code>href</code>, стрелка ↓ вместо ›) и вид <code>marked</code>; значок <code>chart</code> для вкладки; двухчастный <code>Meter</code> (<code>role="img"</code> с подписью); знак <code>Tally</code>; стиль текста «нет данных».</dd>
<dt>Движение</dt><dd>Один раз за загрузку числа проявляются (240 мс), полоса сделанного прорисовывается слева (620 мс), чёрточки кругов прописываются по одной (с шагом 40 мс). Переход по плитке — плавная прокрутка, кольцо один раз расширяется (620 мс). Новые строки после «Показать ещё 2» поднимаются на 4 px. При «Меньше движения»: мгновенная прокрутка, без расширения кольца и прорисовки, только проявление, заготовки и кольцо загрузки неподвижны.</dd>
</dl></div>'''


# The demo state bar; OPT(key, values) renders translated <option>s.
def demo(OPT):
    return f'''  <div class="demo" role="group" aria-label="Demo states" data-i18n-aria="demo.aria">
    <label><span data-i18n="demo.data">Data</span><select id="d-data">{OPT('demo.d', ['typical', 'calm', 'paused', 'failing', 'nolog', 'unreadable', 'nosprint', 'early', 'partialReviews', 'partialSprint', 'untrusted'])}</select></label>
    <label><span data-i18n="demo.load">Load</span><select id="d-load">{OPT('demo.l', ['loaded', 'loading', 'error', 'rate', 'offline', 'notinstalled'])}</select></label>
    <label><input type="checkbox" id="d-fail"> <span data-i18n="demo.refreshFails">Refresh will fail</span></label>
    <button type="button" class="seg-btn" id="d-deep" data-i18n="demo.deep">Open the link …/stats#runs</button>
    <p class="demo__help" data-i18n="demo.help"></p>
  </div>
'''
