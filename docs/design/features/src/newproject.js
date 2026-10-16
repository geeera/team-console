/* #238 New project: from an idea to a working team. Design prototype runtime with mock data only; the real app
   keeps a small draft row in the Worker (`new_project_drafts`), creates the repository on the owner connection (or
   hands over a prefilled github.com/new link), runs the interview in the new project's PM chat (#17/#26) and
   reads kickoff progress from the `team:kickoff` stage comments (architect note on #238, 2026-10-15).
   Order after that note: 1 Idea → 2 Repository → 3 Interview (+ brief) → 4 Kickoff → 5 Environments → 6 Start.
   Two independent instances (iPhone, Mac) share the demo bar; the buttons inside a frame walk the flow there. */
(() => {
  'use strict';
  const { isReduced, cssVar, ms, wait, esc, play, plain, I, dots } = Proto;
  const L = Proto.i18n(I18N);
  const { t, hhmm } = L;

  /* ---------- mock data ---------- */
  const LOGIN = 'geeera';
  const NAME = 'chess-coach';
  const TEMPLATE = `${LOGIN}/product-team-template`;
  const SPRINT = 'Sprint 01';
  const at = (h, m) => new Date(2026, 9, 16, h, m);
  const DEMO1 = new Date(2026, 9, 30); const DEMO2 = new Date(2026, 10, 6);
  const GH = (path) => `https://github.com/${path}`;
  const TEAM_APP_URL = GH('apps/product-team-agents/installations/new');
  const REVIEW_APP_URL = GH('apps/product-team-review/installations/new');
  const CONSOLE_INSTALL_URL = GH('apps/team-console-dev/installations/new');
  const RUN_LOG_URL = GH(`${LOGIN}/${NAME}/issues/1`);
  const TAKEN = ['team-console', 'sheltrix', 'atlas-cli', 'dotfiles'];
  const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
  const STEPS = ['idea', 'repo', 'interview', 'kickoff', 'env', 'start'];
  const TOPICS = ['goal', 'users', 'mvp', 'out', 'stack', 'demo', 'refs'];
  const KICK = ['access', 'config', 'sprint', 'backlog', 'adr', 'design', 'checklist'];
  const REPO_ROWS = ['repo', 'consoleApp', 'teamApps', 'registry'];
  const HISTORY = [
    { n: 1, topic: 'goal', q: 'mock.q.goal', a: 'mock.a.goal', kind: 'accepted' },
    { n: 2, topic: 'users', q: 'mock.q.users', a: 'mock.a.users', kind: 'own' },
    { n: 3, topic: 'stack', q: 'mock.q.stack', a: 'mock.a.stack', kind: 'accepted' },
  ];
  const QUESTIONS = [
    { n: 4, topic: 'mvp', q: 'mock.q.mvp', why: 'mock.why.mvp', rec: 'mock.r.mvp', opts: ['mock.o.mvp1', 'mock.o.mvp2', 'mock.o.mvp3'] },
    { n: 5, topic: 'demo', q: 'mock.q.demo', why: 'mock.why.demo', rec: 'mock.r.demo', opts: ['mock.o.demo1', 'mock.o.demo2'] },
    { n: 6, topic: 'refs', q: 'mock.q.refs', why: 'mock.why.refs', rec: 'mock.r.refs', opts: [] },
  ];
  const PROJECTS = [
    { slug: 'team-console', team: 'running', sprint: 'Sprint 02', demo: new Date(2026, 9, 16), done: 9, total: 14, waiting: 2 },
    { slug: 'sheltrix', team: 'paused', sprint: 'Sprint 01', demo: null, done: 5, total: 11, waiting: 0 },
  ];

  /* Every screen: its wizard step (-1 = All projects, null = whole page), and the sheet it opens over its base. */
  const SCREENS = {
    entry: -1, entryEmpty: -1,
    idea: 0, ideaFilled: 0, ideaShort: 0, ideaNoConn: 0,
    repo: 1, repoEmpty: 1, repoTaken: 1, repoCreating: 1, repoLink: 1, repoFailed: 1, repoRefused: 1, repoDone: 1,
    iStart: 2, iq: 2, iqOther: 2, iqWait: 2, iqBusy: 2, iqFailed: 2, iqOutsider: 2, brief: 2, briefFix: 2, briefV2: 2,
    kReady: 3, kRunning: 3, kNeeds: 3, kStalled: 3, kFailed: 3, kBusy: 3, kDone: 3,
    env: 4, envAll: 4, envUnreadable: 4,
    start: 5, started: 5, startFailed: 5,
    loading: null, gone: null, denied: null, offline: 2,
  };
  const SHEETS = { repoConfirm: ['repo', 'repo'], kConfirm: ['kReady', 'kickoff'], startConfirm: ['start', 'start'], cancelDraft: ['repoEmpty', 'cancel'], cancelRepo: ['repoDone', 'cancel'] };
  const REPO_EXISTS = ['repoCreating', 'repoFailed', 'repoRefused', 'repoDone', 'repoLink'];
  const dateFmt = () => new Intl.DateTimeFormat(L.lang === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'long' });

  const GLOBE = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.6 2.5 13.4 0 16M12 4c-2.5 2.6-2.5 13.4 0 16"/></svg>';
  const hosts = [...document.querySelectorAll('[data-app]')];

  /* ---------- one app instance ---------- */
  function mountApp(host, kind, keep) {
    const fresh = () => ({
      screen: 'entry', idea: '', name: NAME, nameState: 'ok', desc: '', vis: 'private', conn: true,
      q: 0, answers: [], answering: false, answer: '', answerErr: false, correction: null, enough: false,
      briefV: 1, briefConfirmed: false, fix: '', fixErr: false, briefOpen: false,
      repoRows: null, kickRows: null, histOpen: false, allSteps: false, menu: false, sheet: null,
      noDraft: false, lastStep: null, ideaErr: false, gen: 0, inkReceipt: false,
    });
    const S = keep || fresh();
    host.S = S;
    const uid = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const $ = (s) => host.querySelector(s);
    const repo = () => `${LOGIN}/${S.name || NAME}`;

    host.innerHTML = kind === 'mac' ? `<div class="win">
        <div class="win__bar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="win__title">Team Console</span></div>
        <div class="win__body">
          <nav class="sidebar" aria-label="${t('nav.aria')}" data-bg>
            <div class="brand">${I.mark}<span>Team Console</span></div>
            <ul class="side-list side-list--top">
              <li><button type="button" class="side-item" data-act="space">${I.inbox}<span>${t('nav.needs')}</span></button></li>
              <li><button type="button" class="side-item" data-act="toAll" data-fk="nav-all" data-slot="nav-all">${I.grid}<span>${t('nav.all')}</span></button></li>
            </ul>
            <div class="side-label">${t('nav.projects')}</div>
            <ul class="side-list">${PROJECTS.map((p) => `<li><button type="button" class="side-item" data-act="space"><span class="prod-mono" aria-hidden="true">${esc(p.slug[0])}</span><span class="side-prod__label">${esc(p.slug)}</span></button></li>`).join('')}</ul>
            <div class="side-foot">
              <a class="side-item side-item--add" href="#/new" data-act="toNew" data-fk="nav-new" data-slot="nav-new">${I.plus}<span>${t('overview.newProject')}</span></a>
              <a class="side-item" href="#/overview#add-project" data-act="addProject">${I.link}<span>${t('overview.addProject')}</span></a>
              <button type="button" class="side-item" data-act="space">${I.gear}<span>${t('nav.settings')}</span></button>
              <div class="side-foot__row"><span class="avatar avatar--owner" aria-hidden="true">K</span><span>${t('shell.owner')}</span></div>
            </div>
          </nav>
          <section class="set-main" aria-label="${t('newProject.title')}" data-bg data-slot="main-region">
            <div class="set-scroll" data-scroll><div class="set-inner set-inner--wide wz-inner" data-slot="screen"></div></div>
          </section>
        </div>
      </div>
      <div data-slot="asheet"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`
      : `<div class="p-status" aria-hidden="true"><span>9:41</span><span class="p-island"></span><span class="p-status__icons">${I.bars}${I.battery}</span></div>
      <div data-slot="bar" data-bg></div>
      <div class="p-scroll" data-scroll data-bg><div class="set-inner wz-inner" data-slot="screen"></div></div>
      <div class="home-ind" aria-hidden="true"></div>
      <div data-slot="asheet"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`;

    /* ----- small pieces ----- */
    const dis = (on, why) => (on ? ` aria-disabled="true"${why ? ` aria-describedby="${why}"` : ''}` : '');
    const offline = () => S.screen === 'offline';
    const offId = `${uid}-offline`;
    const btn = (act, label, cls = '', fk = act, extra = '') => `<button type="button" class="btn ${cls} btn--tall" data-act="${act}" data-fk="${fk}"${extra}>${label}</button>`;
    const wbtn = (act, label, cls = '', fk = act) => btn(act, label, cls, fk, dis(offline(), offId));
    const extLink = (href, label, fk = '') => `<a class="ext" href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-act="ext"${fk ? ` data-fk="${fk}"` : ''}>${label}<span class="sr-only"> ${t('common.external')}</span>${I.ext}</a>`;
    const extBtn = (href, label, cls, fk) => `<a class="btn ${cls} btn--tall" href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-act="ext" data-fk="${fk}">${label}<span class="sr-only"> ${t('common.external')}</span>${I.ext}</a>`;
    const userText = (s, cls = '') => `<span class="${cls}" dir="auto">${esc(s)}</span>`;
    const ideaText = () => S.idea || plain(t('mock.idea'));
    const step = () => SCREENS[S.screen];
    const stepName = (i) => t(`newProject.step.${STEPS[i]}`);

    /* ================= All projects (host of the entry points) ================= */
    function tile(p) {
      const pct = Math.round((p.done / p.total) * 100);
      const chip = p.team === 'paused' ? `<span class="status status--paused"><i></i>${t('overview.team.paused')}</span>` : `<span class="status"><i></i>${t('overview.team.running')}</span>`;
      return `<li><a class="ov" href="#/p/${esc(p.slug)}/board" data-act="space">
        <span class="ov__top"><span class="prod-mono" aria-hidden="true">${esc(p.slug[0])}</span><b>${esc(p.slug)}</b>${chip}</span>
        <span class="ov__line">${esc(p.sprint)}${p.demo ? ` · ${t('overview.demo', { date: dateFmt().format(p.demo) })}` : ''}</span><span class="meter meter--wide" aria-hidden="true"><i style="--p:${pct}%"></i></span>
        <span class="ov__foot"><span>${t('overview.done', { done: p.done, total: p.total })}</span>${p.waiting ? `<span class="count">${p.waiting}</span>` : ''}</span></a></li>`;
    }
    function draftTile() {
      const title = plain(t('mock.title'));
      return `<li class="draft-li"><article class="draft" aria-labelledby="${uid}-dt">
        <span class="draft__top"><span class="draft__chip">${I.clock}${t('newProject.draft.chip')}</span></span>
        <h2 class="draft__title" id="${uid}-dt" dir="auto">${esc(title)}</h2>
        <p class="draft__line">${t('newProject.draft.step', { n: 3, step: plain(stepName(2)) })}</p>
        <p class="draft__wait">${I.chat}<span>${t('newProject.draft.waiting.owner')}</span></p>
        <span class="wz-seg draft__seg" aria-hidden="true">${STEPS.map((_, i) => `<i class="${i < 2 ? 'is-done' : i === 2 ? 'is-cur' : ''}"></i>`).join('')}</span>
        <a class="btn btn--primary btn--tall draft__go" href="#/new/7/interview" data-act="continue" data-fk="draft-go" aria-label="${esc(plain(t('newProject.draft.continueAria', { title })))}">${t('newProject.draft.continue')}${I.chev}</a>
      </article></li>`;
    }
    function entryScreen(empty) {
      const actions = `<div class="ov-actions"><a class="btn btn--primary btn--tall" href="#/new" data-act="toNew" data-fk="new">${I.plus}${t('overview.newProject')}</a>
        <a class="btn btn--tall" href="#/overview#add-project" data-act="addProject" data-fk="add">${t('overview.addProject')}</a></div>`;
      let h = `<header class="ov-head ov-head--new"><div><h1 tabindex="-1" data-fk="h1">${t('overview.title')}</h1>${empty ? '' : `<p class="ov-count">${t('overview.count', { n: PROJECTS.length })}</p>`}</div>${empty ? '' : actions}</header>`;
      if (empty) {
        return h + `<section class="block ov-start" aria-labelledby="${uid}-empty"><span class="ov-start__mark" aria-hidden="true">${I.plus}</span><h2 id="${uid}-empty">${t('overview.empty.title')}</h2><p>${t('overview.empty.body')}</p>
          <div class="form-actions"><a class="btn btn--primary btn--tall" href="#/new" data-act="toNew" data-fk="new">${t('overview.empty.create')}</a><a class="btn btn--tall" href="#/overview#add-project" data-act="addProject" data-fk="add">${t('overview.empty.connect')}</a></div></section>`;
      }
      h += `<p class="ov-explain">${I.q}<span>${t('overview.newVsAdd')}</span></p>`;
      h += `<ul class="ov-grid">${S.noDraft ? '' : draftTile()}${PROJECTS.map(tile).join('')}</ul>`;
      return h;
    }

    /* ================= the wizard frame: header, stepper, aside ================= */
    function stepper(listId) {
      const cur = step();
      const go = ['ideaFilled', 'repoDone', 'brief', 'kDone', 'env', 'start'];
      return `<ol class="wz-steps__list"${listId ? ` id="${listId}"` : ''}>${STEPS.map((k, i) => {
        const state = i < cur ? 'done' : i === cur ? 'current' : 'future';
        const mark = state === 'done' ? I.check : `${i + 1}`;
        const inner = `<span class="wz-step__mark" aria-hidden="true">${mark}</span><span class="wz-step__txt"><b>${t(`newProject.step.${k}`)}</b><span class="sr-only">, ${t(`newProject.step.state.${state}`)}, </span><small>${t(`newProject.step.${k}Sub`)}</small></span>`;
        if (state === 'done') return `<li class="wz-step wz-step--done"><a href="#/new/7/${k}" data-act="go" data-go="${go[i]}" data-fk="st-${k}">${inner}</a></li>`;
        return `<li class="wz-step wz-step--${state}"${state === 'current' ? ' aria-current="step"' : ''}><span class="wz-step__plain">${inner}</span></li>`;
      }).join('')}</ol>`;
    }
    function miniStepper() {
      const cur = step(); const id = `${uid}-steps`;
      return `<div class="wz-mini">
        <div class="wz-mini__row"><p class="wz-mini__kicker">${t('newProject.stepOf', { n: cur + 1, step: plain(stepName(cur)) })}</p>
          <button type="button" class="btn btn--quiet btn--sm wz-mini__all" data-act="allSteps" data-fk="allSteps" aria-expanded="${S.allSteps}" aria-controls="${id}">${t('newProject.allSteps')}${I.down}</button></div>
        <span class="wz-seg" aria-hidden="true">${STEPS.map((_, i) => `<i class="${i < cur ? 'is-done' : i === cur ? 'is-cur' : ''}"></i>`).join('')}</span>
        <nav class="wz-steps wz-steps--sheet" aria-label="${t('newProject.stepsLabel')}" id="${id}"${S.allSteps ? '' : ' hidden'}>${stepper()}</nav>
      </div>`;
    }
    const cancellable = () => step() === 0 || step() === 1;
    function aside() {
      const cur = step();
      const row = (label, val, filled) => `<div class="wz-card__row${filled ? ' is-filled' : ''}"><dt>${label}</dt><dd>${filled ? val : `<span class="wz-card__none">${t('newProject.aside.none')}</span>`}</dd></div>`;
      const repoKnown = cur > 1 || REPO_EXISTS.includes(S.screen);
      const visWord = t(S.vis === 'public' ? 'newProject.aside.public' : 'newProject.aside.private');
      const settled = settledTopics().length;
      let brief = '';
      if (cur === 2) brief = ['brief', 'briefFix', 'briefV2'].includes(S.screen) ? t('newProject.aside.briefDraft', { n: S.screen === 'briefV2' ? 2 : S.briefV }) : t('newProject.aside.topics', { n: settled });
      if (cur > 2) brief = t('newProject.aside.briefV', { n: S.briefV });
      const kick = cur === 3 && S.screen !== 'kDone' ? (S.screen === 'kReady' ? '' : t('newProject.aside.running')) : cur > 3 || S.screen === 'kDone' ? t('newProject.aside.kickDone', { sprint: SPRINT }) : '';
      const env = cur > 4 || ['env', 'envUnreadable'].includes(S.screen) ? t('newProject.env.missing', { n: 2 }) : S.screen === 'envAll' ? t('newProject.env.allSet') : '';
      const ideaFilled = cur > 0 || ['ideaFilled', 'ideaShort'].includes(S.screen) || S.idea.length > 0;
      return `<aside class="wz-aside" aria-labelledby="${uid}-aside"><div class="wz-card">
        <h2 class="wz-card__h" id="${uid}-aside">${t('newProject.aside')}</h2>
        <dl>${row(t('newProject.aside.idea'), userText(ideaText(), 'wz-card__idea'), ideaFilled)}
        ${row(t('newProject.aside.repo'), `<code>${esc(repo())}</code> · ${visWord}`, repoKnown)}
        ${row(t('newProject.aside.brief'), brief, !!brief)}
        ${row(t('newProject.aside.kickoff'), kick, !!kick)}
        ${row(t('newProject.aside.env'), env, !!env)}</dl></div></aside>`;
    }
    function wizard(body) {
      const cur = step();
      if (kind === 'phone') return `${miniStepper()}<div class="wz-main" data-wz-main>${body}</div>`;
      const draftLine = cur === 0 && S.screen !== 'ideaFilled' && S.screen !== 'ideaShort' ? t('newProject.draftNew') : t('newProject.draftLine', { title: plain(t('mock.title')) });
      return `<header class="wz-head"><div><h1 tabindex="-1" data-fk="h1">${t('newProject.title')}</h1><p class="wz-head__draft">${draftLine}</p></div>
          ${cancellable() ? `<button type="button" class="btn btn--tall btn--danger-quiet" data-act="cancel" data-fk="cancel">${t('newProject.cancel.action')}</button>` : ''}</header>
        <nav class="wz-steps" aria-label="${t('newProject.stepsLabel')}">${stepper()}</nav>
        <div class="wz-grid"><div class="wz-main" data-wz-main>${body}</div>${aside()}</div>`;
    }
    const h2 = (key, vars) => `<h2 class="wz-h2" tabindex="-1" data-fk="h2">${t(key, vars)}</h2>`;
    const lead = (key, vars) => `<p class="wz-lead">${t(key, vars)}</p>`;
    const actions = (...b) => `<div class="wz-actions">${b.filter(Boolean).join('')}</div>`;

    /* ----- ledger: one row per stage with a status word (the #194 step ledger) ----- */
    const ROW = {
      done: ['step--done', () => I.check, 'newProject.row.done'],
      running: ['step--pending', () => dots, 'newProject.row.running'],
      waiting: ['step--wait', (i) => `${i + 1}`, 'newProject.row.waiting'],
      needs: ['step--missing step--outline', () => I.bang, 'newProject.row.needsYou'],
      failed: ['step--failed step--outline', () => I.x, 'newProject.row.failed'],
      later: ['step--skipped', () => I.minus, 'newProject.start.later'],
    };
    function ledger(rows, label) {
      return `<ol class="ledger wz-ledger" aria-label="${esc(label)}">${rows.map((r, i) => {
        const [cls, mark, word] = ROW[r.state];
        const w = r.word || t(word);
        return `<li class="step ${cls}${r.fresh ? ' is-new' : ''}">
          <span class="step__mark" aria-hidden="true">${mark(i)}</span>
          <div class="step__body"><div class="step__head"><p class="step__title"><span class="sr-only">${w}: </span>${r.title}</p><span class="step__state" aria-hidden="true">${r.state === 'needs' ? I.bang : r.state === 'failed' ? I.x : ''}${w}</span></div>
          ${r.sub ? `<p class="step__fix">${r.sub}</p>` : ''}${r.extra || ''}</div></li>`;
      }).join('')}</ol>`;
    }

    /* ================= 1 Idea ================= */
    function ideaScreen() {
      if (S.screen === 'ideaNoConn') {
        return h2('newProject.idea.title') + `<section class="res res--warn need-conn" aria-labelledby="${uid}-nc"><h3 id="${uid}-nc" tabindex="-1" data-fk="nc">${t('newProject.connect.title')}</h3><p>${t('newProject.connect.body')}</p>${btn('connect', t('newProject.connect.action'), 'btn--primary')}</section>`;
      }
      const v = S.idea; const n = [...v].length;
      const err = S.ideaErr;
      const desc = [`${uid}-count`, err ? `${uid}-ierr` : ''].filter(Boolean).join(' ');
      return h2('newProject.idea.title') + lead('newProject.idea.lead') + `
        <div class="field wz-field"><label class="field__label" for="${uid}-idea">${t('newProject.idea.label')}</label>
          <textarea class="field__input wz-ta" id="${uid}-idea" data-field="idea" data-fk="idea" dir="auto" rows="6" maxlength="2000" placeholder="${esc(plain(t('newProject.idea.placeholder')))}" aria-describedby="${desc}"${err ? ' aria-invalid="true"' : ''}>${esc(v)}</textarea>
          ${err ? `<p class="field__err" id="${uid}-ierr">${I.warn}<span>${t('newProject.idea.tooShort')}</span></p>` : ''}
          <p class="field__hint wz-count" id="${uid}-count" data-count>${t('newProject.idea.count', { n })}</p></div>
        <p class="wz-account"><span class="avatar avatar--owner" aria-hidden="true">K</span><span><b>${t('newProject.idea.account')}</b> <code>${LOGIN}</code> · ${t('newProject.idea.accountHint')}</span></p>
        ${actions(btn('ideaNext', t('newProject.idea.next'), 'btn--primary'))}
        <p class="wz-quiet">${t('newProject.idea.nothingYet')}</p>`;
    }

    /* ================= 2 Repository ================= */
    function nameStatus() {
      const st = S.nameState;
      if (st === 'checking') return `<span class="wz-status wz-status--wait">${dots}${t('newProject.repo.checking')}</span>`;
      if (st === 'ok') return `<span class="wz-status wz-status--ok">${I.check}${t('newProject.repo.available')}</span>`;
      return '';
    }
    function nameError() {
      const st = S.nameState;
      if (st === 'taken') return `${t('newProject.repo.taken', { name: S.name })} <button type="button" class="link-btn wz-inline" data-act="addProject">${t('newProject.repo.existing')}</button>`;
      if (st === 'invalid') return t('newProject.repo.invalid');
      if (st === 'empty' && S.nameTouched) return t('newProject.repo.empty');
      return '';
    }
    function repoForm() {
      const err = nameError();
      const describedBy = [`${uid}-rules`, `${uid}-nstat`, err ? `${uid}-nerr` : ''].filter(Boolean).join(' ');
      const radio = (v, icon) => `<label class="wz-radio${S.vis === v ? ' is-on' : ''}"><input type="radio" name="${uid}-vis" value="${v}" data-field="vis"${S.vis === v ? ' checked' : ''} aria-describedby="${uid}-vh-${v}">
          <span class="wz-radio__mark" aria-hidden="true"></span><span class="wz-radio__txt"><b>${icon}${t(`newProject.repo.${v}`)}</b><small id="${uid}-vh-${v}">${t(`newProject.repo.${v}Hint`)}</small></span></label>`;
      return `<form class="wz-form" data-form="repo" novalidate>
        <div class="field wz-field"><label class="field__label" for="${uid}-name">${t('newProject.repo.name')}</label>
          <p class="field__hint" id="${uid}-rules">${t('newProject.repo.rules')}</p>
          <div class="wz-prefix${err ? ' is-bad' : ''}"><span class="wz-prefix__owner" aria-hidden="true">${LOGIN}/</span>
            <input class="field__input" id="${uid}-name" data-field="name" data-fk="name" type="text" value="${esc(S.name)}" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done" aria-describedby="${describedBy}"${err ? ' aria-invalid="true"' : ''}></div>
          <p class="field__err" id="${uid}-nerr" data-nerr${err ? '' : ' hidden'}>${I.warn}<span>${err}</span></p>
          <p class="wz-nstat" id="${uid}-nstat" role="status" data-nstat>${nameStatus()}</p></div>
        <div class="field wz-field"><label class="field__label" for="${uid}-desc">${t('newProject.repo.description')} <span class="wz-opt">${t('newProject.repo.descriptionHint')}</span></label>
          <input class="field__input wz-plain" id="${uid}-desc" data-field="desc" data-fk="desc" type="text" dir="auto" value="${esc(S.desc || plain(t('mock.description')))}" maxlength="350"></div>
        <fieldset class="wz-radios"><legend class="field__label">${t('newProject.repo.visibility')}</legend>${radio('private', I.lock)}${radio('public', GLOBE)}</fieldset>
        <section class="wz-plan" aria-labelledby="${uid}-plan"><h3 id="${uid}-plan">${t('newProject.repo.plan')}</h3>
          <ul><li>${t('newProject.repo.planRepo', { repo: repo() })}</li><li>${t('newProject.repo.planBranches')}</li><li>${t('newProject.repo.planConsole')}</li><li>${t('newProject.repo.planRegistry')}</li><li class="wz-plan__you">${t('newProject.repo.planYou')}</li></ul>
          <dl class="wz-plan__meta"><div><dt>${t('newProject.repo.owner')}</dt><dd><code>${LOGIN}</code></dd></div><div><dt>${t('newProject.repo.template')}</dt><dd><code>${TEMPLATE}</code></dd></div></dl></section>
        ${actions(`<button type="submit" class="btn btn--primary btn--tall" data-fk="create"${dis(offline(), offId)}>${t('newProject.repo.create')}</button>`)}
      </form>`;
    }
    function teamAppsExtra() {
      return `<p class="step__fix">${t('newProject.repo.teamAppsHow', { name: S.name || NAME })}</p>
        <div class="wz-rowacts">${extLink(TEAM_APP_URL, t('newProject.repo.teamApp'), 'team-app')}${extLink(REVIEW_APP_URL, t('newProject.repo.reviewApp'), 'review-app')}</div>`;
    }
    function repoRows(states) {
      const sub = { repo: t(S.vis === 'public' ? 'newProject.repo.sub.repoPublic' : 'newProject.repo.sub.repo'), consoleApp: t('newProject.repo.sub.consoleApp'), registry: t('newProject.repo.sub.registry') };
      return REPO_ROWS.map((k, i) => {
        const st = states[i]; const r = { state: st.state || st, fresh: st.fresh, title: t(`newProject.repo.row.${k}`, { repo: repo() }).replace(esc(repo()), `<code>${esc(repo())}</code>`), sub: sub[k] };
        if (k === 'teamApps') { r.sub = ''; if (r.state === 'needs') { r.extra = teamAppsExtra(); r.word = `${t('newProject.row.needsYou')}`; } }
        if (k === 'registry' && r.state === 'failed') { r.sub = ''; r.extra = `<p class="step__fix">${t('newProject.repo.refused.body')}</p>`; }
        if (k === 'consoleApp' && r.state === 'failed') r.sub = t('newProject.repo.failed.consoleApp');
        if (k === 'repo' && r.state === 'done') r.extra = `<div class="wz-rowacts">${extLink(GH(repo()), t('newProject.kickoff.openRow'))}</div>`;
        return r;
      });
    }
    function repoScreen() {
      const sc = S.screen;
      if (sc === 'repo' || sc === 'repoEmpty' || sc === 'repoTaken') return h2('newProject.repo.title') + lead('newProject.repo.lead') + repoForm();
      if (sc === 'repoLink') {
        return h2('newProject.repo.link.title') + lead('newProject.repo.link.lead') + `
          <div class="wz-link">${extBtn(`https://github.com/new?template_owner=${LOGIN}&template_name=product-team-template&owner=${LOGIN}&name=${encodeURIComponent(S.name)}&visibility=${S.vis}`, t('newProject.repo.link.action'), 'btn--primary', 'link-go')}
            <div class="wz-wait wz-wait--inline" role="status"><p class="wz-wait__h">${dots}<span>${t('newProject.repo.link.waiting', { repo: repo() })}</span></p><p>${t('newProject.repo.link.waitingHint')}</p></div>
            ${btn('checkNow', t('newProject.repo.checkNow'))}
            <p class="wz-quiet">${t('newProject.repo.link.notInstalled')} ${extLink(CONSOLE_INSTALL_URL, t('newProject.repo.link.install'))}</p></div>
          ${ledger(repoRows([{ state: 'needs' }, 'waiting', 'waiting', 'waiting']).map((r, i) => (i === 0 ? { ...r, extra: '', word: t('newProject.row.needsYou') } : r)), plain(t('newProject.repo.creating')))}`;
      }
      const rows = S.repoRows || {
        repoCreating: [{ state: 'done' }, { state: 'running' }, 'waiting', 'waiting'],
        repoFailed: ['done', 'failed', 'waiting', 'waiting'],
        repoRefused: ['done', 'done', 'needs', 'failed'],
        repoDone: ['done', 'done', 'needs', 'done'],
      }[sc];
      const states = rows.map((r) => (typeof r === 'string' ? { state: r } : r));
      const list = ledger(repoRows(states), plain(t('newProject.repo.creating')));
      if (sc === 'repoCreating') return h2('newProject.repo.creating') + `<p class="wz-lead">${t('newProject.repo.leave')}</p>` + list;
      if (sc === 'repoFailed') {
        return h2('newProject.repo.creating') + `<div class="block block--error wz-alert" role="alert"><h3>${t('newProject.repo.failed.consoleApp')}</h3><p>${t('newProject.repo.failedKeep', { what: t('newProject.repo.failedWhat') })}</p>${wbtn('repoRetry', t('newProject.repo.retry'))}</div>` + list;
      }
      if (sc === 'repoRefused') {
        return h2('newProject.repo.creating') + `<div class="block block--error wz-alert" role="alert"><h3>${t('newProject.repo.refused.title')}</h3><p>${t('newProject.repo.failedKeep', { what: t('newProject.repo.row.registry').toLowerCase() })}</p>${wbtn('refusedRetry', t('newProject.repo.refused.retry'))}</div>` + list;
      }
      return h2('newProject.repo.done') + list + `<p class="wz-note">${I.bang}<span>${t('newProject.repo.youLeft')}</span></p>`
        + actions(btn('repoNext', t('newProject.repo.next'), 'btn--primary'), extLink(GH(repo()), t('newProject.repo.open', { name: S.name || NAME }), 'open-repo'));
    }

    /* ================= 3 Interview and the brief ================= */
    function settledTopics() {
      if (step() > 2 || ['brief', 'briefFix', 'briefV2'].includes(S.screen)) return TOPICS.filter((k) => k !== 'out');
      const done = ['goal', 'users', 'stack'];
      QUESTIONS.slice(0, S.q).forEach((q) => done.push(q.topic));
      return done;
    }
    function topicsBlock() {
      const set = settledTopics();
      const isBrief = ['brief', 'briefFix', 'briefV2'].includes(S.screen);
      return `<section class="wz-topics" aria-labelledby="${uid}-tp"><h3 class="wz-sub" id="${uid}-tp">${t('newProject.interview.topics')}</h3><ul>${TOPICS.map((k) => {
        const assumed = isBrief && k === 'out';
        const ok = set.includes(k);
        return `<li class="wz-topic${ok && !assumed ? ' is-done' : ''}${assumed ? ' is-assumed' : ''}${S.inkTopic === k ? ' is-new' : ''}">${ok && !assumed ? I.check : assumed ? I.q : ''}<span>${t(`newProject.topic.${k}`)}</span><span class="sr-only">${t(ok && !assumed ? 'newProject.interview.topicDone' : 'newProject.interview.topicOpen')}</span></li>`;
      }).join('')}</ul></section>`;
    }
    function historyItems() {
      const extra = S.answers.map((a) => ({ ...a }));
      return [...HISTORY, ...extra];
    }
    function historyBlock() {
      const items = historyItems(); const id = `${uid}-hist`;
      const outsider = S.screen === 'iqOutsider';
      const turn = (h) => `<li class="wz-turn">
        <p class="wz-turn__q" dir="auto"><span class="wz-turn__n">${h.n}</span>${esc(plain(t(h.q)))}</p>
        <div class="receipt wz-receipt"><span class="receipt__icon" aria-hidden="true">${I.check}</span><span class="receipt__body"><span class="receipt__verb">${t(h.kind === 'accepted' ? 'newProject.interview.accepted' : 'newProject.interview.yours')}:</span> ${userText(h.text || plain(t(h.a)))}</span></div>
        ${S.briefConfirmed ? '' : `<button type="button" class="link-btn wz-change" data-act="change" data-n="${h.n}" data-fk="change-${h.n}" aria-label="${esc(plain(t('newProject.interview.changeAria', { n: h.n })))}"${dis(offline(), offId)}>${t('newProject.interview.change')}</button>`}</li>`;
      const out = outsider ? `<li class="wz-turn wz-turn--outsider"><p class="wz-outsider"><span class="wz-outsider__chip">${I.warn}${t('newProject.interview.outsider')}</span><code>${esc(plain(t('mock.outsider.who')))}</code></p>
          <p class="wz-outsider__text" dir="auto">${esc(plain(t('mock.outsider.text')))}</p><p class="wz-outsider__hint">${t('newProject.interview.outsiderHint')}</p></li>` : '';
      const open = S.histOpen || outsider;
      return `<section class="wz-hist"><button type="button" class="wz-hist__toggle" data-act="hist" data-fk="hist" aria-expanded="${open}" aria-controls="${id}"><span>${t('newProject.interview.history', { n: items.length + (outsider ? 1 : 0) })}</span>${I.down}</button>
        <ol class="wz-hist__list" id="${id}"${open ? '' : ' hidden'}>${items.map(turn).join('')}${out}</ol></section>`;
    }
    function questionCard() {
      const q = QUESTIONS[Math.min(S.q, QUESTIONS.length - 1)];
      const meta = t('newProject.interview.questionMeta', { n: q.n, topic: plain(t(`newProject.topic.${q.topic}`)) });
      let foot;
      if (S.answering) {
        const label = S.correction ? t('newProject.interview.correctionLabel', { n: S.correction }) : t('newProject.interview.answerLabel');
        const err = S.answerErr;
        foot = `<div class="field wz-field"><label class="field__label" for="${uid}-ans">${label}</label>
            <textarea class="field__input wz-ta wz-ta--short" id="${uid}-ans" data-field="answer" data-fk="answer" dir="auto" rows="3" aria-describedby="${uid}-ansh${err ? ` ${uid}-anse` : ''}"${err ? ' aria-invalid="true"' : ''}>${esc(S.answer)}</textarea>
            ${err ? `<p class="field__err" id="${uid}-anse">${I.warn}<span>${t('newProject.interview.emptyAnswer')}</span></p>` : ''}
            <p class="field__hint" id="${uid}-ansh">${t('newProject.interview.sendHint')}</p></div>
          ${actions(wbtn('send', t('newProject.interview.send'), 'btn--primary'), btn('answerCancel', t('newProject.interview.cancel'), 'btn--quiet'))}`;
      } else {
        const opts = q.opts.length ? `<div class="wz-opts" role="group" aria-labelledby="${uid}-optl"><p class="wz-opts__l" id="${uid}-optl">${t('newProject.interview.options')}</p>${q.opts.map((o, i) => `<button type="button" class="wz-opt-chip" data-act="opt" data-o="${o}" data-fk="opt-${i}"${dis(offline(), offId)} dir="auto">${esc(plain(t(o)))}</button>`).join('')}</div>` : '';
        foot = opts + actions(wbtn('accept', t('newProject.interview.accept'), 'btn--primary'), wbtn('other', t('newProject.interview.other')));
      }
      return `<article class="card wz-q${S.inkQ ? ' is-new' : ''}" aria-labelledby="${uid}-q">
        <p class="wz-q__meta"><span class="avatar avatar--pm" aria-hidden="true">PM</span><span>${meta}</span></p>
        <h3 class="wz-q__title" id="${uid}-q" tabindex="-1" data-fk="q" dir="auto"><span class="sr-only">${meta}. </span>${esc(plain(t(q.q)))}</h3>
        <p class="wz-q__why" dir="auto">${t('newProject.interview.why', { text: plain(t(q.why)) })}</p>
        <div class="rec"><span class="rec__label">${t('newProject.interview.recommend')}</span><span class="rec__choice" dir="auto">${esc(plain(t(q.rec)))}</span></div>
        ${foot}</article>`;
    }
    function lastAnswerReceipt() {
      const last = S.answers[S.answers.length - 1] || { kind: 'own', text: plain(t('mock.my.mvp')), n: 4 };
      return `<div class="receipt wz-receipt wz-receipt--last${S.inkReceipt ? ' is-new' : ''}"><span class="receipt__icon" aria-hidden="true">${I.check}</span><span class="receipt__body"><span class="receipt__verb">${t(last.kind === 'accepted' ? 'newProject.interview.accepted' : 'newProject.interview.yours')}:</span> ${userText(last.text || '')}</span></div>`;
    }
    function interviewScreen() {
      const sc = S.screen;
      if (sc === 'iStart') {
        return h2('newProject.interview.title') + `<p class="wz-lead">${t('newProject.interview.startLead', { name: S.name || NAME })}</p>
          <figure class="wz-idea"><figcaption>${t('newProject.interview.yourIdea')}</figcaption><blockquote dir="auto">${esc(ideaText())}</blockquote></figure>
          ${actions(wbtn('startInterview', t('newProject.interview.start'), 'btn--primary'))}`;
      }
      if (['brief', 'briefFix', 'briefV2'].includes(sc)) return briefScreen();
      let body = '';
      if (sc === 'iq' || sc === 'iqOther' || sc === 'iqOutsider' || sc === 'offline') {
        body = questionCard() + `<div class="wz-enough"><button type="button" class="link-btn" data-act="enough" data-fk="enough"${dis(offline(), offId)}>${t('newProject.interview.enough')}</button><p class="field__hint">${t('newProject.interview.enoughHint')}</p></div>`;
      } else if (sc === 'iqWait') {
        body = lastAnswerReceipt() + `<div class="wz-wait" tabindex="-1" data-fk="wait"><p class="wz-wait__h">${dots}<span>${t('newProject.interview.waiting')}</span></p><p>${t('newProject.interview.waitingHint')}</p></div>`;
      } else if (sc === 'iqBusy') {
        body = lastAnswerReceipt() + `<div class="wz-wait wz-wait--busy" tabindex="-1" data-fk="wait"><p class="wz-wait__h">${I.clock}<span>${t('newProject.interview.busy')}</span></p><p>${t('newProject.interview.busyHint', { time: hhmm(at(15, 10)) })}</p></div>`;
      } else if (sc === 'iqFailed') {
        body = lastAnswerReceipt() + `<div class="block block--error wz-alert" role="alert"><h3>${t('newProject.interview.failed')}</h3><p>${t('newProject.interview.failedHint')}</p>
          <div class="form-actions">${wbtn('wake', t('newProject.interview.wake'))}${extLink(RUN_LOG_URL, t('common.runLog'))}</div></div>`;
      }
      const banner = sc === 'offline' ? `<div class="paused wz-offline" id="${offId}" role="status">${I.wifi}<span>${t('newProject.offline')}</span></div>` : '';
      return banner + h2('newProject.interview.title') + lead('newProject.interview.lead') + topicsBlock() + historyBlock() + body;
    }
    function briefCard(v, readOnly) {
      const f = (k, val, changed) => `<div class="brief-f${changed ? ' is-changed' : ''}"><dt>${t(`newProject.brief.${k}`)}</dt><dd dir="auto">${esc(val)}</dd></div>`;
      const time = hhmm(v === 2 ? at(14, 41) : at(14, 32));
      const assume = [plain(t('mock.brief.assume1')), plain(t('mock.brief.assume2'))];
      return `<article class="brief" aria-labelledby="${uid}-bt${readOnly ? 'r' : ''}">
        <header class="brief__head"><h3 id="${uid}-bt${readOnly ? 'r' : ''}" tabindex="-1" data-fk="${readOnly ? 'brief-ro' : 'brief-h'}">${t('newProject.brief.title')}</h3><p class="brief__v">${t(v === 2 ? 'newProject.brief.versionChanged' : 'newProject.brief.version', { n: v, time })}</p></header>
        <dl class="brief__dl">${f('goal', plain(t('mock.brief.goal')))}${f('users', plain(t('mock.brief.users')))}${f('mvp', plain(t('mock.brief.mvp')))}${f('out', plain(t('mock.brief.out')))}
          ${f('stack', plain(t('mock.brief.stack')))}${f('demo', plain(t(v === 2 ? 'mock.brief.demo2' : 'mock.brief.demo')), v === 2)}${f('refs', plain(t('mock.brief.refs')))}</dl>
        <section class="brief__assume" aria-labelledby="${uid}-as${readOnly ? 'r' : ''}"><h4 id="${uid}-as${readOnly ? 'r' : ''}">${I.q}${t('newProject.brief.assumptions')}</h4><p>${t('newProject.brief.assumptionsHint')}</p><ul>${assume.map((a) => `<li dir="auto">${esc(a)}</li>`).join('')}</ul></section>
      </article>`;
    }
    function briefScreen() {
      const sc = S.screen; const v = sc === 'briefV2' ? 2 : S.briefV;
      let foot;
      if (sc === 'briefFix') {
        const err = S.fixErr;
        foot = `<div class="field wz-field"><label class="field__label" for="${uid}-fix">${t('newProject.brief.fixLabel')}</label>
            <textarea class="field__input wz-ta wz-ta--short" id="${uid}-fix" data-field="fix" data-fk="fix" dir="auto" rows="3" aria-describedby="${uid}-fixh${err ? ` ${uid}-fixe` : ''}"${err ? ' aria-invalid="true"' : ''}>${esc(S.fix)}</textarea>
            ${err ? `<p class="field__err" id="${uid}-fixe">${I.warn}<span>${t('newProject.interview.emptyAnswer')}</span></p>` : ''}
            <p class="field__hint" id="${uid}-fixh">${t('newProject.interview.sendHint')}</p></div>
          ${actions(wbtn('fixSend', t('newProject.brief.fixSend'), 'btn--primary'), btn('fixCancel', t('newProject.interview.cancel'), 'btn--quiet'))}`;
      } else {
        foot = `<p class="wz-frozen">${I.lock}<span>${t('newProject.brief.frozen')}</span></p>` + actions(wbtn('briefConfirm', t('newProject.brief.confirm'), 'btn--primary'), wbtn('briefChange', t('newProject.brief.change')));
      }
      return h2('newProject.brief.title') + lead('newProject.brief.lead') + topicsBlock() + briefCard(v) + foot;
    }

    /* ================= 4 Kickoff ================= */
    function kickRows(states) {
      const date = dateFmt().format(S.briefV === 2 ? DEMO2 : DEMO1);
      const sub = { access: t('newProject.kickoff.sub.access', { name: S.name || NAME }), config: t('newProject.kickoff.sub.config'), sprint: t('newProject.kickoff.sub.sprint', { date }), backlog: t('newProject.kickoff.sub.backlog', { n: 12 }), adr: t('newProject.kickoff.sub.adr'), design: t('newProject.kickoff.sub.design'), checklist: t('newProject.kickoff.sub.checklist') };
      const link = { config: `${repo()}/blob/dev/.product-team/project.yml`, sprint: `${repo()}/milestone/1`, backlog: `${repo()}/issues?q=milestone%3A%22Sprint+01%22`, adr: `${repo()}/blob/dev/docs/decisions/0001-stack.md`, design: `${repo()}/issues/14` };
      return KICK.map((k, i) => {
        const st = typeof states[i] === 'string' ? { state: states[i] } : states[i];
        const r = { state: st.state, fresh: st.fresh, title: t(`newProject.kickoff.row.${k}`, { sprint: SPRINT }), sub: sub[k] };
        if (st.state === 'done' && link[k]) r.extra = `<div class="wz-rowacts">${extLink(GH(link[k]), t('newProject.kickoff.openRow'))}</div>`;
        if (st.state === 'done' && k === 'checklist') r.extra = `<div class="wz-rowacts"><a class="ext" href="#/needs-you" data-act="space">${t('newProject.kickoff.openNeeds')}${I.chev}</a></div>`;
        if (st.state === 'needs' && k === 'access') { r.sub = t('newProject.kickoff.needsAccess', { name: S.name || NAME }); r.extra = `<div class="wz-rowacts">${extLink(TEAM_APP_URL, t('newProject.repo.teamApp'), 'k-team-app')}${extLink(REVIEW_APP_URL, t('newProject.repo.reviewApp'), 'k-review-app')}</div>`; }
        if (st.state === 'failed') r.sub = t('newProject.kickoff.failedRow');
        return r;
      });
    }
    function kickoffScreen() {
      const sc = S.screen;
      const rows = S.kickRows || {
        kReady: KICK.map(() => 'waiting'), kBusy: KICK.map(() => 'waiting'),
        kRunning: ['done', 'done', 'running', 'waiting', 'waiting', 'waiting', 'waiting'], kStalled: ['done', 'done', 'done', 'running', 'waiting', 'waiting', 'waiting'],
        kNeeds: ['needs', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting'],
        kFailed: ['done', 'done', 'done', 'failed', 'waiting', 'waiting', 'waiting'], kDone: KICK.map(() => 'done'),
      }[sc];
      const list = ledger(kickRows(rows), plain(t('newProject.kickoff.title')));
      const receipt = S.inkReceipt ? `<div class="receipt wz-receipt is-new"><span class="receipt__icon" aria-hidden="true">${I.check}</span><span class="receipt__body"><span class="receipt__verb">${t('newProject.brief.confirmed', { n: S.briefV })}</span></span></div>` : '';
      const briefLine = `<div class="wz-briefline"><p>${t('newProject.kickoff.brief', { n: S.briefV, time: hhmm(S.briefV === 2 ? at(14, 41) : at(14, 32)) })}</p>
          <button type="button" class="link-btn" data-act="viewBrief" data-fk="viewBrief" aria-expanded="${S.briefOpen}" aria-controls="${uid}-ro">${t(S.briefOpen ? 'newProject.kickoff.hideBrief' : 'newProject.kickoff.viewBrief')}</button></div>
          <div id="${uid}-ro"${S.briefOpen ? '' : ' hidden'}>${briefCard(S.briefV, true)}</div>`;
      const runLog = extLink(RUN_LOG_URL, t('common.runLog'), 'runlog');
      if (sc === 'kReady') return receipt + h2('newProject.kickoff.title') + lead('newProject.kickoff.lead') + briefLine + list + `<p class="wz-quiet">${t('newProject.kickoff.usual')}</p>` + actions(wbtn('kStart', t('newProject.kickoff.start'), 'btn--primary'));
      if (sc === 'kBusy') return h2('newProject.kickoff.title') + `<div class="wz-wait wz-wait--busy" role="status"><p class="wz-wait__h">${I.clock}<span>${t('newProject.kickoff.busy', { time: hhmm(at(15, 10)) })}</span></p><p>${t('newProject.kickoff.busyHint')}</p></div>` + list;
      const meta = `<p class="wz-meta">${t('newProject.kickoff.meta', { start: hhmm(sc === 'kStalled' ? at(13, 58) : at(14, 52)), last: hhmm(sc === 'kStalled' ? at(14, 6) : at(14, 58)) })}</p>`;
      if (sc === 'kRunning') return h2('newProject.kickoff.running') + meta + list + `<p class="wz-quiet">${t('newProject.repo.leave')}</p>` + actions(runLog);
      if (sc === 'kStalled') return `<div class="paused wz-banner" role="status">${I.clock}<span>${t('newProject.kickoff.stalled', { n: 45 })}</span></div>` + h2('newProject.kickoff.running') + meta + list + actions(runLog);
      if (sc === 'kNeeds') return h2('newProject.kickoff.failed') + `<p class="wz-note">${I.bang}<span>${t('newProject.kickoff.failedHint', { row: plain(t('newProject.kickoff.row.access')) })}</span></p>` + list + actions(wbtn('kContinue', t('newProject.kickoff.continue'), 'btn--primary'), runLog);
      if (sc === 'kFailed') {
        return h2('newProject.kickoff.failed') + `<div class="block block--error wz-alert" role="alert"><h3>${t('newProject.kickoff.failed')}</h3><p>${t('newProject.kickoff.failedHint', { row: plain(t('newProject.kickoff.row.backlog')) })}</p>
          <div class="form-actions">${wbtn('kContinue', t('newProject.kickoff.continue'), 'btn--primary')}${runLog}</div></div>` + list;
      }
      return h2('newProject.kickoff.done') + `<a class="wz-needs" href="#/needs-you" data-act="space" data-fk="needs"><span class="wz-needs__n">3</span><span class="wz-needs__txt"><b>${t('newProject.kickoff.waiting', { n: 3 })}</b><small>${t('newProject.kickoff.waitingHint')}</small></span>${I.chev}</a>`
        + list + actions(btn('kNext', t('newProject.kickoff.next'), 'btn--primary'));
    }

    /* ================= 5 Environments ================= */
    function envScreen() {
      const sc = S.screen;
      const item = (state, name, where) => `<li class="env env--${state}"><span class="env__mark" aria-hidden="true">${state === 'set' ? I.check : state === 'missing' ? I.bang : I.q}</span>
          <span class="env__txt"><code>${name}</code><small>${where}</small></span><span class="env__st"><span class="sr-only">${name}: </span>${t(`newProject.env.status.${state}`)}</span></li>`;
      const all = sc === 'envAll';
      const list = sc === 'envUnreadable' ? `<div class="block block--error wz-alert" role="alert"><h3>${t('newProject.env.unreadable')}</h3><div class="form-actions">${wbtn('envCheck', t('newProject.repo.retry'))}</div></div>`
        : `<ul class="env-list" aria-label="${t('newProject.env.listAria')}">${all
          ? item('set', 'CLOUDFLARE_API_TOKEN', t('newProject.env.where.github')) + item('set', 'CLOUDFLARE_ACCOUNT_ID', t('newProject.env.where.github'))
          : item('missing', 'CLOUDFLARE_API_TOKEN', t('newProject.env.where.github')) + item('missing', 'CLOUDFLARE_ACCOUNT_ID', t('newProject.env.where.github'))}
          ${item('set', `ROUTINE_TOKEN_${(S.name || NAME).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`, t('newProject.env.where.console'))}${item('unseen', 'PT_TELEGRAM_TOKEN', t('newProject.env.unseenHow'))}</ul>`;
      const summary = sc === 'envUnreadable' ? '' : `<div class="env-sum${all ? ' env-sum--ok' : ''}" role="status"><p class="env-sum__n">${all ? I.check : ''}${all ? t('newProject.env.allSet') : t('newProject.env.missing', { n: 2 })}</p><p>${t('newProject.env.summaryHint')}</p></div>`;
      const acts = all
        ? actions(btn('envNext', t('newProject.env.next'), 'btn--primary'), btn('envOpen', t('newProject.env.open')))
        : actions(btn('envOpen', t('newProject.env.open'), 'btn--primary'), wbtn('envCheck', t('newProject.env.check')), btn('envSkip', t('newProject.env.skip'), 'btn--quiet'));
      return h2('newProject.env.title') + lead('newProject.env.lead') + summary + list + `<p class="wz-note wz-note--quiet">${I.key}<span>${t('newProject.env.accounts')}</span></p>` + acts
        + (all ? '' : `<p class="wz-quiet" id="${uid}-skiph">${t('newProject.env.skipHint')}</p>`);
    }

    /* ================= 6 Start ================= */
    const stampSVG = () => `<div class="launch-stamp" aria-hidden="true"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="54"/><circle class="stamp__inner" cx="60" cy="60" r="46"/><path d="M40 70l12 12 28-30"/></svg><span>${t('newProject.start.stamp')}</span></div>`;
    function startScreen() {
      const sc = S.screen; const name = S.name || NAME;
      if (sc === 'started') {
        return `<section class="launch" aria-labelledby="${uid}-ln">${stampSVG()}
          <h2 class="wz-h2" id="${uid}-ln" tabindex="-1" data-fk="h2">${t('newProject.start.done', { name })}</h2>
          <p class="wz-lead">${t('newProject.start.nextRun', { when: plain(t('newProject.start.when', { time: hhmm(at(18, 0)) })) })}</p>
          ${actions(btn('openProject', t('newProject.start.open'), 'btn--primary'), `<a class="btn btn--tall" href="#/needs-you" data-act="space" data-fk="needs">${t('newProject.start.needs', { n: 3 })}<span class="count">3</span></a>`, btn('runNow', t('newProject.start.runNow'), 'btn--quiet'))}</section>`;
      }
      const rows = [
        { state: 'done', title: t('newProject.start.row.brief'), sub: t('newProject.start.sub.brief', { n: S.briefV }) },
        { state: 'done', title: t('newProject.start.row.repo'), sub: `<code>${esc(repo())}</code>` },
        { state: 'done', title: t('newProject.start.row.kickoff'), sub: t('newProject.start.sub.kickoff', { sprint: SPRINT }) },
        { state: 'later', title: t('newProject.start.row.env'), sub: t('newProject.start.sub.env') },
      ];
      const fail = sc === 'startFailed' ? `<div class="block block--error wz-alert" role="alert"><h3>${t('newProject.start.failed')}</h3><div class="form-actions">${wbtn('startTeam', t('newProject.repo.retry'), '', 'retry')}</div></div>` : '';
      return h2('newProject.start.title') + lead('newProject.start.lead') + fail + ledger(rows, plain(t('newProject.start.title'))) + (sc === 'startFailed' ? '' : actions(wbtn('startTeam', t('newProject.start.action'), 'btn--primary')));
    }

    /* ================= whole-page states ================= */
    function pageState() {
      const sc = S.screen;
      if (sc === 'loading') {
        return `<div aria-busy="true" class="wz-skel"><p class="sr-only" role="status">${t('newProject.loading')}</p><div aria-hidden="true">
          ${kind === 'mac' ? '<span class="skel skel--h1"></span><span class="wz-skel__steps">' + '<span class="skel"></span>'.repeat(6) + '</span>' : '<span class="skel skel--b"></span><span class="wz-seg">' + '<i></i>'.repeat(6) + '</span>'}
          <span class="skel skel--h2"></span><span class="skel skel--a"></span><span class="skel skel--card"></span><span class="skel skel--btn"></span></div></div>`;
      }
      const block = (icon, title, hint) => `<section class="block wz-page-block"><h2 class="block__icon-h" tabindex="-1" data-fk="h2">${icon}${t(title)}</h2><p>${t(hint)}</p>${btn('toAll', t('newProject.back'), 'btn--primary', 'back-all')}</section>`;
      if (sc === 'gone') return block(I.archive, 'newProject.gone', 'newProject.goneHint');
      return block(I.lock, 'newProject.denied', 'newProject.deniedHint');
    }

    /* ================= sheets: Sheet.confirm (bottom sheet on iPhone, dialog on the Mac) ================= */
    function sheetContent(k) {
      const name = S.name || NAME;
      if (k === 'repo') return { title: t('newProject.repo.confirmTitle', { repo: repo() }), body: `<ul class="wz-sheet__items"><li>${t('newProject.repo.planRepo', { repo: repo() })}</li><li>${t(S.vis === 'public' ? 'newProject.repo.public' : 'newProject.repo.private')} · ${t(S.vis === 'public' ? 'newProject.repo.publicHint' : 'newProject.repo.privateHint')}</li><li>${t('newProject.repo.planConsole')}</li></ul><p class="wz-sheet__note"><b>${t('newProject.repo.confirmNote')}</b></p>`, primary: t('newProject.repo.confirmAction'), danger: false };
      if (k === 'kickoff') return { title: t('newProject.kickoff.confirmTitle'), body: `<p>${t('newProject.kickoff.confirmBody', { repo: repo(), sprint: SPRINT, n: S.briefV })}</p><p class="wz-sheet__note">${t('newProject.kickoff.confirmItems')}</p>`, primary: t('newProject.kickoff.confirmAction') };
      if (k === 'start') return { title: t('newProject.start.confirmTitle', { name }), body: `<p>${t('newProject.start.confirmBody')}</p>`, primary: t('newProject.start.confirmAction') };
      const repoThere = REPO_EXISTS.includes(S.sheetBase || S.screen);
      return { title: t('newProject.cancel.title'), body: `<p>${t('newProject.cancel.draftOnly')}</p>${repoThere ? `<p class="wz-sheet__note"><b>${t('newProject.cancel.repoStays', { repo: repo() })}</b> ${t('newProject.cancel.repoHow')}</p>` : ''}`, primary: t('newProject.cancel.action'), secondary: t('newProject.cancel.keep'), danger: true };
    }
    function drawSheet() {
      const slot = $('[data-slot=asheet]');
      if (!S.sheet) { slot.innerHTML = ''; return; }
      const c = sheetContent(S.sheet);
      const primary = `<button type="button" class="btn ${c.danger ? 'btn--danger' : 'btn--primary'} btn--tall" data-act="sheetOk" data-fk="sheet-ok">${c.primary}</button>`;
      const secondary = `<button type="button" class="btn btn--tall" data-act="sheetClose" data-fk="sheet-no">${c.secondary || t('newProject.interview.cancel')}</button>`;
      // #282: primary on top on the phone; Cancel then the primary in the dialog row. DOM = Tab = visual order.
      const foot = kind === 'phone' ? primary + secondary : secondary + primary;
      slot.innerHTML = `<div class="asheet${kind === 'mac' ? ' asheet--dialog' : ''} wz-sheet"><div class="asheet__scrim" data-act="sheetClose"></div>
        <section class="asheet__panel" role="dialog" aria-modal="true" aria-labelledby="${uid}-st" aria-describedby="${uid}-sb">
          ${kind === 'phone' ? '<div class="sheet__grab" aria-hidden="true"></div>' : ''}
          <div class="asheet__head"><h2 class="asheet__title" id="${uid}-st" tabindex="-1" data-fk="sheet-title">${c.title}</h2></div>
          <div class="asheet__body" id="${uid}-sb">${c.body}</div>
          <div class="asheet__foot wz-sheet__foot">${foot}</div></section></div>`;
      $('[data-fk="sheet-title"]').focus();
    }
    function openSheet(k, origin) {
      S.sheet = k; S.sheetOrigin = origin; S.menu = false;
      host.querySelectorAll('[data-bg]').forEach((el) => { el.inert = true; });
      drawSheet();
      const panel = $('.asheet__panel'); const scrim = $('.asheet__scrim');
      if (isReduced()) play(panel, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') });
      else {
        play(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-base'), easing: cssVar('--ease-standard') });
        play(panel, kind === 'phone' ? [{ transform: 'translateY(100%)' }, { transform: 'none' }] : [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: ms(kind === 'phone' ? '--dur-slow' : '--dur-base'), easing: cssVar('--ease-enter') });
      }
    }
    function closeSheet(focus) {
      const origin = S.sheetOrigin;
      S.sheet = null; S.sheetBase = null; drawSheet();
      host.querySelectorAll('[data-bg]').forEach((el) => { el.inert = false; });
      const f = focus || origin;
      const el = f && host.querySelector(`[data-fk="${f}"]`);
      if (el) el.focus();
    }

    /* ================= render ================= */
    function bar() {
      if (kind !== 'phone') return;
      const slot = $('[data-slot=bar]');
      if (SCREENS[S.screen] === -1) {
        slot.innerHTML = `<header class="p-head"><button type="button" class="p-switch" data-act="space" aria-haspopup="dialog" aria-label="${t('nav.switch')}"><span class="p-switch__txt"><b>${t('nav.all')}</b></span>${I.down}</button></header>`;
        return;
      }
      const menu = cancellable() && S.screen !== 'loading';
      slot.innerHTML = `<header class="p-bar wz-bar"><a class="p-back" href="#/overview" data-act="toAll" data-fk="back">${I.back}${t('newProject.back')}</a>
        <h1 class="p-bar__title" tabindex="-1" data-fk="h1">${t('newProject.title')}</h1>
        <span class="wz-bar__end">${menu ? `<button type="button" class="icon-btn wz-more" data-act="menu" data-fk="menu" aria-haspopup="menu" aria-expanded="${S.menu}" aria-controls="${uid}-menu" aria-label="${t('common.more')}"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/></svg></button>
          <div class="wz-menu" id="${uid}-menu" role="menu"${S.menu ? '' : ' hidden'}><button type="button" role="menuitem" class="wz-menu__item" data-act="cancel" data-fk="menu-cancel">${t('newProject.cancel.action')}</button></div>` : ''}</span></header>`;
    }
    function screenHTML() {
      const s = step();
      if (s === -1) return entryScreen(S.screen === 'entryEmpty');
      if (s === null) return pageState();
      const body = [ideaScreen, repoScreen, interviewScreen, kickoffScreen, envScreen, startScreen][s]();
      return wizard(body);
    }
    function render(opts = {}) {
      const active = host.contains(document.activeElement) && !$('[data-slot=asheet]').contains(document.activeElement) ? document.activeElement.dataset.fk : null;
      bar();
      if (kind === 'mac') {
        const inWizard = SCREENS[S.screen] !== -1;
        $('[data-slot=nav-all]').setAttribute('aria-current', String(!inWizard));
        $('[data-slot=nav-new]').toggleAttribute('aria-current', inWizard);
        if (inWizard) $('[data-slot=nav-new]').setAttribute('aria-current', 'page');
        $('[data-slot=main-region]').setAttribute('aria-label', plain(t(inWizard ? 'newProject.title' : 'overview.title')));
      }
      $('[data-slot=screen]').innerHTML = screenHTML();
      const f = opts.focus || active;
      const target = f ? host.querySelector(`[data-slot=screen] [data-fk="${CSS.escape(f)}"], [data-slot=bar] [data-fk="${CSS.escape(f)}"]`) : null;
      if (target && !S.sheet) {
        target.focus({ preventScroll: !opts.focus });
        if (opts.focus && opts.top) host.querySelector('[data-scroll]').scrollTop = 0;
      } else if (opts.top) host.querySelector('[data-scroll]').scrollTop = 0;
      // step change: the content settles in (no slide under reduced motion); the stepper's ink advances
      const cur = step();
      if (opts.animate !== false && S.lastStep !== cur && cur !== null && cur >= 0) {
        const main = host.querySelector('[data-wz-main]');
        if (main) play(main, isReduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: ms(isReduced() ? '--dur-fade' : '--dur-base'), easing: cssVar('--ease-enter') });
        const seg = host.querySelector('.wz-mini .wz-seg i.is-cur, .wz-step--current .wz-step__mark');
        if (seg && !isReduced() && S.lastStep !== null && cur > S.lastStep) play(seg, [{ transform: 'scale(.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: ms('--dur-base'), easing: cssVar('--ease-emph') });
      }
      S.lastStep = cur;
      if (S.screen === 'started' && S.stampNow) { S.stampNow = false; stamp($('.launch-stamp')); }
      S.inkQ = false; S.inkTopic = null; S.inkReceipt = false;
    }

    /* ----- the live region: one polite region, coalesced to one announcement per 10 s (latest wins) ----- */
    let lastSaid = 0; let pending = null; let liveTimer;
    function announce(txt, now) {
      const say = (s) => { const l = $('[data-slot=live]'); l.textContent = ''; setTimeout(() => { l.textContent = s; }, 30); lastSaid = Date.now(); };
      const gap = Date.now() - lastSaid;
      if (now || gap > 10000) { clearTimeout(liveTimer); pending = null; say(txt); return; }
      pending = txt; clearTimeout(liveTimer);
      liveTimer = setTimeout(() => { if (pending) say(pending); pending = null; }, 10000 - gap);
    }
    let toastTimer;
    function toast(txt) {
      const el = $('[data-slot=toast]'); el.textContent = txt; el.hidden = false;
      play(el, isReduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: ms(isReduced() ? '--dur-fade' : '--dur-base'), easing: cssVar('--ease-enter') });
      clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms('--dur-toast'));
    }
    // Signature moment: the «Запущено» stamp presses onto the page, its rings and tick draw in. Reduced: a plain fade.
    function stamp(s) {
      if (!s || !s.getClientRects().length) return; // a hidden frame (the other device view) has nothing to draw
      if (isReduced()) { play(s, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade'), fill: 'both' }); return; }
      const strokes = [...s.querySelectorAll('circle,path')];
      strokes.forEach((p) => { const l = p.getTotalLength(); p.style.strokeDasharray = l; p.style.strokeDashoffset = l; });
      play(s, [{ opacity: 0, transform: 'rotate(-24deg) scale(1.5)' }, { opacity: 1, transform: 'rotate(-9deg) scale(1)' }], { duration: ms('--dur-base'), easing: cssVar('--ease-emph'), fill: 'both' });
      play(s.querySelector('span'), [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-base'), delay: ms('--dur-fast'), fill: 'both' });
      strokes.forEach((p, i) => play(p, [{ strokeDashoffset: p.style.strokeDashoffset }, { strokeDashoffset: 0 }], { duration: ms('--dur-sig') * 0.6, delay: i * ms('--stagger'), easing: cssVar('--ease-emph'), fill: 'forwards' }));
    }

    /* ----- moving through the flow ----- */
    function go(screen, focus = 'h2', extra = {}) {
      S.gen += 1; S.screen = screen; S.menu = false; S.allSteps = false; S.repoRows = null; S.kickRows = null;
      Object.assign(S, extra);
      render({ focus: kind === 'mac' && focus === 'h1' ? 'h1' : focus, top: true });
    }
    async function animateRows(key, from, total, steps, done) {
      const g = S.gen;
      for (const [i, st] of steps) {
        await wait(isReduced() ? 260 : 620);
        if (S.gen !== g) return;
        S[key][i] = { state: st, fresh: true };
        if (key === 'kickRows' && st === 'done') announce(plain(t('newProject.kickoff.live', { row: plain(kickRows(S.kickRows)[i].title), state: t('newProject.row.done') })));
        render({ animate: false });
      }
      if (S.gen === g && done) done();
    }
    function createRepo() {
      go('repoCreating', 'h2');
      S.repoRows = [{ state: 'running' }, 'waiting', 'waiting', 'waiting'].map((r) => (typeof r === 'string' ? { state: r } : r));
      render({ animate: false });
      announce(plain(t('newProject.repo.creating')), true);
      animateRows('repoRows', 0, 4, [[0, 'done'], [1, 'running'], [1, 'done'], [2, 'needs'], [3, 'running'], [3, 'done']], () => {
        const rows = S.repoRows; go('repoDone', 'h2'); S.repoRows = rows.map((r) => ({ state: r.state })); render({ animate: false });
        announce(plain(t('newProject.repo.done')), true);
      });
    }
    function runKickoff(fromState) {
      const start = fromState || KICK.map(() => ({ state: 'waiting' }));
      go('kRunning', 'h2');
      S.kickRows = start.map((r) => ({ state: r.state === 'done' ? 'done' : 'waiting' }));
      const first = S.kickRows.findIndex((r) => r.state !== 'done');
      S.kickRows[first] = { state: 'running' };
      render({ animate: false });
      const seq = [];
      for (let i = first; i < KICK.length; i += 1) { seq.push([i, 'done']); if (i + 1 < KICK.length) seq.push([i + 1, 'running']); }
      animateRows('kickRows', first, KICK.length, seq, () => { go('kDone', 'h2'); announce(plain(t('newProject.kickoff.done')), true); });
    }
    async function think(next, extra = {}) {
      const g = S.gen + 1;
      go('iqWait', 'wait', { answering: false, answer: '', answerErr: false, correction: null, inkReceipt: true, ...extra });
      await wait(isReduced() ? 900 : 1600);
      if (S.gen !== g) return;
      const stillHere = !host.contains(document.activeElement) || document.activeElement.dataset.fk === 'wait' || document.activeElement === document.body;
      if (next === 'brief' || next === 'briefV2') {
        S.screen = next; S.histOpen = false;
        render({ focus: stillHere ? 'brief-h' : null, animate: false });
        announce(plain(t('newProject.interview.briefReady')), true);
      } else {
        S.screen = 'iq'; S.inkQ = true; S.inkTopic = QUESTIONS[S.q - 1] ? QUESTIONS[S.q - 1].topic : null;
        render({ focus: stillHere ? 'q' : null, animate: false });
        announce(plain(t('newProject.interview.newQuestion')), true);
      }
    }
    function answer(kindA, text) {
      const q = QUESTIONS[S.q];
      if (S.correction) { const src = [...HISTORY, ...QUESTIONS].find((h) => h.n === S.correction); S.answers.push({ n: src.n, q: src.q, kind: 'own', text }); think('iq'); return; }
      S.answers.push({ n: q.n, q: q.q, kind: kindA, text });
      S.q += 1;
      think(S.q >= QUESTIONS.length ? 'brief' : 'iq');
    }

    /* ----- events ----- */
    host.onclick = (e) => {
      const el = e.target.closest('[data-act]'); if (!el || !host.contains(el)) return;
      const act = el.dataset.act;
      if (act === 'ext') { e.preventDefault(); toast(plain(t('demo.ext'))); return; }
      if (el.tagName === 'A') e.preventDefault();
      if (el.getAttribute('aria-disabled') === 'true') return;
      switch (act) {
        case 'toNew': go('idea', 'h2', { idea: '', ideaErr: false }); break;
        case 'continue': go('iq', 'h2', { q: 0, answers: [] }); break;
        case 'toAll': go('entry', 'h1'); break;
        case 'addProject': toast('#194 · ' + plain(t('overview.addProject'))); break;
        case 'space': toast(plain(t('demo.space'))); break;
        case 'go': go(el.dataset.go, 'h2'); break;
        case 'allSteps': S.allSteps = !S.allSteps; render({ focus: 'allSteps', animate: false }); break;
        case 'menu': S.menu = !S.menu; bar(); $(S.menu ? '[data-fk=menu-cancel]' : '[data-fk=menu]').focus(); break;
        case 'cancel': S.sheetBase = S.screen; openSheet('cancel', kind === 'phone' ? 'menu' : 'cancel'); break;
        case 'connect': go('idea', 'h2'); toast(plain(t('newProject.connect.action')) + ' ✓'); break;
        case 'ideaNext': {
          const v = (host.querySelector('[data-field=idea]') || {}).value || '';
          S.idea = v;
          if ([...v.trim()].length < 20) { S.ideaErr = true; render({ focus: 'idea', animate: false }); return; }
          S.ideaErr = false; go('repoEmpty', 'h2', { name: '', nameState: 'empty', nameTouched: false });
          break;
        }
        case 'checkNow': announce(plain(t('newProject.repo.checkedLive')), true); toast(plain(t('newProject.repo.checkedLive'))); break;
        case 'repoRetry': case 'refusedRetry': {
          const sc = S.screen; go(sc, 'h2');
          S.repoRows = (sc === 'repoFailed' ? ['done', 'running', 'waiting', 'waiting'] : ['done', 'done', 'needs', 'running']).map((s) => ({ state: s }));
          render({ focus: act, animate: false });
          animateRows('repoRows', 0, 4, sc === 'repoFailed' ? [[1, 'done'], [2, 'needs'], [3, 'running'], [3, 'done']] : [[3, 'done']], () => { go('repoDone', 'h2'); announce(plain(t('newProject.repo.done')), true); });
          break;
        }
        case 'repoNext': go('iStart', 'h2'); break;
        case 'startInterview': S.q = 0; S.answers = []; think('iq', { inkReceipt: false, firstTurn: true }); break;
        case 'accept': answer('accepted', plain(t(QUESTIONS[S.q].rec))); break;
        case 'opt': answer('own', plain(t(el.dataset.o))); break;
        case 'other': S.answering = true; S.correction = null; S.screen = S.screen === 'iqOutsider' ? 'iq' : S.screen; render({ focus: 'answer', animate: false }); break;
        case 'change': S.answering = true; S.correction = Number(el.dataset.n); S.answer = ''; if (S.screen !== 'iq') S.screen = 'iq'; render({ focus: 'answer', animate: false }); break;
        case 'answerCancel': { const back = S.correction ? `change-${S.correction}` : 'other'; S.answering = false; S.correction = null; S.answerErr = false; render({ focus: back, animate: false }); break; }
        case 'send': {
          const v = ((host.querySelector('[data-field=answer]') || {}).value || '').trim();
          if (!v) { S.answerErr = true; render({ focus: 'answer', animate: false }); return; }
          answer('own', v); break;
        }
        case 'hist': S.histOpen = !S.histOpen; render({ focus: 'hist', animate: false }); break;
        case 'enough': S.enough = true; S.q = QUESTIONS.length; think('brief'); break;
        case 'wake': think('iq'); break;
        case 'briefConfirm': S.briefConfirmed = true; S.briefV = S.screen === 'briefV2' ? 2 : S.briefV; go('kReady', 'h2', { inkReceipt: true }); break;
        case 'briefChange': S.fixBase = S.screen; S.screen = 'briefFix'; S.fix = ''; render({ focus: 'fix', animate: false }); break;
        case 'fixCancel': S.screen = S.fixBase || 'brief'; S.fixErr = false; render({ focus: 'briefChange', animate: false }); break;
        case 'fixSend': {
          const v = ((host.querySelector('[data-field=fix]') || {}).value || '').trim();
          if (!v) { S.fixErr = true; render({ focus: 'fix', animate: false }); return; }
          S.briefV = 2; think('briefV2', { answers: [...S.answers, { n: 7, q: 'newProject.brief.fixLabel', kind: 'own', text: v }] }); break;
        }
        case 'viewBrief': S.briefOpen = !S.briefOpen; render({ focus: 'viewBrief', animate: false }); break;
        case 'kStart': openSheet('kickoff', 'kStart'); break;
        case 'kContinue': runKickoff(S.screen === 'kFailed' ? ['done', 'done', 'done', 'waiting', 'waiting', 'waiting', 'waiting'].map((s) => ({ state: s })) : null); break;
        case 'kNext': go('env', 'h2'); break;
        case 'envOpen': toast(plain(t('demo.envSetup'))); break;
        case 'envCheck': announce(plain(t('newProject.env.checkedLive')), true); toast(plain(t('newProject.env.checkedLive'))); break;
        case 'envSkip': case 'envNext': go('start', 'h2'); break;
        case 'startTeam': openSheet('start', el.dataset.fk); break;
        case 'openProject': case 'runNow': toast(plain(t('demo.space'))); break;
        case 'sheetClose': closeSheet(); break;
        case 'sheetOk': {
          const k = S.sheet; closeSheet('h2');
          if (k === 'repo') { if (S.linkPath) go('repoLink', 'h2'); else createRepo(); }
          if (k === 'kickoff') runKickoff();
          if (k === 'start') { go('started', 'h2', { stampNow: true }); announce(plain(t('newProject.start.done', { name: S.name || NAME })), true); }
          if (k === 'cancel') { S.noDraft = true; go('entry', 'h1'); toast(plain(t('newProject.cancel.done'))); }
          break;
        }
        default: break;
      }
    };
    let nameTimer;
    host.oninput = (e) => {
      const f = e.target.dataset.field;
      if (f === 'idea') {
        S.idea = e.target.value; const c = $('[data-count]'); if (c) c.innerHTML = t('newProject.idea.count', { n: [...S.idea].length });
        if (S.ideaErr && [...S.idea.trim()].length >= 20) { S.ideaErr = false; render({ animate: false }); }
      }
      if (f === 'answer') S.answer = e.target.value;
      if (f === 'fix') S.fix = e.target.value;
      if (f === 'desc') S.desc = e.target.value;
      if (f === 'vis') { S.vis = e.target.value; render({ animate: false }); host.querySelector(`input[data-field=vis][value=${S.vis}]`).focus(); }
      if (f === 'name') {
        S.name = e.target.value.trim(); S.nameTouched = true;
        clearTimeout(nameTimer);
        const v = S.name;
        const setState = (st) => {
          S.nameState = st;
          const err = nameError(); const ne = $('[data-nerr]'); const ns = $('[data-nstat]'); const input = $('[data-field=name]');
          ne.hidden = !err; ne.querySelector('span').innerHTML = err; ns.innerHTML = nameStatus();
          input.toggleAttribute('aria-invalid', !!err); if (err) input.setAttribute('aria-invalid', 'true');
          input.setAttribute('aria-describedby', [`${uid}-rules`, `${uid}-nstat`, err ? `${uid}-nerr` : ''].filter(Boolean).join(' '));
          input.closest('.wz-prefix').classList.toggle('is-bad', !!err);
          const plan = host.querySelector('.wz-plan li'); if (plan) plan.innerHTML = t('newProject.repo.planRepo', { repo: repo() });
        };
        if (!v) { setState('empty'); return; }
        if (!NAME_RE.test(v) || v === '.' || v === '..') { setState('invalid'); return; }
        setState('checking');
        nameTimer = setTimeout(() => setState(TAKEN.includes(v.toLowerCase()) ? 'taken' : 'ok'), 600);
      }
    };
    host.onsubmit = (e) => {
      e.preventDefault();
      if (offline()) return;
      S.nameTouched = true;
      if (!S.name) S.nameState = 'empty';
      if (S.nameState !== 'ok') { render({ focus: 'name', animate: false }); return; }
      openSheet('repo', 'create');
    };
    host.onkeydown = (e) => {
      if (S.sheet) {
        if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
        if (e.key === 'Tab') {
          const f = [...host.querySelectorAll('.asheet__panel button:not([aria-disabled=true])')];
          const i = f.indexOf(document.activeElement);
          if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
        }
        return;
      }
      if (S.menu && e.key === 'Escape') { S.menu = false; bar(); $('[data-fk=menu]').focus(); return; }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        const f = e.target.dataset && e.target.dataset.field;
        if (f === 'answer') { e.preventDefault(); host.querySelector('[data-act=send]').click(); }
        if (f === 'fix') { e.preventDefault(); host.querySelector('[data-act=fixSend]').click(); }
      }
    };

    /* ----- demo entry points ----- */
    const PRESET = {
      entry: { noDraft: false }, ideaFilled: { idea: plain(t('mock.idea')) }, ideaShort: { idea: 'Шахматы', ideaErr: true }, idea: { idea: '' },
      repo: { name: NAME, nameState: 'ok' }, repoEmpty: { name: '', nameState: 'empty', nameTouched: false }, repoTaken: { name: 'team-console', nameState: 'taken', nameTouched: true },
      iq: { q: 0, answers: [], answering: false }, iqOther: { q: 0, answers: [], answering: true }, iqOutsider: { q: 0, answers: [], answering: false },
      offline: { q: 0, answers: [], answering: false }, iqWait: { q: 1, answers: [{ n: 4, q: 'mock.q.mvp', kind: 'own', text: plain(t('mock.my.mvp')) }] },
      brief: { briefV: 1 }, briefFix: { briefV: 1, fixBase: 'brief' }, briefV2: { briefV: 2 },
    };
    const app = {
      render, S,
      go: (screen) => {
        if (S.sheet) closeSheet();
        S.gen += 1; S.answering = false; S.briefOpen = false; S.histOpen = false; S.lastStep = null;
        if (screen === 'ideaShort') S.idea = L.lang === 'ru' ? 'Шахматы на телефоне' : 'Chess on a phone';
        if (SCREENS[screen] > 2) S.briefConfirmed = true; else if (SCREENS[screen] !== undefined) S.briefConfirmed = false;
        if (SCREENS[screen] >= 1 && !S.name) S.name = NAME;
        const preset = PRESET[screen] || {};
        if (SHEETS[screen]) {
          const [base, sk] = SHEETS[screen];
          Object.assign(S, PRESET[base] || {});
          if (base === 'repoEmpty') S.name = '';
          S.screen = base; render({ focus: 'h2', top: true }); S.sheetBase = base;
          openSheet(sk, sk === 'cancel' ? (kind === 'phone' ? 'menu' : 'cancel') : base === 'repo' ? 'create' : base === 'kReady' ? 'kStart' : 'startTeam');
          return;
        }
        Object.assign(S, preset);
        if (screen === 'ideaShort') S.idea = L.lang === 'ru' ? 'Шахматы на телефоне' : 'Chess on a phone';
        S.screen = screen;
        render({ focus: SCREENS[screen] === -1 ? 'h1' : screen === 'iqOther' ? 'answer' : screen === 'briefFix' ? 'fix' : 'h2', top: true });
        if (screen === 'started') stamp($('.launch-stamp'));
      },
      returned: () => { if (S.screen === 'repoLink') { S.linkPath = false; createRepo(); } },
    };
    host.app = app;
    render();
    return app;
  }

  /* ---------- page controls ---------- */
  const mountAll = (keep) => hosts.forEach((h) => { const prev = keep && h.S ? h.S : null; h.className = 'app'; mountApp(h, h.dataset.app, prev); });
  // optgroup labels are attributes, which the shared page chrome does not translate
  const labelGroups = () => document.querySelectorAll('[data-i18n-label]').forEach((g) => { g.label = plain(t(g.dataset.i18nLabel)); });
  const pageChrome = Proto.page({ L, title: 'Team Console · #238', onLang: () => { labelGroups(); mountAll(true); } });
  labelGroups();
  const sel = document.getElementById('d-screen');
  sel.addEventListener('change', (e) => { const v = e.target.value; if (!v) return; hosts.forEach((h) => h.app.go(v)); });
  document.getElementById('d-link').addEventListener('change', (e) => hosts.forEach((h) => { h.S.linkPath = e.target.checked; }));
  document.getElementById('d-return').addEventListener('click', () => hosts.forEach((h) => h.app.returned()));
  document.querySelector('[data-reset]').addEventListener('click', () => { sel.value = ''; document.getElementById('d-link').checked = false; mountAll(false); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') hosts.forEach((h) => h.app.returned()); });
  mountAll(false);
  pageChrome.fit();
  window.__demo = { hosts, mountAll };
})();
