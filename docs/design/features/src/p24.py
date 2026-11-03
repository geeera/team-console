# #24 Settings: GitHub connection and projects (revised for ADR 0003). Page spec for build.py.
FILE = '24-settings-projects.html'
DOC_TITLE = 'Team Console · #24 · Settings: GitHub and projects'
KICKER = 'Team Console · #24 · design for approval'
TITLE = 'Settings: GitHub and projects'
CSS = ['settings.css']
JS = ['settings-i18n.js', 'settings.js']

NOTE_EN = '''
<div class="note__grid"><div>
<p><b>What you are approving.</b> The look of Settings (#24) after ADR 0003: the GitHub connection block, the project list, New project, the project setup page with its five-step checklist, and the two confirmations (archive, disconnect), on iPhone first and on Mac, light and dark, ru and en. Flow, states and copy follow the UX spec and the issue’s current acceptance criteria; this page decides how they look and move.</p>
<ul>
<li><b>GitHub at the top of Settings.</b> One card: “Connect GitHub” when not connected; “Connected as geeera” with a quiet Disconnect when connected; an ochre “connection lost” card with Connect again when access was revoked or expired; a clay card when connecting failed (cancelled on GitHub, wrong account, an unexpected sign-in address). No token fields anywhere.</li>
<li><b>The checklist is a ledger of five steps.</b> App installed on the repo · the repo’s owner is the connected account · project.yml · events arrive · routine token. Each step says its status in words; the mark only repeats it. Missing is ochre, a to-do, not red. Steps 1–3 gate saving; “events arrive” needs nothing from you.</li>
<li><b>Results are margin notes.</b> Moss when added or ready, ochre when steps are left, clay when nothing was saved.</li>
<li><b>Signature moment, reused.</b> The Paper Desk ink stamp on the “ready” note; checks are drawn in, in step order; the “Connected” tick is drawn once after you come back from GitHub. Nothing else moves. Reduced motion: a 120 ms fade.</li>
<li><b>Destructive actions never default.</b> Archive and Disconnect open a dialog on Cancel; on iPhone it rises as a sheet.</li>
</ul>
<p class="try">Try on iPhone: Projects sheet → Settings → Connect GitHub → Authorize; then Add project with <code>geeera/newsletter</code> (added, 2 steps left), <code>acme/site</code> (owner mismatch) and <code>geeera/no-app</code> (app not installed). Switch “Connect result” to “wrong account” and connect again. The demo bar reaches every state.</p>
</div><dl class="tok">
<dt>Colour</dt><dd>Paper Desk tokens only: paper, sheet, ink, moss for the next action and “connected”, ochre (warning) for missing steps and a lost connection, clay (danger) for “not saved”, failed connect, archive and disconnect.</dd>
<dt>Type</dt><dd>Source Serif 4 for titles, names and result notes; Source Sans 3 for the interface; Source Code Pro for owner/repo, logins, paths and commands. All OFL.</dd>
<dt>New tokens</dt><dd>Proposed for the kit: spacing 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40, target 44, input text 16 (no iOS zoom), checklist mark 28, dialog width 440, stagger 70 ms, reduced-motion fade 120 ms.</dd>
<dt>New kit parts</dt><dd>Field (label, hint, error, preview), danger and quiet-danger buttons, alert dialog, skeleton row, code line with Copy, disclosure, section card (the GitHub card).</dd>
<dt>Motion</dt><dd>fast 140 · base 240 · slow 380 · stamp 620 ms; only transform, opacity and stroke draw.</dd>
</dl></div>'''

NOTE_RU = '''
<div class="note__grid"><div>
<p><b>Что утверждаешь.</b> Внешний вид «Настроек» (#24) после ADR 0003: блок подключения GitHub, список проектов, новый проект, страница настройки проекта с чек-листом из пяти шагов и два подтверждения (архивация, отключение) — сначала на iPhone, потом на Mac, в светлой и тёмной теме, на русском и английском. Сценарий, состояния и тексты — по UX-спеке и текущим критериям задачи; здесь решается, как это выглядит и двигается.</p>
<ul>
<li><b>GitHub — вверху «Настроек».</b> Одна карточка: «Подключить GitHub», если не подключён; «Подключено как geeera» и тихая кнопка «Отключить», если подключён; охристая карточка «Подключение потеряно» с «Подключить GitHub», если доступ отозван или истёк; карточка цвета глины, если подключить не удалось (отменено на GitHub, не тот аккаунт, неожиданный адрес входа). Полей для токенов нет нигде.</li>
<li><b>Чек-лист — страница журнала из пяти шагов.</b> Приложение установлено на репозиторий · владелец репозитория — подключённый аккаунт · project.yml · события приходят · токен рутины. Статус каждого шага написан словом, значок его только повторяет. «Не хватает» — охра: это дело, а не ошибка. Шаги 1–3 решают, сохранится ли проект; для «События приходят» от тебя ничего не нужно.</li>
<li><b>Итог — заметка на полях.</b> Мох — добавлено или готово, охра — остались шаги, глина — ничего не сохранено.</li>
<li><b>Фирменный момент — тот же.</b> Чернильный штамп Paper Desk на заметке «готов»; галочки шагов прорисовываются по порядку; галочка «Подключено» прорисовывается один раз, когда возвращаешься с GitHub. Больше ничего не двигается. При «Меньше движения» — затухание 120 мс.</li>
<li><b>Опасное — никогда не по умолчанию.</b> «Архивировать» и «Отключить» открывают диалог с фокусом на «Отмене»; на iPhone он выезжает снизу, как лист.</li>
</ul>
<p class="try">Попробуй на iPhone: лист «Проекты» → «Настройки» → «Подключить GitHub» → Authorize; потом «Добавить проект»: <code>geeera/newsletter</code> (добавлен, осталось 2 шага), <code>acme/site</code> (чужой владелец) и <code>geeera/no-app</code> (приложение не установлено). Поставь «Итог подключения: не тот аккаунт» и подключи ещё раз. Панель демо открывает любое состояние.</p>
</div><dl class="tok">
<dt>Цвет</dt><dd>Только токены Paper Desk: бумага, лист, чернила, мох — следующее действие и «подключено», охра (warning) — недостающие шаги и потерянное подключение, глина (danger) — «не сохранено», неудачное подключение, архивация и отключение.</dd>
<dt>Шрифты</dt><dd>Source Serif 4 — заголовки, имена проектов и заметки-итоги; Source Sans 3 — интерфейс; Source Code Pro — owner/repo, логины, пути и команды. Все под OFL.</dd>
<dt>Новые токены</dt><dd>Предлагаю в кит: отступы 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40, цель касания 44, текст в поле 16 (без зума на iOS), значок шага 28, ширина диалога 440, шаг задержки 70 мс, затухание 120 мс при уменьшенной анимации.</dd>
<dt>Новое в ките</dt><dd>Поле (подпись, подсказка, ошибка, превью), кнопки «опасное действие» и «тихое опасное», диалог-предупреждение, строка-скелетон, строка кода с «Копировать», раскрывашка, карточка раздела (карточка GitHub).</dd>
<dt>Движение</dt><dd>быстро 140 · обычно 240 · медленно 380 · штамп 620 мс; двигаются только transform, opacity и прорисовка линий.</dd>
</dl></div>'''

# The demo state bar; OPT(key, values) renders translated <option>s.
def demo(OPT):
    return f'''  <div class="demo" role="group" aria-label="Demo states" data-i18n-aria="demo.aria">
    <label><span data-i18n="demo.screen">Screen</span><select id="d-screen"><option value="">—</option>{OPT('demo.s', ['entry', 'list', 'github', 'disconnect', 'new', 'setupMissing', 'setupUnknown', 'setupReady', 'dialog'])}</select></label>
    <label><span data-i18n="demo.conn">GitHub</span><select id="d-conn">{OPT('demo.c', ['none', 'connected', 'lost', 'loading'])}</select></label>
    <label><span data-i18n="demo.connRes">Connect result</span><select id="d-connres">{OPT('demo.r', ['ok', 'denied', 'account', 'url'])}</select></label>
    <label><span data-i18n="demo.list">Project list</span><select id="d-list">{OPT('demo.l', ['normal', 'loading', 'empty', 'error', 'offline'])}</select></label>
    <label><span data-i18n="demo.add">Add result</span><select id="d-add">{OPT('demo.a', ['auto', 'app', 'owner', 'yml', 'saved', 'ready', 'github', 'rate', 'auth', 'lost'])}</select></label>
    <label><input type="checkbox" id="d-fail"><span data-i18n="demo.archFail">Archive fails</span></label>
    <button type="button" class="seg-btn" id="d-return" data-i18n="demo.return">Return to the app</button>
    <p class="demo__help" data-i18n="demo.help"></p>
  </div>
'''
