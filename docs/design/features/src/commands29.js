/* #29 Team commands, the rest after #114: the full status card, Move the demo / Start the next sprint, requests to
   the PM (sprint and queue, recorded on the issue; the console never sets a milestone), batch approve of safe team
   recommendations, snooze per project; reachable from the project space, the board, All projects (#27) and
   Needs you (#16). Pause / resume and Run now are #114's approved design, shown here in the same panel.
   Design prototype runtime with mock data only; the Worker decides every refusal. Two independent instances
   (iPhone, Mac) share the team state, like the Paper Desk prototype. */
(() => {
  'use strict';
  const { isReduced, cssVar, ms, wait, esc, play, plain, I, dots } = Proto;
  const L = Proto.i18n(I18N);
  const { t, hhmm } = L;
  const MIN = 60000;
  const OVERLAP = 3 * 60 * MIN;
  const REQUEST_LOCK = 15 * MIN;
  const at = (mins) => new Date(Date.now() + mins * MIN);
  const day0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fromIso = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const loc = () => (L.lang === 'ru' ? 'ru-RU' : 'en-GB');
  const dShort = (d) => new Intl.DateTimeFormat(loc(), { day: 'numeric', month: 'short' }).format(d);
  const freezeRange = (demo) => new Intl.DateTimeFormat(loc(), { day: 'numeric', month: 'short' }).formatRange(addDays(demo, -2), addDays(demo, -1));
  const inFreeze = (demo) => day0() >= addDays(demo, -2) && day0() < demo;
  const tr = (o) => o[L.lang] || o.en;
  const sprintName = (n) => `Sprint ${String(n).padStart(2, '0')}`;
  const ICO = {
    cal: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/></svg>',
    bell: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16.5h12l-1.5-2V10a4.5 4.5 0 00-9 0v4.5z"/><path d="M10 19a2 2 0 004 0"/></svg>',
    bellOff: (isNew) => `<svg class="ico bell-off${isNew ? ' is-new' : ''}" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16.5h12l-1.5-2V10a4.5 4.5 0 00-9 0v4.5z"/><path d="M10 19a2 2 0 004 0"/><path class="bell-off__slash" d="M4.5 4.5l15 15"/></svg>`,
    ask: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 5.5h15v10h-9l-6 4z"/><path d="M9 10.5h6"/></svg>',
    stack: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l3.5 3.5L15 9.5"/><path d="M11 16l1 1 7.5-7.5"/></svg>',
  };

  /* ---------- the slot schedule (as #114) ---------- */
  const SLOTS = ['pm', 'dev', 'qa'];
  const SCHEDULE = { pm: { h: 18, m: 7, days: [1, 2, 3, 4, 5] }, dev: { h: 23, m: 13, days: [1, 2, 3, 4, 5] }, qa: { h: 4, m: 21, days: [2, 3, 4, 5] } };
  function occurrences(slot) {
    const s = SCHEDULE[slot]; const out = [];
    for (let d = -8; d <= 8; d += 1) { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(s.h, s.m, 0, 0); if (s.days.includes(x.getDay())) out.push(x); }
    return out;
  }
  const lastOf = (slot) => occurrences(slot).filter((d) => d < new Date()).pop();
  const nextOf = (slot) => occurrences(slot).find((d) => d > new Date());
  const lastRun = () => SLOTS.map((slot) => ({ slot, date: lastOf(slot) })).sort((a, b) => b.date - a.date)[0];
  const nextRun = () => SLOTS.map((slot) => ({ slot, date: nextOf(slot) })).filter((x) => x.date).sort((a, b) => a.date - b.date)[0];
  function when(d) {
    const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - day0()) / (24 * 60 * MIN));
    const time = hhmm(d);
    if (diff === 0) return t('when.today', { time });
    if (diff === -1) return t('when.yesterday', { time });
    if (diff === 1) return t('when.tomorrow', { time });
    return t('when.day', { day: new Intl.DateTimeFormat(loc(), { weekday: 'short', day: 'numeric', month: 'short' }).format(d), time });
  }

  /* ---------- mock data, as the Worker would return it ---------- */
  const T = (ru, en) => ({ ru, en });
  function fresh() {
    const d0 = day0(); const morning = addDays(d0, 1); morning.setHours(9, 0, 0, 0);
    return {
      data: 'ok', outcome: 'ok', freeze: false, noSprint: false, nextExists: false, nosafe: false, busyDev: false, statusAt: new Date(),
      P: {
        storify: { slug: 'storify', repo: 'geeera/storify', state: 'running', pausedAt: at(-13), cur: { n: 1, demo: addDays(d0, 15) }, next: null, run: {}, snooze: null },
        'team-console': { slug: 'team-console', repo: 'geeera/team-console', state: 'running', pausedAt: at(-13), cur: { n: 1, demo: addDays(d0, 15) }, next: null, run: {}, snooze: null, prog: [5, 9], now: [70] },
        fieldnote: { slug: 'fieldnote', repo: 'geeera/fieldnote', state: 'owner', pausedAt: at(-60 * 20), cur: { n: 3, demo: addDays(d0, 8) }, next: null, run: {}, snooze: { until: morning, urgent: true, forever: false }, prog: [6, 8], now: [] },
      },
      issues: {
        storify: [
          { n: 41, t: T('Поиск по артефактам', 'Artifact search'), kind: 'feature', sprint: 'cur', col: 'now' },
          { n: 44, t: T('Пуш, когда прогон упал', 'A push when a run fails'), kind: 'feature', sprint: 'cur', col: 'now' },
          { n: 45, t: T('Тёмная тема для графиков', 'Dark theme for charts'), kind: 'feature', sprint: 'cur', col: 'next' },
          { n: 47, t: T('Экспорт отчёта в PDF', 'Report export to PDF'), kind: 'feature', sprint: 'cur', col: 'next', req: { sprint: 'next', prio: 'keep', at: at(-140) } },
          { n: 52, t: T('Вход падает после обновления', 'Sign-in fails after an update'), kind: 'bug', sprint: 'cur', col: 'next' },
          { n: 36, t: T('Онбординг', 'Onboarding'), kind: 'feature', sprint: 'cur', col: 'done' },
          { n: 38, t: T('Пуши на iPhone', 'Push on iPhone'), kind: 'feature', sprint: 'cur', col: 'done' },
          { n: 58, t: T('Импорт из Notion', 'Import from Notion'), kind: 'feature', sprint: 'none', answered: T('В Sprint 01 нет места до демо, оставил в бэклоге. Предложу его в Sprint 02.', 'Sprint 01 is full until the demo, so I left it in the backlog. I’ll propose it for Sprint 02.') },
          { n: 60, t: T('Сводка по почте', 'Email digest'), kind: 'feature', sprint: 'none' },
        ],
        'team-console': [
          { n: 70, t: T('Ссылки на артефакты в чате', 'Artifact links in chat'), kind: 'feature', sprint: 'cur', col: 'now' },
          { n: 72, t: T('Экспорт метрик', 'Metrics export'), kind: 'feature', sprint: 'cur', col: 'next' },
        ],
        fieldnote: [],
      },
      qs: [
        { p: 'storify', n: 61, t: T('Добавить экспорт в CSV в этот спринт?', 'Add CSV export to this sprint?'), cat: 'scope', rec: 'approve', c: T('да, в этот спринт', 'yes, this sprint') },
        { p: 'storify', n: 63, t: T('Перенести видео для онбординга в Sprint 02?', 'Move the onboarding video to Sprint 02?'), cat: 'scope', rec: 'approve', c: T('да, перенести', 'yes, move it') },
        { p: 'team-console', n: 66, t: T('Английский — второй язык по умолчанию?', 'English as the second default language?'), cat: 'scope', rec: 'approve', c: T('да', 'yes') },
        { p: 'storify', n: 62, t: T('Платный тариф Sentry, $26 в месяц?', 'Paid Sentry plan, $26 a month?'), cat: 'money', rec: 'approve', c: T('да', 'yes') },
        { p: 'fieldnote', n: 59, t: T('Выпустить 1.4 в production?', 'Release 1.4 to production?'), cat: 'release', rec: 'approve', c: T('да, выпустить', 'yes, release') },
        { p: 'storify', n: 65, t: T('Отказаться от экспорта в Excel?', 'Drop the Excel export?'), cat: 'scope', rec: 'reject', c: T('нет, оставить', 'no, keep it') },
        { p: 'team-console', n: 67, t: T('Значок приложения: вариант B?', 'App icon: option B?'), cat: 'design', rec: 'approve', c: T('да, B', 'yes, B') },
      ],
    };
  }
  const G = fresh();
  const PROJ = Object.keys(G.P);
  const SPACE = 'storify';
  const paused = (p) => p.state !== 'running';
  const loadedish = () => ['ok', 'offline', 'noperm', 'nopush'].includes(G.data);
  const safe = (q) => q.cat === 'scope' && q.rec === 'approve';
  const qsOf = (scope) => G.qs.filter((q) => scope === 'all' || q.p === scope);
  const safeOf = (scope) => (G.nosafe ? [] : qsOf(scope).filter(safe));
  const leftOf = (scope) => qsOf(scope).filter((q) => !safe(q) || G.nosafe);
  const outWhy = (q) => (q.rec === 'reject' ? 'reject' : q.cat);
  const openIssues = (slug) => G.issues[slug].filter((i) => i.col !== 'done');
  const issue = (slug, n) => G.issues[slug].find((i) => i.n === n);
  function progress(p) {
    if (p.prog) return { done: p.prog[0], total: p.prog[1] };
    const cur = G.issues[p.slug].filter((i) => i.sprint === 'cur');
    return { done: cur.filter((i) => i.col === 'done').length, total: cur.length };
  }
  const nowIssues = (p) => (p.now ? p.now.map((n) => issue(p.slug, n)).filter(Boolean) : G.issues[p.slug].filter((i) => i.col === 'now'));
  const nextNum = (p) => (p.cur ? p.cur.n + 1 : 2);
  function where(slug, i) {
    const p = G.P[slug];
    if (i.sprint === 'cur' && p.cur) return sprintName(p.cur.n);
    if (i.sprint === 'next') return p.next ? sprintName(p.next.n) : sprintName(nextNum(p));
    return t('rq.backlog');
  }
  function reqParts(slug, r) {
    const p = G.P[slug]; const parts = [];
    if (r.sprint === 'cur') parts.push(t('rq.dSprint', { sprint: sprintName(p.cur ? p.cur.n : 1) }));
    if (r.sprint === 'next') parts.push(t('rq.dSprint', { sprint: sprintName(p.next ? p.next.n : nextNum(p)) }));
    if (r.sprint === 'none') parts.push(t('rq.dBacklog'));
    if (r.prio === 'up') parts.push(t('rq.dUp'));
    if (r.prio === 'down') parts.push(t('rq.dDown'));
    return parts;
  }
  const joinList = (parts) => new Intl.ListFormat(loc(), { type: 'conjunction' }).format(parts);
  // Demo-bar switches reshape storify's calendar the way the Worker would report it.
  function applyCalendar() {
    const p = G.P.storify; const d0 = day0();
    if (G.noSprint) p.cur = null;
    else if (G.freeze) p.cur = { n: 1, demo: addDays(d0, 2), custom: false };
    else if (!p.cur || !p.cur.custom) p.cur = { n: 1, demo: addDays(d0, 15), custom: false };
    p.next = G.nextExists ? (p.next || { n: nextNum(p), demo: addDays(p.cur ? p.cur.demo : d0, 14) }) : null;
  }

  // Why a command is off, in the order the owner can act on it; '' when it is available.
  function whyOff(kind, p, slot) {
    if (G.data === 'loading' || G.data === 'error') return t('why.status');
    if (G.data === 'offline') return t('why.offline');
    if (kind === 'write' && G.data === 'noperm') return t('why.noperm');
    if (kind === 'run' && paused(p)) return t('why.paused');
    if (kind === 'push' && G.data === 'nopush') return t('why.nopush');
    return '';
  }
  function slotLock(p, slot) {
    if (p.slug === SPACE && slot === 'dev' && G.busyDev) return { line: t('run.busy', { time: hhmm(at(-25)), until: hhmm(at(155)) }), live: true };
    const r = p.run[slot]; if (!r) return null;
    const until = hhmm(new Date(r.at.getTime() + (r.state === 'started' ? OVERLAP : REQUEST_LOCK)));
    return { line: t(r.state === 'started' ? 'run.started' : 'run.requested', { time: hhmm(r.at), until }), live: true };
  }

  const hosts = [...document.querySelectorAll('[data-app]')];
  const renderAll = (except) => hosts.forEach((h) => h.app && h !== except && h.app.render());

  /* ---------- one app instance ---------- */
  function mountApp(host, kind, keep) {
    const S = keep || { view: 'space', surface: null, cpSlug: SPACE, opener: null, result: null, resultNew: false, needsResult: null, dialog: null, refreshing: false, flip: false, newChip: null, newSnooze: null };
    host.S = S;
    S.dialog = null; // a language switch rebuilds the frame; an open dialog closes with it
    const uid = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const $ = (s) => host.querySelector(s);
    const dis = (why) => (why ? ' aria-disabled="true"' : '');
    const mac = kind === 'mac';
    const runlogLink = (fk) => `<a class="ext" href="#runlog" data-act="runlog" data-fk="${fk}">${t('st.log')}<span class="sr-only"> ${t('c.external')}</span>${I.ext}</a>`;
    const mono = (slug) => `<span class="prod-mono" aria-hidden="true"${G.P[slug].state === 'running' ? '' : ` data-status="${G.P[slug].state === 'team' ? 'failing' : 'paused'}"`}>${slug[0]}</span>`;

    // Mac: a click anywhere in the window keeps the keyboard shortcuts (K, B) working.
    if (mac) host.tabIndex = -1; else host.removeAttribute('tabindex');
    host.innerHTML = mac ? `<div class="win">
        <div class="win__bar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="win__title">Team Console</span></div>
        <div class="win__body">
          <nav class="sidebar" aria-label="${t('nav.aria')}" data-bg>
            <div class="brand">${I.mark}<span>Team Console</span></div>
            <label class="search search--side">${I.search}<span class="sr-only">${t('nav.filter')}</span><input type="search" placeholder="${t('nav.filter')}" autocomplete="off"><kbd>/</kbd></label>
            <div data-slot="side"></div>
            <div class="side-foot"><span class="avatar avatar--owner" aria-hidden="true">K</span><span>${t('nav.owner')}</span></div>
          </nav>
          <section class="convo" aria-labelledby="${uid}-name" data-bg>
            <header class="convo__head" data-slot="head"></header>
            <div class="banner-wrap" data-slot="banner"></div>
            <div class="log"><div class="log__inner" data-slot="content"></div></div>
          </section>
          <section class="pane cp-pane" id="${uid}-pane" aria-labelledby="${uid}-sh" data-slot="pane"><div class="pane__inner cp" data-slot="surface"></div></section>
        </div>
      </div>
      <div data-slot="modal"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`
      : `<div class="p-status" aria-hidden="true"><span>9:41</span><span class="p-island"></span><span class="p-status__icons">${I.bars}${I.battery}</span></div>
      <div data-slot="head" data-bg></div>
      <div class="banner-wrap" data-slot="banner" data-bg></div>
      <div class="log p-log" data-bg><div class="log__inner" data-slot="content"></div></div>
      <nav class="tabs" aria-label="${t('nav.sections')}" data-slot="tabs" data-bg></nav>
      <div class="home-ind" aria-hidden="true"></div>
      <div class="scrim" data-act="surface-close"></div>
      <section class="sheet cp-sheet" role="dialog" aria-modal="true" aria-labelledby="${uid}-sh" data-slot="sheet" inert>
        <div class="sheet__grab" aria-hidden="true"></div>
        <div class="cp" data-slot="surface"></div>
      </section>
      <div data-slot="modal"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`;

    /* ----- the space, All projects and Needs you ----- */
    const surfaceBtn = (name, label, key, icon) => `<button type="button" class="btn ${mac ? 'cp-open' : 'btn--sm p-cmd'}" data-act="surface-toggle" data-surface="${name}" data-fk="open-${name}" aria-label="${esc(name === 'commands' ? t('space.commandsAria', { name: SPACE }) : label)}" aria-expanded="${S.surface === name && S.cpSlug === SPACE}" ${mac ? `aria-controls="${uid}-pane" aria-keyshortcuts="${key}"` : 'aria-haspopup="dialog"'}>${icon}<span>${label}</span>${mac ? `<kbd aria-hidden="true">${key}</kbd>` : ''}</button>`;
    function batchBtn(scope, from, fk, cls = '') {
      const n = safeOf(scope).length; const why = n ? whyOff('write') : '';
      return `<button type="button" class="btn btn--sm${n && !why ? ' btn--primary' : ''} ${cls}" data-act="batch" data-scope="${scope}" data-from="${from}" data-fk="${fk}"${dis(why || !n)}${why ? ` aria-describedby="${uid}-${fk}-why"` : ''}>${ICO.stack}<span>${n ? t('needs.approve', { n }) : t('needs.approveNone')}</span></button>${why ? `<span class="sr-only" id="${uid}-${fk}-why">${why}</span>` : ''}`;
    }
    function headHTML() {
      const p = G.P[SPACE];
      const sub = p.cur ? t('space.sub', { sprint: sprintName(p.cur.n), date: dShort(p.cur.demo) }) : t('st.noSprint');
      if (mac) {
        if (S.view === 'all') return `<div class="convo__title"><h2 id="${uid}-name">${t('all.title')}</h2></div>`;
        if (S.view === 'needs') return `<div class="convo__title"><h2 id="${uid}-name">${t('needs.title')}</h2></div>${batchBtn('all', 'needs', 'needs-batch')}`;
        return `<div class="convo__title"><span class="prod-mono" aria-hidden="true">s</span><h2 id="${uid}-name">${SPACE}</h2><span class="convo__sub"><span data-flip>${sub}</span></span></div>${surfaceBtn('board', t('space.board'), 'B', I.board)}${surfaceBtn('commands', t('space.commands'), 'K', I.sliders)}`;
      }
      if (S.view !== 'space') return `<header class="p-head p-head--view"><h1 class="p-title" id="${uid}-name">${t(S.view === 'all' ? 'all.title' : 'needs.title')}</h1></header>`;
      return `<header class="p-head"><button type="button" class="p-switch" data-act="view" data-view="all" data-fk="p-switch" aria-label="${esc(t('nav.switch', { name: SPACE }))}"><span class="prod-mono" aria-hidden="true">s</span><span class="p-switch__txt"><b id="${uid}-name">${SPACE}</b><small data-flip>${sub}</small></span>${I.down}</button>${surfaceBtn('commands', t('space.commands'), 'K', I.sliders)}</header>`;
    }
    function bannerHTML() {
      const p = G.P[SPACE];
      if (S.view !== 'space' || !paused(p) || !loadedish()) return '';
      const team = p.state === 'team'; const why = whyOff('write', p);
      return `<div class="paused cp-banner${team ? ' paused--bad' : ''}" role="status">${team ? I.warn : I.pause}<span>${t(team ? 'banner.team' : 'banner.owner', { name: SPACE, time: hhmm(p.pausedAt) })}</span>
        <span class="cp-banner__acts">${team ? runlogLink('banner-log') : ''}<button type="button" class="btn btn--sm" data-act="resume" data-slug="${SPACE}" data-from="banner" data-fk="banner-resume"${dis(why)}>${t('banner.resume')}</button></span></div>`;
    }
    const chatHTML = () => `<div class="day"><span>${t('chat.today')}</span></div>
      <div class="msg msg--pm"><span class="avatar avatar--pm" aria-hidden="true">PM</span><div class="msg__body"><div class="msg__meta"><b>${t('chat.pm')}</b><span>${hhmm(at(-300))}</span></div><div class="bubble">${t('chat.m1')}</div></div></div>
      <div class="msg msg--pm"><span class="avatar avatar--pm" aria-hidden="true">PM</span><div class="msg__body"><div class="msg__meta"><b>${t('chat.pm')}</b><span>${hhmm(at(-298))}</span></div><div class="bubble">${t('chat.m2')}</div></div></div>`;
    const stateChip = (p) => `<span class="status${p.state === 'owner' ? ' status--paused' : p.state === 'team' ? ' status--failing' : ''}"><i aria-hidden="true"></i>${t(p.state === 'running' ? 'all.running' : p.state === 'owner' ? 'all.paused' : 'all.failing')}</span>`;
    const snoozeUntil = (z) => (z.forever ? '' : when(z.until));
    function allHTML() {
      const n = PROJ.length; const pz = PROJ.filter((s) => paused(G.P[s])).length;
      const hl = mac ? 'h3' : 'h2'; // the phone's view title is the h1
      const card = (slug) => {
        const p = G.P[slug]; const pr = progress(p); const q = qsOf(slug).length; const z = p.snooze;
        return `<li><article class="ov all-card" data-slug="${slug}" aria-labelledby="${uid}-ov-${slug}">
          <div class="ov__top">${mono(slug)}<${hl} class="all-card__name" id="${uid}-ov-${slug}">${slug}</${hl}>${stateChip(p)}</div>
          <p class="ov__line">${p.cur ? t('all.line', { sprint: sprintName(p.cur.n), date: dShort(p.cur.demo), done: pr.done, total: pr.total }) : t('all.noSprint')}</p>
          ${p.cur ? `<span class="meter meter--wide" aria-hidden="true"><i style="--p:${Math.round((100 * pr.done) / Math.max(pr.total, 1))}%"></i></span>` : ''}
          <p class="ov__line">${t('all.needs', { n: q })}</p>
          ${z ? `<p class="all-snz">${ICO.bellOff(S.newSnooze === slug)}<span>${z.forever ? t('all.snoozedForever') : t('all.snoozed', { until: snoozeUntil(z) })}</span></p>` : ''}
          <div class="all-card__acts"><button type="button" class="btn btn--sm btn--quiet" data-act="elsewhere" data-fk="all-open-${slug}">${t('all.open', { name: slug })}</button>
          <button type="button" class="btn btn--sm" data-act="commands-for" data-slug="${slug}" data-fk="all-cmd-${slug}" aria-label="${esc(t('all.cmdAria', { name: slug }))}"${mac ? ' aria-keyshortcuts="K"' : ' aria-haspopup="dialog"'} aria-expanded="${S.surface === 'commands' && S.cpSlug === slug}">${I.sliders}<span>${t('all.cmd')}</span>${mac ? '<kbd aria-hidden="true">K</kbd>' : ''}</button></div>
        </article></li>`;
      };
      return `<p class="needs__lead">${t('all.lead', { n, p: pz })}</p><ul class="ov-grid all-grid">${PROJ.map(card).join('')}</ul>`;
    }
    function needsHTML() {
      const list = G.qs; const k = new Set(list.map((q) => q.p)).size;
      const res = S.needsResult ? receiptHTML(S.needsResult, 'needs-res') : '';
      if (!list.length) return `${res}<div class="empty empty--big">${I.check}<p>${t('needs.empty')}</p></div>`;
      return `${res}<div class="needs-head"><p class="needs__lead">${t('needs.lead', { n: list.length, k })}</p>${mac ? '' : batchBtn('all', 'needs', 'needs-batch', 'needs-head__btn')}</div>
        <ul class="needs__list">${list.map((q) => `<li data-q="${q.n}"><button type="button" class="need" data-act="elsewhere" data-fk="need-${q.n}">
          <span class="need__top"><span class="ptag">${mono(q.p)}${q.p}</span><span class="need__kind">#${q.n}</span></span>
          <span class="need__title">${esc(tr(q.t))}</span><span class="need__rec">${t('needs.rec', { c: tr(q.c) })}</span>${I.chev}</button></li>`).join('')}</ul>`;
    }
    function sideHTML() {
      const nq = G.qs.length;
      const item = (slug) => {
        const p = G.P[slug]; const dot = p.state === 'team' ? ' sdot--failing' : paused(p) ? ' sdot--paused' : '';
        const cur = S.view === 'space' && slug === SPACE;
        return `<li><button type="button" class="side-item"${cur ? ' aria-current="true"' : ''} data-act="${slug === SPACE ? 'view' : 'elsewhere'}" data-view="space" data-fk="side-${slug}"><span class="prod-mono" aria-hidden="true">${slug[0]}</span><span class="side-prod__label">${slug}</span>${p.snooze ? `<span class="side-snz">${ICO.bellOff(S.newSnooze === slug)}<span class="sr-only">${t('side.snoozed')}</span></span>` : ''}<i class="sdot${dot}" aria-hidden="true"></i></button></li>`;
      };
      return `<ul class="side-list side-list--top">
          <li><button type="button" class="side-item" data-act="view" data-view="needs" data-fk="side-needs"${S.view === 'needs' ? ' aria-current="true"' : ''}>${I.inbox}<span>${t('nav.needs')}</span>${nq ? `<span class="count">${nq}</span>` : ''}</button></li>
          <li><button type="button" class="side-item" data-act="view" data-view="all" data-fk="side-all"${S.view === 'all' ? ' aria-current="true"' : ''}>${I.grid}<span>${t('nav.all')}</span></button></li>
        </ul><div class="side-label">${t('nav.projects')}</div><ul class="side-list">${PROJ.map(item).join('')}</ul>`;
    }
    function tabsHTML() {
      const cur = (v) => (S.view === v && !(v === 'space' && S.surface === 'board') ? ' aria-current="page"' : '');
      return `<button type="button" data-act="view" data-view="needs" data-fk="tab-needs"${cur('needs')}>${I.inbox}<span>${t('nav.needs')}</span>${G.qs.length ? `<span class="count">${G.qs.length}</span>` : ''}</button>
        <button type="button" data-act="view" data-view="space" data-fk="tab-chat"${cur('space')}>${I.chat}<span>${t('nav.chat')}</span></button>
        <button type="button" data-act="surface-open" data-surface="board" data-fk="tab-board" aria-haspopup="dialog"${S.surface === 'board' ? ' aria-current="page"' : ''}>${I.board}<span>${t('nav.board')}</span></button>
        <button type="button" data-act="elsewhere" data-fk="tab-art">${I.stack}<span>${t('nav.artifacts')}</span></button>`;
    }

    /* ----- result note (the kit's Receipt) ----- */
    function receiptHTML(r, fk) {
      const glyph = r.tone === 'warning' ? I.q : r.tone === 'neutral' ? I.minus : I.check;
      const toneCls = r.tone === 'neutral' ? ' receipt--neutral' : r.tone === 'warning' ? ' cp-res--warning' : '';
      const link = r.link === 'log' ? ` · ${runlogLink(`${fk}-log`)}` : r.link === 'issue' ? ` · <a class="ext" href="#issue" data-act="issue" data-fk="${fk}-issue">${t('rq.open')}<span class="sr-only"> ${t('c.external')}</span>${I.ext}</a>` : '';
      return `<div class="receipt cp-res${toneCls}${r.isNew ? ' is-new' : ''}" tabindex="-1" data-fk="${fk}"><span class="receipt__icon" aria-hidden="true">${glyph}</span><span class="cp-res__main"><span class="receipt__body"><span class="receipt__verb">${r.verb}</span>${r.detail ? ` <span class="cp-res__detail">${r.detail}</span>` : ''}</span><span class="receipt__meta">${hhmm(r.time)}${link}</span></span></div>`;
    }

    /* ----- the Commands panel ----- */
    const P = () => G.P[S.cpSlug];
    function statusHTML() {
      const p = P();
      if (G.data === 'loading') return `<section class="cp-state" aria-busy="true" aria-labelledby="${uid}-st"><h3 class="cp-kicker" id="${uid}-st">${t('st.h')}</h3><span class="sr-only">${t('st.loading')}</span><div aria-hidden="true" class="skel-stack st-skel">${'<span class="skel skel--a"></span><span class="skel skel--b"></span>'.repeat(3)}</div></section>`;
      if (G.data === 'error') return `<div class="block block--error cp-err" role="alert"><h3>${t('st.errT')}</h3><p>${t('st.errB')}</p><button type="button" class="btn btn--tall" data-act="refresh" data-fk="st-retry"${dis(S.refreshing)}>${S.refreshing ? t('st.refreshing') : t('c.retry')}</button></div>`;
      const state = p.state === 'running' ? t('st.running') : p.state === 'owner' ? t('st.owner', { time: hhmm(p.pausedAt) }) : t('st.team');
      const pr = progress(p); const now = nowIssues(p); const q = qsOf(p.slug).length;
      const last = lastRun(); const next = nextRun();
      const sprint = p.cur ? `<span data-flip>${t('st.sprintVal', { sprint: sprintName(p.cur.n), date: dShort(p.cur.demo) })}</span><small${inFreeze(p.cur.demo) ? ' class="st-freeze"' : ''}>${inFreeze(p.cur.demo) ? t('st.freezeNow') : t('st.freeze', { range: freezeRange(p.cur.demo) })}</small>` : t('st.noSprint');
      const off = G.data === 'offline';
      let note = '';
      if (off) note = `<p class="paused cp-note" role="status">${I.wifi}<span>${t('st.offline', { time: hhmm(G.statusAt) })}</span></p>`;
      if (G.data === 'noperm') note = `<p class="paused cp-note">${I.lock}<span>${t('st.noperm', { repo: p.repo })} <a href="#settings" data-act="settings" data-fk="noperm-fix">${t('st.nopermFix')}</a></span></p>`;
      return `<section class="cp-state st-card" aria-labelledby="${uid}-st"><h3 class="cp-kicker" id="${uid}-st">${t('st.h')}</h3>
        <p class="cp-state__now cp-state__now--${p.state}" data-state>${p.state === 'team' ? I.warn : `<i class="sdot${paused(p) ? ' sdot--paused' : ''}" aria-hidden="true"></i>`}<span>${state}</span></p>
        <dl class="st-dl">
          <div><dt>${t('st.sprint')}</dt><dd>${sprint}</dd></div>
          ${p.cur ? `<div><dt>${t('st.progress')}</dt><dd><span>${t('st.progressVal', pr)}</span><span class="meter" aria-hidden="true"><i style="--p:${Math.round((100 * pr.done) / Math.max(pr.total, 1))}%"></i></span></dd></div>` : ''}
          <div><dt>${t('st.now')}</dt><dd>${now.length ? now.map((i) => `<span class="st-iss"><span class="st-num">#${i.n}</span> ${esc(tr(i.t))}</span>`).join('') : t('st.nowNone')}</dd></div>
          <div><dt>${t('st.needs')}</dt><dd>${q ? t('st.needsVal', { n: q }) : t('st.needsNone')}</dd></div>
          <div><dt>${t('st.last')}</dt><dd>${t('st.lastVal', { slot: t(`slot.${last.slot}`), when: when(last.date) })}</dd></div>
          <div><dt>${t('st.next')}</dt><dd>${paused(p) ? t('st.nextPaused', { slot: t(`slot.${next.slot}`), when: when(next.date) }) : `${t(`slot.${next.slot}`)}, ${when(next.date)}`}</dd></div>
        </dl>
        <p class="cp-state__meta"><span>${t('st.updated', { time: hhmm(G.statusAt) })}</span><button type="button" class="link-btn cp-refresh" data-act="refresh" data-fk="st-refresh"${dis(off || S.refreshing)}>${I.refresh}<span>${S.refreshing ? t('st.refreshing') : t('st.refresh')}</span></button>${runlogLink('st-log')}</p>
        </section>${note}`;
    }
    // One command row: the text says what it does (or its state), the button names the action.
    function row({ id, title, hint, line, lineIco, why, whyIco, btn, extra = '', cls = '' }) {
      const d = [why ? `${id}-why` : '', hint ? `${id}-hint` : '', line ? `${id}-line` : ''].filter(Boolean).join(' ');
      const b = btn ? `<button type="button" class="btn cmd__btn${btn.primary && !why ? ' btn--primary' : ''}" data-act="${btn.act}" data-fk="${btn.fk}"${btn.slot ? ` data-slot="${btn.slot}"` : ''} data-slug="${S.cpSlug}" data-from="panel" aria-label="${esc(btn.aria)}" aria-describedby="${d}"${dis(why || btn.off)}>${btn.icon || ''}<span>${btn.label}</span></button>` : '';
      return `<li class="cmd${cls}"><div class="cmd__txt"><p class="cmd__title">${title}</p>${hint ? `<p class="cmd__hint" id="${id}-hint">${hint}</p>` : ''}${line ? `<p class="cmd__line" id="${id}-line">${lineIco || ''}<span>${line}</span></p>` : ''}${why ? `<p class="cmd__why" id="${id}-why">${whyIco || I.lock}<span>${why}</span></p>` : ''}${extra}</div>${b}</li>`;
    }
    const whyIco = () => (G.data === 'offline' ? I.wifi : I.lock);
    function teamHTML() {
      const p = P(); const why = whyOff('write', p); const id = `${uid}-team`;
      const n = nextRun();
      const r = paused(p)
        ? { title: t('cmd.resume'), hint: t('cmd.resumeHint', { slot: t(`slot.${n.slot}N`), when: when(n.date) }), btn: { act: 'resume', fk: 'cmd-team', aria: t('cmd.resume'), label: t('cmd.resumeBtn'), icon: I.play, primary: true } }
        : { title: t('cmd.pause'), hint: t('cmd.pauseHint'), btn: { act: 'pause', fk: 'cmd-team', aria: t('cmd.pause'), label: t('cmd.pauseBtn'), icon: I.pause } };
      return group('gt', t('g.team'), row({ id, ...r, why, whyIco: whyIco(), cls: ' cmd--team' }));
    }
    function runHTML() {
      const p = P();
      return group('gr', t('g.run'), SLOTS.map((slot) => {
        const lock = slotLock(p, slot); const why = whyOff('run', p, slot);
        return row({ id: `${uid}-run-${slot}`, title: t(`slot.${slot}`), line: lock ? lock.line : t('run.last', { when: when(lastOf(slot)) }), lineIco: lock ? '<i class="cmd__live" aria-hidden="true"></i>' : '', why, whyIco: whyIco(),
          btn: { act: 'run', slot, fk: `run-${slot}`, aria: t('run.btnAria', { slot: t(`slot.${slot}`) }), label: t('run.btn'), icon: I.play, off: !!lock } });
      }).join(''));
    }
    function sprintHTML() {
      const p = P(); const why = whyOff('write', p); const rows = [];
      if (p.cur) {
        const name = sprintName(p.cur.n);
        rows.push(row({ id: `${uid}-demo`, title: t('cmd.demo'), hint: `<span data-flip>${t('cmd.demoHint', { sprint: name, date: dShort(p.cur.demo), range: freezeRange(p.cur.demo) })}</span>`, why, whyIco: whyIco(),
          btn: { act: 'demo', fk: 'cmd-demo', aria: t('cmd.demoAria', { sprint: name }), label: t('cmd.demoBtn'), icon: ICO.cal } }));
      }
      const nn = sprintName(nextNum(p));
      if (p.next) rows.push(row({ id: `${uid}-next`, title: t('cmd.next'), line: t('cmd.nextExists', { sprint: sprintName(p.next.n), date: dShort(p.next.demo) }), lineIco: I.check }));
      else rows.push(row({ id: `${uid}-next`, title: t('cmd.next'), hint: p.cur ? t('cmd.nextHint', { sprint: nn, date: dShort(p.cur.demo) }) : t('cmd.nextHintNow', { sprint: nn }), why, whyIco: whyIco(),
        btn: { act: 'next', fk: 'cmd-next', aria: t('cmd.nextAria', { sprint: nn }), label: t('cmd.nextBtn'), icon: I.plus } }));
      return group('gs', t('g.sprint'), rows.join(''));
    }
    function issuesHTML() {
      const p = P(); const why = whyOff('write', p);
      const pend = G.issues[p.slug].filter((i) => i.req);
      const ask = row({ id: `${uid}-ask`, title: t('cmd.ask'), hint: t('cmd.askHint'), line: pend.length ? t('cmd.askPending', { n: pend.length, ids: pend.map((i) => `#${i.n}`).join(', ') }) : '', lineIco: pend.length ? '<i class="pend-dot" aria-hidden="true"></i>' : '', why, whyIco: whyIco(),
        btn: { act: 'pick', fk: 'cmd-ask', aria: t('cmd.askAria'), label: t('cmd.askBtn'), icon: ICO.ask } });
      const n = safeOf(p.slug).length; const m = leftOf(p.slug).length;
      const appr = n
        ? row({ id: `${uid}-appr`, title: t('cmd.approve'), hint: t('cmd.approveHint', { n, m }), why, whyIco: whyIco(), btn: { act: 'batch', fk: 'cmd-approve', aria: t('cmd.approveAria', { n }), label: t('cmd.approveBtn'), icon: ICO.stack } })
        : row({ id: `${uid}-appr`, title: t('cmd.approve'), line: t('cmd.approveNone'), lineIco: I.minus });
      return group('gi', t('g.issues'), ask + appr);
    }
    function notifyHTML() {
      const p = P(); const z = p.snooze; const id = `${uid}-snz`;
      const why = whyOff('push', p);
      const fix = G.data === 'nopush' ? ` <a href="#push" data-act="push" data-fk="nopush-fix">${t('why.nopushFix')}</a>` : '';
      if (z) {
        return group('gn', t('g.notify'), row({ id, title: t('cmd.snooze'), line: `${z.forever ? t('cmd.snoozedForever') : t('cmd.snoozed', { until: snoozeUntil(z) })}. ${z.urgent ? t('cmd.snoozedUrgent') : t('cmd.snoozedQuiet')}`, lineIco: ICO.bellOff(S.newSnooze === p.slug), why: why && why !== t('why.nopush') ? why : '', whyIco: whyIco(),
          btn: { act: 'unsnooze', fk: 'cmd-snooze', aria: t('cmd.unsnoozeAria', { name: p.slug }), label: t('cmd.unsnooze'), icon: ICO.bell } }));
      }
      return group('gn', t('g.notify'), row({ id, title: t('cmd.snooze'), hint: t('cmd.snoozeHint', { name: p.slug }), why: why ? `${why}${fix ? '.' : ''}` : '', whyIco: G.data === 'nopush' ? ICO.bellOff(false) : whyIco(), extra: fix ? `<p class="cmd__fix">${fix}</p>` : '',
        btn: { act: 'snooze', fk: 'cmd-snooze', aria: t('cmd.snoozeAria', { name: p.slug }), label: t('cmd.snoozeBtn'), icon: ICO.bellOff(false) } }));
    }
    const group = (key, title, rows) => `<section class="cp-group" aria-labelledby="${uid}-${key}"><h3 class="cp-kicker" id="${uid}-${key}">${title}</h3><ul class="cmd-list">${rows}</ul></section>`;
    function commandsHTML() {
      const p = P();
      const body = G.data === 'loading'
        ? `${statusHTML()}<div class="cmd-list" aria-hidden="true">${'<div class="skel-row"><span class="skel-stack"><span class="skel skel--a"></span><span class="skel skel--b"></span></span></div>'.repeat(5)}</div>`
        : `${S.result ? receiptHTML(S.result, 'result') : ''}${statusHTML()}${teamHTML()}${runHTML()}${sprintHTML()}${issuesHTML()}${notifyHTML()}`;
      return `<header class="cp__head"><h2 class="cp__title" id="${uid}-sh" tabindex="-1" data-fk="sh-h">${t('panel.title', { name: p.slug })}</h2>
        <button type="button" class="icon-btn" data-act="surface-close" data-fk="sh-close" aria-label="${esc(t('panel.close'))}">${I.x}</button></header>
        <div class="cp__body">${body}</div>`;
    }

    /* ----- the board (read-only #18, plus its command shortcuts) ----- */
    function boardHTML() {
      const p = G.P[SPACE]; const why = whyOff('write', p);
      const head = `<header class="cp__head"><h2 class="cp__title" id="${uid}-sh" tabindex="-1" data-fk="sh-h">${t('nav.board')} · ${SPACE}</h2>
        <button type="button" class="icon-btn" data-act="surface-close" data-fk="sh-close" aria-label="${esc(t('pane.close'))}">${I.x}</button></header>`;
      const whyNote = why ? `<span class="sr-only" id="${uid}-bd-why">${why}</span>` : '';
      const wd = why ? ` aria-describedby="${uid}-bd-why"` : '';
      let body;
      if (!p.cur) {
        body = `<div class="board__empty">${ICO.cal}<div><p>${t('bd.noSprint')}</p><button type="button" class="btn btn--sm bd-start" data-act="next" data-slug="${SPACE}" data-from="board" data-fk="bd-start"${dis(why)}${wd}>${I.plus}<span>${t('bd.start')}</span></button></div></div>`;
      } else {
        const name = sprintName(p.cur.n); const pr = progress(p);
        const item = (i) => {
          const pend = i.req ? `<span class="chip-pend${S.newChip === i.n ? ' is-new' : ''}"><i class="pend-dot" aria-hidden="true"></i>${t('bd.pending')}<span class="sr-only">: ${esc(joinList(reqParts(SPACE, i.req)))}</span></span>` : '';
          const ask = i.col === 'done' ? '' : `<button type="button" class="btn btn--sm btn--quiet bd-ask" data-act="form" data-n="${i.n}" data-slug="${SPACE}" data-from="board" data-fk="bd-ask-${i.n}" aria-label="${esc(t('bd.askAria', { n: i.n }))}"${dis(why)}${wd}>${t('bd.ask')}</button>`;
          return `<li class="item bd-item"><span class="item__num">#${i.n}</span><span class="item__title">${esc(tr(i.t))}${pend}</span>${ask}</li>`;
        };
        const cols = ['now', 'next', 'done'].map((c) => { const list = G.issues[SPACE].filter((i) => i.sprint === 'cur' && i.col === c); return `<section class="col" aria-labelledby="${uid}-col-${c}"><h4 id="${uid}-col-${c}">${t(`col.${c}`)}<span>${list.length}</span></h4><ul>${list.map(item).join('')}</ul></section>`; }).join('');
        body = `<div class="board__head bd-head"><div><div class="board__kicker">${t('bd.kicker', { name: SPACE, state: t(p.state === 'running' ? 'all.running' : p.state === 'owner' ? 'all.paused' : 'all.failing') })}</div><h3>${name}</h3>
            <p class="bd-sub" data-flip>${t('bd.sub', { date: dShort(p.cur.demo), range: freezeRange(p.cur.demo) })}</p></div>
            <button type="button" class="btn btn--sm" data-act="demo" data-slug="${SPACE}" data-from="board" data-fk="bd-move" aria-label="${esc(t('cmd.demoAria', { sprint: name }))}"${dis(why)}${wd}>${ICO.cal}<span>${t('bd.move')}</span></button></div>
          <div class="bd-prog"><div class="progress" aria-hidden="true"><i style="--p:${Math.round((100 * pr.done) / Math.max(pr.total, 1))}%"></i></div><span>${t('bd.progress', pr)}</span></div>
          <div class="cols">${cols}</div>`;
      }
      const foot = `<div class="board__foot"><button type="button" class="btn btn--quiet" data-act="${paused(p) ? 'resume' : 'pause'}" data-slug="${SPACE}" data-from="board" data-fk="bd-team"${dis(why)}${wd}>${paused(p) ? I.play + t('bd.resume') : I.pause + t('bd.pause')}</button><span>${t('bd.updated', { time: hhmm(G.statusAt) })}</span></div>`;
      return `${head}<div class="cp__body bd-body"><div class="board">${body}${foot}</div>${whyNote}</div>`;
    }
    function paneHTML() {
      if (S.surface === 'board') return boardHTML();
      if (S.surface === 'commands') return commandsHTML();
      return '';
    }

    /* ----- render with focus kept by data-fk ----- */
    function render(opts = {}) {
      const active = host.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
      $('[data-slot=head]').innerHTML = headHTML();
      $('[data-slot=banner]').innerHTML = bannerHTML();
      const content = $('[data-slot=content]');
      content.classList.toggle('log__inner--view', S.view !== 'space');
      content.innerHTML = S.view === 'all' ? allHTML() : S.view === 'needs' ? needsHTML() : chatHTML();
      if (mac) $('[data-slot=side]').innerHTML = sideHTML(); else $('[data-slot=tabs]').innerHTML = tabsHTML();
      $('[data-slot=surface]').innerHTML = paneHTML();
      if (S.result) S.result.isNew = false;
      if (S.needsResult) S.needsResult.isNew = false;
      setSurfaceDom();
      if (S.flip) { S.flip = false; flip(); }
      S.newChip = null; S.newSnooze = null;
      const target = opts.focus ? host.querySelector(`[data-fk="${opts.focus}"]`) : active ? host.querySelector(`[data-fk="${active}"]`) : null;
      if (target && (opts.focus || !S.dialog)) target.focus({ preventScroll: !opts.focus });
    }
    // A moved date turns like a desk-calendar leaf: the old one lifts away, the new one settles.
    function flip() {
      host.querySelectorAll('[data-flip]').forEach((el, i) => {
        if (isReduced()) { play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') }); return; }
        play(el, [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: ms('--dur-base'), delay: i * ms('--stagger'), easing: cssVar('--ease-enter'), fill: 'backwards' });
      });
    }
    const announce = (txt) => { const l = $('[data-slot=live]'); l.textContent = ''; setTimeout(() => { l.textContent = txt; }, 30); };
    let toastTimer;
    function toast(txt) {
      const el = $('[data-slot=toast]'); el.textContent = txt; el.hidden = false;
      if (!isReduced()) play(el, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: ms('--dur-base'), easing: cssVar('--ease-enter') });
      else play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') });
      clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms('--dur-toast'));
    }

    /* ----- the surface: a non-modal pane on the Mac, a modal sheet on the iPhone ----- */
    function setSurfaceDom() {
      const open = !!S.surface;
      if (mac) {
        const pane = $('[data-slot=pane]'); pane.classList.toggle('is-open', open); pane.inert = !open || !!S.dialog;
        host.querySelectorAll('[data-bg]').forEach((el) => { el.inert = !!S.dialog; });
      } else {
        host.classList.toggle('has-sheet', open);
        const sh = $('[data-slot=sheet]'); sh.classList.toggle('is-open', open); sh.inert = !open || !!S.dialog;
        host.querySelectorAll('[data-bg]').forEach((el) => { el.inert = open || !!S.dialog; });
      }
    }
    function openSurface(name, slug, opener) {
      S.surface = name; S.cpSlug = slug || SPACE; S.result = null; S.opener = opener || null;
      render({ focus: 'sh-h' });
    }
    function closeSurface() {
      const back = S.opener; S.surface = null; S.result = null; render();
      const f = back && host.querySelector(`[data-fk="${back}"]`); if (f) f.focus();
    }

    /* ----- dialogs: one confirmation per command; the picker, the request form and snooze are plain dialogs ----- */
    function dateField(d, label, hintHTML, invalid) {
      return `<div class="field"><label class="field__label" for="${uid}-date">${label}</label>
        <input class="field__input dlg-date" id="${uid}-date" type="date" data-fk="dlg-date" data-input="date" value="${esc(d.value || '')}" min="${d.min || iso(day0())}"${d.max ? ` max="${d.max}"` : ''} aria-describedby="${uid}-date-hint"${invalid ? ' aria-invalid="true"' : ''}${d.busy ? ' readonly' : ''}>
        <div id="${uid}-date-hint" data-region="hint">${hintHTML}</div></div>`;
    }
    function checkDemo(d) {
      const p = G.P[d.slug]; const v = fromIso(d.value);
      if (!v) return { err: t('md.empty') };
      if (v < day0()) return { err: t('md.past') };
      if (p.next && v >= p.next.demo) return { err: t('md.afterNext', { next: sprintName(p.next.n), date: dShort(p.next.demo) }) };
      return { v, same: iso(v) === iso(p.cur.demo), warn: inFreeze(v) ? t('md.freezeNow') : '' };
    }
    function checkNext(d) {
      const p = G.P[d.slug]; const v = fromIso(d.value); const base = p.cur ? p.cur.demo : day0();
      if (!v) return { err: t('md.empty') };
      if (v <= base) return { err: t('ns.early', { sprint: sprintName(nextNum(p)), date: dShort(base) }) };
      return { v };
    }
    const hintErr = (txt) => `<p class="field__err">${I.warn}<span>${txt}</span></p>`;
    // Every dialog type: role, title, body, the regions that follow input, and the primary button.
    const SPEC = {
      pause: (d) => ({ role: 'alertdialog', title: t('p.t', { name: d.slug }), body: `<ul class="cmd-dialog__list"><li>${t('p.b1')}</li><li>${t('p.b2')}</li><li>${t('p.b3')}</li></ul>`, ok: { label: t('p.ok') } }),
      resume: (d) => {
        const n = nextRun(); const team = G.P[d.slug].state === 'team';
        return { role: 'alertdialog', title: t('r.t', { name: d.slug }), body: `${team ? `<div class="cmd-dialog__warn">${I.warn}<p>${t('r.bTeam')}</p></div>` : ''}<p>${t('r.b', { slot: t(`slot.${n.slot}N`), when: when(n.date) })}</p>`, ok: { label: t('r.ok') } };
      },
      run: (d) => ({ role: 'alertdialog', title: t('run.t', { slot: t(`slot.${d.slot}L`) }), body: `<p>${t(`run.${d.slot}`)}</p><p class="cmd-dialog__quota">${t('run.quota')}</p>`, ok: { label: t('run.ok') } }),
      demo: (d) => {
        const p = G.P[d.slug]; const c = checkDemo(d);
        const hint = c.err ? hintErr(c.err) : `<p class="field__hint">${t('md.freeze', { range: freezeRange(c.v) })}</p>${c.warn ? `<p class="dlg-warn">${I.warn}<span>${c.warn}</span></p>` : ''}`;
        return { role: 'alertdialog', title: t('md.t', { sprint: sprintName(p.cur.n) }), body: `<p>${t('md.b', { date: dShort(p.cur.demo) })}</p>`,
          extra: dateField(d, t('md.field'), hint, !!c.err), regions: { hint }, invalid: !!c.err,
          ok: c.err ? { label: t('md.ok', { date: '…' }), off: true } : c.same ? { label: t('md.same'), off: true } : { label: t('md.ok', { date: dShort(c.v) }) } };
      },
      next: (d) => {
        const p = G.P[d.slug]; const c = checkNext(d); const nn = sprintName(nextNum(p));
        const hint = c.err ? hintErr(c.err) : `<p class="field__hint">${t('ns.hint', { range: freezeRange(c.v) })}</p>`;
        return { role: 'alertdialog', title: t('ns.t', { sprint: nn }), body: `<p>${p.cur ? t('ns.after', { sprint: nn, cur: sprintName(p.cur.n), date: dShort(p.cur.demo) }) : t('ns.now', { sprint: nn })}</p>`,
          extra: dateField(d, t('ns.field', { sprint: nn }), hint, !!c.err), regions: { hint }, invalid: !!c.err, ok: { label: t('ns.ok', { sprint: nn }), off: !!c.err } };
      },
      pick: (d) => {
        const all = openIssues(d.slug); const q = (d.q || '').trim().toLowerCase().replace(/^#/, '');
        const list = q ? all.filter((i) => String(i.n).startsWith(q) || tr(i.t).toLowerCase().includes(q)) : all;
        const items = !all.length ? `<p class="pick-empty">${t('pk.empty')}</p>` : !list.length ? `<p class="pick-empty" role="status">${t('pk.none', { q: d.q.trim() })}</p>`
          : `<ul class="pick-list" aria-label="${esc(plain(t('pk.count', { n: list.length })))}">${list.map((i) => `<li><button type="button" class="pick-item" data-act="form" data-n="${i.n}" data-slug="${d.slug}" data-fk="pick-${i.n}">
              <span class="item__num">#${i.n}</span><span class="pick-item__txt"><span class="pick-item__t">${esc(tr(i.t))}</span><small>${esc(where(d.slug, i))}${i.req ? ` · <span class="pick-pend"><i class="pend-dot" aria-hidden="true"></i>${t('pk.pending')}</span>` : i.answered ? ` · ${t('pk.answered')}` : ''}</small></span>${I.chev}</button></li>`).join('')}</ul>`;
        return { role: 'dialog', cls: ' cmd-dialog--pick', title: t('pk.t'), body: '',
          extra: all.length ? `<label class="search pick-search">${I.search}<span class="sr-only">${t('pk.f')}</span><input type="search" data-input="q" data-fk="pick-q" placeholder="${esc(t('pk.f'))}" value="${esc(d.q || '')}" autocomplete="off" enterkeyhint="search"></label><div data-region="list">${items}</div>` : items,
          regions: { list: items }, ok: null };
      },
      form: (d) => {
        const p = G.P[d.slug]; const i = issue(d.slug, d.n);
        const here = (v) => (i.sprint === v ? ` <span class="opt__here">${t('rq.here')}</span>` : '');
        const sprintOpts = [['cur', p.cur ? t('rq.cur', { sprint: sprintName(p.cur.n) }) : null], ['next', p.next ? t('rq.next', { sprint: sprintName(p.next.n) }) : t('rq.nextNone')], ['none', t('rq.none')]]
          .filter(([, lbl]) => lbl);
        const radio = (name, v, lbl, checked) => `<label class="opt"><input type="radio" name="${uid}-${name}" value="${v}" data-input="${name}" data-fk="rq-${name}-${v}"${checked ? ' checked' : ''}${d.busy ? ' disabled' : ''}><span>${lbl}</span></label>`;
        const r = { sprint: d.sprint === i.sprint ? null : d.sprint, prio: d.prio };
        const parts = reqParts(d.slug, r);
        const diff = `<p class="rq-diff${parts.length ? ' is-set' : ''}">${parts.length ? t('rq.diff', { list: joinList(parts) }) : t('rq.diffNone')}</p>`;
        const freeze = d.sprint === 'cur' && p.cur && inFreeze(p.cur.demo) ? `<p class="dlg-warn">${I.warn}<span>${t('rq.freeze')}</span></p>` : '';
        const prev = i.req ? `<p class="rq-prev">${'<i class="pend-dot" aria-hidden="true"></i>'}<span>${t('rq.pending', { what: joinList(reqParts(d.slug, i.req)), when: when(i.req.at) })}</span></p>`
          : i.answered ? `<p class="rq-prev rq-prev--answered">${I.chat}<span>${t('rq.answered', { why: tr(i.answered) })}</span></p>` : '';
        return { role: 'dialog', cls: ' cmd-dialog--form', title: `<span class="item__num">#${i.n}</span> ${esc(tr(i.t))}`,
          top: d.fromPick ? `<button type="button" class="btn btn--quiet btn--sm rq-back" data-act="back" data-fk="rq-back">${I.back}<span>${t('rq.back')}</span></button>` : '',
          body: `<p class="rq-now">${t('rq.now', { where: where(d.slug, i) })} · ${t(`rq.kind.${i.kind}`)}</p>${prev}`,
          extra: `<fieldset class="rq-set"><legend class="field__label">${t('rq.sprint')}</legend><div class="opts">${sprintOpts.map(([v, lbl]) => radio('sprint', v, lbl + here(v), d.sprint === v)).join('')}</div>
              <p class="field__hint">${t('rq.sprintHint')}</p><div data-region="freeze">${freeze}</div></fieldset>
            <fieldset class="rq-set"><legend class="field__label">${t('rq.prio')}</legend><div class="segr">${['up', 'keep', 'down'].map((v) => radio('prio', v, t(`rq.${v}`), d.prio === v)).join('')}</div>
              <p class="field__hint">${t('rq.prioHint')}</p></fieldset>
            <div class="rq-sum"><div data-region="diff" aria-live="polite">${diff}</div><p class="adialog__note">${t('rq.owner')}</p></div>`,
          regions: { diff, freeze }, ok: parts.length ? { label: t('rq.ok') } : { label: t('rq.okNone'), off: true } };
      },
      batch: (d) => {
        const items = d.items.map((n) => G.qs.find((q) => q.n === n)).filter(Boolean);
        const out = leftOf(d.scope); const n = d.checked.size;
        const list = `<ul class="ba-list" aria-label="${esc(t('ba.list'))}">${items.map((q) => `<li><label class="ba-item"><input type="checkbox" data-input="pick" value="${q.n}" data-fk="ba-${q.n}"${d.checked.has(q.n) ? ' checked' : ''}${d.busy ? ' disabled' : ''}>
            <span class="ba-item__txt">${d.scope === 'all' ? `<span class="ptag">${mono(q.p)}${q.p}</span>` : ''}<span class="ba-item__t"><span class="item__num">#${q.n}</span> ${esc(tr(q.t))}</span><small>${t('ba.rec', { c: tr(q.c) })}</small></span></label></li>`).join('')}</ul>`;
        const left = out.length ? `<details class="ba-out"><summary>${t('ba.out', { n: out.length })}</summary><ul>${out.map((q) => `<li><span class="item__num">#${q.n}</span> ${esc(tr(q.t))} <span class="ba-why">${t(`ba.why.${outWhy(q)}`)}</span></li>`).join('')}</ul></details>` : '';
        return { role: 'alertdialog', cls: ' cmd-dialog--batch', title: d.scope === 'all' ? t('ba.tAll') : t('ba.t'), body: d.failed ? '' : `<p>${t('ba.b')}</p>`,
          extra: `${list}${d.failed ? '' : left}<p class="adialog__note">${t('ba.owner', { n: n || '…' })}</p>`,
          ok: n ? { label: t('ba.ok', { n }) } : { label: t('ba.okNone'), off: true } };
      },
      snooze: (d) => {
        const opt = (v) => `<label class="opt"><input type="radio" name="${uid}-snz" value="${v}" data-input="snz" data-fk="snz-${v}"${d.opt === v ? ' checked' : ''}${d.busy ? ' disabled' : ''}><span>${t(`sn.${v}`)}</span></label>`;
        return { role: 'dialog', title: t('sn.t', { name: d.slug }), body: `<p>${t('sn.b')}</p>`,
          extra: `<fieldset class="rq-set"><legend class="field__label">${t('sn.when')}</legend><div class="opts">${['hour', 'morning', 'week', 'forever'].map(opt).join('')}</div></fieldset>
            <label class="opt opt--check"><input type="checkbox" data-input="urgent" data-fk="snz-urgent"${d.urgent ? ' checked' : ''} aria-describedby="${uid}-urg"${d.busy ? ' disabled' : ''}><span>${t('sn.urgent')}<small id="${uid}-urg">${t('sn.urgentHint')}</small></span></label>`,
          ok: { label: t('sn.ok') } };
      },
    };
    function dialogHTML() {
      const d = S.dialog; const sp = SPEC[d.type](d);
      const okLabel = !sp.ok ? '' : d.busy ? t('c.sending') : d.error && !sp.ok.off ? t('c.retry') : sp.ok.label;
      const okOff = sp.ok && (d.busy || sp.ok.off);
      const cancel = t('c.cancel');
      return `<div class="modal"><div class="modal__scrim" data-act="dlg-scrim"></div>
        <div class="adialog cmd-dialog${sp.cls || ''}" role="${sp.role}" aria-modal="true" aria-labelledby="${uid}-dt" aria-describedby="${sp.body ? `${uid}-dd` : ''}${d.error ? ` ${uid}-de` : ''}">
          ${sp.top || ''}<h2 id="${uid}-dt" tabindex="-1" data-fk="dlg-h">${sp.title}</h2>
          ${sp.body ? `<div class="cmd-dialog__body" id="${uid}-dd">${sp.body}</div>` : ''}
          ${sp.extra || ''}
          ${d.error ? `<div class="adialog__err" role="alert" id="${uid}-de">${I.warn}<span>${d.error}</span></div>` : ''}
          <div class="adialog__actions" data-region="actions">${actionsHTML(sp, okLabel, okOff, cancel)}</div>
        </div></div>`;
    }
    const actionsHTML = (sp, okLabel, okOff, cancel) => `<button type="button" class="btn" data-act="dlg-cancel" data-fk="dlg-cancel"${dis(S.dialog.busy)}>${cancel}</button>${sp.ok ? `<button type="button" class="btn btn--primary" data-act="dlg-ok" data-fk="dlg-ok"${dis(okOff)}>${S.dialog.busy ? dots : ''}<span>${okLabel}</span></button>` : ''}`;
    // Input changes refresh only the regions that depend on them, so the caret and the native pickers stay put.
    function updateRegions() {
      const d = S.dialog; const sp = SPEC[d.type](d); const m = $('[data-slot=modal]');
      Object.entries(sp.regions || {}).forEach(([k, html]) => { const el = m.querySelector(`[data-region="${k}"]`); if (el) el.innerHTML = html; });
      const date = m.querySelector('[data-input=date]'); if (date) { if (sp.invalid) date.setAttribute('aria-invalid', 'true'); else date.removeAttribute('aria-invalid'); }
      const okLabel = !sp.ok ? '' : d.error && !sp.ok.off ? t('c.retry') : sp.ok.label;
      m.querySelector('[data-region=actions]').innerHTML = actionsHTML(sp, okLabel, sp.ok && sp.ok.off, t('c.cancel'));
    }
    function openDialog(d, focusFk) {
      S.dialog = { busy: false, error: null, ...d };
      const m = $('[data-slot=modal]'); m.innerHTML = dialogHTML();
      setSurfaceDom();
      const box = m.querySelector('.adialog'); const scrim = m.querySelector('.modal__scrim');
      if (isReduced()) { play(box, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') }); play(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') }); }
      else {
        play(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-base'), easing: cssVar('--ease-standard') });
        play(box, mac ? [{ opacity: 0, transform: 'translateY(8px) scale(.98)' }, { opacity: 1, transform: 'none' }] : [{ transform: 'translateY(100%)' }, { transform: 'none' }], { duration: ms(mac ? '--dur-base' : '--dur-slow'), easing: cssVar('--ease-enter') });
      }
      (m.querySelector(`[data-fk="${focusFk || 'dlg-h'}"]`) || m.querySelector('[data-fk=dlg-h]')).focus();
    }
    function redrawDialog(focusFk) {
      const active = focusFk || (document.activeElement && document.activeElement.dataset.fk) || 'dlg-ok';
      const m = $('[data-slot=modal]'); m.innerHTML = dialogHTML();
      (m.querySelector(`[data-fk="${active}"]`) || m.querySelector('[data-fk=dlg-ok]') || m.querySelector('[data-fk=dlg-h]')).focus();
    }
    function closeDialog(focusFk) {
      S.dialog = null; $('[data-slot=modal]').innerHTML = '';
      setSurfaceDom();
      const f = focusFk && host.querySelector(`[data-fk="${focusFk}"]`); if (f) f.focus();
    }
    // The result of a command: a margin note at the top of the panel; Needs you keeps its own; elsewhere a toast.
    function report(d, res) {
      announce(plain([res.verb, res.detail].filter(Boolean).join(' ')));
      const r = { ...res, time: new Date(), isNew: true };
      renderAll(host);
      if (d.from === 'panel' && S.surface === 'commands') { S.result = r; render({ focus: res.focus || 'result' }); return; }
      if (d.from === 'needs') { S.needsResult = r; render({ focus: 'needs-res' }); return; }
      render({ focus: res.focus || d.opener }); toast(plain(res.verb));
    }
    const fail = (d, msg) => { d.busy = false; d.error = msg; redrawDialog('dlg-ok'); };
    async function confirmDialog() {
      const d = S.dialog; if (!d || d.busy) return;
      const sp = SPEC[d.type](d);
      if (!sp.ok || sp.ok.off) { announce(plain(sp.ok ? sp.ok.label : '')); return; }
      d.busy = true; d.error = null; redrawDialog('dlg-ok');
      await wait(900);
      const o = G.outcome; const p = G.P[d.slug] || G.P[SPACE];
      const generic = d.type === 'snooze' ? t('sn.err') : d.type === 'run' ? t('run.err') : t('err.github');
      if (o === 'error' && d.type !== 'batch') return fail(d, generic);
      if (o === 'rate') return fail(d, d.type === 'run' ? t('run.rate', { time: hhmm(at(40)) }) : d.type === 'snooze' ? t('sn.err') : t('err.rate', { time: hhmm(at(15)) }));
      switch (d.type) {
        case 'pause': case 'resume': {
          const toPaused = d.type === 'pause'; closeDialog();
          if (o === 'conflict') { p.state = toPaused ? 'owner' : 'running'; report(d, { tone: 'neutral', verb: t(toPaused ? 'p.conflict' : 'r.conflict', { name: p.slug, time: hhmm(p.pausedAt) }), link: 'log' }); return; }
          p.state = toPaused ? 'owner' : 'running'; p.pausedAt = new Date();
          report(d, { tone: 'positive', verb: t(toPaused ? 'p.done' : 'r.done', { name: p.slug }), link: 'log', focus: d.from === 'panel' ? 'cmd-team' : d.opener });
          return;
        }
        case 'run': {
          closeDialog();
          if (o === 'conflict') { p.run[d.slot] = { state: 'started', at: at(-25) }; report(d, { tone: 'neutral', verb: t('run.overlap', { slot: t(`slot.${d.slot}`), time: hhmm(at(-25)) }), link: 'log' }); return; }
          p.run[d.slot] = { state: 'requested', at: new Date() };
          report(d, { tone: 'positive', verb: t('run.done', { slot: t(`slot.${d.slot}N`) }), detail: t('run.doneDetail'), link: 'log' });
          return;
        }
        case 'demo': {
          if (o === 'conflict') { p.cur = { ...p.cur, demo: addDays(p.cur.demo, 1), custom: true }; d.value = iso(p.cur.demo); renderAll(host); render(); return fail(d, t('md.conflict', { date: dShort(p.cur.demo) })); }
          const v = fromIso(d.value); p.cur = { ...p.cur, demo: v, custom: true }; closeDialog(); S.flip = true;
          report(d, { tone: 'positive', verb: t('md.done', { sprint: sprintName(p.cur.n), date: dShort(v) }), detail: t('md.doneDetail', { range: freezeRange(v) }), focus: d.from === 'panel' ? 'cmd-demo' : d.opener });
          return;
        }
        case 'next': {
          const nn = sprintName(nextNum(p)); const v = fromIso(d.value); closeDialog();
          if (o === 'conflict') { p.next = { n: nextNum(p), demo: addDays(p.cur ? p.cur.demo : day0(), 14) }; if (p.slug === SPACE) G.nextExists = true; syncDemo(); report(d, { tone: 'neutral', verb: t('ns.conflict', { sprint: nn, date: dShort(p.next.demo) }) }); return; }
          if (p.cur) { p.next = { n: nextNum(p), demo: v }; if (p.slug === SPACE) G.nextExists = true; }
          else { p.cur = { n: nextNum(p), demo: v, custom: true }; if (p.slug === SPACE) G.noSprint = false; }
          syncDemo();
          report(d, { tone: 'positive', verb: t('ns.done', { sprint: nn }), detail: p.next ? t('ns.doneDetail', { date: dShort(v), cur: sprintName(p.cur.n) }) : t('ns.doneDetailNow', { date: dShort(v) }) });
          return;
        }
        case 'form': {
          const i = issue(d.slug, d.n);
          if (o === 'conflict' && i.sprint !== 'next') {
            const was = i.sprint; i.sprint = 'next'; if (i.col) i.col = null; renderAll(host); render();
            if (d.sprint === was) d.sprint = 'next';
            return fail(d, t('rq.conflict', { sprint: where(d.slug, i) }));
          }
          i.req = { sprint: d.sprint === i.sprint ? null : d.sprint, prio: d.prio, at: new Date() }; i.answered = null; closeDialog(); S.newChip = i.n;
          const pm = nextOf('pm');
          report(d, { tone: 'positive', verb: t('rq.done', { n: i.n }), detail: t('rq.doneDetail', { when: when(pm) }), link: 'issue', focus: d.from === 'panel' ? 'cmd-ask' : d.opener });
          return;
        }
        case 'batch': {
          const chosen = [...d.checked];
          const bad = o === 'error' ? chosen : o === 'conflict' && chosen.length > 1 && !d.failed ? [chosen[chosen.length - 1]] : [];
          const ok = chosen.filter((n) => !bad.includes(n));
          if (ok.length && d.from === 'needs') await foldOut(ok);
          G.qs = G.qs.filter((q) => !ok.includes(q.n));
          if (bad.length) {
            if (!ok.length) return fail(d, t('err.github'));
            const before = d.okBefore || 0; d.okBefore = before + ok.length;
            d.items = bad; d.checked = new Set(bad); d.failed = true; renderAll(host); render();
            return fail(d, t('ba.partial', { ok: before + ok.length, n: before + chosen.length, bad: bad.length, ids: bad.map((n) => `#${n}`).join(', ') }));
          }
          const total = ok.length + (d.okBefore || 0);
          closeDialog();
          report(d, { tone: 'positive', verb: t('ba.done', { n: total }) });
          return;
        }
        case 'snooze': {
          const until = d.opt === 'hour' ? at(60) : d.opt === 'week' ? (() => { const x = addDays(day0(), 7); x.setHours(9, 0, 0, 0); return x; })() : (() => { const x = addDays(day0(), 1); x.setHours(9, 0, 0, 0); return x; })();
          p.snooze = { until, urgent: d.urgent, forever: d.opt === 'forever' }; closeDialog(); S.newSnooze = p.slug;
          report(d, { tone: 'positive', verb: p.snooze.forever ? t('sn.doneForever', { name: p.slug }) : t('sn.done', { name: p.slug, until: when(until) }), focus: d.from === 'panel' ? 'cmd-snooze' : d.opener });
          return;
        }
        default: closeDialog();
      }
    }
    // Batch approve from Needs you: the approved cards slide off in a short stagger before the list closes up.
    async function foldOut(ns) {
      const els = ns.map((n) => host.querySelector(`[data-q="${n}"]`)).filter(Boolean);
      if (isReduced()) { await Promise.all(els.map((el) => play(el, [{ opacity: 1 }, { opacity: 0 }], { duration: ms('--dur-fade'), fill: 'forwards' }))); return; }
      await Promise.all(els.map((el, i) => play(el, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(16px)' }], { duration: ms('--dur-base'), delay: i * ms('--stagger'), easing: cssVar('--ease-exit'), fill: 'forwards' })));
    }

    /* ----- small actions ----- */
    async function refresh() {
      if (S.refreshing || G.data === 'offline') return;
      S.refreshing = true; render();
      await wait(800);
      S.refreshing = false;
      if (G.data === 'error') { G.data = 'ok'; syncDemo(); }
      G.statusAt = new Date(); renderAll();
      announce(plain(t('st.updated', { time: hhmm(G.statusAt) })));
    }
    function unsnooze(el) {
      const p = G.P[el.dataset.slug]; p.snooze = null;
      const from = el.dataset.from;
      announce(t('sn.back', { name: p.slug }));
      renderAll(host);
      if (from === 'panel' && S.surface === 'commands') { S.result = { tone: 'positive', verb: t('sn.back', { name: p.slug }), time: new Date(), isNew: true }; render({ focus: 'cmd-snooze' }); }
      else { render({ focus: el.dataset.fk }); toast(t('sn.back', { name: p.slug })); }
    }
    function sayWhy(el) {
      const ids = (el.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
      const txt = ids.map((id) => host.querySelector(`[id="${id}"]`)).filter(Boolean).map((n) => n.textContent.trim()).join('. ');
      announce(`${plain(el.getAttribute('aria-label') || el.textContent)}${txt ? `: ${txt}` : ''}`);
      const why = ids.map((id) => host.querySelector(`[id="${id}"]`)).find((n) => n && n.classList.contains('cmd__why'));
      if (why && !isReduced()) play(why, [{ transform: 'translateX(0)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(-2px)' }, { transform: 'none' }], { duration: ms('--dur-base'), easing: cssVar('--ease-standard') });
    }
    function openForm(el) {
      const slug = el.dataset.slug || SPACE; const n = Number(el.dataset.n);
      const base = { type: 'form', slug, n, sprint: issue(slug, n).sprint, prio: 'keep' };
      if (S.dialog && S.dialog.type === 'pick') { const d = S.dialog; S.dialog = { ...d, ...base, fromPick: true, pickQ: d.q, pickOpener: d.opener, error: null }; redrawDialog('dlg-h'); return; }
      openDialog({ ...base, from: el.dataset.from || 'panel', opener: el.dataset.fk, fromPick: false });
    }

    /* ----- events ----- */
    host.onclick = (e) => {
      const el = e.target.closest('[data-act]'); if (!el || !host.contains(el)) return;
      const act = el.dataset.act;
      if (el.tagName === 'A') e.preventDefault();
      if (el.getAttribute('aria-disabled') === 'true') { if (!S.dialog) sayWhy(el); else if (act === 'dlg-ok') confirmDialog(); return; }
      const slug = el.dataset.slug || S.cpSlug;
      const from = el.dataset.from || 'panel';
      const base = { slug, from, opener: el.dataset.fk };
      switch (act) {
        case 'view': if (S.surface === 'board' || !mac) S.surface = null; S.view = el.dataset.view; S.result = null; render({ focus: el.dataset.fk }); break;
        case 'surface-toggle': if (S.surface === el.dataset.surface && S.cpSlug === SPACE) closeSurface(); else openSurface(el.dataset.surface, SPACE, el.dataset.fk); break;
        case 'surface-open': if (S.view !== 'space') S.view = 'space'; openSurface(el.dataset.surface, SPACE, el.dataset.fk); break;
        case 'surface-close': closeSurface(); break;
        case 'commands-for': if (S.surface === 'commands' && S.cpSlug === slug) closeSurface(); else openSurface('commands', slug, el.dataset.fk); break;
        case 'pause': openDialog({ type: 'pause', ...base }); break;
        case 'resume': openDialog({ type: 'resume', ...base }); break;
        case 'run': openDialog({ type: 'run', slot: el.dataset.slot, ...base }); break;
        case 'demo': openDialog({ type: 'demo', ...base, value: iso(G.P[slug].cur.demo), max: G.P[slug].next ? iso(addDays(G.P[slug].next.demo, -1)) : '' }); break;
        case 'next': { const p = G.P[slug]; openDialog({ type: 'next', ...base, value: iso(addDays(p.cur ? p.cur.demo : day0(), 14)), min: iso(addDays(p.cur ? p.cur.demo : day0(), 1)) }); break; }
        case 'pick': openDialog({ type: 'pick', ...base, q: '' }, openIssues(slug).length ? 'pick-q' : 'dlg-h'); break;
        case 'form': openForm(el); break;
        case 'back': { const d = S.dialog; S.dialog = { type: 'pick', slug: d.slug, from: d.from, opener: d.pickOpener, q: d.pickQ || '', busy: false, error: null }; redrawDialog(`pick-${d.n}`); break; }
        case 'batch': { const scope = el.dataset.scope || slug; const items = safeOf(scope).map((q) => q.n); openDialog({ type: 'batch', ...base, scope, items, checked: new Set(items) }); break; }
        case 'snooze': openDialog({ type: 'snooze', ...base, opt: 'morning', urgent: true }); break;
        case 'unsnooze': unsnooze(el); break;
        case 'dlg-cancel': case 'dlg-scrim': if (!S.dialog.busy) closeDialog(S.dialog.opener); break;
        case 'dlg-ok': confirmDialog(); break;
        case 'refresh': refresh(); break;
        case 'runlog': toast(t('demo.runlog')); break;
        case 'issue': toast(t('demo.issue')); break;
        case 'settings': toast(plain(t('demo.settings'))); break;
        case 'push': toast(plain(t('demo.push'))); break;
        case 'elsewhere': toast(t('demo.elsewhere')); break;
        default: break;
      }
    };
    host.oninput = (e) => {
      const d = S.dialog; const k = e.target.dataset.input; if (!d || !k) return;
      if (k === 'date') { d.value = e.target.value; updateRegions(); }
      if (k === 'q') { d.q = e.target.value; updateRegions(); }
    };
    host.onchange = (e) => {
      const d = S.dialog; const k = e.target.dataset.input; if (!d || !k) return;
      if (k === 'sprint') { d.sprint = e.target.value; updateRegions(); }
      if (k === 'prio') { d.prio = e.target.value; updateRegions(); }
      if (k === 'pick') { const n = Number(e.target.value); if (e.target.checked) d.checked.add(n); else d.checked.delete(n); updateRegions(); }
      if (k === 'snz') d.opt = e.target.value;
      if (k === 'urgent') d.urgent = e.target.checked;
    };
    host.onkeydown = (e) => {
      if (S.dialog) {
        if (e.key === 'Escape') { e.preventDefault(); if (!S.dialog.busy) closeDialog(S.dialog.opener); return; }
        if (e.key === 'Enter' && e.target.matches('[data-input=date]')) { e.preventDefault(); confirmDialog(); return; }
        if (e.key === 'Tab') {
          const f = [...host.querySelectorAll('.adialog a[href], .adialog button, .adialog input:not([disabled]), .adialog summary')].filter((x) => x.offsetParent !== null || x.matches('summary'));
          const i = f.indexOf(document.activeElement);
          if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
          else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
        }
        return;
      }
      if (e.key === 'Escape' && S.surface) { e.preventDefault(); closeSurface(); return; }
      const typing = e.target.matches('input, textarea, [contenteditable]');
      if (!mac || typing || e.metaKey || e.ctrlKey || e.altKey) return;
      // Mac: K opens Commands (on All projects, for the focused card), B the board; also on the Russian layout.
      if (e.code === 'KeyK' || /^[kл]$/i.test(e.key)) {
        e.preventDefault();
        const card = e.target.closest && e.target.closest('[data-slug]');
        const slug = S.view === 'all' && card ? card.dataset.slug : SPACE;
        if (S.surface === 'commands' && S.cpSlug === slug) closeSurface(); else openSurface('commands', slug, S.view === 'all' && card ? `all-cmd-${slug}` : 'open-commands');
      }
      if ((e.code === 'KeyB' || /^[bи]$/i.test(e.key)) && S.view === 'space') {
        e.preventDefault(); if (S.surface === 'board') closeSurface(); else openSurface('board', SPACE, 'open-board');
      }
    };

    const app = {
      render, S,
      go: (screen) => {
        if (S.dialog) closeDialog();
        S.result = null; S.needsResult = null;
        if (['demo', 'next', 'pick', 'form', 'snooze', 'batch'].includes(screen) && !loadedish()) G.data = 'ok';
        if (screen === 'demo' && G.noSprint) { G.noSprint = false; applyCalendar(); }
        if (screen === 'next') { G.nextExists = false; applyCalendar(); }
        if (screen === 'snooze') G.P[SPACE].snooze = null;
        if (screen === 'batch' && G.nosafe) G.nosafe = false;
        S.view = screen === 'all' ? 'all' : screen === 'needs' || screen === 'batch' ? 'needs' : 'space';
        S.surface = screen === 'board' ? 'board' : ['space', 'all', 'needs', 'batch'].includes(screen) ? null : 'commands';
        S.cpSlug = SPACE; S.opener = S.surface === 'board' ? 'open-board' : 'open-commands';
        render();
        if (S.surface) host.querySelector('[data-fk=sh-h]').focus();
        const btn = (fk) => host.querySelector(`[data-fk="${fk}"]`);
        if (screen === 'demo') btn('cmd-demo').click();
        if (screen === 'next') btn('cmd-next').click();
        if (screen === 'pick') btn('cmd-ask').click();
        if (screen === 'form') { btn('cmd-ask').click(); host.querySelector('[data-fk="pick-47"]').click(); }
        if (screen === 'snooze') btn('cmd-snooze').click();
        if (screen === 'batch') btn('needs-batch').click();
      },
    };
    host.app = app;
    render();
    return app;
  }

  /* ---------- page controls ---------- */
  const mountAll = (keep) => hosts.forEach((h) => { const prev = keep && h.S ? h.S : null; h.className = 'app'; mountApp(h, h.dataset.app, prev); });
  const pageChrome = Proto.page({ L, title: 'Team Console · #29', onLang: () => mountAll(true) });
  const sel = (id) => document.getElementById(id);
  function syncDemo() {
    sel('d-proj').value = G.P[SPACE].state; sel('d-data').value = G.data; sel('d-outcome').value = G.outcome;
    sel('d-freeze').checked = G.freeze; sel('d-nosprint').checked = G.noSprint; sel('d-next').checked = G.nextExists; sel('d-nosafe').checked = G.nosafe;
  }
  sel('d-proj').addEventListener('change', (e) => { G.P[SPACE].state = e.target.value; G.P[SPACE].pausedAt = at(-13); renderAll(); });
  sel('d-data').addEventListener('change', (e) => { G.data = e.target.value; renderAll(); });
  sel('d-outcome').addEventListener('change', (e) => { G.outcome = e.target.value; });
  sel('d-freeze').addEventListener('change', (e) => { G.freeze = e.target.checked; G.noSprint = false; if (G.P[SPACE].cur) G.P[SPACE].cur.custom = false; applyCalendar(); syncDemo(); renderAll(); });
  sel('d-nosprint').addEventListener('change', (e) => { G.noSprint = e.target.checked; if (e.target.checked) G.freeze = false; applyCalendar(); syncDemo(); renderAll(); });
  sel('d-next').addEventListener('change', (e) => { G.nextExists = e.target.checked; applyCalendar(); renderAll(); });
  sel('d-nosafe').addEventListener('change', (e) => { G.nosafe = e.target.checked; renderAll(); });
  sel('d-screen').addEventListener('change', (e) => { const v = e.target.value; if (!v) return; hosts.forEach((h) => h.app.go(v)); e.target.value = ''; syncDemo(); });
  document.querySelector('[data-reset]').addEventListener('click', () => { Object.assign(G, fresh()); syncDemo(); mountAll(false); });
  mountAll(false);
  syncDemo();
  pageChrome.fit();
})();
