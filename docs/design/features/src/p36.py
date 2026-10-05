# #36 Web push client: the Notifications block in Settings, the iOS Home Screen guide, the nudge on Needs you, where
# a tapped notification leads, and the app badge. Page spec for build.py.
FILE = '36-web-push.html'
DOC_TITLE = 'Team Console · #36 · Notifications'
KICKER = 'Team Console · #36 · design for approval'
TITLE = 'Notifications: turn on, Home Screen guide, tap and badge'
CSS = ['settings.css', 'push.css']
JS = ['push-i18n.js', 'push.js']

NOTE_EN = '''
<div class="note__grid"><div>
<p><b>What you are approving.</b> How push notifications are turned on and what they do on your iPhone and Mac (#36; the server is #11). Push is per device: each device turns it on once, from a button. Nothing asks for permission on its own.</p>
<ul>
<li><b>Where:</b> a <b>Notifications</b> block in Settings, between GitHub and Projects, with the same card as the GitHub block. While push is off on this device, a quiet note on <b>Needs you</b> offers <b>Turn on</b> and <b>Not now</b>. That screen promises “a notification will arrive”, so it should say when that isn’t true. Not now hides the note on this device only.</li>
<li><b>iPhone in Safari:</b> instead of the button, a three-step guide: <b>•••</b> next to the address → Share → Add to Home Screen (leave Open as Web App on) → Add, then open the app from its icon. This is Apple’s current wording for iOS 26/27. The guide also covers the older tab layout. Safari’s <b>•••</b> button below gets a slow ring (two pulses, then steady) so it is easy to find.</li>
<li><b>Every state:</b>
  <ul>
  <li>checking: a skeleton for a moment on load;</li>
  <li>off: the button, and a line saying the device will ask, so tap Allow;</li>
  <li>waiting for your answer, then turning on;</li>
  <li>on: since when, Send a test (once per 30 s), Turn off, and on iPhone a line about the badge;</li>
  <li>blocked: the exact place to allow it again (iPhone Settings, Safari or Chrome) and Check again;</li>
  <li>not supported: iOS older than 16.4, inside another app, a browser without web push;</li>
  <li>offline, and the server refusing.</li>
  </ul></li>
<li><b>Tapping a notification</b> opens the item in its project: <code>/p/storify/questions#42</code>. The card scrolls into view with a moss ring, and focus moves to its title. If you already answered it, the receipt is marked. If it was closed on GitHub, a note says so and links to it. An archived project shows “Project not found”. The test notification opens Needs you.</li>
<li><b>Badge:</b> the number on the iPhone icon equals Needs you. It is set when the app opens or comes back to the front, and it is cleared at 0. In v1 a push doesn’t change it by itself (ADR 0001, “Not yet”), so the badge line in Settings says so. On the Mac, the sidebar count stays the indicator.</li>
<li><b>Motion:</b>
  <ul>
  <li>the “on” tick is drawn in ink, as in the GitHub block;</li>
  <li>a notification slides in 16 px (240 ms);</li>
  <li>the arrival ring swells once (620 ms) and stays while the card has focus.</li>
  </ul>
  With reduced motion everything appears with a 120 ms fade or at once. The ring and the Safari pointer are static.</li>
</ul>
<p class="try">Try on iPhone: “iPhone opens it: in Safari” shows the guide. Switch to “from the Home Screen”, tap Turn on notifications, then Allow in the mock prompt. Send a test, then tap the notification. Then use “Send the push” with each “Push about” option.</p>
</div><dl class="tok">
<dt>Colour</dt><dd>Paper Desk tokens only. Off is neutral, on is moss (<code>--success-*</code>), blocked is ochre (<code>--warning-*</code>), the server error is clay. The ring is <code>--focus</code> with <code>--accent-soft</code>. The iOS badge red <code>#D70015</code> is Apple’s accessible red. It appears only in the mocks and the badge line, and it is 5.2:1 with white. AA in both themes.</dd>
<dt>Type</dt><dd>Source Serif 4 for the card titles, Source Sans 3 for the rest. The system mocks use the system font.</dd>
<dt>Tokens</dt><dd>No new app tokens: the #24 card (<code>.gh</code>), <code>--mark</code>, <code>--target</code>, <code>--dur-sig</code>, <code>--dur-pulse</code>, <code>--ease-emph</code>, <code>--dur-fade</code>. The four <code>--sys-*</code> values are mock-only.</dd>
<dt>Kit</dt><dd>Five new glyphs: <code>bell</code>, <code>bell-off</code>, <code>share</code>, <code>more</code> and <code>add-square</code>. The guide’s numbered steps stay inside <code>features/push-subscribe</code> until a second feature needs them.</dd>
<dt>Motion</dt><dd>sig 620 ms ring, base 240 ms notification, fast 140 ms toast. Reduced: fade 120 ms or none. Only transform, opacity, box-shadow and stroke animate.</dd>
</dl></div>'''

NOTE_RU = '''
<div class="note__grid"><div>
<p><b>Что утверждаешь.</b> Как включаются пуш-уведомления и что они делают на iPhone и Mac (#36; сервер — #11). Пуши настраиваются на каждом устройстве отдельно: один раз, кнопкой. Само по себе приложение разрешение не спрашивает.</p>
<ul>
<li><b>Где:</b> блок <b>«Уведомления»</b> в Настройках, между GitHub и Проектами, в той же карточке, что и GitHub. Пока на этом устройстве пуши выключены, на экране <b>«Ждут тебя»</b> есть тихая заметка с кнопками <b>«Включить»</b> и <b>«Не сейчас»</b>. Этот экран обещает «придёт уведомление», и ему стоит сказать, когда это не так. «Не сейчас» скрывает заметку только на этом устройстве.</li>
<li><b>iPhone в Safari:</b> вместо кнопки — инструкция из трёх шагов: <b>•••</b> рядом с адресом → «Поделиться» → «На экран „Домой“» (оставь «Открыть как веб‑приложение») → «Добавить», потом открыть приложение со значка. Это текущие формулировки Apple для iOS 26/27. Старый вид вкладок тоже учтён. Кнопку Safari <b>•••</b> внизу обводит медленное кольцо (два импульса, потом остаётся), чтобы её было легко найти.</li>
<li><b>Все состояния:</b>
  <ul>
  <li>проверка: на мгновение скелет при загрузке;</li>
  <li>выключено: кнопка и строка «устройство спросит — нажми „Разрешить“»;</li>
  <li>ждём твоего ответа, потом включаем;</li>
  <li>включено: с какого числа, «Прислать тестовое» (раз в 30 с), «Выключить», а на iPhone — строка про значок;</li>
  <li>запрещено: где именно вернуть разрешение (Настройки iPhone, Safari или Chrome) и «Проверить снова»;</li>
  <li>не поддерживается: iOS старше 16.4, внутри другого приложения, браузер без веб-пушей;</li>
  <li>нет связи и сервер отказал.</li>
  </ul></li>
<li><b>Нажатие на уведомление</b> открывает пункт в его проекте: <code>/p/storify/questions#42</code>. Карточка прокручивается в поле зрения с моховым кольцом, фокус переходит на её заголовок. Если ты уже ответил, отмечена квитанция. Если пункт закрыли на GitHub — заметка об этом со ссылкой. Архивный проект — «Проект не найден». Тестовое уведомление открывает «Ждут тебя».</li>
<li><b>Значок:</b> число на иконке iPhone равно «Ждут тебя». Приложение ставит его при открытии и при возвращении на экран и убирает при нуле. В v1 сам пуш число не меняет (ADR 0001, «Not yet») — строка в Настройках так и говорит. На Mac показателем остаётся счётчик в боковой панели.</li>
<li><b>Движение:</b>
  <ul>
  <li>галочка «включено» рисуется чернилами, как в блоке GitHub;</li>
  <li>уведомление въезжает на 16 px (240 мс);</li>
  <li>кольцо прихода один раз расходится (620 мс) и остаётся, пока карточка в фокусе.</li>
  </ul>
  При «Меньше движения» всё появляется проявлением 120 мс или сразу. Кольцо и указатель Safari статичны.</li>
</ul>
<p class="try">Попробуй на iPhone: «iPhone открывает: в Safari» — инструкция. Переключи на «с экрана „Домой“», нажми «Включить уведомления», потом «Разрешить» в окне-макете. Пришли тестовое и нажми на уведомление. Потом «Прислать пуш» с каждым вариантом «Пуш про».</p>
</div><dl class="tok">
<dt>Цвет</dt><dd>Только токены Paper Desk. Выключено — нейтрально, включено — мох (<code>--success-*</code>), запрещено — охра (<code>--warning-*</code>), ошибка сервера — глина. Кольцо — <code>--focus</code> с <code>--accent-soft</code>. Красный значка iOS <code>#D70015</code> — доступный красный Apple. Он есть только в макетах и строке про значок и даёт 5,2:1 с белым. AA в обеих темах.</dd>
<dt>Шрифты</dt><dd>Source Serif 4 в заголовках карточек, Source Sans 3 в остальном. Системные макеты — системным шрифтом.</dd>
<dt>Токены</dt><dd>Новых токенов приложения нет: карточка из #24 (<code>.gh</code>), <code>--mark</code>, <code>--target</code>, <code>--dur-sig</code>, <code>--dur-pulse</code>, <code>--ease-emph</code>, <code>--dur-fade</code>. Четыре значения <code>--sys-*</code> — только для макетов.</dd>
<dt>Кит</dt><dd>Пять новых глифов: <code>bell</code>, <code>bell-off</code>, <code>share</code>, <code>more</code> и <code>add-square</code>. Нумерованные шаги инструкции остаются внутри <code>features/push-subscribe</code>, пока не понадобятся второй фиче.</dd>
<dt>Движение</dt><dd>sig 620 мс — кольцо, base 240 мс — уведомление, fast 140 мс — тост. При «Меньше движения» — проявление 120 мс или ничего. Анимируются только transform, opacity, box-shadow и stroke.</dd>
</dl></div>'''


# The demo state bar; OPT(key, values) renders translated <option>s.
def demo(OPT):
    return f'''  <div class="demo" role="group" aria-label="Demo states" data-i18n-aria="demo.aria">
    <label><span data-i18n="demo.screen">Screen</span><select id="d-screen">{OPT('demo.s', ['settings', 'needs', 'home'])}</select></label>
    <label><span data-i18n="demo.phone">iPhone opens it</span><select id="d-phone">{OPT('demo.p', ['safari', 'app', 'old', 'inapp'])}</select></label>
    <label><span data-i18n="demo.mac">Mac browser</span><select id="d-mac">{OPT('demo.m', ['safari', 'chrome', 'old'])}</select></label>
    <label><span data-i18n="demo.perm">Permission</span><select id="d-perm">{OPT('demo.pm', ['default', 'denied', 'on'])}</select></label>
    <label><span data-i18n="demo.result">Server</span><select id="d-result">{OPT('demo.r', ['ok', 'error', 'offline'])}</select></label>
    <label><span data-i18n="demo.target">Push about</span><select id="d-target">{OPT('demo.t', ['open', 'answered', 'closed', 'archived'])}</select></label>
    <button type="button" class="seg-btn" id="d-push" data-i18n="demo.push">Send the push</button>
    <p class="demo__help" data-i18n="demo.help"></p>
    <p class="demo__help" id="d-opened" aria-live="polite"></p>
  </div>
'''
