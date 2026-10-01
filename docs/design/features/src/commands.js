/* #114 Team commands, part 1: pause / resume development and "Run now" for planning, development and QA.
   Design prototype runtime with mock data only. In the app, pause and resume write what `runlog pause` / `resume`
   write, and Run now fires the slot's routine through the Worker; the client never decides a refusal itself.
   Two independent instances (iPhone, Mac) share the team state, like the Paper Desk prototype. */
(() => {
  'use strict';
  const { isReduced, cssVar, ms, wait, esc, play, plain, I, dots } = Proto;
  const L = Proto.i18n(I18N);
  const { t, hhmm } = L;
  const MIN = 60000;
  const OVERLAP = 3 * 60 * MIN; // runstate.OVERLAP_WINDOW in the plugin: applies once the run log shows the run
  const REQUEST_LOCK = 15 * MIN; // a request (or a fire with no answer) the run log doesn't show yet (architect note on #114)
  const at = (mins) => new Date(Date.now() + mins * MIN);

  /* ---------- mock data, as the Worker would return it ---------- */
  const P = { slug: 'storify', repo: 'geeera/storify', sprint: 'Sprint 01', demo: new Date(2026, 9, 16) };
  const OTHERS = ['team-console', 'fieldnote'];
  const SLOTS = ['pm', 'dev', 'qa'];
  // Slot times from the plugin's reference/schedule-and-models.md (weekday rules; dev's Friday run opens the burn).
  const SCHEDULE = { pm: { h: 18, m: 7, days: [1, 2, 3, 4, 5] }, dev: { h: 23, m: 13, days: [1, 2, 3, 4, 5] }, qa: { h: 4, m: 21, days: [2, 3, 4, 5] } };
  function occurrences(slot) {
    const s = SCHEDULE[slot]; const out = [];
    for (let d = -8; d <= 8; d += 1) {
      const x = new Date(); x.setDate(x.getDate() + d); x.setHours(s.h, s.m, 0, 0);
      if (s.days.includes(x.getDay())) out.push(x);
    }
    return out;
  }
  const lastRun = (slot) => occurrences(slot).filter((d) => d < new Date()).pop();
  function nextRun() {
    return SLOTS.map((slot) => ({ slot, date: occurrences(slot).find((d) => d > new Date()) }))
      .filter((x) => x.date).sort((a, b) => a.date - b.date)[0];
  }
  function when(d) {
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(d) - day(new Date())) / (24 * 60 * MIN));
    const time = hhmm(d);
    if (diff === 0) return t('when.today', { time });
    if (diff === -1) return t('when.yesterday', { time });
    if (diff === 1) return t('when.tomorrow', { time });
    const wd = new Intl.DateTimeFormat(L.lang === 'ru' ? 'ru-RU' : 'en-GB', { weekday: 'short' }).format(d);
    return t('when.day', { day: wd, time });
  }
  const dateShort = (d) => new Intl.DateTimeFormat(L.lang === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'short' }).format(d);
  const nextHour = () => { const d = at(60); d.setMinutes(0, 0, 0); return d; };

  // Shared by both device frames: the team's state lives in the run log, not in a window.
  const fresh = () => ({ proj: 'running', data: 'ok', busyDev: false, freeze: false, outcome: 'ok', pausedAt: at(-13), busySince: at(-25), run: { pm: null, dev: null, qa: null }, statusAt: new Date() });
  const G = fresh();
  const paused = () => G.proj !== 'running';
  const loadedish = () => ['ok', 'offline', 'noperm', 'notoken', 'notokenQa'].includes(G.data);
  // Each slot is its own routine with its own trigger token, so setup is per slot.
  const missingSlots = () => (G.data === 'notoken' ? [...SLOTS] : G.data === 'notokenQa' ? ['qa'] : []);
  const slotList = (slots) => new Intl.ListFormat(L.lang === 'ru' ? 'ru-RU' : 'en-GB', { type: 'conjunction' }).format(slots.map((x) => t(`slot.${x}N`)));

  // Why a command is off, in the order the owner can act on it; '' when it is available.
  // Run now writes nothing to GitHub, so only pause and resume need the owner's GitHub connection.
  function whyOff(kind, slot) {
    if (G.data === 'loading' || G.data === 'error') return t('why.status');
    if (G.data === 'offline') return t('why.offline');
    if (kind === 'write' && G.data === 'noperm') return t('why.noperm');
    if (kind === 'run' && missingSlots().includes(slot)) return t('why.notoken');
    if (kind === 'run' && paused()) return t('why.paused');
    return '';
  }
  // A slot is locked for the overlap window: the run log shows it running, the console requested it, or no answer came.
  function slotLock(slot) {
    if (slot === 'dev' && G.busyDev) return { line: t('run.busy', { time: hhmm(G.busySince), until: hhmm(new Date(G.busySince.getTime() + OVERLAP)) }), live: true };
    const r = G.run[slot];
    if (!r) return null;
    const until = hhmm(new Date(r.at.getTime() + (r.state === 'started' ? OVERLAP : REQUEST_LOCK)));
    if (r.state === 'requested') return { line: t('run.requested', { time: hhmm(r.at), until }), live: true };
    if (r.state === 'started') return { line: t('run.started', { time: hhmm(r.at), until }), live: true };
    return { line: t('run.unknown', { time: hhmm(r.at), until }), live: false, unknown: true };
  }

  const hosts = [...document.querySelectorAll('[data-app]')];
  const renderAll = () => hosts.forEach((h) => h.app && h.app.render());

  /* ---------- one app instance ---------- */
  function mountApp(host, kind, keep) {
    const S = keep || { panel: false, dialog: null, result: null, resultNew: false, refreshing: false, howOpen: false, shownProj: G.proj };
    host.S = S;
    const uid = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const $ = (s) => host.querySelector(s);
    const dis = (why) => (why ? ` aria-disabled="true"` : '');
    const runlogLink = (fk) => `<a class="ext" href="#runlog" data-act="runlog" data-fk="${fk}">${t('st.log')}<span class="sr-only"> ${t('c.external')}</span>${I.ext}</a>`;
    const commandsBtn = () => `<button type="button" class="btn ${kind === 'phone' ? 'btn--sm p-cmd' : 'cp-open'}" data-act="panel-toggle" data-fk="open-cmd" aria-label="${esc(t('space.commandsAria', { name: P.slug }))}" aria-expanded="${S.panel}" ${kind === 'mac' ? `aria-controls="${uid}-pane" aria-keyshortcuts="K"` : 'aria-haspopup="dialog"'}>${I.sliders}<span>${t('space.commands')}</span>${kind === 'mac' ? '<kbd aria-hidden="true">K</kbd>' : ''}</button>`;

    host.innerHTML = kind === 'mac' ? `<div class="win">
        <div class="win__bar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="win__title">Team Console</span></div>
        <div class="win__body">
          <nav class="sidebar" aria-label="${t('nav.aria')}" data-bg>
            <div class="brand">${I.mark}<span>Team Console</span></div>
            <label class="search search--side">${I.search}<span class="sr-only">${t('nav.filter')}</span><input type="search" placeholder="${t('nav.filter')}" autocomplete="off"><kbd>/</kbd></label>
            <ul class="side-list side-list--top">
              <li><button type="button" class="side-item" data-act="elsewhere">${I.inbox}<span>${t('nav.needs')}</span><span class="count">2</span></button></li>
              <li><button type="button" class="side-item" data-act="elsewhere">${I.grid}<span>${t('nav.all')}</span></button></li>
            </ul>
            <div class="side-label">${t('nav.projects')}</div>
            <ul class="side-list" data-slot="side"></ul>
            <div class="side-foot"><span class="avatar avatar--owner" aria-hidden="true">K</span><span>${t('nav.owner')}</span></div>
          </nav>
          <section class="convo" aria-labelledby="${uid}-name" data-bg>
            <header class="convo__head" data-slot="head"></header>
            <div class="banner-wrap" data-slot="banner"></div>
            <div class="log"><div class="log__inner" data-slot="log"></div></div>
          </section>
          <section class="pane cp-pane" id="${uid}-pane" aria-labelledby="${uid}-cp" data-slot="pane"><div class="pane__inner cp" data-slot="panel"></div></section>
        </div>
      </div>
      <div data-slot="modal"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`
      : `<div class="p-status" aria-hidden="true"><span>9:41</span><span class="p-island"></span><span class="p-status__icons">${I.bars}${I.battery}</span></div>
      <div data-slot="head" data-bg></div>
      <div class="banner-wrap" data-slot="banner" data-bg></div>
      <div class="log p-log" data-bg><div class="log__inner" data-slot="log"></div></div>
      <nav class="tabs" aria-label="${t('nav.sections')}" data-bg>
        <button type="button" data-act="elsewhere">${I.inbox}<span>${t('nav.needs')}</span><span class="count">2</span></button>
        <button type="button" aria-current="page">${I.chat}<span>${t('nav.chat')}</span></button>
        <button type="button" data-act="elsewhere">${I.board}<span>${t('nav.board')}</span></button>
        <button type="button" data-act="elsewhere">${I.stack}<span>${t('nav.artifacts')}</span></button>
      </nav>
      <div class="home-ind" aria-hidden="true"></div>
      <div class="scrim" data-act="panel-close"></div>
      <section class="sheet cp-sheet" role="dialog" aria-modal="true" aria-labelledby="${uid}-cp" data-slot="sheet" inert>
        <div class="sheet__grab" aria-hidden="true"></div>
        <div class="cp" data-slot="panel"></div>
      </section>
      <div data-slot="modal"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`;

    /* ----- the space around the panel ----- */
    function headHTML() {
      const sub = t('space.sub', { sprint: P.sprint, date: dateShort(P.demo) });
      if (kind === 'mac') {
        return `<div class="convo__title"><span class="prod-mono" aria-hidden="true">s</span><h2 id="${uid}-name">${P.slug}</h2><span class="convo__sub">${sub}</span></div>${commandsBtn()}`;
      }
      return `<header class="p-head"><button type="button" class="p-switch" data-act="elsewhere" aria-haspopup="dialog" aria-label="${esc(t('nav.switch', { name: P.slug }))}"><span class="prod-mono" aria-hidden="true">s</span><span class="p-switch__txt"><b>${P.slug}</b><small>${sub}</small></span>${I.down}</button>${commandsBtn()}</header>`;
    }
    function bannerHTML() {
      if (!paused() || !loadedish()) return '';
      const team = G.proj === 'team';
      const why = whyOff('write');
      return `<div class="paused cp-banner${team ? ' paused--bad' : ''}" role="status" data-banner>${team ? I.warn : I.pause}<span>${t(team ? 'banner.team' : 'banner.owner', { name: P.slug, time: hhmm(G.pausedAt) })}</span>
        <span class="cp-banner__acts">${team ? runlogLink('banner-log') : ''}<button type="button" class="btn btn--sm" data-act="resume" data-from="banner" data-fk="banner-resume"${dis(why)}${why ? ` aria-describedby="${uid}-banner-why"` : ''}>${t('banner.resume')}</button>${why ? `<span class="sr-only" id="${uid}-banner-why">${why}</span>` : ''}</span></div>`;
    }
    const logHTML = () => `<div class="day"><span>${t('chat.today')}</span></div>
      <div class="msg msg--pm"><span class="avatar avatar--pm" aria-hidden="true">PM</span><div class="msg__body"><div class="msg__meta"><b>${t('chat.pm')}</b><span>${hhmm(at(-300))}</span></div><div class="bubble">${t('chat.m1')}</div></div></div>
      <div class="msg msg--pm"><span class="avatar avatar--pm" aria-hidden="true">PM</span><div class="msg__body"><div class="msg__meta"><b>${t('chat.pm')}</b><span>${hhmm(at(-298))}</span></div><div class="bubble">${t('chat.m2')}</div></div></div>`;
    function sideHTML() {
      const dot = G.proj === 'team' ? ' sdot--failing' : paused() ? ' sdot--paused' : '';
      return [P.slug, ...OTHERS].map((slug, i) => `<li><button type="button" class="side-item"${i === 0 ? ' aria-current="true"' : ' data-act="elsewhere"'}><span class="prod-mono" aria-hidden="true">${slug[0]}</span><span class="side-prod__label">${slug}</span>${i === 0 ? `<i class="sdot${dot}" aria-hidden="true"></i>` : '<i class="sdot" aria-hidden="true"></i>'}</button></li>`).join('');
    }

    /* ----- the Commands panel ----- */
    function resultHTML() {
      const r = S.result; if (!r) return '';
      const glyph = r.tone === 'warning' ? I.q : r.tone === 'neutral' ? I.minus : I.check;
      const toneCls = r.tone === 'neutral' ? ' receipt--neutral' : r.tone === 'warning' ? ' cp-res--warning' : '';
      const cls = `receipt cp-res${toneCls}${S.resultNew ? ' is-new' : ''}`;
      return `<div class="${cls}" tabindex="-1" data-fk="result"><span class="receipt__icon" aria-hidden="true">${glyph}</span><span class="cp-res__main"><span class="receipt__body"><span class="receipt__verb">${r.verb}</span>${r.detail ? ` <span class="cp-res__detail">${r.detail}</span>` : ''}</span><span class="receipt__meta">${hhmm(r.time)}${r.log ? ` · ${runlogLink('res-log')}` : ''}</span></span></div>`;
    }
    function stateHTML() {
      if (G.data === 'loading') {
        return `<div class="cp-state" aria-busy="true"><span class="sr-only">${t('st.loading')}</span><div aria-hidden="true" class="skel-stack"><span class="skel skel--a"></span><span class="skel skel--b"></span></div></div>`;
      }
      if (G.data === 'error') {
        return `<div class="block block--error cp-err" role="alert"><h3>${t('st.errT')}</h3><p>${t('st.errB')}</p><button type="button" class="btn btn--tall" data-act="refresh" data-fk="st-retry"${dis(S.refreshing)}>${S.refreshing ? `${t('st.refreshing')}` : t('c.retry')}</button></div>`;
      }
      const state = G.proj === 'running' ? t('st.running') : G.proj === 'owner' ? t('st.owner', { time: hhmm(G.pausedAt) }) : t('st.team');
      const off = G.data === 'offline';
      let note = '';
      if (off) note = `<p class="paused cp-note" role="status">${I.wifi}<span>${t('st.offline', { time: hhmm(G.statusAt) })}</span></p>`;
      if (G.data === 'noperm') note = `<p class="paused cp-note">${I.lock}<span>${t('st.noperm', { repo: P.repo })} <a href="#settings" data-act="settings" data-fk="noperm-fix">${t('st.nopermFix')}</a></span></p>`;
      return `<section class="cp-state" aria-labelledby="${uid}-st"><h3 class="cp-kicker" id="${uid}-st">${t('st.h')}</h3>
        <p class="cp-state__now cp-state__now--${G.proj}" data-state>${G.proj === 'team' ? I.warn : `<i class="sdot${paused() ? ' sdot--paused' : ''}" aria-hidden="true"></i>`}<span>${state}</span></p>
        <p class="cp-state__meta"><span>${t('st.updated', { time: hhmm(G.statusAt) })}</span><button type="button" class="link-btn cp-refresh" data-act="refresh" data-fk="st-refresh"${dis(off || S.refreshing)}>${I.refresh}<span>${S.refreshing ? t('st.refreshing') : t('st.refresh')}</span></button>${runlogLink('st-log')}</p>
        </section>${note}`;
    }
    function teamHTML() {
      const why = whyOff('write');
      const id = `${uid}-team`;
      let title; let hint; let label; let btn; let primary = false;
      if (!loadedish()) { title = t('cmd.unknown'); hint = t('cmd.unknownHint'); label = ''; btn = t('cmd.unknownBtn'); }
      else if (paused()) {
        const n = nextRun();
        title = t('cmd.resume'); hint = t('cmd.resumeHint', { slot: t(`slot.${n.slot}N`), when: when(n.date) }); label = t('cmd.resume'); btn = t('cmd.resumeBtn'); primary = true;
      } else { title = t('cmd.pause'); hint = t('cmd.pauseHint'); label = t('cmd.pause'); btn = t('cmd.pauseBtn'); }
      const act = paused() ? 'resume' : 'pause';
      return `<section class="cp-group" aria-labelledby="${uid}-gt"><h3 class="cp-kicker" id="${uid}-gt">${t('g.team')}</h3>
        <div class="cmd-list"><div class="cmd cmd--team">
          <div class="cmd__txt"><p class="cmd__title">${title}</p><p class="cmd__hint" id="${id}-hint">${hint}</p>${why ? `<p class="cmd__why" id="${id}-why">${I.lock}<span>${why}</span></p>` : ''}</div>
          <button type="button" class="btn cmd__btn${primary ? ' btn--primary' : ''}" data-act="${act}" data-from="panel" data-fk="cmd-team" ${label ? ` aria-label="${esc(label)}"` : ''} aria-describedby="${why ? `${id}-why ` : ''}${id}-hint"${dis(why)}>${!loadedish() ? '' : paused() ? I.play : I.pause}<span>${btn}</span></button>
        </div></div></section>`;
    }
    function runRow(slot) {
      const lock = loadedish() ? slotLock(slot) : null;
      const why = whyOff('run', slot);
      const id = `${uid}-run-${slot}`;
      const last = lastRun(slot);
      const line = lock ? lock.line : loadedish() ? t('run.last', { when: when(last) }) : '';
      const off = why || lock;
      const describedBy = [why ? `${id}-why` : '', `${id}-line`, slot === 'dev' && G.freeze ? `${id}-freeze` : ''].filter(Boolean).join(' ');
      return `<li class="cmd">
        <div class="cmd__txt"><p class="cmd__title">${t(`slot.${slot}`)}</p>
          <p class="cmd__line${line ? '' : ' sr-only'}${lock && lock.unknown ? ' cmd__line--unknown' : ''}" id="${id}-line">${lock && lock.live ? '<i class="cmd__live" aria-hidden="true"></i>' : lock ? I.clock : ''}<span>${line}</span></p>
          ${slot === 'dev' && G.freeze ? `<p class="cmd__hint" id="${id}-freeze">${t('run.freezeRow')}</p>` : ''}
          ${why ? `<p class="cmd__why" id="${id}-why">${missingSlots().includes(slot) && why === t('why.notoken') ? I.key : G.data === 'offline' ? I.wifi : I.lock}<span>${why}</span></p>` : ''}</div>
        <button type="button" class="btn cmd__btn" data-act="run" data-slot="${slot}" data-fk="run-${slot}" aria-label="${esc(t('run.btnAria', { slot: t(`slot.${slot}`) }))}" aria-describedby="${describedBy}"${dis(off)}>${I.play}<span>${t('run.btn')}</span></button>
      </li>`;
    }
    function setupHTML() {
      const missing = missingSlots(); if (!missing.length) return '';
      const id = `${uid}-how`;
      const key = (x) => `${P.slug.toUpperCase().replace(/-/g, '_')}_${x.toUpperCase()}`;
      const line = (cmd, slot, what) => `<div class="codeline"><code>${esc(cmd)}</code><button type="button" class="btn btn--sm" data-act="copy" data-value="${esc(cmd)}" data-fk="setup-copy-${what}-${slot}" aria-label="${esc(t(`setup.copy.${what}`, { slot: t(`slot.${slot}N`) }))}">${I.copy}<span aria-hidden="true">${t('c.copy')}</span></button></div>`;
      const cmds = missing.map((x) => `<li class="cp-slot"><span class="cp-slot__name">${t(`slot.${x}`)}</span>${line(`npx wrangler secret put SLOT_ROUTINE_${key(x)} --env production`, x, 'id')}${line(`npx wrangler secret put SLOT_TOKEN_${key(x)} --env production`, x, 'token')}</li>`).join('');
      return `<div class="cp-setup"><div class="cp-setup__head">${I.key}<h4>${t('setup.t', { slots: slotList(missing), n: missing.length })}</h4></div><p>${t('setup.b', { name: P.slug, n: missing.length })}</p>
        <button type="button" class="btn btn--quiet btn--sm how-btn" data-act="how" aria-expanded="${S.howOpen}" aria-controls="${id}" data-fk="setup-how">${t('setup.how')}${I.down}</button>
        <div class="how" id="${id}"${S.howOpen ? '' : ' hidden'}><ol class="cp-steps"><li>${t('setup.s1', { name: P.slug, slots: slotList(missing), n: missing.length })}</li>
          <li>${t('setup.s2')}<ul class="cp-slots">${cmds}</ul></li>
          <li>${t('setup.s3')}</li></ol></div></div>`;
    }
    function panelHTML() {
      const body = G.data === 'loading'
        ? `${stateHTML()}<div class="cmd-list" aria-hidden="true">${'<div class="skel-row"><span class="skel-stack"><span class="skel skel--a"></span><span class="skel skel--b"></span></span></div>'.repeat(4)}</div>`
        : `${resultHTML()}${stateHTML()}${teamHTML()}<section class="cp-group" aria-labelledby="${uid}-gr"><h3 class="cp-kicker" id="${uid}-gr">${t('g.run')}</h3>${setupHTML()}<ul class="cmd-list">${SLOTS.map(runRow).join('')}</ul></section>`;
      return `<header class="cp__head"><h2 class="cp__title" id="${uid}-cp" tabindex="-1" data-fk="cp-h">${t('panel.title', { name: P.slug })}</h2>
        <button type="button" class="icon-btn" data-act="panel-close" data-fk="cp-close" aria-label="${esc(t('panel.close'))}">${I.x}</button></header>
        <div class="cp__body">${body}</div>`;
    }

    /* ----- render with focus kept by data-fk ----- */
    function render(opts = {}) {
      const active = host.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
      $('[data-slot=head]').innerHTML = headHTML();
      $('[data-slot=banner]').innerHTML = bannerHTML();
      $('[data-slot=log]').innerHTML = logHTML();
      if (kind === 'mac') $('[data-slot=side]').innerHTML = sideHTML();
      $('[data-slot=panel]').innerHTML = panelHTML();
      S.resultNew = false;
      setPanel(S.panel, true);
      if (S.shownProj !== G.proj) { motionStateChange(S.shownProj, G.proj); S.shownProj = G.proj; }
      const target = opts.focus ? host.querySelector(`[data-fk="${opts.focus}"]`) : active ? host.querySelector(`[data-fk="${active}"]`) : null;
      if (target && (opts.focus || !S.dialog)) target.focus({ preventScroll: !opts.focus });
    }
    // Pause and resume move only what changed: the banner drops in, the state line crossfades.
    function motionStateChange(from, to) {
      const banner = $('[data-banner]'); const now = $('[data-state]');
      if (isReduced()) { [banner, now].forEach((el) => el && play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') })); return; }
      if (banner && from === 'running') play(banner, [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: ms('--dur-base'), easing: cssVar('--ease-enter') });
      if (now) play(now, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-base'), easing: cssVar('--ease-standard') });
      if (to === 'running') { const btn = $('[data-fk=cmd-team]'); if (btn) play(btn, [{ opacity: 0.4 }, { opacity: 1 }], { duration: ms('--dur-base'), easing: cssVar('--ease-standard') }); }
    }
    const announce = (txt) => { const l = $('[data-slot=live]'); l.textContent = ''; setTimeout(() => { l.textContent = txt; }, 30); };
    let toastTimer;
    function toast(txt) {
      const el = $('[data-slot=toast]'); el.textContent = txt; el.hidden = false;
      if (!isReduced()) play(el, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: ms('--dur-base'), easing: cssVar('--ease-enter') });
      else play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') });
      clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms('--dur-toast'));
    }

    /* ----- panel: a non-modal pane on the Mac, a modal sheet on the iPhone ----- */
    function setPanel(open, quiet) {
      S.panel = open;
      const btn = $('[data-fk=open-cmd]'); if (btn) btn.setAttribute('aria-expanded', String(open));
      if (kind === 'mac') {
        const pane = $('[data-slot=pane]'); pane.classList.toggle('is-open', open); pane.inert = !open;
        host.querySelectorAll('[data-bg]').forEach((el) => { el.inert = !!S.dialog; });
      } else {
        host.classList.toggle('has-sheet', open);
        const sh = $('[data-slot=sheet]'); sh.classList.toggle('is-open', open); sh.inert = !open || !!S.dialog;
        host.querySelectorAll('[data-bg]').forEach((el) => { el.inert = open || !!S.dialog; });
      }
      if (open && !quiet) $('[data-fk=cp-h]').focus();
    }
    function openPanel() { setPanel(true); }
    function closePanel() { S.result = null; setPanel(false); render(); $('[data-fk=open-cmd]').focus(); }

    /* ----- confirmations: one alertdialog per command ----- */
    function dialogBody(d) {
      if (d.type === 'pause') {
        return `<ul class="cmd-dialog__list"><li>${t('p.b1')}</li><li>${t('p.b2')}</li><li>${t('p.b3')}</li></ul>`;
      }
      if (d.type === 'resume') {
        const n = nextRun();
        const team = G.proj === 'team' ? `<div class="cmd-dialog__warn">${I.warn}<p>${t('r.bTeam')} ${runlogLink('dlg-log')}</p></div>` : '';
        return `${team}<p>${t('r.b', { slot: t(`slot.${n.slot}N`), when: when(n.date) })}</p>`;
      }
      const body = d.slot === 'dev' && G.freeze ? `<p class="cmd-dialog__note">${t('run.devFreeze')}</p>` : `<p>${t(`run.${d.slot}`)}</p>`;
      return `${body}<p class="cmd-dialog__quota">${t('run.quota')}</p>`;
    }
    function dialogHTML() {
      const d = S.dialog;
      const title = d.type === 'pause' ? t('p.t', { name: P.slug }) : d.type === 'resume' ? t('r.t', { name: P.slug }) : t('run.t', { slot: t(`slot.${d.slot}L`) });
      const ok = d.busy ? `${t('c.sending')}` : d.error ? t('c.retry') : t(d.type === 'pause' ? 'p.ok' : d.type === 'resume' ? 'r.ok' : 'run.ok');
      const field = d.type === 'pause' ? `<div class="field"><label class="field__label" for="${uid}-reason">${t('p.reason')}</label>
          <input class="field__input" id="${uid}-reason" data-fk="dlg-reason" data-reason type="text" autocomplete="off" enterkeyhint="done" value="${esc(d.reason || '')}" aria-describedby="${uid}-reason-hint"${d.busy ? ' readonly' : ''}>
          <p class="field__hint" id="${uid}-reason-hint">${t('p.reasonHint')}</p></div>` : '';
      return `<div class="modal"><div class="modal__scrim" data-act="dlg-scrim"></div>
        <div class="adialog cmd-dialog${G.proj === 'team' && d.type === 'resume' ? ' cmd-dialog--warn' : ''}" role="alertdialog" aria-modal="true" aria-labelledby="${uid}-dt" aria-describedby="${uid}-dd${d.error ? ` ${uid}-de` : ''}">
          <h2 id="${uid}-dt" tabindex="-1" data-fk="dlg-h">${title}</h2>
          <div class="cmd-dialog__body" id="${uid}-dd">${dialogBody(d)}</div>
          ${field}
          ${d.error ? `<div class="adialog__err" role="alert" id="${uid}-de">${I.warn}<span>${d.error}</span></div>` : ''}
          <div class="adialog__actions"><button type="button" class="btn" data-act="dlg-cancel" data-fk="dlg-cancel"${dis(d.busy)}>${t('c.cancel')}</button>
          <button type="button" class="btn btn--primary" data-act="dlg-ok" data-fk="dlg-ok"${dis(d.busy)}>${d.busy ? dots : ''}<span>${ok}</span></button></div>
        </div></div>`;
    }
    function openDialog(d) {
      S.dialog = { busy: false, error: null, reason: '', ...d };
      const m = $('[data-slot=modal]'); m.innerHTML = dialogHTML();
      setPanel(S.panel, true);
      const box = m.querySelector('.adialog'); const scrim = m.querySelector('.modal__scrim');
      if (isReduced()) { play(box, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') }); play(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') }); }
      else {
        play(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-base'), easing: cssVar('--ease-standard') });
        play(box, kind === 'phone' ? [{ transform: 'translateY(100%)' }, { transform: 'none' }] : [{ opacity: 0, transform: 'translateY(8px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: ms(kind === 'phone' ? '--dur-slow' : '--dur-base'), easing: cssVar('--ease-enter') });
      }
      m.querySelector('[data-fk=dlg-h]').focus();
    }
    function redrawDialog(focusFk) {
      const reason = $('[data-reason]'); if (reason) S.dialog.reason = reason.value;
      const active = focusFk || (document.activeElement && document.activeElement.dataset.fk) || 'dlg-ok';
      const m = $('[data-slot=modal]'); m.innerHTML = dialogHTML();
      const f = m.querySelector(`[data-fk="${active}"]`) || m.querySelector('[data-fk=dlg-ok]'); f.focus();
    }
    function closeDialog(focusFk) {
      S.dialog = null; $('[data-slot=modal]').innerHTML = '';
      setPanel(S.panel, true);
      const f = focusFk && host.querySelector(`[data-fk="${focusFk}"]`); if (f) f.focus();
    }
    // The result of a command: a margin note at the top of the panel, or a toast when it came from outside it.
    function report(d, res) {
      announce(plain([res.verb, res.detail].filter(Boolean).join(' ')));
      if (d.from === 'banner' && !S.panel) { renderAll(); toast(plain(res.verb)); $('[data-fk=open-cmd]').focus(); return; }
      S.result = { ...res, time: new Date() }; S.resultNew = true;
      hosts.forEach((h) => { if (h !== host && h.app) h.app.render(); });
      render({ focus: res.focus || 'result' });
    }
    async function confirmDialog() {
      const d = S.dialog; if (!d || d.busy) return;
      const reason = $('[data-reason]'); if (reason) d.reason = reason.value;
      d.busy = true; d.error = null; redrawDialog('dlg-ok');
      await wait(900);
      const o = G.outcome;
      if (d.type === 'pause' || d.type === 'resume') {
        const toPaused = d.type === 'pause';
        if (o === 'error' || o === 'timeout') { d.busy = false; d.error = t('err.github'); redrawDialog('dlg-ok'); return; }
        if (o === 'rate') { d.busy = false; d.error = t('err.rate', { time: hhmm(at(15)) }); redrawDialog('dlg-ok'); return; }
        closeDialog();
        if (o === 'conflict') {
          // The team chat got there first: nothing is written, the panel shows the state GitHub has.
          G.proj = toPaused ? 'owner' : 'running'; if (toPaused) G.pausedAt = at(-13); G.statusAt = new Date();
          report(d, { tone: 'neutral', verb: t(toPaused ? 'p.conflict' : 'r.conflict', { name: P.slug, time: hhmm(G.pausedAt) }), log: false });
          return;
        }
        G.proj = toPaused ? 'owner' : 'running'; G.pausedAt = new Date(); G.statusAt = new Date();
        report(d, { tone: 'positive', verb: t(toPaused ? 'p.done' : 'r.done', { name: P.slug }), log: true, focus: 'cmd-team' });
        return;
      }
      const slot = d.slot; const name = t(`slot.${slot}N`);
      if (o === 'error') { d.busy = false; d.error = t('run.err'); redrawDialog('dlg-ok'); return; }
      // One 429 for both caps (routine and account): the API doesn't say which, so the copy names both and Retry-After.
      if (o === 'rate') { d.busy = false; d.error = t('run.rate', { time: hhmm(nextHour()) }); redrawDialog('dlg-ok'); return; }
      closeDialog();
      if (o === 'conflict') {
        // The server's overlap guard: a run of this slot is already in the run log; nothing is fired.
        const since = at(-25); G.run[slot] = { state: 'started', at: since };
        report(d, { tone: 'neutral', verb: t('run.overlap', { slot: t(`slot.${slot}`), time: hhmm(since) }), log: true });
        return;
      }
      if (o === 'timeout') {
        G.run[slot] = { state: 'unknown', at: new Date() };
        report(d, { tone: 'warning', verb: t('run.timeout', { time: hhmm(at(15)) }), log: true });
        return;
      }
      G.run[slot] = { state: 'requested', at: new Date() };
      report(d, { tone: 'positive', verb: t('run.done', { slot: name }), detail: t('run.doneDetail'), log: true });
      // The run log shows the run a little later; the row follows it without moving focus.
      setTimeout(() => { const r = G.run[slot]; if (r && r.state === 'requested') { G.run[slot] = { state: 'started', at: at(0) }; renderAll(); } }, 8000);
    }

    /* ----- small actions ----- */
    async function refresh() {
      if (S.refreshing || G.data === 'offline') return;
      S.refreshing = true; render();
      await wait(800);
      S.refreshing = false;
      if (G.data === 'error') { G.data = 'ok'; syncDemo(); }
      G.statusAt = new Date();
      renderAll();
      announce(plain(t('st.updated', { time: hhmm(G.statusAt) })));
    }
    async function copy(btn) {
      try { await navigator.clipboard.writeText(btn.dataset.value); } catch (err) { console.warn('Clipboard unavailable in this preview', err); }
      const label = btn.querySelector('span'); label.textContent = t('c.copied'); btn.dataset.copied = '';
      announce(t('c.copied'));
      setTimeout(() => { if (btn.isConnected) { label.textContent = t('c.copy'); delete btn.dataset.copied; } }, ms('--dur-toast'));
    }
    // An off command stays focusable; pressing it says why and does nothing else.
    function sayWhy(el) {
      const ids = (el.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
      const txt = ids.map((id) => host.querySelector(`[id="${id}"]`)).filter(Boolean).map((n) => n.textContent.trim()).join('. ');
      announce(`${plain(el.getAttribute('aria-label') || el.textContent)}: ${txt}`);
      const why = ids.map((id) => host.querySelector(`[id="${id}"]`)).find((n) => n && (n.classList.contains('cmd__why') || n.classList.contains('cmd__line')));
      if (why && !isReduced()) play(why, [{ transform: 'translateX(0)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(-2px)' }, { transform: 'none' }], { duration: ms('--dur-base'), easing: cssVar('--ease-standard') });
    }

    /* ----- events ----- */
    host.onclick = (e) => {
      const el = e.target.closest('[data-act]'); if (!el || !host.contains(el)) return;
      const act = el.dataset.act;
      if (el.tagName === 'A') e.preventDefault();
      if (el.getAttribute('aria-disabled') === 'true') { if (!S.dialog) sayWhy(el); return; }
      switch (act) {
        case 'panel-toggle': if (S.panel) closePanel(); else openPanel(); break;
        case 'panel-close': closePanel(); break;
        case 'pause': openDialog({ type: 'pause', from: el.dataset.from, opener: el.dataset.fk }); break;
        case 'resume': openDialog({ type: 'resume', from: el.dataset.from, opener: el.dataset.fk }); break;
        case 'run': openDialog({ type: 'run', slot: el.dataset.slot, from: 'panel', opener: el.dataset.fk }); break;
        case 'dlg-cancel': case 'dlg-scrim': if (!S.dialog.busy) closeDialog(S.dialog.opener); break;
        case 'dlg-ok': confirmDialog(); break;
        case 'refresh': refresh(); break;
        case 'how': S.howOpen = !S.howOpen; render(); break;
        case 'copy': copy(el); break;
        case 'runlog': toast(t('demo.runlog')); break;
        case 'settings': toast(plain(t('demo.settings'))); break;
        case 'elsewhere': toast(t('demo.elsewhere')); break;
        default: break;
      }
    };
    host.onkeydown = (e) => {
      if (S.dialog) {
        if (e.key === 'Escape') { e.preventDefault(); if (!S.dialog.busy) closeDialog(S.dialog.opener); return; }
        if (e.key === 'Enter' && e.target.matches('[data-reason]')) { e.preventDefault(); confirmDialog(); return; }
        if (e.key === 'Tab') {
          const f = [...host.querySelectorAll('.adialog a[href], .adialog button, .adialog input')];
          const i = f.indexOf(document.activeElement);
          if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
          else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
        }
        return;
      }
      if (e.key === 'Escape' && S.panel) { e.preventDefault(); closePanel(); return; }
      // Mac: K opens and closes the panel, like the prototype's bare-letter shortcuts (also on the Russian layout).
      const typing = e.target.matches('input, textarea, [contenteditable]');
      if (kind === 'mac' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && (e.code === 'KeyK' || /^[kл]$/i.test(e.key))) {
        e.preventDefault(); if (S.panel) closePanel(); else openPanel();
      }
    };

    const app = {
      render, S,
      go: (screen) => {
        if (S.dialog) closeDialog();
        S.result = null; S.howOpen = false;
        if (screen === 'space') { S.panel = false; render(); return; }
        if (screen === 'setup') { G.data = 'notoken'; S.howOpen = true; }
        if (screen === 'pause' || screen === 'run') { G.proj = 'running'; if (G.data === 'notoken' || G.data === 'notokenQa' || G.data === 'error' || G.data === 'loading') G.data = 'ok'; }
        if (screen === 'run') G.run.dev = null;
        if (screen === 'resume' && !paused()) { G.proj = 'owner'; G.pausedAt = at(-13); }
        S.panel = true; render();
        if (screen === 'pause') openDialog({ type: 'pause', from: 'panel', opener: 'cmd-team' });
        if (screen === 'resume') openDialog({ type: 'resume', from: 'panel', opener: 'cmd-team' });
        if (screen === 'run') openDialog({ type: 'run', slot: 'dev', from: 'panel', opener: 'run-dev' });
      },
    };
    host.app = app;
    render();
    return app;
  }

  /* ---------- page controls ---------- */
  const mountAll = (keep) => hosts.forEach((h) => { const prev = keep && h.S ? h.S : null; h.className = 'app'; mountApp(h, h.dataset.app, prev); });
  const pageChrome = Proto.page({ L, title: 'Team Console · #114', onLang: () => mountAll(true) });
  const sel = (id) => document.getElementById(id);
  function syncDemo() { sel('d-proj').value = G.proj; sel('d-data').value = G.data; sel('d-outcome').value = G.outcome; sel('d-busy').checked = G.busyDev; sel('d-freeze').checked = G.freeze; }
  sel('d-proj').addEventListener('change', (e) => { G.proj = e.target.value; G.pausedAt = at(-13); renderAll(); });
  sel('d-data').addEventListener('change', (e) => { G.data = e.target.value; renderAll(); });
  sel('d-outcome').addEventListener('change', (e) => { G.outcome = e.target.value; });
  sel('d-busy').addEventListener('change', (e) => { G.busyDev = e.target.checked; renderAll(); });
  sel('d-freeze').addEventListener('change', (e) => { G.freeze = e.target.checked; renderAll(); });
  sel('d-screen').addEventListener('change', (e) => { const v = e.target.value; if (!v) return; hosts.forEach((h) => h.app.go(v)); e.target.value = ''; syncDemo(); });
  document.querySelector('[data-reset]').addEventListener('click', () => { Object.assign(G, fresh()); syncDemo(); mountAll(false); });
  mountAll(false);
  syncDemo();
  pageChrome.fit();
})();
