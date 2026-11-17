/* #759 Actions onboarding. Design prototype runtime with mock data only; the real page reads
   GET …/actions-setup (names and states only, never a secret value) and GET …/actions-setup/workflow for the file.
   Three places: the project setup page's sibling rows, the /settings/projects/:slug/actions checklist, and Runners ›
   "Where jobs run" with its readiness line. Two independent instances (iPhone, Mac) share the demo controls and the
   repository's state. */
(() => {
  'use strict';
  const { isReduced, wait, esc, plain, I, dots } = Proto;
  const L = Proto.i18n(I18N);
  const { t, hhmm } = L;
  const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const IX = {
    ...I,
    pr: svg('<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="18.5" r="2"/><path d="M6.5 7.5v9M17.5 16.5V10a3 3 0 00-3-3H11"/><path d="M13 4.5L10.5 7 13 9.5"/>'),
    server: svg('<rect x="4" y="4.5" width="16" height="6" rx="1.5"/><rect x="4" y="13.5" width="16" height="6" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01"/>'),
    up: svg('<path d="M12 18.5v-13M6.5 11L12 5.5l5.5 5.5"/>'),
  };
  const P = { slug: 'storify', name: 'storify', repo: 'geeera/storify', branch: 'main', app: 'team-console' };
  const PROJECTS = [P, { slug: 'team-console', name: 'team-console' }];
  const GH = `https://github.com/${P.repo}`;
  const VERSION = '0.42.0'; const OLD = '0.39.1'; const SHA = '3f9c2a71be04';
  const PINS = [['runner', OLD, VERSION], ['node', '22.11.0', '22.12.0'], ['claude-code', '2.4.0', '2.6.1']];
  const PATH = '.github/workflows/team-console-runner.yml';
  const YML = `<span class="c"># Team Console runner ${VERSION} · rendered by the console, do not edit</span>
<span class="k">name:</span> Team Console runner
<span class="k">on:</span>
  <span class="k">workflow_dispatch:</span>
    <span class="k">inputs:</span>
      <span class="k">job:</span> { required: true, type: string }
<span class="k">permissions:</span>
  <span class="k">id-token:</span> write
  <span class="k">contents:</span> read
<span class="k">jobs:</span>
  <span class="k">run:</span>
    <span class="k">runs-on:</span> ubuntu-latest
    <span class="k">environment:</span> team-console
    <span class="k">timeout-minutes:</span> 90
    <span class="k">steps:</span>
      - <span class="k">name:</span> Download and verify the runner ${VERSION}
        <span class="k">run:</span> |
          gh release download v${VERSION} -R geeera/team-console -p 'runner-*.tgz'
          gh attestation verify runner-*.tgz -R geeera/team-console
        <span class="k">env:</span> { GH_TOKEN: \${{ github.token }} }
      - <span class="k">name:</span> Run the job
        <span class="k">run:</span> npx --yes ./runner-*.tgz run --job "\${{ inputs.job }}"
        <span class="k">env:</span>
          <span class="k">TC_CONSOLE_URL:</span> https://console.example.dev
          <span class="k">TC_CONSOLE_AUDIENCE:</span> team-console-runner
          <span class="k">TC_INFERENCE_API_KEY:</span> \${{ secrets.TC_INFERENCE_API_KEY }}`;

  /* ---------- shared state: one repository, both frames read it ---------- */
  const minsAgo = (m) => new Date(Date.now() - m * 60000);
  const fresh0 = () => ({
    access: 'api_key', perms: 'ok', unverified: false,
    env: { environment: 'ok', branch: 'ok', rules: 'ok', secret: 'missing' },
    wf: 'missing', pr: null, prOff: false, prErr: null,
    dispatch: 'pull', run: null, switchErr: false,
    call: 'ok', customer: false, setupApp: false, slow: false,
    checking: false, busy: null, checkedAt: minsAgo(2), rateUntil: new Date(Date.now() + 6 * 60000), offlineAt: minsAgo(18),
    next: 'same', copyFail: false, stamp: false, stampNow: false,
    rsel: 'pull', rready: null, rrefused: false, rowCall: 'ok',
  });
  const D = fresh0();
  const isOffline = () => D.call === 'offline';
  const noData = () => ['loading', 'github', 'error', 'offline0'].includes(D.call);

  // Readiness per step, as the DTO's items fold into the six steps of the spec (§2).
  function envSubs() {
    if (D.env.environment === 'missing') return [['environment', 'missing']];
    const secret = D.perms !== 'ok' ? 'unknown' : D.env.secret;
    return [['environment', 'ok'], ['branch', D.env.branch], ['rules', D.env.rules === 'ok' ? 'ok' : 'warn'], ['secret', secret]];
  }
  function stepState(k) {
    if (k === 'access') return D.access === 'api_key' ? 'done' : 'missing';
    if (k === 'perm') return D.perms === 'ok' && !D.unverified ? 'done' : 'missing';
    if (k === 'env') {
      const subs = envSubs();
      if (subs.some(([, s]) => s === 'missing' || s === 'wrong')) return 'missing';
      if (subs.some(([, s]) => s === 'unknown')) return 'skipped';
      return 'done';
    }
    if (k === 'wf') {
      if (D.wf === 'ok') return 'done';
      if (D.wf === 'outdated') return 'outdated';
      return 'missing';
    }
    if (k === 'switch') return D.dispatch === 'actions' ? 'on' : 'off';
    if (k === 'run') return { waiting: 'waiting', done: 'done', failed: 'failed' }[D.run] || 'waiting';
    return 'done';
  }
  const PREP = ['access', 'perm', 'env', 'wf'];
  const blocking = () => PREP.filter((k) => ['missing', 'skipped'].includes(stepState(k)));
  const isReady = () => !blocking().length;
  // Failed item ids for the actions-not-ready refusal, in the DTO's vocabulary.
  function failedItems() {
    const out = [];
    if (D.access !== 'api_key') out.push('access-source');
    if (D.perms !== 'ok') out.push('app-permissions');
    for (const [id, s] of envSubs()) if (s === 'missing' || s === 'wrong') out.push({ environment: 'environment', branch: 'branch-policy', secret: 'secret' }[id]);
    if (!['ok', 'outdated'].includes(D.wf)) out.push('workflow');
    return out;
  }

  const hosts = [...document.querySelectorAll('[data-app]')];
  let pageChrome = null;

  /* ---------- one app instance ---------- */
  function mountApp(host, kind, keep) {
    const S = keep || { route: 'actions', how: {}, file: false, pins: false, why: false, fromRunners: false, anim: null, copyFailKey: null };
    host.S = S;
    const uid = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const $ = (s) => host.querySelector(s);
    const mac = kind === 'mac';

    host.innerHTML = mac ? `<div class="win">
        <div class="win__bar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="win__title">Team Console</span></div>
        <div class="win__body">
          <nav class="sidebar" aria-label="${t('nav.aria')}">
            <div class="brand">${IX.mark}<span>Team Console</span></div>
            <ul class="side-list side-list--top">
              <li><button type="button" class="side-item" data-act="space">${IX.inbox}<span>${t('nav.needs')}</span></button></li>
              <li><button type="button" class="side-item" data-act="go-setup" data-nav="all">${IX.grid}<span>${t('nav.all')}</span></button></li>
            </ul>
            <div class="side-label">${t('nav.projects')}</div>
            <ul class="side-list">${PROJECTS.map((p) => `<li><button type="button" class="side-item" data-act="space"><span class="prod-mono" aria-hidden="true">${esc(p.slug[0])}</span><span class="side-prod__label">${esc(p.name)}</span></button></li>`).join('')}</ul>
            <div class="side-foot">
              <button type="button" class="side-item side-item--settings" data-act="go-runners" data-nav="settings">${IX.gear}<span>${t('nav.settings')}</span></button>
              <div class="side-foot__row"><span class="avatar avatar--owner" aria-hidden="true">K</span><span>${t('shell.owner')}</span></div>
            </div>
          </nav>
          <section class="set-main" aria-label="${t('nav.settings')}">
            <header class="convo__head"><nav class="crumbs" aria-label="${t('nav.crumbs')}" data-slot="crumbs"></nav></header>
            <div class="env-body" data-slot="body"></div>
          </section>
        </div>
      </div>
      <div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`
      : `<div class="p-status" aria-hidden="true"><span>9:41</span><span class="p-island"></span><span class="p-status__icons">${IX.bars}${IX.battery}</span></div>
      <div data-slot="phead"></div>
      <main class="p-scroll" data-slot="scroll"><div class="set-inner" data-slot="screen"></div></main>
      <div class="home-ind" aria-hidden="true"></div>
      <div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`;

    /* ----- markup pieces ----- */
    const dis = (on, reasonId) => (on ? ` aria-disabled="true"${reasonId ? ` aria-describedby="${reasonId}"` : ''}` : '');
    const code = (s) => `<code>${esc(s)}</code>`;
    const V = () => ({ repo: P.repo, project: P.name, app: P.app, n: blocking().length, version: VERSION, old: OLD, new: VERSION });
    // Fixed strings go in <code>: t() escapes vars, so the code wrapper is put in after.
    const tc = (key, vars = {}) => t(key, { ...V(), ...vars, branch: '\u0001' }).replace(/\u0001/g, esc(P.branch));
    function codeline(value, key, aria) {
      const fail = S.copyFailKey === key ? `<p class="copy-fail" role="status">${t('common.copyFailed')}</p>` : '';
      return `<div class="codeline"><code>${esc(value)}</code><button type="button" class="btn btn--sm" data-act="copy" data-value="${esc(value)}" data-key="${esc(key)}" data-fk="copy-${esc(key)}" aria-label="${esc(aria || plain(t('actions.env.copyAria', { value })))}">${IX.copy}<span aria-hidden="true">${t('common.copy')}</span></button></div>${fail}`;
    }
    const ghLink = (href, label, fk, cls = 'act-ext') => `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-act="gh"${fk ? ` data-fk="${fk}"` : ''}><span>${label}</span><span class="sr-only"> ${t('common.external')}</span>${IX.ext}</a>`;
    const ghBtn = (href, label, fk, primary) => ghLink(href, label, fk, `btn btn--tall${primary ? ' btn--primary' : ''}`);
    const inLink = (act, label, fk) => `<a class="how__link" href="#" data-act="${act}" data-fk="${fk}">${label}${IX.chev}</a>`;
    const btn = (act, label, fk, { primary, off, reason, busy } = {}) => `<button type="button" class="btn btn--tall${primary ? ' btn--primary' : ''}" data-act="${act}" data-fk="${fk}"${dis(off || busy, reason)}>${busy ? dots : ''}${label}</button>`;
    const mono = (slug) => `<span class="prod-mono" aria-hidden="true">${esc(slug[0])}</span>`;
    const stampSVG = '<div class="stamp" aria-hidden="true"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="28"/><circle class="stamp__inner" cx="32" cy="32" r="23"/><path d="M21 33l8 8 15-17"/></svg></div>';
    function disclosure(key, label, body, { openDefault = false } = {}) {
      const id = `${uid}-how-${key}`; const open = S.how[key] ?? openDefault;
      return `<button type="button" class="btn btn--quiet btn--sm how-btn" data-act="how" data-key="${key}" data-open="${open}" aria-expanded="${open}" aria-controls="${id}" data-fk="how-${key}">${label}${IX.down}</button>
        <div class="how" id="${id}"${open ? '' : ' hidden'}>${body}</div>`;
    }
    const offReason = () => (isOffline() ? t('actions.err.offlineWhy') : '');

    /* ----- the steps ----- */
    const MARK = { done: IX.check, missing: IX.bang, outdated: IX.up, skipped: IX.q, waiting: IX.clock, on: IX.play, off: null, failed: IX.x };
    const WORD = { done: 'step.done', missing: 'step.missing', outdated: 'actions.st.outdated', skipped: 'step.skipped', waiting: 'step.waiting', on: 'actions.row.chip.on', off: 'actions.row.chip.off', failed: 'actions.st.failed' };
    const firstOpen = () => PREP.find((k) => ['missing', 'skipped'].includes(stepState(k)));
    function step(i, k, title, inner, { st, cls = '' } = {}) {
      const loading = noData();
      const s = loading ? 'loading' : st || stepState(k);
      const mark = loading || !MARK[s] ? String(i + 1) : MARK[s];
      const word = loading ? '' : `<span class="step__state">${t(WORD[s])}</span>`;
      const first = !loading && k === firstOpen() ? ' is-first' : '';
      const isNew = D.fresh && D.fresh.includes(k) ? ` is-new" style="--i:${D.fresh.indexOf(k)}` : '';
      return `<li class="step step--${s === 'off' ? 'waiting' : s}${first}${cls}${isNew}" data-step="${k}"><span class="step__mark" aria-hidden="true">${mark}</span>
        <div class="step__body"><div class="step__head"><h3 class="step__title" tabindex="-1" data-fk="step-${k}"><span class="sr-only">${i + 1}. </span>${title}</h3>${word}</div>${loading ? '' : inner}</div></li>`;
    }

    function accessStep(i) {
      const s = stepState('access');
      const inner = s === 'done' ? `<p class="step__fix">${t('actions.access.done')}</p>`
        : `<p class="step__fix">${t('actions.access.missing')}</p>${disclosure('access', t('step.how'), `<p>${t('actions.access.how')}</p>${inLink('space', t('actions.access.link'), 'access-link')}`, { openDefault: firstOpen() === 'access' })}`;
      return step(i, 'access', t('actions.access.title'), inner);
    }
    function permStep(i) {
      const s = stepState('perm');
      const title = D.setupApp ? t('actions.perm.titleSetupApp') : t('actions.perm.title');
      const install = `${GH.replace(P.repo, 'settings')}/installations/58120437`;
      let inner;
      if (D.unverified) inner = `<p class="step__fix">${t('actions.perm.unverified')}</p><div class="act-row">${ghBtn(install, t('actions.perm.unverifiedLink'), 'perm-link', true)}</div>`;
      else if (s === 'done') inner = `<p class="step__fix">${t('actions.perm.done', V())}</p>`;
      else if (D.setupApp) inner = `<p class="step__fix">${t('actions.perm.missingSetupApp', V())}</p><div class="act-row">${ghBtn(`https://github.com/apps/${P.app}-setup/installations/new`, t('actions.perm.linkSetupApp'), 'perm-link', true)}</div>`;
      else inner = `<p class="step__fix">${t('actions.perm.missing', V())}</p>${disclosure('perm', t('step.how'), `<p>${t('actions.perm.how')}</p>${ghLink(install, t('actions.perm.link'), 'perm-link')}`, { openDefault: firstOpen() === 'perm' })}`;
      const why = `<ul class="why"><li>${tc('actions.perm.why.contents')}</li><li>${tc('actions.perm.why.workflows')}</li><li>${tc('actions.perm.why.environments')}</li>
        <li class="how__note"><span>${tc('actions.perm.why.ruleset')}<br>${ghLink(`${GH}/settings/rules`, t('actions.perm.why.rulesetLink'), 'ruleset-link')}</span></li></ul>`;
      return step(i, 'perm', title, inner + disclosure('why', t('actions.perm.why'), why));
    }
    function envStep(i) {
      const subs = envSubs();
      const SUBKEY = { environment: 'environment', branch: 'branch', rules: 'rules', secret: 'secret' };
      const word = { ok: 'ok', missing: 'missing', wrong: 'wrong', warn: 'warn', unknown: 'unknown' };
      const icon = { ok: IX.check, missing: IX.bang, wrong: IX.bang, warn: IX.warn, unknown: IX.q };
      const textKey = (id, s) => `actions.env.${SUBKEY[id]}.${s === 'warn' ? 'wrong' : s === 'unknown' ? 'unknown' : s === 'ok' ? 'ok' : id === 'branch' ? 'wrong' : 'missing'}`;
      const list = `<ul class="subs">${subs.map(([id, s]) => `<li class="sub sub--${s}"><span class="sub__ico" aria-hidden="true">${icon[s]}</span><span class="sub__txt"><span class="sub__word">${t(`actions.sub.${word[s]}`)}</span>${tc(textKey(id, s))}</span></li>`).join('')}</ul>`;
      const missingEnv = D.env.environment === 'missing';
      const link = missingEnv ? ghLink(`${GH}/settings/environments/new`, t('actions.env.linkNew'), 'env-link') : ghLink(`${GH}/settings/environments/2210934/edit`, t('actions.env.linkEdit'), 'env-link');
      const done = stepState('env') === 'done';
      const how = `<ol class="act-how">
          <li><p>${t('actions.env.how.1')}</p>${link}</li>
          <li><p>${t('actions.env.how.2')}</p>${codeline('team-console', 'env-name')}</li>
          <li><p>${tc('actions.env.how.3')}</p>${codeline(P.branch, 'env-branch')}</li>
          <li><p>${t('actions.env.how.4')}</p></li>
          <li><p>${t('actions.env.how.5')}</p>${codeline('TC_INFERENCE_API_KEY', 'env-secret')}</li></ol>
        <p class="how__note how__note--key">${IX.lock}<span>${t('actions.env.keyNote')}</span></p>
        <p class="how__note">${IX.minus}<span>${t('actions.env.noVars')}</span></p>
        <p class="how__note">${IX.sliders}<span>${t('actions.env.limit')}</span></p>`;
      const inner = `${list}${done ? '' : `<div class="act-row">${link}</div>`}${disclosure('env', t('step.how'), how, { openDefault: firstOpen() === 'env' })}`;
      return step(i, 'env', t('actions.env.title'), inner);
    }
    function prSlip(kind) {
      const n = D.pr.n; const foreign = kind === 'foreign';
      return `<div class="prslip${foreign ? ' prslip--foreign' : kind === 'leftover' || kind === 'stale' ? ' prslip--quiet' : ''}"><span class="prslip__mark" aria-hidden="true">${foreign ? IX.warn : IX.pr}</span>
        <span class="prslip__txt"><span class="prslip__title">#${n} · ${esc(kind === 'stale' ? `Update the Team Console runner to ${OLD}` : 'Add the Team Console runner workflow')}</span><span class="prslip__branch">team-console/runner-${kind === 'stale' ? OLD : VERSION} → ${esc(P.branch)}</span></span>
        <span class="etag">${t(`actions.prs.${kind}`)}</span></div>`;
    }
    // "Show the file" is primary when the console can't open the PR (no permission yet, or the PR path is off).
    const fileBlock = (primary) => `<button type="button" class="btn btn--tall${primary ? ' btn--primary' : ''}" data-act="file" data-fk="file" aria-expanded="${S.file}" aria-controls="${uid}-file">${S.file ? t('actions.file.hide') : t('actions.file.show')}</button>`;
    function fileRegion() {
      if (!S.file) return `<div id="${uid}-file" hidden></div>`;
      if (D.prErr === 'misconfigured') return `<div class="file" id="${uid}-file"><p class="act-err act-err--quiet">${IX.warn}<span>${t('actions.file.misconfigured')}</span></p></div>`;
      return `<div class="file how" id="${uid}-file">
        <p class="file__meta">${t('actions.file.meta', { version: VERSION, sha: SHA })}</p>
        <pre class="yml" tabindex="0" role="region" aria-label="${esc(plain(t('actions.file.region')))}">${YML}</pre>
        <div class="act-row" style="margin-top:0">
          <button type="button" class="btn btn--tall file__copy" data-act="copy" data-value="(the rendered file)" data-key="file" data-fk="copy-file">${IX.copy}<span>${t('common.copy')}</span></button>
          ${ghBtn(`${GH}/new/${P.branch}?filename=${PATH}`, t('actions.file.create'), 'file-create', D.perms !== 'ok' || D.prOff)}</div>
        ${S.copyFailKey === 'file' ? `<p class="copy-fail" role="status">${t('common.copyFailed')}</p>` : ''}
        <p>${tc('actions.file.protected')}</p></div>`;
    }
    function wfStep(i) {
      const s = stepState('wf');
      const reason = `${uid}-pr-why`;
      const off = isOffline() || D.busy === 'pr';
      const why = isOffline() ? `<p class="act-reason" id="${reason}">${offReason()}</p>` : '';
      const openBtn = (labelKey, primary = true) => btn('open-pr', D.busy === 'pr' ? t('actions.pr.busy') : t(labelKey), 'open-pr', { primary, off: isOffline(), reason: isOffline() ? reason : '', busy: D.busy === 'pr' });
      const prUrl = D.pr ? `${GH}/pull/${D.pr.n}` : '';
      let fix = ''; let row = ''; let extra = '';
      const pathLine = `<div class="act-path">${codeline(PATH, 'path', plain(t('actions.file.pathAria')))}</div>`;
      if (D.prErr === 'misconfigured') { fix = ''; extra = `<p class="act-err act-err--quiet">${IX.warn}<span>${t('actions.file.misconfigured')}</span></p>`; }
      else if (D.perms !== 'ok' || D.unverified) { fix = t('actions.wf.noPermission'); row = fileBlock(true); }
      else if (D.prOff && s !== 'done') { fix = t('actions.wf.prOff'); row = fileBlock(true); }
      else if (D.pr && D.pr.kind === 'foreign') { fix = ''; extra = `<p class="act-err" role="alert">${IX.warn}<span>${t('actions.pr.foreign', { n: D.pr.n })}</span></p>${prSlip('foreign')}`; row = ghBtn(prUrl, t('actions.pr.view', { n: D.pr.n }), 'pr-view') + fileBlock(); }
      else if (D.pr && D.pr.kind === 'open' && s !== 'done') { fix = t('actions.pr.opened', { n: D.pr.n }); extra = prSlip('open'); row = ghBtn(prUrl, t('actions.pr.view', { n: D.pr.n }), 'pr-view', true) + fileBlock(); }
      else if (D.pr && D.pr.kind === 'stale') { fix = t('actions.pr.stale', { n: D.pr.n, old: OLD }); extra = prSlip('stale'); row = ghBtn(prUrl, t('actions.pr.view', { n: D.pr.n }), 'pr-view') + openBtn('actions.pr.new', false); }
      else if (s === 'done') {
        fix = t('actions.wf.ok', { version: VERSION });
        if (D.pr && D.pr.kind === 'leftover') extra = `<p class="step__fix step__fix--quiet">${t('actions.pr.leftover', { n: D.pr.n })}</p>${ghLink(prUrl, t('actions.pr.view', { n: D.pr.n }), 'pr-view')}`;
        row = fileBlock();
      } else if (D.wf === 'outdated' || D.wf === 'unsupported') {
        fix = t(D.wf === 'outdated' ? 'actions.wf.outdated' : 'actions.wf.unsupported', V());
        row = openBtn('actions.pr.bump', D.wf === 'unsupported');
        extra = disclosure('pins', t('actions.pr.changes'), `<ul class="pins">${PINS.map(([name, o, n]) => `<li>${esc(t('actions.pr.pin', { name, old: o, new: n }))}</li>`).join('')}</ul>`);
      } else if (D.wf === 'modified') { fix = tc('actions.wf.modified'); row = openBtn('actions.pr.restore') + ghBtn(`${GH}/blob/${P.branch}/${PATH}`, t('actions.file.blob'), 'blob'); }
      else { fix = tc('actions.wf.missing'); row = openBtn('actions.pr.open') + fileBlock(); }
      // Refusals of the PR request: the step stays usable, the copy path is offered.
      let err = '';
      if (D.prErr === 'tampered') err = `<p class="act-err" role="alert">${IX.warn}<span>${t('actions.pr.err.tampered')}</span></p>`;
      if (D.prErr === 'permission') err = `<p class="act-err" role="alert">${IX.warn}<span>${t('actions.pr.err.permission', { permission: 'Workflows: write' })}<br>${ghLink(`${GH.replace(P.repo, 'settings')}/installations/58120437`, t('actions.perm.link'), 'pr-perm-link', 'how__link')}</span></p>`;
      if (D.prErr === 'rate') err = `<p class="act-err act-err--quiet" role="status">${IX.clock}<span>${t('actions.pr.err.rate', { time: hhmm(D.rateUntil) })}</span></p>`;
      const inner = `${pathLine}${fix ? `<p class="step__fix">${fix}</p>` : ''}${extra}${err}${row ? `<div class="act-row">${row}${off && !D.busy ? why : ''}</div>` : ''}${fileRegion()}`;
      return step(i, 'wf', tc('actions.wf.title'), inner);
    }
    function switchStep(i) {
      const s = stepState('switch');
      const reason = `${uid}-sw-why`;
      let inner;
      if (s === 'on') inner = `<p class="step__fix">${t('actions.switch.done')}</p>${inLink('go-runners', t('actions.switch.change'), 'sw-change')}`;
      else {
        const n = blocking().length;
        const ready = !n;
        const off = !ready || isOffline();
        const why = isOffline() ? offReason() : !ready ? t('actions.switch.blocked', { n }) : '';
        const banner = D.switchErr ? `<div class="rbanner" role="alert"><span>${IX.warn}<span>${refusal()}</span></span></div>` : '';
        inner = `${ready ? `<p class="step__fix">${t('actions.switch.ready')}</p>` : ''}${banner}<div class="act-row">${btn('switch', D.busy === 'switch' ? t('actions.switch.busy') : t('actions.switch.on'), 'switch', { primary: true, off, reason: off ? reason : '', busy: D.busy === 'switch' })}${why ? `<p class="act-reason" id="${reason}">${why}</p>` : ''}</div>`;
      }
      return step(i, 'switch', t('actions.switch.title'), inner);
    }
    function runStep(i) {
      const s = stepState('run');
      let inner;
      if (s === 'done') inner = `<p class="step__fix">${t('actions.run.done', { time: hhmm(minsAgo(1)) })}</p>`;
      else if (s === 'failed') inner = `<p class="step__fix">${t('actions.run.failed', { reason: t('actions.run.reason.noShow') })}</p>${inLink('space', t('actions.run.openJob'), 'run-job')}`;
      else inner = `<p class="step__fix">${t('actions.run.waiting')}</p>${inLink('space', t('actions.run.openProject'), 'run-open')}`;
      return step(i, 'run', t('actions.run.title'), inner);
    }
    function refusal() {
      const items = failedItems().map((id) => t(`actions.item.${id}`));
      return items.length ? t('runners.err.actionsNotReady', { project: P.name, items: items.join(', ') }) : t('runners.err.actionsNotReadyBare', { project: P.name });
    }

    /* ----- the summary: #24's margin note, #104's foot ----- */
    function summary() {
      if (D.call === 'loading') return `<section class="res res--neutral" aria-labelledby="${uid}-res"><h2 class="sr-only" id="${uid}-res">${t('actions.checkingSr', V())}</h2><div class="res__skel" aria-hidden="true"><span class="skel skel--c"></span><span class="skel skel--d"></span></div>${D.slow ? `<p class="act-slow" role="status">${t('actions.checkingSlow')}</p>` : ''}</section>`;
      if (D.call === 'github' || D.call === 'error') return `<div class="block block--error" role="alert"><h2 tabindex="-1" data-fk="res">${t(D.call === 'github' ? 'actions.err.github' : 'actions.err.load')}</h2><p>${t('actions.err.loadBody')}</p><button type="button" class="btn btn--tall" data-act="retry" data-fk="retry">${t('common.retry')}</button></div>`;
      if (D.call === 'offline0') return `<div class="block" role="status">${IX.wifi.replace('class="ico"', 'class="ico ico-lead"')}<h2 tabindex="-1" data-fk="res">${t('actions.err.offline0')}</h2><button type="button" class="btn btn--tall" data-act="retry" data-fk="retry">${t('common.retry')}</button></div>`;
      const n = blocking().length;
      let tone = 'warn'; let title; let body = ''; let links = '';
      if (D.dispatch === 'actions') {
        if (n) { tone = 'bad'; title = t('actions.sum.drift', { n }); links = inLink('go-runners', t('actions.sum.driftLink'), 'drift-link'); }
        else if (D.run === 'done') { tone = 'ready'; title = t('actions.sum.done', V()); links = inLink('space', t('setup.open'), 'sum-open') + (S.fromRunners ? inLink('go-runners', t('actions.backRunners'), 'sum-runners') : ''); }
        else { tone = ''; title = t('actions.sum.on'); }
      } else if (n) { title = t('actions.sum.missing', { n }); if (D.perms !== 'ok') body = t('actions.sum.permsBody'); }
      else { tone = 'ready'; title = t('actions.sum.ready'); }
      const off = isOffline() || D.call === 'rate';
      const reason = isOffline() ? t('actions.err.offlineWhy') : D.call === 'rate' ? t('actions.err.rateWhy', { time: hhmm(D.rateUntil) }) : '';
      const stamped = tone === 'ready' && D.run === 'done';
      const notes = isOffline() ? `<div class="paused env-note" role="status">${IX.wifi}<span>${t('actions.err.offline', { time: hhmm(D.offlineAt) })}</span></div>`
        : D.call === 'rate' ? `<div class="paused env-note" role="status">${IX.clock}<span>${t('actions.err.rate', { time: hhmm(D.rateUntil) })}</span></div>` : '';
      return `${notes}<section class="res${tone ? ` res--${tone}` : ''}${stamped ? ' res--ready' : ''}" aria-labelledby="${uid}-res" data-res>
        <h2 id="${uid}-res" tabindex="-1" data-fk="res">${title}</h2>${body ? `<p>${body}</p>` : ''}${links ? `<div class="res__links">${links}</div>` : ''}
        <div class="esum__foot"><p class="res__time">${t('setup.checkedAt', { time: hhmm(D.checkedAt) })}</p>
          <button type="button" class="btn btn--tall" data-act="recheck" data-fk="recheck"${dis(off || D.checking, off ? `${uid}-rc-why` : '')}>${IX.refresh}${D.checking ? t('step.pending') : t('setup.checkAgain')}</button>
          ${off ? `<p class="esum__reason" id="${uid}-rc-why">${reason}</p>` : ''}</div>${stamped ? stampSVG : ''}</section>`;
    }
    function actionsScreen() {
      const head = `<div class="act-head"><h1 tabindex="-1" data-fk="h1">${t('actions.title')}</h1>`;
      if (D.call === 'forbidden') return `${head}</div><div class="block block--lock" role="alert">${IX.lock.replace('class="ico"', 'class="ico ico-lead"')}<h2 tabindex="-1" data-fk="res">${t('actions.err.forbidden.title')}</h2><p>${t('actions.err.forbidden.body')}</p><a class="btn btn--tall" href="#" data-act="go-setup" data-fk="forbidden-back">${IX.back}${t('actions.err.forbidden.back')}</a></div>`;
      if (D.call === 'notFound') return `<div class="act-head"><h1 tabindex="-1" data-fk="h1">${t('proj.notFound.title')}</h1></div><div class="block pempty"><p>${t('proj.notFound.body', { slug: 'storyfy' })}</p><button type="button" class="btn btn--tall" data-act="space">${t('nav.all')}</button></div>`;
      const lead = `<p class="set-lead">${t('actions.lead', V())}</p>${ghLink(GH, t('setup.repoLink', V()), 'repo-link')}</div>`;
      const steps = [accessStep(0), permStep(1), envStep(2), wfStep(3), switchStep(4)];
      if (D.dispatch === 'actions' && !noData()) steps.push(runStep(5));
      return `${head}${lead}${summary()}
        <p class="act-minutes">${IX.clock}<span>${t('runners.dispatch.minutes')}</span></p>
        <ol class="ledger" aria-label="${t('actions.stepsAria')}"${noData() ? ' aria-busy="true"' : ''}>${steps.join('')}</ol>`;
    }

    /* ----- project setup: five steps done, then the sibling rows ----- */
    function rowChip() {
      if (D.dispatch !== 'actions') return `<span class="status est est--off">${t('actions.row.chip.off')}</span>`;
      if (D.rowCall === 'checking') return `<span class="status est est--checking">${dots}${t('actions.row.chip.checking')}</span>`;
      const n = blocking().length;
      if (n) return `<span class="status est est--missing">${IX.bang}${t('actions.row.chip.notReady', { n })}</span>`;
      return `<span class="status est est--on">${IX.check}${t('actions.row.chip.on')}</span>`;
    }
    function entryRow({ act, fk, icon, iconCls = '', title, sub, chipHTML }) {
      return `<ul class="plist"><li class="prow erow-entry"><a class="prow__link" href="#" data-act="${act}" data-fk="${fk}">
        <span class="env-ico${iconCls}" aria-hidden="true">${icon}</span>
        <span class="prow__txt"><span class="entry__name">${title}</span><span class="entry__sub">${sub}</span></span>
        ${chipHTML}${IX.chev}</a></li></ul>`;
    }
    function setupScreen() {
      const STEPS = ['app', 'owner', 'yml', 'events', 'routine'];
      const vars = { repo: P.repo, SLUG: 'STORIFY', time: hhmm(minsAgo(38)) };
      const ledger = `<ol class="ledger" aria-label="${t('setup.stepsAria')}">${STEPS.map((k) => `<li class="step step--done"><span class="step__mark" aria-hidden="true">${IX.check}</span>
          <div class="step__body"><div class="step__head"><h3 class="step__title">${t(`step.${k}.title`, vars)}</h3><span class="step__state">${t('step.done')}</span></div><p class="step__fix">${t(`step.${k}.done`, vars)}</p></div></li>`).join('')}</ol>`;
      const drift = D.dispatch === 'actions' && blocking().length;
      const sub = D.dispatch !== 'actions' ? t('actions.row.sub.off') : drift ? t('actions.row.sub.drift') : t('actions.row.sub.on', { repo: P.repo });
      const actionsRow = entryRow({ act: 'go-actions', fk: 'actions-entry', icon: IX.play, iconCls: ' env-ico--run', title: t('actions.row.title'), sub, chipHTML: rowChip() });
      const envRow = D.customer ? '' : entryRow({ act: 'space', fk: 'penv-entry', icon: IX.key, title: t('proj.entry.row'), sub: t('proj.entry.sub', { env: 'ENV' }).replace('ENV', '<code>production</code>'), chipHTML: `<span class="status est est--set">${IX.check}${t('env.entry.ok')}</span>` });
      return `<div class="set-head set-head--proj">${mono(P.slug)}<div><h1 tabindex="-1" data-fk="h1">${esc(P.name)}</h1>
          <p class="set-meta">${ghLink(GH, esc(GH.replace('https://', '')), 'repo-link', 'ext')}<code>/p/${esc(P.slug)}</code></p></div></div>
        <section class="res res--ready" aria-labelledby="${uid}-sres"><h2 id="${uid}-sres" tabindex="-1">${t('setup.ready.title', { name: P.name })}</h2><p>${t('setup.ready.body')}</p><p class="res__time">${t('setup.checkedAt', { time: hhmm(minsAgo(3)) })}</p></section>
        ${ledger}<div class="setup-rows" role="group" aria-label="${esc(plain(t('setup.rowsAria')))}">${actionsRow}${envRow}</div>
        <div class="form-actions"><button type="button" class="btn btn--tall" data-act="space">${t('setup.checkAgain')}</button>
          <button type="button" class="btn btn--primary btn--tall" data-act="space">${t('setup.open')}</button></div>
        <div class="danger-zone"><button type="button" class="btn btn--danger-quiet btn--tall" data-act="space">${IX.archive}${t('setup.archive')}</button></div>`;
    }

    /* ----- Runners › Where jobs run: the readiness line under the radio group ----- */
    function runnersScreen() {
      const saved = D.dispatch;
      const radio = (v, label, hint) => {
        const on = D.rsel === v;
        return `<label class="radio${on ? ' is-on' : ''}"><input type="radio" name="${uid}-mode" value="${v}" data-act="rsel" data-fk="r-${v}"${on ? ' checked' : ''}><span class="radio__mark" aria-hidden="true"></span><span class="radio__txt"><b>${label}</b><span>${hint}</span></span></label>`;
      };
      let line = '';
      const lid = `${uid}-rline`;
      if (D.rsel === 'actions') {
        const r = D.rready;
        if (r === 'checking') line = `<p class="rline rline--checking" role="status" id="${lid}"><span>${dots}<span>${t('runners.dispatch.ready.checking')}</span></span></p>`;
        else if (r === 'ok') line = `<p class="rline rline--ok" role="status" id="${lid}"><span>${IX.check}<span>${t('runners.dispatch.ready.ok')}</span></span></p>`;
        else if (r === 'failed') line = `<p class="rline rline--failed" role="status" id="${lid}"><span>${IX.q}<span>${t('runners.dispatch.ready.failed')}</span></span>${inLink('go-actions-r', t('runners.dispatch.ready.link'), 'r-prep')}</p>`;
        else if (r === 'missing') line = `<p class="rline" role="status" id="${lid}"><span>${IX.warn}<span>${t('runners.dispatch.ready.missing', { n: blocking().length })}</span></span>${inLink('go-actions-r', t('runners.dispatch.ready.link'), 'r-prep')}</p>`;
      } else line = `<p class="sr-only" role="status" id="${lid}"></p>`;
      const blocked = D.rsel === 'actions' && saved !== 'actions' && D.rready === 'missing';
      const banner = D.rrefused ? `<div class="rbanner" role="alert"><span>${IX.warn}<span>${refusal()}</span></span>${inLink('go-actions-r', t('runners.dispatch.ready.link'), 'r-ban-prep')}</div>` : '';
      return `<div class="set-head"><div><h1 tabindex="-1" data-fk="h1">${t('runners.title')}</h1><p class="set-lead">${t('runners.lead')}</p></div></div>
        <section class="sec" aria-labelledby="${uid}-s-m"><h2 class="sec-title" id="${uid}-s-m">${t('runners.machines')}</h2>
          <ul class="plist"><li class="prow erow-entry"><a class="prow__link" href="#" data-act="space"><span class="env-ico" aria-hidden="true">${IX.server}</span><span class="prow__txt"><span class="entry__name">Mac mini</span><span class="entry__sub">${t('runners.machines.sub')}</span></span><span></span>${IX.chev}</a></li></ul></section>
        <section class="sec" aria-labelledby="${uid}-s-d"><h2 class="sec-title" id="${uid}-s-d">${t('runners.dispatch.title')}</h2>
          <div class="rcard"><div class="rcard__proj">${mono(P.slug)}<div><b>${esc(P.name)}</b><br><code>${esc(P.repo)}</code></div></div>
            <p>${t('runners.dispatch.lead')}</p>
            <fieldset class="radios"><legend>${t('runners.dispatch.mode')}</legend>
              ${radio('pull', t('runners.dispatch.pull'), t('runners.dispatch.pullHint'))}
              ${radio('actions', t('runners.dispatch.actions'), t('runners.dispatch.actionsHint'))}</fieldset>
            ${line}
            <p>${tc('runners.dispatch.branch')}</p>
            <p class="act-minutes" style="margin:0">${IX.clock}<span>${t('runners.dispatch.minutes')}</span></p>
            ${banner}
            <div class="rsave">${btn('rsave', D.busy === 'rsave' ? t('runners.dispatch.busy') : t('runners.dispatch.save'), 'rsave', { primary: true, off: blocked, reason: blocked ? lid : '', busy: D.busy === 'rsave' })}</div>
          </div></section>`;
    }

    /* ----- chrome per route ----- */
    function chrome() {
      if (mac) {
        const c = []; const a = (act, fk, label) => `<li><a href="#" data-act="${act}" data-fk="${fk}">${label}</a></li>`;
        const here = (label) => `<li><span aria-current="page">${label}</span></li>`;
        if (S.route === 'runners') { c.push(a('space', 'crumb-settings', t('nav.settings'))); c.push(here(t('runners.title'))); }
        else {
          c.push(a('space', 'crumb-all', t('nav.all')));
          if (S.route === 'setup') c.push(here(esc(P.name)));
          else { c.push(a('go-setup', 'crumb-setup', esc(P.name))); c.push(here(t('actions.crumb'))); }
        }
        $('[data-slot=crumbs]').innerHTML = `<ol>${c.join('')}</ol>`;
        host.querySelectorAll('[data-nav]').forEach((b) => { const on = (b.dataset.nav === 'settings') === (S.route === 'runners'); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
        return;
      }
      const label = { setup: t('nav.all'), actions: S.fromRunners ? t('runners.title') : P.name, runners: t('nav.settings') }[S.route];
      $('[data-slot=phead]').innerHTML = `<header class="p-bar"><button type="button" class="p-back" data-act="back" data-fk="back">${IX.back}<span>${esc(label)}</span></button><span></span><span></span></header>`;
    }
    const scroller = () => host.querySelector('.set-scroll, .p-scroll');
    function render(opts = {}) {
      const active = host.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
      const sc = scroller(); const top = sc ? sc.scrollTop : 0;
      chrome();
      const body = S.route === 'setup' ? setupScreen() : S.route === 'runners' ? runnersScreen() : actionsScreen();
      let animEl;
      if (mac) { $('[data-slot=body]').innerHTML = `<div class="set-scroll"><div class="set-inner">${body}</div></div>`; animEl = $('.set-inner'); }
      else { $('[data-slot=screen]').innerHTML = body; animEl = $('[data-slot=screen]'); }
      if (S.anim && !opts.noAnim && !mac) { const cls = S.anim === 'pop' ? 'is-pop' : 'is-push'; animEl.classList.add(cls); animEl.addEventListener('animationend', () => animEl.classList.remove(cls), { once: true }); }
      S.anim = null;
      const sc2 = scroller(); if (sc2) sc2.scrollTop = opts.scrollTop === 'top' ? 0 : top;
      const target = opts.focus ? host.querySelector(`[data-fk="${opts.focus}"]`) : active ? host.querySelector(`[data-fk="${active}"]`) : null;
      if (target) target.focus({ preventScroll: !opts.reveal });
      if (opts.reveal && target) target.scrollIntoView({ block: 'center', behavior: isReduced() ? 'auto' : 'smooth' });
      if (D.stampNow) stamp();
    }
    const announce = (txt) => { const l = $('[data-slot=live]'); l.textContent = ''; setTimeout(() => { l.textContent = txt; }, 30); };
    let toastTimer;
    function toast(txt) { const el = $('[data-slot=toast]'); el.textContent = txt; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, Proto.ms('--dur-toast')); }
    // The #104 ink stamp, reused once: it presses onto the summary when the first job on GitHub Actions passes.
    function stamp() {
      const s = host.querySelector('[data-res] .stamp'); if (!s || s.dataset.done) return;
      s.dataset.done = '1';
      if (isReduced()) { Proto.play(s, [{ opacity: 0 }, { opacity: 1 }], { duration: Proto.ms('--dur-fade') }); return; }
      const strokes = [...s.querySelectorAll('circle,path')];
      strokes.forEach((p) => { const l = p.getTotalLength(); p.style.strokeDasharray = l; p.style.strokeDashoffset = l; });
      Proto.play(s, [{ opacity: 0, transform: 'rotate(-20deg) scale(1.4)' }, { opacity: 1, transform: 'rotate(-9deg) scale(1)' }], { duration: Proto.ms('--dur-base'), easing: Proto.cssVar('--ease-emph') });
      strokes.forEach((p, n) => Proto.play(p, [{ strokeDashoffset: p.style.strokeDashoffset }, { strokeDashoffset: 0 }], { duration: Proto.ms('--dur-sig') * 0.6, delay: n * Proto.ms('--stagger'), easing: Proto.cssVar('--ease-emph'), fill: 'forwards' }));
    }

    function go(route, opts = {}) { S.route = route; S.anim = opts.anim || 'push'; render({ focus: opts.focus || 'h1', scrollTop: 'top' }); }
    function back() {
      if (S.route === 'actions') { if (S.fromRunners) go('runners', { anim: 'pop', focus: 'r-actions' }); else go('setup', { anim: 'pop', focus: 'actions-entry' }); }
      else toast(t('demo.space'));
    }
    async function copy(b) {
      const key = b.dataset.key;
      try {
        if (D.copyFail) throw new Error('Clipboard refused (demo)');
        await navigator.clipboard.writeText(b.dataset.value);
      } catch (err) {
        console.warn('Copy failed; showing the copy-it-by-hand note', err);
        S.copyFailKey = key; render({ focus: b.dataset.fk }); announce(t('common.copyFailed'));
        return;
      }
      if (S.copyFailKey) { S.copyFailKey = null; render(); }
      const el = host.querySelector(`[data-fk="${CSS.escape(b.dataset.fk)}"]`) || b;
      const label = el.querySelector('span'); label.textContent = t('common.copied'); el.dataset.copied = '';
      announce(t('common.copied'));
      setTimeout(() => { if (el.isConnected) { label.textContent = t('common.copy'); delete el.dataset.copied; } }, 2000);
    }
    function focusFirstMissing() {
      const k = PREP.find((x) => ['missing', 'skipped'].includes(stepState(x)));
      if (k) render({ focus: `step-${k}`, reveal: true });
    }

    host.onclick = (e) => {
      const el = e.target.closest('[data-act]'); if (!el || !host.contains(el)) return;
      const act = el.dataset.act;
      if (el.tagName === 'A') e.preventDefault();
      if (el.getAttribute('aria-disabled') === 'true') {
        // A disabled control still answers: it takes you to what is missing.
        if (act === 'switch' && !isReady()) focusFirstMissing();
        if (act === 'rsave') render({ focus: 'r-prep' });
        return;
      }
      switch (act) {
        case 'go-setup': go('setup', { anim: 'pop', focus: 'actions-entry' }); break;
        case 'go-actions': S.fromRunners = false; go('actions'); break;
        case 'go-actions-r': S.fromRunners = true; go('actions'); break;
        case 'go-runners': D.rsel = D.dispatch; D.rready = D.dispatch === 'actions' ? (isReady() ? 'ok' : 'missing') : null; D.rrefused = false; go('runners'); break;
        case 'back': back(); break;
        case 'how': S.how[el.dataset.key] = el.dataset.open !== 'true'; render(); break;
        case 'file': S.file = !S.file; render({ focus: 'file' }); break;
        case 'copy': copy(el); break;
        case 'recheck': recheck(host); break;
        case 'retry': retry(host); break;
        case 'open-pr': openPr(host); break;
        case 'switch': switchOn(host); break;
        case 'rsave': saveRunners(host); break;
        case 'gh': toast(t('demo.ghNote')); break;
        case 'space': toast(t('demo.space')); break;
        default: break;
      }
    };
    host.onchange = (e) => { const r = e.target.closest('[data-act=rsel]'); if (r) chooseMode(host, r.value); };

    const app = {
      render, S, announce,
      state(v) {
        Object.assign(S, { route: 'actions', how: {}, file: false, fromRunners: false, copyFailKey: null });
        if (v.startsWith('setup')) S.route = 'setup';
        if (v.startsWith('runners')) S.route = 'runners';
        if (v === 'copy' || v === 'prOff') S.file = true;
        render({ focus: 'h1', scrollTop: 'top', noAnim: true });
      },
      reveal(fk) { const el = host.querySelector(`[data-fk="${fk}"]`); const sc = scroller(); if (el && sc) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 16; },
    };
    host.app = app;
    render();
    return app;
  }

  /* ---------- shared actions ---------- */
  function renderAll(except) { hosts.forEach((h) => { if (h.app && h !== except) h.app.render(); }); }
  function applyFixed() {
    Object.assign(D, { perms: 'ok', unverified: false, env: { environment: 'ok', branch: 'ok', rules: 'ok', secret: 'ok' }, prErr: null, switchErr: false });
    if (D.wf !== 'ok') { D.wf = 'ok'; D.pr = null; }
    if (D.pr && D.pr.kind !== 'leftover') D.pr = null;
  }
  async function recheck(host) {
    if (D.checking) return;
    const before = Object.fromEntries(PREP.map((k) => [k, stepState(k)]));
    D.checking = true; renderAll(); host.app.announce(plain(t('actions.checkingSr', { repo: P.repo })));
    await wait(1100);
    D.checking = false;
    if (D.next === 'error') { D.call = 'github'; renderAll(host); host.app.render({ focus: 'res' }); return; }
    if (D.next === 'fixed') {
      if (D.dispatch === 'actions' && isReady()) { D.run = 'done'; D.stampNow = true; } else applyFixed();
    }
    D.call = 'ok'; D.checkedAt = new Date();
    D.fresh = PREP.filter((k) => before[k] !== stepState(k) && stepState(k) === 'done');
    renderAll(host); host.app.render({ focus: 'recheck' });
    D.fresh = null; D.stampNow = false;
    const done = PREP.filter((k) => stepState(k) === 'done').length;
    host.app.announce(t('actions.doneLive', { done, total: PREP.length + 1 }));
  }
  async function retry(host) {
    D.call = 'loading'; renderAll();
    await wait(900);
    D.call = 'ok'; D.checkedAt = new Date();
    renderAll(host); host.app.render({ focus: 'res' });
  }
  async function openPr(host) {
    if (D.busy) return;
    D.busy = 'pr'; D.prErr = D.prErr === 'misconfigured' ? 'misconfigured' : null; renderAll(host); host.app.render({ focus: 'open-pr' });
    await wait(900);
    D.busy = null;
    if (D.demoPrErr) { D.prErr = D.demoPrErr; renderAll(host); host.app.render({ focus: 'open-pr' }); host.app.announce(plain(host.querySelector('.act-err')?.textContent || '')); return; }
    D.pr = { n: 42, kind: 'open' };
    renderAll(host); host.app.render({ focus: 'pr-view' });
    host.app.announce(t('actions.pr.openedLive', { n: 42 }));
  }
  async function switchOn(host) {
    if (D.busy) return;
    D.busy = 'switch'; renderAll(host); host.app.render({ focus: 'switch' });
    await wait(900);
    D.busy = null;
    D.dispatch = 'actions'; D.run = 'waiting'; D.switchErr = false;
    renderAll(host); host.app.render({ focus: 'res' });
    host.app.announce(t('actions.switch.doneLive'));
  }
  async function chooseMode(host, v) {
    D.rsel = v; D.rrefused = false;
    if (v !== 'actions') { D.rready = null; renderAll(); return; }
    // The readiness call runs only when the radio becomes "On GitHub Actions", never for pull.
    D.rready = 'checking'; renderAll();
    await wait(900);
    D.rready = D.demoRready || (isReady() ? 'ok' : 'missing');
    renderAll();
  }
  async function saveRunners(host) {
    if (D.busy) return;
    D.busy = 'rsave'; renderAll(host); host.app.render({ focus: 'rsave' });
    await wait(800);
    D.busy = null;
    if (D.rsel === 'actions' && !isReady()) { D.rrefused = true; renderAll(host); host.app.render({ focus: 'rsave' }); return; }
    D.dispatch = D.rsel; if (D.dispatch === 'actions' && !D.run) D.run = 'waiting';
    renderAll(host); host.app.render({ focus: 'rsave' });
    host.app.announce(t('runners.dispatch.saved'));
  }

  /* ---------- demo states (UX spec §6, §3.4 PR rows, §4, §5) ---------- */
  const STATES = {
    setupOff: {}, setupCustomer: { customer: true }, setupOn: { dispatch: 'actions', run: 'done', wf: 'ok', env: { environment: 'ok', branch: 'ok', rules: 'ok', secret: 'ok' } },
    setupDrift: { dispatch: 'actions', run: 'done', wf: 'modified', env: { environment: 'ok', branch: 'ok', rules: 'ok', secret: 'missing' } },
    loading: { call: 'loading' }, partial: {}, perms: { perms: 'missing' }, subscription: { access: 'subscription' },
    envMissing: { env: { environment: 'missing', branch: 'ok', rules: 'ok', secret: 'missing' } },
    envWrong: { env: { environment: 'ok', branch: 'wrong', rules: 'ok', secret: 'ok' }, wf: 'ok' },
    rulesWarn: { env: { environment: 'ok', branch: 'ok', rules: 'warn', secret: 'ok' }, wf: 'ok' },
    repoUnverified: { unverified: true },
    ready: { env: { environment: 'ok', branch: 'ok', rules: 'ok', secret: 'ok' }, wf: 'ok' },
    waiting: { env: { environment: 'ok', branch: 'ok', rules: 'ok', secret: 'ok' }, wf: 'ok', dispatch: 'actions', run: 'waiting' },
    success: { env: { environment: 'ok', branch: 'ok', rules: 'ok', secret: 'ok' }, wf: 'ok', dispatch: 'actions', run: 'done' },
    runFailed: { env: { environment: 'ok', branch: 'ok', rules: 'ok', secret: 'ok' }, wf: 'ok', dispatch: 'actions', run: 'failed' },
    drift: { env: { environment: 'ok', branch: 'ok', rules: 'ok', secret: 'ok' }, wf: 'modified', dispatch: 'actions', run: 'done' },
    prOpen: { pr: { n: 42, kind: 'open' } }, copy: {}, outdated: { wf: 'outdated', env: { environment: 'ok', branch: 'ok', rules: 'ok', secret: 'ok' } },
    unsupported: { wf: 'unsupported', env: { environment: 'ok', branch: 'ok', rules: 'ok', secret: 'ok' } },
    modified: { wf: 'modified', env: { environment: 'ok', branch: 'ok', rules: 'ok', secret: 'ok' } },
    stale: { wf: 'outdated', pr: { n: 37, kind: 'stale' }, env: { environment: 'ok', branch: 'ok', rules: 'ok', secret: 'ok' } },
    foreign: { pr: { n: 44, kind: 'foreign' }, env: { environment: 'ok', branch: 'ok', rules: 'ok', secret: 'ok' } },
    leftover: { wf: 'ok', pr: { n: 42, kind: 'leftover' }, env: { environment: 'ok', branch: 'ok', rules: 'ok', secret: 'ok' } },
    prOff: { prOff: true }, misconfigured: { prErr: 'misconfigured' },
    prTampered: { prErr: 'tampered', demoPrErr: 'tampered' }, prPerm: { prErr: 'permission', demoPrErr: 'permission' }, prRate: { prErr: 'rate', demoPrErr: 'rate' },
    // drawn after the click: the key went missing between the check and Switch on, so the server refused and the page re-checked
    switchRefused: { wf: 'ok', env: { environment: 'ok', branch: 'ok', rules: 'ok', secret: 'missing' }, switchErr: true },
    github: { call: 'github' }, error: { call: 'error' }, rate: { call: 'rate' }, offline: { call: 'offline' }, offline0: { call: 'offline0' },
    forbidden: { call: 'forbidden' }, notFound: { call: 'notFound' },
    runnersChecking: { rsel: 'actions', rready: 'checking' }, runnersMissing: { rsel: 'actions', rready: 'missing' },
    runnersOk: { rsel: 'actions', rready: 'ok', env: { environment: 'ok', branch: 'ok', rules: 'ok', secret: 'ok' }, wf: 'ok' },
    runnersFailed: { rsel: 'actions', rready: 'failed', demoRready: 'failed' }, runnersRefused: { rsel: 'actions', rready: 'failed', demoRready: 'failed', rrefused: true },
  };

  const mountAll = (keep) => hosts.forEach((h) => { const prev = keep && h.S ? h.S : null; h.className = 'app'; mountApp(h, h.dataset.app, prev); });
  pageChrome = Proto.page({ L, title: 'Team Console · #759', onLang: () => mountAll(true) });
  const sel = (id) => document.getElementById(id);
  let slowTimer;
  function applyState(v) {
    const keep = { next: D.next, copyFail: D.copyFail, setupApp: D.setupApp };
    Object.assign(D, fresh0(), { demoPrErr: null, demoRready: null }, keep, JSON.parse(JSON.stringify(STATES[v] || {})));
    clearTimeout(slowTimer);
    if (D.call === 'loading') slowTimer = setTimeout(() => { if (D.call === 'loading') { D.slow = true; renderAll(); } }, 3000);
    hosts.forEach((h) => h.app.state(v));
  }
  sel('d-state').addEventListener('change', (e) => applyState(e.target.value));
  sel('d-next').addEventListener('change', (e) => { D.next = e.target.value; });
  sel('d-copy').addEventListener('change', (e) => { D.copyFail = e.target.checked; });
  sel('d-setupapp').addEventListener('change', (e) => { D.setupApp = e.target.checked; renderAll(); });
  document.querySelector('[data-reset]').addEventListener('click', () => { D.next = 'same'; D.copyFail = false; D.setupApp = false; sel('d-next').value = 'same'; sel('d-copy').checked = false; sel('d-setupapp').checked = false; sel('d-state').value = 'partial'; applyState('partial'); });

  // ?state=…&view=…&theme=…&lang=…&motion=…&setupApp=1&scroll=<data-fk>&shot=1 opens a state directly (screenshots).
  const q = new URLSearchParams(location.search);
  if (q.has('shot')) Proto.root.dataset.shot = '';
  if (q.get('lang') === 'en' || q.get('lang') === 'ru') { L.save(q.get('lang')); pageChrome.setControl('lang', q.get('lang')); }
  mountAll(false);
  ['view', 'theme', 'motion'].forEach((k) => { if (q.get(k)) pageChrome.setControl(k, q.get(k)); });
  if (q.get('setupApp') === '1') { D.setupApp = true; sel('d-setupapp').checked = true; }
  const st = q.get('state') || 'partial';
  sel('d-state').value = st;
  applyState(st);
  if (q.get('open')) q.get('open').split(',').forEach((k) => hosts.forEach((h) => { h.S.how[k] = true; }));
  if (q.get('open')) renderAll();
  if (q.get('scroll')) hosts.forEach((h) => h.app.reveal(q.get('scroll')));
  pageChrome.fit();
})();
