/* #775 Run now on every project. Design prototype runtime with mock data only (no network).
   The shell and the board are #766's (`wide.css`); the runs section is the app's `tc-board-jobs` (Run now form,
   `tc-job-card` lists) shown on a GitHub-tracker project too, with the `runnerAvailability` line or the «no eligible
   runner» block above it, and the existing `tc-sprint-run-list` (GitHub run log) under it. Text is rendered through
   esc() only, as the app interpolates it. */
(() => {
  'use strict';
  const { esc, plain, I } = Proto;
  const L = Proto.i18n(I18N);
  const { t } = L;
  const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const IX = { ...I, menu: svg('<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>'), sum: svg('<path d="M5 19.5V11M10 19.5V5M15 19.5v-6M20 19.5V8"/>'),
    plug: svg('<path d="M9 3.5v5M15 3.5v5M6.5 8.5h11v3a5.5 5.5 0 01-11 0zM12 17v3.5"/>') };
  const loc = (v) => (typeof v === 'string' ? v : v[L.lang] || v.en);

  /* ---------- demo state, shared by both frames ---------- */
  const PROJECT = 'team-console';
  const OWNERS = { one: ['Анна'], two: ['Анна', 'Борис'] };
  const OWNERS_EN = { one: ['Anna'], two: ['Anna', 'Boris'] };
  const fresh0 = () => ({ s: 'ready', role: 'owner', tracker: 'github', owners: 'one', added: [], outcome: null });
  const D = fresh0();
  const ownersOf = () => (L.lang === 'ru' ? OWNERS : OWNERS_EN)[D.owners];
  // The D3 states only exist on a multi-owner account.
  const isD3 = () => D.s === 'd3' || D.s === 'd3mine';
  const av = () => ({ ready: 'ready', readyEmpty: 'ready', offline: 'offline', paused: 'paused', none: 'none', d3: 'none', d3mine: 'none', refused: 'ready' }[D.s] || 'unknown');

  /* ---------- mock content ---------- */
  const KINDS = ['slot-pm', 'slot-dev', 'slot-qa', 'burn', 'audit', 'digest'];
  const RUNNER = 'Mac';
  const CURRENT = [
    { id: 'a', kind: 'digest', state: 'running', runner: RUNNER, queued: '14:02', started: '14:02' },
    { id: 'b', kind: 'slot-qa', state: 'queued', runner: null, queued: '14:05' },
  ];
  const RECENT = [
    { id: 'c', kind: 'slot-dev', state: 'finished', runner: RUNNER, queued: '12:31', started: '12:31', ended: '12:58',
      summary: { ru: 'Открыт PR #772, проверки идут.', en: 'Opened PR #772, checks are running.' } },
    { id: 'd', kind: 'audit', state: 'failed', runner: RUNNER, queued: '09:30', started: '09:31', ended: '09:44',
      summary: { ru: 'Раннер не нашёл git в PATH.', en: 'The runner could not find git in PATH.' } },
  ];
  const BOARD = {
    doing: [['771', { ru: 'Широкие экраны: раскладка страниц проекта', en: 'Wide screens: project page layout' }, 'heavy'], ['768', { ru: 'Баннер «Показано не всё» сразу после обновления', en: '“Not everything is shown” right after a refresh' }, 'light']],
    review: [['764', { ru: 'Онбординг Actions: что нужно команде от GitHub', en: 'Actions onboarding: what the team needs from GitHub' }, 'standard']],
    todo: [['775', { ru: 'Раннер для всех проектов и «Запустить» везде', en: 'Runner for all projects, Run now everywhere' }, 'heavy'], ['773', { ru: 'Индекс разделов в Настройках', en: 'A section index in Settings' }, 'standard']],
    done: [['761', { ru: 'Установка приложения', en: 'Install the app' }, 'standard'], ['750', { ru: 'Окружение проекта', en: 'Project environment' }, 'standard']],
  };
  const PRS = [['772', 'feat(console): wide-screen layout tokens', 'review'], ['769', 'fix(artifacts): list every docs/design folder', 'changes']];
  const RUNS = [['dev', '14:00', 'going'], ['qa', '13:40', 'ok'], ['pm', '12:00', 'ok'], ['dev', '11:15', 'fail']];

  /* ---------- the jobs section ---------- */
  const TONE = { queued: 'neutral', running: 'warning', finished: 'success', failed: 'danger' };
  const MARK = { queued: IX.clock, running: IX.play, finished: IX.check, failed: IX.x };
  function cardHTML(j, uid) {
    const id = `${uid}-job-${j.id}`;
    // A member reads no runners, so the card shows the id's tail, as runnerLabelOf() does today.
    const runner = j.runner ? (D.role === 'owner' ? j.runner : '…7f3a9c') : t('jobs.card.waitingForRunner');
    const rows = [[t('jobs.card.runner'), `<span dir="auto">${esc(runner)}</span>`], [t('jobs.card.queuedAt'), `<time>${t('mock.today')}, ${j.queued}</time>`]];
    if (j.started) rows.push([t('jobs.card.startedAt'), `<time>${j.started}</time>`]);
    if (j.ended) rows.push([t('jobs.card.finishedAt'), `<time>${j.ended}</time>`]);
    if (j.summary) rows.push([t('jobs.card.summary'), `<span dir="auto">${esc(loc(j.summary))}</span>`]);
    return `<li${j.fresh ? ' class="jc-new"' : ''}><article class="jc jc--${TONE[j.state]}" aria-labelledby="${id}" data-state="${j.state}">
      <div class="jc__row"><span class="jc__mark" aria-hidden="true">${MARK[j.state]}</span><div class="jc__who"><h6 class="jc__title" id="${id}">${t(`jobs.kind.${j.kind}`)}</h6>
        <p class="jc__meta"><span class="jchip jchip--${TONE[j.state]}">${t(`jobs.state.${j.state}`)}</span></p></div></div>
      <dl class="ledger jc__facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></article></li>`;
  }
  const settingsLink = (label) => `<a class="btn" href="#settings-runners" data-act="noop">${IX.gear}${label}</a>`;
  function availabilityHTML() {
    const a = av();
    if (a === 'offline') {
      return `<div class="callout jx__av" role="status" data-av="offline">${IX.wifi}<p>${t(D.role === 'owner' ? 'jobs.availability.offline' : 'jobs.availability.offlineMember')}${D.role === 'owner' ? ` <a class="ext" href="#settings-runners" data-act="noop">${t('jobs.availability.runners')}</a>` : ''}</p></div>`;
    }
    if (a === 'paused') {
      const text = D.role === 'owner' ? t('jobs.availability.paused', { time: '18:40' }) : t('jobs.availability.pausedMember');
      return `<div class="callout jx__av" role="status" data-av="paused">${IX.pause}<p>${text}</p></div>`;
    }
    // ready: no line — the empty hint and the job cards already say what happens.
    return '<div class="jx__av" role="status" data-av="ready"></div>';
  }
  function noneHTML(uid) {
    const hid = `${uid}-none-h`;
    const owners = ownersOf();
    let title = t('jobs.none.title'); let body; let action; let why = false;
    if (D.role === 'member') {
      body = t('jobs.none.member', { owners: owners.join(', ') });
      action = '';
    } else if (D.s === 'd3') {
      title = t('jobs.none.d3Title');
      body = t('jobs.none.d3', { runner: RUNNER, owner: owners[0], project: PROJECT });
      action = `<a class="btn btn--primary" href="#add-runner" data-act="noop">${IX.plus}${t('jobs.none.d3Connect')}</a>`;
      why = true;
    } else if (D.s === 'd3mine') {
      title = t('jobs.none.d3MineTitle');
      body = t('jobs.none.d3Mine', { runner: RUNNER, owner: owners[1], project: PROJECT });
      action = settingsLink(t('jobs.none.d3MineOpen', { runner: RUNNER }));
      why = true;
    } else {
      body = t('jobs.none.owner', { project: PROJECT });
      action = settingsLink(t('jobs.none.open'));
    }
    const whyHTML = why ? `<details class="jx__why"><summary>${t('jobs.none.why')}</summary><p>${t('jobs.none.whyBody')}</p></details>` : '';
    return `<section class="jx-none" aria-labelledby="${hid}" data-fk="none" data-none="${D.role === 'member' ? 'member' : D.s}">
      <span class="jx-none__mark" aria-hidden="true">${IX.plug}</span>
      <h5 class="jx-none__title" id="${hid}" tabindex="-1">${title}</h5><p class="jx-none__body" dir="auto">${body}</p>
      ${action ? `<div class="jx-none__actions">${action}</div>` : ''}${whyHTML}</section>`;
  }
  function runNowHTML(uid) {
    const hid = `${uid}-rn-h`;
    const opts = KINDS.map((k) => `<option value="${k}"${k === 'digest' ? ' selected' : ''}>${t(`jobs.kind.${k}`)}</option>`).join('');
    let outcome = '';
    if (D.outcome === 'refused' || D.s === 'refused') outcome = `<span class="rn__err">${t('jobs.err.kindNotAllowed')}</span>`;
    else if (D.outcome) outcome = `<span>${t(av() === 'ready' ? 'jobs.runNow.queued' : 'jobs.runNow.queuedWaiting', { kind: t(`jobs.kind.${D.outcome}`) })}</span>`;
    return `<form class="rn" aria-labelledby="${hid}" data-act-form="run">
      <h5 class="rn__title" id="${hid}">${t('jobs.runNow.title')}</h5>
      <div class="rn__row"><label class="field rn__kind"><span class="field__label">${t('jobs.runNow.kind')}</span>
        <select class="rn__select" id="${uid}-kind" aria-describedby="${uid}-kind-hint" data-fk="kind">${opts}</select></label>
        <button type="submit" class="btn btn--primary rn__submit" data-fk="run">${IX.play}${t('jobs.runNow.submit')}</button></div>
      <p class="field__hint" id="${uid}-kind-hint">${t('jobs.runNow.hint')}</p>
      <p class="rn__outcome" role="status">${outcome}</p></form>`;
  }
  function jobsHTML(uid) {
    const hid = `${uid}-jobs-h`;
    const a = av();
    const s = D.s;
    let top = '';
    if (s === 'loading') {
      top = `<div class="state-block jx__state" role="status">${Proto.dots}<p>${t('jobs.view.loading')}</p></div>`;
    } else if (a === 'none') {
      top = noneHTML(uid);
    } else {
      top = availabilityHTML();
      top += D.role === 'owner' ? runNowHTML(uid) : `<p class="jx__member">${IX.lock}<span>${t('jobs.member.line', { owners: ownersOf().join(', ') })}</span></p>`;
    }
    let lists = '';
    if (s === 'error') {
      lists = `<div class="block block--error jx__err"><h5>${t('jobs.view.errorTitle')}</h5><p>${t('jobs.view.errorBody')}</p><button type="button" class="btn" data-act="noop">${t('jobs.view.retry')}</button></div>`;
    } else if (s !== 'loading') {
      const empty = s === 'readyEmpty' || a === 'none';
      let cur = empty ? [] : [...CURRENT];
      if (a === 'offline' || a === 'paused') cur = cur.map((j) => ({ ...j, state: 'queued', runner: null, started: null }));
      cur = [...D.added, ...cur];
      const rec = empty ? [] : RECENT;
      const emptyCur = `<div class="jx-empty"><p class="jx-empty__t">${t('jobs.view.empty')}</p><p class="jx-empty__h">${t(D.role === 'owner' && a !== 'none' ? 'jobs.view.emptyHint' : 'jobs.view.emptyHintMember')}</p></div>`;
      lists = `<div class="jx__head"><h5 class="jx__sub">${t('jobs.view.current')}</h5><button type="button" class="btn btn--sm btn--quiet" data-act="noop">${IX.refresh}${t('jobs.view.refresh')}</button></div>
        ${cur.length ? `<ul class="jx__list" data-slot="current">${cur.map((j) => cardHTML(j, uid)).join('')}</ul>` : emptyCur}
        <h5 class="jx__sub">${t('jobs.view.recent')}</h5>
        ${rec.length ? `<ul class="jx__list">${rec.map((j) => cardHTML(j, uid)).join('')}</ul>` : `<p class="jx__note">${t('jobs.view.recentEmpty')}</p>`}`;
    }
    return `<section class="jx" aria-labelledby="${hid}" data-fk="jobs"><h4 class="jx__title" id="${hid}" tabindex="-1">${t('jobs.view.title')}</h4>${top}${lists}</section>`;
  }
  function githubLogHTML(uid) {
    if (D.tracker !== 'github') return '';
    const hid = `${uid}-log-h`;
    const runs = RUNS.map(([slot, tm, st]) => `<li><div class="item"><span class="rdot${st === 'ok' ? '' : ` rdot--${st}`}" aria-hidden="true"></span><span class="item__title">${slot}<small>${t(`b.run.${st}`)}</small></span><span class="item__num">${tm}</span></div></li>`).join('');
    return `<section class="rlog" data-fk="log" aria-labelledby="${hid}"><h4 class="jx__title" id="${hid}">${t('board.runs.githubLog')}</h4>
      <p class="jx__note">${t('board.runs.githubLogHint')}</p><ul class="rlog__list">${runs}</ul>
      <a class="ext" href="https://github.com/" target="_blank" rel="noopener noreferrer" data-act="gh">${t('board.runs.log')}${IX.ext}<span class="sr-only">, ${t('board.runs.opensGitHub')}</span></a></section>`;
  }

  /* ---------- the board and the shell (#766) ---------- */
  function boardPage(host, uid) {
    const lanes = ['doing', 'review', 'todo', 'done'].map((k) => `<div class="lane"><h4>${t(`b.lane.${k}`)} · ${BOARD[k].length}</h4><ul>${BOARD[k].map(([n, title, tier]) => `<li><button type="button" class="item" data-act="noop"><span class="item__num">#${n}</span><span class="item__title">${esc(loc(title))}</span><span class="tier tier--${tier}">${tier}</span></button></li>`).join('')}</ul></div>`).join('');
    const prs = PRS.map(([n, title, st]) => `<li><a class="item" href="https://github.com/" target="_blank" rel="noopener noreferrer" data-act="gh"><span class="item__num">#${n}</span><span class="item__title">${esc(title)}<small>${t(`b.pr.${st}`)}</small></span>${IX.ext}</a></li>`).join('');
    const open = Object.values(BOARD).slice(0, 3).reduce((s, l) => s + l.length, 0);
    const cur = D.added.length + (D.s === 'readyEmpty' || av() === 'none' || D.s === 'loading' || D.s === 'error' ? 0 : CURRENT.length + RECENT.length);
    const runsCount = cur + (D.tracker === 'github' ? RUNS.length : 0);
    const tab = host.S.ptab;
    const ptab = (k, label) => `<button type="button" class="chip-btn" role="tab" data-act="ptab" data-tab="${k}" aria-selected="${tab === k}" aria-pressed="${tab === k}" tabindex="${tab === k ? 0 : -1}">${label}</button>`;
    // Members can't start jobs, so the header's Run (a jump to the form) is the owner's only.
    const run = D.role === 'owner' ? `<button type="button" class="btn" data-act="jump">${IX.play}${t('b.run')}</button>` : '';
    return `<section class="bd" aria-labelledby="${uid}-bd-h" data-ptab="${tab}"><div class="bd__head"><h2 id="${uid}-bd-h">${t('b.title')}</h2><span class="demo-pill">${IX.clock}${t('b.demoPill')}</span><span class="bd__open">${t('b.open', { n: open })}</span>
      <div class="bd__actions">${run}<button type="button" class="btn btn--primary" data-act="noop">${IX.plus}${t('b.newTask')}</button></div></div>
      <div class="bd__ptabs" role="tablist" aria-label="${t('b.phoneTabs')}">${ptab('tasks', t('b.tasks'))}${ptab('pulls', t('b.pulls'))}${ptab('runs', `${t('b.runs')} <span class="ptab-n">${runsCount}</span>`)}</div>
      <div class="bd__secs">
        <section class="bd__sec bd__sec--tasks" aria-labelledby="${uid}-bs-t"><h3 id="${uid}-bs-t">${t('b.tasks')} <span>${open + BOARD.done.length}</span></h3>${lanes}</section>
        <section class="bd__sec bd__sec--pulls" aria-labelledby="${uid}-bs-p"><h3 id="${uid}-bs-p">${t('b.pulls')} <span>${PRS.length}</span></h3><ul>${prs}</ul></section>
        <section class="bd__sec bd__sec--runs" aria-labelledby="${uid}-bs-r"><h3 id="${uid}-bs-r">${t('b.runs')} <span>${runsCount}</span></h3>${jobsHTML(uid)}${githubLogHTML(uid)}</section>
      </div></section>`;
  }
  const TABS = [['questions', IX.chat], ['board', IX.board], ['artifacts', IX.stack], ['demo', IX.play]];
  function shell(host) {
    const uid = host.dataset.app;
    const tabs = TABS.map(([k]) => `<a class="space__tab" href="#" data-act="noop"${k === 'board' ? ' aria-current="page"' : ''}>${t(`space.${k}`)}</a>`).join('');
    const sidebar = `<nav class="sidebar" aria-label="${t('nav.aria')}">
      <div class="brand">${IX.mark}<span>Team Console</span></div>
      <ul class="side-list side-list--top"><li><a class="side-item" href="#" data-act="noop">${IX.inbox}<span>${t('nav.needs')}</span><span class="count"><span>3</span></span></a></li>
        <li><a class="side-item" href="#" data-act="noop">${IX.sum}<span>${t('nav.overview')}</span></a></li></ul>
      <div class="side-label">${t('nav.projects')}</div>
      <ul class="side-list">${[PROJECT, 'storify', 'docs-site'].map((p, k) => `<li><a class="side-item" href="#" data-act="noop"${!k ? ' aria-current="true"' : ''}><span class="prod-mono" aria-hidden="true">${p[0]}</span><span class="side-prod__label">${p}</span></a></li>`).join('')}</ul>
      <div class="side-foot"><a class="side-item side-item--new" href="#" data-act="noop">${IX.plus}<span>${t('nav.newProject')}</span></a><a class="side-item" href="#" data-act="noop">${IX.gear}<span>${t('nav.settings')}</span></a></div></nav>`;
    const top = `<header class="wd__top"><button type="button" class="icon-btn" aria-label="${t('nav.menu')}">${IX.menu}</button>
      <span class="wd__top-title"><span class="prod-mono" aria-hidden="true">t</span><span>Team Console</span></span>
      <button type="button" class="icon-btn" aria-label="${t('space.find')}">${IX.search}</button><button type="button" class="icon-btn" aria-label="${t('space.commands')}">${IX.sliders}</button><button type="button" class="icon-btn" aria-label="${t('space.newTask')}">${IX.plus}</button></header>`;
    const space = `<div class="space"><header class="space__head"><div class="space__head-in"><h1 class="space__title">Team Console</h1>
        <nav class="space__tabs" aria-label="${t('space.sections')}">${tabs}</nav>
        <button type="button" class="btn space__find">${IX.search}${t('space.find')}<kbd>/</kbd></button>
        <button type="button" class="btn">${IX.sliders}${t('space.commands')}<kbd>K</kbd></button></div></header>
      <div class="space__main"><main class="space__body" id="main-${uid}">${boardPage(host, uid)}</main></div></div>`;
    const phoneTabs = `<nav class="wd__tabs" aria-label="${t('space.sections')}">${TABS.map(([k, ico]) => `<a href="#" data-act="noop"${k === 'board' ? ' aria-current="page"' : ''}>${ico}<span>${t(`space.${k}`)}</span></a>`).join('')}</nav>`;
    return `<div class="wd" data-layout="new" data-page="board"><div class="wd__row">${sidebar}<div class="wd__main">${top}${space}</div></div>${phoneTabs}</div>`;
  }

  /* ---------- rendering and behaviour ---------- */
  const hosts = [...document.querySelectorAll('.app[data-app]')];
  hosts.forEach((h) => { h.S = { ptab: h.dataset.app === 'phone' ? 'runs' : 'tasks' }; });
  function render(focus) {
    hosts.forEach((h) => {
      h.innerHTML = shell(h);
      if (focus && focus.host === h) { const el = h.querySelector(focus.sel); if (el) el.focus(); }
    });
  }
  let seq = 0;
  function jumpToRun(host) {
    host.S.ptab = 'runs';
    render();
    const target = host.querySelector('[data-fk=kind]') || host.querySelector('.jx-none__title') || host.querySelector('.jx__title');
    if (target) { target.scrollIntoView({ block: 'center' }); target.focus(); }
  }
  hosts.forEach((host) => {
    host.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]'); if (!el) return;
      const act = el.dataset.act;
      if (act === 'noop' || act === 'gh') { e.preventDefault(); return; }
      if (act === 'ptab') { host.S.ptab = el.dataset.tab; render({ host, sel: `[data-act=ptab][data-tab=${el.dataset.tab}]` }); return; }
      if (act === 'jump') jumpToRun(host);
    });
    host.addEventListener('keydown', (e) => {
      const tabEl = e.target.closest('[data-act=ptab]');
      if (!tabEl || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const order = ['tasks', 'pulls', 'runs'];
      const i = order.indexOf(tabEl.dataset.tab) + (e.key === 'ArrowRight' ? 1 : -1);
      host.S.ptab = order[(i + order.length) % order.length];
      render({ host, sel: `[data-act=ptab][data-tab=${host.S.ptab}]` });
    });
    host.addEventListener('submit', async (e) => {
      if (!e.target.matches('[data-act-form=run]')) return;
      e.preventDefault();
      const kind = e.target.querySelector('select').value;
      const btn = e.target.querySelector('[data-fk=run]');
      btn.setAttribute('aria-disabled', 'true'); btn.innerHTML = `${Proto.dots}${plain(t('jobs.runNow.submit'))}`;
      await Proto.wait(700);
      if (D.s === 'refused') { D.outcome = 'refused'; render({ host, sel: '[data-fk=run]' }); return; }
      D.added = [{ id: `n${seq += 1}`, kind, state: 'queued', runner: null, queued: L.hhmm(new Date()), fresh: true }, ...D.added];
      D.outcome = kind;
      // Focus stays on Run; the outcome line is the polite announcement.
      render({ host, sel: '[data-fk=run]' });
      hosts.forEach((h) => { const s = h.querySelector('[data-fk=kind]'); if (s) s.value = kind; });
    });
  });

  /* ---------- page controls ---------- */
  const sel = (id) => document.getElementById(id);
  const pageChrome = Proto.page({ L, title: 'Team Console · #775', onLang: () => render() });
  function apply() {
    if (isD3()) { D.owners = 'two'; sel('d-owners').value = 'two'; if (D.role === 'member' && D.s === 'd3mine') D.s = 'd3'; }
    D.added = []; D.outcome = null;
    render();
  }
  sel('d-state').addEventListener('change', (e) => { D.s = e.target.value; apply(); });
  sel('d-role').addEventListener('change', (e) => { D.role = e.target.value; apply(); });
  sel('d-tracker').addEventListener('change', (e) => { D.tracker = e.target.value; apply(); });
  sel('d-owners').addEventListener('change', (e) => { D.owners = e.target.value; if (D.owners === 'one' && isD3()) { D.s = 'none'; sel('d-state').value = 'none'; } apply(); });
  document.querySelector('[data-reset]').addEventListener('click', () => {
    Object.assign(D, fresh0());
    hosts.forEach((h) => { h.S.ptab = h.dataset.app === 'phone' ? 'runs' : 'tasks'; });
    ['state', 'role', 'tracker', 'owners'].forEach((k) => { sel(`d-${k}`).value = D[k === 'state' ? 's' : k]; });
    render();
  });

  // ?s=…&role=…&tracker=…&owners=…&ptab=…&scroll=jobs|none&view=…&theme=…&lang=…&shot=1 opens a view directly (screenshots).
  const q = new URLSearchParams(location.search);
  if (q.has('shot')) Proto.root.dataset.shot = '';
  if (q.get('lang') === 'en' || q.get('lang') === 'ru') { L.save(q.get('lang')); pageChrome.setControl('lang', q.get('lang')); }
  ['view', 'theme', 'motion'].forEach((k) => { if (q.get(k)) pageChrome.setControl(k, q.get(k)); });
  if (q.get('s')) D.s = q.get('s');
  ['role', 'tracker', 'owners'].forEach((k) => { if (q.get(k)) D[k] = q.get(k); });
  if (q.get('ptab')) hosts.forEach((h) => { h.S.ptab = q.get('ptab'); });
  ['state', 'role', 'tracker', 'owners'].forEach((k) => { sel(`d-${k}`).value = D[k === 'state' ? 's' : k]; });
  apply();
  if (q.get('queued')) { D.added = [{ id: 'q1', kind: q.get('queued'), state: 'queued', runner: null, queued: '14:10', fresh: true }]; D.outcome = q.get('queued'); render(); }
  if (q.get('why')) document.querySelectorAll('.jx__why').forEach((d) => { d.open = true; });
  if (q.get('scroll')) hosts.forEach((h) => { const el = h.querySelector(`[data-fk=${q.get('scroll')}]`); if (el) { const main = h.querySelector('.wd__main'); main.scrollTop = Math.max(0, el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 8); } });
  pageChrome.fit();
})();
