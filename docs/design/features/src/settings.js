/* #24 Settings: GitHub connection and projects. Design prototype runtime with mock data only; the real app talks to
   the registry API (#15) and the connection API (#59). Two independent instances (iPhone, Mac) share the demo
   controls and the connection state, like the Paper Desk prototype. */
(() => {
  'use strict';
  const root = document.documentElement;
  const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
  const isReduced = () => root.dataset.motion === 'reduce' || mqReduce.matches;
  const cssVar = (n) => getComputedStyle(root).getPropertyValue(n).trim();
  const ms = (n) => { const v = cssVar(n); const x = parseFloat(v) || 0; return v.endsWith('ms') ? x : v.endsWith('s') ? x * 1000 : x; };
  const wait = (t) => new Promise((r) => setTimeout(r, t));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function play(el, frames, opts) {
    if (!el || !el.animate) return;
    try { await el.animate(frames, opts).finished; } catch (err) { if (!err || err.name !== 'AbortError') throw err; }
  }

  /* ---------- language (same preference key as the Paper Desk prototype) ---------- */
  const LANG_KEY = 'team-console.lang';
  let LANG = 'ru';
  try { const v = localStorage.getItem(LANG_KEY); LANG = v === 'en' || v === 'ru' ? v : /^en\b/i.test(navigator.language || '') ? 'en' : 'ru'; }
  catch (err) { console.warn('Language preference unavailable, using Russian', err); }
  let fmt;
  function applyLang(v) {
    LANG = v; root.lang = v;
    const loc = v === 'ru' ? 'ru-RU' : 'en-GB';
    fmt = { time: new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit' }), plural: new Intl.PluralRules(loc) };
  }
  applyLang(LANG);
  const pl = (n, forms) => { const c = fmt.plural.select(n); if (forms.length === 2) return c === 'one' ? forms[0] : forms[1]; return c === 'one' ? forms[0] : c === 'few' ? forms[1] : forms[2]; };
  function t(key, vars = {}) {
    const v = I18N[LANG][key] ?? I18N.en[key];
    if (v == null) { console.warn(`Missing UI string: ${key}`); return key; }
    if (typeof v === 'function') return v(vars, pl, { esc });
    return v.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? esc(vars[k]) : m));
  }
  const plain = (html) => { const d = document.createElement('template'); d.innerHTML = html; return d.content.textContent; };
  const hhmm = (d) => fmt.time.format(d);
  const minsAgo = (m) => new Date(Date.now() - m * 60000);

  /* ---------- icons: inline strokes, as in the prototype ---------- */
  const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const I = {
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'), x: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
    bang: svg('<path d="M12 6.5v7M12 17.3v.2"/>'), q: svg('<path d="M9.3 9a2.8 2.8 0 015.4 1c0 2-2.7 2.3-2.7 4M12 17.3v.2"/>'),
    warn: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.3v.2"/>'),
    chev: svg('<path d="M9.5 6l6 6-6 6"/>'), back: svg('<path d="M14.5 6l-6 6 6 6"/>'), down: svg('<path d="M6 9.5l6 6 6-6"/>'),
    plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4L6 18M18 18l-1.6-1.6M7.6 7.6L6 6"/>'),
    ext: svg('<path d="M14 4.5h5.5V10M19.5 4.5L11 13M17 13.5v5a1 1 0 01-1 1H5.5a1 1 0 01-1-1V8a1 1 0 011-1h5"/>'),
    copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V5.5a1 1 0 00-1-1h-9a1 1 0 00-1 1v9a1 1 0 001 1h3"/>'),
    inbox: svg('<path d="M4 13.5L6.5 5h11l2.5 8.5V19H4z"/><path d="M4 13.5h5l1 2h4l1-2h5"/>'),
    grid: svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
    search: svg('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
    chat: svg('<path d="M4.5 5.5h15v10h-9l-6 4z"/>'),
    board: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15M15 4.5v15"/>'),
    stack: svg('<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4M4 16l8 4 8-4"/>'),
    archive: svg('<rect x="3.5" y="4.5" width="17" height="4.5" rx="1"/><path d="M5 9v10.5h14V9M10 13h4"/>'),
    link: svg('<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>'),
    lock: svg('<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5"/>'),
    wifi: svg('<path d="M3.5 9.5a12 12 0 0117 0M6.5 12.8a7.5 7.5 0 0111 0M9.5 16a3 3 0 015 0"/><path d="M4 4l16 16"/>'),
    mark: '<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="6" fill="currentColor"/><path d="M7.5 9.5h9M7.5 14.5h5.5" stroke="var(--accent-contrast)" stroke-width="2.2" stroke-linecap="round"/></svg>',
    bars: '<svg viewBox="0 0 18 12" width="18" height="12" aria-hidden="true"><rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor"/><rect x="5" y="5" width="3" height="7" rx="1" fill="currentColor"/><rect x="10" y="2.5" width="3" height="9.5" rx="1" fill="currentColor"/><rect x="15" y="0" width="3" height="12" rx="1" fill="currentColor"/></svg>',
    battery: '<svg viewBox="0 0 27 13" width="27" height="13" aria-hidden="true"><rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="18" height="9" rx="2" fill="currentColor"/><rect x="24.5" y="4.5" width="2" height="4" rx="1" fill="currentColor" opacity=".4"/></svg>',
  };
  const dots = '<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>';

  /* ---------- mock data ---------- */
  // Values the real Worker returns (ADR 0003): the environment's app, the owner login, the install link.
  const ENV = 'dev';
  const APP = `team-console-${ENV}`;
  const LOGIN = 'geeera';
  const OTHER_LOGIN = 'kirill-work';
  const INSTALL_URL = `https://github.com/apps/${APP}/installations/new`;
  const STEP_KEYS = ['app', 'owner', 'yml', 'events', 'routine'];
  const N = STEP_KEYS.length;
  const ALL = STEP_KEYS.map(() => 'done');
  const seed = () => ({
    projects: [
      { slug: 'storify', repo: 'geeera/storify', steps: [...ALL], eventAt: minsAgo(38) },
      { slug: 'team-console', repo: 'geeera/team-console', steps: [...ALL], eventAt: minsAgo(6) },
      { slug: 'fieldnote', repo: 'geeera/fieldnote', steps: ['done', 'done', 'done', 'done', 'missing'], eventAt: minsAgo(122) },
      { slug: 'atlas-cli', repo: 'geeera/atlas-cli', steps: ['done', 'done', 'done', 'unknown', 'unknown'] },
      { slug: 'brewlog', repo: 'geeera/brewlog', steps: [...ALL], eventAt: minsAgo(15), loading: true },
    ],
    archived: [{ slug: 'oldmap', repo: 'geeera/oldmap', steps: [...ALL], eventAt: minsAgo(60 * 24 * 30) }],
  });
  // Shared by both device frames: the connection is one per environment, not per window.
  const G = { list: 'normal', scenario: 'auto', archFail: false, conn: 'none', connRes: 'ok', connErr: null, connectedAt: minsAgo(60 * 24 * 3) };
  const offline = () => G.list === 'offline';
  const connected = () => G.conn === 'connected';
  const listedAt = minsAgo(12);

  const RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
  function normalise(raw) {
    const v = raw.trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!raw.trim()) return { ok: false, err: t('add.invalid.empty') };
    if (!RE.test(v)) return { ok: false, err: t('add.invalid.format', { value: raw.trim() }) };
    return { ok: true, repo: v };
  }
  const slugOf = (repo) => repo.split('/')[1].toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const SECRET = (slug) => slug.toUpperCase().replace(/-/g, '_');
  const missingCount = (p) => p.steps.filter((s) => s === 'missing').length;
  const doneCount = (steps) => steps.filter((s) => s === 'done').length;
  const dateFmt = () => new Intl.DateTimeFormat(LANG === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'long' });

  const hosts = [...document.querySelectorAll('[data-app]')];
  const renderAll = () => hosts.forEach((h) => h.app && h.app.render());

  /* ---------- one app instance ---------- */
  function mountApp(host, kind, keep) {
    const S = keep || { route: kind === 'phone' ? 'home' : 'list', sheet: kind === 'phone', ...seed(), field: '', fieldErr: null, add: null, slug: null, busy: false, connecting: false, how: {}, dialog: null, stampFor: null, fresh: null, inkConn: false };
    host.S = S;
    const uid = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const $ = (s) => host.querySelector(s);
    const find = (slug) => S.projects.find((p) => p.slug === slug);

    host.innerHTML = kind === 'mac' ? `<div class="win">
        <div class="win__bar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="win__title" data-slot="wintitle">Team Console</span></div>
        <div class="win__body">
          <nav class="sidebar" aria-label="${t('nav.aria')}" data-bg>
            <div class="brand">${I.mark}<span>Team Console</span></div>
            <label class="search search--side">${I.search}<span class="sr-only">${t('filter.ph')}</span><input type="search" placeholder="${t('filter.ph')}" autocomplete="off"><kbd>/</kbd></label>
            <ul class="side-list side-list--top">
              <li><button type="button" class="side-item" data-act="space">${I.inbox}<span>${t('nav.needs')}</span></button></li>
              <li><button type="button" class="side-item" data-act="space">${I.grid}<span>${t('nav.all')}</span></button></li>
            </ul>
            <div class="side-label">${t('nav.projects')}</div>
            <ul class="side-list" data-slot="side"></ul>
            <div class="side-foot">
              <button type="button" class="side-item side-item--settings" data-act="go" data-to="list" data-fk="nav-settings" aria-current="page">${I.gear}<span>${t('nav.settings')}</span></button>
              <div class="side-foot__row"><span class="avatar avatar--owner" aria-hidden="true">K</span><span>${t('shell.owner')}</span><span class="side-foot__sync" data-slot="sync"></span></div>
            </div>
          </nav>
          <section class="set-main" aria-label="${t('nav.settings')}" data-bg>
            <header class="convo__head"><nav class="crumbs" aria-label="${t('nav.crumbs')}" data-slot="crumbs"></nav></header>
            <div class="set-scroll"><div class="set-inner" data-slot="screen"></div></div>
          </section>
        </div>
      </div>
      <div data-slot="modal"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`
      : `<div class="p-status" aria-hidden="true"><span>9:41</span><span class="p-island"></span><span class="p-status__icons">${I.bars}${I.battery}</span></div>
      <div data-slot="phead" data-bg></div>
      <div class="p-scroll" data-bg><div class="set-inner" data-slot="screen"></div></div>
      <nav class="tabs" aria-label="${t('nav.sections')}" data-slot="tabs" data-bg>
        <button type="button" data-act="space">${I.inbox}<span>${t('nav.needs')}</span></button>
        <button type="button" aria-current="page">${I.chat}<span>${t('nav.chat')}</span></button>
        <button type="button" data-act="space">${I.board}<span>${t('tab.board')}</span></button>
        <button type="button" data-act="space">${I.stack}<span>${t('tab.artifacts')}</span></button>
      </nav>
      <div class="home-ind" aria-hidden="true"></div>
      <div class="scrim" data-act="sheet-close"></div>
      <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="${uid}-sheet" data-slot="sheet" inert>
        <div class="sheet__grab" aria-hidden="true"></div>
        <header class="sheet__head"><h2 id="${uid}-sheet" tabindex="-1">${t('sheet.title')}</h2><button type="button" class="icon-btn" data-act="sheet-close" aria-label="${t('sheet.close')}">${I.x}</button></header>
        <div class="sheet__body" data-slot="sheetbody"></div>
      </section>
      <div data-slot="modal"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`;

    /* ----- markup pieces ----- */
    const mono = (slug) => `<span class="prod-mono" aria-hidden="true">${esc(slug[0])}</span>`;
    function chip(p) {
      if (p.loading) return `<span class="status setchip setchip--checking">${dots}${t('projects.row.checking')}</span>`;
      if (p.steps.includes('unknown')) return `<span class="status setchip setchip--unknown">${I.q}${t('projects.row.unknown')}</span>`;
      const n = missingCount(p);
      if (n) return `<span class="status setchip setchip--missing">${I.bang}${t('projects.row.missing', { n })}</span>`;
      return `<span class="status setchip">${I.check}${t('projects.row.ready')}</span>`;
    }
    const dis = (on) => (on ? ' aria-disabled="true"' : '');
    const extLink = (href, label, fk) => `<a class="ext" href="${esc(href)}" target="_blank" rel="noopener noreferrer"${fk ? ` data-fk="${fk}"` : ''}>${label}<span class="sr-only"> ${t('common.external')}</span>${I.ext}</a>`;
    const copyLine = (value, aria, fk) => `<div class="codeline"><code>${esc(value)}</code><button type="button" class="btn btn--sm" data-act="copy" data-value="${esc(value)}" data-fk="${fk}" aria-label="${esc(aria)}">${I.copy}<span aria-hidden="true">${t('common.copy')}</span></button></div>`;
    const connectBtn = (fk, primary = true) => `<button type="button" class="btn ${primary ? 'btn--primary ' : ''}btn--tall" data-act="connect" data-fk="${fk}"${dis(S.connecting || offline())}>${S.connecting ? t('gh.connecting') : t('gh.connect')}</button>`;

    function stepHTML(i, st, ctx) {
      const k = STEP_KEYS[i];
      const vars = { repo: ctx.repo, SLUG: SECRET(ctx.slug), time: ctx.eventAt ? hhmm(ctx.eventAt) : '', app: APP, login: LOGIN, repoOwner: ctx.repoOwner || ctx.repo.split('/')[0] };
      const mark = st === 'done' ? I.check : st === 'missing' ? I.bang : st === 'pending' ? dots : st === 'unknown' ? I.q : `${i + 1}`;
      let fix = '';
      if (st === 'done') fix = t(`step.${k}.done`, vars);
      if (st === 'missing') fix = t(`step.${k}.missing`, vars);
      if (st === 'skipped') fix = t('step.skippedWhy');
      if (st === 'unknown') fix = t('step.unknownWhy');
      let how = '';
      if (st === 'missing') {
        const id = `${uid}-how-${ctx.scope}-${i}`; const open = !!S.how[`${ctx.scope}-${i}`];
        let body = `<p>${t(`step.${k}.how`, vars)}</p>`;
        if (k === 'app') body += extLink(INSTALL_URL, t('step.app.link'));
        if (k === 'routine') body += copyLine(`npx wrangler secret put ROUTINE_TOKEN_${SECRET(ctx.slug)} --env ${ENV}`, plain(t('step.routine.copyAria')), `copy-cmd-${ctx.scope}`);
        how = `<button type="button" class="btn btn--quiet btn--sm how-btn" data-act="how" data-key="${ctx.scope}-${i}" aria-expanded="${open}" aria-controls="${id}" data-fk="how-${ctx.scope}-${i}">${t('step.how')}${I.down}</button>
          <div class="how" id="${id}"${open ? '' : ' hidden'}>${body}</div>`;
      }
      const fresh = ctx.fresh && ctx.fresh.includes(i);
      return `<li class="step step--${st}${fresh ? ' is-new' : ''}" style="--i:${ctx.fresh ? ctx.fresh.indexOf(i) : 0}">
        <span class="step__mark" aria-hidden="true">${mark}</span>
        <div class="step__body"><div class="step__head"><h3 class="step__title">${t(`step.${k}.title`, vars)}</h3><span class="step__state">${t(k === 'events' && st === 'missing' ? 'step.waiting' : `step.${st}`)}</span></div>
        ${fix ? `<p class="step__fix">${fix}</p>` : ''}${how}</div></li>`;
    }
    const ledger = (steps, ctx) => `<ol class="ledger" aria-label="${t('setup.stepsAria')}">${steps.map((s, i) => stepHTML(i, s, ctx)).join('')}</ol>`;

    /* ----- the GitHub connection block ----- */
    function connBlock() {
      const head = `<h2 class="sec-title" id="${uid}-gh">${t('gh.title')}</h2>`;
      const off = offline() ? `<p class="gh__off">${I.wifi}<span>${t('gh.offline')}</span></p>` : '';
      if (G.conn === 'loading') {
        return `<section class="sec" aria-labelledby="${uid}-gh">${head}<div class="gh" aria-busy="true"><span class="sr-only">${t('gh.loading')}</span>
          <div class="gh__row" aria-hidden="true"><span class="skel skel--mono gh__skel"></span><span class="skel-stack"><span class="skel skel--a"></span><span class="skel skel--b"></span></span></div></div></section>`;
      }
      let card;
      if (G.connErr) {
        const reason = G.connErr === 'account' ? t('gh.error.account', { who: OTHER_LOGIN, login: LOGIN }) : t(`gh.error.${G.connErr}`);
        card = `<div class="gh gh--bad" role="alert"><h3 class="gh__title" tabindex="-1" data-fk="gh-h">${t('gh.error.title')}</h3><p class="gh__body">${reason}</p>${off}<div class="gh__actions">${connectBtn('gh-connect')}</div></div>`;
      } else if (G.conn === 'connected') {
        card = `<div class="gh gh--ok"><div class="gh__row">
            <span class="gh__mark${S.inkConn ? ' is-new' : ''}" aria-hidden="true">${I.check}</span>
            <div class="gh__who"><h3 class="gh__title" tabindex="-1" data-fk="gh-h">${t('gh.connected', { login: LOGIN })}</h3>
            <p class="gh__meta">${t('gh.connectedMeta', { date: dateFmt().format(G.connectedAt), app: APP })}</p></div>
            <button type="button" class="btn btn--quiet btn--tall gh__disc" data-act="disconnect" data-fk="gh-disc" aria-label="${esc(t('gh.disconnectAria', { login: LOGIN }))}"${dis(offline())}>${t('gh.disconnect')}</button>
          </div>${off}</div>`;
      } else if (G.conn === 'lost') {
        card = `<div class="gh gh--warn"><div class="gh__row"><span class="gh__mark" aria-hidden="true">${I.bang}</span><h3 class="gh__title" tabindex="-1" data-fk="gh-h">${t('gh.lost.title')}</h3></div>
          <p class="gh__body">${t('gh.lost.body')}</p>${off}<div class="gh__actions">${connectBtn('gh-connect')}</div></div>`;
      } else {
        card = `<div class="gh"><div class="gh__row"><span class="gh__mark gh__mark--none" aria-hidden="true">${I.link}</span><h3 class="gh__title" tabindex="-1" data-fk="gh-h">${t('gh.none.title')}</h3></div>
          <p class="gh__body">${t('gh.none.body')}</p>${off}<div class="gh__actions">${connectBtn('gh-connect')}</div></div>`;
      }
      S.inkConn = false;
      return `<section class="sec" aria-labelledby="${uid}-gh">${head}${card}</section>`;
    }
    // A compact reminder on the pages below Settings: the connection state is part of the setup status (ADR 0003).
    function connBanner() {
      if (G.conn !== 'none' && G.conn !== 'lost') return '';
      return `<div class="paused conn-banner">${I.lock}<span>${t(`gh.banner.${G.conn}`)}</span>${connectBtn('banner-connect', false)}</div>`;
    }

    /* ----- screens ----- */
    function listScreen() {
      const mode = G.list;
      const add = `<button type="button" class="btn btn--primary btn--tall" data-act="go" data-to="new" data-fk="add"${dis(offline())}>${I.plus}${t('projects.add')}</button>`;
      const empty = mode === 'empty' || (mode === 'normal' && !S.projects.length);
      let h = `<div class="set-head"><h1 tabindex="-1" data-fk="h1">${t('settings.title')}</h1></div>`;
      if (offline()) h += `<div class="paused offline" role="status">${I.wifi}<span>${t('projects.offline', { time: hhmm(listedAt) })}</span></div>`;
      h += connBlock();
      h += `<section class="sec" aria-labelledby="${uid}-pj"><div class="sec-head"><div><h2 class="sec-title" id="${uid}-pj">${t('projects.title')}</h2><p class="set-lead">${t('projects.lead')}</p></div>${empty || mode === 'loading' || mode === 'error' ? '' : add}</div>`;
      if (mode === 'loading') {
        return `${h}<div aria-busy="true"><span class="sr-only">${t('projects.loading')}</span><div class="plist" aria-hidden="true">${'<div class="skel-row"><span class="skel skel--mono"></span><span class="skel-stack"><span class="skel skel--a"></span><span class="skel skel--b"></span></span></div>'.repeat(3)}</div></div></section>`;
      }
      if (mode === 'error') return `${h}<div class="block block--error" role="alert"><h3>${t('projects.error.title')}</h3><p>${t('projects.error.body')}</p><button type="button" class="btn btn--tall" data-act="retry-list" data-fk="retry">${t('common.retry')}</button></div></section>`;
      if (empty) return `${h}<div class="block"><h3>${t('projects.empty.title')}</h3><p>${t('projects.empty.body')}</p>${add}</div></section>`;
      return `${h}<ul class="plist" data-slot="plist">${S.projects.map((p) => `<li class="prow" data-row="${p.slug}">
          <a class="prow__link" href="#/settings/projects/${p.slug}" data-act="open" data-slug="${p.slug}" data-fk="row-${p.slug}">${mono(p.slug)}
            <span class="prow__txt"><span class="prow__name">${esc(p.slug)}</span><span class="prow__repo">${esc(p.repo)}</span></span>${chip(p)}${I.chev}</a>
          <button type="button" class="btn btn--quiet prow__arch" data-act="archive" data-slug="${p.slug}" data-fk="arch-${p.slug}" aria-label="${esc(plain(t('projects.row.archiveAria', { name: p.slug })))}"${dis(offline())}>${I.archive}<span class="prow__archtxt">${t('projects.row.archive')}</span></button></li>`).join('')}</ul></section>`;
    }

    function newScreen() {
      const a = S.add;
      const describedBy = [`${uid}-hint`, S.fieldErr ? `${uid}-err` : '', `${uid}-prev`].filter(Boolean).join(' ');
      const norm = normalise(S.field);
      const blocked = !connected();
      let h = `<div class="set-head"><h1 tabindex="-1" data-fk="h1">${t('add.title')}</h1></div>`;
      if (blocked && G.conn !== 'loading') {
        h += `<div class="res res--warn need-conn"><h2 tabindex="-1" data-fk="need">${G.conn === 'lost' ? t('gh.lost.title') : t('gh.needConnect.title')}</h2>
          <p>${G.conn === 'lost' ? t('gh.needConnect.lostBody') : t('gh.needConnect.body')}</p>${connectBtn('need-connect')}</div>`;
      }
      h += `<form class="field-form" data-form novalidate><div class="field">
          <label class="field__label" for="${uid}-repo">${t('add.field')}</label>
          <p class="field__hint" id="${uid}-hint">${t('add.hint')}</p>
          <input class="field__input" id="${uid}-repo" data-field data-fk="field" type="text" inputmode="url" enterkeyhint="go" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" value="${esc(S.field)}" aria-describedby="${describedBy}"${S.fieldErr ? ' aria-invalid="true"' : ''}>
          ${S.fieldErr ? `<p class="field__err" id="${uid}-err">${I.warn}<span>${esc(S.fieldErr)}</span></p>` : ''}
          <p class="field__preview" id="${uid}-prev" data-preview>${norm.ok ? t('add.preview', { slug: slugOf(norm.repo) }) : ''}</p>
        </div>
        ${offline() ? `<div class="paused offline" role="status">${I.wifi}<span>${t('add.offline')}</span></div>` : ''}
        <div class="form-actions"><button type="submit" class="btn btn--primary btn--tall" data-fk="submit"${dis(S.busy || offline() || blocked)}>${S.busy ? t('add.submitting') : t('add.submit')}</button>
        <button type="button" class="btn btn--quiet btn--tall" data-act="go" data-to="list" data-fk="cancel">${t('common.cancel')}</button></div></form>`;
      if (!a) return h;
      const ctx = { repo: a.repo, slug: a.slug, repoOwner: a.repoOwner, scope: 'add', fresh: S.fresh };
      if (a.kind === 'dup') h += `<div class="res res--neutral"><h2 tabindex="-1" data-fk="res">${t('add.duplicate', { repo: a.repo })}</h2><button type="button" class="link-btn" data-act="open" data-slug="${a.slug}" data-fk="dup-open">${t('add.duplicateLink')}</button></div>`;
      if (a.kind === 'archived') h += `<div class="res res--neutral"><h2 tabindex="-1" data-fk="res">${t('add.archived', { repo: a.repo })}</h2><p>${t('add.archivedBody')}</p></div>`;
      if (a.kind === 'unavailable') h += `<div class="res res--bad"><h2 tabindex="-1" data-fk="res">${t('add.unavailable.title')}</h2><p>${a.reason}</p><button type="button" class="btn btn--tall" data-act="submit" data-fk="try">${t('common.retry')}</button></div>`;
      if (a.kind === 'checking') h += ledger(a.steps, ctx);
      if (a.kind === 'refused') h += `<div class="res res--bad"><h2 tabindex="-1" data-fk="res">${t('add.refused.title')}</h2><p>${t('add.refused.body')}</p></div>${ledger(a.steps, ctx)}
        <div class="form-actions"><button type="button" class="btn btn--primary btn--tall" data-act="submit" data-fk="again"${dis(S.busy || offline())}>${t('setup.checkAgain')}</button></div>`;
      return h;
    }

    function setupScreen() {
      const p = find(S.slug);
      if (!p) return `<div class="set-head"><h1 tabindex="-1" data-fk="h1">${t('projects.title')}</h1></div>`;
      const checking = p.steps.includes('pending');
      const n = missingCount(p); const unknown = p.steps.includes('unknown'); const ready = !checking && !n && !unknown;
      let tone = 'warn'; let title; let body = '';
      if (checking) { tone = 'neutral'; title = t('add.submitting'); }
      else if (ready) { tone = 'ready'; title = t('setup.ready.title', { name: p.slug }); body = t('setup.ready.body'); }
      else if (p.justAdded) { tone = ''; title = t('add.saved.title', { n: n + p.steps.filter((s) => s === 'unknown').length }); body = t('add.saved.body'); }
      else if (unknown) { tone = 'neutral'; title = t('setup.unknown.title'); }
      else title = t('setup.incomplete.title', { n });
      const time = p.checkedAt || minsAgo(3);
      return `<div class="set-head set-head--proj">${mono(p.slug)}<div><h1 tabindex="-1" data-fk="h1">${esc(p.slug)}</h1>
          <p class="set-meta">${extLink(`https://github.com/${p.repo}`, t('setup.repoLink', { repo: p.repo }))}<code>/p/${esc(p.slug)}</code></p></div></div>
        ${connBanner()}
        <section class="res${tone ? ` res--${tone}` : ''}" aria-labelledby="${uid}-res" data-res><h2 id="${uid}-res" tabindex="-1" data-fk="res">${title}</h2>${body ? `<p>${body}</p>` : ''}${checking ? '' : `<p class="res__time">${t('setup.checkedAt', { time: hhmm(time) })}</p>`}${ready ? stampSVG : ''}</section>
        ${ledger(p.steps, { repo: p.repo, slug: p.slug, eventAt: p.eventAt, scope: p.slug, fresh: S.fresh })}
        <div class="form-actions"><button type="button" class="btn ${ready ? '' : 'btn--primary'} btn--tall" data-act="recheck" data-fk="recheck"${dis(checking || offline())}>${checking ? t('add.submitting') : t('setup.checkAgain')}</button>
          <button type="button" class="btn ${ready ? 'btn--primary' : ''} btn--tall" data-act="space" data-fk="open">${t('setup.open')}</button></div>
        <div class="danger-zone"><button type="button" class="btn btn--danger-quiet btn--tall" data-act="archive" data-slug="${p.slug}" data-from="setup" data-fk="arch-setup"${dis(offline())}>${t('setup.archive')}</button></div>`;
    }
    const stampSVG = '<div class="stamp" aria-hidden="true"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="28"/><circle class="stamp__inner" cx="32" cy="32" r="23"/><path d="M21 33l8 8 15-17"/></svg></div>';

    // GitHub's authorize page, mocked so the round trip can be tried on a phone. It is GitHub's UI, so it stays English.
    function githubScreen() {
      const who = G.connRes === 'account' ? OTHER_LOGIN : LOGIN;
      return `<p class="gh-mock__note">${t('demo.gh.note')}</p>
        <div class="gh-mock" lang="en"><div class="gh-mock__logos" aria-hidden="true">${I.mark}<span class="gh-mock__dots">···</span><span class="avatar avatar--owner">${esc(who[0].toUpperCase())}</span></div>
          <h1 tabindex="-1" data-fk="h1">${t('demo.gh.title', { app: APP })}</h1>
          <p class="gh-mock__by">${t('demo.gh.by', { login: LOGIN })} ${t('demo.gh.wants')}</p>
          <ul><li>${t('demo.gh.p1', { who })}</li><li>${t('demo.gh.p2')}</li></ul>
          <p class="gh-mock__signed">${t('demo.gh.signed')} <b>${esc(who)}</b></p>
          <div class="form-actions"><button type="button" class="btn btn--quiet btn--tall" data-act="gh-cancel" data-fk="gh-cancel">${t('demo.gh.cancel')}</button>
          <button type="button" class="btn btn--primary btn--tall" data-act="gh-ok" data-fk="gh-ok">${t('demo.gh.ok', { app: APP })}</button></div></div>`;
    }

    function homeScreen() {
      return `<div class="p-stub"><div class="day"><span>${t('demo.today')}</span></div><p>${t('demo.chat')}</p></div>`;
    }

    /* ----- chrome per route ----- */
    const shown = () => (G.list === 'empty' ? [] : S.projects);
    function syncLabel() {
      const k = G.conn === 'connected' ? 'connected' : G.conn === 'loading' ? 'loading' : G.conn === 'lost' ? 'lost' : 'none';
      return `<i aria-hidden="true" class="sync-dot sync-dot--${k}"></i>${t(`shell.gh.${k}`, { login: LOGIN })}`;
    }
    function chrome() {
      if (kind === 'mac') {
        const c = [];
        if (S.route === 'gh') c.push('<li><span aria-current="page" class="crumbs__url">github.com/login/oauth/authorize</span></li>');
        else if (S.route === 'list') c.push(`<li><span aria-current="page">${t('nav.settings')}</span></li>`);
        else {
          c.push(`<li><a href="#/settings" data-act="go" data-to="list" data-fk="crumb-settings">${t('nav.settings')}</a></li>`);
          c.push(`<li><span aria-current="page">${S.route === 'new' ? t('add.title') : esc(S.slug)}</span></li>`);
        }
        $('[data-slot=crumbs]').innerHTML = `<ol>${c.join('')}</ol>`;
        $('[data-slot=side]').innerHTML = shown().map((p) => `<li><button type="button" class="side-item" data-act="space"><span class="prod-mono" aria-hidden="true">${esc(p.slug[0])}</span><span class="side-prod__label">${esc(p.slug)}</span></button></li>`).join('');
        $('[data-slot=sync]').innerHTML = syncLabel();
        return;
      }
      const head = $('[data-slot=phead]');
      if (S.route === 'home') {
        const p = shown()[0];
        head.innerHTML = `<header class="p-head"><button type="button" class="p-switch" data-act="sheet-open" data-fk="switch" aria-haspopup="dialog">${p ? `<span class="prod-mono" aria-hidden="true">${esc(p.slug[0])}</span><span class="p-switch__txt"><b>${esc(p.slug)}</b><small>${esc(p.repo)}</small></span>` : `<span class="p-switch__txt"><b>${t('sheet.title')}</b></span>`}${I.down}</button></header>`;
      } else if (S.route === 'gh') {
        head.innerHTML = '<header class="p-bar p-bar--url"><span></span><span class="p-bar__url" aria-hidden="true">github.com</span><span></span></header>';
      } else {
        const back = S.route === 'list' ? t('nav.chat') : t('nav.settings');
        head.innerHTML = `<header class="p-bar"><button type="button" class="p-back" data-act="back" data-fk="back">${I.back}<span>${back}</span></button><span></span><span></span></header>`;
      }
      $('[data-slot=tabs]').hidden = S.route !== 'home';
      $('[data-slot=sheetbody]').innerHTML = `<div class="sheet__pad"><button type="button" class="side-item side-item--needs" data-act="space">${I.inbox}<span>${t('nav.needs')}</span></button></div>
        <ul class="side-list proj-list">${shown().map((p) => `<li><button type="button" class="side-item side-prod--rich" data-act="space"><span class="prod-mono" aria-hidden="true">${esc(p.slug[0])}</span><span class="side-prod__name"><span class="side-prod__label">${esc(p.slug)}</span><span class="sheet-row__repo">${esc(p.repo)}</span></span></button></li>`).join('')}</ul>
        <div class="sheet-foot"><button type="button" class="side-item side-item--add" data-act="sheet-go" data-to="new" data-fk="sheet-add">${I.plus}<span>${t('sheet.add')}</span></button>
        <button type="button" class="side-item" data-act="sheet-go" data-to="list" data-fk="sheet-settings">${I.gear}<span>${t('sheet.settings')}</span><span class="sheet-foot__sync">${syncLabel()}</span></button></div>`;
    }

    /* ----- render with focus kept by data-fk ----- */
    function render(opts = {}) {
      const active = host.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
      chrome();
      const screen = $('[data-slot=screen]');
      screen.innerHTML = S.route === 'list' ? listScreen() : S.route === 'new' ? newScreen() : S.route === 'setup' ? setupScreen() : S.route === 'gh' ? githubScreen() : homeScreen();
      S.fresh = null;
      host.classList.toggle('on-github', S.route === 'gh');
      if (kind === 'phone') setSheet(S.sheet, true);
      const target = opts.focus ? host.querySelector(`[data-fk="${opts.focus}"]`) : active ? host.querySelector(`[data-fk="${active}"]`) : null;
      if (target && (opts.focus || !S.dialog)) target.focus({ preventScroll: !opts.focus });
      if (opts.scrollTop) (screen.closest('.set-scroll, .p-scroll') || screen).scrollTop = 0;
      if (S.stampFor && S.route === 'setup' && S.stampFor === S.slug) { S.stampFor = null; stamp(); }
    }
    const announce = (txt) => { const l = $('[data-slot=live]'); l.textContent = ''; setTimeout(() => { l.textContent = txt; }, 30); };
    let toastTimer;
    function toast(txt) {
      const el = $('[data-slot=toast]'); el.textContent = txt; el.hidden = false;
      if (!isReduced()) play(el, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: ms('--dur-base'), easing: cssVar('--ease-enter') });
      else play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') });
      clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms('--dur-toast'));
    }
    // Signature moment, reused from Paper Desk: the ink stamp presses onto the "ready" note.
    function stamp() {
      const s = host.querySelector('[data-res] .stamp'); if (!s) return;
      if (isReduced()) { play(s, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') }); return; }
      const strokes = [...s.querySelectorAll('circle,path')];
      strokes.forEach((p) => { const l = p.getTotalLength(); p.style.strokeDasharray = l; p.style.strokeDashoffset = l; });
      play(s, [{ opacity: 0, transform: 'rotate(-20deg) scale(1.4)' }, { opacity: 1, transform: 'rotate(-9deg) scale(1)' }], { duration: ms('--dur-base'), easing: cssVar('--ease-emph') });
      strokes.forEach((p, i) => play(p, [{ strokeDashoffset: p.style.strokeDashoffset }, { strokeDashoffset: 0 }], { duration: ms('--dur-sig') * 0.6, delay: i * ms('--stagger'), easing: cssVar('--ease-emph'), fill: 'forwards' }));
    }

    /* ----- phone sheet ----- */
    function setSheet(open, quiet) {
      if (kind !== 'phone') return;
      S.sheet = open && S.route === 'home';
      host.classList.toggle('has-sheet', S.sheet);
      const sh = $('[data-slot=sheet]'); sh.classList.toggle('is-open', S.sheet); sh.inert = !S.sheet;
      host.querySelectorAll('[data-bg]').forEach((el) => { el.inert = S.sheet || !!S.dialog; });
      if (S.sheet && !quiet) sh.querySelector('h2').focus();
    }

    /* ----- navigation ----- */
    function go(route, slug, focus) {
      S.route = route; if (slug) S.slug = slug;
      if (route === 'new') { S.add = null; S.fieldErr = null; }
      const first = route === 'new' ? (connected() ? 'field' : 'need') : 'h1';
      render({ focus: focus || first, scrollTop: true });
    }

    /* ----- connect and disconnect (#59's API; the client only follows a GitHub authorize URL) ----- */
    const AUTHORIZE_PREFIX = 'https://github.com/login/oauth/authorize';
    async function connect() {
      if (S.connecting || offline()) return;
      S.connecting = true; G.connErr = null; render();
      await wait(700);
      const url = G.connRes === 'url' ? 'https://example.com/login' : `${AUTHORIZE_PREFIX}?client_id=Iv23…&state=…`;
      S.connecting = false;
      if (!url.startsWith(AUTHORIZE_PREFIX)) { G.connErr = 'url'; S.route = 'list'; renderAll(); render({ focus: 'gh-h', scrollTop: true }); return; }
      go('gh');
    }
    function backFromGithub(result) {
      if (result === 'ok') { G.conn = 'connected'; G.connErr = null; G.connectedAt = new Date(); S.inkConn = true; }
      else G.connErr = result;
      S.route = 'list';
      hosts.forEach((h) => { if (h !== host && h.app) h.app.render(); });
      render({ focus: 'gh-h', scrollTop: true });
      if (result === 'ok') { toast(plain(t('gh.connectedLive', { login: LOGIN }))); }
    }

    /* ----- add flow ----- */
    async function resolveSteps(steps, target, onTick) {
      for (let i = 0; i < N; i += 1) {
        await wait(320);
        target[i] = steps[i];
        S.fresh = [i];
        onTick();
      }
    }
    const refusedAt = (i) => STEP_KEYS.map((_, j) => (j < i ? 'done' : j === i ? 'missing' : 'skipped'));
    function outcomeFor(repo) {
      const owner = repo.split('/')[0];
      const byInput = owner.toLowerCase() !== LOGIN ? 'owner' : /no-app/i.test(repo) ? 'app' : /no-team/i.test(repo) ? 'yml' : 'saved';
      const sc = G.scenario !== 'auto' ? G.scenario : byInput;
      const later = new Date(Date.now() + 17 * 60000);
      if (sc === 'app') return { kind: 'refused', steps: refusedAt(0) };
      if (sc === 'owner') return { kind: 'refused', steps: refusedAt(1), repoOwner: owner.toLowerCase() === LOGIN ? 'acme' : owner };
      if (sc === 'yml') return { kind: 'refused', steps: refusedAt(2) };
      if (sc === 'github') return { kind: 'unavailable', reason: t('add.unavailable.github') };
      if (sc === 'rate') return { kind: 'unavailable', reason: t('add.unavailable.rate', { time: hhmm(later) }) };
      if (sc === 'auth') return { kind: 'unavailable', reason: t('add.unavailable.auth', { app: APP }) };
      if (sc === 'lost') return { kind: 'lost' };
      if (sc === 'ready') return { kind: 'saved', steps: [...ALL] };
      return { kind: 'saved', steps: ['done', 'done', 'done', 'missing', 'missing'] };
    }
    async function submitAdd() {
      if (S.busy || offline() || !connected()) return;
      const field = $('[data-field]'); if (field) S.field = field.value;
      const norm = normalise(S.field);
      if (!norm.ok) { S.fieldErr = norm.err; S.add = null; render({ focus: 'field' }); return; }
      S.fieldErr = null;
      const repo = norm.repo; const slug = slugOf(repo);
      if (S.projects.some((p) => p.repo.toLowerCase() === repo.toLowerCase())) { S.add = { kind: 'dup', repo, slug }; render({ focus: 'res' }); return; }
      if (S.archived.some((p) => p.repo.toLowerCase() === repo.toLowerCase())) { S.add = { kind: 'archived', repo, slug }; render({ focus: 'res' }); return; }
      const out = outcomeFor(repo);
      S.busy = true; S.add = { kind: 'checking', repo, slug, repoOwner: out.repoOwner, steps: STEP_KEYS.map(() => 'pending') };
      render({ focus: 'submit' }); announce(plain(t('add.checkingLive', { repo })));
      if (out.kind === 'unavailable' || out.kind === 'lost') {
        await wait(1100); S.busy = false;
        // 403 github-owner-not-connected: the connection is gone, so the page says so instead of a generic error
        if (out.kind === 'lost') { G.conn = 'lost'; S.add = null; hosts.forEach((h) => { if (h !== host && h.app) h.app.render(); }); render({ focus: 'need' }); return; }
        S.add = { kind: 'unavailable', repo, slug, reason: out.reason }; render({ focus: 'res' }); return;
      }
      await resolveSteps(out.steps, S.add.steps, () => render());
      S.busy = false;
      if (out.kind === 'refused') { S.add = { kind: 'refused', repo, slug, repoOwner: out.repoOwner, steps: out.steps }; render({ focus: 'res' }); return; }
      const ready = !out.steps.includes('missing');
      S.projects.push({ slug, repo, steps: out.steps, eventAt: ready ? new Date() : null, justAdded: !ready, checkedAt: new Date() });
      S.field = ''; S.add = null;
      if (ready) S.stampFor = slug;
      S.route = 'setup'; S.slug = slug;
      render({ focus: 'res', scrollTop: true });
    }

    async function recheck(auto) {
      const p = find(S.slug); if (!p || S.busy || offline()) return;
      if (auto && !p.steps.some((s) => s !== 'done')) return;
      const before = p.steps.slice(); const wasReady = before.every((s) => s === 'done');
      let next = before.slice();
      if (G.scenario === 'github') next = before.map((s) => (s === 'missing' ? 'unknown' : s));
      else if (before.includes('unknown')) next = before.map((s) => (s === 'unknown' ? 'done' : s));
      else { const i = before.indexOf('missing'); if (i >= 0) next[i] = 'done'; }
      S.busy = true; p.steps = STEP_KEYS.map(() => 'pending'); render();
      await resolveSteps(next, p.steps, () => render());
      S.busy = false; p.checkedAt = new Date(); p.justAdded = false;
      if (next[3] === 'done' && !p.eventAt) p.eventAt = new Date();
      if (!wasReady && next.every((s) => s === 'done')) S.stampFor = p.slug;
      render({ focus: 'res' });
      announce(plain(t('setup.doneLive', { done: doneCount(next) })));
    }

    /* ----- confirmation dialogs: archive a project, disconnect GitHub ----- */
    function dialogHTML() {
      const d = S.dialog;
      const isDisc = d.type === 'disc';
      const title = isDisc ? t('disc.title') : t('archive.title', { name: d.slug });
      const body = isDisc ? t('disc.body', { login: LOGIN }) : t('archive.body');
      const note = isDisc ? '' : `<p class="adialog__note">${t('archive.note')}</p>`;
      const err = isDisc ? t('disc.error') : t('archive.error');
      const ok = d.busy ? t(isDisc ? 'disc.busy' : 'archive.busy') : t(isDisc ? 'disc.confirm' : 'archive.confirm');
      return `<div class="modal"><div class="modal__scrim" data-act="dlg-scrim"></div>
        <div class="adialog" role="alertdialog" aria-modal="true" aria-labelledby="${uid}-dt" aria-describedby="${uid}-dd">
          <h2 id="${uid}-dt">${title}</h2>
          <p id="${uid}-dd">${body}</p>
          ${note}
          ${d.error ? `<div class="adialog__err" role="alert">${I.warn}<span>${err}</span></div>` : ''}
          <div class="adialog__actions"><button type="button" class="btn" data-act="dlg-cancel" data-fk="dlg-cancel">${t('common.cancel')}</button>
          <button type="button" class="btn btn--danger" data-act="dlg-confirm" data-fk="dlg-confirm"${dis(d.busy)}>${ok}</button></div>
        </div></div>`;
    }
    function openDialog(d) {
      S.dialog = { busy: false, error: false, ...d };
      const m = $('[data-slot=modal]'); m.innerHTML = dialogHTML();
      host.querySelectorAll('[data-bg]').forEach((el) => { el.inert = true; });
      const box = m.querySelector('.adialog'); const scrim = m.querySelector('.modal__scrim');
      if (isReduced()) { play(box, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') }); }
      else {
        play(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-base'), easing: cssVar('--ease-standard') });
        play(box, kind === 'phone' ? [{ transform: 'translateY(100%)' }, { transform: 'none' }] : [{ opacity: 0, transform: 'translateY(8px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: ms(kind === 'phone' ? '--dur-slow' : '--dur-base'), easing: cssVar('--ease-enter') });
      }
      m.querySelector('[data-fk=dlg-cancel]').focus();
    }
    function redrawDialog() {
      const active = document.activeElement && document.activeElement.dataset.fk;
      const m = $('[data-slot=modal]'); m.innerHTML = dialogHTML();
      const f = m.querySelector(`[data-fk="${active || 'dlg-confirm'}"]`); if (f) f.focus();
    }
    function closeDialog(focusFk) {
      S.dialog = null; $('[data-slot=modal]').innerHTML = '';
      host.querySelectorAll('[data-bg]').forEach((el) => { el.inert = false; });
      const f = focusFk && host.querySelector(`[data-fk="${focusFk}"]`); if (f) f.focus();
    }
    async function confirmDialog() {
      const d = S.dialog; if (!d || d.busy) return;
      d.busy = true; d.error = false; redrawDialog();
      await wait(900);
      if (G.archFail) { d.busy = false; d.error = true; redrawDialog(); return; }
      if (d.type === 'disc') {
        G.conn = 'none'; G.connErr = null;
        closeDialog();
        hosts.forEach((h) => { if (h !== host && h.app) h.app.render(); });
        render({ focus: 'gh-connect' });
        toast(t('disc.toast'));
        return;
      }
      const idx = S.projects.findIndex((p) => p.slug === d.slug);
      const after = S.projects[idx + 1] || S.projects[idx - 1];
      const focusFk = after ? `row-${after.slug}` : 'add';
      // FLIP: the rows below slide up into the gap; nothing moves under reduced motion
      const rows = S.route === 'list' ? [...host.querySelectorAll('.prow')].slice(idx + 1) : [];
      const tops = rows.map((r) => r.getBoundingClientRect().top);
      const [gone] = S.projects.splice(idx, 1);
      S.archived.push(gone);
      const name = d.slug;
      closeDialog();
      S.route = 'list';
      render({ focus: focusFk });
      if (!isReduced() && rows.length) {
        rows.forEach((r, i) => {
          const now = host.querySelector(`[data-row="${r.dataset.row}"]`); if (!now) return;
          const dy = tops[i] - now.getBoundingClientRect().top;
          if (dy) play(now, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: ms('--dur-base'), easing: cssVar('--ease-standard') });
        });
      }
      toast(plain(t('archive.toast', { name })));
    }

    /* ----- copy ----- */
    async function copy(btn) {
      try { await navigator.clipboard.writeText(btn.dataset.value); } catch (err) { console.warn('Clipboard unavailable in this preview', err); }
      const label = btn.querySelector('span'); label.textContent = t('common.copied'); btn.dataset.copied = '';
      announce(t('common.copied'));
      setTimeout(() => { if (btn.isConnected) { label.textContent = t('common.copy'); delete btn.dataset.copied; } }, ms('--dur-toast'));
    }

    /* ----- events ----- */
    host.onclick = (e) => {
      const el = e.target.closest('[data-act]'); if (!el || !host.contains(el)) return;
      const act = el.dataset.act;
      if (el.tagName === 'A') e.preventDefault();
      if (el.getAttribute('aria-disabled') === 'true') return;
      switch (act) {
        case 'go': go(el.dataset.to); break;
        case 'open': go('setup', el.dataset.slug); break;
        case 'back': go(S.route === 'list' ? 'home' : 'list', null, S.route === 'list' ? 'switch' : 'h1'); break;
        case 'sheet-open': setSheet(true); break;
        case 'sheet-close': setSheet(false); host.querySelector('[data-fk=switch]')?.focus(); break;
        case 'sheet-go': S.sheet = false; go(el.dataset.to); break;
        case 'space': toast(t('demo.space')); break;
        case 'retry-list': G.list = 'normal'; syncDemo(); renderAll(); break;
        case 'submit': submitAdd(); break;
        case 'recheck': recheck(false); break;
        case 'how': S.how[el.dataset.key] = !S.how[el.dataset.key]; render(); break;
        case 'copy': copy(el); break;
        case 'connect': connect(); break;
        case 'gh-ok': backFromGithub(G.connRes === 'account' ? 'account' : 'ok'); break;
        case 'gh-cancel': backFromGithub('denied'); break;
        case 'disconnect': openDialog({ type: 'disc', opener: 'gh-disc' }); break;
        case 'archive': openDialog({ type: 'archive', slug: el.dataset.slug, from: el.dataset.from || 'list', opener: el.dataset.fk }); break;
        case 'dlg-cancel': closeDialog(S.dialog.opener); break;
        case 'dlg-confirm': confirmDialog(); break;
        default: break;
      }
    };
    host.onsubmit = (e) => { e.preventDefault(); submitAdd(); };
    host.oninput = (e) => {
      if (!e.target.matches('[data-field]')) return;
      S.field = e.target.value;
      const n = normalise(S.field);
      $('[data-preview]').innerHTML = n.ok ? t('add.preview', { slug: slugOf(n.repo) }) : '';
    };
    host.onkeydown = (e) => {
      if (S.dialog) {
        if (e.key === 'Escape') { e.preventDefault(); if (!S.dialog.busy) closeDialog(S.dialog.opener); return; }
        if (e.key === 'Tab') {
          const f = [...host.querySelectorAll('.adialog button')];
          const i = f.indexOf(document.activeElement);
          if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
          else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
        }
        return;
      }
      if (S.sheet && e.key === 'Escape') { setSheet(false); host.querySelector('[data-fk=switch]')?.focus(); }
    };

    const app = {
      render, S,
      go: (screen) => {
        closeDialog(); S.sheet = false; S.busy = false; S.connecting = false;
        if (screen === 'entry') { if (kind === 'phone') { S.route = 'home'; S.sheet = true; render(); setSheet(true, true); } else go('list'); return; }
        if (screen === 'list' || screen === 'new') { go(screen); return; }
        if (screen === 'github') { go('gh'); return; }
        if (screen === 'disconnect') { G.conn = 'connected'; G.connErr = null; go('list'); openDialog({ type: 'disc', opener: 'gh-disc' }); return; }
        if (screen === 'dialog') { go('list'); if (S.projects[0]) openDialog({ type: 'archive', slug: S.projects[0].slug, from: 'list', opener: `arch-${S.projects[0].slug}` }); return; }
        const slug = { setupMissing: 'fieldnote', setupUnknown: 'atlas-cli', setupReady: 'storify' }[screen];
        if (!find(slug)) { go('list'); return; }
        go('setup', slug);
      },
      returned: () => { if (S.route === 'setup') recheck(true); },
    };
    host.app = app;
    render();
    // a row whose setup status is still loading resolves a moment later
    setTimeout(() => { const p = S.projects.find((x) => x.loading); if (p) { p.loading = false; if (S.route === 'list') render(); } }, 1600);
    return app;
  }

  /* ---------- page controls ---------- */
  const mountAll = (keep) => hosts.forEach((h) => { const prev = keep && h.S ? h.S : null; h.className = 'app'; mountApp(h, h.dataset.app, prev); });
  const stage = document.querySelector('.stage');
  const macFrame = document.querySelector('.mac-frame');
  function fit() {
    const W = stage.clientWidth - 48; const view = stage.dataset.view; let z = 1;
    if (view === 'mac') { z = Math.min(1, W / 1182); stage.dataset.layout = 'stack'; }
    else if (view === 'both') {
      const room = W - 414 - 40;
      if (room / 1182 >= 0.62) { z = Math.min(1, room / 1182); stage.dataset.layout = 'row'; } else { z = Math.min(1, W / 1182); stage.dataset.layout = 'stack'; }
    }
    macFrame.style.zoom = String(Math.max(z, 0.3));
  }
  function translatePage() {
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.innerHTML = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', plain(t(el.dataset.i18nAria))));
    document.title = `Team Console · #24 · ${plain(t('page.title'))}`;
  }
  function setControl(ctrl, val) {
    if (ctrl === 'view') { stage.dataset.view = val; fit(); }
    if (ctrl === 'theme') { if (val === 'auto') delete root.dataset.theme; else root.dataset.theme = val; }
    if (ctrl === 'motion') { if (val === 'system') delete root.dataset.motion; else root.dataset.motion = val; }
    if (ctrl === 'lang' && val !== LANG) {
      try { localStorage.setItem(LANG_KEY, val); } catch (err) { console.warn('Language preference not saved', err); }
      applyLang(val); translatePage(); mountAll(true);
    }
    document.querySelectorAll(`[data-control="${ctrl}"] button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === val)));
  }
  document.querySelectorAll('[data-control]').forEach((g) => g.addEventListener('click', (e) => { const b = e.target.closest('button[data-value]'); if (b) setControl(g.dataset.control, b.dataset.value); }));
  const sel = (id) => document.getElementById(id);
  function syncDemo() { sel('d-list').value = G.list; sel('d-add').value = G.scenario; sel('d-fail').checked = G.archFail; sel('d-conn').value = G.conn; sel('d-connres').value = G.connRes; }
  sel('d-list').addEventListener('change', (e) => { G.list = e.target.value; renderAll(); });
  sel('d-conn').addEventListener('change', (e) => { G.conn = e.target.value; G.connErr = null; renderAll(); });
  sel('d-connres').addEventListener('change', (e) => { G.connRes = e.target.value; });
  sel('d-add').addEventListener('change', (e) => { G.scenario = e.target.value; });
  sel('d-fail').addEventListener('change', (e) => { G.archFail = e.target.checked; });
  sel('d-screen').addEventListener('change', (e) => { const v = e.target.value; if (!v) return; hosts.forEach((h) => h.app.go(v)); e.target.value = ''; syncDemo(); });
  sel('d-return').addEventListener('click', () => hosts.forEach((h) => h.app.returned()));
  document.querySelector('[data-reset]').addEventListener('click', () => { Object.assign(G, { list: 'normal', scenario: 'auto', archFail: false, conn: 'none', connRes: 'ok', connErr: null }); syncDemo(); mountAll(false); });
  // the real app re-checks once when it comes back to the foreground
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') hosts.forEach((h) => h.app.returned()); });
  const small = matchMedia('(max-width: 520px)').matches;
  translatePage();
  setControl('view', small ? 'phone' : 'both');
  setControl('theme', 'auto');
  setControl('motion', 'system');
  setControl('lang', LANG);
  document.querySelectorAll('[data-control=lang] button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === LANG)));
  addEventListener('resize', fit);
  mountAll(false);
  syncDemo();
  fit();
})();
