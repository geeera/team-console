# #107 New task from the phone, with a sprint request. Page spec for build.py.
FILE = '107-quick-task.html'
DOC_TITLE = 'Team Console · #107 · New task from the phone'
KICKER = 'Team Console · #107 · design for approval'
TITLE = 'New task from the phone, with a sprint request'
CSS = ['task.css']
JS = ['task-i18n.js', 'task.js']

NOTE_EN = '''
<div class="note__grid"><div>
<p><b>What you are approving.</b> How “New task” looks and moves: a quick form for an idea or a bug, sent to the project’s team with a request for a sprint (#107). The flow, states and copy come from the UX spec on #107; this page decides the look, iPhone first, then the Mac, light and dark, ru and en. The console only records your sprint request; the PM applies it at its next planning run.</p>
<ul>
<li><b>Where it opens.</b> On iPhone, a <b>+</b> in the top bar of every project screen and of Needs you, before Settings. With three actions in that bar, Commands (#114) becomes an icon button (the sliders, named “Commands”) so the project name stays whole; on the Mac it keeps its word and <kbd>K</kbd>. On the Mac, a <b>New task</b> button with <kbd>T</kbd> next to Commands <kbd>K</kbd> in the project header and in the Needs you header; <kbd>T</kbd> works anywhere outside a text field. While a draft is unsent, an ochre ink dot sits on the corner, and the button’s name says “(draft saved)”.</li>
<li><b>One sheet, top to bottom.</b> Project (with its monogram), Title, Details, Kind, Which sprint. The title is set in the serif, like the heading of a card, because it is the thought you are capturing. Kind is three inked segments: Feature, Bug, Chore. The hint under them says what the chosen kind means. Sprint has three rows with the sprint’s name and demo date under each. Defaults: Feature, Next.</li>
<li><b>Create sits where your thumb and the keyboard allow.</b> On iPhone, <b>Close · New task · Create</b> is the sheet’s top bar, so the keyboard never hides the button. The project shows under the title (“in team-console”). On the Mac, the footer says <b>Create in team-console</b>, with “Send ⌘ ↩” beside it; “The draft stays on this device only” closes the form on both.</li>
<li><b>Notes are information, not stops.</b> A public repository gets a quiet line with an eye icon. A paused team gets one with a pause icon. A line starting with “/” gets a margin note saying it stays plain text. If the team can’t read sprint requests yet, an ochre note sits over the sprint rows. Current is greyed with its reason when there is no current sprint, or during freeze, with a small “freeze” tag. The text stays readable (AA).</li>
<li><b>Nothing is lost.</b> Closing keeps the draft (toast “Draft saved”). Reopening shows “Draft from 13:52 · Clear” as an ochre margin slip. If the draft belongs to another project, the slip says so. Clear asks first.</li>
<li><b>When it can’t send</b>, Create stays in place and says why: offline, not connected (an ochre Connect GitHub block at the top), no project. When GitHub refuses, a clay block appears at the top of the form, visible with the keyboard up. It has the problem’s own fix, and Create becomes <b>Try again</b> where a retry helps. After “no answer”, the retry returns the same task, never a second one.</li>
<li><b>Created: the signature moment.</b> The form is replaced by your task as an index card: kind tab, #142, title in serif, the repo, tilted a little as if just filed. Then the round ink stamp from #16 presses onto it. Below that: “Task #142 created”, project · time · created as you, the request in words as a margin note, and Open #142 on GitHub ↗. Done is primary, Another task keeps the project.</li>
</ul>
<p class="try">Try on iPhone: + → type a title → Create. Then Another task, type, close (the dot), reopen (the slip). Set “Next send” to “no answer”, send, then Try again. Tick “iPhone keyboard up” to see the form above the keyboard.</p>
</div><dl class="tok">
<dt>Colour</dt><dd>Paper Desk tokens only: ink (<code>--text</code>) for the chosen kind, moss (<code>--accent-*</code>) for the chosen sprint row, Create, the stamp and the request note, ochre (<code>--warning-*</code>) for the draft dot and slip, Connect GitHub and “doesn’t read requests yet”, clay (<code>--danger-*</code>) for send errors and the Bug tab, <code>--bg-sunken</code> for the public, paused and offline notes. Text pairs are AA in both themes, the greyed Current option included.</dd>
<dt>Type</dt><dd>Source Serif 4 for the sheet title, the task title field, the index card and the receipt heading; Source Sans 3 for the interface; Source Code Pro for the repo and #142. All OFL; no new fonts.</dd>
<dt>Tokens</dt><dd>Proposed for the kit: <code>--task-dialog-w</code> 600 px (the Mac dialog), <code>--task-sheet-max-h</code> 94 % (a capture sheet taller than the 88 % default), <code>--draft-dot</code> 8 px, <code>--card-tilt</code> −1.2°. Everything else exists: 44 px targets, 16 px inputs on iPhone, spacing, <code>--r-sheet</code>, <code>--scrim</code>, motion durations.</dd>
<dt>Kit</dt><dd>Sheet (with a header action slot and a footer), Field with a counter, Button with a busy state, Toast, Sheet.confirm for Clear, the Paper Desk stamp. New in the kit, before the feature uses them: a <code>SegmentedRadio</code> (three inked segments over a native radio group) and a <code>ChoiceList</code> (radio rows with a hint line and an <code>aria-disabled</code> row with its reason). The <code>IconButton</code> also gets an optional dot.</dd>
<dt>Motion</dt><dd>The sheet rises in 380 ms (the dialog settles in 240 ms) and leaves faster. The draft dot pops in once. Notes and errors fade down 4 px. The card files in 380 ms, then the stamp presses in (620 ms). With reduced motion: 120 ms fades, no stamp press, no skeleton pulse.</dd>
</dl></div>'''

NOTE_RU = '''
<div class="note__grid"><div>
<p><b>Что вы утверждаете.</b> Как выглядит и двигается «Новая задача»: быстрая форма для идеи или ошибки, которая уходит команде проекта вместе с просьбой о спринте (#107). Сценарий, состояния и тексты — из UX-спеки #107. Здесь решается внешний вид: сначала iPhone, потом Mac, в светлой и тёмной теме, на русском и английском. Консоль только записывает вашу просьбу о спринте, а применяет её PM на ближайшем планировании.</p>
<ul>
<li><b>Откуда открывается.</b> На iPhone — <b>+</b> в верхней панели любого экрана проекта и «Ждут вас», перед «Настройками». Действий в панели теперь три, поэтому «Команды» из #114 становятся кнопкой-значком (ползунки, для экранного диктора — «Команды»): так имя проекта не обрезается. На Mac у кнопки остаются слово и <kbd>K</kbd>. На Mac — кнопка <b>«Новая задача»</b> с <kbd>T</kbd> рядом с «Командами» <kbd>K</kbd> в шапке проекта и в шапке «Ждут вас». Клавиша <kbd>T</kbd> работает везде, кроме текстовых полей. Пока есть неотправленный черновик, в углу кнопки стоит охристая чернильная точка, а в названии кнопки для экранного диктора — «есть черновик».</li>
<li><b>Один лист сверху вниз:</b> проект (с монограммой), название, подробности, тип, спринт.
  <ul>
  <li>Название набирается шрифтом с засечками, как заголовок карточки: это и есть мысль, которую вы записываете.</li>
  <li>Тип — три сегмента: «Функция», «Ошибка», «Техзадача». Выбранный залит чернилами, под ним подсказка, что этот тип значит.</li>
  <li>Спринт — три строки, под каждой название спринта и дата демо.</li>
  <li>По умолчанию: «Функция» и «В следующий».</li>
  </ul></li>
<li><b>«Создать» там, где её не закроет клавиатура.</b> На iPhone верх листа — <b>«Закрыть · Новая задача · Создать»</b>, под заголовком проект: «в team-console». На Mac внизу <b>«Создать в team-console»</b>, рядом — «Отправить ⌘ ↩»; строка «Черновик хранится только на этом устройстве» завершает форму на обоих.</li>
<li><b>Заметки — это информация, а не запрет:</b>
  <ul>
  <li>публичный репозиторий — тихая строка со значком глаза;</li>
  <li>команда на паузе — строка со значком паузы;</li>
  <li>строка, которая начинается с «/», — заметка на полях: она останется обычным текстом;</li>
  <li>команда пока не читает просьбы о спринте — охристая заметка над вариантами;</li>
  <li>текущего спринта нет или идёт заморозка — «В текущий» серый, с причиной и пометкой «заморозка». Текст при этом читается (контраст AA).</li>
  </ul></li>
<li><b>Ничего не теряется.</b> Закрыли — черновик остался, всплывает «Черновик сохранён». Открыли снова — охристая полоска на полях «Черновик от 13:52 · Очистить». Если черновик для другого проекта, полоска говорит об этом. «Очистить» сначала переспрашивает.</li>
<li><b>Когда отправить нельзя,</b> «Создать» остаётся на месте и объясняет почему: нет сети, GitHub не подключён (сверху охристый блок «Подключить GitHub»), нет проекта.
  <ul>
  <li>Если GitHub отказал, сверху формы появляется блок цвета глины. Он виден и при открытой клавиатуре, в нём своё решение для каждой ошибки.</li>
  <li>Там, где повтор поможет, «Создать» становится <b>«Повторить»</b>.</li>
  <li>После «нет ответа» повтор вернёт ту же задачу, а не вторую.</li>
  </ul></li>
<li><b>Создано — главный момент.</b> Форму сменяет ваша задача в виде учётной карточки: тип, #142, название с засечками, репозиторий. Карточка чуть наклонена, будто её только что подшили, и на неё опускается круглый чернильный штамп из #16. Ниже:
  <ul>
  <li>«Задача #142 создана»;</li>
  <li>проект · время · от вашего имени;</li>
  <li>просьба словами, заметкой на полях;</li>
  <li>«Открыть #142 на GitHub ↗».</li>
  </ul>
  «Готово» — главная кнопка, «Ещё задача» оставляет тот же проект.</li>
</ul>
<p class="try">Попробуйте на iPhone: «+» → название → «Создать». Потом «Ещё задача»: напишите что-нибудь и закройте лист (появится точка), откройте снова (появится полоска). Поставьте «Следующая отправка: нет ответа», отправьте, затем «Повторить». Отметьте «Клавиатура iPhone открыта» — так видно форму над клавиатурой.</p>
</div><dl class="tok">
<dt>Цвет</dt><dd>Только токены Paper Desk:
  <ul>
  <li>чернила (<code>--text</code>) — выбранный тип;</li>
  <li>мох (<code>--accent-*</code>) — выбранный спринт, «Создать», штамп и заметка с просьбой;</li>
  <li>охра (<code>--warning-*</code>) — точка и полоска черновика, «Подключить GitHub», «пока не читает просьбы»;</li>
  <li>глина (<code>--danger-*</code>) — ошибки отправки и ярлык «Ошибка»;</li>
  <li><code>--bg-sunken</code> — заметки о публичном репозитории, паузе и сети.</li>
  </ul>
  Контраст текста AA в обеих темах, включая серый «В текущий».</dd>
<dt>Шрифты</dt><dd>Source Serif 4 — заголовок листа, поле названия, карточка и заголовок итога. Source Sans 3 — интерфейс. Source Code Pro — репозиторий и #142. Все под OFL, новых шрифтов нет.</dd>
<dt>Токены</dt><dd>Предлагаются в кит:
  <ul>
  <li><code>--task-dialog-w</code> 600 px — диалог на Mac;</li>
  <li><code>--task-sheet-max-h</code> 94 % — лист выше обычных 88 %;</li>
  <li><code>--draft-dot</code> 8 px;</li>
  <li><code>--card-tilt</code> −1,2°.</li>
  </ul>
  Остальное уже есть: цели касания 44 px, поля 16 px на iPhone, отступы, <code>--r-sheet</code>, <code>--scrim</code>, длительности анимации.</dd>
<dt>Кит</dt><dd>Используются: Sheet (со слотом под действие в шапке и подвалом), Field со счётчиком, Button с состоянием отправки, Toast, Sheet.confirm для «Очистить», штамп Paper Desk. Новое в ките, до использования в задаче:
  <ul>
  <li><code>SegmentedRadio</code> — три сегмента поверх обычной группы радиокнопок;</li>
  <li><code>ChoiceList</code> — строки-варианты с подсказкой; недоступная строка помечена <code>aria-disabled</code> и показывает причину;</li>
  <li>необязательная точка у <code>IconButton</code>.</li>
  </ul></dd>
<dt>Движение</dt><dd>
  <ul>
  <li>Лист выезжает за 380 мс, диалог на Mac — за 240 мс, уходят они быстрее.</li>
  <li>Точка черновика появляется один раз.</li>
  <li>Заметки и ошибки проявляются со сдвигом 4 px.</li>
  <li>Карточка подшивается за 380 мс, потом опускается штамп (620 мс).</li>
  </ul>
  При «Меньше движения» — затухание 120 мс, без удара штампа и без пульсации скелетона.</dd>
</dl></div>'''


# The demo state bar; OPT(key, values) renders translated <option>s.
def demo(OPT):
    return f'''  <div class="demo" role="group" aria-label="Demo states" data-i18n-aria="demo.aria">
    <label><span data-i18n="demo.screen">Open</span><select id="d-screen"><option value="">—</option>{OPT('demo.s', ['fresh', 'draftOther', 'invalid', 'long', 'command', 'sending', 'error', 'done', 'clear'])}</select></label>
    <label><span data-i18n="demo.from">Opened from</span><select id="d-from">{OPT('demo.f', ['space', 'needs'])}</select></label>
    <label><span data-i18n="demo.projects">Projects</span><select id="d-projects">{OPT('demo.p', ['many', 'one', 'loading', 'error', 'none'])}</select></label>
    <label><span data-i18n="demo.conn">GitHub</span><select id="d-conn">{OPT('demo.c', ['connected', 'none'])}</select></label>
    <label><span data-i18n="demo.net">Network</span><select id="d-net">{OPT('demo.n', ['online', 'offline'])}</select></label>
    <label><span data-i18n="demo.sprints">Sprints</span><select id="d-sprints">{OPT('demo.sp', ['ok', 'nonext', 'nocur', 'freeze', 'loading', 'error'])}</select></label>
    <label><span data-i18n="demo.reads">Team reads sprint requests</span><select id="d-reads">{OPT('demo.r', ['yes', 'no'])}</select></label>
    <label><span data-i18n="demo.draft">Saved draft</span><select id="d-draft">{OPT('demo.d', ['none', 'same', 'other'])}</select></label>
    <label><span data-i18n="demo.send">Next send</span><select id="d-send">{OPT('demo.x', ['ok', 'not-connected', 'owner-mismatch', 'app-not-installed', 'issues-disabled', 'project-gone', 'rate', 'invalid', 'forbidden', 'network', 'timeout'])}</select></label>
    <label><input type="checkbox" id="d-kb"><span data-i18n="demo.kb">iPhone keyboard up</span></label>
    <p class="demo__help" data-i18n="demo.help"></p>
  </div>
'''
