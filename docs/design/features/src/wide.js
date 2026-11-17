/* #766 Wide-screen layout. Design prototype runtime with mock data only. One window frame of a chosen width (and the
   iPhone frame beside it) renders the console's shell and one of the six pages in scope. Layout is CSS only: the
   same DOM is rows or cards, one column or three, depending on the body's width, so focus never moves when a pane
   opens or the window is resized. */
(() => {
  'use strict';
  const { esc, plain, I } = Proto;
  const L = Proto.i18n(I18N);
  const { t } = L;
  const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const IX = {
    ...I,
    file: svg('<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4M9 12.5h6M9 16h6"/>'),
    pen: svg('<path d="M4.5 19.5l1-4L15.5 5.5l3 3-10 10z"/><path d="M13.5 7.5l3 3"/>'),
    image: svg('<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-5-5-8.5 8"/>'),
    imageOff: svg('<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M4 4l16 16"/>'),
    code: svg('<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/>'),
    menu: svg('<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>'),
    sum: svg('<path d="M5 19.5V11M10 19.5V5M15 19.5v-6M20 19.5V8"/>'),
  };
  const MON = { ru: ['янв.', 'февр.', 'марта', 'апр.', 'мая', 'июня', 'июля', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'],
    en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] };
  const day = (d, m = 10) => (L.lang === 'ru' ? `${d} ${MON.ru[m]}` : `${d} ${MON.en[m]}`);
  const loc = (v) => (typeof v === 'string' ? v : v[L.lang] || v.en);

  /* ---------- demo state, shared by both frames ---------- */
  const WINS = [375, 768, 1200, 1280, 1440, 1920, 2560];
  const HEIGHTS = { 375: 812, 768: 1024, 1200: 820, 1280: 860, 1440: 960, 1920: 1200, 2560: 1300 };
  const fresh0 = () => ({ page: 'artifacts', win: 1440, pane: 'none', state: 'ready', layout: 'new', type: 'all', q: '' });
  const D = fresh0();

  /* ---------- mock content ---------- */
  const DEC = [
    ['ADR 0009 Team configuration lives in the console', 'file', 'accepted', 16],
    ['ADR 0008 One GitHub App per environment', 'file', 'accepted', 14],
    ['ADR 0007 The console tracker is the source of truth', 'file', 'accepted', 9],
    ['ADR 0006 Tasks are named by key, not by GitHub number', 'file', 'accepted', 5],
    ['#702 Weekly digest as one email', 'issue', 'closed', 4],
    ['ADR 0005 Web push through VAPID, no third-party relay', 'file', 'accepted', 2],
    ['#690 Board on the phone: one lane at a time', 'issue', 'closed', 1],
    ['ADR 0004 Sign-in through Cloudflare Access', 'file', 'accepted', 28, 9],
    ['ADR 0003 GitHub connection per owner, installation per repository', 'file', 'accepted', 21, 9],
    ['#655 Console client follow-ups after the October demo', 'issue', 'open', 17, 9],
    ['ADR 0002 Paper Desk is the visual direction', 'file', 'accepted', 2, 9],
    ['ADR 0001 Angular and Nx in one repository', 'file', 'accepted', 24, 8],
  ].map(([title, source, state, d, m]) => ({ type: 'decision', title, source, state, d, m }));
  const DES = [
    { n: 688, title: 'Settings › Team: roles, models, limits, history', screens: 39, dev: 'both', awaiting: true, d: 17, look: 'mac' },
    { n: 761, title: 'PWA install prompt', screens: 44, dev: 'both', d: 17, look: 'phone' },
    { n: 759, title: 'Actions onboarding: what the team needs from GitHub', screens: 31, dev: 'both', awaiting: true, d: 16, look: 'mac', tone: 'dark' },
    { n: 630, title: 'Team configuration', screens: 0, d: 15, tile: 'none' },
    { n: 750, title: 'Environment setup per project', screens: 30, dev: 'both', d: 15, look: 'list' },
    { n: 409, title: 'Tasks and sprints in the console', screens: 0, d: 11, tile: 'html' },
    { n: 277, title: 'Design viewer', screens: 8, dev: 'both', d: 6, look: 'dialog' },
    { n: 238, title: 'New project: from an idea to a working team', screens: 52, dev: 'both', d: 29, m: 9, look: 'phone', tone: 'dark' },
    { n: 109, title: 'Team analytics', screens: 24, dev: 'both', d: 20, m: 9, look: 'stats' },
  ].map((x) => ({ type: 'design', source: 'issue', ...x }));
  const DEM = [
    { type: 'demo', title: 'Sprint 12 demo · 21 Nov', source: 'issue', state: 'open', d: 17 },
    { type: 'demo', title: 'Sprint 11 demo · 7 Nov', source: 'release', state: 'closed', d: 7 },
  ];
  const ARTS = [...DEC, ...DES, ...DEM];

  const Q = [
    { kind: 'decision', n: 630, title: { ru: 'Где живут настройки команды', en: 'Where the team settings live' },
      text: { ru: 'PM предлагает хранить конфигурацию команды в консоли, а в репозитории оставить только снимок для раннера. Так её можно менять с телефона, а история правок остаётся в консоли.', en: 'The PM proposes to keep the team configuration in the console and leave only a snapshot for the runner in the repository. You can then change it from the phone, and the history stays in the console.' },
      yes: { ru: 'Настройки — в консоли, снимок коммитится раз в сутки.', en: 'Settings in the console, the snapshot is committed daily.' },
      no: { ru: 'Остаётся файл project.yml, правки — через PR.', en: 'project.yml stays, changes go through a PR.' }, ago: '2 ч' },
    { kind: 'design', n: 688, title: { ru: 'Настройки › Команда: роли, модели, лимиты', en: 'Settings › Team: roles, models, limits' },
      text: { ru: '39 экранов, iPhone и Mac. Пресеты, переопределения по ролям, бюджет и история правок.', en: '39 screens, iPhone and Mac. Presets, per-role overrides, the budget and the edit history.' }, more: 36, ago: '5 ч' },
    { kind: 'question', n: 690, title: { ru: 'Какой день демо у спринта 13?', en: 'Which demo day for sprint 13?' },
      text: { ru: 'Спринт 12 заканчивается 21 ноября. Предлагаю демо спринта 13 через две недели, в пятницу; заморозка — за два дня до него.', en: 'Sprint 12 ends on 21 November. I suggest the sprint 13 demo two weeks later, on a Friday, with the freeze two days before.' },
      opts: { ru: ['5 дек.', '12 дек.', 'Другой день…'], en: ['5 Dec', '12 Dec', 'Another day…'] }, ago: '1 д' },
    { kind: 'decision', n: 771, title: { ru: 'Три колонки доски с 1360 px', en: 'Three board columns from 1360 px' },
      text: { ru: 'На широком окне PR и запуски встают рядом с задачами, а не друг под другом. До 1359 px доска как сейчас.', en: 'On a wide window the PRs and runs sit beside the tasks instead of under each other. Up to 1359 px the board is as it is today.' },
      yes: { ru: 'Три колонки на 1440 px с открытой панелью задачи нет.', en: 'No three columns at 1440 with the task pane open.' },
      no: { ru: 'Доска остаётся в двух колонках на любой ширине.', en: 'The board keeps two columns at any width.' }, ago: '1 д' },
    { kind: 'design', n: 761, title: { ru: 'Установка приложения: карточка и Настройки › Приложение', en: 'Install the app: the card and Settings › App' },
      text: { ru: '44 экрана, iPhone и Mac. Одно касание в Chrome и Edge, три шага на iPhone, подсказка в Safari.', en: '44 screens, iPhone and Mac. One tap in Chrome and Edge, three steps on iPhone, a hint in Safari.' }, more: 41, ago: '2 д' },
  ];
  const NEEDS_EXTRA = [
    { kind: 'decision', n: 214, proj: 'storify', title: { ru: 'Экспорт истории в PDF', en: 'Export a story to PDF' },
      text: { ru: 'Печатать на сервере или в браузере? На сервере — одинаковый вид, в браузере — без новой зависимости.', en: 'Print on the server or in the browser? The server gives the same look everywhere; the browser needs no new dependency.' },
      yes: { ru: 'Печать на сервере, +1 Worker.', en: 'Server-side print, one more Worker.' }, no: { ru: 'Печать браузером, вид зависит от него.', en: 'Browser print, the look depends on it.' }, ago: '3 ч' },
    { kind: 'question', n: 88, proj: 'docs-site', title: { ru: 'Куда вести ссылку «Начать»?', en: 'Where should “Get started” lead?' },
      text: { ru: 'Сейчас она ведёт на установку. Предлагаю вести на пятиминутный обзор, а установку дать вторым шагом.', en: 'It leads to the install guide today. I suggest a five-minute tour first and the install as step two.' },
      opts: { ru: ['На обзор', 'На установку'], en: ['To the tour', 'To the install'] }, ago: '6 ч' },
  ];
  const BOARD = {
    doing: [['771', { ru: 'Широкие экраны: раскладка страниц проекта', en: 'Wide screens: project page layout' }, 'heavy'], ['768', { ru: 'Баннер «Показано не всё» сразу после обновления', en: '“Not everything is shown” right after a refresh' }, 'light']],
    review: [['764', { ru: 'Онбординг Actions: что нужно команде от GitHub', en: 'Actions onboarding: what the team needs from GitHub' }, 'standard']],
    todo: [['773', { ru: 'Индекс разделов в Настройках', en: 'A section index in Settings' }, 'standard'], ['774', { ru: 'Скриншоты дизайна #630', en: 'Screenshots of the #630 design' }, 'light'], ['775', { ru: 'Счётчик бюджета в боковой панели', en: 'Budget meter in the sidebar' }, 'light']],
    done: [['761', { ru: 'Установка приложения', en: 'Install the app' }, 'standard'], ['750', { ru: 'Окружение проекта', en: 'Project environment' }, 'standard'], ['703', { ru: 'Доработки плагина', en: 'Plugin follow-ups' }, 'light'], ['688', { ru: 'Настройки › Команда', en: 'Settings › Team' }, 'heavy']],
  };
  const PRS = [['772', 'feat(console): wide-screen layout tokens', 'review'], ['769', 'fix(artifacts): list every docs/design folder', 'changes'], ['763', 'docs(design): #761 install prompt', 'green']];
  const RUNS = [['dev', '14:02', 'going'], ['qa', '13:40', 'ok'], ['pm', '12:00', 'ok'], ['dev', '11:15', 'fail'], ['security', '09:30', 'ok']];

  /* ---------- pieces ---------- */
  const bodyOf = (w, pane) => Math.max(0, Math.min(w - 256, 1664) - 64 - (pane === 'commands' ? 392 : pane === 'task' ? 496 : 0));
  function shotPage(a) {
    const look = a.look || 'mac';
    let p = '';
    if (look === 'mac' || look === 'stats' || look === 'list' || look === 'dialog') {
      p += '<i class="s-side"></i><i style="left:4%;top:5%;width:12%;height:3%"></i><i style="left:4%;top:12%;width:14%;height:2%"></i><i style="left:4%;top:16%;width:10%;height:2%"></i>';
      p += '<i style="left:27%;top:5%;width:30%;height:4%"></i><i class="s-acc" style="left:84%;top:4.5%;width:12%;height:5%"></i>';
      if (look === 'stats') for (let k = 0; k < 4; k++) p += `<i class="s-card" style="left:${27 + k * 18}%;top:14%;width:16%;height:12%"></i><i class="s-acc" style="left:${29 + k * 18}%;top:${22 - k * 2}%;width:6%;height:${2 + k * 2}%"></i>`;
      if (look === 'list') for (let k = 0; k < 6; k++) p += `<i class="s-card" style="left:27%;top:${14 + k * 9}%;width:69%;height:7%"></i><i style="left:30%;top:${16.5 + k * 9}%;width:${20 + (k % 3) * 9}%;height:2%"></i><i class="${k === 1 ? 's-acc' : ''}" style="left:86%;top:${16 + k * 9}%;width:7%;height:3%"></i>`;
      if (look === 'mac' || look === 'dialog') {
        p += '<i class="s-card" style="left:27%;top:14%;width:33%;height:26%"></i><i class="s-card" style="left:63%;top:14%;width:33%;height:26%"></i>';
        p += '<i style="left:30%;top:18%;width:20%;height:2.5%"></i><i style="left:30%;top:23%;width:26%;height:1.6%"></i><i style="left:30%;top:26.5%;width:22%;height:1.6%"></i><i class="s-acc" style="left:30%;top:33%;width:9%;height:4%"></i>';
        p += '<i style="left:66%;top:18%;width:18%;height:2.5%"></i><i style="left:66%;top:23%;width:26%;height:1.6%"></i><i style="left:66%;top:26.5%;width:20%;height:1.6%"></i>';
        p += '<i class="s-card" style="left:27%;top:44%;width:69%;height:20%"></i><i style="left:30%;top:48%;width:40%;height:2%"></i><i style="left:30%;top:52%;width:55%;height:1.6%"></i>';
      }
      if (look === 'dialog') p += '<i class="s-scrim"></i><i class="s-card" style="left:20%;top:9%;width:60%;height:42%"></i><i style="left:24%;top:13%;width:24%;height:3%"></i><i class="s-acc" style="left:24%;top:20%;width:52%;height:26%;opacity:.35"></i>';
    } else {
      for (let k = 0; k < 2; k++) {
        const x = 18 + k * 36;
        p += `<i class="s-phone" style="left:${x}%;top:6%;width:28%;height:56%"></i><i style="left:${x + 3}%;top:10%;width:14%;height:2.4%"></i>`;
        p += `<i class="s-card" style="left:${x + 3}%;top:16%;width:22%;height:${k ? 18 : 24}%"></i><i style="left:${x + 5}%;top:19%;width:14%;height:1.8%"></i><i style="left:${x + 5}%;top:22.5%;width:17%;height:1.4%"></i>`;
        p += `<i class="s-acc" style="left:${x + 5}%;top:${k ? 28 : 33}%;width:${k ? 8 : 17}%;height:3%"></i><i style="left:${x + 3}%;top:${k ? 38 : 44}%;width:22%;height:1.6%"></i><i style="left:${x + 3}%;top:${k ? 41 : 47}%;width:15%;height:1.6%"></i>`;
      }
    }
    return `<span class="shot__page"${a.tone ? ` data-tone="${a.tone}"` : ''} aria-hidden="true">${p}</span>`;
  }
  function tileOf(a) {
    if (D.state === 'thumbFail' && a.n === 277) return 'failed';
    return a.tile || null;
  }
  function shot(a) {
    const tile = tileOf(a);
    if (tile) {
      const ico = tile === 'html' ? IX.code : tile === 'failed' ? IX.imageOff : IX.image;
      return `<span class="shot${tile === 'failed' ? ' shot--fail' : ''}" aria-hidden="true"><span class="shot__tile">${ico}<span>${t(`designs.tile.${tile}`)}</span></span></span>`;
    }
    return `<span class="shot" aria-hidden="true">${shotPage(a)}</span>`;
  }
  function designSummary(a) {
    const tile = tileOf(a);
    const what = tile ? t(`designs.row.${tile}`) : `${t('designs.row.screens', { n: a.screens })} · ${t(`designs.row.devices.${a.dev}`)}`;
    return `#${a.n} · ${what}`;
  }
  const typeIco = (type) => (type === 'decision' ? IX.file : type === 'design' ? IX.pen : IX.play);
  function artItem(a) {
    if (a.type === 'design') {
      const sum = designSummary(a);
      return `<li><button type="button" class="acard acard--design" data-act="open-design" data-n="${a.n}" data-fk="art-${a.n}">
        ${shot(a)}
        <span class="acard__text"><span class="acard__title" dir="auto">${esc(a.title)} <span class="sr-only">— ${t('designs.row.open')}, ${esc(sum.replace(/ · /g, ', '))}${a.awaiting ? `, ${t('designs.row.awaiting')}` : ''}</span></span>
          <span class="acard__sub" aria-hidden="true">${esc(sum)} · ${day(a.d, a.m)}</span>
          ${a.awaiting ? `<span class="acard__await" aria-hidden="true">${t('designs.row.awaiting')}</span>` : ''}</span>
        <span class="acard__chip" aria-hidden="true">${t(`artifacts.type.${a.type}`)}</span></button></li>`;
    }
    const sub = `${t(`artifacts.source.${a.source}`)} · ${t(`artifacts.state.${a.state}`)} · ${day(a.d, a.m)}`;
    return `<li><a class="acard" href="https://github.com/" target="_blank" rel="noopener noreferrer" data-act="gh">
      <span class="acard__text"><span class="acard__kicker" aria-hidden="true">${typeIco(a.type)}${t(`artifacts.typeOne.${a.type}`)}${IX.ext}</span>
        <span class="acard__title" dir="auto">${esc(a.title)}<span class="sr-only">, ${t('artifacts.opensGitHub')}, ${esc(sub)}</span></span>
        <span class="acard__sub" aria-hidden="true">${esc(sub)}</span></span>
      <span class="acard__chip" aria-hidden="true">${t(`artifacts.type.${a.type}`)}</span>${IX.ext}</a></li>`;
  }
  function visibleArts() {
    const q = D.q.trim().toLowerCase();
    return ARTS.filter((a) => (D.type === 'all' || a.type === D.type) && (!q || a.title.toLowerCase().includes(q)));
  }
  function artList() {
    if (D.state === 'loading') {
      if (D.type === 'design') {
        const sk = Array.from({ length: 6 }, () => '<li class="skelc"><span class="shot shot--skel skel-pulse"></span><span class="skelc__lines"><i class="skel skel--a skel-pulse"></i><i class="skel skel--b skel-pulse"></i></span></li>').join('');
        return `<ul class="alist skel-list" aria-hidden="true">${sk}</ul><p class="arts__status" role="status">${t('designs.loading')}</p>`;
      }
      return `<div class="state-block" role="status">${Proto.dots}<p>${t('artifacts.loading')}</p></div>`;
    }
    const items = visibleArts();
    if (!items.length) return `<div class="state-block"><h3>${t('artifacts.noMatch.title')}</h3><p>${t('artifacts.noMatch.body', { q: D.q })}</p><button type="button" class="btn" data-act="reset-filter">${t('artifacts.noMatch.reset')}</button></div>`;
    let html = ''; let last = null;
    for (const a of items) {
      if (D.type === 'all' && a.type !== last) {
        const n = items.filter((x) => x.type === a.type).length;
        html += `<li class="alist__group" role="none"><h3>${t(`artifacts.type.${a.type}`)} <span aria-hidden="true">${n}</span><span class="sr-only">, ${t('artifacts.group.count', { n })}</span></h3></li>`;
        last = a.type;
      }
      html += artItem(a);
    }
    return `<ul class="alist" aria-label="${t('artifacts.listLabel')}">${html}</ul>`;
  }
  function artifactsPage() {
    const counts = { all: ARTS.length, decision: DEC.length, design: DES.length, demo: DEM.length };
    const chips = ['all', 'decision', 'design', 'demo'].map((k) => `<button type="button" class="chip-btn" data-act="type" data-type="${k}" aria-pressed="${D.type === k}">${k === 'all' ? t('artifacts.all') : t(`artifacts.type.${k}`)}<span>${counts[k]}</span></button>`).join('');
    const refreshing = D.state === 'refreshing';
    return `<section class="arts" aria-labelledby="arts-h">
      <div class="arts__head"><h2 class="arts__title" id="arts-h">${t('artifacts.title')}</h2>
        <p class="arts__loaded">${t('artifacts.updated', { t: '14:02' })}</p>
        <button type="button" class="btn btn--sm" data-act="refresh"${refreshing ? ' aria-disabled="true"' : ''} data-fk="refresh">${refreshing ? `${Proto.dots}${t('artifacts.refreshing')}` : `${IX.refresh}${t('artifacts.refresh')}`}</button></div>
      ${D.state === 'partial' ? `<div class="callout" role="status">${IX.warn}<p><b>${t('artifacts.partial.title')}</b>${t('artifacts.partial.body')}</p></div>` : ''}
      <div class="arts__tools">
        <label class="search">${IX.search}<span class="sr-only">${t('artifacts.searchAria')}</span><input type="search" data-act="search" placeholder="${t('artifacts.search')}" value="${esc(D.q)}"></label>
        <div class="arts__chips" role="group" aria-label="${t('artifacts.filterAria')}">${chips}</div>
        <p class="arts__shown" aria-live="polite" data-slot="shown">${D.state === 'loading' ? '' : t('artifacts.shown', { n: visibleArts().length, m: ARTS.length })}</p>
      </div>
      <div data-slot="alist">${artList()}</div>
    </section>`;
  }

  function qcard(x, withProj) {
    const kindIco = x.kind === 'design' ? IX.pen : x.kind === 'decision' ? IX.file : IX.q;
    let mid = '';
    if (x.yes) mid = `<div class="outc"><div><b>${t('q.ifApprove')}</b>${esc(loc(x.yes))}</div><div><b>${t('q.ifReject')}</b>${esc(loc(x.no))}</div></div>`;
    if (x.more) mid = `<div class="qthumbs"><button type="button" class="thumb" aria-label="${t('q.openDesign')} #${x.n}">${['', ' tf--dark', ''].map((c, k) => `<span class="tf${c}"><span class="tf__bar"></span><span class="tf__center"><span class="tf__icon"${k === 1 ? ' style="opacity:.6"' : ''}></span><span class="tf__line"></span><span class="tf__line tf__line--s"></span><span class="tf__btn"></span></span></span>`).join('')}</button><span class="qthumbs__more" aria-hidden="true">${t('q.more', { n: x.more })}</span></div>`;
    if (x.opts) mid = `<div class="qopts">${loc(x.opts).map((o) => `<button type="button" class="btn">${esc(o)}</button>`).join('')}</div>`;
    const actions = x.opts ? '' : x.more
      ? `<button type="button" class="btn btn--primary">${t('q.approve')}</button><button type="button" class="btn">${t('q.reject')}</button>`
      : `<button type="button" class="btn btn--primary">${t('q.approve')}</button><button type="button" class="btn">${t('q.reject')}</button>`;
    return `<li><article class="card" aria-labelledby="q-${x.n}">
      ${withProj ? `<span class="ptag"><span class="prod-mono" aria-hidden="true">${esc((x.proj || 'team-console')[0])}</span>${esc(x.proj || 'team-console')}</span>` : ''}
      <div class="card__head"><span class="card__kind">${kindIco}${t(`q.kind.${x.kind}`)}</span><span class="card__num">#${x.n}</span></div>
      <h3 class="card__title" id="q-${x.n}" dir="auto">${esc(loc(x.title))}</h3>
      <p class="card__text" dir="auto">${esc(loc(x.text))}</p>
      ${mid}
      <div class="card__foot"><div class="card__actions">${actions}</div><span class="card__meta">${t('q.by', { t: x.ago })}</span></div>
    </article></li>`;
  }
  const receipt = () => `<li><div class="receipt" tabindex="-1"><span class="receipt__icon">${IX.check}</span><span class="receipt__body">${t('q.receipt')}</span><span class="receipt__meta">13:20</span></div></li>`;
  function questionsPage() {
    return `<section class="qpage" aria-labelledby="qp-h"><h2 class="sr-only" id="qp-h">${t('space.questions')}</h2>
      <p class="qlead">${t('q.lead', { n: Q.length })}</p>
      <ul class="attn qlist"><li><a href="#" data-act="noop">${IX.gear}${t('q.attn.setup')}${IX.chev}</a></li><li><a href="#" data-act="noop">${IX.clock}${t('q.attn.budget')}${IX.chev}</a></li></ul>
      <ul class="qlist">${Q.map((x) => qcard(x)).join('')}${receipt()}</ul></section>`;
  }
  function demoPage() {
    const dcard = `<li><article class="card" aria-labelledby="dm-12"><div class="card__head"><span class="card__kind">${IX.play}${t('artifacts.typeOne.demo')}</span><span class="card__num">#780</span></div>
      <h3 class="card__title" id="dm-12">${t('dp.sprint')}</h3><p class="card__text">${t('dp.sprintBody')}</p>
      <div class="card__foot"><div class="card__actions"><a class="btn" href="https://github.com/" target="_blank" rel="noopener noreferrer">${t('dp.open')}${IX.ext}<span class="sr-only">, ${t('artifacts.opensGitHub')}</span></a></div><span class="card__meta">${day(21)}</span></div></article></li>`;
    const des = [Q[1], { ...Q[4], n: 759, title: { ru: 'Онбординг Actions: что нужно команде от GitHub', en: 'Actions onboarding: what the team needs from GitHub' }, text: { ru: '31 экран, iPhone и Mac. Шаги, проверки и что делать, если прав не хватает.', en: '31 screens, iPhone and Mac. The steps, the checks and what to do when a permission is missing.' }, more: 28 }];
    return `<section class="qpage" aria-labelledby="dp-h"><h2 class="sr-only" id="dp-h">${t('space.demo')}</h2><p class="qlead">${t('dp.lead')}</p>
      <ul class="qlist">${des.map((x) => qcard(x)).join('')}${dcard}</ul></section>`;
  }
  function boardPage() {
    const lanes = ['doing', 'review', 'todo', 'done'].map((k) => `<div class="lane"><h4>${t(`b.lane.${k}`)} · ${BOARD[k].length}</h4><ul>${BOARD[k].map(([n, title, tier]) => `<li><button type="button" class="item" data-act="task" data-n="${n}" aria-expanded="${D.pane === 'task' && n === '771'}"><span class="item__num">#${n}</span><span class="item__title">${esc(loc(title))}</span><span class="tier tier--${tier}">${tier}</span></button></li>`).join('')}</ul></div>`).join('');
    const prs = PRS.map(([n, title, st]) => `<li><a class="item" href="https://github.com/" target="_blank" rel="noopener noreferrer"><span class="item__num">#${n}</span><span class="item__title">${esc(title)}<small>${t(`b.pr.${st}`)}</small></span>${IX.ext}</a></li>`).join('');
    const runs = RUNS.map(([slot, tm, st]) => `<li><div class="item"><span class="rdot${st === 'ok' ? '' : ` rdot--${st}`}" aria-hidden="true"></span><span class="item__title">${slot}<small>${t(`b.run.${st}`)}</small></span><span class="item__num">${tm}</span></div></li>`).join('');
    const open = Object.values(BOARD).slice(0, 3).reduce((s, l) => s + l.length, 0);
    return `<section class="bd" aria-labelledby="bd-h"><div class="bd__head"><h2 id="bd-h">${t('b.title')}</h2><span class="demo-pill">${IX.clock}${t('b.demoPill')}</span><span class="bd__open">${t('b.open', { n: open })}</span>
      <div class="bd__actions"><button type="button" class="btn">${IX.play}${t('b.run')}</button><button type="button" class="btn btn--primary">${IX.plus}${t('b.newTask')}</button></div></div>
      <div class="bd__ptabs" role="tablist" aria-label="${t('b.phoneTabs')}"><button type="button" class="chip-btn" role="tab" aria-selected="true" aria-pressed="true">${t('b.tasks')}</button><button type="button" class="chip-btn" role="tab" aria-selected="false">${t('b.pulls')}</button><button type="button" class="chip-btn" role="tab" aria-selected="false">${t('b.runs')}</button></div>
      <div class="bd__secs">
        <section class="bd__sec bd__sec--tasks" aria-labelledby="bs-t"><h3 id="bs-t">${t('b.tasks')} <span>${open + BOARD.done.length}</span></h3>${lanes}</section>
        <section class="bd__sec bd__sec--pulls" aria-labelledby="bs-p"><h3 id="bs-p">${t('b.pulls')} <span>${PRS.length}</span></h3><ul>${prs}</ul></section>
        <section class="bd__sec bd__sec--runs" aria-labelledby="bs-r"><h3 id="bs-r">${t('b.runs')} <span>${RUNS.length}</span></h3><ul>${runs}</ul></section>
      </div></section>`;
  }
  function needsPage() {
    const all = [Q[0], { ...Q[1] }, NEEDS_EXTRA[0], Q[2], NEEDS_EXTRA[1], Q[3], Q[4]];
    return `<div class="npage"><div class="npage__head"><h1>${t('needs.title')}</h1><button type="button" class="btn">${IX.check}${t('needs.approveRecs')}</button><button type="button" class="btn btn--primary">${IX.plus}${t('space.newTask')}</button></div>
      <div class="nudge">${IX.bellOff}<p>${t('needs.nudge')}</p><button type="button" class="btn btn--sm">${t('needs.nudgeOn')}</button></div>
      <div class="space__body"><section class="qpage" aria-label="${t('needs.title')}"><p class="qlead">${t('needs.lead', { n: all.length, p: 3 })}</p>
      <ul class="qlist">${all.map((x) => qcard(x, true)).join('')}</ul></section></div></div>`;
  }

  /* ---------- the shell ---------- */
  const TABS = [['questions', IX.chat], ['board', IX.board], ['artifacts', IX.stack], ['demo', IX.play]];
  const tabOf = (p) => (p === 'designs' ? 'artifacts' : p);
  function shell(host) {
    const page = D.page === 'designs' ? 'artifacts' : D.page;
    const isSpace = page !== 'needs';
    const cur = tabOf(page);
    const tabs = TABS.map(([k]) => `<a class="space__tab" href="#" data-act="go" data-page="${k}"${cur === k ? ' aria-current="page"' : ''}>${t(`space.${k}`)}</a>`).join('');
    const body = page === 'artifacts' ? artifactsPage() : page === 'questions' ? questionsPage() : page === 'demo' ? demoPage() : page === 'board' ? boardPage() : '';
    const sidebar = `<nav class="sidebar" aria-label="${t('nav.aria')}">
      <div class="brand">${IX.mark}<span>Team Console</span></div>
      <ul class="side-list side-list--top">
        <li><a class="side-item" href="#" data-act="go" data-page="needs"${page === 'needs' ? ' aria-current="true"' : ''}>${IX.inbox}<span>${t('nav.needs')}</span><span class="count"><span>7</span></span></a></li>
        <li><a class="side-item" href="#" data-act="noop">${IX.sum}<span>${t('nav.overview')}</span></a></li></ul>
      <div class="side-label">${t('nav.projects')}</div>
      <ul class="side-list">${['team-console', 'storify', 'docs-site'].map((p, k) => `<li><a class="side-item" href="#" data-act="${k ? 'noop' : 'go'}" data-page="questions"${!k && isSpace ? ' aria-current="true"' : ''}><span class="prod-mono" aria-hidden="true">${p[0]}</span><span class="side-prod__label">${p}</span></a></li>`).join('')}</ul>
      <div class="side-foot"><a class="side-item side-item--new" href="#" data-act="noop">${IX.plus}<span>${t('nav.newProject')}</span></a><a class="side-item" href="#" data-act="noop">${IX.gear}<span>${t('nav.settings')}</span></a></div>
    </nav>`;
    const top = `<header class="wd__top"><button type="button" class="icon-btn" aria-label="${t('nav.menu')}">${IX.menu}</button>
      <span class="wd__top-title">${isSpace ? `<span class="prod-mono" aria-hidden="true">t</span><span>Team Console</span>` : `<span>${t('needs.title')}</span>`}</span>
      ${isSpace ? `<button type="button" class="icon-btn" aria-label="${t('space.find')}">${IX.search}</button><button type="button" class="icon-btn" data-act="commands" aria-label="${t('space.commands')}">${IX.sliders}</button>` : ''}<button type="button" class="icon-btn" aria-label="${t('space.newTask')}">${IX.plus}</button></header>`;
    const panes = `<aside class="wpane" aria-labelledby="pc-h" data-pane="commands"${D.pane === 'commands' && isSpace ? '' : ' hidden'}>
        <div class="wpane__head"><h2 id="pc-h" tabindex="-1">${t('pane.commands')}</h2><button type="button" class="icon-btn" data-act="close" aria-label="${t('pane.close')}">${IX.x}</button></div>
        <div class="wpane__body"><div class="wpane__card"><b>${t('pane.status')}</b><span>${t('pane.statusLine')}</span></div>
          <button type="button" class="btn">${IX.pause}${t('pane.pause')}</button><button type="button" class="btn">${IX.play}${t('pane.runNow')}</button><button type="button" class="btn">${IX.clock}${t('pane.moveDemo')}</button><button type="button" class="btn">${IX.chat}${t('pane.ask')}</button></div></aside>
      <aside class="wpane wpane--task" aria-labelledby="pt-h" data-pane="task"${D.pane === 'task' && page === 'board' ? '' : ' hidden'}>
        <div class="wpane__head"><h2 id="pt-h" tabindex="-1">#771 ${esc(loc(BOARD.doing[0][1]))}</h2><button type="button" class="icon-btn" data-act="close" aria-label="${t('pane.close')}">${IX.x}</button></div>
        <div class="wpane__body"><dl class="ledger"><dt>${t('task.status')}</dt><dd>${t('task.statusV')}</dd><dt>${t('task.kind')}</dt><dd>${t('task.kindV')}</dd><dt>${t('task.sprint')}</dt><dd>${t('b.title')}</dd></dl>
          <h3 class="wpane__h">${t('task.details')}</h3><p class="wpane__p">${t('task.body')}</p>
          <h3 class="wpane__h">${t('task.history')}</h3><ul class="hist"><li>14:02 · ${t('task.h1')}</li><li>${day(17)} · ${t('task.h2')}</li></ul></div></aside>`;
    const spaceHtml = `<div class="space">
      <header class="space__head"><div class="space__head-in"><h1 class="space__title">Team Console</h1>
        <nav class="space__tabs" aria-label="${t('space.sections')}">${tabs}</nav>
        <button type="button" class="btn space__find">${IX.search}${t('space.find')}<kbd>/</kbd></button>
        <button type="button" class="btn" data-act="commands" aria-expanded="${D.pane === 'commands'}">${IX.sliders}${t('space.commands')}<kbd>K</kbd></button>
        <button type="button" class="btn btn--primary">${IX.plus}${t('space.newTask')}</button></div></header>
      ${page === 'questions' ? `<div class="space__banner"><div class="paused">${IX.pause}<span>${t('space.paused')}</span><button type="button" class="btn btn--sm">${t('space.resume')}</button></div></div>` : ''}
      <div class="space__main"><main class="space__body" id="main-${host.dataset.app}">${body}</main>${panes}</div></div>`;
    const phoneTabs = isSpace ? `<nav class="wd__tabs" aria-label="${t('space.sections')}">${TABS.map(([k, ico]) => `<a href="#" data-act="go" data-page="${k}"${cur === k ? ' aria-current="page"' : ''}>${ico}<span>${t(`space.${k}`)}</span></a>`).join('')}</nav>` : '';
    return `<div class="wd" data-layout="${D.layout}" data-page="${page}">
      <div class="wd__row">${sidebar}<div class="wd__main">${top}${isSpace ? spaceHtml : `<main id="main-${host.dataset.app}">${needsPage()}</main>`}</div></div>${phoneTabs}
      <div data-slot="viewer"></div></div>`;
  }

  /* ---------- rendering and behaviour ---------- */
  const hosts = [...document.querySelectorAll('.app[data-app]')];
  function render(focusSel) {
    hosts.forEach((h) => {
      h.innerHTML = shell(h);
      if (focusSel && h.dataset.app === 'mac') { const el = h.querySelector(focusSel); if (el) el.focus(); }
    });
    sizeFrame();
  }
  function refreshList(host) {
    hosts.forEach((h) => {
      const slot = h.querySelector('[data-slot=alist]'); if (!slot) return;
      slot.innerHTML = artList();
      const shown = h.querySelector('[data-slot=shown]'); if (shown) shown.textContent = plain(t('artifacts.shown', { n: visibleArts().length, m: ARTS.length }));
      h.querySelectorAll('[data-act=type]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === D.type)));
      if (h !== host) { const s = h.querySelector('[data-act=search]'); if (s) s.value = D.q; }
    });
  }
  function setPane(p, host) {
    D.pane = p; sel('d-pane').value = p;
    hosts.forEach((h) => {
      h.querySelectorAll('[data-pane]').forEach((el) => { el.hidden = !(el.dataset.pane === p && (p !== 'task' || D.page === 'board')); });
      const cb = h.querySelector('.space__head [data-act=commands]'); if (cb) cb.setAttribute('aria-expanded', String(p === 'commands'));
      h.querySelectorAll('[data-act=task]').forEach((b) => b.setAttribute('aria-expanded', String(p === 'task' && b.dataset.n === '771')));
    });
    sizeFrame();
    return host;
  }
  let opener = null;
  function openViewer(host, btn) {
    const a = DES.find((x) => String(x.n) === btn.dataset.n); if (!a) return;
    opener = btn;
    const slot = host.querySelector('[data-slot=viewer]');
    slot.innerHTML = `<div class="viewer"><div class="modal__scrim" data-act="close-viewer"></div><div class="viewer__box" role="dialog" aria-modal="true" aria-labelledby="vw-h">
      <h2 id="vw-h" tabindex="-1">${esc(a.title)}</h2><button type="button" class="icon-btn" data-act="close-viewer" aria-label="${t('pane.close')}">${IX.x}</button>
      ${shot(a)}<p>${esc(designSummary(a))}</p></div></div>`;
    slot.querySelector('#vw-h').focus();
  }
  function closeViewer(host) {
    host.querySelector('[data-slot=viewer]').innerHTML = '';
    if (opener && opener.isConnected) opener.focus();
    opener = null;
  }
  hosts.forEach((host) => {
    host.addEventListener('click', async (e) => {
      const el = e.target.closest('[data-act]'); if (!el) return;
      const act = el.dataset.act;
      if (act === 'gh') { e.preventDefault(); return; }
      if (act === 'noop') { e.preventDefault(); return; }
      if (act === 'go') { e.preventDefault(); D.page = el.dataset.page; if (D.page !== 'board' && D.pane === 'task') D.pane = 'none'; syncSelects(); render(`[data-act=go][data-page=${D.page}]`); return; }
      if (act === 'type') { D.type = el.dataset.type; if (D.page === 'artifacts' || D.page === 'designs') D.page = D.type === 'design' ? 'designs' : 'artifacts'; syncSelects(); refreshList(host); return; }
      if (act === 'reset-filter') { D.q = ''; D.type = 'all'; refreshList(); const s = host.querySelector('[data-act=search]'); s.value = ''; s.focus(); return; }
      if (act === 'commands') { setPane(D.pane === 'commands' ? 'none' : 'commands'); if (D.pane === 'commands') host.querySelector('#pc-h').focus(); return; }
      if (act === 'task') { setPane('task'); return; }
      if (act === 'close') { const was = D.pane; setPane('none'); const back = host.querySelector(was === 'task' ? '[data-act=task][data-n="771"]' : '.space__head [data-act=commands]'); if (back) back.focus(); return; }
      if (act === 'open-design') { openViewer(host, el); return; }
      if (act === 'close-viewer') { closeViewer(host); return; }
      if (act === 'refresh' && D.state !== 'refreshing') {
        const prev = D.state; D.state = 'refreshing'; render('[data-fk=refresh]');
        await Proto.wait(1200);
        D.state = prev === 'partial' ? 'ready' : prev; syncSelects(); render('[data-fk=refresh]');
      }
    });
    host.addEventListener('input', (e) => { if (e.target.dataset.act === 'search') { D.q = e.target.value; refreshList(host); } });
    host.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && host.querySelector('.viewer')) { closeViewer(host); return; }
      if ((e.key === 'k' || e.key === 'K') && !e.target.matches('input,textarea') && !e.metaKey && !e.ctrlKey) {
        const keep = document.activeElement; setPane(D.pane === 'commands' ? 'none' : 'commands'); if (keep && keep.isConnected) keep.focus();
      }
    });
  });

  /* ---------- the window frame: width, height, scale ---------- */
  const stage = document.querySelector('.stage');
  const frame = document.querySelector('.mac-frame');
  const label = document.querySelector('.device--mac .device__label');
  const SHOT = new URLSearchParams(location.search).has('shot');
  function sizeFrame() {
    const w = D.win; const h = Number(new URLSearchParams(location.search).get('h')) || HEIGHTS[w] || 900;
    frame.style.width = `${w}px`; frame.style.height = `${h}px`;
    if (!SHOT) {
      if (stage.dataset.view === 'both') stage.dataset.layout = 'stack';
      const room = stage.clientWidth - 48;
      frame.style.zoom = String(Math.max(0.2, Math.min(1, room / w)));
    }
    const b = bodyOf(w, D.page === 'needs' ? 'none' : D.pane);
    const mode = w < 520 ? t('demo.m.phone') : w < 900 ? t('demo.m.tablet') : (D.page === 'artifacts' || D.page === 'designs') ? t(D.layout === 'new' && b >= 880 ? 'demo.m.grid' : 'demo.m.list') : '';
    if (label) label.innerHTML = `${t('page.macLabel')} · <b>${plain(t('demo.w', { w, b: w < 900 ? w - 64 : b, m: mode })).replace(/ · $/, '')}</b>`;
  }

  /* ---------- page controls ---------- */
  const sel = (id) => document.getElementById(id);
  function syncSelects() { sel('d-page').value = D.page; sel('d-win').value = String(D.win); sel('d-pane').value = D.pane; sel('d-state').value = D.state; sel('d-layout').value = D.layout; }
  const pageChrome = Proto.page({ L, title: 'Team Console · #766', onLang: () => render() });
  document.querySelector('[data-control=view]').addEventListener('click', () => sizeFrame());
  addEventListener('resize', () => sizeFrame());
  sel('d-page').addEventListener('change', (e) => { D.page = e.target.value; D.type = D.page === 'designs' ? 'design' : 'all'; if (D.page !== 'board' && D.pane === 'task') D.pane = 'none'; syncSelects(); render(); });
  sel('d-win').addEventListener('change', (e) => { D.win = Number(e.target.value); sizeFrame(); });
  sel('d-pane').addEventListener('change', (e) => { const p = e.target.value; if (p === 'task') { D.page = 'board'; D.type = 'all'; syncSelects(); render(); } setPane(p); });
  sel('d-state').addEventListener('change', (e) => { D.state = e.target.value; if (D.state === 'noMatch') { D.state = 'ready'; D.q = 'zzz'; } render(); });
  sel('d-layout').addEventListener('change', (e) => { D.layout = e.target.value; render(); });
  document.querySelector('[data-reset]').addEventListener('click', () => { Object.assign(D, fresh0()); syncSelects(); render(); });

  // ?page=…&w=…&h=…&pane=…&state=…&layout=…&theme=…&lang=…&motion=…&view=…&shot=1 opens a view directly (screenshots).
  const q = new URLSearchParams(location.search);
  if (SHOT) Proto.root.dataset.shot = '';
  if (q.get('lang') === 'en' || q.get('lang') === 'ru') { L.save(q.get('lang')); pageChrome.setControl('lang', q.get('lang')); }
  ['view', 'theme', 'motion'].forEach((k) => { if (q.get(k)) pageChrome.setControl(k, q.get(k)); });
  if (!q.get('view')) pageChrome.setControl('view', matchMedia('(max-width: 520px)').matches ? 'phone' : 'mac');
  if (q.get('page')) { D.page = q.get('page'); D.type = D.page === 'designs' ? 'design' : 'all'; }
  if (q.get('w')) D.win = Number(q.get('w'));
  if (q.get('pane')) D.pane = q.get('pane');
  if (q.get('state')) D.state = q.get('state');
  if (D.state === 'noMatch') { D.state = 'ready'; D.q = 'zzz'; }
  if (q.get('layout')) D.layout = q.get('layout');
  syncSelects();
  render();
})();
