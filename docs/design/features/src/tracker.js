/* #409 Tasks and sprints in the console. Design prototype runtime with mock data only (no network).
   In the app: the board stays `tc-sprint-board` + #108's sections with `tc-lanes` (#134); the row gains a `tc-menu-button`
   (Move); the task screen is a new `tc-item` page (the #114 detail pane on the Mac); pickers and the Move menu are one kit
   `Menu` (popover on the Mac, action sheet on the iPhone); the #107 sheet, #16 card / reason sheet / receipt and #29's
   dialog are reused. Text from the tracker is rendered through esc() only, as the app interpolates it.
   ADR 0006 decision 2: a task is named by its key (TC-410); a pull request reads "PR #415"; an old GitHub number keeps
   its "#" and always says GitHub. */
(() => {
  'use strict';
  const { isReduced, esc, I, play, ms, cssVar, plain } = Proto;
  const L = Proto.i18n(I18N);
  const { t } = L;
  const mon = () => t('months').split('|');
  const day = ([m, d]) => (L.lang === 'ru' ? `${d} ${mon()[m - 1]}` : `${mon()[m - 1]} ${d}`);
  const ordEn = (n) => { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  const ord = (n) => (L.lang === 'ru' ? `${n}` : ordEn(n));
  const NOW = '14:05';
  const TODAY = new Date(2026, 10, 4);
  const CAP = 8;
  const TITLE_MAX = 200; const TEXT_MAX = 5000; // #107's caps

  const svg = (d, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`;
  const IC = {
    dots: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="6" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="18" cy="12" r="1.7" fill="currentColor"/></svg>',
    top: svg('<path d="M6 5h12M12 19V9M7.5 13.5L12 9l4.5 4.5"/>'), up: svg('<path d="M12 19V6M7 11l5-5 5 5"/>'), down: svg('<path d="M12 5v13M7 13l5 5 5-5"/>'),
    cal: svg('<rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>'),
    tray: svg('<path d="M4 13.5L6.5 5h11l2.5 8.5V19H4z"/><path d="M4 13.5h5l1 2h4l1-2h5"/>'),
    here: svg('<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8"/>'),
    lock: I.lock, pen: svg('<path d="M5 19l1-4 9.5-9.5a2.1 2.1 0 013 3L9 18z"/><path d="M14 7l3 3"/>'),
    folder: svg('<path d="M3.5 7.5a2 2 0 012-2h4l2 2h7a2 2 0 012 2V17a2 2 0 01-2 2h-13a2 2 0 01-2-2z"/><path d="M12 10.5v5M9.5 13h5"/>'),
    radio: svg('<circle cx="12" cy="12" r="7"/>'), radioOn: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3" fill="currentColor"/>'),
    note: svg('<path d="M6 4.5h9l3 3v12H6z"/><path d="M9 11h6M9 14.5h6"/>'),
  };
  const BAR1 = 'M5 14h2v6H5z'; const BAR2 = 'M11 9h2v11h-2z'; const BAR3 = 'M17 4h2v16h-2z';
  const TIER_ICON = { light: svg(`<path d="${BAR1}M11 20h2M17 20h2"/>`), standard: svg(`<path d="${BAR1}${BAR2}M17 20h2"/>`), heavy: svg(`<path d="${BAR1}${BAR2}${BAR3}"/>`) };
  const STAMP = (glyph = '<path d="M21 33l8 8 15-17"/>') => `<div class="stamp" aria-hidden="true"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="28"/><circle class="stamp__inner" cx="32" cy="32" r="23"/>${glyph}</svg></div>`;

  /* ---------- mock data: the wireframe's (#413), in the console after the switch ---------- */
  const SPRINTS = () => [
    { id: 's03', name: 'Sprint 03', due: [11, 13] },
    { id: 's04', name: 'Sprint 04', due: [11, 27] },
    { id: 's05', name: 'Sprint 05', due: [12, 11] },
  ];
  // [n, title, kind, status, sprint, tier, untrusted?]
  const TC_SEED = [
    [395, 'Answer not saved on a slow network', 'bug', 'in-progress', 's03', 'standard'],
    [407, 'ADR: the console as the source of truth', 'chore', 'in-progress', 's03', 'heavy'],
    [408, 'Threat model: tracker, role keys, runner', 'chore', 'approved', 's03', 'standard'],
    [192, 'Try again loses focus', 'finding', 'approved', 's03', 'light'],
    [409, 'UX spec: tasks and sprints in the console', 'chore', 'qa', 's03', 'standard'],
    [246, 'PR count doesn’t refresh after a merge', 'finding', 'done', 's03', 'light'],
    [410, 'Own tracker: D1 tables and API', 'feature', 'approved', 's04', 'heavy'],
    [411, 'Runner v0 on the Mac', 'feature', 'approved', 's04', 'heavy'],
    [412, 'Plugin 0.12: backlog on the console API', 'chore', 'approved', 's04', 'heavy'],
    [104, 'Environment setup screen', 'feature', 'approved', 's04', 'standard'],
    [337, 'App size budget', 'chore', 'approved', 's04', 'light'],
    [250, 'Check the webhook signature before parsing', 'finding', 'approved', 's04', 'light'],
    [251, 'Offline banner overlaps the top bar', 'bug', 'approved', 's04', 'light'],
    [253, 'Notes on a task from the phone', 'feature', 'proposed', 's04', 'standard'],
    [107, 'Quick task from the phone', 'feature', 'approved', 's05', 'standard'],
    [108, 'Board by sprint', 'feature', 'approved', 's05', 'standard'],
    [17, 'Chat with the PM', 'feature', 'proposed', null, null],
    [345, 'Stamp sound on approval', 'wow', 'proposed', null, null],
    [366, 'Empty Artifacts screen flickers', 'finding', 'proposed', null, 'light'],
    [388, 'Follow someone else’s repository', 'feature', 'proposed', null, null, true],
  ];
  const ST_SEED = [
    [31, 'Chapter outline editor', 'feature', 'in-progress', 's03', 'standard'],
    [36, 'Export to EPUB', 'feature', 'approved', 's03', 'heavy'],
    [40, 'Word count off by one', 'bug', 'qa', 's03', 'light'],
    [29, 'Autosave every 30 seconds', 'feature', 'done', 's03', 'standard'],
    [44, 'Reader mode', 'feature', 'approved', 's04', 'standard'],
    [12, 'Cover image upload', 'feature', 'proposed', null, null],
  ];
  const CLOSED = [{ n: 142, t: 'Question cards: design preview', k: 'feature', s: 'done', sp: null, closed: true }];
  const mk = ([n, title, k, s, sp, tier, untr]) => ({ n, t: title, k, s, sp, tier, untrusted: !!untr, closed: false });
  function project(slug) {
    if (slug === 'st') return { slug: 'storify', prefix: 'ST', items: ST_SEED.map(mk), sprints: SPRINTS().slice(0, 2), open: { s04: false, backlog: false }, lane: {}, next: 425, switched: false };
    const p = { slug: 'team-console', prefix: 'TC', items: TC_SEED.map(mk), sprints: SPRINTS(), open: { s04: true, s05: false, backlog: false }, lane: {}, next: 413, switched: true };
    if (G.nofuture) { p.sprints = p.sprints.slice(0, 1); p.items.forEach((i) => { if (i.sp && i.sp !== 's03') i.sp = null; }); }
    return p;
  }
  const LANES = ['proposed', 'approved', 'in-progress', 'qa', 'blocked', 'done'];
  const CORE = ['approved', 'in-progress', 'qa', 'done'];
  const VARIANT_N = { progress: 395, decision: 345, closed: 366, untrusted: 388 };

  // History and text per task; a task without an entry shows the import line only.
  const EXTRA = {
    395: { body: 'item.body.395', labels: ['mobile', 'network'], from: ['pm', [10, 28]], hist: [
      { who: 'console', at: [10, 28], ev: ['item.ev.imported', { n: 395 }] },
      { who: 'pm', at: [10, 29], ev: ['item.ev.status', { from: 'proposed', to: 'approved' }] },
      { who: 'dev', at: [11, 3], time: '10:12', text: 'item.c.395a' },
      { who: 'dev', at: [11, 4], time: '11:40', ev: ['item.ev.pr', { pr: 'PR #414', branch: 'feature/tc-395-answer-retry' }] },
      { who: 'dev', at: [11, 4], time: '11:42', text: 'item.c.395b' },
    ], earlier: 4 },
    345: { body: 'item.body.345', labels: ['demo'], from: ['pm', [10, 20]], hist: [
      { who: 'console', at: [10, 20], ev: ['item.ev.imported', { n: 345 }] },
      { who: 'pm', at: [11, 2], time: '09:30', text: 'item.c.345a' },
    ], earlier: 1, decision: true },
    366: { body: 'item.body.366', labels: [], from: ['dev', [10, 24]], closed: true, hist: [
      { who: 'console', at: [10, 24], ev: ['item.ev.imported', { n: 366 }] },
      { who: 'dev', at: [11, 1], time: '16:20', text: 'item.c.366a' },
      { who: 'pm', at: [11, 1], time: '16:31', ev: ['item.ev.closed', {}] },
    ], earlier: 0 },
    388: { body: 'item.body.388', labels: ['external'], from: ['octo-visitor', [11, 2]], hist: [
      { who: 'console', at: [11, 2], ev: ['item.ev.imported', { n: 388 }] },
      { who: 'octo-visitor', untrusted: true, at: [11, 2], time: '08:02', text: 'item.c.388a' },
    ], earlier: 0 },
  };

  /* ---------- demo state (page-wide) ---------- */
  const G = { screen: 'board', data: 'loaded', variant: 'progress', write: 'ok', imp: 'banner', freeze: false, nofuture: false, draft: false };
  const hosts = [...document.querySelectorAll('[data-app]')];

  function mountApp(host, kind) {
    const phone = kind === 'phone';
    const uid = `${kind}-${Math.random().toString(36).slice(2, 6)}`;
    const S = host.S = { view: 'board', proj: 'tc', P: { tc: project('tc'), st: project('st') }, menu: null, toast: null, fail: null, tk: null, sd: null, nt: null, modal: null, find: { q: '', state: 'idle' }, imp: 'banner', pending: null, isNew: {} };
    const P = () => S.P[S.proj];
    const key = (n, p = P()) => `${p.prefix}-${n}`;
    const itemOf = (n, p = P()) => p.items.find((x) => x.n === n);
    const sprintOf = (id, p = P()) => p.sprints.find((s) => s.id === id);
    const curId = (p = P()) => p.sprints[0]?.id;
    const whereName = (id) => (id ? sprintOf(id).name : t('board.sections.backlog'));
    const peersOf = (i, p = P()) => p.items.filter((x) => x.sp === i.sp && x.s === i.s && !x.closed);
    const openCount = (id, p = P()) => p.items.filter((x) => x.sp === id && x.s !== 'done' && !x.closed).length;
    const offline = () => G.data === 'stale';
    const STALE_ID = `${uid}-stale`;
    const offAttr = () => (offline() ? ` aria-disabled="true" aria-describedby="${STALE_ID}"` : '');

    /* ----- shell: static frame, then main / overlay / toast slots so the Undo slip survives re-renders ----- */
    if (phone) {
      host.innerHTML = `<div class="p-status" aria-hidden="true"><span>9:41</span><span class="p-island"></span><span class="p-status__icons">${I.bars}${I.battery}</span></div>
        <div class="p-body" data-slot="main"></div><div data-slot="ov"></div><div data-slot="toast"></div>
        <div class="home-ind" aria-hidden="true"></div><div class="sr-only" aria-live="polite" data-live></div><div class="sr-only" aria-live="assertive" data-alert></div>`;
    } else {
      host.innerHTML = `<div class="win"><div class="win__bar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="win__title">Team Console</span></div>
        <div class="win__body" data-slot="main"></div></div><div data-slot="ov"></div><div data-slot="toast"></div>
        <div class="sr-only" aria-live="polite" data-live></div>`;
    }
    const $ = (s) => host.querySelector(s);
    const say = (msg) => { const l = $('[data-live]'); l.textContent = ''; setTimeout(() => { l.textContent = plain(msg); }, 60); };
    const focusFk = (fk) => { const el = fk && host.querySelector(`[data-fk="${fk}"]`); if (el) { el.focus({ preventScroll: false }); return true; } return false; };

    /* ================= board ================= */
    const tierHTML = (tier) => (tier ? `<span class="tier-ico tier-ico--${tier}">${TIER_ICON[tier]}<span class="sr-only">, ${t('board.tierLabel')} ${t(`board.tier.${tier}`)}</span></span>` : '<span></span>');
    function rowHTML(i, idx, p) {
      const sub = [`<span class="kind"><span class="sr-only">, </span>${t(`board.kind.${i.k}`)}</span>`];
      if (i.untrusted) sub.push(`<span class="chip-untr"><span class="sr-only">, </span>${t('board.untrusted')}</span>`);
      const main = `<span class="bd-row__main"><span class="bd-row__title">${esc(i.t)}</span><span class="bd-row__sub">${sub.join('')}</span></span>${tierHTML(i.tier)}`;
      if (!p.switched) return `<li style="--i:${idx}"><a class="bd-row" href="#github" data-act="gh"><span class="bd-row__num">#${i.n}</span>${main}</a></li>`;
      const cur = S.view === 'task' && S.tk && S.tk.n === i.n && !phone;
      const landed = S.isNew.landed === i.n ? ' is-landed' : '';
      const open = !!(S.menu && S.menu.type === "move" && S.menu.n === i.n);
      return `<li class="mv-li${cur ? ' is-current' : ''}${landed}" style="--i:${idx}" data-row="${i.n}"><a class="bd-row" href="#t/${i.n}" data-act="open" data-n="${i.n}" data-fk="row-${i.n}"${cur ? ' aria-current="true"' : ''}><span class="bd-row__key">${key(i.n, p)}</span>${main}</a>`
        + `<button type="button" class="mv" data-act="menu" data-n="${i.n}" data-fk="mv-${i.n}" aria-haspopup="menu" aria-expanded="${open}" aria-label="${esc(plain(t('plan.moveAria', { key: key(i.n, p), title: i.t })))}"${offAttr()}>${IC.dots}</button></li>`;
    }
    function lanesHTML(sec, list, core, label, p) {
      const by = new Map(core.map((s) => [s, []]));
      list.forEach((x) => { if (!by.has(x.s)) by.set(x.s, []); by.get(x.s).push(x); });
      const lanes = [...by.entries()].sort(([a], [b]) => LANES.indexOf(a) - LANES.indexOf(b));
      const laneList = (items) => (items.length ? `<ul class="bd-list">${items.map((x, j) => rowHTML(x, j, p)).join('')}</ul>` : `<p class="bd-empty">${I.check}<span>${t('board.laneEmpty')}</span></p>`);
      const aria = esc(plain(t('board.lanes', { section: label })));
      if (!phone || lanes.length < 2) {
        return `<div class="bd-lanes" role="group" aria-label="${aria}">${lanes.map(([s, items]) => `<div class="bd-lane" role="group" aria-labelledby="${uid}-${sec}-${s}-h"><div class="bd-lane__head" role="heading" aria-level="3" id="${uid}-${sec}-${s}-h" tabindex="-1" data-fk="lh-${sec}-${s}">${t(`board.status.${s}`)} <span class="bd-lane__count">${items.length}</span></div>${laneList(items)}</div>`).join('')}</div>`;
      }
      const keep = p.lane[sec];
      const sel = lanes.some(([s]) => s === keep) ? keep : (lanes.find(([, v]) => v.length) || lanes[0])[0];
      const tabs = lanes.map(([s, items]) => { const on = s === sel; const b = `${uid}-${sec}-${s}`; return `<button type="button" role="tab" class="lt" id="${b}-tab" aria-controls="${b}-panel" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-lane="${sec}|${s}" data-fk="lh-${sec}-${s}"><span class="lt__name">${t(`board.status.${s}`)}</span> <span class="lt__count">${items.length}</span></button>`; }).join('');
      const panels = lanes.map(([s, items]) => { const b = `${uid}-${sec}-${s}`; return `<div class="bd-panel" role="tabpanel" id="${b}-panel" aria-labelledby="${b}-tab"${s === sel ? '' : ' hidden'}>${laneList(items)}</div>`; }).join('');
      return `<div class="bd-lanes bd-lanes--tabs"><div class="lt-list" role="tablist" aria-label="${aria}">${tabs}</div>${panels}</div>`;
    }
    function failHTML(sec) {
      const f = S.fail; if (!f || f.sec !== sec) return '';
      const retry = ['network', 'timeout'].includes(f.code) ? `<div class="wblk__acts"><button type="button" class="btn" data-act="move-retry" data-fk="move-retry">${I.refresh}${t('ui.retry')}</button></div>` : '';
      return `<div class="wblk wblk--bad mv-fail is-new" role="alert" tabindex="-1" data-fk="move-fail"><h3>${I.warn}<span>${t('plan.failed', { key: key(f.n) })} · ${t(`err.${f.code}.t`)}</span></h3><p>${t(`err.${f.code}.b`)}</p>${retry}</div>`;
    }
    const createBtn = (cls = 'btn btn--sm') => `<button type="button" class="${cls}" data-act="sprint-new" data-fk="sprint-new"${offAttr()}>${I.plus}<span>${t('sprint.create')}</span></button>`;
    function currentHTML(p) {
      const s = p.sprints[0]; const hid = `${uid}-h-${s.id}`;
      const list = p.items.filter((x) => x.sp === s.id && !x.closed);
      const freeze = G.freeze && p.switched ? `<span class="sx-meta__sep" aria-hidden="true">·</span><span class="sx-freeze">${IC.lock}${t('board.freeze')}</span>` : '';
      return `<section class="sx" aria-labelledby="${hid}"><div class="sx-head"><div class="sx-head__text"><h2 class="sx-title" id="${hid}" tabindex="-1" data-fk="sec-${s.id}"><span class="sx-kicker">${t('board.sections.current')}</span><span class="sx-name">${esc(s.name)}</span></h2>
        <p class="sx-meta">${IC.cal}<span>${t('board.demo', { date: day(s.due) })}</span>${freeze}<span class="sx-meta__sep" aria-hidden="true">·</span><span>${t('board.sections.open', { n: openCount(s.id, p) })}</span></p></div>
        <button type="button" class="btn btn--sm">${t('board.moveDemo')}</button></div>${failHTML(s.id)}${lanesHTML(s.id, list, CORE, s.name, p)}</section>`;
    }
    function folderHTML(sec, idx, p) {
      const isB = sec === 'backlog'; const s = isB ? null : sprintOf(sec, p);
      const hid = `${uid}-h-${sec}`; const bodyId = `${uid}-b-${sec}`;
      const open = !!p.open[sec];
      const list = p.items.filter((x) => x.sp === (isB ? null : sec) && !x.closed);
      const kicker = isB ? t('board.sections.backlog') : idx === 1 ? t('board.sections.next') : t('board.sections.later');
      const name = isB ? t('board.sections.backlogTitle') : esc(s.name);
      const meta = [];
      if (!isB) meta.push(`${IC.cal}<span>${t('board.demo', { date: day(s.due) })}</span>`);
      if (open) meta.push(`<span>${t('board.sections.open', { n: list.filter((x) => x.s !== 'done').length })}</span>`);
      const label = plain(t(open ? 'board.sections.hideAria' : 'board.sections.showAria', { section: isB ? t('board.sections.backlog') : s.name }));
      let inner = '';
      if (open) {
        if (!list.length) {
          inner = isB ? `<div class="sx-state sx-state--empty">${I.check}<p class="sx-state__t">${t('board.sections.backlog.emptyTitle')}</p><p class="sx-state__h">${t('board.sections.backlog.emptyHint')}</p></div>`
            : `<div class="sx-state sx-state--empty">${IC.tray}<p class="sx-state__t">${t('board.sections.next.emptyTitle', { sprint: s.name })}</p><p class="sx-state__h">${t('board.sections.next.emptyHint')}</p></div>`;
        } else inner = lanesHTML(sec, list, [], isB ? t('board.sections.backlog') : s.name, p);
      }
      const target = S.isNew.target === sec ? ' is-target' : '';
      return `<section class="sx sx--folder${open ? ' is-open' : ''}${target}" aria-labelledby="${hid}"><div class="sx-head"><div class="sx-head__text"><h2 class="sx-title" id="${hid}" tabindex="-1" data-fk="sec-${sec}"><span class="sx-kicker">${kicker}</span><span class="sx-name">${name}</span></h2>${meta.length ? `<p class="sx-meta">${meta.join('<span class="sx-meta__sep" aria-hidden="true">·</span>')}</p>` : ''}</div>
        <button type="button" class="btn btn--sm sx-toggle" data-act="toggle" data-sec="${sec}" data-fk="tg-${sec}" aria-expanded="${open}" aria-controls="${bodyId}" aria-label="${esc(label)}">${t(open ? 'board.sections.hide' : 'board.sections.show')}${I.down}</button></div>
        ${open ? `<div class="sx-body" id="${bodyId}">${failHTML(sec)}${inner}</div>` : `<div id="${bodyId}" hidden></div>`}</section>`;
    }
    function boardHTML() {
      const p = P();
      if (G.data === 'loading') return `<div class="bd" aria-busy="true"><p class="sx-busy"><span class="ring" aria-hidden="true"></span>${t('board.loading')}</p><ul class="bd-list" aria-hidden="true">${'<li><div class="skel-row"><span class="skel skel--num"></span><span class="skel-stack"><span class="skel skel--c"></span><span class="skel skel--d"></span></span><span class="skel skel--tier"></span></div></li>'.repeat(5)}</ul></div>`;
      if (G.data === 'error') return `<div class="bd"><div class="sx-state sx-state--error" role="alert">${I.warn}<p class="sx-state__t">${t('board.error.title')}</p><p class="sx-state__h">${t('board.error.hint')}</p><div class="sx-state__act"><button type="button" class="btn btn--sm" data-act="reload" data-fk="reload">${I.refresh}${t('ui.retry')}</button></div></div></div>`;
      if (G.data === 'offline') return `<div class="bd"><div class="sx-state sx-state--offline">${I.wifi}<p class="sx-state__t">${t('board.offline.title')}</p><p class="sx-state__h">${t('board.offline.hint')}</p><div class="sx-state__act"><button type="button" class="btn btn--sm" data-act="reload" data-fk="reload">${I.refresh}${t('ui.retry')}</button></div></div></div>`;
      if (G.data === 'empty' && p.switched) return `<div class="bd"><div class="block"><h2>${t('board.empty.title')}</h2><p>${t('board.empty.hint')}</p><button type="button" class="btn btn--primary btn--tall" data-act="new" data-fk="empty-new">${I.plus}${t('nav.new')}</button></div></div>`;
      const parts = [];
      if (!p.switched) parts.push(`<div class="imp-banner"><p>${t('imp.banner', { name: p.slug })}</p><button type="button" class="btn btn--primary" data-act="imp-start" data-fk="imp-start">${t('imp.bannerGo')}</button></div>`);
      if (offline() && p.switched) parts.push(`<p class="stale" id="${STALE_ID}">${I.wifi}<span>${t('board.stale', { time: '13:58' })}</span></p>`);
      parts.push(currentHTML(p));
      const fut = p.sprints.slice(1);
      if (!fut.length) {
        const hid = `${uid}-h-none`;
        parts.push(`<section class="sx sx--folder" aria-labelledby="${hid}"><div class="sx-head"><div class="sx-head__text"><h2 class="sx-title" id="${hid}"><span class="sx-kicker">${t('board.sections.next')}</span><span class="sx-name">${t('board.sections.next.none')}</span></h2></div>${p.switched ? createBtn('btn btn--sm sx-toggle') : ''}</div></section>`);
      } else fut.forEach((s, i) => parts.push(folderHTML(s.id, i + 1, p)));
      if (fut.length && p.switched) parts.push(`<div class="sx-ghost"><span>${t('board.ghost')}</span>${createBtn()}</div>`);
      parts.push(folderHTML('backlog', 0, p));
      parts.push(`<div class="bd-tail"><div class="bd-lane__head" role="heading" aria-level="2">${t('board.pulls')} <span class="bd-lane__count">2</span></div><div class="bd-tail__line"><span>PR #415 · PR #414</span><span>${p.prefix}-410 · ${p.prefix}-395</span></div></div>`);
      return `<div class="bd">${parts.join('')}</div>`;
    }

    /* ================= the task screen ================= */
    function freshTask(n) {
      const ex = EXTRA[n] || {};
      const i = itemOf(n);
      const tk = { n, edit: false, title: i ? i.t : '', body: ex.body ? t(ex.body) : '', err: null, theirs: false, busy: null, dec: ex.decision ? 'waiting' : null, comment: '', hist: [], fieldErr: null, changed: null, draft: false };
      if (G.draft && i) { tk.edit = true; tk.draft = true; tk.title = `${i.t} (iPhone)`; }
      return tk;
    }
    const whoName = (w) => (['you', 'pm', 'dev', 'architect', 'console'].includes(w) ? t(`item.who.${w}`) : esc(w));
    function evHTML(e, isNew) {
      const when = `${day(e.at)}${e.time ? `, ${e.time}` : ''}`;
      const untr = e.untrusted ? ` <span class="chip-untr">${t('board.untrusted')}</span>` : '';
      let what = '';
      if (e.text) what = `<p class="ev-text">${esc(e.raw ? e.text : t(e.text))}</p>`;
      else {
        const [k, v] = e.ev; const vv = { ...v };
        if (k === 'item.ev.status') { vv.from = t(`board.status.${v.from}`); vv.to = t(`board.status.${v.to}`); }
        if (k === 'item.ev.kind') { vv.from = t(`board.kind.${v.from}`); vv.to = t(`board.kind.${v.to}`); }
        if (k === 'item.ev.sprint') { vv.from = whereName(v.from); vv.to = whereName(v.to); }
        let txt = t(k, vv);
        if (k === 'item.ev.pr') txt = txt.replace(esc(v.branch), `<code>${esc(v.branch)}</code>`);
        what = `<p class="ev-what">${txt}</p>`;
      }
      const cls = [e.who === 'you' ? 'ev--you' : '', e.decision ? 'ev--decision' : '', e.negative ? 'ev--negative' : '', isNew ? 'is-new' : ''].filter(Boolean).join(' ');
      return `<li${cls ? ` class="${cls}"` : ''}><span class="ev-who"><b>${whoName(e.who)}</b>${untr}<span>${when}</span></span>${what}</li>`;
    }
    const statusOf = (i) => (i.closed ? 'closed' : i.s);
    function errBlock(tk) {
      const e = tk.err; if (!e) return '';
      const code = e.code;
      if (code === 'conflict') {
        return `<div class="wblk wblk--warn is-new" role="alert" tabindex="-1" data-fk="err-blk"><h2>${I.warn}<span>${t('err.conflict.t')}</span></h2><p>${t('err.conflict.b', { time: '14:03' })}</p>
          <div class="wblk__acts"><button type="button" class="btn" data-act="theirs" data-fk="theirs" aria-expanded="${tk.theirs}">${t(tk.theirs ? 'err.conflict.hide' : 'err.conflict.see')}</button><button type="button" class="btn btn--primary" data-act="mine" data-fk="mine">${t('err.conflict.mine')}</button></div></div>`;
      }
      if (code === 'gone') return `<div class="wblk wblk--warn is-new" role="alert" tabindex="-1" data-fk="err-blk"><h2>${I.warn}<span>${t('err.gone.t')}</span></h2><p>${t('err.gone.b')}</p><div class="wblk__acts"><button type="button" class="btn" data-act="refresh" data-fk="refresh">${I.refresh}${t('err.refresh')}</button></div></div>`;
      const retry = ['network', 'timeout'].includes(code) ? `<div class="wblk__acts"><button type="button" class="btn" data-act="retry" data-fk="retry">${I.refresh}${t('ui.retry')}</button></div>` : '';
      return `<div class="wblk wblk--bad is-new" role="alert" tabindex="-1" data-fk="err-blk"><h2>${I.warn}<span>${t(`err.${code}.t`)}</span></h2><p>${t(`err.${code}.b`)}</p>${retry}</div>`;
    }
    const pickBtn = (field, value, fk, extra = '') => `<button type="button" class="pick${S.tk.changed === field ? ' is-changed' : ''}" data-act="pick" data-field="${field}" data-fk="${fk}" aria-haspopup="menu" aria-expanded="${!!(S.menu && S.menu.field === field)}" aria-label="${esc(plain(t('item.pickerAria', { field: t(`item.${field}`), value: plain(value) })))}"${offAttr()}>${extra}<span>${value}</span>${I.down}</button>`;
    function taskHTML() {
      const tk = S.tk; const p = P();
      if (G.data === 'loading') return `<div class="tk" aria-busy="true"><p class="sx-busy"><span class="ring" aria-hidden="true"></span>${t('item.loading')}</p><div class="tk-skel" aria-hidden="true"><span class="skel skel--s"></span><span class="skel skel--h"></span>${'<span class="skel skel--l"></span>'.repeat(5)}<span class="skel skel--s"></span></div></div>`;
      if (G.data === 'error') return `<div class="tk"><div class="wblk wblk--bad" role="alert"><h2>${I.warn}<span>${t('item.error.title')}</span></h2><p>${t('item.error.hint')}</p><div class="wblk__acts"><button type="button" class="btn" data-act="reload" data-fk="reload">${I.refresh}${t('ui.retry')}</button></div></div></div>`;
      if (G.data === 'offline') return `<div class="tk"><div class="wblk wblk--quiet"><h2>${I.wifi}<span>${t('item.offlineNever.title')}</span></h2><p>${t('item.offlineNever.hint')}</p><div class="wblk__acts"><button type="button" class="btn" data-act="reload" data-fk="reload">${I.refresh}${t('ui.retry')}</button></div></div></div>`;
      const i = itemOf(tk.n);
      if (G.data === 'notfound' || !i) {
        return `<div class="tk"><div class="block"><h1 class="tk-title" tabindex="-1" data-fk="h1">${t('item.notFound.title', { key: key(999), name: p.slug })}</h1><p>${t('item.notFound.hint')}</p><div class="form-actions"><button type="button" class="btn btn--primary btn--tall" data-act="find" data-fk="nf-find">${I.search}${t('nav.find')}</button><button type="button" class="btn btn--tall" data-act="board" data-fk="nf-board">${t('nav.back')}</button></div></div></div>`;
      }
      const ex = EXTRA[i.n] || { hist: [{ who: 'console', at: [10, 30], ev: ['item.ev.imported', { n: i.n }] }], labels: [], from: ['pm', [10, 30]], earlier: 0 };
      const isNewTask = i.n >= 413;
      const busy = tk.busy;
      const parts = [];
      if (offline()) parts.push(`<p class="stale" id="${STALE_ID}">${I.wifi}<span>${t('item.offline', { time: '13:58' })}</span></p>`);
      parts.push(errBlock(tk));
      // head
      const tag = `<p class="tk-tag"><span class="key">${key(i.n)}</span><span aria-hidden="true">·</span><span class="kind">${t(`board.kind.${i.k}`)}</span>${i.untrusted ? `<span class="chip-untr">${t('board.untrusted')}</span>` : ''}</p>`;
      if (!tk.edit) {
        parts.push(`<div class="tk-head">${tag}<h1 class="tk-title" tabindex="-1" data-fk="h1">${esc(i.t)}</h1><div class="tk-head__acts"><button type="button" class="btn" data-act="edit" data-fk="edit" aria-label="${esc(t('item.editAria'))}"${offAttr()}>${IC.pen}${t('item.edit')}</button></div></div>`);
      } else {
        const over = tk.title.length > TITLE_MAX; const bodyErr = tk.fieldErr === 'body';
        const cnt = (n, max, id) => (n >= max * 0.8 ? `<span class="fld__count" id="${id}">${t('item.counter', { n, max })}</span>` : '');
        const ro = busy === 'save' ? ' readonly' : '';
        parts.push(`<div class="tk-head">${tag}<h1 class="sr-only" tabindex="-1" data-fk="h1">${esc(i.t)}</h1>
          ${tk.draft ? `<div class="tdraft"><p>${t('item.draft', { time: '13:52' })}</p><button type="button" class="link-btn" data-act="draft-drop" data-fk="draft-drop">${t('item.draftDrop')}</button></div>` : ''}
          <form class="tk-edit" data-form="edit" novalidate${busy === 'save' ? ' aria-busy="true"' : ''}>
            <div class="fld"><div class="fld__row"><label class="fld__label" for="${uid}-et">${t('item.title')}</label>${cnt(tk.title.length, TITLE_MAX, `${uid}-etc`)}</div>
              ${over ? `<p class="fld__err" id="${uid}-ete">${I.warn}<span>${t('item.tooLong', { max: TITLE_MAX, n: tk.title.length - TITLE_MAX })}</span></p>` : ''}
              <input class="fld-input fld-input--title" id="${uid}-et" data-fk="e-title" data-bind="title" value="${esc(tk.title)}" autocomplete="off"${over ? ` aria-invalid="true" aria-describedby="${uid}-ete"` : ''}${ro}></div>
            <div class="fld"><div class="fld__row"><label class="fld__label" for="${uid}-eb">${t('item.details')}</label>${cnt(tk.body.length, TEXT_MAX, `${uid}-ebc`)}</div>
              ${bodyErr ? `<p class="fld__err" id="${uid}-ebe">${I.warn}<span>${t('err.invalid.b')}</span></p>` : ''}
              <textarea class="fld-input" id="${uid}-eb" rows="6" data-fk="e-body" data-bind="body"${bodyErr ? ` aria-invalid="true" aria-describedby="${uid}-ebe"` : ''}${ro}>${esc(tk.body)}</textarea>
              ${tk.theirs ? `<div class="theirs" role="region" aria-label="${esc(t('err.theirs', { time: '14:03' }))}"><b>${t('err.theirs', { time: '14:03' })}</b><p>${esc(t('item.body.theirs'))}</p></div>` : ''}</div>
            <div class="form-actions"><button type="submit" class="btn btn--primary${busy === 'save' ? ' is-busy' : ''}" data-fk="e-save">${busy === 'save' ? `${Proto.dots}${t('item.saving')}` : `${t('item.save')}<kbd>⌘↩</kbd>`}</button><button type="button" class="btn" data-act="edit-cancel" data-fk="e-cancel">${t('item.cancel')}</button></div>
          </form></div>`);
      }
      if (i.closed) parts.push(`<div class="wblk wblk--quiet"><h2>${I.archive}<span>${t('item.closedNote')}</span></h2><div class="wblk__acts"><button type="button" class="btn" data-act="reopen" data-fk="reopen"${offAttr()}>${t('item.reopen')}</button></div></div>`);
      // the decision card (#16) or its receipt
      if (tk.dec === 'waiting') {
        const decBusy = busy === 'approve' || busy === 'reject';
        parts.push(`<section class="card" aria-labelledby="${uid}-dq"><div class="card__head"><span class="card__kind">${I.q}${t('dec.h')}</span><span class="card__num">${key(i.n)}</span></div>
          <h2 class="card__title" id="${uid}-dq">${t('dec.q')}</h2><div class="rec"><span class="rec__label">${t('dec.recommends')}</span><span class="rec__choice">${t('dec.choice')}</span></div>
          <div class="card__foot">${decBusy ? `<span class="card__meta">${Proto.dots} ${t('dec.busy', { key: key(i.n) })}</span>` : `<div class="card__actions"><button type="button" class="btn btn--primary" data-act="approve" data-fk="approve"${offAttr()}>${I.check}${t('dec.approve')}</button><button type="button" class="btn" data-act="reject" data-fk="reject"${offAttr()}>${t('dec.reject')}</button></div>`}</div></section>`);
      } else if (tk.dec === 'approved' || tk.dec === 'rejected') {
        const neg = tk.dec === 'rejected';
        parts.push(`<div class="receipt${neg ? ' receipt--negative' : ''}${S.isNew.receipt ? ' is-new' : ''}"><span class="receipt__icon">${neg ? I.x : I.check}</span><div class="receipt__body"><h2 class="receipt__verb" tabindex="-1" data-fk="receipt">${t(neg ? 'dec.done.reject' : 'dec.done.approve')}</h2> <span class="receipt__meta">${t('dec.doneMeta', { key: key(i.n), time: NOW })}</span></div>${STAMP(neg ? '<path d="M24 24l16 16M40 24L24 40"/>' : undefined).replace('class="stamp"', `class="stamp${neg ? ' stamp--negative' : ''}" data-stamp`)}</div>`);
      }
      // the field ledger
      const st = statusOf(i);
      const peers = peersOf(i); const pos = peers.indexOf(i) + 1;
      const sprintVal = i.sp ? (i.sp === curId() ? plain(t('plan.toCurrent', { sprint: sprintOf(i.sp).name })).replace(/^(В|To) /, '') : sprintOf(i.sp).name) : t('item.noSprint');
      const from = ex.from;
      const fromLine = `${whoName(from[0])} · ${day(from[1])}`;
      const gh = isNewTask ? '' : `<a class="ext" href="#github" data-act="gh" data-fk="gh" aria-label="${esc(t('item.githubAria', { n: i.n }))}">${t('item.github', { n: i.n })}${I.ext}</a>`;
      parts.push(`<dl class="ledger">
        <div><dt>${t('item.status')}</dt><dd>${pickBtn('status', t(`board.status.${st}`), 'pk-status', `<i class="sdot2 sdot2--${st}" aria-hidden="true"></i>`)}</dd></div>
        <div><dt>${t('item.kind')}</dt><dd>${pickBtn('kind', t(`board.kind.${i.k}`), 'pk-kind')}</dd></div>
        <div><dt>${t('item.sprint')}</dt><dd>${pickBtn('sprint', esc(sprintVal), 'pk-sprint')}</dd></div>
        <div><dt>${t('item.queue')}</dt><dd>${i.closed ? `<span>${t('item.noQueue')}</span>` : `<span>${t('item.queueVal', { pos: ord(pos), total: peers.length, lane: t(`board.status.${i.s}`) })}</span>`}</dd></div>
        <div><dt>${t('item.tier')}</dt><dd>${i.tier ? `${tierHTML(i.tier)}<span>${t(`board.tier.${i.tier}`)}</span>` : '<span>—</span>'}<small>${t('item.tierHint')}</small></dd></div>
        <div><dt>${t('item.flags')}</dt><dd>${(ex.labels || []).length ? ex.labels.map((l) => `<span class="lbl-chip">${esc(l)}</span>`).join('') : '<span>—</span>'}</dd></div>
        <div><dt>${t('item.from')}</dt><dd><span>${fromLine}</span>${i.untrusted ? `<span class="chip-untr">${t('board.untrusted')}</span>` : ''}${gh}</dd></div>
      </dl>`);
      if (!tk.edit) {
        parts.push(`<section class="tk-sec" aria-labelledby="${uid}-hd"><h2 class="tk-h2" id="${uid}-hd">${t('item.details')}</h2>${tk.body ? `<p class="tk-body">${esc(tk.body)}</p>` : `<p class="tk-body tk-body--none">${t('item.noDetails')}</p>`}</section>`);
      }
      // history and the comment box
      const hist = [...(isNewTask ? [{ who: 'you', at: [11, 4], time: NOW, ev: ['item.ev.created', {}] }] : ex.hist), ...tk.hist];
      const earlier = ex.earlier ? `<button type="button" class="link-btn" data-fk="earlier">${t('item.earlier', { n: ex.earlier })}</button>` : '';
      let cbox = '';
      if (!i.closed) {
        const cmd = /^\s*\/\w+/m.test(tk.comment);
        const sending = busy === 'comment';
        cbox = `<form class="cbox" data-form="comment" novalidate><label class="fld__label" for="${uid}-cm">${t('item.comment')}</label><p class="fld__hint" id="${uid}-cmh">${t('item.commentHint')}</p>
          <textarea id="${uid}-cm" rows="3" data-fk="comment" data-bind="comment" aria-describedby="${uid}-cmh${cmd ? ` ${uid}-cmn` : ''}"${sending ? ' readonly' : ''}>${esc(tk.comment)}</textarea>
          ${cmd ? `<p class="tnote tnote--cmd${S.isNew.cmd ? ' is-new' : ''}" id="${uid}-cmn">${I.q}<span>${t(tk.dec === 'waiting' ? 'item.commentCmd' : 'item.commentCmdNoDecision')}</span></p>` : ''}
          <div class="cbox__foot"><span></span><button type="submit" class="btn btn--primary${sending ? ' is-busy' : ''}" data-fk="c-send"${offAttr()}>${sending ? `${Proto.dots}${t('item.commentSending')}` : t('item.commentSend')}</button></div></form>`;
      }
      parts.push(`<section class="tk-sec" aria-labelledby="${uid}-hh"><h2 class="tk-h2" id="${uid}-hh">${t('item.history')}</h2>${earlier}<ol class="hist">${hist.map((e, j) => evHTML(e, j >= hist.length - tk.hist.length && S.isNew.hist)).join('')}</ol>${cbox}</section>`);
      return `<article class="tk${i.closed ? ' is-closed' : ''}">${parts.filter(Boolean).join('')}</article>`;
    }

    /* ================= Find ================= */
    const REPOS = { 'geeera/team-console': 'tc', 'geeera/ghost': 'ghost', 'geeera/storify': 'st' };
    function search(q) {
      const p = S.P.tc;
      const link = q.match(/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/i);
      if (link) {
        const repo = link[1].toLowerCase(); const n = +link[2]; const which = REPOS[repo];
        if (which === 'ghost') return { other: { repo, name: 'ghost', key: `GH-${n}` } };
        if (which === 'st' && !S.P.st.switched) return { gh: { repo, n } };
        if (which === 'st') return { other: { repo, name: 'storify', key: `ST-${n}` } };
        q = String(n);
      }
      const all = [...p.items, ...CLOSED];
      const num = (q.match(/^(?:#|tc-)?(\d+)$/i) || [])[1];
      if (num) return { hits: all.filter((i) => i.n === +num), exact: true };
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      return { hits: all.filter((i) => words.every((w) => i.t.toLowerCase().includes(w))), words };
    }
    function hl(text, words) {
      let h = esc(text);
      (words || []).forEach((w) => { const re = new RegExp(`(${esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'); h = h.replace(re, '<mark>$1</mark>'); });
      return h;
    }
    function findResultsHTML() {
      const f = S.find; const q = f.q.trim();
      if (G.data === 'offline' || G.data === 'stale') return `<div class="sx-state sx-state--offline">${I.wifi}<p class="sx-state__t">${t('plan.offline')}</p><p class="sx-state__h">${t('find.offline')}</p></div>`;
      if (!q) return '';
      if (f.state === 'typing') return `<p class="sx-busy"><span class="ring" aria-hidden="true"></span>${t('find.typing')}</p>`;
      const r = search(q);
      if (r.other) return `<div class="fd-other"><p>${t('find.otherRepo', { repo: r.other.repo, name: r.other.name })}</p><button type="button" class="btn" data-fk="f-other">${t('find.otherOpen', { key: r.other.key, name: r.other.name })}</button></div>`;
      if (r.gh) return `<div class="fd-other fd-other--gh"><p>${t('find.notImported', { repo: r.gh.repo })}</p><a class="ext" href="#github" data-act="gh" data-fk="f-gh">${t('find.onGitHub', { n: r.gh.n })}${I.ext}</a></div>`;
      if (!r.hits.length) return `<div class="sx-state sx-state--empty">${I.search}<p class="sx-state__t">${t('find.none')}</p><p class="sx-state__h">${t('find.noneHint')}</p></div>`;
      const rows = r.hits.map((i) => {
        const where = i.closed ? t('find.closed') : i.sp ? sprintOf(i.sp, S.P.tc).name : t('board.sections.backlog');
        const enter = r.exact && r.hits.length === 1 && !phone ? `<span class="fd-hit__enter" aria-hidden="true"><kbd>↩</kbd></span>` : '';
        return `<li><a class="fd-hit${i.closed ? ' is-closed' : ''}" href="#t/${i.n}" data-act="open" data-n="${i.n}" data-fk="hit-${i.n}"><span class="key">TC-${i.n}</span><span class="fd-hit__t">${hl(i.t, r.words)}</span>${enter}<span class="fd-hit__sub"><span class="kind">${t(`board.kind.${i.k}`)}</span><span aria-hidden="true">·</span><span>${t(`board.status.${i.closed && i.s !== 'done' ? 'closed' : i.s}`)}</span><span aria-hidden="true">·</span><span>${where}</span></span></a></li>`;
      }).join('');
      return `<p class="fd-count" role="status">${t('find.results', { n: r.hits.length })}</p><ul class="fd-list">${rows}</ul>`;
    }
    function findHTML() {
      const tries = ['142', 'TC-410', 'board sprint', 'github.com/geeera/team-console/issues/142', 'github.com/geeera/ghost/issues/12', 'github.com/geeera/storify/issues/31', 'zebra'];
      return `<div class="fd" role="search" aria-labelledby="${uid}-fh"><h1 id="${uid}-fh" tabindex="-1" data-fk="f-h">${t('find.t')}</h1>
        <div><label class="fld__label" for="${uid}-fq">${t('find.label')}</label>
        <div class="fd-field">${I.search}<input id="${uid}-fq" type="search" data-fk="f-q" data-bind="find" value="${esc(S.find.q)}" autocomplete="off" enterkeyhint="search" aria-describedby="${uid}-fhint">${phone ? '' : '<kbd>/</kbd>'}</div>
        <p class="fld__hint" id="${uid}-fhint">${t('find.hint')}</p></div>
        <div class="fd-try"><span>${t('find.try')}:</span>${tries.map((q) => `<button type="button" class="chip-btn" data-act="try" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
        <div data-slot="results">${findResultsHTML()}</div></div>`;
    }

    /* ================= the move to the console (storify) ================= */
    const stepIdx = { intro: 0, copying: 0, failed: 1, ready: 1, mismatch: 1, switching: 2, swfail: 2, switched: 3 };
    function stepsHTML(step) {
      const at = stepIdx[step] ?? 0;
      return `<ol class="im-steps" aria-label="${esc(t('imp.steps'))}">${['copy', 'check', 'switch'].map((k, j) => `<li class="${j < at ? 'is-done' : ''}"${j === at ? ' aria-current="step"' : ''}><b>${j + 1}. ${t(`imp.step.${k}`)}</b><span class="sr-only">, ${j < at ? t('imp.step.done') : j === at ? t('imp.step.now') : ''}</span></li>`).join('')}</ol>`;
    }
    function importHTML() {
      const step = S.imp; const name = 'storify';
      const offNote = G.data === 'offline' || G.data === 'stale' ? `<p class="stale">${I.wifi}<span>${t('imp.offline')}</span></p>` : '';
      const head = (h) => `<p class="im-kicker">${t('imp.kicker')}</p>${h}`;
      if (step === 'intro') {
        return `<div class="im">${offNote}${head(`<h1 tabindex="-1" data-fk="im-h">${t('imp.t', { name })}</h1>`)}${stepsHTML(step)}<p class="im-lead">${t('imp.intro.lead')}</p>
          <div class="im-cols"><section class="im-col"><h2>${t('imp.intro.what')}</h2><ul class="im-list im-list--in">${['w1', 'w2', 'w3', 'w4'].map((k) => `<li>${I.check}<span>${t(`imp.intro.${k}`)}</span></li>`).join('')}</ul></section>
          <section class="im-col"><h2>${t('imp.intro.stays')}</h2><ul class="im-list im-list--stay">${['s1', 's2'].map((k) => `<li>${I.minus}<span>${t(`imp.intro.${k}`)}</span></li>`).join('')}</ul></section></div>
          <p class="im-key">${I.key}<span>${t('imp.intro.key', { prefix: 'ST' })}</span></p>
          <div class="im-acts"><button type="button" class="btn btn--primary" data-act="imp-copy" data-fk="imp-copy">${t('imp.intro.go')}</button><small>${t('imp.intro.time')}</small></div></div>`;
      }
      if (step === 'copying') {
        const a = S.copyN ?? 172;
        return `<div class="im">${offNote}${head(`<h1 tabindex="-1" data-fk="im-h">${t('imp.copy.h')}</h1>`)}${stepsHTML(step)}
          <dl class="im-ledger"><div><dt>${t('imp.copy.sprints')}</dt><dd>${I.check} ${t('imp.copy.of', { a: 5, b: 5 })}</dd></div>
          <div><dt id="${uid}-pl">${t('imp.copy.items')}</dt><dd>${t('imp.copy.of', { a, b: 412 })}</dd><progress class="im-bar" max="412" value="${a}" aria-labelledby="${uid}-pl"></progress></div>
          <div><dt>${t('imp.copy.comments')}</dt><dd>${t('imp.copy.of', { a: Math.round(a * 5.1), b: 2104 })}</dd></div></dl>
          <p class="im-note">${t('imp.copy.leave')}</p><div class="im-acts"><button type="button" class="btn" data-act="imp-stop" data-fk="imp-stop">${t('imp.copy.cancel')}</button></div></div>`;
      }
      if (['failed', 'ready', 'mismatch'].includes(step)) {
        const failed = step === 'failed'; const diff = step === 'mismatch';
        const rows = [['Sprint 03', 6, 6], ['Sprint 04', diff ? 5 : 4, 4], [t('board.sections.backlog'), 31, 31], [t('imp.check.closed'), 371, failed ? 369 : 371]];
        const tbl = `<table class="im-tbl"><caption>${t('imp.check.compare')}</caption><thead><tr><th scope="col">${t('imp.check.col.where')}</th><th scope="col">${t('imp.check.col.gh')}</th><th scope="col">${t('imp.check.col.tc')}</th><th scope="col">${t('imp.check.col.ok')}</th></tr></thead><tbody>${rows.map(([w, g, c]) => `<tr${g !== c ? ' class="is-diff"' : ''}><th scope="row">${w}</th><td>${g}</td><td>${c}</td><td>${g === c ? `<span class="res-ok">${I.check}${t('imp.check.match')}</span>` : `<span class="res-diff">${I.warn}${t('imp.check.diff')}</span>`}</td></tr>`).join('')}</tbody></table>`;
        const fail = failed ? `<div class="wblk wblk--bad" role="alert"><h2>${I.warn}<span>${t('imp.check.failed', { n: 2 })}</span></h2><ul class="im-fail">${[77, 203].map((n) => `<li>${t('imp.check.failedRow', { n })}</li>`).join('')}</ul><div class="wblk__acts"><button type="button" class="btn" data-act="imp-refail" data-fk="imp-refail">${I.refresh}${t('imp.check.retryFailed')}</button></div></div>` : '';
        const changed = `<section class="im-sec"><h2>${t('imp.check.changed')}</h2><ul class="im-list im-list--in">${['c1', 'c2', 'c3', 'c4'].map((k) => `<li>${I.check}<span>${t(`imp.check.${k}`)}</span></li>`).join('')}</ul></section>`;
        const swId = `${uid}-swoff`;
        return `<div class="im">${offNote}${head(`<h1 tabindex="-1" data-fk="im-h">${t(failed ? 'imp.check.hFailed' : 'imp.check.h')}</h1>`)}${stepsHTML(step)}<p class="im-lead">${t('imp.check.lead', { items: failed ? 410 : 412, sprints: 5, comments: 2104 })}</p>
          ${fail}${tbl}${diff ? `<p class="im-note">${t('imp.check.mismatchNote')}</p>` : ''}${changed}
          <div class="im-acts"><button type="button" class="btn btn--primary" data-act="imp-switch" data-fk="imp-switch"${failed ? ` aria-disabled="true" aria-describedby="${swId}"` : ''}>${t('imp.check.switch')}</button><button type="button" class="btn" data-act="imp-copy" data-fk="imp-again">${t('imp.check.again')}</button><button type="button" class="btn btn--danger-quiet" data-act="imp-cancel" data-fk="imp-cancel">${t('imp.check.cancel')}</button>${failed ? `<small id="${swId}">${t('imp.check.switchOff')}</small>` : ''}</div></div>`;
      }
      if (step === 'switching' || step === 'swfail') {
        const k = S.swStep ?? 2;
        const lines = ['s1', 's2', 's3', 's4', 's5'].map((s, j) => {
          const done = step === 'switching' ? j < k : j < 2;
          const now = step === 'switching' && j === k;
          return `<li class="${done ? 'is-done' : ''}${now ? ' is-now' : ''}${done && S.isNew.sw === j ? ' is-new' : ''}"><span class="mark2">${done ? I.check : now ? '<span class="ring" aria-hidden="true"></span>' : '<i></i>'}</span><span>${t(`imp.sw.${s}`, { n: 3 })}</span>${done ? `<span class="sr-only">, ${t('imp.step.done')}</span>` : ''}</li>`;
        }).join('');
        const fail = step === 'swfail' ? `<div class="wblk wblk--bad" role="alert" tabindex="-1" data-fk="sw-fail"><h2>${I.warn}<span>${t('imp.swfail.t')}</span></h2><p>${t('imp.swfail.b')}</p><div class="wblk__acts"><button type="button" class="btn" data-act="imp-switch" data-fk="sw-retry">${I.refresh}${t('imp.swfail.retry')}</button></div></div>` : '';
        return `<div class="im">${offNote}${head(`<h1 tabindex="-1" data-fk="im-h">${t('imp.sw.h', { name })}</h1>`)}${stepsHTML(step)}${fail}<ol class="im-run" aria-busy="${step === 'switching'}">${lines}</ol>${step === 'switching' ? `<p class="im-note">${t('imp.sw.stay')}</p>` : ''}</div>`;
      }
      // switched
      return `<div class="im">${head('')}${stepsHTML(step)}<div class="im-done"><p class="im-done__kicker" aria-hidden="true">${t('imp.done.stamp')}</p><h2 tabindex="-1" data-fk="im-done">${t('imp.done.h', { name })}</h2><p>${t('imp.done.b')}</p>${STAMP().replace('class="stamp"', 'class="stamp" data-stamp')}</div>
        <div class="im-acts"><button type="button" class="btn btn--primary" data-act="imp-board" data-fk="imp-board">${t('imp.done.board')}</button><button type="button" class="btn" data-act="find" data-fk="imp-find">${I.search}${t('imp.done.find')}</button></div></div>`;
    }

    /* ================= chrome ================= */
    const navItems = [['inbox', 'questions'], ['chat', 'chat'], ['board', 'board'], ['stack', 'artifacts'], ['play', 'demo']];
    function mainHTML() {
      const p = P();
      const view = S.view;
      const content = view === 'find' ? findHTML() : view === 'import' ? importHTML() : boardHTML();
      if (phone) {
        if (view === 'task' || view === 'find' || view === 'import') {
          const label = view === 'task' ? (G.data === 'notfound' ? key(999) : key(S.tk.n)) : view === 'find' ? '' : p.slug;
          const body = view === 'task' ? taskHTML() : content;
          return `<header class="tk-bar"><button type="button" class="tk-back" data-act="board" data-fk="back">${I.back}${t('nav.back')}</button><span class="tk-bar__key" aria-hidden="true">${label}</span><span style="width:var(--target)"></span></header>
            <div class="tk-scroll" data-scroll="${view}">${body}</div>
            <nav class="tabs bd-tabs" aria-label="${esc(t('nav.sections'))}">${navItems.map(([ico, k]) => `<button type="button"${k === 'board' ? ' aria-current="page"' : ''}>${I[ico]}<span>${t(`nav.${k}`)}</span></button>`).join('')}</nav>`;
        }
        return `<header class="p-head bd-top"><button type="button" class="bd-proj" aria-label="${esc(t('nav.switch', { name: p.slug }))}" aria-haspopup="dialog"><span>${p.slug}</span>${I.down}</button>
          <span class="bd-top__acts">${p.switched ? `<button type="button" class="bd-icon" data-act="find" data-fk="hd-find" aria-label="${esc(t('nav.find'))}">${I.search}</button><button type="button" class="bd-icon" data-act="new" data-fk="hd-new" aria-label="${esc(t('nav.new'))}">${I.plus}</button>` : ''}<button type="button" class="bd-icon" aria-label="${esc(t('nav.commands'))}">${I.sliders}</button></span></header>
          <div class="bd-scroll" data-scroll="board">${content}</div>
          <nav class="tabs bd-tabs" aria-label="${esc(t('nav.sections'))}">${navItems.map(([ico, k]) => `<button type="button"${k === 'board' ? ' aria-current="page"' : ''}>${I[ico]}<span>${t(`nav.${k}`)}</span></button>`).join('')}</nav>`;
      }
      const side = `<nav class="sidebar" aria-label="${esc(t('nav.projects'))}"><div class="brand">${I.mark}<span>${t('nav.app')}</span></div>
        <ul class="side-list side-list--top"><li><button type="button" class="side-item">${I.inbox}<span>${t('nav.waiting')}</span></button></li><li><button type="button" class="side-item">${I.grid}<span>${t('nav.all')}</span></button></li></ul>
        <div class="side-label">${t('nav.projects')}</div>
        <ul class="side-list">${[['ghost', 'tc'], ['storify', 'st'], ['team-console', 'tc']].map(([name, pk]) => `<li><button type="button" class="side-item" data-act="proj" data-p="${name}"${p.slug === name ? ' aria-current="true"' : ''}><span class="side-prod__label">${name}</span></button></li>`).join('')}</ul></nav>`;
      const pane = view === 'task' ? `<aside class="tk-pane${S.paneQuiet ? ' is-quiet' : ''}" aria-labelledby="${uid}-pk"><div class="tk-bar"><span class="tk-bar__key" id="${uid}-pk">${G.data === 'notfound' ? key(999) : key(S.tk.n)}</span><button type="button" class="icon-btn" data-act="close-task" data-fk="pane-x" aria-label="${esc(t('item.close'))}">${I.x}</button></div><div class="tk-scroll" data-scroll="task">${taskHTML()}</div></aside>` : '';
      const acts = p.switched ? `<div class="hd-acts"><button type="button" class="btn btn--quiet hd-find" data-act="find" data-fk="hd-find" aria-label="${esc(t('nav.find'))}" aria-keyshortcuts="/">${I.search}<kbd>/</kbd></button><button type="button" class="btn" data-act="new" data-fk="hd-new" aria-keyshortcuts="T"${pane ? ` aria-label="${esc(t('nav.new'))}"` : ''}>${I.plus}${pane ? '' : `<span>${t('nav.new')}</span>`}<kbd>T</kbd></button></div>` : '<div class="hd-acts"></div>';
      return `${side}<section class="convo bd-mac${pane ? ' has-pane' : ''}"><header class="convo__head"><div class="convo__title">${pane ? `<p class="bd-mac__name">${p.slug}</p>` : `<h1 class="bd-mac__name">${p.slug}</h1>`}</div>
          <nav class="bd-seg" aria-label="${esc(t('nav.sections'))}">${navItems.slice(0, pane ? 3 : 5).map(([ico, k]) => `<button type="button"${k === 'board' ? ' aria-current="page"' : ''}${pane ? ` aria-label="${esc(t(`nav.${k}`))}"` : ''}>${I[ico]}${pane ? '' : `<span>${t(`nav.${k}`)}</span>`}</button>`).join('')}</nav>${acts}</header>
          <div class="bd-scroll" data-scroll="${view === 'task' ? 'board' : view}">${content}</div></section>${pane}`;
    }

    /* ================= overlays: menus, pickers, dialogs, sheets ================= */
    function moveMenuHTML(i) {
      const p = P(); const items = [];
      const cur = curId();
      items.push(`<div class="mnu__group" role="presentation">${t('plan.sprints')}</div>`);
      p.sprints.forEach((s) => {
        const n = openCount(s.id); const here = i.sp === s.id; const frozen = s.id === cur && G.freeze;
        const label = s.id === cur ? t('plan.toCurrent', { sprint: s.name }) : t('plan.to', { sprint: s.name });
        const why = here ? t('plan.here') : frozen ? t('plan.freeze', { date: day(s.due) }) : '';
        const full = !why && n >= CAP;
        const hint = why || (full ? t('plan.full', { n, cap: CAP }) : t('plan.count', { n, date: day(s.due) }));
        items.push(`<button type="button" role="menuitem" class="mi" data-mi="sp:${s.id}"${why ? ` aria-disabled="true" data-why="${esc(plain(why))}"` : ''}>${here ? IC.here : frozen ? IC.lock : IC.cal}<span class="mi__t">${label}</span><span class="mi__h${full ? ' mi__h--full' : ''}">${hint}</span></button>`);
      });
      const inB = i.sp === null;
      items.push(`<button type="button" role="menuitem" class="mi" data-mi="sp:"${inB ? ` aria-disabled="true" data-why="${esc(t('plan.here'))}"` : ''}>${inB ? IC.here : IC.tray}<span class="mi__t">${t('plan.toBacklog')}</span><span class="mi__h">${inB ? t('plan.here') : t('plan.backlogCount', { n: openCount(null) })}</span></button>`);
      items.push('<div class="mnu__sep" role="separator"></div>');
      items.push(`<div class="mnu__group" role="presentation">${t('plan.queue', { lane: t(`board.status.${i.s}`) })}</div>`);
      const peers = peersOf(i); const pos = peers.indexOf(i); const last = pos === peers.length - 1;
      [['top', IC.top, pos === 0, 'plan.upNone'], ['up', IC.up, pos === 0, 'plan.upNone'], ['down', IC.down, last, 'plan.downNone']].forEach(([k, ico, off, whyK]) => {
        items.push(`<button type="button" role="menuitem" class="mi" data-mi="q:${k}"${off ? ` aria-disabled="true" data-why="${esc(t(whyK))}"` : ''}>${ico}<span class="mi__t">${t(`plan.${k}`)}</span>${off ? `<span class="mi__h">${t(whyK)}</span>` : ''}</button>`);
      });
      const warn = i.s === 'in-progress' ? `<p class="mnu__warn">${I.warn}<span>${t('plan.inProgressWarn')}</span></p>` : '';
      return { title: t('plan.menuTitle', { key: key(i.n) }), sub: esc(i.t), aria: t('plan.menuAria', { key: key(i.n) }), warn, items: items.join('') };
    }
    function pickerHTML(field, i) {
      const vals = field === 'status' ? [...LANES, 'closed'] : ['feature', 'bug', 'chore', 'finding', 'wow', 'question'];
      const cur = field === 'status' ? statusOf(i) : i.k;
      const items = vals.map((v) => {
        const on = v === cur; const team = field === 'status' && (v === 'in-progress' || v === 'qa');
        const name = field === 'status' ? t(`board.status.${v}`) : t(`board.kind.${v}`);
        return `<button type="button" role="menuitemradio" class="mi" aria-checked="${on}" data-mi="${field}:${v}">${on ? IC.radioOn : IC.radio}<span class="mi__t">${name}${team ? `<span class="mi__team">${t('item.teamUsually')}</span>` : ''}</span><span class="mi__h">${t(`item.${field}.hint.${v}`)}</span></button>`;
      }).join('');
      return { title: `<span class="key">${key(i.n)}</span> · ${t(`item.${field}`)}`, sub: '', aria: t(`item.picker.${field}`, { key: key(i.n) }), warn: '', items };
    }
    function menuHTML() {
      const m = S.menu; const i = itemOf(m.n);
      const c = m.type === 'move' ? moveMenuHTML(i) : pickerHTML(m.field, i);
      return `<div class="mo"><div class="mo__scrim" data-act="menu-close"></div>
        <div class="mnu" data-menu>${phone ? '<div class="mnu__grab" aria-hidden="true"></div>' : ''}
          <div class="mnu__head"><p class="mnu__title">${c.title}</p>${c.sub ? `<p class="mnu__sub">${c.sub}</p>` : ''}</div>${c.warn}
          <div class="mnu__list" role="menu" aria-label="${esc(plain(c.aria))}">${c.items}</div>
          ${phone ? `<button type="button" class="btn mnu__cancel" data-act="menu-close" data-fk="mnu-cancel">${t('ui.cancel')}</button>` : ''}</div></div>`;
    }
    function sprintDialogHTML() {
      const d = S.sd; const p = P();
      const last = p.sprints[p.sprints.length - 1];
      const prevDate = day(last.due);
      const dd = new Date(`${d.date}T12:00:00`);
      const f1 = new Date(dd); f1.setDate(dd.getDate() - 2); const f2 = new Date(dd); f2.setDate(dd.getDate() - 1);
      const fz = Number.isNaN(dd.getTime()) ? '—' : f1.getMonth() === f2.getMonth() ? (L.lang === 'ru' ? `${f1.getDate()}–${f2.getDate()} ${mon()[f1.getMonth()]}` : `${mon()[f1.getMonth()]} ${f1.getDate()}–${f2.getDate()}`) : `${day([f1.getMonth() + 1, f1.getDate()])} – ${day([f2.getMonth() + 1, f2.getDate()])}`;
      const e = d.err || {}; const busy = d.busy; const off = offline();
      const errP = (k, id) => (e[k] ? `<p class="fld__err" id="${id}">${I.warn}<span>${e[k]}</span></p>` : '');
      const ro = busy ? ' readonly' : '';
      const okLabel = busy ? `${Proto.dots}${t('sprintNew.busy')}` : t('sprintNew.ok', { sprint: d.name.trim() || '…' });
      const ok = `<button type="submit" form="${uid}-sdf" class="btn btn--primary${busy ? ' is-busy' : ''}" data-fk="sd-ok"${off ? ` aria-disabled="true" aria-describedby="${uid}-sdoff"` : ''}>${okLabel}</button>`;
      const body = `<form class="tform" id="${uid}-sdf" data-form="sprint" novalidate${busy ? ' aria-busy="true"' : ''}>
        ${d.wErr ? `<div class="terr is-new" role="alert" tabindex="-1" data-fk="sd-err"><h3>${I.warn}<span>${t(`err.${d.wErr}.t`)}</span></h3><p>${t(`err.${d.wErr}.b`)}</p></div>` : ''}
        ${off ? `<p class="stale" id="${uid}-sdoff">${I.wifi}<span>${t('plan.offline')}</span></p>` : ''}
        <div class="fld"><label class="fld__label" for="${uid}-sn">${t('sprintNew.name')}</label>${errP('name', `${uid}-sne`)}<input class="fld-input fld-input--title" id="${uid}-sn" data-fk="sd-name" data-bind="sd-name" value="${esc(d.name)}" autocomplete="off"${e.name ? ` aria-invalid="true" aria-describedby="${uid}-sne"` : ''}${ro}></div>
        <div class="fld"><label class="fld__label" for="${uid}-sdd">${t('sprintNew.date')}</label>${errP('date', `${uid}-sde`)}<input class="fld-input" type="date" id="${uid}-sdd" data-fk="sd-date" data-bind="sd-date" value="${esc(d.date)}" min="2026-11-04" aria-describedby="${e.date ? `${uid}-sde ` : ''}${uid}-sdh"${e.date ? ' aria-invalid="true"' : ''}${ro}></div>
        <p class="sd-hint" id="${uid}-sdh">${t('sprintNew.hint', { prev: last.name, date: prevDate, freeze: fz })} ${t('sprintNew.after')}</p></form>`;
      const head = phone
        ? `<div class="sheet__grab" aria-hidden="true"></div><button type="button" class="btn btn--quiet tsheet__close" data-act="sd-close" data-fk="sd-x">${t('ui.cancel')}</button><div class="tsheet__titles"><h2 class="tsheet__title" id="${uid}-sdt">${t('sprintNew.t')}</h2></div><span></span>`
        : `<div class="tsheet__titles"><h2 class="tsheet__title" id="${uid}-sdt">${t('sprintNew.t')}</h2></div><button type="button" class="icon-btn" data-act="sd-close" data-fk="sd-x" aria-label="${esc(t('ui.close'))}">${I.x}</button>`;
      const foot = `<div class="tsheet__foot"><span class="foot-hint"></span><button type="button" class="btn" data-act="sd-close" data-fk="sd-cancel">${t('ui.cancel')}</button>${ok}</div>`;
      return `<div class="tsheet tsheet--sd ${phone ? 'tsheet--phone' : 'tsheet--dialog'}"><div class="tsheet__scrim" data-act="sd-close"></div><section class="tsheet__panel" role="dialog" aria-modal="true" aria-labelledby="${uid}-sdt" data-dialog><div class="tsheet__head">${head}</div><div class="tsheet__body">${body}</div>${foot}</section></div>`;
    }
    function newTaskHTML() {
      const n = S.nt; const p = S.P.tc;
      const cur = p.sprints[0]; const nxt = p.sprints[1];
      const done = n.step === 'done';
      let body; let foot = '';
      if (done) {
        const c = n.created; const it = itemOf(c.n, p);
        const where = c.sp ? t('task.done.where', { sprint: sprintOf(c.sp, p).name, pos: ord(peersOf(it, p).indexOf(it) + 1) }) : t('task.done.whereBacklog');
        body = `<div class="tdone"><div class="tcard"><span class="tcard__top"><span class="tcard__kind tcard__kind--${c.k}">${t(`board.kind.${c.k}`)}</span><span class="tcard__num">${key(c.n, p)}</span></span><p class="tcard__title">${esc(c.t)}</p><span class="tcard__repo">team-console</span>${STAMP().replace('class="stamp"', 'class="stamp" data-stamp')}</div>
          <p class="tdone__kicker" aria-hidden="true">${t('task.done.stamp')}</p><h2 class="tdone__h" id="${uid}-ntd" tabindex="-1" data-fk="nt-done">${t('task.done.h', { key: key(c.n, p) })}</h2>
          <p class="tdone__meta">${t('task.done.meta', { name: 'team-console', time: NOW })}</p><p class="tdone__req${c.sp ? '' : ' tdone__req--neutral'}">${where}</p>
          ${phone ? `<div class="tphone-acts"><button type="button" class="btn btn--primary" data-act="nt-open" data-fk="nt-open">${t('task.done.open')}</button><button type="button" class="btn" data-act="nt-another">${t('task.done.another')}</button><button type="button" class="btn" data-act="nt-close">${t('task.done.close')}</button></div>` : ''}</div>`;
        if (!phone) foot = `<div class="tsheet__foot tsheet__foot--done"><button type="button" class="btn" data-act="nt-another">${t('task.done.another')}</button><button type="button" class="btn" data-act="nt-close">${t('task.done.close')}</button><button type="button" class="btn btn--primary" data-act="nt-open" data-fk="nt-open">${t('task.done.open')}</button></div>`;
      } else {
        const busy = n.step === 'busy';
        const opt = (v, label, hint, status, offWhy, chip) => {
          const id = `${uid}-nt-${v}`; const on = n.sprint === v;
          return `<label class="topt${offWhy ? ' topt--off' : ''}"><input type="radio" name="${uid}-ns" value="${v}" data-bind="nt-sprint"${on ? ' checked' : ''}${offWhy ? ' aria-disabled="true"' : ''} aria-describedby="${id}"><span class="topt__t">${label}${chip || ''}${status && !offWhy ? `<span class="topt__as">· ${t('task.sprint.as', { status: t(`board.status.${status}`) })}</span>` : ''}</span><span class="topt__h" id="${id}">${hint}</span></label>`;
        };
        const curOff = G.freeze ? t('task.sprint.freeze', { date: day(cur.due) }) : '';
        const opts = [
          opt('current', t('task.sprint.current'), curOff || t('task.sprint.currentHint', { sprint: cur.name, date: day(cur.due) }), 'approved', curOff, G.freeze ? `<span class="topt__chip">${IC.lock}${t('board.freeze')}</span>` : ''),
          nxt ? opt('next', t('task.sprint.next'), t('task.sprint.nextHint', { sprint: nxt.name, date: day(nxt.due) }), 'approved') : opt('next', t('task.sprint.next'), t('task.sprint.nextNone'), null, t('task.sprint.nextNone')),
          opt('backlog', t('task.sprint.backlog'), t('task.sprint.backlogHint'), 'proposed'),
        ].join('');
        const projOpts = `<option value="team-console" selected>team-console</option><option value="ghost">ghost</option><option value="storify" disabled>${t('task.project.off', { name: 'storify' })}</option>`;
        body = `<form class="tform" id="${uid}-ntf" data-form="nt" novalidate${busy ? ' aria-busy="true"' : ''}>
          ${n.wErr ? `<div class="terr is-new" role="alert" tabindex="-1" data-fk="nt-err"><h3>${I.warn}<span>${t(`err.${n.wErr}.t`)}</span></h3><p>${t(`err.${n.wErr}.b`)}</p></div>` : ''}
          <div class="fld"><label class="fld__label" for="${uid}-np">${t('task.project.label')}</label><div class="fld-proj"><span class="prod-mono" aria-hidden="true">t</span><select class="fld-select" id="${uid}-np" aria-describedby="${uid}-npn">${projOpts}</select>${I.down}</div><p class="tnote" id="${uid}-npn">${I.lock}<span>${t('task.project.github', { name: 'storify' })}</span></p></div>
          <div class="fld"><label class="fld__label" for="${uid}-nn">${t('task.name.label')}</label><input class="fld-input fld-input--title" id="${uid}-nn" data-fk="nt-title" value="${esc(n.title)}" data-bind="nt-title"${busy ? ' readonly' : ''}></div>
          <fieldset class="fld"><legend class="fld__label">${t('task.kind.label')}</legend><div class="tseg">${['feature', 'bug', 'chore'].map((k) => `<label><input type="radio" name="${uid}-nk" value="${k}" data-bind="nt-kind"${n.k === k ? ' checked' : ''}>${t(`board.kind.${k}`)}</label>`).join('')}</div></fieldset>
          <fieldset class="fld"><legend class="fld__label">${t('task.sprint.label')}</legend><div class="topts">${opts}</div></fieldset></form>`;
        const send = `<button type="submit" form="${uid}-ntf" class="btn btn--primary${busy ? ' is-busy' : ''}${phone ? ' tsheet__send' : ''}" data-fk="nt-send">${busy ? `${Proto.dots}${phone ? '' : t('task.sending')}` : phone ? t('task.sendShort') : t('task.send', { name: 'team-console' })}</button>`;
        if (!phone) foot = `<div class="tsheet__foot"><p class="foot-hint"><kbd>⌘↩</kbd></p><button type="button" class="btn" data-act="nt-close">${t('ui.close')}</button>${send}</div>`;
        n.sendHTML = send;
      }
      const head = phone
        ? `<div class="sheet__grab" aria-hidden="true"></div><button type="button" class="btn btn--quiet tsheet__close" data-act="nt-close" data-fk="nt-x">${t('ui.close')}</button><div class="tsheet__titles"><h2 class="tsheet__title" id="${uid}-ntt">${t('task.title')}</h2><span class="tsheet__into">team-console</span></div>${done ? '<span></span>' : n.sendHTML}`
        : `<div class="tsheet__titles"><h2 class="tsheet__title" id="${uid}-ntt">${t('task.title')}</h2><span class="tsheet__into">team-console</span></div><button type="button" class="icon-btn" data-act="nt-close" data-fk="nt-x" aria-label="${esc(t('ui.close'))}">${I.x}</button>`;
      return `<div class="tsheet ${phone ? 'tsheet--phone' : 'tsheet--dialog'}"><div class="tsheet__scrim" data-act="nt-close"></div><section class="tsheet__panel" role="dialog" aria-modal="true" aria-labelledby="${uid}-ntt" data-dialog><div class="tsheet__head">${head}</div><div class="tsheet__body">${body}</div>${foot}</section></div>`;
    }
    function modalHTML() {
      const m = S.modal;
      if (m === 'discard') {
        return `<div class="modal"><div class="modal__scrim"></div><section class="adialog" role="alertdialog" aria-modal="true" aria-labelledby="${uid}-dt" aria-describedby="${uid}-db" data-dialog><h2 id="${uid}-dt" tabindex="-1" data-fk="dc-h">${t('item.discard.t')}</h2><p id="${uid}-db">${t('item.discard.b')}</p>
          <div class="adialog__actions"><button type="button" class="btn" data-act="dc-keep" data-fk="dc-keep">${t('item.discard.keep')}</button><button type="button" class="btn btn--danger" data-act="dc-ok">${t('item.discard.ok')}</button></div></section></div>`;
      }
      if (m === 'reason') {
        const r = S.reason; const k = key(S.tk.n);
        return `<div class="modal"><div class="modal__scrim" data-act="rs-close"></div><section class="adialog" role="dialog" aria-modal="true" aria-labelledby="${uid}-rt" data-dialog><h2 id="${uid}-rt">${t('dec.reason.t')}</h2>
          <form class="tform" data-form="reason" novalidate><div class="fld"><label class="fld__label" for="${uid}-rr">${t('dec.reason.l')}</label>${r.err ? `<p class="fld__err" id="${uid}-rre">${I.warn}<span>${t('dec.reason.req')}</span></p>` : ''}<textarea class="fld-input" id="${uid}-rr" rows="3" data-fk="rs-text" data-bind="reason" aria-describedby="${r.err ? `${uid}-rre ` : ''}${uid}-rrh"${r.err ? ' aria-invalid="true"' : ''}>${esc(r.text)}</textarea><p class="fld__hint" id="${uid}-rrh">${t('dec.reason.hint')}</p></div>
          <div class="adialog__actions"><button type="button" class="btn" data-act="rs-close">${t('ui.cancel')}</button><button type="submit" class="btn btn--danger" data-fk="rs-send">${t('dec.reason.send', { key: k })}</button></div></form></section></div>`;
      }
      if (m === 'confirm') {
        const name = 'storify';
        return `<div class="modal"><div class="modal__scrim"></div><section class="adialog adialog--wide" role="alertdialog" aria-modal="true" aria-labelledby="${uid}-ct" aria-describedby="${uid}-cl" data-dialog><h2 id="${uid}-ct" tabindex="-1" data-fk="cf-h">${t('imp.confirm.t', { name })}</h2>
          <ol class="im-lines" id="${uid}-cl">${['l1', 'l2', 'l3', 'l4'].map((k) => `<li>${t(`imp.confirm.${k}`)}</li>`).join('')}</ol>
          <div class="adialog__actions"><button type="button" class="btn" data-act="cf-keep" data-fk="cf-keep">${t('imp.confirm.keep')}</button><button type="button" class="btn btn--primary" data-act="cf-ok">${t('imp.confirm.ok', { name })}</button></div></section></div>`;
      }
      return '';
    }
    function placeMenu() {
      const m = $('[data-menu]'); if (!m || phone) return;
      const anchor = host.querySelector(`[data-fk="${S.menu.opener}"]`); if (!anchor) return;
      const hr = host.getBoundingClientRect(); const z = hr.width / host.offsetWidth || 1;
      const ar = anchor.getBoundingClientRect();
      const W = host.offsetWidth; const H = host.offsetHeight;
      let left = S.menu.type === 'move' ? (ar.right - hr.left) / z - m.offsetWidth : (ar.left - hr.left) / z;
      left = Math.max(8, Math.min(left, W - m.offsetWidth - 8));
      let top = (ar.bottom - hr.top) / z + 4;
      if (top + m.offsetHeight > H - 8) { const up = (ar.top - hr.top) / z - 4 - m.offsetHeight; top = up > 8 ? up : Math.max(8, H - 8 - m.offsetHeight); }
      m.style.left = `${left}px`; m.style.top = `${top}px`;
    }

    /* ================= render ================= */
    function render(focus) {
      const main = $('[data-slot=main]');
      const scrolls = {}; host.querySelectorAll('[data-scroll]').forEach((el) => { scrolls[el.dataset.scroll] = el.scrollTop; });
      const keepFk = !focus && host.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
      main.innerHTML = mainHTML();
      host.querySelectorAll('[data-scroll]').forEach((el) => { if (scrolls[el.dataset.scroll] != null) el.scrollTop = scrolls[el.dataset.scroll]; });
      const ov = $('[data-slot=ov]');
      ov.innerHTML = S.menu ? menuHTML() : S.modal ? modalHTML() : S.sd ? sprintDialogHTML() : S.nt ? newTaskHTML() : '';
      main.inert = !!(S.menu || S.modal || S.sd || S.nt);
      const toastSlot = $('[data-slot=toast]'); if (toastSlot) toastSlot.inert = main.inert;
      if (S.menu) placeMenu();
      host.querySelectorAll('[data-stamp]').forEach((s) => { if (S.isNew.stamp) stamp(s); });
      S.isNew = {};
      S.paneQuiet = true;
      if (focus) {
        if (focus === 'menu') focusMenuStart();
        else if (!focusFk(focus) && keepFk) focusFk(keepFk);
      } else if (keepFk) focusFk(keepFk);
    }
    function stamp(s) {
      if (isReduced()) return;
      const strokes = [...s.querySelectorAll('circle,path')];
      strokes.forEach((pth) => { const l = pth.getTotalLength(); pth.style.strokeDasharray = l; pth.style.strokeDashoffset = l; });
      play(s, [{ opacity: 0, transform: 'rotate(-20deg) scale(1.4)' }, { opacity: 1, transform: 'rotate(-9deg) scale(1)' }], { duration: ms('--dur-base'), easing: cssVar('--ease-emph') });
      strokes.forEach((pth, j) => play(pth, [{ strokeDashoffset: pth.style.strokeDashoffset }, { strokeDashoffset: 0 }], { duration: ms('--dur-sig') * 0.6, delay: j * ms('--stagger'), easing: cssVar('--ease-emph'), fill: 'forwards' }));
    }

    /* ================= behaviour ================= */
    // The demo's "next write" outcome applies once to the next write it fits; a retry then succeeds.
    function consume(kind) {
      const o = G.write;
      const fits = o === 'conflict' || o === 'invalid' ? kind === 'save' : o === 'gone' ? kind === 'approve' || kind === 'reject' : true;
      if (o === 'ok' || !fits) return 'ok';
      G.write = 'ok'; syncDemo();
      return o;
    }
    function write(kind, apply, { onFocus, force } = {}) {
      const tk = S.tk;
      const out = force ? 'ok' : consume(kind);
      tk.busy = kind; tk.err = null; render();
      setTimeout(() => {
        if (S.tk !== tk) return;
        tk.busy = null;
        if (out === 'ok') { const f = apply(); render(f || onFocus); return; }
        tk.err = { code: out, kind, retry: () => write(kind, apply, { onFocus }) };
        if (out === 'invalid') { tk.fieldErr = 'body'; render('e-body'); return; }
        const primary = { conflict: 'mine', gone: 'refresh', network: 'retry', timeout: 'retry' }[out];
        render(primary || 'err-blk');
        say(`${t(`err.${out}.t`)}. ${t(`err.${out}.b`, { time: '14:03' })}`);
      }, 650);
    }
    const addEv = (e) => { S.tk.hist.push({ who: 'you', at: [11, 4], time: NOW, ...e }); S.isNew.hist = true; };
    function openTask(n, from) {
      S.view = 'task'; S.tk = freshTask(n); S.menu = null; S.paneQuiet = false; S.returnFk = from || `row-${n}`;
      render(S.tk.edit ? 'e-title' : 'h1');
    }
    function closeTask() {
      const back = S.returnFk; S.view = 'board'; S.tk = null; render(back);
    }
    function openMenu(type, n, opener, field) { S.menu = { type, n, opener, field }; render('menu'); }
    function focusMenuStart() {
      const m = $('[data-menu]'); if (!m) return;
      const items = [...m.querySelectorAll('.mi')];
      const first = items.find((x) => x.getAttribute('aria-checked') === 'true') || items.find((x) => x.getAttribute('aria-disabled') !== 'true') || items[0];
      if (first) first.focus();
    }
    function closeMenu() { const back = S.menu.opener; S.menu = null; render(back); }

    /* moves */
    function successorFk(i) {
      const peers = peersOf(i); const j = peers.indexOf(i);
      const nb = peers[j + 1] || peers[j - 1];
      return nb ? `mv-${nb.n}` : `lh-${i.sp || 'backlog'}-${i.s}`;
    }
    function moveTo(n, target, origin) {
      const p = P(); const i = itemOf(n);
      const fromSec = i.sp || 'backlog';
      const out = consume('move');
      if (out !== 'ok') {
        if (origin === 'task') { S.tk.err = { code: out, kind: 'move', retry: () => moveTo(n, target, 'task') }; render(['network', 'timeout'].includes(out) ? 'retry' : 'err-blk'); }
        else { S.fail = { sec: fromSec, n, code: out, retry: () => moveTo(n, target, 'board') }; render(['network', 'timeout'].includes(out) ? 'move-retry' : 'move-fail'); }
        say(`${t('plan.failed', { key: key(n) })}. ${t(`err.${out}.b`)}`);
        return;
      }
      S.fail = null;
      const before = { sp: i.sp, idx: p.items.indexOf(i) };
      const nextFocus = origin === 'task' ? 'pk-sprint' : successorFk(i);
      const apply = () => {
        p.items.splice(p.items.indexOf(i), 1); i.sp = target; p.items.push(i);
        if (S.tk && S.tk.n === n) addEv({ ev: ['item.ev.sprint', { from: before.sp, to: target }] });
        showToast({ n, before, where: whereName(target), from: whereName(before.sp) });
        render(nextFocus);
        say(t('plan.moved', { key: key(n), where: whereName(target) }));
      };
      const row = host.querySelector(`[data-row="${n}"]`);
      if (row && !isReduced()) { row.classList.add('is-leaving'); setTimeout(apply, ms('--dur-base')); } else apply();
    }
    function reorder(n, how) {
      const p = P(); const i = itemOf(n); const peers = peersOf(i); const j = peers.indexOf(i);
      const out = consume('move');
      if (out !== 'ok') { S.fail = { sec: i.sp || 'backlog', n, code: out, retry: () => reorder(n, how) }; render(['network', 'timeout'].includes(out) ? 'move-retry' : 'move-fail'); return; }
      S.fail = null;
      const target = how === 'top' ? peers[0] : how === 'up' ? peers[j - 1] : peers[j + 1];
      p.items.splice(p.items.indexOf(i), 1);
      const ti = p.items.indexOf(target);
      p.items.splice(how === 'down' ? ti + 1 : ti, 0, i);
      const np = peersOf(i).indexOf(i) + 1;
      S.isNew.landed = n;
      const lane = i.s; const sec = i.sp || 'backlog';
      if (phone) p.lane[sec] = lane;
      render(S.view === 'task' ? 'pk-sprint' : `mv-${n}`);
      say(t('plan.position', { key: key(n), pos: ord(np), total: peers.length, lane: t(`board.status.${lane}`) }));
    }
    /* the Undo slip: rendered in its own slot so re-renders never restart its 10 s */
    let toastT = null; let toastLeft = 0; let toastAt = 0;
    function showToast(x) {
      S.toast = x;
      const slot = $('[data-slot=toast]');
      slot.innerHTML = `<div class="utoast" role="status"><span class="utoast__msg"><b>${key(x.n)}</b> → ${esc(x.where)}</span><button type="button" class="utoast__undo" data-act="undo" data-fk="undo">${t('plan.undo')}${phone ? '' : `<kbd>${t('plan.undoKey')}</kbd>`}</button><span class="utoast__bar" aria-hidden="true"></span></div>`;
      const el = slot.firstElementChild;
      const hold = () => { if (toastT) { clearTimeout(toastT); toastT = null; toastLeft -= Date.now() - toastAt; } };
      const go = () => { if (!toastT && S.toast) { toastAt = Date.now(); toastT = setTimeout(hideToast, Math.max(toastLeft, 1500)); } };
      el.addEventListener('pointerenter', hold); el.addEventListener('focusin', hold);
      el.addEventListener('pointerleave', go); el.addEventListener('focusout', go);
      clearTimeout(toastT); toastT = null; toastLeft = ms('--undo-ms'); go();
    }
    function hideToast() { clearTimeout(toastT); toastT = null; S.toast = null; const slot = $('[data-slot=toast]'); if (slot) slot.innerHTML = ''; }
    function undo() {
      const x = S.toast; if (!x) return;
      const p = P(); const i = itemOf(x.n);
      p.items.splice(p.items.indexOf(i), 1); i.sp = x.before.sp; p.items.splice(x.before.idx, 0, i);
      hideToast();
      if (S.tk && S.tk.n === x.n) addEv({ ev: ['item.ev.sprint', { from: null, to: x.before.sp }] });
      const sec = x.before.sp || 'backlog';
      if (sec !== curId()) p.open[sec] = true;
      if (phone) p.lane[sec] = i.s;
      S.isNew.landed = x.n;
      render(S.view === 'task' ? 'pk-sprint' : `mv-${x.n}`);
      say(t('plan.undone', { key: key(x.n), where: whereName(x.before.sp) }));
    }
    function pickMenuItem(btn) {
      const m = S.menu;
      if (btn.getAttribute('aria-disabled') === 'true') { say(btn.dataset.why); return; }
      const [kind, val] = btn.dataset.mi.split(':');
      const n = m.n; const opener = m.opener;
      S.menu = null;
      if (kind === 'sp') { render(opener); moveTo(n, val || null, S.view === 'task' ? 'task' : 'board'); return; }
      if (kind === 'q') { render(opener); reorder(n, val); return; }
      const i = itemOf(n);
      if (kind === 'status') {
        const from = statusOf(i); if (val === from) { render(opener); return; }
        write('status', () => {
          if (val === 'closed') { i.closed = true; addEv({ ev: ['item.ev.closed', {}] }); } else { i.closed = false; addEv({ ev: ['item.ev.status', { from: from === 'closed' ? i.s : from, to: val }] }); i.s = val; }
          S.tk.changed = 'status';
          say(t('item.changedAria', { field: t('item.status'), to: t(`board.status.${val}`) }));
          return 'pk-status';
        });
      }
      if (kind === 'kind') {
        const from = i.k; if (val === from) { render(opener); return; }
        write('kind', () => { addEv({ ev: ['item.ev.kind', { from, to: val }] }); i.k = val; S.tk.changed = 'kind'; say(t('item.changedAria', { field: t('item.kind'), to: t(`board.kind.${val}`) })); return 'pk-kind'; });
      }
    }

    /* the task's own writes */
    function save(force) {
      const tk = S.tk; const i = itemOf(tk.n);
      if (tk.title.trim() === '' || tk.title.length > TITLE_MAX) { render('e-title'); return; }
      write('save', () => { i.t = tk.title.trim(); tk.edit = false; tk.draft = false; tk.theirs = false; tk.fieldErr = null; addEv({ ev: ['item.ev.edit', {}] }); say(t('item.saved')); return 'h1'; }, { force });
    }
    function cancelEdit() {
      const tk = S.tk; const i = itemOf(tk.n); const ex = EXTRA[tk.n];
      const changed = tk.title !== i.t || tk.body !== (ex && ex.body ? t(ex.body) : '');
      if (changed) { S.modal = 'discard'; render('dc-h'); return; }
      tk.edit = false; tk.err = null; render('edit');
    }

    /* the move to the console */
    let impTimer = null;
    function setImp(step, focus = 'im-h') {
      clearInterval(impTimer); S.imp = step; S.view = step === 'banner' ? 'board' : 'import'; S.proj = 'st';
      if (step === 'switched') { S.P.st.switched = true; S.isNew.stamp = true; focus = 'im-done'; } else if (step !== 'confirm') S.P.st.switched = false;
      if (step === 'confirm') { S.imp = 'ready'; S.view = 'import'; S.modal = 'confirm'; render('cf-h'); return; }
      render(step === 'banner' ? 'imp-start' : focus);
      if (step === 'copying') {
        S.copyN = 0; let said = 0;
        impTimer = setInterval(() => {
          S.copyN = Math.min(412, S.copyN + 37);
          const pct = Math.floor((S.copyN / 412) * 4) * 25;
          const bar = host.querySelector('.im-bar');
          if (bar) { bar.value = S.copyN; bar.previousElementSibling.textContent = plain(t('imp.copy.of', { a: S.copyN, b: 412 })); }
          if (pct > said) { said = pct; say(t('imp.announce', { p: pct })); }
          if (S.copyN >= 412) { clearInterval(impTimer); setTimeout(() => { if (S.imp === 'copying') setImp('ready'); }, 500); }
        }, 260);
      }
      if (step === 'switching') {
        S.swStep = 0;
        impTimer = setInterval(() => {
          S.isNew.sw = S.swStep; S.swStep += 1; render();
          if (S.swStep >= 5) { clearInterval(impTimer); setTimeout(() => { if (S.imp === 'switching') setImp('switched'); }, 500); }
        }, 700);
      }
    }

    /* ----- events ----- */
    host.addEventListener('click', (e) => {
      const mi = e.target.closest('[data-mi]');
      if (mi) { pickMenuItem(mi); return; }
      const tab = e.target.closest('[role=tab]');
      if (tab) { const [sec, lane] = tab.dataset.lane.split('|'); P().lane[sec] = lane; render(`lh-${sec}-${lane}`); return; }
      const el = e.target.closest('[data-act]'); if (!el) return;
      const act = el.dataset.act;
      if (el.tagName === 'A') e.preventDefault();
      if (el.getAttribute('aria-disabled') === 'true') {
        const why = el.getAttribute('aria-describedby'); const w = why && host.querySelector(`#${why}`);
        if (w) say(w.textContent);
        return;
      }
      const n = +el.dataset.n;
      switch (act) {
        case 'open': if (S.view === 'find') S.returnFk = 'f-q'; openTask(n, S.view === 'find' ? 'f-q' : `row-${n}`); break;
        case 'menu': if (S.menu) { closeMenu(); break; } openMenu('move', n, el.dataset.fk); break;
        case 'menu-close': closeMenu(); break;
        case 'pick': {
          const f = el.dataset.field;
          if (f === 'sprint') openMenu('move', S.tk.n, 'pk-sprint');
          else openMenu('picker', S.tk.n, el.dataset.fk, f);
          break;
        }
        case 'toggle': { const sec = el.dataset.sec; const p = P(); p.open[sec] = !p.open[sec]; render(`tg-${sec}`); break; }
        case 'undo': undo(); break;
        case 'move-retry': { const f = S.fail; S.fail = null; render(`sec-${f.sec}`); f.retry(); break; }
        case 'close-task': closeTask(); break;
        case 'board': if (S.view === 'task') closeTask(); else { S.view = 'board'; render('hd-find'); } break;
        case 'find': S.view = 'find'; S.tk = null; S.proj = 'tc'; render('f-q'); break;
        case 'new': S.nt = { step: 'form', sprint: G.nofuture ? 'backlog' : 'next', title: t('task.sample'), k: 'feature', opener: el.dataset.fk }; render('nt-title'); break;
        case 'nt-close': { const back = S.nt.opener; S.nt = null; render(back); break; }
        case 'nt-another': S.nt = { step: 'form', sprint: S.nt.sprint, title: '', k: 'feature', opener: S.nt.opener }; render('nt-title'); break;
        case 'nt-open': { const c = S.nt.created; S.nt = null; S.proj = 'tc'; openTask(c.n, 'hd-new'); break; }
        case 'sprint-new': {
          const p = P(); const last = p.sprints[p.sprints.length - 1];
          const d = new Date(2026, last.due[0] - 1, last.due[1] + 14);
          const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          S.sd = { name: `Sprint ${String(+last.name.slice(-2) + 1).padStart(2, '0')}`, date: iso, err: {}, opener: el.dataset.fk };
          render('sd-name'); break;
        }
        case 'sd-close': { const back = S.sd.opener; S.sd = null; render(back); break; }
        case 'edit': S.tk.edit = true; S.tk.title = itemOf(S.tk.n).t; render('e-title'); break;
        case 'edit-cancel': cancelEdit(); break;
        case 'draft-drop': { const i = itemOf(S.tk.n); S.tk.title = i.t; S.tk.draft = false; S.tk.edit = false; render('edit'); break; }
        case 'dc-keep': S.modal = null; render('e-title'); break;
        case 'dc-ok': { S.modal = null; const tk = S.tk; const ex = EXTRA[tk.n]; tk.edit = false; tk.err = null; tk.draft = false; tk.theirs = false; tk.title = itemOf(tk.n).t; tk.body = ex && ex.body ? t(ex.body) : ''; render('edit'); break; }
        case 'theirs': S.tk.theirs = !S.tk.theirs; render('theirs'); break;
        case 'mine': save(true); break;
        case 'retry': { const r = S.tk.err.retry; S.tk.err = null; render('h1'); r(); break; }
        case 'refresh': { const tk = S.tk; const i = itemOf(tk.n); tk.err = null; tk.dec = null; i.s = 'approved'; tk.hist.push({ who: 'pm', at: [11, 4], time: '14:04', ev: ['item.ev.status', { from: 'proposed', to: 'approved' }] }); render('h1'); break; }
        case 'approve': write('approve', () => { const i = itemOf(S.tk.n); S.tk.dec = 'approved'; i.s = 'approved'; addEv({ ev: ['item.ev.approved', {}], decision: true }); S.isNew.stamp = true; S.isNew.receipt = true; say(`${t('dec.done.approve')}. ${t('dec.doneMeta', { key: key(i.n), time: NOW })}`); return 'receipt'; }); break;
        case 'reject': S.reason = { text: '', err: false }; S.modal = 'reason'; render('rs-text'); break;
        case 'rs-close': S.modal = null; render('reject'); break;
        case 'reopen': write('status', () => { const i = itemOf(S.tk.n); i.closed = false; i.s = 'proposed'; addEv({ ev: ['item.ev.reopened', {}] }); S.tk.changed = 'status'; say(t('item.changedAria', { field: t('item.status'), to: t('board.status.proposed') })); return 'pk-status'; }); break;
        case 'reload': render('reload'); break;
        case 'try': S.find.q = el.dataset.q; S.find.state = 'idle'; render('f-q'); announceFind(); break;
        case 'imp-start': setImp('intro'); break;
        case 'imp-copy': setImp('copying'); break;
        case 'imp-stop': setImp('intro'); break;
        case 'imp-refail': setImp('ready'); break;
        case 'imp-cancel': setImp('banner'); break;
        case 'imp-switch': S.modal = 'confirm'; render('cf-h'); break;
        case 'cf-keep': S.modal = null; render(S.imp === 'swfail' ? 'sw-retry' : 'imp-switch'); break;
        case 'cf-ok': S.modal = null; if (consume('switch') !== 'ok') { setImp('swfail', 'sw-fail'); break; } setImp('switching'); break;
        case 'imp-board': S.imp = 'switched'; S.view = 'board'; render('hd-find'); break;
        case 'proj': { const name = el.dataset.p; S.proj = name === 'storify' ? 'st' : 'tc'; S.view = name === 'storify' && S.imp !== 'banner' && !S.P.st.switched ? 'import' : 'board'; S.tk = null; render(); break; }
        default: break;
      }
    });
    function announceFind() {
      const q = S.find.q.trim(); if (!q) return;
      const r = search(q);
      if (r.hits) say(r.hits.length ? t('find.results', { n: r.hits.length }) : t('find.none'));
      else if (r.other) say(t('find.otherRepo', { repo: r.other.repo, name: r.other.name }));
      else if (r.gh) say(t('find.notImported', { repo: r.gh.repo }));
    }
    let findT = null;
    host.addEventListener('input', (e) => {
      const b = e.target.dataset.bind; if (!b) return;
      const v = e.target.value;
      if (b === 'title' || b === 'body') { S.tk[b] = v; const c = host.querySelector(`#${uid}-${b === 'title' ? 'etc' : 'ebc'}`); const max = b === 'title' ? TITLE_MAX : TEXT_MAX; if ((v.length >= max * 0.8) !== !!c || (b === 'title' && (v.length > max) !== !!host.querySelector(`#${uid}-ete`))) render(); else if (c) c.textContent = t('item.counter', { n: v.length, max }); }
      if (b === 'comment') { const had = /^\s*\/\w+/m.test(S.tk.comment); S.tk.comment = v; const has = /^\s*\/\w+/m.test(v); if (had !== has) { S.isNew.cmd = has; render(); } }
      if (b === 'find') {
        S.find.q = v; S.find.state = 'typing';
        const slot = host.querySelector('[data-slot=results]'); if (slot) slot.innerHTML = findResultsHTML();
        clearTimeout(findT);
        findT = setTimeout(() => { S.find.state = 'idle'; const s2 = host.querySelector('[data-slot=results]'); if (s2) s2.innerHTML = findResultsHTML(); announceFind(); }, 300);
      }
      if (b === 'sd-name') { S.sd.name = v; const ok = host.querySelector('[data-fk="sd-ok"]'); if (ok && !S.sd.busy) ok.textContent = plain(t('sprintNew.ok', { sprint: v.trim() || '…' })); }
      if (b === 'sd-date') { S.sd.date = v; render(); }
      if (b === 'reason') S.reason.text = v;
      if (b === 'nt-title') S.nt.title = v;
    });
    host.addEventListener('change', (e) => {
      const b = e.target.dataset.bind;
      if (b === 'nt-sprint') { if (e.target.getAttribute('aria-disabled') === 'true') { const back = S.nt.sprint; S.nt.sprint = back; render(); say(host.querySelector(`#${e.target.getAttribute('aria-describedby')}`)?.textContent || ''); return; } S.nt.sprint = e.target.value; }
      if (b === 'nt-kind') S.nt.k = e.target.value;
    });
    host.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target.dataset.form;
      if (f === 'edit') save(false);
      if (f === 'comment') {
        const text = S.tk.comment.trim(); if (!text || offline()) { render('comment'); return; }
        write('comment', () => { addEv({ text, raw: true }); S.tk.comment = ''; say(t('item.commentSent')); return 'comment'; });
      }
      if (f === 'reason') {
        if (!S.reason.text.trim()) { S.reason.err = true; render('rs-text'); return; }
        const why = S.reason.text.trim(); S.modal = null;
        write('reject', () => { const i = itemOf(S.tk.n); S.tk.dec = 'rejected'; addEv({ ev: ['item.ev.rejected', { why }], decision: true, negative: true }); S.isNew.stamp = true; S.isNew.receipt = true; i.closed = false; say(`${t('dec.done.reject')}. ${t('dec.doneMeta', { key: key(i.n), time: NOW })}`); return 'receipt'; });
      }
      if (f === 'sprint') submitSprint();
      if (f === 'nt') submitTask();
    });
    function submitSprint() {
      const d = S.sd; const p = P(); if (offline() || d.busy) return;
      const last = p.sprints[p.sprints.length - 1];
      const lastDate = new Date(2026, last.due[0] - 1, last.due[1]);
      const dt = new Date(`${d.date}T12:00:00`);
      const err = {};
      const name = d.name.trim();
      if (!name) err.name = t('sprintNew.errNameEmpty');
      else if (p.sprints.some((s) => s.name.toLowerCase() === name.toLowerCase())) err.name = t('sprintNew.errName');
      if (Number.isNaN(dt.getTime()) || dt < TODAY) err.date = t('sprintNew.errPast');
      else if (dt <= lastDate) err.date = t('sprintNew.errBefore', { sprint: name || '…', prev: last.name, date: day(last.due) });
      d.err = err;
      if (err.name || err.date) { render(err.name ? 'sd-name' : 'sd-date'); return; }
      const out = consume('sprint');
      d.busy = true; d.wErr = null; render('sd-ok');
      setTimeout(() => {
        d.busy = false;
        if (out !== 'ok') { d.wErr = out; render('sd-err'); return; }
        const id = `s${Date.now()}`;
        p.sprints.push({ id, name, due: [dt.getMonth() + 1, dt.getDate()] });
        p.open[id] = true; S.sd = null; S.isNew.target = id;
        render(`sec-${id}`);
        const h = host.querySelector(`[data-fk="sec-${id}"]`); if (h) h.scrollIntoView({ block: 'center', behavior: isReduced() ? 'auto' : 'smooth' });
        say(t('sprintNew.done', { sprint: name, date: day([dt.getMonth() + 1, dt.getDate()]) }));
      }, 650);
    }
    function submitTask() {
      const n = S.nt; if (n.step !== 'form') return;
      if (!n.title.trim()) { render('nt-title'); return; }
      const out = consume('create');
      n.step = 'busy'; n.wErr = null; render('nt-send');
      setTimeout(() => {
        if (out !== 'ok') { n.step = 'form'; n.wErr = out; render('nt-err'); return; }
        const p = S.P.tc; const num = p.next; p.next += 1;
        const sp = n.sprint === 'current' ? p.sprints[0].id : n.sprint === 'next' && p.sprints[1] ? p.sprints[1].id : null;
        const it = { n: num, t: n.title.trim(), k: n.k, s: sp ? 'approved' : 'proposed', sp, tier: null, untrusted: false, closed: false };
        p.items.push(it);
        n.step = 'done'; n.created = it; S.isNew.stamp = true;
        render('nt-done');
        say(t('task.done.announce', { key: key(num, p), name: 'team-console' }));
      }, 700);
    }
    host.addEventListener('keydown', (e) => {
      const tg = e.target;
      const typing = tg.matches('input, textarea, select');
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        const form = tg.closest('form'); if (form) { e.preventDefault(); form.requestSubmit(); return; }
      }
      // menu keyboard: arrows, Home/End, Esc back to the opener, Tab closes
      const menu = tg.closest('[data-menu]');
      if (menu) {
        const items = [...menu.querySelectorAll('.mi')]; const j = items.indexOf(tg);
        let k = null;
        if (e.key === 'ArrowDown') k = (j + 1) % items.length;
        if (e.key === 'ArrowUp') k = (j - 1 + items.length) % items.length;
        if (e.key === 'Home') k = 0;
        if (e.key === 'End') k = items.length - 1;
        if (k !== null) { e.preventDefault(); items[k].focus(); return; }
        if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(); return; }
      }
      const tab = tg.closest('[role=tab]');
      if (tab && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) {
        const tabs = [...tab.parentElement.querySelectorAll('[role=tab]')]; const j = tabs.indexOf(tab);
        const k = e.key === 'ArrowRight' ? (j + 1) % tabs.length : e.key === 'ArrowLeft' ? (j - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : tabs.length - 1;
        e.preventDefault(); tabs[k].click(); return;
      }
      if (e.key === 'Tab') {
        const dlg = host.querySelector('[data-dialog]');
        if (dlg) {
          const f = [...dlg.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')].filter((x) => !x.disabled && x.offsetParent !== null && !(x.type === 'radio' && !x.checked));
          const j = f.indexOf(document.activeElement);
          if (e.shiftKey && j <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && j === f.length - 1) { e.preventDefault(); f[0].focus(); }
        }
      }
      if (e.key === 'Escape') {
        if (S.modal === 'discard') { S.modal = null; render('e-title'); return; }
        if (S.modal === 'reason') { S.modal = null; render('reject'); return; }
        if (S.modal === 'confirm') { S.modal = null; render('imp-switch'); return; }
        if (S.sd) { const back = S.sd.opener; S.sd = null; render(back); return; }
        if (S.nt) { const back = S.nt.opener; S.nt = null; render(back); return; }
        if (S.view === 'task' && !phone && !(S.tk && S.tk.edit && typing)) { closeTask(); return; }
        if (S.tk && S.tk.edit && typing) { cancelEdit(); return; }
      }
      if (e.key === 'Enter' && tg.dataset.bind === 'find') {
        const r = search(S.find.q.trim());
        if (r.exact && r.hits && r.hits.length === 1) { e.preventDefault(); openTask(r.hits[0].n, 'f-q'); }
        return;
      }
      if (phone || typing || e.metaKey && e.key !== 'z' || e.altKey) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && S.toast) { e.preventDefault(); undo(); return; }
      if (S.menu || S.modal || S.sd || S.nt || !P().switched) return;
      if (e.key === 't' || e.key === 'T') { e.preventDefault(); host.querySelector('[data-act=new]')?.click(); }
      if (e.key === '/') { e.preventDefault(); S.view = 'find'; S.tk = null; render('f-q'); }
    });
    addEventListener('resize', () => { if (S.menu) placeMenu(); });

    host.api = {
      render: () => { render(); if (S.toast) showToast(S.toast); },
      apply(screen) {
        hideToast(); clearInterval(impTimer);
        Object.assign(S, { menu: null, modal: null, sd: null, nt: null, fail: null, tk: null, find: { q: '', state: 'idle' } });
        if (screen === 'import') { setImp(G.imp); return; }
        S.proj = 'tc'; S.view = 'board';
        if (screen === 'task') { S.view = 'task'; S.tk = freshTask(VARIANT_N[G.variant]); S.paneQuiet = false; S.returnFk = `row-${S.tk.n}`; }
        if (screen === 'find') S.view = 'find';
        if (screen === 'new') S.nt = { step: 'form', sprint: G.nofuture ? 'backlog' : 'next', title: t('task.sample'), k: 'feature', opener: 'hd-new' };
        render();
      },
      reset() { S.P = { tc: project('tc'), st: project('st') }; S.imp = 'banner'; },
    };
    host.api.apply(G.screen);
  }

  /* ---------- page controls ---------- */
  hosts.forEach((h) => mountApp(h, h.dataset.app));
  const renderAll = () => hosts.forEach((h) => h.api.render());
  const pageChrome = Proto.page({ L, title: 'Team Console · #409', onLang: renderAll });
  const sel = (id) => document.getElementById(id);
  const CTRL = { 'd-screen': 'screen', 'd-data': 'data', 'd-var': 'variant', 'd-write': 'write', 'd-imp': 'imp' };
  function syncDemo() { Object.entries(CTRL).forEach(([id, k]) => { sel(id).value = G[k]; }); sel('d-freeze').checked = G.freeze; sel('d-nofuture').checked = G.nofuture; sel('d-draft').checked = G.draft; }
  const applyAll = () => hosts.forEach((h) => h.api.apply(G.screen));
  sel('d-screen').addEventListener('change', (e) => { G.screen = e.target.value; applyAll(); });
  sel('d-data').addEventListener('change', (e) => { G.data = e.target.value; renderAll(); });
  sel('d-var').addEventListener('change', (e) => { G.variant = e.target.value; G.screen = 'task'; syncDemo(); applyAll(); });
  sel('d-write').addEventListener('change', (e) => { G.write = e.target.value; });
  sel('d-imp').addEventListener('change', (e) => { G.imp = e.target.value; G.screen = 'import'; syncDemo(); applyAll(); });
  sel('d-freeze').addEventListener('change', (e) => { G.freeze = e.target.checked; renderAll(); });
  sel('d-nofuture').addEventListener('change', (e) => { G.nofuture = e.target.checked; hosts.forEach((h) => h.api.reset()); applyAll(); });
  sel('d-draft').addEventListener('change', (e) => { G.draft = e.target.checked; if (G.draft) { G.screen = 'task'; syncDemo(); } applyAll(); });
  document.querySelector('[data-reset]').addEventListener('click', () => {
    Object.assign(G, { screen: 'board', data: 'loaded', variant: 'progress', write: 'ok', imp: 'banner', freeze: false, nofuture: false, draft: false });
    hosts.forEach((h) => h.api.reset()); syncDemo(); applyAll();
  });
  syncDemo();
  pageChrome.fit();
  // Review hook: ?screen=task&variant=decision&data=stale&imp=ready opens that state at once.
  const q = new URLSearchParams(location.search);
  let hooked = false;
  [['screen', 'screen'], ['data', 'data'], ['variant', 'variant'], ['imp', 'imp'], ['write', 'write']].forEach(([qk, gk]) => { if (q.get(qk)) { G[gk] = q.get(qk); hooked = true; } });
  ['freeze', 'nofuture', 'draft'].forEach((k) => { if (q.get(k) === '1') { G[k] = true; hooked = true; } });
  if (hooked) { syncDemo(); hosts.forEach((h) => h.api.reset()); applyAll(); }
})();
