# #761 PWA install prompt: the card after sign-in, the iPhone guide inside it, the macOS Safari hint, and
# Settings › App. Page spec for build.py. Written next to the other issue folders with its screenshots.
FILE = '../761-install-prompt/wireframe.html'
DOC_TITLE = 'Team Console · #761 · Install the app'
KICKER = 'Team Console · #761 · design for approval'
TITLE = 'Install the app: the card after sign-in and Settings › App'
CSS = ['settings.css', 'push.css', 'install.css']
JS = ['push-i18n.js', 'install-i18n.js', 'install.js']

NOTE_EN = '''
<div class="note__grid"><div>
<p><b>What you are approving.</b> How the console offers to install itself after sign-in (#761). Browsers never install silently, so it is always one tap from you: on Android and in Chrome or Edge that tap opens the browser’s own install window; on iPhone the card shows the three Home Screen steps from #36; in Safari on the Mac it is one line about File → Add to Dock. Flow, states and copy follow the UX spec on #761. Phone first, then the Mac, light and dark, ru and en.</p>
<ul>
<li><b>The card</b> sits at the top of the screen you land on (Needs you, or the project space you were in), under the heading and above the content. It is in the page flow, never fixed or sticky: in a project space on the phone it scrolls away with the board and the bottom section bar stays fully clickable (#368). It is #36’s sunken-paper nudge grown into an offer: the app icon as it will look on your Home Screen, “Install Team Console”, one line on why, then <b>Install</b> (or <b>How to install</b>) and <b>Not now</b>, and <b>Don’t show again</b> as a quiet text button. Every action is 44 px tall on the phone.</li>
<li><b>iPhone.</b> “How to install” opens the steps inside the card (the button becomes “Hide steps”), so they stay on screen while you open Safari’s Share sheet. In Chrome, Edge or Firefox on iPhone, step 1 is “Tap Share in the address bar” and the card does not say “in Safari”.</li>
<li><b>After the browser’s window:</b> Install turns the card into one line, “Team Console is installed”, with focus on it and a × to hide it. Cancel counts as Not now. If the window can’t open, the card stays and says to use the browser menu.</li>
<li><b>Not now</b> hides it for 14 days; <b>Don’t show again</b> for good on this device. Both show the toast “You can install it from Settings → App” and move focus to the page heading. While the card is offered, the push nudge from #36 waits for the next launch: one prompt per launch.</li>
<li><b>Settings › App</b> is a new section between GitHub and Notifications: one row with the app icon, “Install on this device”, a line for this browser and a chip (Installed / Not installed), and the action below it. Ten browser cases, from “You’re in the Team Console app” to “This browser can’t install web apps”. On iPhone the Notifications block no longer repeats the guide: it keeps its title and points to App (question 1 below).</li>
<li><b>Installed app:</b> no card, ever. Settings says Installed. On iPhone the first launch from the icon shows #36’s “Notifications are off · Turn on”.</li>
<li><b>Motion.</b> The card fades in over 140 ms (no slide, nothing pushes the page). The one small moment: when you accept, the icon in the success line lands like an app arriving on a Home Screen (380 ms). Reduced motion: no animation at all.</li>
</ul>
<p class="try">Try: press Install in a frame and pick Install or Cancel in the browser window (a mock). Then press New launch to see the next launch. On iPhone Safari, open the steps, then Settings › Notifications → “How to add it”. The dashed ring shows where focus lands.</p>
</div><dl class="tok">
<dt>Colour</dt><dd>Paper Desk tokens only. Sunken paper for the offer (as #36’s nudge), moss for Install and for the installed line and chip, grey for Not installed, clay only when the install window failed.</dd>
<dt>Type</dt><dd>Source Serif 4 for the card and row titles; Source Sans 3 for the rest. All OFL, self-hosted.</dd>
<dt>New tokens</dt><dd>App tile 40 / 56 px with a 10 px radius (the installed icon’s shape). The bottom bar height the toast lifts above is the app’s existing <code>--tab-bar-h</code>.</dd>
<dt>New kit parts</dt><dd>App tile, install card (offer, steps, one-line hint, success line), the App settings row. Reused: #36’s nudge surface, Home Screen guide and its glyphs, the list row and chip, toast. The #36 icons (bell, share, more, add) moved into the shared kit.</dd>
<dt>Motion</dt><dd>fade 140 · land 380 ms, transform and opacity only; nothing under reduced motion.</dd>
</dl></div>'''

NOTE_RU = '''
<div class="note__grid"><div>
<p><b>Что вы утверждаете.</b> Как консоль после входа предлагает себя установить (#761). Браузеры не устанавливают молча, поэтому это всегда одно ваше касание: на Android и в Chrome или Edge оно открывает окно установки самого браузера; на iPhone карточка показывает три шага из #36 про экран «Домой»; в Safari на Mac — одна строка про «Файл → Добавить в Dock». Сценарий, состояния и тексты — по UX-спеке на #761. Сначала телефон, потом Mac, светлая и тёмная тема, русский и английский.</p>
<ul>
<li><b>Карточка</b> стоит вверху экрана, на который вы попали (Ждут вас или пространство проекта, где вы были), под заголовком и над содержимым. Она в потоке страницы, не закреплена: в пространстве проекта на телефоне она уезжает вместе с доской, а нижняя панель разделов остаётся целиком доступной (#368). Это утоплённая «бумага» подсказки из #36, выросшая в предложение: значок приложения таким, каким он будет на экране «Домой», «Установите Team Console», одна строка зачем, затем <b>«Установить»</b> (или <b>«Как установить»</b>) и <b>«Не сейчас»</b>, а <b>«Больше не показывать»</b> — тихой текстовой кнопкой. На телефоне каждое действие высотой 44 px.</li>
<li><b>iPhone.</b> «Как установить» раскрывает шаги прямо в карточке (кнопка становится «Скрыть шаги»), чтобы они оставались на экране, пока вы открываете «Поделиться» в Safari. В Chrome, Edge или Firefox на iPhone шаг 1 — «Нажмите „Поделиться“ в адресной строке», и карточка не говорит «в Safari».</li>
<li><b>После окна браузера:</b> «Установить» превращает карточку в одну строку «Team Console установлено» — фокус на ней, есть × чтобы скрыть. «Отмена» считается как «Не сейчас». Если окно не открылось, карточка остаётся и говорит установить через меню браузера.</li>
<li><b>«Не сейчас»</b> прячет её на 14 дней, <b>«Больше не показывать»</b> — навсегда на этом устройстве. Оба показывают тост «Установить можно в Настройках → Приложение» и переводят фокус на заголовок страницы. Пока карточка предложена, подсказка про уведомления из #36 ждёт следующего запуска: одна просьба за запуск.</li>
<li><b>Настройки › Приложение</b> — новый раздел между GitHub и «Уведомлениями»: одна строка со значком, «Установить на устройство», строка про этот браузер и чип («Установлено» / «Не установлено»), действие под ней. Десять случаев браузера — от «Вы в приложении Team Console» до «Этот браузер не устанавливает веб‑приложения». На iPhone блок «Уведомления» больше не повторяет инструкцию: оставляет заголовок и ведёт в «Приложение» (вопрос 1 ниже).</li>
<li><b>Установленное приложение:</b> карточки нет никогда. В Настройках — «Установлено». На iPhone первый запуск со значка показывает «Уведомления выключены · Включить» из #36.</li>
<li><b>Движение.</b> Карточка проявляется за 140 мс (без выезда, ничего не сдвигается). Один маленький момент: когда вы соглашаетесь, значок в строке успеха «приземляется», как приложение на экран «Домой» (380 мс). При «Меньше движения» — без анимации вовсе.</li>
</ul>
<p class="try">Попробуйте: нажмите «Установить» в рамке и выберите «Установить» или «Отмена» в окне браузера (макет). Затем «Новый запуск» — так выглядит следующий запуск. На iPhone в Safari раскройте шаги, потом Настройки › Уведомления → «Как добавить». Пунктирное кольцо показывает, куда попадает фокус.</p>
</div><dl class="tok">
<dt>Цвет</dt><dd>Только токены Paper Desk. Утоплённая бумага — предложение (как подсказка из #36), мох — «Установить», строка и чип «Установлено», серый — «Не установлено», глина — только если окно установки не открылось.</dd>
<dt>Шрифты</dt><dd>Source Serif 4 — заголовки карточки и строки; Source Sans 3 — остальное. Все под OFL, шрифты у нас.</dd>
<dt>Новые токены</dt><dd>Плитка значка 40 / 56 px со скруглением 10 px (форма установленного значка). Высота нижней панели, над которой поднимается тост, — уже существующий в приложении <code>--tab-bar-h</code>.</dd>
<dt>Новое в ките</dt><dd>Плитка значка, карточка установки (предложение, шаги, подсказка в одну строку, строка успеха), строка «Приложение» в Настройках. Переиспользуются: поверхность подсказки, инструкция и значки из #36, строка списка и чип, тост. Значки из #36 (колокольчик, «Поделиться», «Ещё», «Добавить») переехали в общий кит.</dd>
<dt>Движение</dt><dd>проявление 140 · приземление 380 мс, только transform и opacity; при «Меньше движения» — ничего.</dd>
</dl></div>'''

STATES = ['offer', 'offerSpace', 'dialog', 'done', 'dismissed', 'error', 'ios', 'iosGuide', 'iosOther', 'later', 'never',
          'nextLaunch', 'late', 'standalone', 'setNative', 'setMenu', 'setIos', 'setIosOpen', 'setInApp', 'setOther',
          'setJust', 'setStandalone', 'setError']
PHONES = ['android', 'androidNoEvent', 'iosSafari', 'iosOther', 'iosInApp', 'standalone']
MACS = ['chrome', 'chromeNoEvent', 'safari', 'safariOld', 'firefox', 'standalone']


def demo(OPT):
    return f'''  <div class="demo" role="group" aria-label="Demo states" data-i18n-aria="demo.aria">
    <label><span data-i18n="demo.state">State</span><select id="d-state">{OPT('demo.s', STATES)}</select></label>
    <label><span data-i18n="demo.phone">Phone</span><select id="d-phone">{OPT('demo.p', PHONES)}</select></label>
    <label><span data-i18n="demo.mac">Mac</span><select id="d-mac">{OPT('demo.m', MACS)}</select></label>
    <label><span data-i18n="demo.prompt">Install window</span><select id="d-prompt">{OPT('demo.pr', ['opens', 'throws'])}</select></label>
    <label><span data-i18n="demo.policy">Ignored card</span><select id="d-policy">{OPT('demo.po', ['three', 'every'])}</select></label>
    <button type="button" class="seg-btn" id="d-launch" data-i18n="demo.launch">New launch</button>
    <button type="button" class="seg-btn" id="d-days" data-i18n="demo.days">+15 days</button>
    <p class="demo__help"><span data-i18n="demo.mem">Stored on the device:</span> <span id="d-mem"></span></p>
    <p class="demo__help" data-i18n="demo.help"></p>
  </div>
'''
