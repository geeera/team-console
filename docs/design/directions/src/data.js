/* Mock content: real examples from storify; other projects kept short. */
const DATA = (() => {
  const P = (o) => Object.assign({ pinned: false, quiet: false, status: 'running', ci: 'green', prs: 0, run: 'healthy' }, o);
  const projects = [
    P({ id: 'storify', name: 'storify', pinned: true, sprint: 'Sprint 01', demo: '9 Oct', demoIn: 'in 10 days', done: 3, total: 9, prs: 2 }),
    P({ id: 'team-console', name: 'team-console', pinned: true, sprint: 'Sprint 00', demo: '13 Oct', demoIn: 'in 14 days', done: 1, total: 6, prs: 1 }),
    P({ id: 'fieldnote', name: 'fieldnote', status: 'failing', sprint: 'Sprint 04', demo: '2 Oct', demoIn: 'in 3 days', done: 5, total: 8, prs: 3, ci: 'red', run: '2 failed runs' }),
    P({ id: 'sheltrix', name: 'sheltrix', status: 'paused', pausedSince: '22 Sep', sprint: 'Sprint 03', demo: 'none', demoIn: '', done: 7, total: 7, prs: 2, run: 'paused' }),
  ];
  const quiet = [
    ['atlas-cli', 'Sprint 02', '16 Oct', 2, 5], ['brewlog', 'Sprint 05', '6 Oct', 4, 6], ['kinder', 'Sprint 01', '20 Oct', 0, 4],
    ['orbit-notes', 'Sprint 07', '8 Oct', 6, 7], ['pagecraft', 'Sprint 02', '14 Oct', 1, 5], ['tidy-inbox', 'Sprint 03', '10 Oct', 3, 6],
  ];
  quiet.forEach(([name, sprint, demo, done, total], i) => projects.push(P({
    id: name, name, quiet: true, sprint, demo, demoIn: '', done, total, prs: i % 3,
    status: name === 'kinder' ? 'paused' : 'running', pausedSince: '1 Sep',
  })));

  const logs = {
    storify: [
      { t: 'day', text: 'Yesterday' },
      { t: 'msg', who: 'pm', time: '18:04', html: '<p>Нужны ваши руки: без аккаунтов Oracle и Cloudflare stage не выкатить. Шаги в карточке, это минут 15.</p>' },
      {
        t: 'card', id: '72', kind: 'action', icon: 'key', label: 'Action · access',
        title: 'Create Oracle and Cloudflare accounts and deploy secrets',
        text: 'Only you can open these accounts. The stage deploy waits on them.',
        steps: ['Oracle Cloud Free Tier account and an API key', 'Cloudflare account and an API token with <i>Pages: Edit</i>', 'Add <code>ORACLE_API_KEY</code> and <code>CLOUDFLARE_API_TOKEN</code> to the repo’s GitHub Secrets'],
        meta: 'Blocks stage deploy · asked yesterday',
        actions: [{ id: 'done', label: 'Done', key: 'd', primary: true }, { id: 'later', label: 'Not yet', key: 'l' }],
        receipts: {
          done: { tone: 'positive', verb: 'Done', detail: 'accounts created, secrets added', pm: 'Спасибо! Проверю секреты и запущу деплой на stage, отпишусь, когда поднимется.' },
          later: { tone: 'neutral', verb: 'Not yet', detail: 'remind me tomorrow 10:00', pm: 'Хорошо, напомню завтра в 10:00. Пока stage ждёт, берём задачи без деплоя.' },
        },
      },
      { t: 'msg', who: 'pm', time: '18:20', html: '<p>Дизайнер подготовил состояния редактора историй: пустое, ошибка, офлайн. Прототип в карточке.</p>' },
      {
        t: 'card', id: '47', kind: 'design', icon: 'image', label: 'Design approval',
        title: 'Story editor: empty, error and offline states', thumb: true,
        text: 'Three states from the UX spec, light and dark.',
        meta: 'UI designer · prototype on dev',
        actions: [{ id: 'approve', label: 'Approve', key: 'a', primary: true }, { id: 'changes', label: 'Request changes', key: 'c' }],
        receipts: {
          approve: { tone: 'positive', verb: 'Approved', detail: 'story editor states', pm: 'Дизайн утверждён, передаю в разработку: #49 продолжит с ним.' },
          changes: { tone: 'neutral', verb: 'Changes requested', detail: 'story editor states', pm: 'Что поправить? Напишите одной фразой, передам дизайнеру.' },
        },
      },
      { t: 'day', text: 'Today' },
      { t: 'msg', who: 'owner', time: '10:41', html: '<p>что нового?</p>' },
      {
        t: 'msg', who: 'pm', time: '10:41', html:
          '<p>Коротко по storify за сутки.</p>' +
          '<p class="brief__h">Отгружено: 3</p>' +
          '<ul><li>Лента историй с бесконечной прокруткой <span class="ref">#41</span></li><li>Экспорт истории в PDF <span class="ref">#38</span></li><li>Вход по magic-link <span class="ref">#29</span></li></ul>' +
          '<p class="brief__h">Нужно ваше решение: 2</p>' +
          '<ul><li><span class="ref">#13</span> wip/craft-i18n: слить или закрыть. Рекомендую закрыть.</li><li>Демо Sprint 01, 9 окт: go / no-go.</li></ul>' +
          '<p class="brief__foot">Со вчера ещё ждут аккаунты (#72) и дизайн редактора (#47).</p>',
      },
      {
        t: 'card', id: '13', kind: 'decision', icon: 'branch', label: 'Decision · scope',
        title: 'Decide wip/craft-i18n: merge or close',
        rec: { choice: 'Close the branch', why: 'It is 38 commits behind main and its strings already live in #51. Merging would reopen 6 conflicts for no new behaviour.' },
        meta: 'PM and tech lead · asked today',
        actions: [{ id: 'approve', label: 'Approve · close', key: 'a', primary: true }, { id: 'reject', label: 'Reject · merge', key: 'r' }],
        receipts: {
          approve: { tone: 'positive', verb: 'Approved', detail: 'close wip/craft-i18n', pm: 'Принято: закрываю wip/craft-i18n, строки остаются в #51.' },
          reject: { tone: 'negative', verb: 'Rejected', detail: 'merge wip/craft-i18n instead', pm: 'Понял, сливаем. Заведу задачу на 6 конфликтов (standard) и возьмём её в Sprint 01.' },
        },
      },
      {
        t: 'card', id: '75', kind: 'release', icon: 'flag', label: 'Release · go / no-go',
        title: 'Sprint 01 demo: go / no-go',
        checks: [{ s: 'ok', t: 'CI green on stage · 3 items shipped' }, { s: 'ok', t: 'QA passed 14 of 14 checks' }, { s: 'warn', t: '1 known issue: #50 dark theme polish (light), follow-up' }],
        meta: 'Demo 9 Oct · release right after',
        actions: [{ id: 'go', label: 'Go', key: 'g', primary: true }, { id: 'nogo', label: 'No-go', key: 'n' }],
        receipts: {
          go: { tone: 'positive', verb: 'Go', detail: 'Sprint 01 demo on 9 Oct', pm: 'Go принят. Демо-страница откроется 9 окт, релиз сразу после демо.' },
          nogo: { tone: 'negative', verb: 'No-go', detail: 'Sprint 01 demo held', pm: 'No-go записан. Что должно войти в демо? Напишите, и я перенесу дату.' },
        },
      },
    ],
    'team-console': [
      { t: 'day', text: 'Today' },
      { t: 'msg', who: 'pm', time: '09:12', html: '<p>Кикофф закрыт: бриф и ADR-0001 в артефактах. Для пушей на iPhone нужен один шаг с вашей стороны.</p>' },
      {
        t: 'card', id: '9', kind: 'action', icon: 'key', label: 'Action · device',
        title: 'Install the dev build to the Home Screen to allow push',
        text: 'iOS only delivers web push to installed apps. Open dev in Safari, Share, Add to Home Screen, then allow notifications.',
        meta: 'Needed for Sprint 00 demo · asked today',
        actions: [{ id: 'done', label: 'Done', key: 'd', primary: true }, { id: 'later', label: 'Not yet', key: 'l' }],
        receipts: {
          done: { tone: 'positive', verb: 'Done', detail: 'installed, push allowed', pm: 'Отлично, отправлю тестовый пуш в течение минуты.' },
          later: { tone: 'neutral', verb: 'Not yet', detail: 'remind me tonight', pm: 'Напомню вечером.' },
        },
      },
    ],
    fieldnote: [
      { t: 'day', text: 'Today' },
      { t: 'msg', who: 'pm', time: '07:30', html: '<p>Ночной прогон упал второй раз подряд: e2e-тесты синхронизации таймаутят на CI. Демо в пятницу под угрозой.</p>' },
      {
        t: 'card', id: '31', kind: 'decision', icon: 'warn', label: 'Decision · run health',
        title: 'Nightly run failed twice: pause fieldnote until e2e is fixed?',
        rec: { choice: 'Pause feature work, fix e2e first', why: 'Two failed runs in a row; the flaky sync suite blocks every PR. One heavy item, about a day.' },
        meta: 'Run log · 2 failures since 28 Sep',
        actions: [{ id: 'approve', label: 'Approve · fix first', key: 'a', primary: true }, { id: 'reject', label: 'Reject · keep going', key: 'r' }],
        receipts: {
          approve: { tone: 'positive', verb: 'Approved', detail: 'fix e2e before features', pm: 'Принято. Беру #33 (heavy), остальное ждёт. Сообщу, когда прогон позеленеет.' },
          reject: { tone: 'negative', verb: 'Rejected', detail: 'keep feature work going', pm: 'Понял, продолжаем. Помечу e2e как known issue для демо.' },
        },
      },
    ],
    sheltrix: [
      { t: 'day', text: '22 Sep' },
      { t: 'msg', who: 'owner', time: '19:10', html: '<p>поставь sheltrix на паузу, пока не закончим storify</p>' },
      { t: 'msg', who: 'pm', time: '19:11', html: '<p>Готово: sheltrix на паузе. Sprint 03 закрыт (7 из 7), два PR оставил открытыми: #88 и #91. Вопросов к вам нет.</p>' },
      { t: 'note', html: 'You paused <b>sheltrix</b> · 22 Sep 19:12' },
    ],
  };
  quiet.forEach(([name, sprint]) => {
    logs[name] = [{ t: 'day', text: 'Monday' }, { t: 'msg', who: 'pm', time: '09:00', html: `<p>${sprint} идёт по плану, вопросов к вам нет.</p>` }];
  });

  const boards = {
    storify: {
      approved: [{ n: 54, t: 'Share-link preview card', tier: 'light' }, { n: 57, t: 'Onboarding tour', tier: 'standard' }],
      'in progress': [{ n: 49, t: 'Story editor autosave', tier: 'heavy', sub: 'PR #61 · CI running' }, { n: 52, t: 'Tag filter', tier: 'standard', sub: 'PR #60 · CI green' }],
      QA: [{ n: 45, t: 'Comments on stories', tier: 'standard' }, { n: 50, t: 'Dark theme polish', tier: 'light' }],
      done: [{ n: 41, t: 'Infinite story feed', tier: 'standard' }, { n: 38, t: 'PDF export', tier: 'heavy' }, { n: 29, t: 'Magic-link sign-in', tier: 'standard' }],
    },
    'team-console': {
      approved: [{ n: 4, t: 'Push relay worker', tier: 'standard' }, { n: 5, t: 'Needs-you list', tier: 'standard' }],
      'in progress': [{ n: 3, t: 'GitHub auth + session', tier: 'heavy', sub: 'PR #8 · CI green' }, { n: 7, t: 'Design tokens + kit', tier: 'standard' }],
      QA: [{ n: 2, t: 'PWA shell and install', tier: 'light' }],
      done: [{ n: 1, t: 'Repo, CI and dev deploy', tier: 'standard' }],
    },
    fieldnote: {
      approved: [{ n: 36, t: 'Export to Markdown', tier: 'light' }],
      'in progress': [{ n: 33, t: 'Fix flaky sync e2e', tier: 'heavy', sub: 'Run failing · 2×' }, { n: 34, t: 'Offline badge', tier: 'light', sub: 'PR #40 · CI red' }],
      QA: [{ n: 30, t: 'Tag autocomplete', tier: 'standard' }],
      done: [{ n: 25, t: 'Note sync', tier: 'heavy' }, { n: 27, t: 'Search', tier: 'standard' }, { n: 28, t: 'Pinning', tier: 'light' }, { n: 29, t: 'Share sheet', tier: 'light' }, { n: 26, t: 'Import', tier: 'standard' }],
    },
  };

  const A = (type, title, meta, extra) => Object.assign({ type, title, meta }, extra || {});
  const artifacts = {
    storify: [
      A('design', 'Story editor: empty, error, offline', '#47 · awaiting your approval', { awaiting: '47' }),
      A('design', 'Feed: infinite scroll', '#41 · approved 24 Sep'),
      A('demo', 'Sprint 01 demo page', 'draft · opens 9 Oct'),
      A('adr', 'ADR-0001 Stack and architecture', 'accepted 18 Sep'),
      A('adr', 'ADR-0002 PDF export via server render', 'accepted 25 Sep'),
      A('audit', 'Accessibility audit: feed', '2 issues, both light'),
      A('audit', 'Security review: magic-link', 'passed 27 Sep'),
      A('brief', 'Briefing 29 Sep', '3 shipped · 2 questions'),
      A('brief', 'Briefing 28 Sep', '1 shipped · 1 question'),
      A('release', 'v0.1.0 first internal build', 'changelog · 12 items'),
      A('deploy', 'dev · dev.storify.example', 'live · updated 10:30'),
      A('deploy', 'stage · stage.storify.example', 'waiting on #72'),
    ],
    'team-console': [
      A('design', 'Visual directions 01 to 03', 'kickoff · awaiting your pick'),
      A('adr', 'ADR-0001 Stack and architecture', 'accepted today'),
      A('brief', 'Product brief', 'kickoff · 29 Sep'),
      A('deploy', 'dev · console-dev.example', 'live'),
    ],
    fieldnote: [
      A('audit', 'Run log: 2 failed nightly runs', '28 and 29 Sep'),
      A('demo', 'Sprint 04 demo page', 'draft · opens 2 Oct'),
      A('release', 'v0.4.0', 'changelog · 9 items'),
      A('deploy', 'stage · fieldnote-stage.example', 'last good build 27 Sep'),
    ],
    sheltrix: [
      A('release', 'v1.2.0', 'changelog · 7 items · 20 Sep'),
      A('demo', 'Sprint 03 demo page', 'held 19 Sep'),
      A('adr', 'ADR-0004 Queue on Postgres', 'accepted'),
    ],
  };
  quiet.forEach(([name, sprint]) => { artifacts[name] = [A('brief', `Briefing: ${sprint}`, 'Monday')]; });

  const artifactTypes = [
    ['design', 'Designs and prototypes'], ['demo', 'Demo pages'], ['adr', 'Decisions (ADR)'], ['audit', 'Audits'],
    ['brief', 'Briefings'], ['release', 'Releases and changelogs'], ['deploy', 'Deploys'],
  ];

  const replies = {
    running: 'Принял. Заведу это в бэклог как light и отвечу, когда будет план.',
    paused: 'Проект на паузе. Записал, возьмём после возобновления.',
    failing: 'Принял. Сначала чиним прогон, потом возьму это в работу.',
  };

  return { projects, logs, boards, artifacts, artifactTypes, replies };
})();
