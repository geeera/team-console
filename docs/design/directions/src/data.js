/* Mock content: real examples from storify; other projects kept short.
   L(en, ru) marks text the owner reads; repo issue and document titles stay as they are in GitHub.
   Dates are ISO (local time) and formatted with Intl for the chosen language. */
const DATA = (() => {
  const L = (en, ru) => ({ en, ru });
  const today = '2026-09-29';
  const P = (o) => Object.assign({ pinned: false, quiet: false, status: 'running', ci: 'green', prs: 0, soon: false }, o);
  const projects = [
    P({ id: 'storify', name: 'storify', pinned: true, sprint: '01', demo: '2026-10-09', soon: true, done: 3, total: 9, prs: 2 }),
    P({ id: 'team-console', name: 'team-console', pinned: true, sprint: '00', demo: '2026-10-13', soon: true, done: 1, total: 6, prs: 1 }),
    P({ id: 'fieldnote', name: 'fieldnote', status: 'failing', sprint: '04', demo: '2026-10-02', soon: true, done: 5, total: 8, prs: 3, ci: 'red', runFails: 2 }),
    P({ id: 'sheltrix', name: 'sheltrix', status: 'paused', pausedSince: '2026-09-22', sprint: '03', demo: null, done: 7, total: 7, prs: 2 }),
  ];
  const quiet = [
    ['atlas-cli', '02', '2026-10-16', 2, 5], ['brewlog', '05', '2026-10-06', 4, 6], ['kinder', '01', '2026-10-20', 0, 4],
    ['orbit-notes', '07', '2026-10-08', 6, 7], ['pagecraft', '02', '2026-10-14', 1, 5], ['tidy-inbox', '03', '2026-10-10', 3, 6],
  ];
  quiet.forEach(([name, sprint, demo, done, total], i) => projects.push(P({
    id: name, name, quiet: true, sprint, demo, done, total, prs: i % 3,
    status: name === 'kinder' ? 'paused' : 'running', pausedSince: '2026-09-01',
  })));

  const logs = {
    storify: [
      { t: 'day', date: '2026-09-28' },
      { t: 'msg', who: 'pm', at: '2026-09-28T18:04', html: L(
        '<p>I need your hands here: stage can’t ship without the Oracle and Cloudflare accounts. The steps are in the card, about 15 minutes.</p>',
        '<p>Нужна твоя помощь: без аккаунтов Oracle и Cloudflare stage не выкатить. Шаги в карточке, это минут 15.</p>') },
      {
        t: 'card', id: '72', kind: 'action', icon: 'key', label: L('Action · access', 'Действие · доступ'),
        title: L('Create Oracle and Cloudflare accounts and deploy secrets', 'Заведи аккаунты Oracle и Cloudflare и добавь секреты для деплоя'),
        text: L('Only you can open these accounts. The stage deploy waits on them.', 'Открыть эти аккаунты можешь только ты. Деплой на stage ждёт их.'),
        steps: [
          L('Oracle Cloud Free Tier account and an API key', 'Аккаунт Oracle Cloud Free Tier и API-ключ'),
          L('Cloudflare account and an API token with <i>Pages: Edit</i>', 'Аккаунт Cloudflare и API-токен с правом <i>Pages: Edit</i>'),
          L('Add <code>ORACLE_API_KEY</code> and <code>CLOUDFLARE_API_TOKEN</code> to the repo’s GitHub Secrets', 'Добавь <code>ORACLE_API_KEY</code> и <code>CLOUDFLARE_API_TOKEN</code> в GitHub Secrets репозитория'),
        ],
        meta: L('Blocks stage deploy · asked yesterday', 'Блокирует деплой на stage · ждёт со вчера'),
        actions: [{ id: 'done', label: L('Done', 'Готово'), key: 'd', primary: true }, { id: 'later', label: L('Not yet', 'Пока нет'), key: 'l' }],
        receipts: {
          done: { tone: 'positive', verb: L('Done', 'Готово'), detail: L('accounts created, secrets added', 'аккаунты заведены, секреты добавлены'),
            pm: L('Thanks! I’ll check the secrets, start the stage deploy and tell you when it’s up.', 'Спасибо! Проверю секреты, запущу деплой на stage и напишу, когда поднимется.') },
          later: { tone: 'neutral', verb: L('Not yet', 'Пока нет'), detail: L('remind me tomorrow 10:00', 'напомнить завтра в 10:00'),
            pm: L('OK, I’ll remind you tomorrow at 10:00. While stage waits, we take items that don’t need a deploy.', 'Хорошо, напомню завтра в 10:00. Пока stage ждёт, берём задачи без деплоя.') },
        },
      },
      { t: 'msg', who: 'pm', at: '2026-09-28T18:20', html: L(
        '<p>The story editor states are ready: empty, error, offline. The prototype is in the card.</p>',
        '<p>Готовы состояния редактора историй: пустое, ошибка, офлайн. Прототип в карточке.</p>') },
      {
        t: 'card', id: '47', kind: 'design', icon: 'image', label: L('Design approval', 'Согласование дизайна'),
        title: L('Story editor: empty, error and offline states', 'Редактор историй: пустое состояние, ошибка и офлайн'), thumb: true,
        text: L('Three states from the UX spec, light and dark.', 'Три состояния из UX-спеки, в светлой и тёмной теме.'),
        meta: L('UI designer · prototype on dev', 'UI-дизайнер · прототип на dev'),
        actions: [{ id: 'approve', label: L('Approve', 'Утвердить'), key: 'a', primary: true }, { id: 'changes', label: L('Request changes', 'Нужны правки'), key: 'c' }],
        receipts: {
          approve: { tone: 'positive', verb: L('Approved', 'Утверждено'), detail: L('story editor states', 'состояния редактора историй'),
            pm: L('Design approved, handing it to development: #49 continues with it.', 'Дизайн утверждён, передаю в разработку: #49 продолжит с ним.') },
          changes: { tone: 'neutral', verb: L('Changes requested', 'Нужны правки'), detail: L('story editor states', 'состояния редактора историй'),
            pm: L('What should change? One sentence is enough, I’ll pass it to the designer.', 'Что поправить? Хватит одной фразы, передам дизайнеру.') },
        },
      },
      { t: 'day', date: today },
      { t: 'msg', who: 'owner', at: `${today}T10:41`, html: L('<p>what’s new?</p>', '<p>что нового?</p>') },
      {
        t: 'msg', who: 'pm', at: `${today}T10:41`, html: L(
          '<p>storify in the last 24 hours, briefly.</p>' +
          '<p class="brief__h">Shipped: 3</p>' +
          '<ul><li>Infinite story feed <span class="ref">#41</span></li><li>Story export to PDF <span class="ref">#38</span></li><li>Magic-link sign-in <span class="ref">#29</span></li></ul>' +
          '<p class="brief__h">Your decision needed: 2</p>' +
          '<ul><li><span class="ref">#13</span> wip/craft-i18n: merge or close. I recommend closing.</li><li>Sprint 01 demo, 9 Oct: go / no-go.</li></ul>' +
          '<p class="brief__foot">Still waiting since yesterday: the accounts (#72) and the editor design (#47).</p>',
          '<p>Коротко по storify за сутки.</p>' +
          '<p class="brief__h">Выпущено: 3</p>' +
          '<ul><li>Лента историй с бесконечной прокруткой <span class="ref">#41</span></li><li>Экспорт истории в PDF <span class="ref">#38</span></li><li>Вход по magic-link <span class="ref">#29</span></li></ul>' +
          '<p class="brief__h">Нужно твоё решение: 2</p>' +
          '<ul><li><span class="ref">#13</span> wip/craft-i18n: слить или закрыть. Советую закрыть.</li><li>Демо спринта 01, 9 окт.: go / no-go.</li></ul>' +
          '<p class="brief__foot">Со вчера ещё ждут аккаунты (#72) и дизайн редактора (#47).</p>'),
      },
      {
        t: 'card', id: '13', kind: 'decision', icon: 'branch', label: L('Decision · scope', 'Решение · объём работ'),
        title: L('Decide wip/craft-i18n: merge or close', 'wip/craft-i18n: слить или закрыть?'),
        rec: {
          choice: L('Close the branch', 'Закрыть ветку'),
          why: L('It is 38 commits behind main and its strings already live in #51. Merging would reopen 6 conflicts for no new behaviour.',
            'Ветка отстала от main на 38 коммитов, а её строки уже есть в #51. Слияние вернёт 6 конфликтов и ничего нового не даст.'),
        },
        meta: L('PM and tech lead · asked today', 'PM и техлид · сегодня'),
        actions: [{ id: 'approve', label: L('Approve · close', 'Да, закрыть'), key: 'a', primary: true }, { id: 'reject', label: L('Reject · merge', 'Нет, слить'), key: 'r' }],
        receipts: {
          approve: { tone: 'positive', verb: L('Approved', 'Утверждено'), detail: L('close wip/craft-i18n', 'закрыть wip/craft-i18n'),
            pm: L('Got it: closing wip/craft-i18n, the strings stay in #51.', 'Принято: закрываю wip/craft-i18n, строки остаются в #51.') },
          reject: { tone: 'negative', verb: L('Rejected', 'Отклонено'), detail: L('merge wip/craft-i18n instead', 'слить wip/craft-i18n'),
            pm: L('Understood, we merge. I’ll open an item for the 6 conflicts (standard) and take it into Sprint 01.', 'Хорошо, сливаем. Заведу задачу на 6 конфликтов (средняя) и возьмём её в спринт 01.') },
        },
      },
      {
        t: 'card', id: '75', kind: 'release', icon: 'flag', label: L('Release · go / no-go', 'Релиз · go / no-go'),
        title: L('Sprint 01 demo: go / no-go', 'Демо спринта 01: go / no-go'),
        checks: [
          { s: 'ok', t: L('CI green on stage · 3 items shipped', 'CI на stage зелёный · выпущено 3 задачи') },
          { s: 'ok', t: L('QA passed 14 of 14 checks', 'QA: пройдено 14 проверок из 14') },
          { s: 'warn', t: L('1 known issue: #50 dark theme polish (light), follow-up', '1 известная проблема: #50 доводка тёмной темы (лёгкая), доделаем следом') },
        ],
        meta: L('Demo 9 Oct · release right after', 'Демо 9 окт. · релиз сразу после'),
        actions: [{ id: 'go', label: L('Go', 'Проводим'), key: 'g', primary: true }, { id: 'nogo', label: L('No-go', 'Переносим'), key: 'n' }],
        receipts: {
          go: { tone: 'positive', verb: L('Go', 'Go'), detail: L('Sprint 01 demo on 9 Oct', 'демо спринта 01, 9 окт.'),
            pm: L('Go recorded. The demo page opens on 9 Oct, release right after the demo.', 'Принято: go. Демо-страница откроется 9 окт., релиз сразу после демо.') },
          nogo: { tone: 'negative', verb: L('No-go', 'No-go'), detail: L('Sprint 01 demo held', 'демо спринта 01 переносится'),
            pm: L('No-go recorded. What must be in the demo? Tell me and I’ll move the date.', 'Принято: no-go. Что должно войти в демо? Напиши, и я перенесу дату.') },
        },
      },
    ],
    'team-console': [
      { t: 'day', date: today },
      { t: 'msg', who: 'pm', at: `${today}T09:12`, html: L(
        '<p>Kickoff is done: the brief and ADR-0001 are in artifacts. Push on iPhone needs one step from you.</p>',
        '<p>Кикофф закрыт: бриф и ADR-0001 в артефактах. Для пушей на iPhone нужен один шаг с твоей стороны.</p>') },
      {
        t: 'card', id: '9', kind: 'action', icon: 'key', label: L('Action · device', 'Действие · устройство'),
        title: L('Install the dev build to the Home Screen to allow push', 'Установи dev-сборку на экран «Домой», чтобы получать пуши'),
        text: L('iOS only delivers web push to installed apps. Open dev in Safari, Share, Add to Home Screen, then allow notifications.',
          'iOS присылает веб-пуши только установленным приложениям. Открой dev в Safari, нажми «Поделиться» → «На экран „Домой“» и разреши уведомления.'),
        meta: L('Needed for Sprint 00 demo · asked today', 'Нужно для демо спринта 00 · сегодня'),
        actions: [{ id: 'done', label: L('Done', 'Готово'), key: 'd', primary: true }, { id: 'later', label: L('Not yet', 'Пока нет'), key: 'l' }],
        receipts: {
          done: { tone: 'positive', verb: L('Done', 'Готово'), detail: L('installed, push allowed', 'установлено, пуши разрешены'),
            pm: L('Great, I’ll send a test push within a minute.', 'Отлично, пришлю тестовый пуш в течение минуты.') },
          later: { tone: 'neutral', verb: L('Not yet', 'Пока нет'), detail: L('remind me tonight', 'напомнить вечером'),
            pm: L('I’ll remind you tonight.', 'Напомню вечером.') },
        },
      },
    ],
    fieldnote: [
      { t: 'day', date: today },
      { t: 'msg', who: 'pm', at: `${today}T07:30`, html: L(
        '<p>The nightly run failed for the second time in a row: the sync e2e tests time out on CI. Friday’s demo is at risk.</p>',
        '<p>Ночной прогон упал второй раз подряд: e2e-тесты синхронизации падают по таймауту на CI. Демо в пятницу под угрозой.</p>') },
      {
        t: 'card', id: '31', kind: 'decision', icon: 'warn', label: L('Decision · run health', 'Решение · прогоны'),
        title: L('Nightly run failed twice: pause fieldnote until e2e is fixed?', 'Ночной прогон упал дважды: остановить fieldnote, пока не починим e2e?'),
        rec: {
          choice: L('Pause feature work, fix e2e first', 'Отложить фичи, сначала починить e2e'),
          why: L('Two failed runs in a row; the flaky sync suite blocks every PR. One heavy item, about a day.',
            'Два упавших прогона подряд, нестабильные тесты синхронизации блокируют каждый PR. Одна тяжёлая задача, примерно день.'),
        },
        meta: L('Run log · 2 failures since 28 Sep', 'Журнал прогонов · 2 сбоя с 28 сент.'),
        actions: [{ id: 'approve', label: L('Approve · fix first', 'Да, сначала починить'), key: 'a', primary: true }, { id: 'reject', label: L('Reject · keep going', 'Нет, продолжать'), key: 'r' }],
        receipts: {
          approve: { tone: 'positive', verb: L('Approved', 'Утверждено'), detail: L('fix e2e before features', 'сначала e2e, потом фичи'),
            pm: L('Got it. Taking #33 (heavy), the rest waits. I’ll tell you when the run is green.', 'Принято. Беру #33 (тяжёлая), остальное ждёт. Сообщу, когда прогон позеленеет.') },
          reject: { tone: 'negative', verb: L('Rejected', 'Отклонено'), detail: L('keep feature work going', 'продолжаем работу над фичами'),
            pm: L('Understood, we keep going. I’ll mark e2e as a known issue for the demo.', 'Хорошо, продолжаем. Отмечу e2e как известную проблему для демо.') },
        },
      },
    ],
    sheltrix: [
      { t: 'day', date: '2026-09-22' },
      { t: 'msg', who: 'owner', at: '2026-09-22T19:10', html: L('<p>pause sheltrix until we finish storify</p>', '<p>поставь sheltrix на паузу, пока не закончим storify</p>') },
      { t: 'msg', who: 'pm', at: '2026-09-22T19:11', html: L(
        '<p>Done: sheltrix is paused. Sprint 03 is closed (7 of 7); two PRs stay open: #88 and #91. No questions for you.</p>',
        '<p>Готово: sheltrix на паузе. Спринт 03 закрыт (7 из 7), два PR остались открытыми: #88 и #91. Вопросов к тебе нет.</p>') },
      { t: 'note', key: 'note.pausedAt', name: 'sheltrix', at: '2026-09-22T19:12' },
    ],
  };
  quiet.forEach(([name, sprint]) => {
    logs[name] = [{ t: 'day', date: '2026-09-28' }, { t: 'msg', who: 'pm', at: '2026-09-28T09:00', html: L(
      `<p>Sprint ${sprint} is on track, no questions for you.</p>`,
      `<p>Спринт ${sprint} идёт по плану, вопросов к тебе нет.</p>`) }];
  });

  // Board items are GitHub issue titles and stay as written in the repo.
  const boards = {
    storify: {
      approved: [{ n: 54, t: 'Share-link preview card', tier: 'light' }, { n: 57, t: 'Onboarding tour', tier: 'standard' }],
      progress: [{ n: 49, t: 'Story editor autosave', tier: 'heavy', sub: L('PR #61 · CI running', 'PR #61 · CI идёт') }, { n: 52, t: 'Tag filter', tier: 'standard', sub: L('PR #60 · CI green', 'PR #60 · CI зелёный') }],
      qa: [{ n: 45, t: 'Comments on stories', tier: 'standard' }, { n: 50, t: 'Dark theme polish', tier: 'light' }],
      done: [{ n: 41, t: 'Infinite story feed', tier: 'standard' }, { n: 38, t: 'PDF export', tier: 'heavy' }, { n: 29, t: 'Magic-link sign-in', tier: 'standard' }],
    },
    'team-console': {
      approved: [{ n: 4, t: 'Push relay worker', tier: 'standard' }, { n: 5, t: 'Needs-you list', tier: 'standard' }],
      progress: [{ n: 3, t: 'GitHub auth + session', tier: 'heavy', sub: L('PR #8 · CI green', 'PR #8 · CI зелёный') }, { n: 7, t: 'Design tokens + kit', tier: 'standard' }],
      qa: [{ n: 2, t: 'PWA shell and install', tier: 'light' }],
      done: [{ n: 1, t: 'Repo, CI and dev deploy', tier: 'standard' }],
    },
    fieldnote: {
      approved: [{ n: 36, t: 'Export to Markdown', tier: 'light' }],
      progress: [{ n: 33, t: 'Fix flaky sync e2e', tier: 'heavy', sub: L('Run failing · 2×', 'Прогон падает · 2×') }, { n: 34, t: 'Offline badge', tier: 'light', sub: L('PR #40 · CI red', 'PR #40 · CI красный') }],
      qa: [{ n: 30, t: 'Tag autocomplete', tier: 'standard' }],
      done: [{ n: 25, t: 'Note sync', tier: 'heavy' }, { n: 27, t: 'Search', tier: 'standard' }, { n: 28, t: 'Pinning', tier: 'light' }, { n: 29, t: 'Share sheet', tier: 'light' }, { n: 26, t: 'Import', tier: 'standard' }],
    },
  };

  // Titles of repo documents and issues stay as written; what the team generates for the owner is translated.
  const A = (type, title, meta, extra) => Object.assign({ type, title, meta }, extra || {});
  const artifacts = {
    storify: [
      A('design', 'Story editor: empty, error, offline', L('#47 · awaiting your approval', '#47 · ждёт твоего согласования'), { awaiting: '47' }),
      A('design', 'Feed: infinite scroll', L('#41 · approved 24 Sep', '#41 · утверждено 24 сент.')),
      A('demo', L('Sprint 01 demo page', 'Демо-страница спринта 01'), L('draft · opens 9 Oct', 'черновик · откроется 9 окт.')),
      A('adr', 'ADR-0001 Stack and architecture', L('accepted 18 Sep', 'принято 18 сент.')),
      A('adr', 'ADR-0002 PDF export via server render', L('accepted 25 Sep', 'принято 25 сент.')),
      A('audit', L('Accessibility audit: feed', 'Аудит доступности: лента'), L('2 issues, both light', '2 замечания, оба лёгкие')),
      A('audit', L('Security review: magic-link', 'Ревью безопасности: magic-link'), L('passed 27 Sep', 'пройдено 27 сент.')),
      A('brief', L('Briefing 29 Sep', 'Сводка 29 сент.'), L('3 shipped · 2 questions', 'выпущено 3 · 2 вопроса')),
      A('brief', L('Briefing 28 Sep', 'Сводка 28 сент.'), L('1 shipped · 1 question', 'выпущена 1 · 1 вопрос')),
      A('release', L('v0.1.0 first internal build', 'v0.1.0 первая внутренняя сборка'), L('changelog · 12 items', 'список изменений · 12 пунктов')),
      A('deploy', 'dev · dev.storify.example', L('live · updated 10:30', 'работает · обновлено в 10:30')),
      A('deploy', 'stage · stage.storify.example', L('waiting on #72', 'ждёт #72')),
    ],
    'team-console': [
      A('design', L('Visual directions 01 to 03', 'Визуальные направления 01–03'), L('kickoff · awaiting your pick', 'кикофф · ждёт твоего выбора')),
      A('adr', 'ADR-0001 Stack and architecture', L('accepted today', 'принято сегодня')),
      A('brief', L('Product brief', 'Бриф продукта'), L('kickoff · 29 Sep', 'кикофф · 29 сент.')),
      A('deploy', 'dev · console-dev.example', L('live', 'работает')),
    ],
    fieldnote: [
      A('audit', L('Run log: 2 failed nightly runs', 'Журнал прогонов: 2 упавших ночных прогона'), L('28 and 29 Sep', '28 и 29 сент.')),
      A('demo', L('Sprint 04 demo page', 'Демо-страница спринта 04'), L('draft · opens 2 Oct', 'черновик · откроется 2 окт.')),
      A('release', 'v0.4.0', L('changelog · 9 items', 'список изменений · 9 пунктов')),
      A('deploy', 'stage · fieldnote-stage.example', L('last good build 27 Sep', 'последняя рабочая сборка 27 сент.')),
    ],
    sheltrix: [
      A('release', 'v1.2.0', L('changelog · 7 items · 20 Sep', 'список изменений · 7 пунктов · 20 сент.')),
      A('demo', L('Sprint 03 demo page', 'Демо-страница спринта 03'), L('held 19 Sep', 'прошло 19 сент.')),
      A('adr', 'ADR-0004 Queue on Postgres', L('accepted', 'принято')),
    ],
  };
  quiet.forEach(([name, sprint]) => { artifacts[name] = [A('brief', L(`Briefing: Sprint ${sprint}`, `Сводка: спринт ${sprint}`), L('Monday', 'понедельник'))]; });

  const artifactTypes = ['design', 'demo', 'adr', 'audit', 'brief', 'release', 'deploy'];

  const replies = {
    running: L('Got it. I’ll add this to the backlog as light and reply when there’s a plan.', 'Принято. Заведу это в бэклог как лёгкую задачу и отвечу, когда будет план.'),
    paused: L('The project is paused. Noted; we’ll take it after it resumes.', 'Проект на паузе. Записано, возьмём после возобновления.'),
    failing: L('Got it. We fix the run first, then I’ll take this on.', 'Принято. Сначала чиним прогон, потом возьмусь за это.'),
  };

  return { today, projects, logs, boards, artifacts, artifactTypes, replies };
})();
