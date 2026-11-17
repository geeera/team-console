/* #761 PWA install prompt. Design prototype runtime with mock data only: no beforeinstallprompt, no storage of the
   real app. The real client captures `beforeinstallprompt` in main.ts with preventDefault(), picks one install path
   per launch from `platformOf` plus the kept event (UX spec §2), and stores the choice in `tc.install-prompt.v1`.
   Each frame is its own device with its own memory; the demo bar sets the browser and replays launches. */
(() => {
  'use strict';
  const { isReduced, cssVar, ms, wait, esc, play, plain, I } = Proto;
  const L = Proto.i18n(I18N);
  const { t } = L;

  /* ---------- mock data ---------- */
  const APP = 'Team Console';
  const HOST = 'team-console.example.workers.dev';
  const NEEDS = 3;
  const SNOOZE_DAYS = 14;
  const IGNORE_LIMIT = 3;
  const DAY = 864e5;
  const Q = [{ n: 42, kind: 'question' }, { n: 47, kind: 'release' }, { n: 51, kind: 'question' }];
  const LANES = [['doing', [[61, 1], [64, 2]]], ['review', [[58, 3], [66, 5]]], ['done', [[52, 4], [49, 6]]]];
  const TABS = [['questions', I.inbox], ['board', I.board], ['artifacts', I.stack], ['demo', I.play]];

  // Shared by both frames: the demo bar.
  const G = { phone: 'android', mac: 'chrome', prompt: 'opens', policy: 'three', clock: Date.now() };
  const hosts = [...document.querySelectorAll('[data-app]')];
  const memOut = document.getElementById('d-mem');
  // Screenshots keep the toast on screen; the live page lets it go after --dur-toast.
  const HOLD_TOAST = new URLSearchParams(location.search).has('shot');

  /* The install path for one launch (UX spec §2): native | ios | iosOther | mac | menu | inapp | macOld | none | standalone */
  function pathOf(plat, eventKept) {
    return {
      android: eventKept ? 'native' : 'menu', androidNoEvent: 'menu', iosSafari: 'ios', iosOther: 'iosOther', iosInApp: 'inapp',
      standalone: 'standalone', chrome: eventKept ? 'native' : 'menu', chromeNoEvent: 'menu', safari: 'mac', safariOld: 'macOld',
      firefox: 'none',
    }[plat];
  }
  const CARD_PATHS = ['native', 'ios', 'iosOther', 'mac'];

  /* ---------- one device ---------- */
  function mountApp(host, kind, keep) {
    const isPhone = kind === 'phone';
    const plat = () => G[kind];
    const fresh = () => ({
      screen: 'needs', landing: 'needs', card: 'hidden', steps: false, setSteps: false, setErr: false, eventKept: true,
      installedNow: false, mem: null, ignored: 0, shownThisLaunch: false, answered: false, lateArmed: false,
      nudge: true, toastMsg: '', nudgeHeld: false,
    });
    const S = keep || fresh();
    host.S = S;
    const uid = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const $ = (s) => host.querySelector(s);
    const path = () => (S.installedNow && pathOf(plat(), S.eventKept) !== 'standalone' ? 'just' : pathOf(plat(), S.eventKept));
    const inBrowser = () => plat() !== 'standalone';

    host.innerHTML = isPhone
      ? `<div class="p-status" aria-hidden="true"><span>9:41</span><span class="p-island"></span><span class="p-status__icons">${I.bars}${I.battery}</span></div>
        <div data-slot="crbar" data-bg></div>
        <div data-slot="phead" data-bg></div>
        <div class="p-scroll" data-bg data-slot="scroll"><div class="set-inner" data-slot="screen"></div></div>
        <div data-slot="tabs" data-bg></div>
        <div data-slot="safari" data-bg></div>
        <div class="home-ind" aria-hidden="true"></div>
        <div data-slot="overlay"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`
      : `<div class="win">
          <div class="win__bar" data-slot="winbar"></div>
          <div class="win__body">
            <nav class="sidebar" aria-label="${t('shell.nav')}" data-bg data-slot="side"></nav>
            <section class="set-main" aria-label="Team Console" data-bg>
              <header class="convo__head"><nav class="crumbs" aria-label="${t('shell.crumbs')}" data-slot="crumbs"></nav></header>
              <div class="set-scroll" data-slot="scroll"><div class="set-inner" data-slot="screen"></div></div>
            </section>
          </div>
        </div>
        <div data-slot="overlay"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`;

    const sr = (txt) => `<span class="sr-only">${txt}</span>`;
    const tile = (cls = '') => `<span class="app-tile${cls}" aria-hidden="true">${I.mark}</span>`;
    const kbd = (ico, name) => `<span class="kbd-ico">${ico}${sr(name)}</span>`;

    /* ----- the Home Screen guide (#36's three steps; step 1 differs outside Safari, step 3 in install wording) ----- */
    function guide(id, other) {
      const s1 = other
        ? `<p>${t('install.guide.s1OtherIos', { app: APP }).replace('{share}', kbd(I.share, t('push.install.share')))}</p>`
        : `<p>${t('push.install.s1').replace('{more}', kbd(I.more, t('push.install.more')))}</p><p class="guide__aside">${t('push.install.s1note').replace('{share}', kbd(I.share, t('push.install.share')))}</p>`;
      return `<ol class="guide" id="${id}" aria-label="${esc(plain(t('push.install.steps')))}" data-testid="push-install-guide">
        <li class="guide__step"><span class="guide__n" aria-hidden="true">1</span><div>${s1}</div></li>
        <li class="guide__step"><span class="guide__n" aria-hidden="true">2</span><div><p>${t('push.install.s2')}</p></div></li>
        <li class="guide__step"><span class="guide__n" aria-hidden="true">3</span><div><p>${t('install.guide.s3', { app: APP })}</p></div></li></ol>`;
    }

    /* ----- the install card ----- */
    function card() {
      const p = path();
      if (S.card === 'done') {
        return `<div class="inst-done${S.landed ? ' is-new' : ''}" role="status" tabindex="-1" data-fk="done">${tile(' app-tile--sm')}<p>${t(isPhone ? 'install.card.donePhone' : 'install.card.doneDesktop', { app: APP })}</p>
          <button type="button" class="icon-btn" data-act="done-x" aria-label="${esc(t('install.card.doneHideAria'))}">${I.x}</button></div>`;
      }
      if (!['offer', 'dialog', 'error'].includes(S.card) || !CARD_PATHS.includes(p)) return '';
      const later = `<button type="button" class="btn btn--quiet" data-act="later" data-fk="later">${t('install.card.later')}</button>`;
      const never = `<button type="button" class="inst__never" data-act="never" data-fk="never">${t('install.card.never')}</button>`;
      const anim = S.fresh ? ' is-in' : '';
      if (p === 'mac') {
        return `<aside class="inst inst--line${anim}" aria-labelledby="${uid}-it">${tile(' app-tile--sm')}<p class="inst__body" id="${uid}-it">${t('install.card.mac', { app: APP })}</p>
          <div class="inst__acts">${later.replace('btn btn--quiet', 'btn btn--quiet btn--sm')}${never}</div></aside>`;
      }
      const ios = p === 'ios' || p === 'iosOther';
      const body = ios ? t(p === 'iosOther' ? 'install.card.bodyIosOther' : 'install.card.bodyIos') : t(isPhone ? 'install.card.bodyPhone' : 'install.card.bodyDesktop');
      const busy = S.card === 'dialog';
      const main = ios
        ? `<button type="button" class="btn btn--primary toggle-btn" data-act="steps" data-fk="main" aria-expanded="${S.steps}" aria-controls="${uid}-steps">${t(S.steps ? 'install.card.hideSteps' : 'install.card.how')}${I.down}</button>`
        : `<button type="button" class="btn btn--primary" data-act="install" data-fk="main" aria-label="${esc(t('install.card.installAria', { app: APP }))}"${busy ? ' aria-disabled="true"' : ''}>${I.install}${t('install.card.install')}</button>`;
      const err = S.card === 'error' ? `<p class="inst__err" role="alert">${I.warn}<span>${t('install.card.error')}</span></p>` : '';
      const steps = ios && S.steps ? `<div class="inst__steps">${guide(`${uid}-steps`, p === 'iosOther')}</div>` : '';
      // Desktop keeps every action in one row; the phone puts "Don't show again" on its own line, after the steps.
      const acts = isPhone ? `<div class="inst__acts">${main}${later}</div>${err}${steps}${never}` : `<div class="inst__acts">${main}${later}${never}</div>${err}`;
      return `<aside class="inst${anim}" aria-labelledby="${uid}-it">${tile()}<h2 class="inst__title" id="${uid}-it">${t('install.card.title', { app: APP })}</h2>
        <p class="inst__body">${body}</p>${acts}</aside>`;
    }

    /* ----- the push nudge (#36), held while the install card is offered: one prompt per launch ----- */
    function nudge() {
      if (!S.nudge || S.shownThisLaunch || S.nudgeHeld) return '';
      if (['ios', 'iosOther', 'inapp'].includes(path()) && plat() !== 'iosSafari') return '';
      const main = plat() === 'iosSafari'
        ? `<button type="button" class="btn btn--sm" data-act="nudge-how" data-fk="nudge-how">${t('nudge.how')}</button>`
        : `<button type="button" class="btn btn--primary btn--sm" data-act="enable">${I.bell}<span>${t('nudge.enable')}</span></button>`;
      return `<aside class="push-nudge" aria-labelledby="${uid}-nudge"><span class="push-nudge__ico" aria-hidden="true">${I.bellOff}</span>
        <p id="${uid}-nudge">${t('nudge.text')}</p>
        <div class="push-nudge__acts">${main}<button type="button" class="btn btn--quiet btn--sm" data-act="nudge-later" aria-label="${esc(t('nudge.laterAria'))}">${t('nudge.later')}</button></div></aside>`;
    }

    /* ----- screens ----- */
    const top = () => (S.screen === S.cardScreen ? card() : '');
    function needsScreen() {
      const row = (q, slug) => `<li><button type="button" class="need" data-act="answer"><span class="need__top"><span class="ptag">${slug}</span><span class="need__kind">${t(`needs.kind.${q.kind}`)}</span></span><span class="need__title">${t(`q.${q.n}`)}</span>${I.chev}</button></li>`;
      return `<div class="set-head"><h1 tabindex="-1" data-fk="h1">${t('shell.needsYou')}</h1></div>${top()}${nudge()}
        <p class="needs__lead">${t('needs.lead')}</p>
        <ul class="needs__list">${row(Q[0], 'storify')}${row(Q[1], 'storify')}${row(Q[2], 'fieldnote')}</ul>`;
    }
    function spaceScreen() {
      const lane = ([k, items]) => `<section class="lane" aria-labelledby="${uid}-l-${k}"><h2 class="lane__h" id="${uid}-l-${k}">${t(`lane.${k}`)}</h2>
        <ul>${items.map(([n, i]) => `<li><button type="button" class="ticket" data-act="answer"><span class="ticket__n">#${n}</span><span>${t(`task.${i}`)}</span></button></li>`).join('')}</ul></section>`;
      return `<div class="set-head"><h1 tabindex="-1" data-fk="h1"${isPhone ? ' class="sr-only"' : ''}>storify</h1></div>${top()}
        <div class="${isPhone ? 'lanes' : 'mac-lanes'}" style="display:grid;gap:var(--sp-5)">${LANES.map(lane).join('')}${isPhone ? LANES.map(lane).join('') : ''}</div>`;
    }
    function appSection() {
      const p = path();
      const installed = p === 'standalone' || p === 'just';
      const sub = {
        standalone: t('settings.app.subStandalone', { app: APP }), just: t('settings.app.subJustInstalled', { app: APP }),
        native: t('settings.app.subNative'), menu: t('settings.app.subMenu', { app: APP }), ios: t('settings.app.subIos'),
        iosOther: t('settings.app.subIos'), inapp: t('settings.app.subInApp'), mac: t('settings.app.subMac'),
        macOld: t('settings.app.subMacOld'), none: t('settings.app.subUnsupported'),
      }[p];
      const chip = installed ? `<span class="status setchip">${I.check}${t('settings.app.chipOn')}</span>`
        : ['native', 'ios', 'iosOther'].includes(p) ? `<span class="status status--neutral setchip">${t('settings.app.chipOff')}</span>` : '';
      let acts = '';
      if (p === 'native') {
        acts = `<div class="app-acts"><button type="button" class="btn btn--tall" data-act="install" data-fk="set-install"${S.card === 'dialog' ? ' aria-disabled="true"' : ''}>${I.install}${t('install.card.install')}</button></div>
          ${S.setErr ? `<p class="app-err" role="alert">${I.warn}<span>${t('install.card.error')}</span></p>` : ''}`;
      } else if (p === 'ios' || p === 'iosOther') {
        acts = `<div class="app-acts"><button type="button" class="btn btn--tall toggle-btn" data-act="set-steps" data-fk="set-steps" aria-expanded="${S.setSteps}" aria-controls="${uid}-set-steps">${t(S.setSteps ? 'install.card.hideSteps' : 'install.card.how')}${I.down}</button></div>
          ${S.setSteps ? `<div class="app-steps">${guide(`${uid}-set-steps`, p === 'iosOther')}</div>` : ''}`;
      } else if (p === 'inapp') {
        acts = `<div class="app-acts"><button type="button" class="btn btn--tall" data-act="copy" data-fk="copy">${I.copy}${t('settings.app.copyLink')}</button></div>`;
      }
      return `<section class="sec" aria-labelledby="${uid}-app"><h2 class="sec-title" id="${uid}-app" tabindex="-1" data-fk="app-h">${t('settings.app.title')}</h2>
        <div class="plist"><div class="app-row">${tile()}<span class="app-row__title">${t(installed ? 'settings.app.rowInstalled' : 'settings.app.row')}</span>${chip}<span class="app-row__sub">${sub}</span></div></div>
        ${acts}</section>`;
    }
    function pushSection() {
      const head = `<h2 class="sec-title" id="${uid}-push" tabindex="-1" data-fk="push-h">${t('push.title')}</h2><p class="set-lead">${t('push.lead')}</p>`;
      let body;
      if (plat() === 'iosInApp') {
        body = `<div class="block push"><h3>${I.bellOff}${t('push.unsupported.title')}</h3><p>${t('push.unsupported.inapp')}</p></div>`;
      } else if (plat() === 'iosSafari' || plat() === 'iosOther') {
        // The guide now lives once, in App; Notifications keeps its title and body and points there (spec §3.4).
        body = `<div class="gh push push--guide"><div class="gh__row"><span class="gh__mark" aria-hidden="true">${I.addSquare}</span><h3 class="gh__title">${t('push.install.title')}</h3></div>
          <p class="gh__body">${t('push.install.body')}</p>
          <div class="gh__actions"><button type="button" class="btn btn--tall" data-act="go-app" data-fk="go-app">${t('push.install.goToApp')}</button></div></div>`;
      } else {
        body = `<div class="gh push"><div class="gh__row"><span class="gh__mark gh__mark--none" aria-hidden="true">${I.bellOff}</span><h3 class="gh__title">${t('push.off.title')}</h3></div>
          <p class="gh__body">${t('push.off.body')}</p><div class="gh__actions"><button type="button" class="btn btn--primary btn--tall" data-act="enable">${I.bell}<span>${t('push.enable')}</span></button></div></div>`;
      }
      return `<section class="sec" aria-labelledby="${uid}-push">${head}${body}</section>`;
    }
    function settingsScreen() {
      return `<div class="set-head"><h1 tabindex="-1" data-fk="h1">${t('settings.title')}</h1></div>
        <section class="sec" aria-labelledby="${uid}-gh"><h2 class="sec-title" id="${uid}-gh">${t('settings.gh.title')}</h2>
          <div class="gh gh--ok"><div class="gh__row"><span class="gh__mark" aria-hidden="true">${I.check}</span><p class="gh__title">${t('settings.gh.connected')}</p></div></div></section>
        ${appSection()}${pushSection()}
        <section class="sec" aria-labelledby="${uid}-pj"><h2 class="sec-title" id="${uid}-pj">${t('settings.projects.title')}</h2><p class="set-lead">${t('settings.projects.lead')}</p></section>`;
    }

    /* ----- chrome ----- */
    const titleOf = () => ({ settings: t('shell.settings'), needs: t('shell.needsYou'), space: 'storify' }[S.screen]);
    function chrome() {
      const isAndroid = plat() === 'android' || plat() === 'androidNoEvent';
      const isIos = plat() === 'iosSafari' || plat() === 'iosOther';
      if (isPhone) {
        $('[data-slot=crbar]').innerHTML = isAndroid
          ? `<div class="crbar" role="group" aria-label="${esc(t('sys.chrome.aria'))}"><span class="crbar__url">${I.lock}${HOST}</span><span class="crbar__btn" aria-hidden="true">${I.moreV}</span></div>` : '';
        const sw = S.screen === 'space'
          ? `<span class="prod-mono" aria-hidden="true">s</span><span class="p-switch__txt"><b>storify</b></span>`
          : `<span class="p-switch__txt"><b>${esc(titleOf())}</b></span>`;
        $('[data-slot=phead]').innerHTML = `<header class="p-head"><button type="button" class="p-switch" data-act="go" data-to="needs" aria-haspopup="dialog" aria-label="${esc(t('shell.openSwitcher'))}">${sw}${I.down}</button>
          <button type="button" class="icon-btn" data-act="go" data-to="settings" aria-label="${t('shell.settings')}"${S.screen === 'settings' ? ' aria-current="page"' : ''}>${I.gear}</button></header>`;
        $('[data-slot=tabs]').innerHTML = S.screen === 'space'
          ? `<nav class="tabs" aria-label="${t('space.sections')}">${TABS.map(([k, ico]) => `<button type="button" data-act="${k === 'board' ? 'noop' : 'answer'}"${k === 'board' ? ' aria-current="page"' : ''}>${ico}<span>${t(`space.${k}`)}</span></button>`).join('')}</nav>` : '';
        $('[data-slot=safari]').innerHTML = isIos
          ? `<div class="safari" role="group" aria-label="${esc(t('sys.safari.aria'))}"><span class="safari__btn" aria-hidden="true">${I.back}</span><span class="safari__url">${HOST}</span><span class="safari__btn" aria-hidden="true">${plat() === 'iosOther' ? I.share : I.more}</span></div>` : '';
        host.classList.toggle('has-tabs', S.screen === 'space');
        host.classList.toggle('has-browser-bar', isIos);
        return;
      }
      $('[data-slot=winbar]').innerHTML = `<span class="lights" aria-hidden="true"><i></i><i></i><i></i></span>${inBrowser()
        ? `<span class="win__url" role="group" aria-label="${esc(t('sys.chrome.aria'))}">${I.lock}${HOST}</span>` : `<span class="win__title">Team Console</span>`}`;
      const cur = (s) => (S.screen === s ? ' aria-current="page"' : '');
      $('[data-slot=side]').innerHTML = `<div class="brand">${I.mark}<span>Team Console</span></div>
        <ul class="side-list side-list--top">
          <li><button type="button" class="side-item side-item--needs" data-act="go" data-to="needs"${cur('needs')}>${I.inbox}<span>${t('shell.needsYou')}</span><span class="count" aria-hidden="true">${NEEDS}</span>${sr(t('shell.badge', { n: NEEDS }))}</button></li>
          <li><button type="button" class="side-item" data-act="answer">${I.grid}<span>${t('shell.overview')}</span></button></li></ul>
        <div class="side-label">${t('shell.projects')}</div>
        <ul class="side-list">${['storify', 'team-console', 'fieldnote'].map((s) => `<li><button type="button" class="side-item"${S.screen === 'space' && s === 'storify' ? ' aria-current="page"' : ''} data-act="${s === 'storify' ? 'go' : 'answer'}" data-to="space"><span class="prod-mono" aria-hidden="true">${s[0]}</span><span class="side-prod__label">${s}</span></button></li>`).join('')}</ul>
        <div class="side-foot"><button type="button" class="side-item side-item--settings" data-act="go" data-to="settings"${cur('settings')}>${I.gear}<span>${t('shell.settings')}</span></button></div>`;
      $('[data-slot=crumbs]').innerHTML = S.screen === 'space' ? `<ol><li>storify</li><li aria-current="page">${t('space.board')}</li></ol>` : `<ol><li aria-current="page">${esc(titleOf())}</li></ol>`;
    }

    function render(opts = {}) {
      chrome();
      $('[data-slot=screen]').innerHTML = { settings: settingsScreen, needs: needsScreen, space: spaceScreen }[S.screen]();
      S.fresh = false; S.landed = false;
      if (opts.focus) focusOn(opts.focus);
    }

    /* ----- focus and the review aid that marks where it landed ----- */
    function focusOn(fk) {
      const el = host.querySelector(`[data-fk="${fk}"]`); if (!el) return;
      el.focus({ preventScroll: true });
      if (fk === 'app-h') el.scrollIntoView({ block: 'start' });
      markFocus(el);
    }
    function markFocus(el) {
      host.querySelectorAll('.is-focus-demo').forEach((x) => x.classList.remove('is-focus-demo'));
      host.querySelectorAll('.focus-tag').forEach((x) => x.remove());
      // A heading hidden on the phone (the space title) is shown through the top bar that names the same place.
      const shown = el.classList.contains('sr-only') ? $('.p-switch') : el;
      if (!shown) return;
      shown.classList.add('is-focus-demo');
      const tag = document.createElement('span');
      tag.className = 'focus-tag'; tag.setAttribute('aria-hidden', 'true'); tag.textContent = t('demo.focus');
      const hb = host.getBoundingClientRect(); const eb = shown.getBoundingClientRect();
      const z = parseFloat(getComputedStyle(host.closest('.mac-frame') || host).zoom) || 1;
      tag.style.left = `${(eb.right - hb.left) / z - 56}px`; tag.style.top = `${(eb.top - hb.top) / z - 10}px`;
      host.appendChild(tag);
      el.addEventListener('blur', () => { shown.classList.remove('is-focus-demo'); tag.remove(); }, { once: true });
    }

    /* ----- feedback ----- */
    const announce = (txt) => { const l = $('[data-slot=live]'); l.textContent = ''; setTimeout(() => { l.textContent = txt; }, 30); };
    let toastTimer;
    function toast(txt) {
      const el = $('[data-slot=toast]'); el.textContent = txt; el.hidden = false; S.toastMsg = txt;
      play(el, isReduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: ms('--dur-fast'), easing: cssVar('--ease-enter') });
      clearTimeout(toastTimer); if (!HOLD_TOAST) toastTimer = setTimeout(() => { el.hidden = true; }, ms('--dur-toast'));
    }
    const bg = (on) => host.querySelectorAll('[data-bg]').forEach((el) => { el.inert = on; });

    /* ----- memory: tc.install-prompt.v1, device-local ----- */
    function snoozed() {
      const m = S.mem; if (!m) return false;
      if (m.choice === 'never') return true;
      const left = m.until - G.clock;
      return left > 0 && left <= SNOOZE_DAYS * DAY; // a date in the past or past 14 days (clock moved) has expired
    }
    function choose(choice) {
      S.mem = choice === 'never' ? { choice } : { choice: 'snoozed', until: G.clock + SNOOZE_DAYS * DAY };
      S.answered = true; S.ignored = 0; syncMem();
    }

    /* ----- one app launch (spec §3): the card is offered on every launch with a working session until answered ----- */
    function launch(opts = {}) {
      if (S.shownThisLaunch && !S.answered) S.ignored += 1;
      if (G.policy === 'three' && S.ignored >= IGNORE_LIMIT && !snoozed()) { S.mem = { choice: 'snoozed', until: G.clock + SNOOZE_DAYS * DAY, auto: true }; S.ignored = 0; }
      Object.assign(S, { screen: opts.screen || 'needs', card: 'hidden', steps: false, setSteps: false, setErr: false, answered: false, shownThisLaunch: false, nudge: true, nudgeHeld: false, lateArmed: false, toastMsg: '' });
      // After installing from a tab, the next launch in that tab gets no install event: the browser-menu path.
      S.eventKept = !S.installedNow;
      S.installedNow = false;
      S.cardScreen = S.screen;
      // The card belongs to the landing screen (Needs you or the restored space), never to Settings.
      const eligible = S.screen !== 'settings' && CARD_PATHS.includes(path()) && !snoozed();
      if (eligible && opts.late) { S.lateArmed = true; S.nudgeHeld = true; }
      else if (eligible) { S.card = 'offer'; S.shownThisLaunch = true; S.fresh = true; }
      $('[data-slot=toast]').hidden = true;
      syncMem();
      render();
    }

    /* ----- the browser's install window (a mock of Chrome, never our UI) ----- */
    let opener = null;
    function openDialog(fk) {
      opener = fk; bg(true);
      render({ focus: fk });
      $('[data-slot=overlay]').innerHTML = `<div class="sysmodal${isPhone ? '' : ' sysmodal--mac-inst'}"><div class="sysmodal__scrim"></div>
        <div class="sysinst" role="dialog" aria-modal="true" aria-labelledby="${uid}-sd"><p class="sysprompt__mock">${t('sys.mock')}</p><h2 id="${uid}-sd">${t('sys.inst.title')}</h2>
          <div class="sysinst__app">${tile(' app-tile--lg')}<div><b>${APP}</b><span>${HOST}</span></div></div>
          <div class="sysinst__acts"><button type="button" data-act="choice" data-v="dismissed">${t('sys.inst.cancel')}</button><button type="button" data-act="choice" data-v="accepted" data-fk="sys-ok">${t('sys.inst.install')}</button></div></div></div>`;
      const box = $('.sysinst');
      play(box, isReduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: ms('--dur-base'), easing: cssVar('--ease-enter') });
      box.querySelector('[data-fk=sys-ok]').focus();
    }
    function closeDialog() { bg(false); $('[data-slot=overlay]').innerHTML = ''; }
    function install(fk) {
      if (G.prompt === 'throws') {
        if (fk === 'set-install') { S.setErr = true; render({ focus: fk }); } else { S.card = 'error'; render({ focus: fk }); }
        return;
      }
      S.setErr = false;
      if (S.card === 'error') S.card = 'offer';
      if (fk === 'main') S.card = 'dialog';
      openDialog(fk);
    }
    function onChoice(v) {
      closeDialog();
      S.eventKept = false; // prompt() can be called once per event
      if (v === 'accepted') {
        S.installedNow = true; S.answered = true;
        if (opener === 'main') { S.card = 'done'; S.landed = true; render({ focus: 'done' }); } else { S.card = S.card === 'dialog' ? 'hidden' : S.card; render({ focus: 'app-h' }); }
        announce(t('install.doneLive', { app: APP }));
        syncMem();
        return;
      }
      // Declined in the card's window: the same as Not now. Declined from Settings: the event is spent, nothing stored.
      if (opener === 'main') { choose('later'); S.card = 'hidden'; render({ focus: 'h1' }); toast(t('install.toast')); } else render({ focus: 'app-h' });
    }

    function go(to) {
      if (to === S.screen) return;
      // Leaving the landing screen unanswered hides the card for this launch only; a late event shows on this new screen.
      if (S.card !== 'hidden' && S.card !== 'done') S.card = 'gone';
      if (S.card === 'done') S.card = 'hidden';
      S.screen = to;
      if (S.lateArmed) { S.lateArmed = false; S.card = 'offer'; S.cardScreen = to; S.shownThisLaunch = true; S.fresh = true; }
      render({ focus: 'h1' });
    }

    host.onclick = (e) => {
      const el = e.target.closest('[data-act]'); if (!el || !host.contains(el)) return;
      if (el.getAttribute('aria-disabled') === 'true') return;
      switch (el.dataset.act) {
        case 'install': install(el.dataset.fk); break;
        case 'choice': onChoice(el.dataset.v); break;
        case 'steps': S.steps = !S.steps; render({ focus: 'main' }); break;
        case 'set-steps': S.setSteps = !S.setSteps; render({ focus: 'set-steps' }); break;
        case 'later': choose('later'); S.card = 'hidden'; render({ focus: 'h1' }); toast(t('install.toast')); break;
        case 'never': choose('never'); S.card = 'hidden'; render({ focus: 'h1' }); toast(t('install.toast')); break;
        case 'done-x': S.card = 'hidden'; render({ focus: 'h1' }); break;
        case 'go-app': S.setSteps = true; render({ focus: 'app-h' }); break;
        case 'nudge-how': S.screen = 'settings'; S.setSteps = true; render({ focus: 'app-h' }); break;
        case 'nudge-later': S.nudge = false; render({ focus: 'h1' }); toast(t('nudge.laterToast')); break;
        case 'copy': toast(t('settings.app.copied')); break;
        case 'enable': toast(t('demo.enable')); break;
        case 'go': go(el.dataset.to); break;
        case 'answer': toast(t('demo.answer')); break;
        default: break;
      }
    };
    host.onkeydown = (e) => {
      if (!$('.sysinst')) return;
      if (e.key === 'Escape') { e.preventDefault(); onChoice('dismissed'); return; }
      if (e.key === 'Tab') {
        const f = [...host.querySelectorAll('.sysinst button')]; const i = f.indexOf(document.activeElement);
        e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
    };

    const app = { render, launch, S, install, onChoice, go, focusOn, toast, choose, openDialog };
    host.app = app;
    return app;
  }

  /* ---------- page controls ---------- */
  const sel = (id) => document.getElementById(id);
  function syncMem() {
    if (!memOut) return;
    memOut.innerHTML = hosts.map((h) => {
      const S = h.S; if (!S) return '';
      const m = S.mem;
      const v = m ? `<code>${esc(JSON.stringify(m.choice === 'never' ? { choice: 'never' } : { choice: 'snoozed', until: new Date(m.until).toISOString().slice(0, 10) }))}</code>` : t('demo.memNone');
      return `<span><b>${h.dataset.app === 'phone' ? t('demo.phone') : t('demo.mac')}</b> ${v} · ${t('demo.ignored', { n: S.ignored })}</span>`;
    }).join(' &nbsp; ');
  }
  function mountAll(keep) {
    hosts.forEach((h) => { const prev = keep && h.S ? h.S : null; h.className = 'app'; mountApp(h, h.dataset.app, prev); });
    hosts.forEach((h) => h.app.render());
    syncMem();
  }
  const pageChrome = Proto.page({ L, title: 'Team Console · #761', onLang: () => mountAll(true) });

  const PRESETS = {
    offer: { phone: 'android', mac: 'chrome' }, offerSpace: { phone: 'android', mac: 'chrome', screen: 'space' },
    dialog: { phone: 'android', mac: 'chrome', then: (a) => a.install('main') },
    done: { phone: 'android', mac: 'chrome', then: (a) => { a.install('main'); a.onChoice('accepted'); } },
    dismissed: { phone: 'android', mac: 'chrome', then: (a) => { a.install('main'); a.onChoice('dismissed'); } },
    error: { phone: 'android', mac: 'chrome', prompt: 'throws', then: (a) => a.install('main') },
    ios: { phone: 'iosSafari', mac: 'safari' },
    iosGuide: { phone: 'iosSafari', mac: 'safari', then: (a, k) => { if (k === 'phone') { a.S.steps = true; a.render({ focus: 'main' }); } } },
    iosOther: { phone: 'iosOther', mac: 'safari', then: (a, k) => { if (k === 'phone') { a.S.steps = true; a.render({ focus: 'main' }); } } },
    later: { phone: 'android', mac: 'chrome', then: (a) => clickIn(a, 'later') },
    never: { phone: 'iosSafari', mac: 'safari', then: (a) => clickIn(a, 'never') },
    nextLaunch: { phone: 'iosSafari', mac: 'chrome', then: (a) => { clickIn(a, 'later'); a.launch(); } },
    late: { phone: 'android', mac: 'chrome', late: true },
    standalone: { phone: 'standalone', mac: 'standalone' },
    setNative: { phone: 'android', mac: 'chrome', screen: 'settings' },
    setMenu: { phone: 'androidNoEvent', mac: 'chromeNoEvent', screen: 'settings' },
    setIos: { phone: 'iosSafari', mac: 'safari', screen: 'settings' },
    setIosOpen: { phone: 'iosSafari', mac: 'safari', screen: 'settings', then: (a, k) => { if (k === 'phone') clickIn(a, 'go-app'); } },
    setInApp: { phone: 'iosInApp', mac: 'safariOld', screen: 'settings' },
    setOther: { phone: 'iosOther', mac: 'firefox', screen: 'settings' },
    setJust: { phone: 'android', mac: 'chrome', screen: 'settings', then: (a) => { a.install('set-install'); a.onChoice('accepted'); } },
    setStandalone: { phone: 'standalone', mac: 'standalone', screen: 'settings' },
    setError: { phone: 'android', mac: 'chrome', screen: 'settings', prompt: 'throws', then: (a) => a.install('set-install') },
  };
  function clickIn(a, act) {
    const h = hosts.find((x) => x.app === a); const b = h && h.querySelector(`[data-act="${act}"]`); if (b) b.click();
  }
  function applyState(v) {
    const p = PRESETS[v]; if (!p) return;
    Object.assign(G, { phone: p.phone, mac: p.mac, prompt: p.prompt || 'opens', clock: Date.now() });
    syncDemo();
    mountAll(false);
    hosts.forEach((h) => {
      const a = h.app;
      a.launch({ screen: p.screen, late: p.late });
      if (p.then) p.then(a, h.dataset.app);
    });
    syncMem();
  }
  function syncDemo() { sel('d-phone').value = G.phone; sel('d-mac').value = G.mac; sel('d-prompt').value = G.prompt; sel('d-policy').value = G.policy; }
  sel('d-state').addEventListener('change', (e) => applyState(e.target.value));
  sel('d-phone').addEventListener('change', (e) => { G.phone = e.target.value; hosts.find((h) => h.dataset.app === 'phone').app.launch(); });
  sel('d-mac').addEventListener('change', (e) => { G.mac = e.target.value; hosts.find((h) => h.dataset.app === 'mac').app.launch(); });
  sel('d-prompt').addEventListener('change', (e) => { G.prompt = e.target.value; });
  sel('d-policy').addEventListener('change', (e) => { G.policy = e.target.value; });
  sel('d-launch').addEventListener('click', () => hosts.forEach((h) => h.app.launch()));
  sel('d-days').addEventListener('click', () => { G.clock += 15 * DAY; hosts.forEach((h) => h.app.launch()); });
  document.querySelector('[data-reset]').addEventListener('click', () => { G.policy = 'three'; sel('d-state').value = 'offer'; applyState('offer'); });

  // ?state=…&view=…&theme=…&lang=…&motion=…&scroll=<data-fk>&shot=1 opens a state directly (used for the screenshots).
  const q = new URLSearchParams(location.search);
  if (q.has('shot')) Proto.root.dataset.shot = '';
  if (q.get('lang') === 'en' || q.get('lang') === 'ru') { L.save(q.get('lang')); pageChrome.setControl('lang', q.get('lang')); }
  ['view', 'theme', 'motion'].forEach((k) => { if (q.get(k)) pageChrome.setControl(k, q.get(k)); });
  const st = q.get('state') || 'offer';
  sel('d-state').value = st;
  applyState(st);
  if (q.get('scroll')) hosts.forEach((h) => { const el = h.querySelector(`[data-fk="${q.get('scroll')}"]`); if (el) el.scrollIntoView({ block: 'start' }); });
  pageChrome.fit();
})();
