/* #134 Board on the phone: a lane switcher (tab list) replaces the sideways lane row, so the page under a short
   lane is not as tall as the longest lane. Design prototype runtime with mock data only (QA's #129 fixture).
   In the app the switcher belongs to the kit's `tc-lanes` (phone breakpoint only); the widget is unchanged. */
(() => {
  'use strict';
  const { isReduced, cssVar, ms, esc, play, I } = Proto;
  const L = Proto.i18n(I18N);
  const { t } = L;

  /* ---------- mock data: GitHub text is rendered through esc() only, as the app interpolates it ---------- */
  const issue = (number, status, tier, title) => ({ number, status, tier, title });
  const SPRINT01 = [
    issue(3, 'done', 'heavy', 'Nx workspace with the Angular PWA shell and FSD boundaries'),
    issue(4, 'approved', 'standard', 'Bilingual interface (ru, en) from the first component'),
    issue(5, 'done', 'standard', 'Contract CI: lint, test, build, security'),
    issue(6, 'done', 'heavy', 'API and hooks Workers skeleton with D1'),
    issue(7, 'done', 'standard', 'Deploy workflow and step-by-step owner checklist'),
    issue(8, 'done', 'standard', 'Cloudflare Access JWT verification'),
    issue(9, 'done', 'standard', 'GitHub client on the console app’s installation tokens (ADR 0003)'),
    issue(10, 'in-progress', 'standard', 'Owner grammar library and the answer endpoint'),
    issue(12, 'approved', 'standard', 'GitHub webhook receiver'),
    issue(13, 'done', 'heavy', 'Design kit, tokens and Storybook (Paper Desk)'),
    issue(15, 'done', 'standard', 'Project registry API: add, archive, setup status'),
    issue(16, 'approved', 'standard', 'Questions and cross-project Needs you'),
    issue(18, 'approved', 'standard', 'Sprint board (read-only)'),
    issue(21, 'blocked', 'standard', 'Аккаунт Cloudflare и токены для деплоя'),
    issue(23, 'in-progress', 'heavy', 'Spaces shell: project routing, switcher and restored state'),
    issue(24, 'blocked', 'standard', 'Settings: GitHub connection and projects'),
    issue(34, 'done', 'standard', 'UI kit primitives and Storybook (Paper Desk)'),
    issue(35, 'in-progress', 'standard', 'Read models: inbox, questions, sprint and needs-you'),
    issue(46, 'blocked', 'standard', 'Переключить GitHub Pages на GitHub Actions'),
    issue(59, 'done', 'standard', 'Connect GitHub: owner user access token flow (ADR 0003)'),
  ];
  const EARLY = [
    issue(101, 'approved', 'standard', 'Board by sprint: current, next and backlog'),
    issue(104, 'approved', 'light', 'Sprint request from the chat'),
    issue(107, 'approved', 'standard', 'Pending sprint request line'),
    issue(110, 'approved', 'heavy', 'Team commands, part 2: the full status card'),
    issue(114, 'in-progress', 'standard', 'Team commands, part 1: pause/resume and run now'),
    issue(134, 'proposed', 'light', 'Board on the phone: lanes row is as tall as the tallest lane'),
  ];
  const UNKNOWN = [
    ...SPRINT01.slice(0, 8),
    issue(61, 'waiting-for-the-owner-to-decide-on-pricing', 'light', 'Pick the free tier for push notifications'),
    issue(62, null, 'standard', 'Issue without any status label'),
  ];
  const NEXT = [
    issue(108, 'approved', 'standard', 'Board by sprint: current, next and backlog'),
    issue(107, 'approved', 'light', 'Sprint request from the chat'),
    issue(110, 'proposed', 'heavy', 'Team commands, part 2: the full status card'),
    issue(111, 'proposed', 'standard', 'Owner checklist on the phone'),
  ];
  const BACKLOG = [
    issue(70, null, 'light', 'Offline read of the last board'),
    issue(71, null, 'standard', 'Search across projects'),
    issue(72, null, 'standard', 'Weekly digest e-mail'),
  ];
  const PULLS = [
    { number: 45, title: 'chore(devops): publish docs/design to GitHub Pages via Actions' },
    { number: 40, title: 'docs(design): UX wireframe for #29 team commands' },
  ];

  // statusColumnsOf() from @console/entities/sprint: core lanes always, others only with an issue, workflow order.
  const STATUS_ORDER = ['proposed', 'approved', 'in-progress', 'qa', 'blocked', 'done'];
  const CORE = ['approved', 'in-progress', 'qa', 'done'];
  const KNOWN = new Set([...STATUS_ORDER, 'none']);
  const rank = (s) => { const i = STATUS_ORDER.indexOf(s); return i !== -1 ? i : s === 'none' ? STATUS_ORDER.length + 1 : STATUS_ORDER.length; };
  function columnsOf(issues, core = CORE) {
    const lanes = new Map(core.map((s) => [s, []]));
    issues.forEach((x) => { const s = x.status ?? 'none'; if (!lanes.has(s)) lanes.set(s, []); lanes.get(s).push(x); });
    return [...lanes.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .map(([status, list]) => ({ key: status, issues: [...list].sort((a, b) => a.number - b.number) }));
  }
  const laneName = (s) => (KNOWN.has(s) ? t(`board.status.${s}`) : s);

  function sections(data) {
    if (data === 's108') {
      return [
        { key: 'cur', title: `Sprint 01 · ${t('p108.current')}`, columns: columnsOf(SPRINT01), issues: SPRINT01 },
        { key: 'next', title: `Sprint 02 · ${t('p108.next')}`, columns: columnsOf(NEXT, []), issues: NEXT },
        { key: 'back', title: t('p108.backlog'), columns: columnsOf(BACKLOG, []), issues: BACKLOG },
      ];
    }
    const issues = data === 'early' ? EARLY : data === 'unknown' ? UNKNOWN : SPRINT01;
    return [{ key: 'cur', title: 'Sprint 01', columns: columnsOf(issues), issues }];
  }

  const G = { version: 'new', data: 'sprint' };
  const hosts = [...document.querySelectorAll('[data-app]')];

  /* ---------- one app instance (iPhone or Mac) ---------- */
  function mountApp(host, kind) {
    const uid = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    // The selected lane per section: kept across refreshes, reset to the default when that lane is gone.
    if (!host.selected) host.selected = {};
    const selected = host.selected;

    const rowHTML = (x, withTier) => `<li><a class="bd-row" href="#github" data-act="gh"><span class="bd-row__num">#${x.number}</span><span class="bd-row__title">${esc(x.title)}<span class="sr-only"> ${t('board.opensGitHub')}</span></span>${withTier ? `<span class="tier tier--${x.tier}"><span class="sr-only">${t('board.tierLabel')} </span>${t(`board.tier.${x.tier}`)}</span>` : ''}</a></li>`;
    const bodyHTML = (col) => (col.issues.length
      ? `<ul class="bd-list">${col.issues.map((x) => rowHTML(x, true)).join('')}</ul>`
      : `<p class="bd-empty">${I.check}<span>${t('board.laneEmpty')}</span></p>`);
    const headHTML = (id, name, count, level, cls = '') => `<div class="bd-lane__head${cls}" role="heading" aria-level="${level}" id="${id}"><span class="bd-lane__title">${esc(name)}</span> <span class="bd-lane__count">${count}</span></div>`;
    const laneHTML = (sec, col, extra = '') => {
      const hid = `${uid}-${sec.key}-${col.key}-h`;
      return `<div class="bd-lane" role="group" aria-labelledby="${hid}"${extra}>${headHTML(hid, laneName(col.key), col.issues.length, 3)}${bodyHTML(col)}</div>`;
    };

    // Default lane: the first one with issues, else the first.
    const defaultKey = (cols) => (cols.find((c) => c.issues.length > 0) || cols[0]).key;
    const selectedOf = (sec) => {
      const keep = selected[sec.key];
      return sec.columns.some((c) => c.key === keep) ? keep : defaultKey(sec.columns);
    };

    function lanesHTML(sec) {
      const aria = esc(t('board.lanes'));
      if (kind === 'mac' || sec.columns.length < 2) {
        return `<div class="bd-lanes bd-lanes--stack" role="group" aria-label="${aria}">${sec.columns.map((c) => laneHTML(sec, c)).join('')}</div>`;
      }
      if (G.version === 'old') {
        return `<div class="bd-lanes bd-lanes--swipe" role="group" aria-label="${aria}" tabindex="0" data-swipe>${sec.columns.map((c) => laneHTML(sec, c)).join('')}</div>`;
      }
      const sel = selectedOf(sec);
      const tabs = sec.columns.map((c) => {
        const on = c.key === sel; const base = `${uid}-${sec.key}-${c.key}`;
        return `<button type="button" role="tab" class="lt" id="${base}-tab" aria-controls="${base}-panel" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-key="${esc(c.key)}"><span class="lt__name">${esc(laneName(c.key))}</span> <span class="lt__count">${c.issues.length}</span></button>`;
      }).join('');
      const panels = sec.columns.map((c) => {
        const on = c.key === sel; const base = `${uid}-${sec.key}-${c.key}`;
        // An empty lane has nothing focusable, so the panel itself takes Tab and reads "Nothing here".
        return `<div class="bd-panel" role="tabpanel" id="${base}-panel" aria-labelledby="${base}-tab"${c.issues.length ? '' : ' tabindex="0"'}${on ? '' : ' hidden'} data-key="${esc(c.key)}">${headHTML(`${base}-h`, laneName(c.key), c.issues.length, 3, ' sr-only')}${bodyHTML(c)}</div>`;
      }).join('');
      return `<div class="bd-lanes bd-lanes--tabs" data-sec="${sec.key}"><div class="lt-list" role="tablist" aria-label="${aria}">${tabs}</div>${panels}</div>`;
    }

    function boardHTML() {
      const secs = sections(G.data);
      const cur = secs[0];
      const shipped = cur.issues.filter((x) => x.status === 'done').length;
      const planned = cur.issues.length;
      const stats = `<dl class="bd-stats"><div><dt>${t('board.stat.done')}</dt><dd>${t('board.stat.doneValue', { shipped, planned })}</dd></div><div><dt>${t('board.stat.stillOpen')}</dt><dd>${planned - shipped}</dd></div><div><dt>${t('board.stat.openPrs')}</dt><dd>${PULLS.length}</dd></div></dl>`;
      const secHTML = secs.map((sec, i) => {
        const tid = `${uid}-${sec.key}-t`;
        const head = i === 0
          ? `<header class="bd-head"><h2 class="bd-title" id="${tid}">${esc(sec.title)}</h2><span class="demo-pill">${I.clock}${t('board.demoIn')}</span></header>${stats}`
          : `<header class="bd-head"><h2 class="bd-title bd-title--sub" id="${tid}">${esc(sec.title)}</h2></header>`;
        return `<section class="bd-sec" aria-labelledby="${tid}">${head}${lanesHTML(sec)}</section>`;
      }).join('');
      const pulls = `<div class="bd-lane bd-pulls" role="group" aria-labelledby="${uid}-pulls">${headHTML(`${uid}-pulls`, t('board.pulls'), PULLS.length, 2)}<ul class="bd-list">${PULLS.map((x) => rowHTML(x, false)).join('')}</ul></div>`;
      const note = G.data === 's108' ? `<p class="bd-note">${t('p108.note')}</p>` : '';
      return `<div class="bd">${note}${secHTML}${pulls}</div>`;
    }

    const navItems = [['inbox', 'questions'], ['chat', 'chat'], ['board', 'board'], ['stack', 'artifacts'], ['play', 'demo']];
    if (kind === 'phone') {
      host.innerHTML = `<div class="p-status" aria-hidden="true"><span>9:41</span><span class="p-island"></span><span class="p-status__icons">${I.bars}${I.battery}</span></div>
        <header class="p-head bd-top"><button type="button" class="bd-proj" aria-label="${esc(t('nav.switch', { name: 'team-console' }))}" aria-haspopup="dialog">team-console${I.down}</button><button type="button" class="bd-icon" aria-label="${esc(t('nav.settings'))}">${I.gear}</button></header>
        <div class="bd-scroll" data-slot="board">${boardHTML()}</div>
        <nav class="tabs bd-tabs" aria-label="${esc(t('nav.sections'))}">${navItems.map(([ico, key]) => `<button type="button"${key === 'board' ? ' aria-current="page"' : ''}>${I[ico]}<span>${t(`nav.${key}`)}</span></button>`).join('')}</nav>
        <div class="home-ind" aria-hidden="true"></div>`;
    } else {
      host.innerHTML = `<div class="win"><div class="win__bar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="win__title">Team Console</span></div>
        <div class="win__body">
          <nav class="sidebar" aria-label="${esc(t('nav.projects'))}"><div class="brand">${I.mark}<span>${t('nav.app')}</span></div>
            <ul class="side-list side-list--top"><li><button type="button" class="side-item">${I.inbox}<span>${t('nav.waiting')}</span></button></li><li><button type="button" class="side-item">${I.grid}<span>${t('nav.all')}</span></button></li></ul>
            <div class="side-label">${t('nav.projects')}</div>
            <ul class="side-list">${['ghost', 'private-product', 'team-console'].map((p) => `<li><button type="button" class="side-item"${p === 'team-console' ? ' aria-current="true"' : ''}><span class="side-prod__label">${p}</span></button></li>`).join('')}</ul></nav>
          <section class="convo bd-mac"><header class="convo__head"><div class="convo__title"><h1 class="bd-mac__name">team-console</h1></div>
            <nav class="bd-seg" aria-label="${esc(t('nav.sections'))}">${navItems.map(([ico, key]) => `<button type="button"${key === 'board' ? ' aria-current="page"' : ''}>${I[ico]}<span>${t(`nav.${key}`)}</span></button>`).join('')}</nav></header>
            <div class="bd-scroll" data-slot="board">${boardHTML()}</div></section>
        </div></div>`;
    }

    function select(list, tab, moveFocus) {
      const wrap = list.closest('.bd-lanes--tabs');
      const tabs = [...list.querySelectorAll('[role=tab]')];
      const from = tabs.findIndex((x) => x.getAttribute('aria-selected') === 'true');
      const to = tabs.indexOf(tab);
      if (moveFocus) tab.focus();
      if (to === from) return;
      tabs.forEach((x, i) => { x.setAttribute('aria-selected', String(i === to)); x.tabIndex = i === to ? 0 : -1; });
      const panels = [...wrap.querySelectorAll('[role=tabpanel]')];
      panels.forEach((p, i) => { p.hidden = i !== to; });
      host.selected[wrap.dataset.sec] = tab.dataset.key;
      // Enter from the side the owner moved towards; reduced motion fades only.
      const dir = to > from ? 1 : -1;
      const frames = isReduced()
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 0, transform: `translateX(${dir * 8}px)` }, { opacity: 1, transform: 'none' }];
      play(panels[to], frames, { duration: ms(isReduced() ? '--dur-fade' : '--dur-fast'), easing: cssVar('--ease-enter') });
    }

    if (host.wired) return;
    host.wired = true;
    host.addEventListener('click', (e) => {
      const tab = e.target.closest('[role=tab]');
      if (tab) { select(tab.parentElement, tab, false); return; }
      if (e.target.closest('a[data-act=gh]')) e.preventDefault();
    });
    // Tabs pattern (WAI-ARIA APG), automatic activation: the panels are already rendered, switching is free.
    host.addEventListener('keydown', (e) => {
      const tab = e.target.closest('[role=tab]');
      if (tab) {
        const tabs = [...tab.parentElement.querySelectorAll('[role=tab]')];
        const i = tabs.indexOf(tab); let j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
        if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
        if (e.key === 'Home') j = 0;
        if (e.key === 'End') j = tabs.length - 1;
        if (j !== null) { e.preventDefault(); select(tab.parentElement, tabs[j], true); }
        return;
      }
      // Today's row: arrow keys scroll it by one lane, as the app's focusable scroll container does.
      const row = e.target.closest('[data-swipe]');
      if (row && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        row.scrollBy({ left: (e.key === 'ArrowRight' ? 1 : -1) * row.clientWidth * 0.82, behavior: isReduced() ? 'auto' : 'smooth' });
      }
    });
  }

  /* ---------- page controls ---------- */
  const mountAll = () => hosts.forEach((h) => { h.className = 'app'; mountApp(h, h.dataset.app); });
  const pageChrome = Proto.page({ L, title: 'Team Console · #134', onLang: mountAll });
  const sel = (id) => document.getElementById(id);
  const syncDemo = () => { sel('d-version').value = G.version; sel('d-data').value = G.data; };
  sel('d-version').addEventListener('change', (e) => { G.version = e.target.value; mountAll(); });
  sel('d-data').addEventListener('change', (e) => { G.data = e.target.value; mountAll(); });
  document.querySelector('[data-reset]').addEventListener('click', () => {
    G.version = 'new'; G.data = 'sprint'; hosts.forEach((h) => { h.selected = {}; }); syncDemo(); mountAll();
  });
  mountAll();
  syncDemo();
  pageChrome.fit();
})();
