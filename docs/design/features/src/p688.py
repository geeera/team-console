# #688 Settings › Team: roles, models, limits, history (ADR 0009). Page spec for build.py.
# Written next to the other issue folders (docs/design/<issue>-<slug>/wireframe.html) with its screenshots.
FILE = '../688-settings-team/wireframe.html'
DOC_TITLE = 'Team Console · #688 · Settings › Team'
KICKER = 'Team Console · #688 · design for approval'
TITLE = 'Settings › Team: roles, models, limits, history'
CSS = ['settings.css', 'teamcfg.css']
JS = ['teamcfg-i18n.js', 'teamcfg.js']

NOTE_EN = '''
<div class="note__grid"><div>
<p><b>What you are approving.</b> The look and behaviour of Settings › Team (#688) on the approved Paper Desk direction, iPhone first, then the Mac, light and dark, ru and en. Flow, states and copy follow the UX spec on #630 and #688’s criteria (with #737’s waived month); this page decides how they look and move.</p>
<ul>
<li><b>A sub-page like Runners.</b> Title “Team”, the revision line (number, author name only, date, the reason in italics), Import from project.yml and History. Five section cards: Preset, How the team reaches Claude, Roles, Limits, Rules. On the iPhone each card folds to one line that still shows its value (“API key”, “$200 a month · $64 spent”); Preset and Roles start open.</li>
<li><b>Roles are a ledger.</b> Name, switch, a model button (“Opus 5.5 · high”), a limits button (“90 min · 400 turns · 5 at once”). The five never-off roles show the switch on with a lock in its thumb, stay focusable, and say why under the name. Security has no switch, only its reason. An override carries the word chip “Override” and its own Reset; the preset line counts them and offers Reset to the preset.</li>
<li><b>Model picker.</b> A sheet on the iPhone, a dialog on the Mac: only the role’s allowed models, each with a one-line hint and its pinned id, “In Recommended” on the preset’s choice, effort below; the excluded models are named in the footer (“Not available for this role: Haiku 4.5”).</li>
<li><b>Subscription.</b> The risk warning is always printed under it. Choosing it opens a confirmation with a required “I understand” tick; under it cost levers are off with their reason. With a hosted runner it stays focusable but disabled, says why and links to Runners; a forced save shows <code>access-source-hosted</code> inline.</li>
<li><b>Nothing saves on change.</b> A sticky bar counts the edits. Review lists Setting · Was · Now in words (struck-through old value, never colour alone), says it applies to the next job, takes an optional reason (500) and saves. 412 is an ochre banner with the three actions; “Keep my edits on top” loads revision 13 and asks only about the settings you both changed. 403, offline and network errors keep the edits.</li>
<li><b>Money.</b> Budget used up is a clay callout at the top with Resume this month (one-line confirm) and Raise budget (jumps to the field). A waived month is an ochre margin note under Limits: when you resumed, why the budget does not stop the team, and that changing the budget ends it; while you edit it the note turns moss and says the month is capped again at the new figure, and the review row says “ends the waiver”.</li>
<li><b>History</b> is a ledger of revisions; a revision opens a diff in words, the raw JSON behind Show raw, and Use as draft (no restore button). Revision 9’s reason is an <code>&lt;img onerror&gt;</code> payload printed as text (T4).</li>
<li><b>Motion.</b> Sheets rise (380 ms), dialogs and the save bar fade up (240 ms), a picked role row glows moss once. Nothing animates height. Reduced motion: a 120 ms fade. No stamp here (the UX spec keeps the signature moment out of settings).</li>
</ul>
<p class="try">Try: switch UI designer on, set Developer to Fable 5.1, set the budget to 250, then Review and save. Set “Next save” to 412 and save again: Keep my edits on top. Choose Economy. Pick Claude subscription, then tick “A hosted runner can reach this project”. Open History → revision 9 → Show raw.</p>
</div><dl class="tok">
<dt>Colour</dt><dd>Paper Desk tokens only: moss for the next action, switches on, overrides and “capped again”; ochre for the risk warning, the conflict and the waived month; clay for the budget stop and 403.</dd>
<dt>Type</dt><dd>Source Serif 4 for titles, revision numbers and reasons; Source Sans 3 for the interface; Source Code Pro for model ids, paths and raw JSON. All OFL, self-hosted.</dd>
<dt>New tokens</dt><dd>Proposed for the kit: switch 44 × 26, save bar 68, the Mac model column 210, wide dialog 600.</dd>
<dt>New kit parts</dt><dd><code>switch</code> (on, off, locked with reason): the kit has none yet, it goes in first with its story. Reused: segmented, picker-button, sheet, callout, banner, ledger, field, state-block, toast.</dd>
<dt>Motion</dt><dd>fast 140 · base 240 · slow 380 ms; only transform and opacity; one live region for “N unsaved changes”, “Saved. Revision 13.”</dd>
</dl></div>'''

NOTE_RU = '''
<div class="note__grid"><div>
<p><b>Что утверждаете.</b> Внешний вид и поведение «Настройки › Команда» (#688) в утверждённом направлении Paper Desk — сначала iPhone, потом Mac, светлая и тёмная тема, русский и английский. Сценарий, состояния и тексты — по UX-спеке на #630 и критериям #688 (с месяцем без лимита из #737); здесь решается, как это выглядит и двигается.</p>
<ul>
<li><b>Подстраница, как «Раннеры».</b> Заголовок «Команда», строка ревизии (номер, только имя автора, дата, причина курсивом), «Импорт из project.yml» и «История». Пять карточек: «Набор», «Как команда обращается к Claude», «Роли», «Лимиты», «Правила». На iPhone каждая карточка сворачивается в одну строку, где всё равно видно значение («Ключ API», «$200 в месяц · потрачено $64»); «Набор» и «Роли» открыты сразу.</li>
<li><b>Роли — страница журнала.</b> Имя, переключатель, кнопка модели («Opus 5.5 · высокое»), кнопка лимитов («90 мин · 400 шагов · 5 сразу»). Пять ролей, которые нельзя выключить, показывают включённый переключатель с замком, остаются в порядке Tab и пишут причину под именем. У «Безопасности» переключателя нет, только причина. Своя настройка помечена словом «Своя настройка» и своей кнопкой «Вернуть»; строка набора считает такие изменения и предлагает вернуть набор.</li>
<li><b>Выбор модели.</b> Лист снизу на iPhone, диалог на Mac: только разрешённые для роли модели, у каждой — строка подсказки и закреплённый id, «В наборе „Рекомендуемый“» у выбора набора, ниже — усилие; недоступные модели названы внизу («Недоступна для этой роли: Haiku 4.5»).</li>
<li><b>Подписка.</b> Предупреждение о риске всегда напечатано под ней. Выбор открывает подтверждение с обязательной галочкой «Я понимаю риск»; при подписке рычаги расходов выключены с причиной. Если проект доступен облачному раннеру, вариант остаётся в порядке Tab, но выключен, объясняет почему и ведёт к «Раннерам»; сохранение в обход показывает <code>access-source-hosted</code> прямо под полем.</li>
<li><b>Ничего не сохраняется само.</b> Липкая панель считает правки. «Проверить» показывает «Настройка · Было · Стало» словами (старое значение зачёркнуто, не только цветом), говорит, что изменения применятся к следующей задаче, принимает причину (до 500) и сохраняет. 412 — охристый баннер с тремя действиями; «Оставить мои правки сверху» загружает ревизию 13 и спрашивает только о настройках, которые меняли оба. 403, нет сети и ошибка сети — правки остаются.</li>
<li><b>Деньги.</b> «Бюджет исчерпан» — плашка цвета глины вверху с «Возобновить на этот месяц» (подтверждение в одну строку) и «Увеличить бюджет» (переводит к полю). Месяц без лимита — охристая заметка на полях в «Лимитах»: когда вы возобновили, почему бюджет не останавливает команду и что смена бюджета это отменит; пока вы правите бюджет, заметка становится зелёной и говорит, что месяц снова будет ограничен новой суммой, а в проверке у строки бюджета написано «снимет исключение».</li>
<li><b>История</b> — журнал ревизий; ревизия открывает разницу словами, JSON — за «Показать JSON», и «Взять как черновик» (кнопки «восстановить» нет). Причина ревизии 9 — код <code>&lt;img onerror&gt;</code>, напечатанный как текст (T4).</li>
<li><b>Движение.</b> Листы выезжают (380 мс), диалоги и панель сохранения проявляются (240 мс), выбранная строка роли один раз подсвечивается зелёным. Высота не анимируется. При «Меньше движения» — затухание 120 мс. Штампа здесь нет (UX-спека не берёт фирменный момент в настройки).</li>
</ul>
<p class="try">Попробуйте: включите UI-дизайнера, поставьте разработчику Fable 5.1, бюджет 250 — и «Проверить и сохранить». Поставьте «Следующее сохранение: 412» и сохраните ещё раз: «Оставить мои правки сверху». Выберите «Экономный». Выберите подписку Claude, затем отметьте «Облачный раннер может работать с проектом». Откройте «История» → ревизия 9 → «Показать JSON».</p>
</div><dl class="tok">
<dt>Цвет</dt><dd>Только токены Paper Desk: мох — следующее действие, включённые переключатели, свои настройки и «снова ограничен»; охра — предупреждение о риске, конфликт и месяц без лимита; глина — остановка по бюджету и 403.</dd>
<dt>Шрифты</dt><dd>Source Serif 4 — заголовки, номера ревизий и причины; Source Sans 3 — интерфейс; Source Code Pro — id моделей, пути и JSON. Все под OFL, шрифты у нас.</dd>
<dt>Новые токены</dt><dd>Предлагаю в кит: переключатель 44 × 26, панель сохранения 68, колонка модели на Mac 210, широкий диалог 600.</dd>
<dt>Новое в ките</dt><dd><code>switch</code> (вкл., выкл., закреплён с причиной): в ките его ещё нет, он появится первым, со своей историей в Storybook. Переиспользуются: segmented, picker-button, sheet, callout, banner, ledger, field, state-block, toast.</dd>
<dt>Движение</dt><dd>быстро 140 · обычно 240 · медленно 380 мс; только transform и opacity; одна live-область для «N несохранённых изменений», «Сохранено. Ревизия 13.»</dd>
</dl></div>'''

STATES = ['loaded', 'member', 'locked', 'picker', 'preset', 'subscription', 'hosted', 'hostedErr', 'review', 'conflict', 'merged',
          'invalid', 'forbidden', 'network', 'import', 'importFail', 'history', 'diff', 'raw', 'partial', 'budget', 'resume',
          'waived', 'loading', 'slow', 'empty', 'error', 'offline', 'leave', 'saved']


def demo(OPT):
    return f'''  <div class="demo" role="group" aria-label="Demo states" data-i18n-aria="demo.aria">
    <label><span data-i18n="demo.state">State</span><select id="d-state">{OPT('demo.s', STATES)}</select></label>
    <label><span data-i18n="demo.save">Next save</span><select id="d-save">{OPT('demo.v', ['ok', 'invalid', 'conflict', 'forbidden', 'network'])}</select></label>
    <label><input type="checkbox" id="d-hosted"><span data-i18n="demo.hosted">A hosted runner can reach this project</span></label>
    <label><input type="checkbox" id="d-impfail"><span data-i18n="demo.impFail">Import fails</span></label>
    <p class="demo__help" data-i18n="demo.help"></p>
  </div>
'''
