# #134 Board on the phone: one lane at a time behind a lane switcher, so short lanes leave no blank page.
# Page spec for build.py.
FILE = '134-board-phone-lanes.html'
DOC_TITLE = 'Team Console · #134 · Board on the phone: lane switcher'
KICKER = 'Team Console · #134 · design for approval'
TITLE = 'Board on the phone: lane switcher'
CSS = ['board.css']
JS = ['board-i18n.js', 'board.js']

NOTE_EN = '''
<div class="note__grid"><div>
<p><b>What you are approving.</b> How the sprint board (#18) shows its status lanes on the phone. Today the lanes are a sideways row, and the row is as tall as its tallest lane: under a short lane there are 500 to 740 px of blank page before “Open pull requests” (#134). This page replaces the row with a lane switcher on the phone only. The Mac layout, the data, the copy and every other board state stay as approved in #18.</p>
<ul>
<li><b>A switcher with counts above the lane.</b> Every lane is a pill with its name and count (“Approved 4”, “QA 0”), all visible at once. Pills wrap onto a second line when they don’t fit, so nothing hides off-screen. The selected pill is ink-filled, as in the Paper Desk segmented controls. Every pill is a 44 px target.</li>
<li><b>Only the selected lane is shown</b>, at its own height, so “Open pull requests” always starts right under it. The board opens on the first lane that has issues; your choice is kept while the board refreshes.</li>
<li><b>Keyboard and screen readers.</b> The switcher is one Tab stop (a tab list): the arrow keys move between lanes, Home and End jump to the first and last. A screen reader hears “Approved 4, tab, 1 of 5, selected”. The lane heading stays in the page for heading navigation. This replaces today’s scrollable row, which is also one Tab stop with arrow keys.</li>
<li><b>Motion:</b> the incoming lane slides 8 px from the side you moved towards and fades in (140 ms). With reduced motion it only fades (120 ms). Nothing else moves.</li>
<li><b>Ready for #108</b> (current, next sprint, backlog): each section gets its own switcher. A section with a single lane shows the lane without a switcher. See the “#108 preview” data set.</li>
</ul>
<p class="try">Try on iPhone: tap “Done 10”, then “QA 0”: the pull requests move up with the lane. Switch “Version” to “Now: swipe row” to see today’s gap. With a keyboard, Tab to the switcher and use ← →, Home, End.</p>
</div><dl class="tok">
<dt>Colour</dt><dd>Paper Desk tokens only: ink fill (<code>--text</code> on <code>--bg</code>) for the selected pill, <code>--surface</code> and <code>--border</code> for the others, <code>--text-3</code> for counts, <code>--focus</code> for the focus ring. AA contrast in both themes.</dd>
<dt>Type</dt><dd>Source Sans 3, <code>--fs-sm</code>, semibold name, tabular count. No new fonts.</dd>
<dt>Tokens</dt><dd>No new tokens: <code>--control-h-touch</code> (44 px), <code>--r-pill</code>, <code>--space-2</code>/<code>--space-3</code>, <code>--dur-fast</code>, <code>--ease-enter</code>, <code>--dur-fade</code>.</dd>
<dt>Kit</dt><dd><code>tc-lanes</code> renders the switcher itself on the phone from its <code>tc-lane</code> children; <code>tc-lane</code> gets an optional <code>key</code>. No new component, and no new strings in the app.</dd>
<dt>Motion</dt><dd>fast 140 ms slide and fade; reduced: fade 120 ms. Only transform and opacity animate.</dd>
</dl></div>'''

NOTE_RU = '''
<div class="note__grid"><div>
<p><b>Что утверждаешь.</b> Как доска спринта (#18) показывает дорожки статусов на телефоне. Сейчас дорожки — ряд со свайпом вбок, и этот ряд высотой с самую длинную дорожку: под короткой дорожкой 500–740 px пустой страницы до «Открытых пул-реквестов» (#134). Здесь ряд заменён переключателем дорожек — только на телефоне. Вид на Mac, данные, тексты и остальные состояния доски остаются как утверждено в #18.</p>
<ul>
<li><b>Над дорожкой — переключатель со счётчиками.</b> Каждая дорожка — «таблетка» с названием и числом («Одобрено 4», «На проверке 0»), все видны сразу. Если не помещаются, переносятся на вторую строку, так что ничего не прячется за краем экрана. Выбранная залита чернилами, как переключатели в Paper Desk. Каждая — цель касания 44 px.</li>
<li><b>Показана только выбранная дорожка</b> и ровно своей высоты, поэтому «Открытые пул-реквесты» всегда начинаются сразу под ней. Доска открывается на первой дорожке, где есть задачи; выбор сохраняется, пока доска обновляется.</li>
<li><b>Клавиатура и скринридер.</b> Переключатель — одна остановка Tab (список вкладок): стрелки переходят между дорожками, Home и End — к первой и последней. Скринридер читает «Одобрено 4, вкладка, 1 из 5, выбрана». Заголовок дорожки остаётся на странице для навигации по заголовкам. Это заменяет сегодняшний прокручиваемый ряд — он тоже одна остановка Tab со стрелками.</li>
<li><b>Движение:</b> новая дорожка въезжает на 8 px с той стороны, куда ты переключил, и проявляется (140 мс). При «Меньше движения» — только проявление (120 мс). Больше ничего не двигается.</li>
<li><b>Готово к #108</b> (текущий спринт, следующий, бэклог): у каждой секции свой переключатель. Секция с одной дорожкой показывает её без переключателя. См. набор данных «превью #108».</li>
</ul>
<p class="try">Попробуй на iPhone: нажми «Готово 10», потом «На проверке 0» — пул-реквесты поднимаются вместе с дорожкой. Переключи «Версия» на «Сейчас: ряд со свайпом», чтобы увидеть сегодняшнюю пустоту. С клавиатуры: Tab до переключателя, потом ← →, Home, End.</p>
</div><dl class="tok">
<dt>Цвет</dt><dd>Только токены Paper Desk: заливка чернилами (<code>--text</code> на <code>--bg</code>) у выбранной таблетки, <code>--surface</code> и <code>--border</code> у остальных, <code>--text-3</code> у счётчиков, <code>--focus</code> у рамки фокуса. Контраст AA в обеих темах.</dd>
<dt>Шрифты</dt><dd>Source Sans 3, <code>--fs-sm</code>, название полужирным, число табличными цифрами. Новых шрифтов нет.</dd>
<dt>Токены</dt><dd>Новых нет: <code>--control-h-touch</code> (44 px), <code>--r-pill</code>, <code>--space-2</code>/<code>--space-3</code>, <code>--dur-fast</code>, <code>--ease-enter</code>, <code>--dur-fade</code>.</dd>
<dt>Кит</dt><dd><code>tc-lanes</code> сам рисует переключатель на телефоне из своих <code>tc-lane</code>; у <code>tc-lane</code> появляется необязательный <code>key</code>. Новых компонентов нет, новых строк в приложении нет.</dd>
<dt>Движение</dt><dd>быстро 140 мс — сдвиг и проявление; при «Меньше движения» — проявление 120 мс. Анимируются только transform и opacity.</dd>
</dl></div>'''


# The demo state bar; OPT(key, values) renders translated <option>s.
def demo(OPT):
    return f'''  <div class="demo" role="group" aria-label="Demo states" data-i18n-aria="demo.aria">
    <label><span data-i18n="demo.version">Version</span><select id="d-version">{OPT('demo.v', ['new', 'old'])}</select></label>
    <label><span data-i18n="demo.data">Data</span><select id="d-data">{OPT('demo.d', ['sprint', 'early', 'unknown', 's108'])}</select></label>
    <p class="demo__help" data-i18n="demo.help"></p>
  </div>
'''
