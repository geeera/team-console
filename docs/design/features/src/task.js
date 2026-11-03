/* #107 New task: quick capture with a sprint request. Design prototype runtime with mock data only; the real app
   creates the issue through the Worker on the owner's token (labels kind:* + status:proposed, the sprint request
   line and its marker in the body, no milestone) and keeps the one draft per device in `tc.state.v1`.
   Two independent instances (iPhone, Mac) share the demo controls, like the other feature pages. */
(() => {
  'use strict';
  const { isReduced, cssVar, ms, wait, esc, play, plain, I, dots } = Proto;
  const L = Proto.i18n(I18N);
  const { t, hhmm } = L;

  const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const J = {
    eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
    snow: svg('<path d="M12 3.5v17M4.6 7.75l14.8 8.5M19.4 7.75l-14.8 8.5"/><path d="M9.5 5l2.5 2 2.5-2M9.5 19l2.5-2 2.5 2"/>'),
    spark: svg('<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.6 6.6l2.2 2.2M15.2 15.2l2.2 2.2M17.4 6.6l-2.2 2.2M8.8 15.2l-2.2 2.2"/>'),
    bug: svg('<rect x="7.5" y="8" width="9" height="11" rx="4.5"/><path d="M9.5 8a2.5 2.5 0 015 0M4.5 12.5h3M16.5 12.5h3M5.5 8l2.3 1.5M18.5 8l-2.3 1.5M5.5 18l2.3-1.5M18.5 18l-2.3-1.5"/>'),
    wrench: svg('<path d="M14.5 5.5a4 4 0 00-4.9 5.2l-5.1 5.1a1.6 1.6 0 002.3 2.3l5.1-5.1a4 4 0 005.2-4.9l-2.4 2.4-2.3-.6-.6-2.3z"/>'),
  };
  const KIND_ICON = { feature: J.spark, bug: J.bug, chore: J.wrench };

  /* ---------- mock data ---------- */
  const TITLE_MAX = 200; const TEXT_MAX = 5000; // proposed caps (the architect fixes the numbers)
  const PROJECTS = [
    { slug: 'team-console', repo: 'geeera/team-console', public: true },
    { slug: 'storify', repo: 'geeera/storify', public: false },
    { slug: 'sheltrix', repo: 'geeera/sheltrix', public: false, paused: true },
  ];
  const SPRINT = { cur: { name: 'Sprint 02', demo: new Date(2026, 9, 16) }, next: { name: 'Sprint 03', demo: new Date(2026, 9, 30) } };
  const ISSUE_N = 142;
  const SEED = {
    same: { ru: ['Показывать дату последнего прогона на доске', 'Сейчас не видно, когда команда работала в последний раз.'], en: ['Show the last run’s date on the board', 'Right now you can’t see when the team last worked.'], project: 'team-console', sprint: 'next' },
    other: { ru: ['Экспорт истории в PDF', ''], en: ['Export the history to PDF', ''], project: 'storify', sprint: 'backlog' },
  };
  const LONG = { ru: 'Шаги, чтобы повторить: открыть доску, переключить спринт, вернуться назад. ', en: 'Steps to reproduce: open the board, switch the sprint, go back. ' };
  const CMD = { ru: ['Кнопка «Повторить» на доске не реагирует', 'После обрыва сети кнопка серая.\n/approve после проверки'], en: ['Retry on the board does nothing', 'After a network drop the button stays grey.\n/approve once checked'] };

  const G = { from: 'space', projects: 'many', conn: 'connected', net: 'online', sprints: 'ok', reads: 'yes', draft: 'none', send: 'ok', kb: false };
  // ru: the full month ("16 октября"): the short form ends with a period that clashes with the copy's own punctuation
  const dateFmt = () => new Intl.DateTimeFormat(L.lang === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: L.lang === 'ru' ? 'long' : 'short' });
  const projectOf = (slug) => PROJECTS.find((p) => p.slug === slug);
  const projectList = () => (G.projects === 'one' ? PROJECTS.slice(0, 1) : PROJECTS);
  const projectsReady = () => G.projects === 'many' || G.projects === 'one';
  const contextSlug = () => (G.from === 'space' || G.projects === 'one' ? 'team-console' : '');
  const emptyDraft = (slug) => ({ project: slug || '', title: '', text: '', kind: 'feature', sprint: 'next', savedAt: null });
  function seedDraft(which) {
    const s = SEED[which]; if (!s) return null;
    return { ...emptyDraft(s.project), title: s[L.lang][0], text: s[L.lang][1], sprint: s.sprint, savedAt: new Date(Date.now() - 13 * 60000) };
  }
  const hosts = [...document.querySelectorAll('[data-app]')];
  const renderAll = () => hosts.forEach((h) => h.app && h.app.refresh());

  /* ---------- one app instance ---------- */
  function mountApp(host, kind, keep) {
    const fresh = () => ({
      open: false, step: 'form', draft: seedDraft(G.draft), restored: false, err: null, errNew: false, fieldErr: {},
      created: null, confirm: false, attempt: 0, opener: 'nt', dotNew: false, hold: null,
    });
    const S = keep || fresh();
    host.S = S;
    const uid = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const $ = (s) => host.querySelector(s);
    const phone = kind === 'phone';
    const dis = (on) => (on ? ' aria-disabled="true"' : '');
    const mono = (slug) => `<span class="prod-mono" aria-hidden="true">${esc(slug[0])}</span>`;
    const hasDraft = () => !!(S.draft && (S.draft.title.trim() || S.draft.text.trim()));
    const sending = () => S.step === 'sending';

    host.innerHTML = kind === 'mac' ? `<div class="win">
        <div class="win__bar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="win__title">Team Console</span></div>
        <div class="win__body">
          <nav class="sidebar" aria-label="${t('nav.aria')}" data-bg data-slot="side"></nav>
          <div class="p-body" data-bg data-slot="screen"></div>
        </div>
      </div>
      <div data-slot="sheet"></div><div data-slot="modal"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`
      : `<div class="p-status" aria-hidden="true"><span>9:41</span><span class="p-island"></span><span class="p-status__icons">${I.bars}${I.battery}</span></div>
      <div class="p-body" data-bg data-slot="screen"></div>
      <div class="home-ind" aria-hidden="true"></div>
      <div data-slot="sheet"></div><div data-slot="modal"></div><div data-slot="kb"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`;

    /* ================= host screens: the project space and Needs you ================= */
    function ntButton() {
      const label = hasDraft() ? t('task.newDraft') : t('task.new');
      const dot = hasDraft() ? `<span class="draft-dot${S.dotNew ? ' is-new' : ''}" aria-hidden="true"></span>` : '';
      if (phone) return `<button type="button" class="icon-btn nt-plus" data-act="open" data-fk="nt" aria-haspopup="dialog" aria-label="${esc(label)}">${I.plus}${dot}</button>`;
      return `<button type="button" class="btn nt-btn" data-act="open" data-fk="nt" aria-haspopup="dialog" aria-keyshortcuts="T" aria-label="${esc(label)}">${I.plus}<span>${t('task.new')}</span><kbd aria-hidden="true">T</kbd>${dot}</button>`;
    }
    const subLine = () => t('space.sub', { sprint: SPRINT.cur.name, date: dateFmt().format(SPRINT.cur.demo) });
    const chat = () => `<div class="day"><span>${t('chat.today')}</span></div>
      <div class="msg msg--pm"><span class="avatar avatar--pm" aria-hidden="true">PM</span><div class="msg__body"><div class="msg__meta"><b>${t('chat.pm')}</b><span>${hhmm(new Date(Date.now() - 52 * 60000))}</span></div><div class="bubble">${t('chat.m1')}</div></div></div>
      <div class="msg msg--pm"><span class="avatar avatar--pm" aria-hidden="true">PM</span><div class="msg__body"><div class="msg__meta"><b>${t('chat.pm')}</b><span>${hhmm(new Date(Date.now() - 51 * 60000))}</span></div><div class="bubble">${t('chat.m2')}</div></div></div>`;
    const needsList = () => `<ul class="nq-list">
      <li class="nq-card"><small>team-console · ${t('needs.kind1')}</small><b>${t('needs.q1')}</b></li>
      <li class="nq-card"><small>team-console · ${t('needs.kind2')}</small><b>${t('needs.q2')}</b></li></ul>`;
    function sideHTML() {
      const inSpace = G.from === 'space';
      return `<div class="brand">${I.mark}<span>Team Console</span></div>
        <label class="search search--side">${I.search}<span class="sr-only">${t('nav.filter')}</span><input type="search" placeholder="${t('nav.filter')}" autocomplete="off"><kbd>/</kbd></label>
        <ul class="side-list side-list--top">
          <li><button type="button" class="side-item"${inSpace ? ' data-act="elsewhere"' : ' aria-current="true"'}>${I.inbox}<span>${t('nav.needs')}</span><span class="count">2</span></button></li>
          <li><button type="button" class="side-item" data-act="elsewhere">${I.grid}<span>${t('nav.all')}</span></button></li>
        </ul>
        <div class="side-label">${t('nav.projects')}</div>
        <ul class="side-list">${PROJECTS.map((p) => `<li><button type="button" class="side-item"${inSpace && p.slug === 'team-console' ? ' aria-current="true"' : ' data-act="elsewhere"'}>${mono(p.slug)}<span class="side-prod__label">${esc(p.slug)}</span></button></li>`).join('')}</ul>
        <div class="side-foot"><span class="avatar avatar--owner" aria-hidden="true">K</span><span>${t('nav.owner')}</span></div>`;
    }
    function screenHTML() {
      const inSpace = G.from === 'space';
      if (kind === 'mac') {
        if (inSpace) {
          return `<section class="convo" aria-labelledby="${uid}-name">
            <header class="convo__head"><div class="convo__title">${mono('team-console')}<h2 id="${uid}-name">team-console</h2><span class="convo__sub">${subLine()}</span></div>
              <button type="button" class="btn" data-act="elsewhere" aria-keyshortcuts="K">${I.sliders}<span>${t('space.commands')}</span><kbd aria-hidden="true">K</kbd></button>${ntButton()}</header>
            <div class="log"><div class="log__inner">${chat()}</div></div></section>`;
        }
        return `<section class="nq" aria-labelledby="${uid}-nq"><div class="nq-scroll"><div class="nq-inner">
          <header class="nq-head"><div><h1 id="${uid}-nq">${t('nav.needs')}</h1><p>${t('needs.lead')}</p></div>${ntButton()}</header>${needsList()}</div></div></section>`;
      }
      const sw = inSpace
        ? `<button type="button" class="p-switch" data-act="elsewhere" aria-haspopup="dialog" aria-label="${t('nav.switch')}">${mono('team-console')}<span class="p-switch__txt"><b>team-console</b><small>${subLine()}</small></span>${I.down}</button>`
        : `<button type="button" class="p-switch" data-act="elsewhere" aria-haspopup="dialog" aria-label="${t('nav.switch')}"><span class="p-switch__txt"><b>${t('nav.needs')}</b><small>${t('needs.lead')}</small></span>${I.down}</button>`;
      // with New task in the bar, Commands (#114) becomes an icon button on iPhone so the project name stays whole
      const cmd = inSpace ? `<button type="button" class="icon-btn" data-act="elsewhere" aria-haspopup="dialog" aria-label="${t('space.commands')}">${I.sliders}</button>` : '';
      const head = `<header class="p-head">${sw}<span class="p-head__acts">${cmd}${ntButton()}<button type="button" class="icon-btn" data-act="settings" aria-label="${t('nav.settings')}">${I.gear}</button></span></header>`;
      if (inSpace) {
        return `${head}<div class="log p-log"><div class="log__inner">${chat()}</div></div>
          <nav class="tabs" aria-label="${t('nav.sections')}">
            <button type="button" data-act="elsewhere">${I.inbox}<span>${t('nav.needs')}</span><span class="count">2</span></button>
            <button type="button" aria-current="page">${I.chat}<span>${t('nav.chat')}</span></button>
            <button type="button" data-act="elsewhere">${I.board}<span>${t('nav.board')}</span></button>
            <button type="button" data-act="elsewhere">${I.stack}<span>${t('nav.artifacts')}</span></button>
          </nav>`;
      }
      return `${head}<div class="nq-scroll"><div class="nq-inner">${needsList()}</div></div>`;
    }

    /* ================= the New task form ================= */
    function sendBlocked() {
      if (!projectsReady()) return t('task.off.projects');
      if (G.net === 'offline') return t('task.off.offline');
      if (G.conn === 'none') return t('task.off.notConnected');
      return '';
    }
    // The visible reason the Create button points at (aria-describedby): the Mac footer line, or on iPhone the
    // block that already says it (Connect, the projects state) or an offline note at the top of the form.
    function whyId() {
      const why = sendBlocked(); if (!why) return '';
      if (!phone) return `${uid}-why`;
      if (!projectsReady()) return `${uid}-projstate`;
      if (G.net === 'offline') return `${uid}-why`;
      return `${uid}-connh`;
    }
    function sendButton() {
      const p = projectOf(S.draft.project);
      const full = sending() ? t('task.sending') : S.err && S.err.retry ? t('task.retrySend') : p ? t('task.send', { name: p.slug }) : t('task.sendNoProject');
      let label;
      if (sending()) label = `${dots}<span>${phone ? t('task.sendingShort') : t('task.sending')}</span>`;
      else if (S.err && S.err.retry) label = t('task.retrySend');
      else label = phone ? t('task.sendPhone') : esc(full);
      const why = whyId();
      return `<button type="button" class="btn btn--primary${phone ? ' tsheet__send' : ''}${sending() ? ' is-busy' : ''}" data-act="send" data-fk="send" aria-label="${esc(plain(full))}"${dis(!!sendBlocked() || sending())}${why ? ` aria-describedby="${why}"` : ''}>${label}</button>`;
    }
    function errBlock() {
      const e = S.err; if (!e) return '';
      const P = { repo: e.repo || '', name: e.name || '', time: hhmm(new Date(Date.now() + 60000)) };
      if (e.code === 'invalid') return `<section class="terr${S.errNew ? ' is-new' : ''}" role="alert" tabindex="-1" data-fk="err"><h3>${I.warn}<span>${t('task.err.invalid')}</span></h3></section>`;
      let act = '';
      if (e.code === 'not-connected') act = `<button type="button" class="btn" data-act="connect" data-fk="err-act">${t('task.conn.action')}</button>`;
      if (e.code === 'owner-mismatch') act = `<button type="button" class="btn" data-act="settings" data-fk="err-act">${t('err.toSettings')}</button>`;
      if (e.code === 'app-not-installed') act = `<button type="button" class="btn" data-act="settings" data-fk="err-act">${t('err.toProjectSettings')}</button>`;
      if (e.code === 'timeout') act = `<a class="ext" href="https://github.com/${esc(e.repo)}/issues" target="_blank" rel="noopener noreferrer" data-act="ext" data-fk="err-act">${t('err.timeout.link', P)}<span class="sr-only"> ${t('task.external')}</span>${I.ext}</a>`;
      return `<section class="terr${S.errNew ? ' is-new' : ''}" role="alert" tabindex="-1" data-fk="err"><h3>${I.warn}<span>${t(`err.${e.code}.t`, P)}</span></h3><p>${t(`err.${e.code}.h`, P)}</p>${act}</section>`;
    }
    function connBlock() {
      if (G.conn !== 'none' || !projectsReady() || (S.err && S.err.code === 'not-connected')) return '';
      return `<section class="tconn" aria-labelledby="${uid}-connt"><h3 id="${uid}-connt">${t('task.conn.title')}</h3><p id="${uid}-connh">${t('task.conn.hint')}</p>
        <button type="button" class="btn btn--primary" data-act="connect" data-fk="conn"${dis(G.net === 'offline')}>${t('task.conn.action')}</button></section>`;
    }
    function draftNote() {
      if (!S.restored || !S.draft || !S.draft.savedAt) return '';
      const d = S.draft; const p = projectOf(d.project);
      const other = G.from === 'space' && p && p.slug !== 'team-console' ? `<b>${t('task.draft.other', { name: p.slug })}</b> ` : '';
      return `<div class="tdraft" id="${uid}-draft"><p>${other}${t('task.draft.restored', { time: hhmm(d.savedAt) })}</p>
        <button type="button" class="link-btn" data-act="clear" data-fk="clear"${dis(sending())}>${t('task.draft.clear')}</button></div>`;
    }
    function projectField() {
      const d = S.draft;
      if (G.projects === 'loading') return `<div class="fld" aria-busy="true"><span class="fld__label">${t('task.project.label')}</span><p class="fld__hint" id="${uid}-projstate"><span class="tskel" aria-hidden="true"></span> ${t('task.project.loading')}</p></div>`;
      if (G.projects === 'error') return `<div class="fld"><span class="fld__label">${t('task.project.label')}</span><div class="tstate tstate--error" role="alert"><p id="${uid}-projstate">${t('task.project.error')}</p><button type="button" class="btn" data-act="proj-retry" data-fk="proj-retry">${t('task.retry')}</button></div></div>`;
      if (G.projects === 'none') return `<div class="fld"><span class="fld__label">${t('task.project.label')}</span><div class="tstate"><p id="${uid}-projstate">${t('task.project.none')}</p><button type="button" class="btn" data-act="elsewhere" data-fk="to-all">${t('task.project.toAll')}</button></div></div>`;
      const p = projectOf(d.project);
      const err = S.fieldErr.project;
      const notes = [];
      if (p && p.public) notes.push([`${uid}-pub`, `<p class="tnote" id="${uid}-pub">${J.eye}<span>${t('task.project.public', { repo: p.repo })}</span></p>`]);
      if (p && p.paused) notes.push([`${uid}-paused`, `<p class="tnote" id="${uid}-paused">${I.pause}<span>${t('task.project.paused', { name: p.slug })}</span></p>`]);
      const desc = [err ? `${uid}-perr` : '', ...notes.map((n) => n[0])].filter(Boolean).join(' ');
      return `<div class="fld"><label class="fld__label" for="${uid}-proj">${t('task.project.label')}</label>
        ${err ? `<p class="fld__err" id="${uid}-perr">${I.warn}<span>${t('task.project.required')}</span></p>` : ''}
        <div class="fld-proj">${p ? mono(p.slug) : ''}<select class="fld-select${p ? '' : ' is-empty'}" id="${uid}-proj" data-f="project" data-fk="f-proj" aria-required="true"${desc ? ` aria-describedby="${desc}"` : ''}${err ? ' aria-invalid="true"' : ''}${sending() ? ' disabled' : ''}>
          <option value=""${p ? '' : ' selected'} disabled>${t('task.project.choose')}</option>
          ${projectList().map((x) => `<option value="${esc(x.slug)}"${x.slug === d.project ? ' selected' : ''}>${esc(x.slug)}</option>`).join('')}
        </select>${I.down}</div>${notes.map((n) => n[1]).join('')}</div>`;
    }
    const counter = (id, n, max) => `<span class="fld__count" id="${id}"${n >= max * 0.8 ? '' : ' hidden'}>${t('task.counter', { n, max })}</span>`;
    const overBy = (n, max) => (n > max ? t('task.tooLong', { max, n: n - max }) : '');
    function titleField() {
      const d = S.draft; const ro = sending() ? ' readonly aria-readonly="true"' : '';
      const err = S.fieldErr.title || overBy(d.title.length, TITLE_MAX);
      return `<div class="fld"><div class="fld__row"><label class="fld__label" for="${uid}-title">${t('task.name.label')}</label>${counter(`${uid}-tc`, d.title.length, TITLE_MAX)}</div>
        <p class="fld__err" id="${uid}-terr" data-err="title"${err ? '' : ' hidden'}>${I.warn}<span>${err || ''}</span></p>
        <input class="fld-input fld-input--title" id="${uid}-title" data-f="title" data-fk="f-title" type="text" enterkeyhint="next" autocomplete="off" autocapitalize="sentences" value="${esc(d.title)}" aria-required="true" aria-describedby="${uid}-terr ${uid}-th ${uid}-tc"${err ? ' aria-invalid="true"' : ''}${ro}>
        <p class="fld__hint" id="${uid}-th">${t('task.name.hint')}</p></div>`;
    }
    const hasCommand = (s) => /^[ \t]*\//m.test(s);
    function textField() {
      const d = S.draft; const ro = sending() ? ' readonly aria-readonly="true"' : '';
      const err = overBy(d.text.length, TEXT_MAX);
      return `<div class="fld"><div class="fld__row"><label class="fld__label" for="${uid}-text">${t('task.text.label')} <small>${t('task.text.optional')}</small></label>${counter(`${uid}-xc`, d.text.length, TEXT_MAX)}</div>
        <p class="fld__err" id="${uid}-xerr" data-err="text" aria-live="polite"${err ? '' : ' hidden'}>${I.warn}<span>${err}</span></p>
        <textarea class="fld-input" id="${uid}-text" data-f="text" data-fk="f-text" rows="4" aria-describedby="${uid}-xerr ${uid}-xh ${uid}-xc ${uid}-cmd"${err ? ' aria-invalid="true"' : ''}${ro}>${esc(d.text)}</textarea>
        <p class="fld__hint" id="${uid}-xh">${t('task.text.hint')}</p>
        <p class="tnote tnote--cmd" id="${uid}-cmd" data-cmd${hasCommand(d.text) ? '' : ' hidden'}><span>${t('task.text.commandNote')}</span></p></div>`;
    }
    function kindField() {
      const d = S.draft;
      return `<fieldset class="fld" aria-describedby="${uid}-kh"><legend class="fld__label">${t('task.kind.legend')}</legend>
        <div class="tseg">${['feature', 'bug', 'chore'].map((k) => `<label><input type="radio" name="${uid}-kind" value="${k}" data-f="kind" data-fk="kind-${k}"${d.kind === k ? ' checked' : ''}${sending() ? ' disabled' : ''}>${KIND_ICON[k]}<span>${t(`task.kind.${k}`)}</span></label>`).join('')}</div>
        <p class="fld__hint" id="${uid}-kh" aria-live="polite" data-kh>${t(`task.kind.${d.kind}Hint`)}</p></fieldset>`;
    }
    function sprintOptions() {
      const f = dateFmt(); const generic = G.sprints === 'error'; const loading = G.sprints === 'loading';
      let curOff = '';
      if (G.sprints === 'nocur') curOff = t('task.sprint.noCurrent');
      if (G.sprints === 'freeze') curOff = t('task.sprint.freeze', { date: f.format(SPRINT.cur.demo) });
      let curHint = generic ? t('task.sprint.genericCurrent') : t('task.sprint.currentHint', { sprint: SPRINT.cur.name, date: f.format(SPRINT.cur.demo) });
      let nextHint = generic ? t('task.sprint.genericNext') : t('task.sprint.nextHint', { sprint: SPRINT.next.name, date: f.format(SPRINT.next.demo) });
      if (G.sprints === 'nonext' || G.sprints === 'nocur') nextHint = t('task.sprint.nextNone');
      if (G.sprints === 'nocur') curHint = '';
      return [
        { v: 'current', hint: curOff || curHint, off: !!curOff, chip: G.sprints === 'freeze' },
        { v: 'next', hint: nextHint },
        { v: 'backlog', hint: t('task.sprint.backlogHint') },
      ].map((o) => ({ ...o, hint: loading && o.v !== 'backlog' ? '' : o.hint }));
    }
    function sprintField() {
      const d = S.draft; const p = projectOf(d.project);
      const loading = G.sprints === 'loading';
      const notes = [];
      if (G.reads === 'no' && p) notes.push([`${uid}-unsup`, `<p class="tnote tnote--warn" id="${uid}-unsup">${I.clock}<span>${t('task.sprint.unsupported', { name: p.slug })}</span></p>`]);
      if (G.sprints === 'error') notes.push([`${uid}-sperr`, `<p class="tnote" id="${uid}-sperr">${I.refresh}<span>${t('task.sprint.error')}</span></p>`]);
      if (loading) notes.push([`${uid}-spl`, `<p class="fld__hint" id="${uid}-spl">${t('task.sprint.loading')}</p>`]);
      const desc = notes.map((n) => n[0]).join(' ');
      const opts = sprintOptions().map((o) => `<label class="topt${o.off ? ' topt--off' : ''}">
          <input type="radio" name="${uid}-sprint" value="${o.v}" data-f="sprint" data-fk="sprint-${o.v}"${d.sprint === o.v && !o.off ? ' checked' : ''}${o.off ? ` aria-disabled="true" data-off="${esc(o.hint)}"` : ''}${o.hint ? ` aria-describedby="${uid}-sp-${o.v}"` : ''}${sending() ? ' disabled' : ''}>
          <span class="topt__t">${t(`task.sprint.${o.v}`)}${o.chip ? `<span class="topt__chip">${J.snow}${t('task.sprint.freezeChip')}</span>` : ''}</span>
          ${o.hint ? `<span class="topt__h" id="${uid}-sp-${o.v}">${o.hint}</span>` : loading && o.v !== 'backlog' ? '<span class="topt__h"><span class="tskel" aria-hidden="true"></span></span>' : ''}</label>`).join('');
      return `<fieldset class="fld"${loading ? ' aria-busy="true"' : ''}${desc ? ` aria-describedby="${desc}"` : ''}><legend class="fld__label">${t('task.sprint.legend')}</legend>
        ${notes.map((n) => n[1]).join('')}<div class="topts">${opts}</div></fieldset>`;
    }
    function formParts() {
      const p = projectOf(S.draft.project);
      const head = phone
        ? `<div class="sheet__grab" aria-hidden="true"></div>
           <button type="button" class="btn btn--quiet tsheet__close" data-act="close" data-fk="close"${dis(sending())}>${t('task.close')}</button>
           <div class="tsheet__titles"><h2 class="tsheet__title" id="${uid}-h" tabindex="-1" data-fk="title-h">${t('task.title')}</h2>${p ? `<span class="tsheet__into">${t('task.into', { name: p.slug })}</span>` : ''}</div>${sendButton()}`
        : `<div class="tsheet__titles"><h2 class="tsheet__title" id="${uid}-h" tabindex="-1" data-fk="title-h">${t('task.title')}</h2></div>
           <button type="button" class="icon-btn" data-act="close" data-fk="x" aria-label="${t('task.close')}"${dis(sending())}>${I.x}</button>`;
      const offNote = phone && G.net === 'offline' ? `<p class="tnote" id="${uid}-why">${I.wifi}<span>${t('task.off.offline')}</span></p>` : '';
      const body = `${errBlock()}${connBlock()}${offNote}${draftNote()}<div class="tform"${sending() ? ' aria-busy="true"' : ''}>${projectField()}${titleField()}${textField()}${kindField()}${sprintField()}</div>
        <p class="fld__hint">${t('task.draft.hint')}</p>`;
      const why = sendBlocked();
      const foot = phone ? '' : `<div class="tsheet__foot">${why
        ? `<p class="foot-why" id="${uid}-why">${G.net === 'offline' ? I.wifi : I.lock}<span>${why}</span></p>`
        : `<p class="foot-hint"><span>${t('task.shortcut')} <kbd>⌘</kbd> <kbd>↩</kbd></span></p>`}
        <button type="button" class="btn" data-act="close" data-fk="close"${dis(sending())}>${t('task.close')}</button>${sendButton()}</div>`;
      return { head, body, foot, label: `${uid}-h` };
    }

    /* ----- the receipt: the task filed as an index card, then the stamp ----- */
    const stampSVG = '<div class="stamp" aria-hidden="true"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="28"/><circle class="stamp__inner" cx="32" cy="32" r="23"/><path d="M21 33l8 8 15-17"/></svg></div>';
    function doneParts() {
      const c = S.created; const p = projectOf(c.project);
      const req = G.reads === 'no' ? t('task.done.unsup') : t(`task.done.${c.sprint}`);
      const neutral = G.reads === 'no' || c.sprint === 'backlog';
      const open = `<a class="ext" href="https://github.com/${esc(p.repo)}/issues/${c.n}" target="_blank" rel="noopener noreferrer" data-act="ext" data-fk="open-gh">${t('task.done.open', { n: c.n })}<span class="sr-only"> ${t('task.external')}</span>${I.ext}</a>`;
      const head = phone
        ? `<div class="sheet__grab" aria-hidden="true"></div><span></span><div class="tsheet__titles"><span class="tsheet__title" aria-hidden="true">${t('task.title')}</span></div><span></span>`
        : `<div class="tsheet__titles"><span class="tsheet__title" aria-hidden="true">${t('task.title')}</span></div>
           <button type="button" class="icon-btn" data-act="done" data-fk="x" aria-label="${t('task.close')}">${I.x}</button>`;
      const body = `<div class="tdone">
          <div class="tcard" data-card><span class="tcard__top"><span class="tcard__kind tcard__kind--${c.kind}">${KIND_ICON[c.kind]}${t(`task.kind.${c.kind}`)}</span><span class="tcard__num">#${c.n}</span></span>
            <p class="tcard__title">${esc(c.title)}</p><span class="tcard__repo">${esc(p.repo)}</span>${stampSVG}</div>
          <p class="tdone__kicker" aria-hidden="true">${t('task.done.stamp')}</p>
          <h2 class="tdone__h" id="${uid}-dh" tabindex="-1" data-fk="done-h">${t('task.done.title', { n: c.n })}</h2>
          <p class="tdone__meta">${t('task.done.meta', { name: p.slug, time: hhmm(c.at) })}</p>
          <p class="tdone__req${neutral ? ' tdone__req--neutral' : ''}">${req}</p>
          ${open}
          ${phone ? `<div class="tphone-acts"><button type="button" class="btn" data-act="another" data-fk="another">${t('task.done.another')}</button><button type="button" class="btn btn--primary" data-act="done" data-fk="done">${t('task.done.close')}</button></div>` : ''}
        </div>`;
      const foot = phone ? '' : `<div class="tsheet__foot tsheet__foot--done"><button type="button" class="btn" data-act="another" data-fk="another">${t('task.done.another')}</button><button type="button" class="btn btn--primary" data-act="done" data-fk="done">${t('task.done.close')}</button></div>`;
      return { head, body, foot, label: `${uid}-dh` };
    }

    function sheetHTML() {
      const parts = S.step === 'done' ? doneParts() : formParts();
      const kb = phone && G.kb && S.step !== 'done';
      return `<div class="tsheet ${phone ? 'tsheet--phone' : 'tsheet--dialog'}${kb ? ' has-kb' : ''}"><div class="tsheet__scrim" data-act="scrim"></div>
        <section class="tsheet__panel" role="dialog" aria-modal="true" aria-labelledby="${parts.label}">
          <div class="tsheet__head">${parts.head}</div>
          <div class="tsheet__body" data-sbody tabindex="-1">${parts.body}</div>${parts.foot}
        </section></div>`;
    }
    function drawSheet(focus) {
      const slot = $('[data-slot=sheet]');
      const kb = $('[data-slot=kb]');
      if (!S.open) { slot.innerHTML = ''; if (kb) kb.innerHTML = ''; return; }
      const act = slot.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
      const top = slot.querySelector('[data-sbody]')?.scrollTop || 0;
      slot.innerHTML = sheetHTML();
      if (kb) kb.innerHTML = G.kb && S.step !== 'done' ? `<div class="kb-mock" aria-hidden="true"><div class="kb-mock__bar"><span>«${L.lang === 'ru' ? 'задача' : 'task'}»</span><span>${L.lang === 'ru' ? 'задачи' : 'tasks'}</span><span>${L.lang === 'ru' ? 'задачу' : 'tasking'}</span></div>${[10, 9, 9, 3].map((n, i) => `<div class="kb-mock__row${i >= 2 ? ' kb-mock__row--wide' : ''}">${'<i></i>'.repeat(n)}</div>`).join('')}</div>` : '';
      const body = slot.querySelector('[data-sbody]'); body.scrollTop = top;
      S.errNew = false;
      const f = focus || act;
      const el = f && slot.querySelector(`[data-fk="${f}"]`);
      if (el) {
        el.focus({ preventScroll: !focus });
        if (focus && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      }
      if (focus === 'err' || focus === 'title-h') body.scrollTop = 0;
    }
    function inertBg(on) { host.querySelectorAll('[data-bg]').forEach((el) => { el.inert = on; }); }

    function openForm(opener) {
      if (S.open) return;
      S.opener = opener || 'nt';
      if (!S.draft) S.draft = emptyDraft(contextSlug());
      else if (!S.draft.project && contextSlug()) S.draft.project = contextSlug();
      S.restored = hasDraft();
      S.open = true; S.step = 'form'; S.err = null; S.fieldErr = {};
      inertBg(true);
      drawSheet(projectsReady() ? 'f-title' : 'title-h');
      const panel = $('.tsheet__panel'); const scrim = $('.tsheet__scrim');
      if (isReduced()) { play(panel, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') }); return; }
      play(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-base'), easing: cssVar('--ease-standard') });
      play(panel, phone ? [{ transform: 'translateY(100%)' }, { transform: 'none' }] : [{ opacity: 0, transform: 'translateY(8px) scale(.99)' }, { opacity: 1, transform: 'none' }], { duration: ms(phone ? '--dur-slow' : '--dur-base'), easing: cssVar('--ease-enter') });
    }
    async function closeForm() {
      if (!S.open || sending()) return;
      const done = S.step === 'done';
      const kept = !done && hasDraft();
      if (done) S.draft = null;
      const panel = $('.tsheet__panel'); const scrim = $('.tsheet__scrim');
      if (panel && !isReduced()) {
        play(scrim, [{ opacity: 1 }, { opacity: 0 }], { duration: ms('--dur-fast'), easing: cssVar('--ease-exit'), fill: 'forwards' });
        await play(panel, phone ? [{ transform: 'none' }, { transform: 'translateY(100%)' }] : [{ opacity: 1 }, { opacity: 0, transform: 'translateY(6px)' }], { duration: ms(phone ? '--dur-base' : '--dur-fast'), easing: cssVar('--ease-exit'), fill: 'forwards' });
      }
      S.open = false; S.step = 'form'; S.err = null; S.fieldErr = {}; S.confirm = false; S.created = null; S.attempt = 0;
      drawModal(); drawSheet(); inertBg(false);
      S.dotNew = kept;
      render({ focus: S.opener });
      S.dotNew = false;
      if (kept) { toast(t('task.closedKept')); announce(t('task.closedKept')); }
    }

    /* ----- validation and sending ----- */
    function validate() {
      const e = {}; const d = S.draft;
      if (!d.project) e.project = true;
      if (!d.title.trim()) e.title = t('task.name.required');
      else if (d.title.length > TITLE_MAX) e.title = overBy(d.title.length, TITLE_MAX);
      if (d.text.length > TEXT_MAX) e.text = true;
      return e;
    }
    const RETRY = ['rate', 'network', 'timeout', 'app-not-installed', 'issues-disabled'];
    async function submit() {
      if (sending() || S.step === 'done') return;
      const why = sendBlocked();
      if (why) { announce(why); return; }
      S.fieldErr = validate();
      if (Object.keys(S.fieldErr).length) {
        S.err = null; drawSheet(S.fieldErr.project ? 'f-proj' : S.fieldErr.title ? 'f-title' : 'f-text'); return;
      }
      S.step = 'sending'; S.attempt += 1;
      drawSheet('send'); announce(t('task.sending'));
      const hold = S.hold; S.hold = null;
      await wait(hold || (G.send === 'timeout' && S.attempt === 1 ? 2200 : 1100));
      if (host.S !== S || !S.open || S.step !== 'sending') return; // the demo was reset or remounted meanwhile
      if (S.attempt === 1 && G.send !== 'ok') { fail(G.send); return; }
      succeed();
    }
    function fail(code) {
      S.step = 'form'; S.errNew = true;
      const was = projectOf(S.draft.project);
      if (code === 'invalid') {
        S.err = { code };
        S.fieldErr = { title: t('task.tooLong', { max: TITLE_MAX, n: 3 }) };
        drawSheet('f-title'); return;
      }
      S.err = { code, retry: RETRY.includes(code), name: was ? was.slug : '', repo: was ? was.repo : '' };
      if (code === 'project-gone') S.draft.project = '';
      drawSheet(code === 'not-connected' ? 'err-act' : code === 'project-gone' ? 'f-proj' : S.err.retry ? 'send' : 'err');
    }
    function succeed() {
      const d = S.draft;
      // a retry within the replay window answers with the same issue: always #142 here
      S.created = { n: ISSUE_N, project: d.project, title: d.title.trim(), kind: d.kind, sprint: d.sprint, at: new Date() };
      S.step = 'done'; S.err = null; S.draft = null;
      drawSheet('done-h');
      file();
      announce(plain(t('task.done.announce', { n: ISSUE_N, name: S.created.project })));
    }
    // Signature moment: the task is filed as an index card and the ink stamp presses onto it.
    async function file() {
      const card = $('[data-card]'); if (!card) return;
      const s = card.querySelector('.stamp');
      if (isReduced()) { play(card, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') }); return; }
      s.style.opacity = '0';
      await play(card, [{ opacity: 0, transform: 'translateY(18px) rotate(0deg) scale(.97)' }, { opacity: 1, transform: `rotate(${cssVar('--card-tilt')})` }], { duration: ms('--dur-slow'), easing: cssVar('--ease-emph') });
      s.style.opacity = '';
      stamp(s);
    }
    function stamp(s) {
      if (!s) return;
      const strokes = [...s.querySelectorAll('circle,path')];
      strokes.forEach((p) => { const l = p.getTotalLength(); p.style.strokeDasharray = l; p.style.strokeDashoffset = l; });
      play(s, [{ opacity: 0, transform: 'rotate(-20deg) scale(1.4)' }, { opacity: 1, transform: 'rotate(-9deg) scale(1)' }], { duration: ms('--dur-base'), easing: cssVar('--ease-emph') });
      strokes.forEach((p, i) => play(p, [{ strokeDashoffset: p.style.strokeDashoffset }, { strokeDashoffset: 0 }], { duration: ms('--dur-sig') * 0.6, delay: i * ms('--stagger'), easing: cssVar('--ease-emph'), fill: 'forwards' }));
    }

    /* ----- Clear the draft? (the kit's Sheet.confirm, an alertdialog) ----- */
    function drawModal(focus) {
      const slot = $('[data-slot=modal]');
      const panel = $('.tsheet__panel');
      if (panel) panel.inert = S.confirm;
      if (!S.confirm) { slot.innerHTML = ''; return; }
      slot.innerHTML = `<div class="modal"><div class="modal__scrim" data-act="clear-no"></div>
        <section class="adialog" role="alertdialog" aria-modal="true" aria-labelledby="${uid}-ch" aria-describedby="${uid}-cm">
          <h2 id="${uid}-ch" tabindex="-1" data-fk="clear-h">${t('task.clear.title')}</h2><p id="${uid}-cm">${t('task.clear.message')}</p>
          <div class="adialog__actions"><button type="button" class="btn" data-act="clear-no" data-fk="clear-no">${t('task.clear.cancel')}</button><button type="button" class="btn btn--danger" data-act="clear-yes" data-fk="clear-yes">${t('task.clear.ok')}</button></div>
        </section></div>`;
      const el = slot.querySelector(`[data-fk="${focus || 'clear-h'}"]`); if (el) el.focus();
      const box = slot.querySelector('.adialog');
      play(box, isReduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: phone ? 'translateY(40px)' : 'scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: ms(isReduced() ? '--dur-fade' : '--dur-base'), easing: cssVar('--ease-enter') });
    }

    /* ----- live text while typing: counters, the over-cap error, the command note, the kind hint ----- */
    function syncLive(f) {
      const d = S.draft; d.savedAt = new Date();
      if (f === 'title' || f === 'text') {
        const max = f === 'title' ? TITLE_MAX : TEXT_MAX; const n = d[f].length;
        const c = $(`#${uid}-${f === 'title' ? 'tc' : 'xc'}`); if (c) { c.hidden = n < max * 0.8; c.textContent = plain(t('task.counter', { n, max })); }
        const over = overBy(n, max);
        const e = $(`[data-err="${f}"]`);
        const input = $(`[data-f="${f}"]`);
        if (f === 'title' && S.fieldErr.title && d.title.trim() && !over) S.fieldErr.title = null;
        const msg = over || (f === 'title' ? S.fieldErr.title : '');
        if (e) { e.hidden = !msg; e.querySelector('span').textContent = msg ? plain(msg) : ''; }
        if (input) { if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
      }
      if (f === 'text') {
        const n = $('[data-cmd]'); const show = hasCommand(d.text);
        if (n && n.hidden === show) { n.hidden = !show; if (show) { n.classList.remove('is-new'); void n.offsetWidth; n.classList.add('is-new'); } }
      }
      if (f === 'kind') { const h = $('[data-kh]'); if (h) h.textContent = plain(t(`task.kind.${d.kind}Hint`)); }
    }

    /* ----- render, keeping focus by data-fk ----- */
    function render(opts = {}) {
      const active = host.contains(document.activeElement) && !$('[data-slot=sheet]').contains(document.activeElement) ? document.activeElement.dataset.fk : null;
      if (kind === 'mac') $('[data-slot=side]').innerHTML = sideHTML();
      $('[data-slot=screen]').innerHTML = screenHTML();
      host.classList.toggle('is-space', G.from === 'space');
      const f = opts.focus || active;
      const el = f && host.querySelector(`[data-slot=screen] [data-fk="${CSS.escape(f)}"]`);
      if (el && !S.open) el.focus({ preventScroll: true });
    }
    const announce = (txt) => { const l = $('[data-slot=live]'); l.textContent = ''; setTimeout(() => { l.textContent = plain(txt); }, 30); };
    let toastTimer;
    function toast(txt) {
      const el = $('[data-slot=toast]'); el.textContent = plain(txt); el.hidden = false;
      play(el, isReduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: ms(isReduced() ? '--dur-fade' : '--dur-base'), easing: cssVar('--ease-enter') });
      clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms('--dur-toast'));
    }

    /* ----- events ----- */
    host.onclick = (e) => {
      const el = e.target.closest('[data-act]'); if (!el || !host.contains(el)) return;
      const act = el.dataset.act;
      if (el.tagName === 'A') e.preventDefault();
      if (el.getAttribute('aria-disabled') === 'true') {
        if (act === 'send' && !sending()) announce(sendBlocked());
        return;
      }
      switch (act) {
        case 'open': openForm(el.dataset.fk); break;
        case 'close': case 'done': closeForm(); break;
        case 'scrim': if (!sending()) closeForm(); break;
        case 'send': submit(); break;
        case 'another': { const keep = S.created.project; S.draft = emptyDraft(keep); S.restored = false; S.step = 'form'; S.created = null; S.attempt = 0; drawSheet('f-title'); break; }
        case 'clear': S.confirm = true; drawModal(); break;
        case 'clear-no': S.confirm = false; drawModal(); drawSheet('f-title'); break;
        case 'clear-yes': S.confirm = false; S.draft = emptyDraft(contextSlug()); S.restored = false; S.err = null; S.fieldErr = {}; drawModal(); drawSheet('f-title'); announce(t('task.clear.done')); toast(t('task.clear.done')); break;
        case 'connect': G.conn = 'connected'; syncDemo(); if (S.err && S.err.code === 'not-connected') { S.err = null; S.attempt = 0; } toast(t('demo.connect')); renderAll(); if (S.open) drawSheet('send'); break;
        case 'proj-retry': G.projects = 'loading'; syncDemo(); renderAll(); wait(800).then(() => { G.projects = 'many'; syncDemo(); renderAll(); if (S.open) drawSheet('f-proj'); }); break;
        case 'settings': toast(t('demo.settings')); break;
        case 'ext': toast(t('demo.github')); break;
        case 'elsewhere': toast(t('demo.elsewhere')); break;
        default: break;
      }
    };
    host.oninput = (e) => {
      const f = e.target.dataset && e.target.dataset.f; if (!f || !S.draft) return;
      if (f === 'sprint' && e.target.dataset.off !== undefined) {
        e.target.checked = false;
        const cur = $(`input[data-f=sprint][value="${S.draft.sprint}"]`); if (cur) cur.checked = true;
        announce(e.target.dataset.off); return;
      }
      S.draft[f] = e.target.value;
      if (f === 'project') { S.fieldErr.project = false; if (S.err && S.err.code === 'project-gone') S.err = null; S.draft.savedAt = new Date(); drawSheet('f-proj'); return; }
      syncLive(f);
    };
    host.onkeydown = (e) => {
      if (S.confirm) {
        if (e.key === 'Escape') { e.preventDefault(); S.confirm = false; drawModal(); drawSheet('f-title'); return; }
        if (e.key === 'Tab') trap(e, '.adialog');
        return;
      }
      if (!S.open) return;
      if (e.key === 'Escape') { e.preventDefault(); closeForm(); return; }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); return; }
      if (e.key === 'Enter' && e.target.dataset.f === 'title') { e.preventDefault(); const x = $('[data-f=text]'); if (x) x.focus(); return; }
      if (e.key === 'Tab') trap(e, '.tsheet__panel');
    };
    function trap(e, sel) {
      const box = $(sel); if (!box) return;
      const f = [...box.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')].filter((x) => !x.disabled && x.offsetParent !== null && !(x.type === 'radio' && !x.checked && box.querySelector(`input[name="${x.name}"]:checked`)));
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }

    /* ----- demo entry points ----- */
    function silentClose() { S.open = false; S.confirm = false; S.step = 'form'; S.err = null; S.fieldErr = {}; S.created = null; S.attempt = 0; drawModal(); drawSheet(); inertBg(false); }
    const app = {
      S,
      refresh: () => { render(); if (S.open) drawSheet(); },
      reseed: () => { silentClose(); S.draft = seedDraft(G.draft); render(); },
      openT: () => { if (!S.open) { const a = document.activeElement; const fk = host.contains(a) && a.dataset.fk ? a.dataset.fk : 'nt'; openForm(fk); } },
      go: (screen) => {
        silentClose();
        const ctx = contextSlug() || 'team-console';
        const seeded = () => ({ ...emptyDraft(ctx), title: SEED.same[L.lang][0], text: SEED.same[L.lang][1], savedAt: new Date(Date.now() - 13 * 60000) });
        if (screen === 'fresh') S.draft = null;
        if (screen === 'draftOther') S.draft = seedDraft('other');
        if (['invalid', 'sending', 'error', 'done', 'clear'].includes(screen)) S.draft = screen === 'invalid' ? emptyDraft(ctx) : seeded();
        if (screen === 'long') { S.draft = seeded(); let s = ''; while (s.length < TEXT_MAX + 40) s += LONG[L.lang]; S.draft.text = s.slice(0, TEXT_MAX + 37); }
        if (screen === 'command') S.draft = { ...emptyDraft(ctx), title: CMD[L.lang][0], text: CMD[L.lang][1], kind: 'bug', savedAt: new Date() };
        render();
        openForm('nt');
        if (screen === 'invalid') submit();
        if (screen === 'sending') { S.hold = 4000; submit(); }
        if (screen === 'error') { S.attempt = 1; fail('timeout'); }
        if (screen === 'done') succeed();
        if (screen === 'clear') { S.confirm = true; drawModal(); }
      },
    };
    host.app = app;
    render();
    if (S.open) { inertBg(true); drawSheet(); if (S.confirm) drawModal(); }
    return app;
  }

  /* ---------- page controls ---------- */
  const mountAll = (keep) => hosts.forEach((h) => { const prev = keep && h.S ? h.S : null; h.className = 'app'; mountApp(h, h.dataset.app, prev); });
  const pageChrome = Proto.page({ L, title: 'Team Console · #107', onLang: () => mountAll(true) });
  const sel = (id) => document.getElementById(id);
  const CTRL = { 'd-from': 'from', 'd-projects': 'projects', 'd-conn': 'conn', 'd-net': 'net', 'd-sprints': 'sprints', 'd-reads': 'reads', 'd-draft': 'draft', 'd-send': 'send' };
  function syncDemo() { Object.entries(CTRL).forEach(([id, k]) => { sel(id).value = G[k]; }); sel('d-kb').checked = G.kb; }
  Object.entries(CTRL).forEach(([id, k]) => sel(id).addEventListener('change', (e) => {
    G[k] = e.target.value;
    if (k === 'from') { mountAll(false); return; }
    if (k === 'draft') { hosts.forEach((h) => h.app.reseed()); return; }
    if (k === 'send') hosts.forEach((h) => { h.S.attempt = 0; });
    renderAll();
  }));
  sel('d-kb').addEventListener('change', (e) => { G.kb = e.target.checked; renderAll(); });
  sel('d-screen').addEventListener('change', (e) => { const v = e.target.value; if (!v) return; hosts.forEach((h) => h.app.go(v)); e.target.value = ''; });
  document.querySelector('[data-reset]').addEventListener('click', () => { Object.assign(G, { from: 'space', projects: 'many', conn: 'connected', net: 'online', sprints: 'ok', reads: 'yes', draft: 'none', send: 'ok', kb: false }); syncDemo(); mountAll(false); });
  // T opens New task on the Mac from anywhere outside a text field (a physical key: works with the Russian layout too)
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyT' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.target.closest && (e.target.closest('input, textarea, select, [contenteditable]') || e.target.closest('.note'))) return;
    const stage = document.querySelector('.stage');
    if (stage.dataset.view === 'phone') return;
    const mac = hosts.find((h) => h.dataset.app === 'mac');
    if (!mac || mac.S.open) return;
    e.preventDefault(); mac.app.openT();
  });
  mountAll(false);
  syncDemo();
  pageChrome.fit();
  window.__demo = { G, hosts, syncDemo, mountAll };
})();
