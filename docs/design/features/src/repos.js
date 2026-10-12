/* #194 All projects: add from GitHub. Design prototype runtime with mock data only; the real app reads
   GET /api/v1/github/installation/repositories and adds through #24's POST /api/v1/projects.
   The repository block (section, rows, states, "Add by name") and the Add sheet do not know their host screen:
   `reposBlock()` is mounted by the All projects host below and could be mounted anywhere else unchanged.
   Two independent instances (iPhone, Mac) share the demo controls, like the other feature pages. */
(() => {
  'use strict';
  const { isReduced, cssVar, ms, wait, esc, play, plain, I, dots } = Proto;
  const L = Proto.i18n(I18N);
  const { t, hhmm } = L;
  const minsAgo = (m) => new Date(Date.now() - m * 60000);

  /* ---------- mock data ---------- */
  // Values the real Worker returns: the environment's app and the owner login come from the #59 connection.
  const ENV = 'dev';
  const APP = `team-console-${ENV}`;
  const LOGIN = 'geeera';
  const INSTALL_URL = `https://github.com/apps/${APP}/installations/new`;
  const SELECTION_URL = 'https://github.com/settings/installations/1001';
  const STEP_KEYS = ['app', 'owner', 'yml', 'events', 'routine'];
  const N = STEP_KEYS.length;
  const ALL = STEP_KEYS.map(() => 'done');
  const FOLD_AT = 10; // a long list shows the first ten addable rows, then "Show N more"
  const LONG_NAMES = ['api-gateway', 'billing-sandbox', 'blog', 'brand-assets', 'cv', 'design-tokens', 'docs-site', 'dotfiles-old', 'esp32-weather', 'expense-bot', 'family-photos', 'flashcards', 'game-jam-2023', 'gpx-tools', 'habit-tracker', 'homelab', 'interview-prep', 'invoice-cli', 'kata', 'kotlin-playground', 'landing-2024', 'leetcode', 'markdown-notes', 'meal-planner', 'micro-saas', 'nvim-config', 'pdf-merge', 'photo-sorter', 'pomodoro', 'portfolio', 'quiz-app', 'recipes', 'resume', 'rust-learning', 'scripts', 'side-project', 'snippets', 'sql-practice', 'telegram-bot', 'todo-react'];
  const PROJECTS = [
    { slug: 'team-console', team: 'running', sprint: 'Sprint 02', demo: new Date(2026, 9, 16), done: 9, total: 14, waiting: 2 },
    { slug: 'sheltrix', team: 'paused', sprint: 'Sprint 01', demo: null, done: 5, total: 11, waiting: 0 },
    { slug: 'atlas-cli', team: 'running', sprint: 'Sprint 01', demo: new Date(2026, 9, 23), done: 3, total: 8, waiting: 0, setup: true },
  ];
  function seedRepos(withProjects, long) {
    const r = (name, priv, reg = 'none') => ({ fullName: `${LOGIN}/${name}`, name, private: priv, reg, slug: name });
    const list = [
      r('a-really-long-repository-name-to-check-wrapping', true), r('dotfiles', false), r('fieldnote', true),
      r('newsletter', false), r('storify', true),
      r('team-console', false, withProjects ? 'active' : 'none'), r('sheltrix', true, withProjects ? 'active' : 'none'),
      r('atlas-cli', false, withProjects ? 'active' : 'none'),
    ];
    if (withProjects) list.push(r('old-landing', false, 'archived'));
    if (long) LONG_NAMES.forEach((n, i) => list.push(r(n, i % 3 === 0)));
    return list;
  }
  const ORDER = { none: 0, active: 1, archived: 2 };
  const sorted = (list) => [...list].sort((a, b) => ORDER[a.reg] - ORDER[b.reg] || a.fullName.localeCompare(b.fullName, 'en', { sensitivity: 'base' }));

  // Shared by both device frames.
  const G = { projects: 'some', conn: 'connected', list: 'loaded', scenario: 'auto' };
  const listed = () => ['loaded', 'long', 'partial', 'offline'].includes(G.list);
  const offline = () => G.list === 'offline' || G.list === 'offlineNone';
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
  const dateFmt = () => new Intl.DateTimeFormat(L.lang === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'short' });

  const hosts = [...document.querySelectorAll('[data-app]')];
  const renderAll = () => hosts.forEach((h) => h.app && h.app.render());

  /* ---------- one app instance ---------- */
  function mountApp(host, kind, keep) {
    const fresh = () => ({
      projects: G.projects === 'some' ? PROJECTS.map((p) => ({ ...p })) : [],
      repos: seedRepos(G.projects === 'some', G.list === 'long'),
      rows: {}, // fullName -> { kind: 'checking' } | { kind: 'notAdded', step, job }
      sheet: null, // the Add sheet: { job, origin }
      expanded: false, byName: false, field: '', fieldErr: null, refreshing: false, connecting: false,
      switcher: false, inkRow: null, newTile: null, stampJob: null,
    });
    const S = keep || fresh();
    host.S = S;
    S.reset = () => Object.assign(S, fresh());
    const uid = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const $ = (s) => host.querySelector(s);

    host.innerHTML = kind === 'mac' ? `<div class="win">
        <div class="win__bar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="win__title">Team Console</span></div>
        <div class="win__body">
          <nav class="sidebar" aria-label="${t('nav.aria')}" data-bg>
            <div class="brand">${I.mark}<span>Team Console</span></div>
            <ul class="side-list side-list--top">
              <li><button type="button" class="side-item" data-act="space">${I.inbox}<span>${t('nav.needs')}</span></button></li>
              <li><button type="button" class="side-item" aria-current="true" data-act="top" data-fk="nav-all">${I.grid}<span>${t('nav.all')}</span></button></li>
            </ul>
            <div class="side-label">${t('nav.projects')}</div>
            <ul class="side-list" data-slot="side"></ul>
            <div class="side-foot">
              <button type="button" class="side-item side-item--add" data-act="entry" data-fk="nav-add">${I.plus}<span>${t('nav.add')}</span></button>
              <button type="button" class="side-item" data-act="space">${I.gear}<span>${t('nav.settings')}</span></button>
              <div class="side-foot__row"><span class="avatar avatar--owner" aria-hidden="true">K</span><span>${t('shell.owner')}</span></div>
            </div>
          </nav>
          <section class="set-main" aria-label="${t('nav.all')}" data-bg>
            <div class="set-scroll" data-scroll><div class="set-inner set-inner--wide" data-slot="screen"></div></div>
          </section>
        </div>
      </div>
      <div data-slot="asheet"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`
      : `<div class="p-status" aria-hidden="true"><span>9:41</span><span class="p-island"></span><span class="p-status__icons">${I.bars}${I.battery}</span></div>
      <header class="p-head" data-bg><button type="button" class="p-switch" data-act="switcher" data-fk="switch" aria-haspopup="dialog" aria-label="${t('nav.switch')}"><span class="p-switch__txt"><b>${t('nav.all')}</b></span>${I.down}</button></header>
      <div class="p-scroll" data-scroll data-bg><div class="set-inner" data-slot="screen"></div></div>
      <div class="home-ind" aria-hidden="true"></div>
      <div class="scrim" data-act="switcher-close"></div>
      <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="${uid}-sw" data-slot="switcher" inert>
        <div class="sheet__grab" aria-hidden="true"></div>
        <header class="sheet__head"><h2 id="${uid}-sw" tabindex="-1">${t('sheet.title')}</h2><button type="button" class="icon-btn" data-act="switcher-close" aria-label="${t('sheet.close')}">${I.x}</button></header>
        <div class="sheet__body" data-slot="swbody"></div>
      </section>
      <div data-slot="asheet"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`;

    /* ----- small pieces ----- */
    const dis = (on) => (on ? ' aria-disabled="true"' : '');
    const mono = (slug) => `<span class="prod-mono" aria-hidden="true">${esc(slug[0])}</span>`;
    const extBtn = (href, label, cls, fk) => `<a class="btn ${cls} btn--tall" href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-act="ext" data-fk="${fk}">${label}<span class="sr-only"> ${t('common.external')}</span>${I.ext}</a>`;
    const extLink = (href, label) => `<a class="ext" href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-act="ext">${label}<span class="sr-only"> ${t('common.external')}</span>${I.ext}</a>`;
    const connectBtn = (fk) => `<button type="button" class="btn btn--primary btn--tall" data-act="connect" data-fk="${fk}"${dis(S.connecting || offline())}>${S.connecting ? t('gh.connecting') : t('gh.connect')}</button>`;

    /* ================= HOST: All projects ================= */
    function tile(p) {
      const pct = Math.round((p.done / p.total) * 100);
      const chip = p.team === 'paused' ? `<span class="status status--paused"><i></i>${t('overview.team.paused')}</span>` : `<span class="status"><i></i>${t('overview.team.running')}</span>`;
      const line = p.sprint ? `${esc(p.sprint)}${p.demo ? ` · ${t('overview.demo', { date: dateFmt().format(p.demo) })}` : ''}` : '';
      const isNew = S.newTile === p.slug;
      return `<li${isNew ? ' class="is-landing"' : ''}><a class="ov" href="#/p/${esc(p.slug)}" data-act="space" data-fk="tile-${esc(p.slug)}">
        <span class="ov__top">${mono(p.slug)}<b>${esc(p.slug)}</b>${p.fresh ? `<span class="status status--new">${t('overview.new')}</span>` : chip}</span>
        ${line ? `<span class="ov__line">${line}</span><span class="meter meter--wide" aria-hidden="true"><i style="--p:${pct}%"></i></span>` : ''}
        <span class="ov__foot"><span>${p.total ? t('overview.done', { done: p.done, total: p.total }) : ''}</span>
          <span class="ov__chips">${p.setup ? `<span class="status setchip setchip--missing">${t('overview.setup')}</span>` : ''}${p.waiting ? `<span class="count">${p.waiting}</span>` : ''}</span></span></a></li>`;
    }
    function hostScreen() {
      const ps = S.projects;
      let h = `<header class="ov-head"><h1 tabindex="-1" data-fk="h1">${t('overview.title')}</h1>${ps.length ? `<p class="ov-count">${t('overview.count', { n: ps.length })}</p>` : ''}</header>`;
      if (!ps.length) {
        h += `<div class="ov-empty"><h2>${t('overview.empty.title')}</h2><p>${t('overview.empty.body')}</p></div>`;
      } else {
        const main = ps.filter((p) => p.waiting); const quiet = ps.filter((p) => !p.waiting);
        if (main.length) h += `<ul class="ov-grid">${main.map(tile).join('')}</ul>`;
        if (quiet.length) h += `<h2 class="ov-h" id="${uid}-quiet">${t('overview.quiet')} <span>${quiet.length}</span></h2><ul class="ov-grid ov-grid--quiet" aria-labelledby="${uid}-quiet">${quiet.map(tile).join('')}</ul>`;
      }
      return h + reposBlock();
    }

    /* ================= BLOCK: repositories on GitHub (host-independent) ================= */
    function rowHTML(r) {
      const meta = `<span class="repo__meta"><span class="repo__owner">${esc(LOGIN)}</span>${r.private ? `<span class="repo__priv">${I.lock}${t('repos.row.private')}</span>` : ''}</span>`;
      const name = `<span class="repo__name">${esc(r.name)}</span>`;
      if (r.reg === 'active') {
        const ink = S.inkRow === r.fullName;
        return `<li class="repo repo--project" data-repo="${esc(r.fullName)}"><a class="repo__link" href="#/settings/projects/${esc(r.slug)}" data-act="setup" data-fk="row-${esc(r.fullName)}" aria-label="${esc(plain(t('repos.row.projectAria', { repo: r.fullName })))}">
          <span class="repo__txt">${name}${meta}</span><span class="repo__tail">${ink ? `<span class="ink is-new" aria-hidden="true">${I.check}</span>` : ''}${t('repos.row.project')}${I.chev}</span></a></li>`;
      }
      if (r.reg === 'archived') {
        return `<li class="repo repo--archived" data-repo="${esc(r.fullName)}"><span class="repo__txt">${name}${meta}</span><span class="repo__tail">${I.archive}${t('repos.row.archived')}</span></li>`;
      }
      const st = S.rows[r.fullName];
      const checking = st && st.kind === 'checking';
      const why = st && st.kind === 'notAdded' ? `<span class="repo__why"><span class="repo__whytxt">${I.bang}${t('repos.row.notAdded', { n: st.step })}</span>
          <button type="button" class="link-btn repo__whybtn" data-act="why" data-repo="${esc(r.fullName)}" data-fk="why-${esc(r.fullName)}" aria-label="${esc(plain(t('repos.row.seeWhyAria', { repo: r.fullName })))}">${t('repos.row.seeWhy')}${I.chev}</button></span>` : '';
      const add = checking
        ? `<button type="button" class="btn btn--tall repo__add is-busy" data-fk="add-${esc(r.fullName)}" aria-disabled="true">${dots}<span>${t('repos.row.adding')}</span></button>`
        : `<button type="button" class="btn btn--tall repo__add" data-act="add" data-repo="${esc(r.fullName)}" data-fk="add-${esc(r.fullName)}" aria-label="${esc(plain(t('repos.row.addAria', { repo: r.fullName })))}"${dis(offline())}>${I.plus}<span>${t('repos.row.add')}</span></button>`;
      return `<li class="repo${why ? ' repo--why' : ''}" data-repo="${esc(r.fullName)}"><span class="repo__txt">${name}${meta}${why}</span>${add}</li>`;
    }
    function reposHead(withRefresh) {
      const busy = S.refreshing || G.list === 'loading';
      const refresh = withRefresh ? `<button type="button" class="btn btn--tall repos__refresh${S.refreshing ? ' is-spinning' : ''}" data-act="refresh" data-fk="refresh"${dis(busy || offline())}>${I.refresh}<span>${S.refreshing ? t('repos.refreshing') : t('repos.refresh')}</span></button>` : '';
      return `<div class="sec-head repos__head"><div><h2 class="sec-title" id="${uid}-repos" tabindex="-1" data-fk="repos-h">${t('repos.title')}</h2>
        ${connected() ? `<p class="set-lead">${t('repos.lead', { app: APP, login: LOGIN })}</p>` : ''}</div>${refresh}</div>`;
    }
    function reposBody() {
      if (!connected()) {
        const lost = G.conn === 'lost';
        return `<div class="res res--warn need-conn"><h3 tabindex="-1" data-fk="need">${lost ? t('gh.lost.title') : t('gh.needConnect.title')}</h3>
          <p>${lost ? t('repos.lost.body') : t('repos.needConnect.body', { app: APP })}</p>${connectBtn('connect')}</div>`;
      }
      const m = G.list;
      if (m === 'loading') {
        return `<div aria-busy="true"><span class="sr-only">${t('repos.loading')}</span><div class="plist" aria-hidden="true">${'<div class="skel-row skel-row--repo"><span class="skel-stack"><span class="skel skel--a"></span><span class="skel skel--b"></span></span><span class="skel skel--btn"></span></div>'.repeat(3)}</div></div>`;
      }
      if (m === 'empty') return `<div class="block"><h3>${t('repos.empty.title', { app: APP })}</h3><p>${t('repos.empty.body')}</p>${extBtn(SELECTION_URL, t('repos.selectLink'), 'btn--primary', 'select')}</div>`;
      if (m === 'notInstalled') return `<div class="block"><h3>${t('repos.notInstalled.title', { app: APP })}</h3><p>${t('repos.notInstalled.body')}</p>${extBtn(INSTALL_URL, t('repos.notInstalled.action'), 'btn--primary', 'install')}</div>`;
      if (m === 'github' || m === 'rate' || m === 'auth') {
        const reason = m === 'github' ? t('repos.error.github') : m === 'rate' ? t('repos.error.rate', { time: hhmm(new Date(Date.now() + 17 * 60000)) }) : t('repos.error.auth', { app: APP });
        return `<div class="block block--error" role="alert"><h3>${t('repos.error.title')}</h3><p>${reason}</p><button type="button" class="btn btn--tall" data-act="retry" data-fk="retry">${t('common.retry')}</button></div>`;
      }
      if (m === 'offlineNone') return `<div class="block"><h3 class="block__icon-h">${I.wifi}${t('repos.offline.title')}</h3><p>${t('repos.offline.body')}</p><button type="button" class="btn btn--tall" data-act="retry" data-fk="retry">${t('common.retry')}</button></div>`;
      // a list: addable rows first, then the ones already in the console
      const all = sorted(S.repos);
      const addable = all.filter((r) => r.reg === 'none' || S.rows[r.fullName] || r.justAdded);
      const already = all.filter((r) => !addable.includes(r));
      const folded = !S.expanded && addable.length > FOLD_AT + 2;
      const shownAdd = folded ? addable.slice(0, FOLD_AT) : addable;
      let h = '';
      if (m === 'offline') h += `<div class="paused offline" role="status">${I.wifi}<span>${t('repos.offline.list', { time: hhmm(listedAt) })}</span></div>`;
      if (m === 'partial') h += `<div class="repos__partial" role="status">${I.clock}<div><p>${t('repos.partial', { n: all.length })}</p>${extLink(SELECTION_URL, t('repos.selectLink'))}</div></div>`;
      if (shownAdd.length) {
        h += `<ul class="plist repos__list" aria-label="${t('repos.listAria')}">${shownAdd.map(rowHTML).join('')}</ul>`;
        if (folded) h += `<button type="button" class="btn btn--quiet btn--tall repos__more" data-act="more" data-fk="more">${I.down}${t('repos.more', { n: addable.length - FOLD_AT })}</button>`;
      }
      if (already.length) {
        h += `<h3 class="ov-h repos__already" id="${uid}-already">${t('repos.already')} <span>${already.length}</span></h3>
          <ul class="plist plist--quiet repos__list" aria-labelledby="${uid}-already">${already.map(rowHTML).join('')}</ul>`;
      }
      return h;
    }
    function byNameBlock() {
      const open = S.byName; const id = `${uid}-byname`;
      const norm = normalise(S.field);
      const describedBy = [`${uid}-hint`, S.fieldErr ? `${uid}-err` : '', `${uid}-prev`].filter(Boolean).join(' ');
      return `<div class="byname"><button type="button" class="byname__toggle" data-act="byname" aria-expanded="${open}" aria-controls="${id}" data-fk="byname">
          <span class="byname__txt"><b>${t('repos.byName')}</b><small>${t('repos.byNameLead')}</small></span>${I.down}</button>
        <form class="byname__panel" id="${id}" data-form novalidate${open ? '' : ' hidden'}><div class="field">
          <label class="field__label" for="${uid}-repo">${t('add.field')}</label>
          <p class="field__hint" id="${uid}-hint">${t('add.hint')}</p>
          <input class="field__input" id="${uid}-repo" data-field data-fk="field" type="text" inputmode="url" enterkeyhint="go" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" value="${esc(S.field)}" aria-describedby="${describedBy}"${S.fieldErr ? ' aria-invalid="true"' : ''}>
          ${S.fieldErr ? `<p class="field__err" id="${uid}-err">${I.warn}<span>${esc(S.fieldErr)}</span></p>` : ''}
          <p class="field__preview" id="${uid}-prev" data-preview>${norm.ok ? t('add.preview', { slug: slugOf(norm.repo) }) : ''}</p></div>
          ${offline() ? `<p class="field__hint">${t('add.offline')}</p>` : ''}
          <div class="form-actions"><button type="submit" class="btn btn--primary btn--tall" data-fk="submit"${dis(offline() || !connected())}>${t('add.submit')}</button></div>
        </form></div>`;
    }
    function reposBlock() {
      const withRefresh = connected() && (listed() || G.list === 'loading');
      return `<section class="sec repos" aria-labelledby="${uid}-repos" data-repos>${reposHead(withRefresh)}${reposBody()}${byNameBlock()}</section>`;
    }

    /* ================= the Add sheet (kit Sheet: bottom sheet on iPhone, dialog on Mac) ================= */
    function stepHTML(i, st, ctx) {
      const k = STEP_KEYS[i];
      const vars = { repo: ctx.repo, SLUG: SECRET(ctx.slug), time: hhmm(new Date()), app: APP, login: LOGIN, repoOwner: ctx.repoOwner || ctx.repo.split('/')[0] };
      const mark = st === 'done' ? I.check : st === 'missing' ? I.bang : st === 'pending' ? dots : `${i + 1}`;
      let fix = '';
      if (st === 'done') fix = t(`step.${k}.done`, vars);
      if (st === 'missing') fix = t(`step.${k}.missing`, vars);
      if (st === 'skipped') fix = t('step.skippedWhy');
      let how = '';
      if (st === 'missing' && (k === 'app' || k === 'owner' || k === 'yml')) {
        const id = `${uid}-how-${i}`; const open = !!(S.sheet && S.sheet.how === i);
        how = `<button type="button" class="btn btn--quiet btn--sm how-btn" data-act="how" data-i="${i}" aria-expanded="${open}" aria-controls="${id}" data-fk="how-${i}">${t('step.how')}${I.down}</button>
          <div class="how" id="${id}"${open ? '' : ' hidden'}><p>${t(`step.${k}.how`, vars)}</p>${k === 'app' ? extLink(INSTALL_URL, t('step.app.link')) : ''}</div>`;
      }
      const isNew = ctx.fresh === i;
      return `<li class="step step--${st}${isNew ? ' is-new' : ''}">
        <span class="step__mark" aria-hidden="true">${mark}</span>
        <div class="step__body"><div class="step__head"><h4 class="step__title">${t(`step.${k}.title`, vars)}</h4><span class="step__state">${t(k === 'events' && st === 'missing' ? 'step.waiting' : `step.${st}`)}</span></div>
        ${fix ? `<p class="step__fix">${fix}</p>` : ''}${how}</div></li>`;
    }
    const ledger = (j) => `<ol class="ledger" aria-label="${t('setup.stepsAria')}">${j.steps.map((s, i) => stepHTML(i, s, { repo: j.repo, slug: j.slug, repoOwner: j.repoOwner, fresh: j.fresh })).join('')}</ol>`;
    const stampSVG = '<div class="stamp" aria-hidden="true"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="28"/><circle class="stamp__inner" cx="32" cy="32" r="23"/><path d="M21 33l8 8 15-17"/></svg></div>';

    function sheetContent(j) {
      const btn = (act, label, primary, fk, disabled) => `<button type="button" class="btn ${primary ? 'btn--primary' : ''} btn--tall" data-act="${act}" data-fk="${fk}"${dis(disabled)}>${label}</button>`;
      let body = ''; let acts = [];
      const res = (tone, title, text) => `<section class="res${tone ? ` res--${tone}` : ''}" data-res><h3 tabindex="-1" data-fk="res">${title}</h3>${text ? `<p>${text}</p>` : ''}${tone === 'ready' ? stampSVG : ''}</section>`;
      if (j.kind === 'checking') { body = ledger(j); acts = [btn('noop', `${dots}${t('add.submitting')}`, true, 'busy', true), btn('close', t('repos.sheet.close'), false, 'close')]; }
      if (j.kind === 'refused') { body = res('bad', t('add.refused.title'), t('add.refused.body')) + ledger(j); acts = [btn('again', t('setup.checkAgain'), true, 'again', offline()), btn('close', t('repos.sheet.close'), false, 'close')]; }
      if (j.kind === 'saved') {
        const left = j.steps.filter((s) => s !== 'done').length;
        body = (left ? res('', t('add.saved.title', { n: left }), t('add.saved.body')) : res('ready', t('setup.ready.title', { name: j.slug }), t('setup.ready.body'))) + ledger(j);
        acts = [btn('done', t('repos.sheet.done'), true, 'done'), btn('setup', t('repos.sheet.openSetup'), false, 'open-setup')];
      }
      if (j.kind === 'unavailable') { body = res('bad', t('add.unavailable.title'), j.reason); acts = [btn('again', t('common.retry'), true, 'again', offline()), btn('close', t('repos.sheet.close'), false, 'close')]; }
      if (j.kind === 'lost') { body = `<div class="res res--warn need-conn"><h3 tabindex="-1" data-fk="res">${t('gh.lost.title')}</h3><p>${t('gh.needConnect.lostBody')}</p></div>`; acts = [connectBtn('sheet-connect'), btn('close', t('repos.sheet.close'), false, 'close')]; }
      if (j.kind === 'dup') { body = `<div class="res res--neutral"><h3 tabindex="-1" data-fk="res">${t('add.duplicate', { repo: j.repo })}</h3><button type="button" class="link-btn" data-act="setup" data-fk="dup-open">${t('add.duplicateLink')}</button></div>`; acts = [btn('close', t('repos.sheet.close'), true, 'close')]; }
      if (j.kind === 'archived') { body = `<div class="res res--neutral"><h3 tabindex="-1" data-fk="res">${t('add.archived', { repo: j.repo })}</h3><p>${t('add.archivedBody')}</p></div>`; acts = [btn('close', t('repos.sheet.close'), true, 'close')]; }
      return { body, acts: acts.join('') };
    }
    function sheetHTML() {
      const j = S.sheet.job; const c = sheetContent(j);
      return `<div class="asheet${kind === 'mac' ? ' asheet--dialog' : ''}"><div class="asheet__scrim" data-act="close"></div>
        <section class="asheet__panel" role="dialog" aria-modal="true" aria-labelledby="${uid}-at">
          ${kind === 'phone' ? '<div class="sheet__grab" aria-hidden="true"></div>' : ''}
          <div class="asheet__head"><h2 class="asheet__title" id="${uid}-at" tabindex="-1" data-fk="sheet-title">${t('repos.sheet.title', { repo: j.repo })}</h2>
            <button type="button" class="icon-btn" data-act="close" data-fk="sheet-x" aria-label="${t('repos.sheet.close')}">${I.x}</button></div>
          <div class="asheet__body" data-sbody tabindex="0" aria-labelledby="${uid}-at">${c.body}</div>
          <div class="asheet__foot">${c.acts}</div>
        </section></div>`;
    }
    function drawSheet(focus) {
      const slot = $('[data-slot=asheet]');
      if (!S.sheet) { slot.innerHTML = ''; return; }
      const active = slot.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
      const top = slot.querySelector('[data-sbody]')?.scrollTop || 0;
      slot.innerHTML = sheetHTML();
      const body = slot.querySelector('[data-sbody]'); body.scrollTop = top;
      S.sheet.job.fresh = null;
      const f = focus || active;
      const el = f && slot.querySelector(`[data-fk="${f}"]`);
      if (el) el.focus({ preventScroll: !focus });
      if (focus === 'res') { const r = slot.querySelector('[data-res], .res'); if (r) body.scrollTop = 0; }
      if (S.stampJob === S.sheet.job) { S.stampJob = null; stamp(slot.querySelector('.res--ready .stamp')); }
    }
    function openSheet(job, origin) {
      S.sheet = { job, origin, how: null };
      host.querySelectorAll('[data-bg]').forEach((el) => { el.inert = true; });
      drawSheet('sheet-title');
      const panel = $('.asheet__panel'); const scrim = $('.asheet__scrim');
      if (isReduced()) play(panel, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') });
      else {
        play(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-base'), easing: cssVar('--ease-standard') });
        play(panel, kind === 'phone' ? [{ transform: 'translateY(100%)' }, { transform: 'none' }] : [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: ms(kind === 'phone' ? '--dur-slow' : '--dur-base'), easing: cssVar('--ease-enter') });
      }
    }
    function closeSheet() {
      const s = S.sheet; if (!s) return;
      const j = s.job;
      S.sheet = null; drawSheet();
      host.querySelectorAll('[data-bg]').forEach((el) => { el.inert = false; });
      // focus: the row link after a success (the Add button is gone), else the row's Add or the by-name submit
      let fk;
      if (j.kind === 'saved' || j.kind === 'dup') { fk = `row-${j.repo}`; S.inkRow = j.kind === 'saved' ? j.repo : null; }
      else fk = s.origin === 'byname' ? 'submit' : `add-${j.repo}`;
      render({ focus: fk });
      S.inkRow = null;
    }

    /* ----- the add check (#24's POST, unchanged); the result lands on the sheet or on the row ----- */
    const refusedAt = (i) => STEP_KEYS.map((_, j) => (j < i ? 'done' : j === i ? 'missing' : 'skipped'));
    function outcomeFor(repo) {
      const owner = repo.split('/')[0];
      const known = S.repos.find((r) => r.fullName.toLowerCase() === repo.toLowerCase());
      const byRepo = owner.toLowerCase() !== LOGIN ? 'owner' : /no-app/i.test(repo) ? 'app' : /storify|team-console|sheltrix|atlas/i.test(repo) ? 'saved' : /newsletter/i.test(repo) ? 'ready' : known ? 'yml' : 'saved';
      const sc = G.scenario !== 'auto' ? G.scenario : byRepo;
      if (sc === 'app') return { kind: 'refused', steps: refusedAt(0) };
      if (sc === 'owner') return { kind: 'refused', steps: refusedAt(1), repoOwner: owner };
      if (sc === 'yml') return { kind: 'refused', steps: refusedAt(2) };
      if (sc === 'github') return { kind: 'unavailable', reason: t('add.unavailable.github') };
      if (sc === 'rate') return { kind: 'unavailable', reason: t('add.unavailable.rate', { time: hhmm(new Date(Date.now() + 17 * 60000)) }) };
      if (sc === 'auth') return { kind: 'unavailable', reason: t('add.unavailable.auth', { app: APP }) };
      if (sc === 'lost') return { kind: 'lost' };
      if (sc === 'dup') return { kind: 'dup' };
      if (sc === 'ready') return { kind: 'saved', steps: [...ALL] };
      return { kind: 'saved', steps: ['done', 'done', 'done', 'missing', 'missing'] };
    }
    const sheetShows = (j) => S.sheet && S.sheet.job === j;
    async function runCheck(repo, origin, jobIn) {
      const out = outcomeFor(repo);
      const job = jobIn || { repo, slug: slugOf(repo) };
      Object.assign(job, { kind: 'checking', repoOwner: out.repoOwner, steps: STEP_KEYS.map(() => 'pending'), fresh: null });
      S.rows[repo] = { kind: 'checking' };
      if (sheetShows(job)) drawSheet('busy'); else openSheet(job, origin);
      render();
      announce(plain(t('add.checkingLive', { repo })));
      if (out.kind === 'saved' || out.kind === 'refused') {
        for (let i = 0; i < N; i += 1) {
          await wait(340);
          job.steps[i] = out.steps[i]; job.fresh = i;
          if (sheetShows(job)) drawSheet();
        }
      } else await wait(1100);
      finish(job, out);
    }
    function finish(job, out) {
      const repo = job.repo; const r = S.repos.find((x) => x.fullName.toLowerCase() === repo.toLowerCase());
      const open = sheetShows(job);
      delete S.rows[repo];
      if (out.kind === 'lost') { G.conn = 'lost'; Object.assign(job, { kind: 'lost' }); hosts.forEach((h) => { if (h !== host && h.app) h.app.render(); }); }
      else if (out.kind === 'unavailable') Object.assign(job, { kind: 'unavailable', reason: out.reason });
      else if (out.kind === 'dup') { Object.assign(job, { kind: 'dup' }); if (r) r.reg = 'active'; }
      else if (out.kind === 'refused') {
        Object.assign(job, { kind: 'refused', steps: out.steps });
        S.rows[repo] = { kind: 'notAdded', step: out.steps.indexOf('missing') + 1, job };
      } else {
        Object.assign(job, { kind: 'saved', steps: out.steps });
        if (r) { r.reg = 'active'; r.justAdded = true; }
        else S.repos.push({ fullName: repo, name: repo.split('/')[1], private: false, reg: 'active', slug: job.slug, justAdded: true });
        const left = out.steps.filter((s) => s !== 'done').length;
        S.projects.push({ slug: job.slug, team: 'running', sprint: null, demo: null, done: 0, total: 0, waiting: 0, setup: left > 0, fresh: true });
        S.newTile = job.slug;
        if (!left) S.stampJob = job;
      }
      if (open) { render(); drawSheet('res'); }
      else {
        // the sheet was closed mid-check: the row carries the result, and the live region says it
        render();
        if (job.kind === 'saved') { toast(plain(t('repos.addedToast', { repo }))); announce(plain(t('repos.addedToast', { repo }))); }
        else if (job.kind === 'refused') announce(plain(t('repos.notAddedLive', { repo })));
      }
      S.newTile = null;
    }
    function submitByName() {
      if (offline() || !connected()) return;
      const field = $('[data-field]'); if (field) S.field = field.value;
      const norm = normalise(S.field);
      if (!norm.ok) { S.fieldErr = norm.err; render({ focus: 'field' }); return; }
      S.fieldErr = null;
      const repo = norm.repo;
      const known = S.repos.find((x) => x.fullName.toLowerCase() === repo.toLowerCase());
      if (known && known.reg !== 'none') { openSheet({ repo: known.fullName, slug: known.slug, kind: known.reg === 'archived' ? 'archived' : 'dup', steps: [] }, 'byname'); return; }
      runCheck(known ? known.fullName : repo, 'byname');
    }

    /* ----- list actions ----- */
    async function reload(how) {
      if (how === 'refresh') { if (S.refreshing || offline()) return; S.refreshing = true; render(); await wait(900); S.refreshing = false; render({ focus: 'refresh' }); announce(plain(t('repos.refreshedLive', { n: S.repos.length }))); return; }
      // Try again / back from GitHub: skeleton, then the list; focus on the section heading
      G.list = 'loading'; renderAll(); await wait(900);
      G.list = 'loaded'; syncDemo(); hosts.forEach((h) => h.app.render(h === host ? { focus: how === 'retry' ? 'repos-h' : null } : {}));
    }
    async function connect() {
      if (S.connecting || offline()) return;
      S.connecting = true; render(); if (S.sheet) drawSheet();
      await wait(800);
      S.connecting = false; G.conn = 'connected'; syncDemo();
      if (S.sheet) closeSheet();
      toast(plain(t('gh.connectedLive', { login: LOGIN })));
      reload('retry');
    }

    /* ----- render, keeping focus by data-fk ----- */
    function chrome() {
      if (kind === 'mac') {
        $('[data-slot=side]').innerHTML = S.projects.map((p) => `<li><button type="button" class="side-item" data-act="space">${mono(p.slug)}<span class="side-prod__label">${esc(p.slug)}</span></button></li>`).join('');
        return;
      }
      $('[data-slot=swbody]').innerHTML = `<div class="sheet__pad"><button type="button" class="side-item side-item--needs" data-act="space">${I.inbox}<span>${t('nav.needs')}</span></button>
          <button type="button" class="side-item" aria-current="true" data-act="switcher-close">${I.grid}<span>${t('nav.all')}</span></button></div>
        <ul class="side-list proj-list">${S.projects.map((p) => `<li><button type="button" class="side-item side-prod--rich" data-act="space">${mono(p.slug)}<span class="side-prod__name"><span class="side-prod__label">${esc(p.slug)}</span><span class="sheet-row__repo">${esc(LOGIN)}/${esc(p.slug)}</span></span></button></li>`).join('')}</ul>
        <div class="sheet-foot"><button type="button" class="side-item side-item--add" data-act="entry" data-fk="sheet-add">${I.plus}<span>${t('nav.add')}</span></button>
        <button type="button" class="side-item" data-act="space">${I.gear}<span>${t('nav.settings')}</span></button></div>`;
    }
    function render(opts = {}) {
      const active = host.contains(document.activeElement) && !$('[data-slot=asheet]').contains(document.activeElement) ? document.activeElement.dataset.fk : null;
      chrome();
      $('[data-slot=screen]').innerHTML = hostScreen();
      const target = opts.focus ? host.querySelector(`[data-slot=screen] [data-fk="${CSS.escape(opts.focus)}"], [data-fk="${CSS.escape(opts.focus)}"]`) : active ? host.querySelector(`[data-fk="${CSS.escape(active)}"]`) : null;
      if (target && !S.sheet) target.focus({ preventScroll: !opts.focus });
      const land = host.querySelector('.is-landing .ov');
      if (land) play(land, isReduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: ms(isReduced() ? '--dur-fade' : '--dur-base'), easing: cssVar('--ease-enter') });
    }
    const announce = (txt) => { const l = $('[data-slot=live]'); l.textContent = ''; setTimeout(() => { l.textContent = txt; }, 30); };
    let toastTimer;
    function toast(txt) {
      const el = $('[data-slot=toast]'); el.textContent = txt; el.hidden = false;
      play(el, isReduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: ms(isReduced() ? '--dur-fade' : '--dur-base'), easing: cssVar('--ease-enter') });
      clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms('--dur-toast'));
    }
    // Signature moment, reused from Paper Desk: the ink stamp presses onto the "ready" note.
    function stamp(s) {
      if (!s) return;
      if (isReduced()) { play(s, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') }); return; }
      const strokes = [...s.querySelectorAll('circle,path')];
      strokes.forEach((p) => { const l = p.getTotalLength(); p.style.strokeDasharray = l; p.style.strokeDashoffset = l; });
      play(s, [{ opacity: 0, transform: 'rotate(-20deg) scale(1.4)' }, { opacity: 1, transform: 'rotate(-9deg) scale(1)' }], { duration: ms('--dur-base'), easing: cssVar('--ease-emph') });
      strokes.forEach((p, i) => play(p, [{ strokeDashoffset: p.style.strokeDashoffset }, { strokeDashoffset: 0 }], { duration: ms('--dur-sig') * 0.6, delay: i * ms('--stagger'), easing: cssVar('--ease-emph'), fill: 'forwards' }));
    }
    function setSwitcher(open) {
      if (kind !== 'phone') return;
      S.switcher = open; host.classList.toggle('has-sheet', open);
      const sh = $('[data-slot=switcher]'); sh.classList.toggle('is-open', open); sh.inert = !open;
      host.querySelectorAll('[data-bg]').forEach((el) => { el.inert = open; });
      if (open) sh.querySelector('h2').focus();
    }
    // Every "Add project" entry point opens All projects scrolled to the GitHub section, focus on its heading.
    function entry() {
      setSwitcher(false);
      const h = $('[data-fk="repos-h"]');
      const scroller = host.querySelector('[data-scroll]');
      const top = h.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 8;
      scroller.scrollTo({ top, behavior: isReduced() ? 'auto' : 'smooth' });
      h.focus({ preventScroll: true });
    }

    /* ----- events ----- */
    host.onclick = (e) => {
      const el = e.target.closest('[data-act]'); if (!el || !host.contains(el)) return;
      const act = el.dataset.act;
      if (act === 'ext') { e.preventDefault(); toast('GitHub ↗'); return; }
      if (el.tagName === 'A') e.preventDefault();
      if (el.getAttribute('aria-disabled') === 'true') return;
      const repo = el.dataset.repo;
      switch (act) {
        case 'add': runCheck(repo, 'row'); break;
        case 'why': { const st = S.rows[repo]; if (st && st.job) openSheet(st.job, 'row'); break; }
        case 'again': runCheck(S.sheet.job.repo, S.sheet.origin, S.sheet.job); break;
        case 'close': closeSheet(); break;
        case 'done': closeSheet(); break;
        case 'setup': if (S.sheet) closeSheet(); toast(t('demo.setup')); break;
        case 'how': S.sheet.how = S.sheet.how === Number(el.dataset.i) ? null : Number(el.dataset.i); drawSheet(); break;
        case 'refresh': reload('refresh'); break;
        case 'retry': reload('retry'); break;
        case 'more': { S.expanded = true; render(); const next = host.querySelectorAll('.repos__list')[0].querySelectorAll('.repo')[FOLD_AT]; const f = next && next.querySelector('button, a'); if (f) f.focus(); break; }
        case 'byname': S.byName = !S.byName; render({ focus: S.byName ? 'field' : 'byname' }); break;
        case 'connect': connect(); break;
        case 'entry': entry(); break;
        case 'top': render({ focus: 'h1' }); break;
        case 'switcher': setSwitcher(true); break;
        case 'switcher-close': setSwitcher(false); $('[data-fk=switch]').focus(); break;
        case 'space': toast(t('demo.space')); break;
        default: break;
      }
    };
    host.onsubmit = (e) => { e.preventDefault(); submitByName(); };
    host.oninput = (e) => {
      if (!e.target.matches('[data-field]')) return;
      S.field = e.target.value;
      const n = normalise(S.field);
      $('[data-preview]').innerHTML = n.ok ? t('add.preview', { slug: slugOf(n.repo) }) : '';
    };
    host.onkeydown = (e) => {
      if (S.sheet) {
        if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
        if (e.key === 'Tab') {
          const f = [...host.querySelectorAll('.asheet__panel button:not([aria-disabled=true]), .asheet__panel a[href]')];
          const i = f.indexOf(document.activeElement);
          if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
          else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
        }
        return;
      }
      if (S.switcher && e.key === 'Escape') { setSwitcher(false); $('[data-fk=switch]').focus(); }
    };

    /* ----- demo entry points ----- */
    const SHEET_STATES = { sheetYml: 'yml', sheetSaved: 'saved', sheetReady: 'ready', sheetGithub: 'github', sheetRate: 'rate', sheetAuth: 'auth', sheetLost: 'lost', sheetDup: 'dup' };
    const app = {
      render, S,
      go: async (screen) => {
        if (S.sheet) { S.sheet = null; drawSheet(); host.querySelectorAll('[data-bg]').forEach((el) => { el.inert = false; }); }
        setSwitcher(false);
        if (screen === 'top') { render({ focus: 'h1' }); host.querySelector('[data-scroll]').scrollTop = 0; return; }
        if (screen === 'entry') { render(); if (kind === 'phone') setSwitcher(true); else entry(); return; }
        if (screen === 'byName') { S.byName = true; render(); entry(); return; }
        const repo = `${LOGIN}/${screen === 'sheetReady' ? 'newsletter' : screen === 'sheetYml' || screen === 'rowNotAdded' ? 'fieldnote' : 'storify'}`;
        const r = S.repos.find((x) => x.fullName === repo);
        if (r) { r.reg = 'none'; r.justAdded = false; }
        S.projects = S.projects.filter((p) => p.slug !== slugOf(repo)); delete S.rows[repo];
        render();
        const keepSc = G.scenario;
        if (screen === 'sheetChecking') {
          const job = { repo, slug: slugOf(repo), kind: 'checking', steps: ['done', 'done', 'pending', 'pending', 'pending'] };
          S.rows[repo] = { kind: 'checking' }; render(); openSheet(job, 'row'); return;
        }
        if (screen === 'rowChecking') { S.rows[repo] = { kind: 'checking' }; render(); entry(); return; }
        if (screen === 'rowNotAdded') {
          const job = { repo, slug: slugOf(repo), kind: 'refused', steps: refusedAt(2) };
          S.rows[repo] = { kind: 'notAdded', step: 3, job }; render(); entry(); return;
        }
        G.scenario = SHEET_STATES[screen] || 'auto';
        const out = outcomeFor(repo);
        G.scenario = keepSc;
        const job = { repo, slug: slugOf(repo) };
        Object.assign(job, { kind: 'checking', steps: STEP_KEYS.map(() => 'pending') });
        openSheet(job, 'row');
        finish(job, out);
      },
      returned: () => { if (connected() && ['empty', 'notInstalled', 'loaded', 'long', 'partial'].includes(G.list)) reload(G.list === 'empty' || G.list === 'notInstalled' ? 'retry' : 'refresh'); },
    };
    host.app = app;
    render();
    return app;
  }

  /* ---------- page controls ---------- */
  const mountAll = (keep) => hosts.forEach((h) => { const prev = keep && h.S ? h.S : null; h.className = 'app'; mountApp(h, h.dataset.app, prev); });
  const pageChrome = Proto.page({ L, title: 'Team Console · #194', onLang: () => mountAll(true) });
  const sel = (id) => document.getElementById(id);
  function syncDemo() { sel('d-projects').value = G.projects; sel('d-conn').value = G.conn; sel('d-list').value = G.list; sel('d-add').value = G.scenario; }
  sel('d-projects').addEventListener('change', (e) => { G.projects = e.target.value; mountAll(false); });
  sel('d-conn').addEventListener('change', (e) => { G.conn = e.target.value; renderAll(); });
  sel('d-list').addEventListener('change', (e) => {
    const was = G.list; G.list = e.target.value;
    if ((was === 'long') !== (G.list === 'long')) mountAll(false); else renderAll();
  });
  sel('d-add').addEventListener('change', (e) => { G.scenario = e.target.value; });
  sel('d-screen').addEventListener('change', (e) => { const v = e.target.value; if (!v) return; if (v.startsWith('sheet') || v.startsWith('row')) { G.conn = 'connected'; if (!listed()) G.list = 'loaded'; syncDemo(); } hosts.forEach((h) => h.app.go(v)); e.target.value = ''; });
  sel('d-return').addEventListener('click', () => hosts.forEach((h) => h.app.returned()));
  document.querySelector('[data-reset]').addEventListener('click', () => { Object.assign(G, { projects: 'some', conn: 'connected', list: 'loaded', scenario: 'auto' }); syncDemo(); mountAll(false); });
  // the real app refetches once with ?fresh=1 when the tab is visible again after a GitHub link from this screen
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') hosts.forEach((h) => h.app.returned()); });
  mountAll(false);
  syncDemo();
  pageChrome.fit();
  window.__demo = { G, hosts, syncDemo, mountAll };
})();
