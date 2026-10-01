/* #36 Web push client. Design prototype runtime with mock data only: no service worker, no Notification API, no
   network. The real client reads `swPush.subscription` and `Notification.permission` on load, asks for permission
   only from the button's click handler, then PUTs the subscription (#11). Two independent devices (iPhone, Mac):
   each has its own permission and subscription, as real devices do; the demo bar sets the platform and the server. */
(() => {
  'use strict';
  const { isReduced, cssVar, ms, wait, esc, play, plain, I } = Proto;
  const L = Proto.i18n(I18N);
  const { t } = L;

  /* ---------- icons this feature adds to the kit (24 grid, 1.8 stroke, as icon.ts) ---------- */
  const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const J = {
    bell: svg('<path d="M6 16.5V11a6 6 0 0112 0v5.5l1.5 2h-15zM10 20.5a2 2 0 004 0"/>'),
    'bell-off': svg('<path d="M8.2 6.2A6 6 0 0118 11v3.5M6 11v5.5l-1.5 2h12M10 20.5a2 2 0 004 0M4 4l16 16"/>'),
    share: svg('<path d="M12 3.5v11M8 7.5l4-4 4 4M8.5 10.5h-2a1 1 0 00-1 1v8a1 1 0 001 1h11a1 1 0 001-1v-8a1 1 0 00-1-1h-2"/>'),
    more: svg('<path class="ico-dots" d="M6.5 12h.01M12 12h.01M17.5 12h.01"/>'),
    'add-square': svg('<rect x="4.5" y="4.5" width="15" height="15" rx="3.5"/><path d="M12 8.5v7M8.5 12h7"/>'),
  };

  /* ---------- mock data ---------- */
  const HOST = 'team-console-dev.example.workers.dev';
  const NEEDS = 3;
  const minsAgo = (m) => new Date(Date.now() - m * 60000);
  const dateFmt = () => new Intl.DateTimeFormat(L.lang === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'long' });
  // The payload's onActionClick url is built by the Worker as a relative /p/{slug}/questions#{n} (#11, threat row 6).
  const TARGETS = {
    open: { slug: 'storify', n: 42, url: '/p/storify/questions#42' },
    answered: { slug: 'storify', n: 45, url: '/p/storify/questions#45' },
    closed: { slug: 'storify', n: 39, url: '/p/storify/questions#39' },
    archived: { slug: 'oldmap', n: 7, url: '/p/oldmap/questions#7' },
  };
  const TEST = { url: '/needs-you' };
  const Q = [
    { n: 42, kind: 'question', rec: 'GitHub', acts: [['q.approve', 'GitHub'], ['q.reject', null]] },
    { n: 45, kind: 'design', answered: true },
    { n: 47, kind: 'release', acts: [['q.go'], ['q.nogo']] },
  ];
  // Shared by both frames: the demo bar.
  const G = { phone: 'safari', mac: 'safari', perm: 'default', result: 'ok', target: 'open', screen: 'settings' };
  const offline = () => G.result === 'offline';

  const hosts = [...document.querySelectorAll('[data-app]')];
  const status = document.getElementById('d-opened');

  /* ---------- one device ---------- */
  function mountApp(host, kind, keep) {
    const fresh = () => ({ screen: G.screen, perm: G.perm === 'on' ? 'granted' : G.perm, sub: G.perm === 'on', since: minsAgo(60 * 24 * 2), busy: null, res: null, nudge: true, nudgeOn: false, checking: true, prompt: false, testAt: 0, mark: false, arrive: null, loading: false });
    const S = keep || fresh();
    host.S = S;
    const uid = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const $ = (s) => host.querySelector(s);
    const isPhone = kind === 'phone';

    /* What this device can do. iOS: push needs the Home Screen app (iOS 16.4+); Mac browsers push in a tab. */
    function support() {
      if (isPhone) return { safari: 'install', app: 'ok', old: 'old', inapp: 'inapp' }[G.phone];
      return G.mac === 'old' ? 'browser' : 'ok';
    }
    function state() {
      const s = support();
      if (s === 'install') return 'install';
      if (s !== 'ok') return 'unsupported';
      if (S.checking) return 'checking';
      if (S.perm === 'denied') return 'denied';
      return S.sub ? 'on' : 'off';
    }
    const inSafari = () => isPhone && G.phone === 'safari' && S.screen !== 'home';

    host.innerHTML = isPhone
      ? `<div class="p-status" aria-hidden="true"><span>9:41</span><span class="p-island"></span><span class="p-status__icons">${I.bars}${I.battery}</span></div>
        <div data-slot="phead" data-bg></div>
        <div class="p-scroll" data-bg data-slot="scroll"><div class="set-inner" data-slot="screen"></div></div>
        <div data-slot="safari" data-bg></div>
        <div class="home-ind" aria-hidden="true"></div>
        <div data-slot="overlay"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`
      : `<div class="win">
          <div class="win__bar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="win__title">Team Console</span></div>
          <div class="win__body">
            <nav class="sidebar" aria-label="${t('shell.nav')}" data-bg data-slot="side"></nav>
            <section class="set-main" aria-label="Team Console" data-bg>
              <header class="convo__head"><nav class="crumbs" aria-label="${t('shell.crumbs')}" data-slot="crumbs"></nav></header>
              <div class="set-scroll" data-slot="scroll"><div class="set-inner" data-slot="screen"></div></div>
            </section>
          </div>
        </div>
        <div data-slot="overlay"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`;

    const dis = (on, reasonId) => (on ? ` aria-disabled="true"${reasonId ? ` aria-describedby="${reasonId}"` : ''}` : '');
    const sr = (txt) => `<span class="sr-only">${txt}</span>`;

    /* ----- the Notifications block ----- */
    function enableBtn(fk, cls = 'btn btn--primary btn--tall') {
      const busy = S.busy === 'asking' || S.busy === 'saving';
      const label = S.busy === 'asking' ? t('push.asking') : S.busy === 'saving' ? t('push.saving') : t('push.enable');
      return `<button type="button" class="${cls}" data-act="enable" data-fk="${fk}"${dis(busy || offline(), offline() ? `${uid}-off` : '')}>${busy ? Proto.dots : J.bell}<span>${label}</span></button>`;
    }
    const offNote = () => (offline() ? `<p class="push__note" id="${uid}-off">${I.wifi}<span>${t('push.offline')}</span></p>` : '');
    function resNote() {
      const r = S.res; if (!r) return '';
      if (r.kind === 'error') return `<div class="res res--bad" role="alert"><h3 tabindex="-1" data-fk="res">${t('push.error.title')}</h3><p>${t('push.error.server')}</p></div>`;
      if (r.kind === 'sent') return `<div class="res"><h3 tabindex="-1" data-fk="res">${t('push.test.sent')}</h3><p>${t('push.test.sentBody', { n: r.n })}</p></div>`;
      if (r.kind === 'wait') return `<div class="res res--warn"><h3 tabindex="-1" data-fk="res">${t('push.test.wait', { s: r.s })}</h3></div>`;
      if (r.kind === 'testfail') return `<div class="res res--bad" role="alert"><h3 tabindex="-1" data-fk="res">${t('push.test.failed')}</h3></div>`;
      return '';
    }
    function pushBlock() {
      const st = state();
      const head = `<h2 class="sec-title" id="${uid}-push" tabindex="-1" data-fk="push-h">${t('push.title')}</h2><p class="set-lead">${t('push.lead')}</p>`;
      let card;
      if (st === 'checking') {
        card = `<div class="gh" aria-busy="true"><span class="sr-only">${t('push.checking')}</span><div class="gh__row" aria-hidden="true"><span class="skel skel--mono gh__skel"></span><span class="skel-stack"><span class="skel skel--a"></span><span class="skel skel--b"></span></span></div></div>`;
      } else if (st === 'install') {
        const more = `<span class="kbd-ico">${J.more}${sr(t('push.install.more'))}</span>`;
        const share = `<span class="kbd-ico">${J.share}${sr(t('push.install.share'))}</span>`;
        card = `<div class="gh push push--guide"><div class="gh__row"><span class="gh__mark" aria-hidden="true">${J['add-square']}</span><h3 class="gh__title" tabindex="-1" data-fk="state-h">${t('push.install.title')}</h3></div>
          <p class="gh__body">${t('push.install.body')}</p>
          <ol class="guide" aria-label="${esc(plain(t('push.install.steps')))}">
            <li class="guide__step"><span class="guide__n" aria-hidden="true">1</span><div><p>${t('push.install.s1').replace('{more}', more)}</p><p class="guide__aside">${t('push.install.s1note').replace('{share}', share)}</p></div></li>
            <li class="guide__step"><span class="guide__n" aria-hidden="true">2</span><div><p>${t('push.install.s2')}</p></div></li>
            <li class="guide__step"><span class="guide__n" aria-hidden="true">3</span><div><p>${t('push.install.s3')}</p></div></li>
          </ol>
          <p class="push__note">${t('push.install.already')}</p></div>`;
      } else if (st === 'unsupported') {
        const why = isPhone ? (G.phone === 'old' ? 'old' : 'inapp') : 'browser';
        card = `<div class="block push"><h3 tabindex="-1" data-fk="state-h">${J['bell-off']}${t('push.unsupported.title')}</h3><p>${t(`push.unsupported.${why}`)}</p></div>`;
      } else if (st === 'denied') {
        const how = isPhone ? t('push.denied.ios') : t(`push.denied.${G.mac}`, { host: HOST });
        card = `<div class="gh gh--warn push"><div class="gh__row"><span class="gh__mark" aria-hidden="true">${J['bell-off']}</span><h3 class="gh__title" tabindex="-1" data-fk="state-h">${t('push.denied.title')}</h3></div>
          <p class="gh__body">${t('push.denied.body')}</p><p class="push__path">${how}</p>
          <div class="gh__actions"><button type="button" class="btn btn--tall push__warn-btn" data-act="recheck" data-fk="recheck">${I.refresh}${t('push.recheck')}</button></div></div>`;
      } else if (st === 'on') {
        const testing = S.busy === 'testing';
        const badge = isPhone ? `<p class="push__badge"><span class="push__badge-dot" aria-hidden="true">${NEEDS}</span><span>${t('push.on.badge', { n: NEEDS })}</span></p>` : '';
        card = `<div class="gh gh--ok push"><div class="gh__row">
            <span class="gh__mark${S.mark ? ' is-new' : ''}" aria-hidden="true">${I.check}</span>
            <div class="gh__who"><h3 class="gh__title" tabindex="-1" data-fk="state-h">${t('push.on.title')}</h3><p class="gh__meta">${t('push.on.meta', { date: dateFmt().format(S.since) })}</p></div></div>
          ${badge}${resNote()}${offNote()}
          <div class="gh__actions"><button type="button" class="btn btn--tall" data-act="test" data-fk="test"${dis(testing || offline(), offline() ? `${uid}-off` : '')}>${testing ? Proto.dots : J.bell}<span>${testing ? t('push.testing') : t('push.test')}</span></button>
          <button type="button" class="btn btn--quiet btn--tall push__off" data-act="turn-off" data-fk="turn-off" aria-label="${esc(t('push.turnOffAria'))}"${dis(offline(), offline() ? `${uid}-off` : '')}>${t('push.turnOff')}</button></div></div>`;
        S.mark = false;
      } else {
        const hint = S.perm === 'granted' ? '' : `<p class="push__note">${t(isPhone ? 'push.hint.ios' : 'push.hint.browser')}</p>`;
        card = `<div class="gh push"><div class="gh__row"><span class="gh__mark gh__mark--none" aria-hidden="true">${J['bell-off']}</span><h3 class="gh__title" tabindex="-1" data-fk="state-h">${t('push.off.title')}</h3></div>
          <p class="gh__body">${t('push.off.body')}</p>${resNote()}${offNote()}
          <div class="gh__actions">${enableBtn('enable')}</div>${S.busy ? '' : hint}</div>`;
      }
      return `<section class="sec" aria-labelledby="${uid}-push" id="${uid}-push-sec">${head}${card}</section>`;
    }

    /* ----- screens ----- */
    function settingsScreen() {
      return `<div class="set-head"><h1 tabindex="-1" data-fk="h1">${t('settings.title')}</h1></div>
        <section class="sec" aria-labelledby="${uid}-gh"><h2 class="sec-title" id="${uid}-gh">${t('settings.gh.title')}</h2>
          <div class="gh gh--ok"><div class="gh__row"><span class="gh__mark" aria-hidden="true">${I.check}</span><p class="gh__title">${t('settings.gh.connected')}</p></div></div></section>
        ${pushBlock()}
        <section class="sec" aria-labelledby="${uid}-pj"><h2 class="sec-title" id="${uid}-pj">${t('settings.projects.title')}</h2><p class="set-lead">${t('settings.projects.lead')}</p></section>
        <section class="sec" aria-labelledby="${uid}-lang"><h2 class="sec-title" id="${uid}-lang">${t('settings.language')}</h2><div><button type="button" class="btn btn--tall" data-act="noop" lang="${L.lang === 'ru' ? 'en' : 'ru'}">${t('settings.switchLang')}</button></div></section>`;
    }
    function nudge() {
      if (S.nudgeOn) return `<div class="res push-nudge__done" role="status"><p>${t('nudge.on')}</p></div>`;
      const st = state();
      if (!S.nudge || (st !== 'off' && st !== 'install')) return '';
      const main = st === 'install'
        ? `<button type="button" class="btn btn--sm" data-act="how" data-fk="nudge-how">${t('nudge.how')}</button>`
        : enableBtn('nudge-enable', 'btn btn--primary btn--sm').replace(t('push.enable'), t('nudge.enable'));
      return `<aside class="push-nudge" aria-labelledby="${uid}-nudge"><span class="push-nudge__ico" aria-hidden="true">${J['bell-off']}</span>
        <p id="${uid}-nudge">${t('nudge.text')}</p>${S.res && S.res.kind === 'error' ? `<p class="push-nudge__err" role="alert">${t('push.error.title')}</p>` : ''}${offline() && st === 'off' ? `<p class="push__note" id="${uid}-off">${t('push.offline')}</p>` : ''}
        <div class="push-nudge__acts">${main}<button type="button" class="btn btn--quiet btn--sm" data-act="later" data-fk="nudge-later" aria-label="${esc(t('nudge.laterAria'))}">${t('nudge.later')}</button></div></aside>`;
    }
    const needRow = (q, slug) => `<li><button type="button" class="need" data-act="noop"><span class="need__top"><span class="ptag">${slug}</span><span class="need__kind">${t(`needs.kind.${q.kind}`)}</span></span><span class="need__title">${t(`q.${q.n}`)}</span>${I.chev}</button></li>`;
    function needsScreen() {
      return `<div class="set-head"><h1 tabindex="-1" data-fk="h1">${t('shell.needsYou')}</h1></div>${nudge()}
        <p class="needs__lead">${t('needs.lead')}</p>
        <ul class="needs__list">${needRow(Q[0], 'storify')}${needRow(Q[2], 'storify')}${needRow({ n: 51, kind: 'question' }, 'fieldnote')}</ul>`;
    }
    function card(q, target) {
      const here = target && target.n === q.n;
      if (q.answered) {
        return `<li><div class="receipt push-arrive${here ? ' is-arrived' : ''}" tabindex="-1" data-q="${q.n}"><span class="receipt__icon" aria-hidden="true">${I.check}</span><span class="receipt__body">${t('q.receipt')} · ${t('q.45')}</span></div></li>`;
      }
      const acts = q.acts.map(([k, x], i) => `<button type="button" class="btn${i === 0 ? ' btn--primary' : ''}" data-act="answer">${t(k)}${x ? ` · ${esc(x)}` : ''}</button>`).join('');
      return `<li><article class="card push-arrive${here ? ' is-arrived' : ''}" aria-labelledby="${uid}-q${q.n}" data-q="${q.n}">
        <div class="card__head"><span class="card__kind">${q.kind === 'release' ? I.play : I.q}${t(`needs.kind.${q.kind}`)}</span><span class="card__num">#${q.n}</span></div>
        <h2 class="card__title" id="${uid}-q${q.n}" tabindex="-1">${t(`q.${q.n}`)}</h2><p class="card__text">${t(`q.${q.n}.text`)}</p>
        ${q.rec ? `<p class="card__meta">${t('q.recommends', { x: q.rec })}</p>` : ''}<div class="card__actions">${acts}</div></article></li>`;
    }
    function spaceScreen() {
      const target = S.arrive;
      const h = `<div class="set-head"><h1 tabindex="-1" data-fk="h1">${t('shell.questions')}</h1></div>`;
      if (S.loading) return `${h}<div aria-busy="true"><span class="sr-only">${t('space.loading')}</span><div class="plist" aria-hidden="true">${'<div class="skel-row"><span class="skel skel--mono"></span><span class="skel-stack"><span class="skel skel--a"></span><span class="skel skel--b"></span></span></div>'.repeat(3)}</div></div>`;
      const gone = target && !Q.some((q) => q.n === target.n)
        ? `<div class="res res--neutral push-arrive is-arrived" tabindex="-1" data-q="${target.n}"><h2>${t('arrive.gone.title', { n: target.n })}</h2><p>${t('arrive.gone.body')}</p><a class="ext" href="https://github.com/geeera/storify/issues/${target.n}" target="_blank" rel="noopener noreferrer" data-act="gh">${t('arrive.gone.link', { n: target.n })}${sr(L.lang === 'ru' ? '(откроется на GitHub)' : '(opens on GitHub)')}${I.ext}</a></div>`
        : '';
      return `${h}${gone}<ul class="push-cards" aria-label="${t('shell.questions')}">${Q.map((q) => card(q, target)).join('')}</ul>`;
    }
    function notFoundScreen() {
      return `<div class="block push-arrive is-arrived" tabindex="-1" data-q="nf"><h1 class="push-nf">${t('notFound.title')}</h1><p>${t('notFound.body')}</p><button type="button" class="btn btn--tall" data-act="go" data-to="needs">${t('notFound.back')}</button></div>`;
    }
    function homeScreen() {
      const tiles = Array.from({ length: 11 }, (_, i) => `<span class="hs__tile" style="--h:${(i * 37) % 360}"></span>`);
      tiles.splice(5, 0, `<button type="button" class="hs__app" data-act="open-app" aria-label="${esc(t('sys.home.icon', { n: NEEDS }))}"><span class="hs__icon">${I.mark}<span class="hs__badge" aria-hidden="true">${NEEDS}</span></span><span class="hs__label" aria-hidden="true">Team Console</span></button>`);
      return `<section class="hs" aria-label="${esc(t('sys.home.aria'))}"><div class="hs__grid">${tiles.join('')}</div><p class="hs__note">${t('sys.home.note')}</p></section>`;
    }

    /* ----- chrome ----- */
    const titleOf = () => ({ settings: t('shell.settings'), needs: t('shell.needsYou'), space: 'storify', notfound: 'oldmap' }[S.screen] || 'Team Console');
    function chrome() {
      if (isPhone) {
        const head = $('[data-slot=phead]');
        head.innerHTML = S.screen === 'home' ? '' : `<header class="p-head"><button type="button" class="p-switch" data-act="noop" aria-haspopup="dialog" aria-label="${esc(t('shell.openSwitcher'))}"><span class="p-switch__txt"><b>${esc(titleOf())}</b></span>${I.down}</button>
          <button type="button" class="icon-btn" data-act="go" data-to="settings" aria-label="${t('shell.settings')}"${S.screen === 'settings' ? ' aria-current="page"' : ''}>${I.gear}</button></header>`;
        $('[data-slot=safari]').innerHTML = inSafari()
          ? `<div class="safari" role="group" aria-label="${esc(t('sys.safari.aria'))}"><span class="safari__btn" aria-hidden="true">${I.back}</span><span class="safari__url">${HOST}</span><span class="safari__btn safari__more${state() === 'install' && S.screen === 'settings' ? ' is-pointed' : ''}" aria-hidden="true">${J.more}</span></div>` : '';
        host.classList.toggle('is-home', S.screen === 'home');
        return;
      }
      const cur = (s) => (S.screen === s ? ' aria-current="true"' : '');
      $('[data-slot=side]').innerHTML = `<div class="brand">${I.mark}<span>Team Console</span></div>
        <ul class="side-list side-list--top">
          <li><button type="button" class="side-item side-item--needs" data-act="go" data-to="needs"${cur('needs')}>${I.inbox}<span>${t('shell.needsYou')}</span><span class="count" aria-hidden="true">${NEEDS}</span>${sr(t('shell.badge', { n: NEEDS }))}</button></li>
          <li><button type="button" class="side-item" data-act="noop">${I.grid}<span>${t('shell.overview')}</span></button></li></ul>
        <div class="side-label">${t('shell.projects')}</div>
        <ul class="side-list">${['storify', 'team-console', 'fieldnote'].map((s) => `<li><button type="button" class="side-item"${S.screen === 'space' && s === 'storify' ? ' aria-current="true"' : ''} data-act="noop"><span class="prod-mono" aria-hidden="true">${s[0]}</span><span class="side-prod__label">${s}</span></button></li>`).join('')}</ul>
        <div class="side-foot"><button type="button" class="side-item side-item--settings" data-act="go" data-to="settings"${S.screen === 'settings' ? ' aria-current="page"' : ''}>${I.gear}<span>${t('shell.settings')}</span></button></div>`;
      const crumbs = S.screen === 'space' ? `<ol><li>storify</li><li aria-current="page">${t('shell.questions')}</li></ol>` : `<ol><li aria-current="page">${esc(titleOf())}</li></ol>`;
      $('[data-slot=crumbs]').innerHTML = crumbs;
    }

    function render(opts = {}) {
      chrome();
      const screen = S.screen === 'home' && !isPhone ? 'settings' : S.screen;
      $('[data-slot=screen]').innerHTML = { settings: settingsScreen, needs: needsScreen, space: spaceScreen, notfound: notFoundScreen, home: homeScreen }[screen]();
      if (opts.focus) { const el = host.querySelector(`[data-fk="${opts.focus}"]`); if (el) el.focus({ preventScroll: !!opts.noScroll }); }
    }

    /* ----- feedback ----- */
    const announce = (txt) => { const l = $('[data-slot=live]'); l.textContent = ''; setTimeout(() => { l.textContent = txt; }, 30); };
    let toastTimer;
    function toast(txt) {
      const el = $('[data-slot=toast]'); el.textContent = txt; el.hidden = false;
      play(el, isReduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: ms('--dur-fast'), easing: cssVar('--ease-enter') });
      clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms('--dur-toast'));
    }
    const bg = (on) => host.querySelectorAll('[data-bg]').forEach((el) => { el.inert = on; });

    /* ----- the system permission prompt (a mock of iOS / the browser, never our UI) ----- */
    let promptOpener = null;
    function openPrompt(opener) {
      promptOpener = opener; S.prompt = true; bg(true);
      const title = isPhone ? t('sys.prompt.ios') : t('sys.prompt.mac', { host: HOST });
      const body = isPhone ? t('sys.prompt.iosBody') : t('sys.prompt.macBody');
      $('[data-slot=overlay]').innerHTML = `<div class="sysmodal sysmodal--${kind}"><div class="sysmodal__scrim"></div>
        <div class="sysprompt" role="alertdialog" aria-modal="true" aria-labelledby="${uid}-sp" aria-describedby="${uid}-spb">
          <p class="sysprompt__mock">${t('sys.mock')}</p><h2 id="${uid}-sp">${esc(title)}</h2><p id="${uid}-spb">${esc(body)}</p>
          <div class="sysprompt__acts"><button type="button" data-act="perm" data-v="denied">${t('sys.prompt.deny')}</button><button type="button" data-act="perm" data-v="granted" data-fk="allow">${t('sys.prompt.allow')}</button></div></div></div>`;
      const box = $('.sysprompt');
      play(box, isReduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'scale(1.06)' }, { opacity: 1, transform: 'none' }], { duration: ms('--dur-base'), easing: cssVar('--ease-enter') });
      box.querySelector('[data-fk=allow]').focus();
    }
    function closePrompt() { S.prompt = false; bg(false); $('[data-slot=overlay]').innerHTML = ''; }

    /* ----- actions ----- */
    // Permission is only ever requested here, from the button's own click (#11 AC, ADR 0001 decision 3).
    async function enable(fk) {
      if (offline()) { announce(t('push.offline')); return; }
      if (S.busy) return;
      S.res = null;
      if (S.perm === 'default') { S.busy = 'asking'; render({ focus: fk }); openPrompt(fk); return; }
      await save(fk);
    }
    async function onPermission(v) {
      closePrompt();
      S.perm = v;
      if (v === 'denied') {
        S.busy = null; render({ focus: S.screen === 'settings' ? 'state-h' : 'h1' });
        announce(t('push.deniedLive'));
        return;
      }
      await save(promptOpener);
    }
    async function save(fk) {
      S.busy = 'saving'; render({ focus: fk });
      await wait(700);
      S.busy = null;
      if (G.result === 'error') { S.res = { kind: 'error' }; render({ focus: S.screen === 'settings' ? 'res' : fk }); return; }
      S.sub = true; S.since = new Date(); S.mark = true;
      if (S.screen === 'needs') { S.nudgeOn = true; render({ focus: 'h1', noScroll: true }); } else render({ focus: 'state-h' });
      announce(t('push.onLive'));
    }
    async function test() {
      if (offline()) { announce(t('push.offline')); return; }
      if (S.busy) return;
      const since = Date.now() - S.testAt;
      S.busy = 'testing'; S.res = null; render({ focus: 'test' });
      await wait(800);
      S.busy = null;
      if (since < 30000) { S.res = { kind: 'wait', s: Math.ceil((30000 - since) / 1000) }; render({ focus: 'test' }); announce(plain(t('push.test.wait', { s: S.res.s }))); return; }
      if (G.result === 'error') { S.res = { kind: 'testfail' }; render({ focus: 'test' }); return; }
      S.testAt = Date.now();
      const n = Math.max(1, hosts.filter((h) => h.S && h.S.sub).length);
      S.res = { kind: 'sent', n }; render({ focus: 'test' }); announce(plain(t('push.test.sentBody', { n })));
      await wait(1200);
      hosts.forEach((h) => h.S && h.S.sub && h.app.notify({ title: t('sys.notif.test'), body: t('sys.notif.testBody'), url: TEST.url }));
    }
    function turnOff() {
      if (offline()) { announce(t('push.offline')); return; }
      S.sub = false; S.res = null; render({ focus: 'enable' }); toast(t('push.offToast'));
    }

    /* ----- a notification and where its tap leads ----- */
    let notifTimer;
    function notify(n) {
      const ov = $('[data-slot=overlay]');
      if (S.prompt) return;
      ov.innerHTML = `<button type="button" class="notif notif--${kind}" data-act="tap" data-url="${esc(n.url)}" aria-label="${esc(t('sys.notif.aria', { title: n.title, body: n.body }))}">
        <span class="notif__icon" aria-hidden="true">${I.mark}</span><span class="notif__txt" aria-hidden="true"><span class="notif__top"><b>${t('sys.notif.app')}</b><span>${t('sys.notif.now')}</span></span><b class="notif__title">${esc(n.title)}</b><span class="notif__body">${esc(n.body)}</span></span></button>`;
      const el = ov.firstElementChild;
      play(el, isReduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: `translateY(${isPhone ? '-16px' : '0'}) translateX(${isPhone ? '0' : '16px'})` }, { opacity: 1, transform: 'none' }], { duration: ms(isReduced() ? '--dur-fade' : '--dur-base'), easing: cssVar('--ease-enter') });
      clearTimeout(notifTimer); notifTimer = setTimeout(() => { if (el.isConnected && !el.contains(document.activeElement)) el.remove(); }, 8000);
    }
    // navigateLastFocusedOrOpen: the app comes to the front on the item's route; a cold start shows the list loading first.
    async function tap(url) {
      clearTimeout(notifTimer);
      $('[data-slot=overlay]').innerHTML = '';
      if (status) status.innerHTML = t('demo.opened', { url });
      if (isPhone && G.phone === 'safari') G.phone = 'app';
      if (url === TEST.url) { S.screen = 'needs'; S.arrive = null; render({ focus: 'h1' }); return; }
      const target = Object.values(TARGETS).find((x) => x.url === url);
      if (target.slug === 'oldmap') { S.screen = 'notfound'; S.arrive = target; render(); await arrive(); return; }
      S.screen = 'space'; S.arrive = target; S.loading = true; render();
      await wait(500);
      S.loading = false; render(); await arrive();
    }
    async function arrive() {
      const el = $('.push-arrive.is-arrived');
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: isReduced() ? 'auto' : 'smooth' });
      const focusEl = el.matches('article') ? el.querySelector('.card__title') : el;
      focusEl.focus({ preventScroll: true });
      // The ring stays while the item has focus, so the place is still marked after the pulse.
      el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('is-arrived'); });
    }

    host.onclick = (e) => {
      const el = e.target.closest('[data-act]'); if (!el || !host.contains(el)) return;
      if (el.getAttribute('aria-disabled') === 'true') { if (offline()) announce(t('push.offline')); return; }
      switch (el.dataset.act) {
        case 'enable': enable(el.dataset.fk); break;
        case 'perm': onPermission(el.dataset.v); break;
        case 'test': test(); break;
        case 'turn-off': turnOff(); break;
        case 'recheck': S.perm = 'granted'; S.res = null; render({ focus: 'state-h' }); announce(t('push.recheckLive')); break;
        case 'how': S.screen = 'settings'; render(); { const h = $('[data-fk=push-h]'); h.scrollIntoView({ block: 'start' }); h.focus({ preventScroll: true }); } break;
        case 'later': S.nudge = false; render({ focus: 'h1' }); toast(t('nudge.laterToast')); break;
        case 'go': S.screen = el.dataset.to; S.arrive = null; S.nudgeOn = false; render({ focus: 'h1' }); break;
        case 'open-app': G.phone = 'app'; S.screen = 'needs'; render({ focus: 'h1' }); syncDemo(); break;
        case 'tap': tap(el.dataset.url); break;
        case 'answer': toast(t('demo.answer')); break;
        case 'gh': e.preventDefault(); toast(t('demo.space')); break;
        case 'noop': toast(t('demo.space')); break;
        default: break;
      }
    };
    host.onkeydown = (e) => {
      if (!S.prompt) return;
      // A mock system alert: Esc answers "Don't Allow", Tab stays inside.
      if (e.key === 'Escape') { e.preventDefault(); onPermission('denied'); return; }
      if (e.key === 'Tab') {
        const f = [...host.querySelectorAll('.sysprompt button')];
        const i = f.indexOf(document.activeElement);
        e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
    };

    const app = {
      render, S, notify, tap,
      // the real client reads swPush.subscription and Notification.permission once on load: no prompt, no request
      settle: async () => { await wait(350); S.checking = false; render(); },
    };
    host.app = app;
    render();
    if (S.checking) app.settle();
    return app;
  }

  /* ---------- page controls ---------- */
  const mountAll = (keep) => hosts.forEach((h) => { const prev = keep && h.S ? h.S : null; h.className = 'app'; mountApp(h, h.dataset.app, prev); });
  const renderAll = () => hosts.forEach((h) => h.app && h.app.render());
  const pageChrome = Proto.page({ L, title: 'Team Console · #36', onLang: () => mountAll(true) });
  const sel = (id) => document.getElementById(id);
  function syncDemo() { sel('d-screen').value = G.screen; sel('d-phone').value = G.phone; sel('d-mac').value = G.mac; sel('d-perm').value = G.perm; sel('d-result').value = G.result; sel('d-target').value = G.target; }
  sel('d-screen').addEventListener('change', (e) => { G.screen = e.target.value; hosts.forEach((h) => { h.S.screen = h.dataset.app === 'mac' && G.screen === 'home' ? 'settings' : G.screen; h.S.arrive = null; h.S.nudgeOn = false; }); renderAll(); });
  sel('d-phone').addEventListener('change', (e) => { G.phone = e.target.value; renderAll(); });
  sel('d-mac').addEventListener('change', (e) => { G.mac = e.target.value; renderAll(); });
  sel('d-perm').addEventListener('change', (e) => { G.perm = e.target.value; hosts.forEach((h) => { Object.assign(h.S, { perm: G.perm === 'on' ? 'granted' : G.perm, sub: G.perm === 'on', res: null, busy: null }); }); renderAll(); });
  sel('d-result').addEventListener('change', (e) => { G.result = e.target.value; hosts.forEach((h) => { h.S.res = null; }); renderAll(); });
  sel('d-target').addEventListener('change', (e) => { G.target = e.target.value; });
  sel('d-push').addEventListener('click', () => {
    const x = TARGETS[G.target];
    const title = t('sys.notif.title', { project: x.slug });
    const body = x.slug === 'oldmap' ? `#${x.n} ${L.lang === 'ru' ? 'Выбрать карту по умолчанию' : 'Pick the default map'}` : `#${x.n} ${plain(t(`q.${x.n === 39 ? 51 : x.n}`))}`;
    hosts.forEach((h) => h.app.notify({ title, body, url: x.url }));
  });
  document.querySelector('[data-reset]').addEventListener('click', () => { Object.assign(G, { phone: 'safari', mac: 'safari', perm: 'default', result: 'ok', target: 'open', screen: 'settings' }); if (status) status.textContent = ''; syncDemo(); mountAll(false); });
  mountAll(false);
  syncDemo();
  pageChrome.fit();
})();
