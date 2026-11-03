/* #108 Board by sprint: current, next and backlog. Design prototype runtime with mock data only (no network).
   In the app: the current sprint stays `tc-sprint-board` (#18); the next sprint and the backlog are sections of the same
   widget, each with its own load, lanes (`tc-lanes`, #134) and states; the row is `tc-sprint-item-list` with the kind
   word and the pending-request slip added. GitHub text is rendered through esc() only, as the app interpolates it. */
(() => {
  'use strict';
  const { isReduced, esc, I } = Proto;
  const L = Proto.i18n(I18N);
  const { t } = L;
  const months = () => I18N[L.lang].months;
  const day = ([m, d]) => (L.lang === 'ru' ? `${d} ${months()[m - 1]}` : `${months()[m - 1]} ${d}`);

  /* ---------- mock data: the wireframe's (#255), the repository as it stands in Sprint 03 ---------- */
  // [number, title, kind, status, tier, request?, trusted?]
  const CUR = { title: 'Sprint 03', due: [10, 13], issues: [
    [131, 'CI state per open PR on the board', 'feature', 'done', 'standard'],
    [132, 'Run state on the board', 'feature', 'done', 'standard'],
    [237, 'Environment name in the app title and icons', 'feature', 'done', 'light'],
    [306, 'PWA updates: take a new version when the page is quiet', 'feature', 'done', 'standard'],
    [108, 'Board by sprint: current, next and backlog', 'feature', 'approved', 'standard'],
    [107, 'Quick task capture from the phone, with a sprint request', 'feature', 'blocked', 'standard'],
    [29, 'Team commands: pause/resume, run now, sprint and priority controls', 'feature', 'in-progress', 'heavy'],
    [307, 'Date picker for the Move demo sheet', 'feature', 'in-progress', 'standard'],
    [244, 'Sheet focus lost after a 429 retry', 'bug', 'qa', 'light', { kind: 'priority', to: 'up', at: [10, 4] }],
    [311, 'Hash mismatch heals once, not in a loop', 'bug', 'qa', 'light'],
    [177, 'Remove the braces allowlist entry once a fix exists', 'chore', 'approved', 'light'],
  ] };
  const NEXT = { title: 'Sprint 04', due: [10, 27], issues: [
    [36, 'Web push client: subscribe button, iOS guide, tap routing and badge', 'feature', 'approved', 'standard'],
    [104, 'Environment setup: status and a step-by-step guide per item', 'feature', 'approved', 'heavy'],
    [198, 'Bundle size budget in CI', 'chore', 'approved', 'light'],
    [251, 'Offline banner overlaps the iPhone top bar', 'bug', 'proposed', 'light', null, false],
    [249, 'Export the sprint summary for the demo', 'feature', 'proposed', 'standard', { kind: 'sprint', to: 'current', at: [10, 5] }],
  ] };
  const BACK = [
    [253, 'Notes on a task from the phone', 'feature', 'proposed', 'standard', { kind: 'sprint', to: 'next', at: [10, 6] }],
    [250, 'Dark theme contrast on the CI chip', 'bug', 'proposed', 'light', { kind: 'sprint', to: 'backlog', at: [10, 3] }],
    [230, 'Search across projects', 'feature', 'proposed', 'heavy'],
    [214, 'Should the board show closed PRs from the last day?', 'question', 'blocked', 'standard'],
    [166, 'Keyboard shortcuts help sheet', 'wow', 'proposed', 'light'],
    [140, 'Unused CSS in the Mac sidebar', 'finding', 'approved', 'light', { kind: 'priority', to: 'down', at: [10, 2] }],
    [22, 'Run log', null, null, 'standard'],
  ];
  const LARGE = [...BACK, ...Array.from({ length: 68 }, (_, i) => [300 - i * 3, `Idea from the team ${i + 1}`, i % 4 === 0 ? 'chore' : 'feature', 'proposed', i % 3 === 0 ? 'light' : 'standard'])];
  const PAGE = 30;

  // statusColumnsOf() from @console/entities/sprint: core lanes always for the current sprint; next and backlog show
  // only lanes with issues, in the workflow order, then unknown labels, then No status.
  const ORDER = ['proposed', 'approved', 'in-progress', 'qa', 'blocked', 'done'];
  const CORE = ['approved', 'in-progress', 'qa', 'done'];
  const rank = (s) => { const i = ORDER.indexOf(s); return i !== -1 ? i : s === 'none' ? ORDER.length + 1 : ORDER.length; };
  function lanesOf(issues, core) {
    const by = new Map(core.map((s) => [s, []]));
    issues.forEach((x) => { const s = x[3] || 'none'; if (!by.has(s)) by.set(s, []); by.get(s).push(x); });
    // Pending requests first in their lane, then #18's order (by number).
    const pend = (x) => (G.req && x[5] ? 0 : 1);
    return [...by.entries()].sort(([a], [b]) => rank(a) - rank(b))
      .map(([key, list]) => ({ key, issues: [...list].sort((a, b) => pend(a) - pend(b) || a[0] - b[0]) }));
  }

  // Kit glyphs tier-light|standard|heavy (#134).
  const BAR1 = 'M5 14h2v6H5z'; const BAR2 = 'M11 9h2v11h-2z'; const BAR3 = 'M17 4h2v16h-2z';
  const TIER_PATHS = { light: `${BAR1}M11 20h2M17 20h2`, standard: `${BAR1}${BAR2}M17 20h2`, heavy: `${BAR1}${BAR2}${BAR3}` };
  const TIER_ICON = Object.fromEntries(Object.entries(TIER_PATHS).map(([k, d]) => [k, `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`]));
  const CAL = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/></svg>';

  /* ---------- demo state (page-wide) and per-app state (iPhone and Mac each keep their own) ---------- */
  const G = { cur: 'loaded', next: 'loaded', backlog: 'loaded', req: true };
  const fresh = () => ({ open: false, state: 'idle', lane: null, shown: {}, isNew: false });
  const hosts = [...document.querySelectorAll('[data-app]')];

  function mountApp(host, kind) {
    const uid = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    if (!host.S) host.S = { next: fresh(), backlog: fresh(), curLane: null, remember: { next: false, backlog: false } };
    const S = host.S;
    const say = (msg) => { const l = host.querySelector('[data-live]'); if (!l) return; l.textContent = ''; setTimeout(() => { l.textContent = Proto.plain(msg); }, 60); };

    const noNext = () => G.cur === 'nosprint' || G.next === 'none';
    const nameOf = (key) => (key === 'next' ? NEXT.title : t('board.sections.backlog'));
    const dataOf = (key) => {
      if (key === 'next') return G.next === 'empty' ? [] : NEXT.issues;
      return { empty: [], large: LARGE, partial: BACK.slice(0, 5) }[G.backlog] || BACK;
    };

    /* ----- a row ----- */
    const tierHTML = (tier) => {
      const name = `${t('board.tierLabel')} ${t(`board.tier.${tier}`)}`;
      return `<span class="tier-ico tier-ico--${tier}">${TIER_ICON[tier]}<span class="sr-only">, ${name}</span><span class="tier-tip" aria-hidden="true">${name}</span></span>`;
    };
    function rowHTML(x, i) {
      const [n, title, k, , tier, req, trusted] = x;
      const sub = [];
      if (k) sub.push(`<span class="kind"><span class="sr-only">, </span>${t(`board.kind.${k}`)}</span>`);
      if (trusted === false) sub.push(`<span class="chip-untr"><span class="sr-only">, </span>${t('board.untrusted')}</span>`);
      if (G.req && req) {
        const what = req.kind === 'sprint' ? t(`board.request.sprint.${req.to}`) : t(`board.request.priority.${req.to}`);
        sub.push(`<span class="req" data-testid="request"><i class="pend-dot" aria-hidden="true"></i><span><span class="sr-only">, </span>${what}<span class="req__when"> · ${t('board.request.waiting', { date: day(req.at) })}</span></span></span>`);
      }
      return `<li style="--i:${i}"><a class="bd-row" href="#github" data-act="gh" data-n="${n}"><span class="bd-row__num">#${n}</span><span class="bd-row__main"><span class="bd-row__title">${esc(title)}<span class="sr-only"> ${t('board.opensGitHub')}</span></span>${sub.length ? `<span class="bd-row__sub">${sub.join('')}</span>` : ''}</span>${tierHTML(tier)}</a></li>`;
    }
    function listHTML(key, lane) {
      if (!lane.issues.length) return `<p class="bd-empty">${I.check}<span>${t('board.laneEmpty')}</span></p>`;
      const st = S[key] || { shown: {} };
      const max = (st.shown && st.shown[lane.key]) || PAGE;
      const rest = lane.issues.length - max;
      const more = rest > 0 ? `<li class="sx-more-li"><button type="button" class="sx-more" data-more="${key}|${lane.key}"><span>${t('board.sections.more', { n: Math.min(rest, PAGE) })}</span><span class="sx-more__left">· ${t('board.sections.moreLeft', { n: rest })}</span></button></li>` : '';
      return `<ul class="bd-list">${lane.issues.slice(0, max).map(rowHTML).join('')}${more}</ul>`;
    }

    /* ----- lanes: stacked on the Mac, a tab list per section on the phone (#134); one lane has no switcher ----- */
    const laneName = (s) => t(`board.status.${s}`);
    const headHTML = (id, name, count, cls = '') => `<div class="bd-lane__head${cls}" role="heading" aria-level="3" id="${id}"><span class="bd-lane__title">${esc(name)}</span> <span class="bd-lane__count">${count}</span></div>`;
    function lanesHTML(key, lanes, section) {
      const aria = esc(Proto.plain(t('board.lanes', { section })));
      if (kind === 'mac' || lanes.length < 2) {
        return `<div class="bd-lanes" role="group" aria-label="${aria}">${lanes.map((c) => { const hid = `${uid}-${key}-${c.key}-h`; return `<div class="bd-lane" role="group" aria-labelledby="${hid}">${headHTML(hid, laneName(c.key), c.issues.length)}${listHTML(key, c)}</div>`; }).join('')}</div>`;
      }
      const keep = key === 'current' ? S.curLane : S[key].lane;
      const sel = lanes.some((c) => c.key === keep) ? keep : (lanes.find((c) => c.issues.length) || lanes[0]).key;
      const tabs = lanes.map((c) => { const on = c.key === sel; const b = `${uid}-${key}-${c.key}`; return `<button type="button" role="tab" class="lt" id="${b}-tab" aria-controls="${b}-panel" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-lane="${key}|${c.key}"><span class="lt__name">${esc(laneName(c.key))}</span> <span class="lt__count">${c.issues.length}</span></button>`; }).join('');
      const panels = lanes.map((c) => { const on = c.key === sel; const b = `${uid}-${key}-${c.key}`; return `<div class="bd-panel" role="tabpanel" id="${b}-panel" aria-labelledby="${b}-tab"${c.issues.length ? '' : ' tabindex="0"'}${on ? '' : ' hidden'}>${headHTML(`${b}-h`, laneName(c.key), c.issues.length, ' sr-only')}${listHTML(key, c)}</div>`; }).join('');
      return `<div class="bd-lanes bd-lanes--tabs"><div class="lt-list" role="tablist" aria-label="${aria}">${tabs}</div>${panels}</div>`;
    }

    /* ----- the current sprint: #18 unchanged, plus "N open" and the kind and request on rows ----- */
    function currentHTML() {
      const hid = `${uid}-h-current`;
      if (G.cur === 'nosprint') {
        return `<section class="sx" aria-labelledby="${hid}"><div class="sx-head"><div class="sx-head__text"><h2 class="sx-title" id="${hid}" tabindex="-1"><span class="sx-kicker">${t('board.sections.current')}</span><span class="sx-name">${t('board.noSprintTitle')}</span></h2></div></div>
          <div class="sx-state sx-state--empty">${I.clock}<p class="sx-state__t">${t('board.noSprintTitle')}</p><p class="sx-state__h">${t('board.noSprintHint')}</p></div></section>`;
      }
      const done = CUR.issues.filter((x) => x[3] === 'done').length;
      const open = CUR.issues.length - done;
      const legend = `<p class="tier-legend"><span>${t('board.tierLabel')}</span>${['light', 'standard', 'heavy'].map((x) => `<span class="tier-legend__item"><span class="tier-ico tier-ico--${x}">${TIER_ICON[x]}</span>${t(`board.tier.${x}`)}</span>`).join('')}</p>`;
      const stats = `<dl class="bd-stats"><div><dt>${t('board.stat.done')}</dt><dd>${t('board.stat.doneValue', { shipped: done, planned: CUR.issues.length })}</dd></div><div><dt>${t('board.stat.stillOpen')}</dt><dd>${open}</dd></div><div><dt>${t('board.stat.openPrs')}</dt><dd>2</dd></div><div><dt>${t('board.stat.ci')}</dt><dd><span class="stat-word stat-ok">${I.check}${t('board.ci.pass')}</span></dd></div><div><dt>${t('board.stat.runs')}</dt><dd><span class="stat-word">${I.play}${t('board.team.running')}</span></dd></div></dl>`;
      return `<section class="sx" aria-labelledby="${hid}"><div class="sx-head"><div class="sx-head__text"><h2 class="sx-title" id="${hid}" tabindex="-1"><span class="sx-kicker">${t('board.sections.current')}</span><span class="sx-name">${esc(CUR.title)}</span></h2>
        <p class="sx-meta">${CAL}<span>${t('board.demo', { date: day(CUR.due) })}</span><span class="sx-meta__sep" aria-hidden="true">·</span><span>${t('board.sections.open', { n: open })}</span></p></div>
        <button type="button" class="btn btn--sm">${t('board.moveDemo')}</button></div>
        ${stats}${legend}${lanesHTML('current', lanesOf(CUR.issues, CORE), CUR.title)}</section>`;
    }

    /* ----- the next sprint and the backlog: folders, loaded on demand ----- */
    function stateHTML(cls, icon, title, hint, retryKey, alert) {
      const act = retryKey ? `<div class="sx-state__act"><button type="button" class="btn btn--sm" data-retry="${retryKey}">${I.refresh}${t('ui.error.retry')}</button></div>` : '';
      return `<div class="sx-state sx-state--${cls}"${alert ? ' role="alert"' : ''}>${icon}<p class="sx-state__t">${title}</p><p class="sx-state__h">${hint}</p>${act}</div>`;
    }
    function folderHTML(key) {
      const st = S[key];
      const isNext = key === 'next';
      const hid = `${uid}-h-${key}`;
      const bodyId = `${uid}-body-${key}`;
      const name = nameOf(key);
      if (isNext && noNext()) {
        return `<section class="sx sx--folder" id="${uid}-sx-${key}" aria-labelledby="${hid}"><div class="sx-head"><div class="sx-head__text"><h2 class="sx-title" id="${hid}" tabindex="-1"><span class="sx-name">${t('board.sections.next')}</span></h2><p class="sx-note">${t('board.sections.next.none')}</p></div></div></section>`;
      }
      const data = dataOf(key);
      const meta = [];
      if (isNext) meta.push(`${CAL}<span>${t('board.demo', { date: day(NEXT.due) })}</span>`);
      // A partial backlog shows no count: never a wrong number.
      if (st.state === 'loaded' && !(key === 'backlog' && G.backlog === 'partial')) meta.push(`<span>${t('board.sections.open', { n: data.length })}</span>`);
      const metaHTML = meta.length ? `<p class="sx-meta">${meta.join('<span class="sx-meta__sep" aria-hidden="true">·</span>')}</p>` : '';
      const title = isNext ? esc(NEXT.title) : t('board.sections.backlogTitle');
      const kicker = isNext ? t('board.sections.next') : t('board.sections.backlog');
      const label = Proto.plain(t(st.open ? 'board.sections.hideAria' : 'board.sections.showAria', { section: name }));
      const btn = `<button type="button" class="btn btn--sm sx-toggle" data-toggle="${key}" aria-expanded="${st.open}" aria-controls="${bodyId}" aria-label="${esc(label)}">${t(st.open ? 'board.sections.hide' : 'board.sections.show')}${I.down}</button>`;
      let inner = '';
      if (st.open) {
        if (st.state === 'loading') {
          const skel = '<li><div class="skel-row"><span class="skel skel--num"></span><span class="skel-stack"><span class="skel skel--c"></span><span class="skel skel--d"></span></span><span class="skel skel--tier"></span></div></li>';
          inner = `<div aria-busy="true"><p class="sx-busy"><span class="ring" aria-hidden="true"></span>${t('board.sections.loading', { section: name })}</p></div><ul class="bd-list" aria-hidden="true">${skel.repeat(3)}</ul>`;
        } else if (st.state === 'error') inner = stateHTML('error', I.warn, t('board.sections.error.title', { section: name }), t('board.sections.error.hint'), key, true);
        else if (st.state === 'rate') inner = stateHTML('wait', I.clock, t('board.sections.rate.title'), t('board.sections.rate.hint', { time: '14:06' }), key, true);
        else if (st.state === 'offline') inner = stateHTML('offline', I.wifi, t('board.sections.offline.title'), t('board.sections.offline.hint'), key, true);
        else if (st.state === 'loaded' && !data.length) {
          inner = isNext
            ? stateHTML('empty', I.check, t('board.sections.next.emptyTitle', { sprint: NEXT.title }), t('board.sections.next.emptyHint'))
            : stateHTML('empty', I.check, t('board.sections.backlog.emptyTitle'), t('board.sections.backlog.emptyHint'));
        } else if (st.state === 'loaded') {
          const partial = key === 'backlog' && G.backlog === 'partial'
            ? `<p class="sx-partial"><span>${t('board.sections.partial', { n: data.length })}</span><a class="ext" href="#github" data-act="gh">${t('board.sections.openOnGitHub')}${I.ext}<span class="sr-only"> ${t('board.opensGitHub')}</span></a></p>` : '';
          inner = partial + lanesHTML(key, lanesOf(data, []), name);
        }
      }
      const body = st.open ? `<div class="sx-body${st.isNew ? ' is-new' : ''}" id="${bodyId}">${inner}</div>` : `<div id="${bodyId}" hidden></div>`;
      return `<section class="sx sx--folder${st.open ? ' is-open' : ''}" id="${uid}-sx-${key}" aria-labelledby="${hid}"><div class="sx-head"><div class="sx-head__text"><h2 class="sx-title" id="${hid}" tabindex="-1"><span class="sx-kicker">${kicker}</span><span class="sx-name">${title}</span></h2>${metaHTML}</div>${btn}</div>${body}</section>`;
    }

    function boardHTML() {
      const tail = `<div class="bd-tail"><div class="bd-lane__head" role="heading" aria-level="2">${t('board.pulls')} <span class="bd-lane__count">2</span></div><div class="bd-tail__line"><span>#330 · #329</span><span>#18</span></div>
        <div class="bd-lane__head" role="heading" aria-level="2">${t('board.runs')} <span class="bd-lane__count">5</span></div><div class="bd-tail__line"><span>slot-pm · slot-dev · slot-qa</span><span>#132</span></div></div>`;
      return `<div class="bd">${currentHTML()}${folderHTML('next')}${folderHTML('backlog')}${tail}</div>`;
    }

    const navItems = [['inbox', 'questions'], ['chat', 'chat'], ['board', 'board'], ['stack', 'artifacts'], ['play', 'demo']];
    function render() {
      const scroller = host.querySelector('.bd-scroll');
      const top = scroller ? scroller.scrollTop : 0;
      if (kind === 'phone') {
        host.innerHTML = `<div class="p-status" aria-hidden="true"><span>9:41</span><span class="p-island"></span><span class="p-status__icons">${I.bars}${I.battery}</span></div>
          <header class="p-head bd-top"><button type="button" class="bd-proj" aria-label="${esc(t('nav.switch', { name: 'team-console' }))}" aria-haspopup="dialog">team-console${I.down}</button><span class="bd-top__acts"><button type="button" class="bd-icon" aria-label="${esc(t('nav.commands'))}">${I.sliders}</button><button type="button" class="bd-icon" aria-label="${esc(t('nav.settings'))}">${I.gear}</button></span></header>
          <div class="bd-scroll" data-slot="board">${boardHTML()}</div>
          <nav class="tabs bd-tabs" aria-label="${esc(t('nav.sections'))}">${navItems.map(([ico, k]) => `<button type="button"${k === 'board' ? ' aria-current="page"' : ''}>${I[ico]}<span>${t(`nav.${k}`)}</span></button>`).join('')}</nav>
          <div class="home-ind" aria-hidden="true"></div><div class="sr-only" aria-live="polite" data-live></div>`;
      } else {
        host.innerHTML = `<div class="win"><div class="win__bar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="win__title">Team Console</span></div>
          <div class="win__body">
            <nav class="sidebar" aria-label="${esc(t('nav.projects'))}"><div class="brand">${I.mark}<span>${t('nav.app')}</span></div>
              <ul class="side-list side-list--top"><li><button type="button" class="side-item">${I.inbox}<span>${t('nav.waiting')}</span></button></li><li><button type="button" class="side-item">${I.grid}<span>${t('nav.all')}</span></button></li></ul>
              <div class="side-label">${t('nav.projects')}</div>
              <ul class="side-list">${['ghost', 'private-product', 'team-console'].map((p) => `<li><button type="button" class="side-item"${p === 'team-console' ? ' aria-current="true"' : ''}><span class="side-prod__label">${p}</span></button></li>`).join('')}</ul></nav>
            <section class="convo bd-mac"><header class="convo__head"><div class="convo__title"><h1 class="bd-mac__name">team-console</h1></div>
              <nav class="bd-seg" aria-label="${esc(t('nav.sections'))}">${navItems.map(([ico, k]) => `<button type="button"${k === 'board' ? ' aria-current="page"' : ''}>${I[ico]}<span>${t(`nav.${k}`)}</span></button>`).join('')}</nav></header>
              <div class="bd-scroll" data-slot="board">${boardHTML()}</div></section>
          </div><div class="sr-only" aria-live="polite" data-live></div></div>`;
      }
      const sc = host.querySelector('.bd-scroll');
      if (sc) sc.scrollTop = top;
      S.next.isNew = false; S.backlog.isNew = false;
    }
    const focus = (sel) => { const el = sel && host.querySelector(sel); if (el) el.focus({ preventScroll: true }); };

    /* ----- behaviour ----- */
    function load(key, after) {
      const st = S[key];
      st.state = 'loading';
      const outcome = G[key];
      render(); focus(after === undefined ? `[data-toggle="${key}"]` : after);
      say(t('board.sections.loading', { section: nameOf(key) }));
      if (outcome === 'loading') return;
      clearTimeout(st.timer);
      st.timer = setTimeout(() => {
        if (!st.open) return;
        // Focus stays where the owner left it (the disclosure button, as a rule); only the result is announced.
        const a = document.activeElement;
        const keepSel = a && host.contains(a) && a.dataset.toggle ? `[data-toggle="${a.dataset.toggle}"]` : a && host.contains(a) && a.dataset.retry ? `[data-toggle="${key}"]` : null;
        st.state = ['error', 'rate', 'offline'].includes(outcome) ? outcome : 'loaded';
        st.isNew = true;
        render(); focus(keepSel);
        const name = nameOf(key); const data = dataOf(key);
        if (st.state === 'loaded') {
          say(data.length ? t('board.sections.loaded', { section: name, n: data.length })
            : key === 'next' ? t('board.sections.next.emptyTitle', { sprint: name }) : t('board.sections.backlog.emptyTitle'));
        } else if (st.state === 'error') say(t('board.sections.error.title', { section: name }));
        else if (st.state === 'rate') say(t('board.sections.rate.title'));
        else say(t('board.sections.offline.title'));
        if (st.onLoaded) { const f = st.onLoaded; st.onLoaded = null; f(); }
      }, 900);
    }
    // Scroll only the board's own scroller (the app's <main>), the heading just below the top bar.
    function scrollToSection(sx, smooth) {
      const sc = host.querySelector('.bd-scroll'); if (!sc) return;
      const top = sx.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 16;
      sc.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
    }
    host.api = {
      render,
      load: (key) => load(key, null),
      reopen() {
        // A new visit: open sections are remembered per project on this device and load by themselves.
        const keep = { ...S.remember };
        S.next = fresh(); S.backlog = fresh(); render();
        ['next', 'backlog'].forEach((k) => { if (keep[k] && !(k === 'next' && noNext())) { S[k].open = true; load(k, null); } });
        const sc = host.querySelector('.bd-scroll'); if (sc) sc.scrollTop = 0;
      },
      deep(key) {
        // /p/team-console/board?section=backlog: opens, loads, scrolls the heading below the top bar and focuses it.
        S[key].open = true; S.remember[key] = true;
        S[key].onLoaded = () => {
          const sx = host.querySelector(`#${uid}-sx-${key}`); const h = host.querySelector(`#${uid}-h-${key}`);
          if (!sx || !h) return;
          scrollToSection(sx, !isReduced());
          h.focus({ preventScroll: true });
          sx.classList.add('is-target');
        };
        load(key, null);
        const sx = host.querySelector(`#${uid}-sx-${key}`); if (sx) scrollToSection(sx, false);
      },
    };

    render();
    host.addEventListener('pointerover', () => host.classList.remove('tips-off'));
    host.addEventListener('focusin', () => host.classList.remove('tips-off'));
    host.addEventListener('click', (e) => {
      const tg = e.target.closest('[data-toggle]');
      if (tg) {
        const key = tg.dataset.toggle; const st = S[key];
        st.open = !st.open; S.remember[key] = st.open;
        if (st.open && st.state === 'idle') { load(key); return; }
        // Loaded once in this visit: Hide and Show again do not reload.
        if (st.open && st.state === 'loaded') st.isNew = true;
        render(); focus(`[data-toggle="${key}"]`);
        return;
      }
      const rt = e.target.closest('[data-retry]');
      // While the section reloads, focus waits on its disclosure button (the Try again button is gone for that time).
      if (rt) { load(rt.dataset.retry); return; }
      const mo = e.target.closest('[data-more]');
      if (mo) {
        const [key, lane] = mo.dataset.more.split('|'); const st = S[key];
        const first = st.shown[lane] || PAGE;
        st.shown[lane] = first + PAGE;
        render();
        // Focus the first new row, so the next Tab continues the list.
        const list = host.querySelector(`[data-more="${key}|${lane}"]`)?.closest('.bd-list') || [...host.querySelectorAll(`#${uid}-body-${key} .bd-list`)].find((l) => l.children.length > first);
        const row = list && list.querySelectorAll('.bd-row')[first];
        if (row) row.focus();
        return;
      }
      const tab = e.target.closest('[role=tab]');
      if (tab) { selectLane(tab, false); return; }
      if (e.target.closest('a[data-act=gh]')) e.preventDefault();
    });
    function selectLane(tab, moveFocus) {
      const [key, lane] = tab.dataset.lane.split('|');
      const tabs = [...tab.parentElement.querySelectorAll('[role=tab]')];
      const from = tabs.findIndex((x) => x.getAttribute('aria-selected') === 'true'); const to = tabs.indexOf(tab);
      if (key === 'current') S.curLane = lane; else S[key].lane = lane;
      if (to === from) { if (moveFocus) tab.focus(); return; }
      tabs.forEach((x, i) => { x.setAttribute('aria-selected', String(i === to)); x.tabIndex = i === to ? 0 : -1; });
      const panels = [...tab.closest('.bd-lanes--tabs').querySelectorAll('[role=tabpanel]')];
      panels.forEach((p, i) => { p.hidden = i !== to; });
      if (moveFocus) tab.focus();
      const dir = to > from ? 1 : -1;
      const frames = isReduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: `translateX(${dir * 8}px)` }, { opacity: 1, transform: 'none' }];
      Proto.play(panels[to], frames, { duration: Proto.ms(isReduced() ? '--dur-fade' : '--dur-fast'), easing: Proto.cssVar('--ease-enter') });
    }
    host.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { host.classList.add('tips-off'); return; }
      const tab = e.target.closest('[role=tab]');
      if (!tab) return;
      const tabs = [...tab.parentElement.querySelectorAll('[role=tab]')];
      const i = tabs.indexOf(tab); let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      if (e.key === 'Home') j = 0;
      if (e.key === 'End') j = tabs.length - 1;
      if (j !== null) { e.preventDefault(); selectLane(tabs[j], true); }
    });
  }

  /* ---------- page controls ---------- */
  hosts.forEach((h) => mountApp(h, h.dataset.app));
  const renderAll = () => hosts.forEach((h) => h.api.render());
  const pageChrome = Proto.page({ L, title: 'Team Console · #108', onLang: renderAll });
  const sel = (id) => document.getElementById(id);
  const syncDemo = () => { sel('d-cur').value = G.cur; sel('d-next').value = G.next; sel('d-back').value = G.backlog; sel('d-req').checked = G.req; };
  // A changed outcome applies to the next load; a section that is open reloads with it at once.
  const outcome = (key, v) => {
    G[key] = v;
    hosts.forEach((h) => {
      const st = h.S[key]; st.shown = {};
      if (st.open && !(key === 'next' && (G.cur === 'nosprint' || G.next === 'none'))) h.api.load(key);
      else { if (!st.open) st.state = 'idle'; h.api.render(); }
    });
  };
  sel('d-cur').addEventListener('change', (e) => { G.cur = e.target.value; renderAll(); });
  sel('d-next').addEventListener('change', (e) => outcome('next', e.target.value));
  sel('d-back').addEventListener('change', (e) => outcome('backlog', e.target.value));
  sel('d-req').addEventListener('change', (e) => { G.req = e.target.checked; renderAll(); });
  sel('d-reopen').addEventListener('click', () => hosts.forEach((h) => h.api.reopen()));
  sel('d-deep').addEventListener('click', () => hosts.forEach((h) => h.api.deep('backlog')));
  document.querySelector('[data-reset]').addEventListener('click', () => {
    Object.assign(G, { cur: 'loaded', next: 'loaded', backlog: 'loaded', req: true });
    hosts.forEach((h) => { Object.assign(h.S, { next: fresh(), backlog: fresh(), curLane: null, remember: { next: false, backlog: false } }); h.api.render(); });
    syncDemo();
  });
  syncDemo();
  pageChrome.fit();
  // Screenshot / review hook: ?open=next,backlog opens those sections at once (no network in the prototype).
  const q = new URLSearchParams(location.search);
  (q.get('open') || '').split(',').filter((k) => k === 'next' || k === 'backlog').forEach((k) => hosts.forEach((h) => h.querySelector(`[data-toggle="${k}"]`)?.click()));
})();
