# #766 Wide-screen layout: Artifacts as a card grid, more cards per row on Questions, Demo and Needs you, a
# three-column board, one page cap. Page spec for build.py. Written next to the other issue folders with its screenshots.
FILE = '../766-wide-screen/wireframe.html'
DOC_TITLE = 'Team Console · #766 · Wide screens'
KICKER = 'Team Console · #766 · design for approval'
TITLE = 'Wide screens: the project pages use the width'
CSS = ['wide.css']
JS = ['wide-i18n.js', 'wide.js']

NOTE_EN = '''
<div class="note__grid"><div>
<p><b>What you are approving.</b> How the console uses a wide window (#766). The frame below is a browser window of the width you pick, from 375 to 2560 px; flow, states and copy follow the UX spec on #766. Phone and tablet do not change: at 375 and 768 the proposed layout and today’s are the same pixels.</p>
<ul>
<li><b>One page cap.</b> Every project page and Needs you share <code>--page-max</code> 1664 px (1920 less the sidebar), instead of today’s three caps (680, 1064, 1184). The header’s contents, the paused banner and the body line up on it; beyond 1920 the column centres. Prose (leads, banners, card text) stays at <code>--measure</code> 72ch.</li>
<li><b>Artifacts</b> becomes a grid of cards once the body is 880 px wide (about a 1200 px window): 2 per row at 1200, 3 at 1280 and 1440, 4 at 1920. A design card is one button: a 16:10 crop of its first screen, the title on two lines, “#688 · 39 screens · iPhone and Mac”, the date and “Awaiting your approval”. Decisions and demos are one link each, with a small kicker (type and ↗) instead of the type chip. Under All, each type starts its own row with a heading. Narrower than 880 px (or with Commands open below a 1592 px window), the same list is today’s rows.</li>
<li><b>Thumbnails that can’t show a picture</b> say so in a tile: No pictures, Interactive version only, The picture didn’t load. The card’s summary line says the same in words for a screen reader.</li>
<li><b>Questions, Demo and Needs you</b> keep the #276 decision card and get more of them per row: 2 at 1280 and 1440, 3 at 1920 (each 448–560 px wide). No new pane, so answering stays one step.</li>
<li><b>Board:</b> from a 1360 px body, three columns: tasks (2fr), pull requests, runs. Below it, two columns as today.</li>
<li><b>Motion.</b> A card lifts 2 px on hover, and its thumbnail slowly “peeks” further down the first screen (620 ms). Nothing moves under reduced motion. Layout switches are CSS only, so focus never jumps when a pane opens or the window is resized.</li>
</ul>
<p class="try">Try: pick 1440, open Artifacts, press K (Commands): the grid becomes rows and focus stays put. Switch Layout to “today on dev” to compare. Pick a design card and close the viewer: focus returns to the card.</p>
</div><dl class="tok">
<dt>New tokens</dt><dd><code>--page-max</code> 1664px · <code>--measure</code> 72ch · <code>--cq-grid-min</code> 880px · <code>--cq-wide-min</code> 1360px · <code>--artifact-card-min</code> 300px · <code>--artifact-cols-max</code> 4 · <code>--thumb-ratio</code> 16 / 10</dd>
<dt>Changed</dt><dd><code>--card-min-w</code> 480 → 448px. <code>--board-max</code> removed. <code>--cards-max</code>, <code>--log-max</code> stay for Settings and Find.</dd>
<dt>Gaps</dt><dd><code>--gap-log</code> 20px for both card grids; no new gap token.</dd>
<dt>Colour</dt><dd>Paper Desk tokens only. Tiles: <code>--text-2</code> on <code>--bg-sunken</code>; the failed tile’s icon in clay. “Awaiting” on <code>--warning-soft</code>.</dd>
<dt>Type</dt><dd>Source Serif 4 for card titles; Source Sans 3 for the rest. OFL, self-hosted.</dd>
<dt>Motion</dt><dd>lift <code>--dur-fast</code> 140ms · peek <code>--dur-sig</code> 620ms; transform and shadow only; none under reduced motion.</dd>
</dl></div>'''

NOTE_RU = '''
<div class="note__grid"><div>
<p><b>Что вы утверждаете.</b> Как консоль использует широкое окно (#766). Рамка ниже — окно браузера выбранной ширины, от 375 до 2560 px; сценарий, состояния и тексты — по UX-спеке на #766. Телефон и планшет не меняются: при 375 и 768 предлагаемая и сегодняшняя раскладки совпадают до пикселя.</p>
<ul>
<li><b>Одно ограничение ширины.</b> У всех страниц проекта и «Ждут вас» общий <code>--page-max</code> 1664 px (1920 минус боковая панель) вместо сегодняшних трёх (680, 1064, 1184). По нему выравниваются содержимое шапки, баннер паузы и тело страницы; шире 1920 колонка встаёт по центру. Текст (вводные строки, баннеры, текст карточек) остаётся в пределах <code>--measure</code> 72ch.</li>
<li><b>«Артефакты»</b> становятся сеткой карточек, когда тело страницы шире 880 px (окно около 1200 px): 2 в ряд при 1200, 3 при 1280 и 1440, 4 при 1920. Карточка дизайна — одна кнопка: кадр 16:10 с верха первого экрана, название в две строки, «#688 · 39 экранов · iPhone и Mac», дата и «Ждёт вашего согласования». Решения и демо — по одной ссылке, с маленькой подписью (тип и ↗) вместо чипа типа. В «Все» каждый тип начинает свой ряд с заголовком. Уже 880 px (или с открытыми «Командами» в окне уже 1592 px) тот же список — сегодняшние строки.</li>
<li><b>Если картинки нет</b>, плитка говорит об этом: «Без картинок», «Только интерактивная версия», «Картинка не загрузилась». Строка описания карточки говорит то же словами — для экранного диктора.</li>
<li><b>«Вопросы», «Демо» и «Ждут вас»</b> сохраняют карточку решения из #276, просто их больше в ряду: 2 при 1280 и 1440, 3 при 1920 (каждая 448–560 px). Новой панели нет, ответ — по-прежнему один шаг.</li>
<li><b>Доска:</b> с тела 1360 px — три колонки: задачи (2fr), pull requests, запуски. Уже — две колонки, как сейчас.</li>
<li><b>Движение.</b> Карточка приподнимается на 2 px при наведении, а её картинка медленно «заглядывает» ниже по первому экрану (620 мс). При «Меньше движения» ничего не двигается. Раскладка переключается только CSS, поэтому фокус не прыгает, когда открывается панель или меняется окно.</li>
</ul>
<p class="try">Попробуйте: выберите 1440, откройте «Артефакты», нажмите K («Команды»): сетка станет строками, а фокус останется на месте. Переключите «Раскладка» на «как сейчас на dev», чтобы сравнить. Откройте карточку дизайна и закройте просмотр: фокус вернётся на карточку.</p>
</div><dl class="tok">
<dt>Новые токены</dt><dd><code>--page-max</code> 1664px · <code>--measure</code> 72ch · <code>--cq-grid-min</code> 880px · <code>--cq-wide-min</code> 1360px · <code>--artifact-card-min</code> 300px · <code>--artifact-cols-max</code> 4 · <code>--thumb-ratio</code> 16 / 10</dd>
<dt>Изменено</dt><dd><code>--card-min-w</code> 480 → 448px. <code>--board-max</code> удалён. <code>--cards-max</code>, <code>--log-max</code> остаются для Настроек и «Найти».</dd>
<dt>Отступы</dt><dd><code>--gap-log</code> 20px для обеих сеток карточек; нового токена нет.</dd>
<dt>Цвет</dt><dd>Только токены Paper Desk. Плитки: <code>--text-2</code> на <code>--bg-sunken</code>; значок неудачной плитки — глина. «Ждёт» — на <code>--warning-soft</code>.</dd>
<dt>Шрифты</dt><dd>Source Serif 4 — названия карточек; Source Sans 3 — остальное. OFL, шрифты у нас.</dd>
<dt>Движение</dt><dd>подъём <code>--dur-fast</code> 140 мс · «заглядывание» <code>--dur-sig</code> 620 мс; только transform и тень; при «Меньше движения» — ничего.</dd>
</dl></div>'''

PAGES_ = ['artifacts', 'designs', 'questions', 'demo', 'board', 'needs']
WINS = ['375', '768', '1200', '1280', '1440', '1920', '2560']


def demo(OPT):
    wins = ''.join(f'<option value="{w}">{w} px</option>' for w in WINS)
    return f'''  <div class="demo" role="group" aria-label="Demo states" data-i18n-aria="demo.aria">
    <label><span data-i18n="demo.page">Page</span><select id="d-page">{OPT('demo.pg', PAGES_)}</select></label>
    <label><span data-i18n="demo.win">Window</span><select id="d-win">{wins}</select></label>
    <label><span data-i18n="demo.pane">Pane</span><select id="d-pane">{OPT('demo.pn', ['none', 'commands', 'task'])}</select></label>
    <label><span data-i18n="demo.state">State</span><select id="d-state">{OPT('demo.st', ['ready', 'loading', 'partial', 'refreshing', 'thumbFail', 'noMatch'])}</select></label>
    <label><span data-i18n="demo.layout">Layout</span><select id="d-layout">{OPT('demo.ly', ['new', 'today'])}</select></label>
    <p class="demo__help" data-i18n="demo.help"></p>
  </div>
'''
