/* #750 Environment setup per project. Design prototype runtime with mock data only; the real app asks the
   presence-only endpoint scoped to one project (`?project=<slug>`, booleans only) and renders the guides from the
   manifest. Three places: the project's own environment screen under project setup, the setup page's new row, and
   the operator's console screen at /admin/environment/:env (the #104 screen without the projects group). Two
   independent instances (iPhone, Mac) share the demo controls and the environment's state. */
(() => {
  'use strict';
  const { isReduced, wait, esc, plain, I, dots } = Proto;
  const L = Proto.i18n(I18N);
  const { t, hhmm } = L;
  const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const IX = {
    ...I,
    eye: svg('<path d="M3.5 12s3-6 8.5-6 8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6z"/><circle cx="12" cy="12" r="2.5"/>'),
    eyeOff: svg('<path d="M3.5 12s3-6 8.5-6 8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6z"/><circle cx="12" cy="12" r="2.5"/><path d="M4.5 4.5l15 15"/>'),
    laptop: svg('<rect x="5" y="5.5" width="14" height="9.5" rx="1.5"/><path d="M3 18.5h18"/>'),
    bell: svg('<path d="M6.5 16.5V11a5.5 5.5 0 0111 0v5.5l1.5 1.5h-14z"/><path d="M10 20.5h4"/>'),
    server: svg('<rect x="4" y="4.5" width="16" height="6" rx="1.5"/><rect x="4" y="13.5" width="16" height="6" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01"/>'),
  };
  const lang = () => L.lang;
  const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

  /* ---------- the project and its manifest rows (three patterns, all production, all on the api Worker) ---------- */
  const PROJECT = { slug: 'storify', name: 'storify', repo: 'geeera/storify' };
  const PROJECTS = [PROJECT, { slug: 'team-console', name: 'team-console' }];
  const SLUG = PROJECT.slug.toUpperCase().replace(/-/g, '_');
  const SLOTS = ['PM', 'DEV', 'QA'];
  const ENVS = ['dev', 'stage', 'production', 'local'];
  const ALL3 = ['dev', 'stage', 'production'];
  const ROW_ENVS = ['production'];
  function projectRows() {
    if (D.empty) return [];
    const out = [{ id: 'R', n: `ROUTINE_TOKEN_${SLUG}`, g: 'routine' }];
    for (const sl of SLOTS) {
      out.push({ id: `T:${sl}`, n: `SLOT_TOKEN_${SLUG}_${sl}`, g: 'slotToken', slot: sl, opt: true });
      out.push({ id: `I:${sl}`, n: `SLOT_ROUTINE_${SLUG}_${sl}`, g: 'slotId', slot: sl, opt: true });
    }
    return out.map((r) => ({ ...r, k: 'secret', p: 'project', src: 'owner', who: 'api', envs: ROW_ENVS, proj: PROJECT }));
  }
  // Manifest prose is Russian only (spec §9): the guide keeps lang="ru" and says so in English.
  const PG = {
    routine: { purpose: 'Bearer-токен API-триггера рутины PM проекта {project}. Им консоль будит PM, когда вы пишете в чат.',
      impact: 'PM проекта {project} не отвечает в чате.',
      where: [['Откройте claude.ai/code/routines → рутину PM проекта {project}.', 'https://claude.ai/code/routines'], ['Добавьте триггер: Add trigger → API.'], ['Скопируйте токен: Claude показывает его один раз.']],
      life: 'Живёт, пока вы не удалите триггер. Если токен утёк, создайте новый триггер и задайте токен командой замены ниже — старый просто перестанет работать.',
      gotchas: ['Имя секрета строится из slug проекта заглавными буквами, «-» становится «_»: {slug} → {name}.', 'Обычно нужен только в production: dev и stage не управляют настоящими проектами.'] },
    slotToken: { purpose: 'Bearer-токен API-триггера рутины «{slot}» проекта {project} — для «Запустить сейчас».',
      impact: 'В пространстве проекта «Запустить сейчас» для «{slot}» показывает карточку настройки вместо запуска. Пауза и возобновление работают и без него.',
      where: [['Откройте claude.ai/code/routines → рутину slot-{slotLow} проекта {project}.', 'https://claude.ai/code/routines'], ['Добавьте API-триггер; токен (sk-ant-oat01-…) Claude показывает один раз.']],
      life: 'Живёт, пока вы не удалите триггер. Если токен утёк, создайте новый API-триггер.',
      gotchas: ['Задаётся парой с {pair}: без id рутины токен не используется.'] },
    slotId: { purpose: 'Id (trig_…) рутины «{slot}» проекта {project}, чтобы он не лежал в публичном репозитории.',
      impact: '«Запустить сейчас» для «{slot}» не знает, какую рутину будить.',
      where: [['Тот же экран триггера, что и для {pair}: id виден в адресе триггера.', 'https://claude.ai/code/routines']],
      life: 'Меняется вместе с {pair}, если триггер пересоздаётся.',
      gotchas: ['По формату значение не секретное, но хранится как секрет вместе со своим токеном.'] },
  };
  const pairOf = (i) => (i.g === 'slotToken' ? `SLOT_ROUTINE_${SLUG}_${i.slot}` : `SLOT_TOKEN_${SLUG}_${i.slot}`);
  const pvars = (i) => ({ project: PROJECT.name, slug: PROJECT.slug, name: i.n, slot: i.slot || '', slotLow: (i.slot || '').toLowerCase(), pair: i.slot ? pairOf(i) : '' });

  /* ---------- the console's own rows for the operator screen (#104's manifest minus the projects group) ---------- */
  const PLACES = ['api', 'ghvar', 'hooks', 'ghsec', 'repo', 'local'];
  const VISIBLE = new Set(['api', 'ghvar']);
  const CITEMS = [
    { id: 'api:OWNER_EMAIL', n: 'OWNER_EMAIL', k: 'secret', p: 'api', src: 'owner', who: 'api', pu: { ru: 'Адрес, с которым вы входите через Cloudflare Access.', en: 'The address you sign in with through Cloudflare Access.' } },
    { id: 'api:GITHUB_APP_PRIVATE_KEY', n: 'GITHUB_APP_PRIVATE_KEY', k: 'secret', p: 'api', src: 'app', who: 'api', pu: { ru: 'Закрытый ключ GitHub App этого окружения: им консоль читает репозитории.', en: 'This environment’s GitHub App private key: the console reads the repositories with it.' } },
    { id: 'api:TOKEN_ENCRYPTION_KEY', n: 'TOKEN_ENCRYPTION_KEY', k: 'secret', p: 'api', src: 'gen', who: 'api', pu: { ru: 'Ключ, которым консоль шифрует токены GitHub в базе.', en: 'The key the console encrypts GitHub tokens with in its database.' } },
    { id: 'api:VAPID_PRIVATE_KEY', n: 'VAPID_PRIVATE_KEY', k: 'secret', p: 'api', src: 'gen', who: 'api, hooks', pu: { ru: 'Закрытый ключ веб-пушей: им консоль подписывает уведомления.', en: 'The web push private key: the console signs notifications with it.' },
      g: { ru: { impact: 'Уведомления не приходят; в «Настройках» блок «Уведомления» пишет, что сервер не настроен.', life: 'Не истекает. После замены каждое устройство нужно подписать заново.', gotchas: ['У каждого окружения своя пара: ключ из dev не подходит к production.'] },
        en: { impact: 'No notifications arrive; the Notifications block in Settings says the server isn’t set up.', life: 'Doesn’t expire. After a replacement every device has to subscribe again.', gotchas: ['Each environment has its own pair: a dev key doesn’t work in production.'] } } },
    { id: 'var:ACCESS_AUD', n: 'ACCESS_AUD', k: 'var', p: 'ghvar', src: 'owner', who: 'deploy.yml → api', pu: { ru: 'Метка приложения Access (AUD) этого окружения.', en: 'This environment’s Access application tag (AUD).' } },
    { id: 'var:VAPID_PUBLIC_KEY', n: 'VAPID_PUBLIC_KEY', k: 'var', p: 'ghvar', src: 'gen', who: 'deploy.yml → api', pu: { ru: 'Открытый ключ веб-пушей; пара к VAPID_PRIVATE_KEY.', en: 'The web push public key; pairs with VAPID_PRIVATE_KEY.' } },
    { id: 'var:CONSOLE_GITHUB_APP_ID', n: 'CONSOLE_GITHUB_APP_ID', k: 'var', p: 'ghvar', src: 'app', who: 'deploy.yml → api', pu: { ru: 'Номер GitHub App этого окружения.', en: 'This environment’s GitHub App id.' } },
    { id: 'hooks:WEBHOOK_SECRET', n: 'WEBHOOK_SECRET', k: 'secret', p: 'hooks', src: 'app', who: 'hooks', pu: { ru: 'Подпись событий от GitHub.', en: 'Signs GitHub’s events.' } },
    { id: 'sec:CLOUDFLARE_API_TOKEN', n: 'CLOUDFLARE_API_TOKEN', k: 'secret', p: 'ghsec', src: 'owner', who: 'deploy.yml', pu: { ru: 'Даёт GitHub Actions право деплоить Worker’ы и базу D1.', en: 'Lets GitHub Actions deploy the Workers and the D1 database.' } },
    { id: 'sec:CLOUDFLARE_ACCOUNT_ID', n: 'CLOUDFLARE_ACCOUNT_ID', k: 'secret', p: 'ghsec', src: 'owner', who: 'deploy.yml', pu: { ru: 'Номер аккаунта Cloudflare для деплоя.', en: 'The Cloudflare account id, for deploys.' } },
    { id: 'repo:PT_NTFY_TOPIC', n: 'PT_NTFY_TOPIC', k: 'secret', p: 'repo', src: 'owner', opt: true, who: 'product-team', pu: { ru: 'Тема ntfy для уведомлений команды.', en: 'The ntfy topic for team notifications.' } },
    { id: 'local:CF_ACCESS_CLIENT_ID', n: 'CF_ACCESS_CLIENT_ID', k: 'secret', p: 'local', src: 'owner', envs: ['local'], who: 'console-e2e', pu: { ru: 'Client ID сервисного токена — e2e против stage на вашем Mac.', en: 'The service token client id — e2e against stage on your Mac.' } },
    { id: 'local:CF_ACCESS_CLIENT_SECRET', n: 'CF_ACCESS_CLIENT_SECRET', k: 'secret', p: 'local', src: 'owner', envs: ['local'], who: 'console-e2e', pu: { ru: 'Client Secret того же токена.', en: 'The same token’s client secret.' } },
  ];
  const CMISSING = new Set(['api:VAPID_PRIVATE_KEY', 'var:VAPID_PUBLIC_KEY']);

  /* ---------- shared state (one console, both frames read it) ---------- */
  const minsAgo = (m) => new Date(Date.now() - m * 60000);
  const fresh0 = () => ({ thisEnv: 'production', call: 'ok', allSet: false, fixed: false, empty: false, customer: false, next: 'same', copyFail: false, checking: false, checkedAt: minsAgo(4), fresh: null, stamp: false, rateUntil: new Date(Date.now() + 9 * 60000) });
  const D = fresh0();
  const offlineAt = minsAgo(26);
  const unknownCall = () => ['loading', 'error', 'offline0', 'forbidden'].includes(D.call);
  const cmd = (env, flag) => `setup --env ${env}${flag ? ` ${flag}` : ''}`;
  const PMISSING = new Set(['R', 'T:QA', 'I:QA']);

  function pStatus(i, env) {
    if (env !== D.thisEnv) return 'unseen';
    if (unknownCall()) return null;
    if ((D.allSet || D.fixed) && !i.opt) return 'set';
    return PMISSING.has(i.id) ? 'missing' : 'set';
  }
  function pCounts(env) {
    let missing = 0; let optLeft = 0;
    for (const i of projectRows()) { const s = pStatus(i, env); if (s === 'missing') { if (i.opt) optLeft += 1; else missing += 1; } }
    return { missing, optLeft };
  }
  // Sections: only environments with rows for this project, this console's environment first.
  const pEnvs = () => { const has = ENVS.filter((e) => projectRows().some((r) => r.envs.includes(e))); return [...has.filter((e) => e === D.thisEnv), ...has.filter((e) => e !== D.thisEnv)]; };
  const pQuietEnvs = () => ENVS.filter((e) => !pEnvs().includes(e));

  function cItems(env) { return CITEMS.filter((i) => (i.envs || ALL3).includes(env)); }
  function cStatus(i, env) {
    if (env === 'local' || env !== D.thisEnv || !VISIBLE.has(i.p)) return 'unseen';
    if (unknownCall()) return null;
    if (D.allSet || D.fixed) return 'set';
    return CMISSING.has(i.id) ? 'missing' : 'set';
  }
  function cCounts(env) {
    let missing = 0; let unseen = 0;
    for (const i of cItems(env)) { const s = cStatus(i, env); if (s === 'missing' && !i.opt) missing += 1; if (s === 'unseen') unseen += 1; }
    return { missing, unseen };
  }

  const hosts = [...document.querySelectorAll('[data-app]')];
  let pageChrome = null;

  /* ---------- one app instance ---------- */
  function mountApp(host, kind, keep) {
    const S = keep || { route: 'setup', env: D.thisEnv, item: null, copyFailKey: null, listTop: 0, how: {}, anim: null, justAdded: false, notFound: false, adminDenied: false };
    host.S = S;
    const uid = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const $ = (s) => host.querySelector(s);
    const domId = (id) => `${uid}-${id.replace(/[^A-Za-z0-9]/g, '_')}`;
    const mac = kind === 'mac';
    const isAdmin = () => S.route === 'admin' || S.route === 'aguide';
    const isProj = () => S.route === 'penv' || S.route === 'pguide';
    const findP = (id) => projectRows().find((i) => i.id === id);
    const findC = (id) => cItems(S.env).find((i) => i.id === id);

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
              <button type="button" class="side-item side-item--settings" data-act="go-settings" data-nav="settings" data-fk="nav-settings">${IX.gear}<span>${t('nav.settings')}</span></button>
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

    /* ----- markup pieces (the #104 vocabulary) ----- */
    const dis = (on, reason) => (on ? ` aria-disabled="true"${reason ? ` aria-describedby="${reason}"` : ''}` : '');
    function codeline(value, aria, key) {
      const fail = S.copyFailKey === key ? `<p class="copy-fail" role="status">${t('common.copyFailed')}</p>` : '';
      const words = String(value).split(' ').map((w) => `<span class="cw">${esc(w)}</span>`).join(' ');
      return `<div class="codeline"><code>${words}</code><button type="button" class="btn btn--sm" data-act="copy" data-value="${esc(value)}" data-key="${esc(key)}" data-fk="copy-${esc(key)}" aria-label="${esc(aria)}">${IX.copy}<span aria-hidden="true">${t('common.copy')}</span></button></div>${fail}`;
    }
    const extLink = (href, fk) => `<a class="ext" href="${esc(href)}" target="_blank" rel="noopener noreferrer"${fk ? ` data-fk="${fk}"` : ''}>${esc(href.replace(/^https:\/\//, '').replace(/\/$/, ''))}<span class="sr-only"> ${t('env.g.external')}</span>${IX.ext}</a>`;
    function chip(s, i, id, optAlways) {
      const isFresh = D.fresh && i && D.fresh.includes(i.id);
      const freshAttr = isFresh ? ` is-new" style="--i:${D.fresh.indexOf(i.id)}` : '';
      const idAttr = id ? ` id="${id}"` : '';
      let c = '';
      if (s === 'set') c = `<span class="status est est--set${freshAttr}"${idAttr}>${IX.check}${t('env.st.set')}</span>`;
      if (s === 'missing') c = `<span class="status est est--missing${freshAttr}"${idAttr}>${IX.bang}${t('env.st.missing')}</span>`;
      if (s === 'unseen') c = `<span class="status est est--unseen"${idAttr}>${IX.eyeOff}${t('env.st.unseen')}</span>`;
      const opt = i && i.opt && (optAlways || s !== 'set') ? `<span class="etag etag--opt">${t('env.st.optional')}</span>` : '';
      return c + opt;
    }
    const mono = (slug) => `<span class="prod-mono" aria-hidden="true">${esc(slug[0])}</span>`;
    const lock = (title, body, back) => `<div class="block block--lock" role="alert">${IX.lock.replace('class="ico"', 'class="ico ico-lead"')}<h2 tabindex="-1" data-fk="sum-h">${title}</h2><p>${body}</p>${back || ''}</div>`;
    const skelSummary = (sr) => `<div class="esum"><span class="sr-only">${sr}</span><div class="esum__top" aria-hidden="true"><span class="esum__mark skel" style="width:var(--env-mark);height:var(--env-mark);border-radius:50%"></span><div class="esum-skel" style="flex:1"><span class="skel skel--c"></span><span class="skel skel--d"></span></div></div><div class="esum-skel" aria-hidden="true"><span class="skel skel--e"></span></div></div>`;
    const stampSVG = '<div class="stamp" aria-hidden="true"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="28"/><circle class="stamp__inner" cx="32" cy="32" r="23"/><path d="M21 33l8 8 15-17"/></svg></div>';
    // The summary foot: Checked at · Check again (aria-disabled with its reason while offline or rate limited).
    function sumFoot() {
      const off = D.call === 'offline' || D.call === 'rate';
      const reason = D.call === 'offline' ? t('env.sum.offReason') : D.call === 'rate' ? t('env.sum.rateReason', { time: hhmm(D.rateUntil) }) : '';
      return `<div class="esum__foot"><p class="res__time">${t('env.sum.checkedAt', { time: hhmm(D.checkedAt) })}</p>
        <button type="button" class="btn btn--tall" data-act="recheck" data-fk="recheck"${dis(off || D.checking, off ? `${uid}-reason` : '')}>${IX.refresh}${D.checking ? t('env.sum.rechecking') : t('env.sum.recheck')}</button>
        ${off ? `<p class="esum__reason" id="${uid}-reason">${reason}</p>` : ''}</div>`;
    }
    const callNotes = () => (D.call === 'offline' ? `<div class="paused env-note" role="status">${IX.wifi}<span>${t('env.err.offline', { time: hhmm(offlineAt) })}</span></div>`
      : D.call === 'rate' ? `<div class="paused env-note" role="status">${IX.clock}<span>${t('env.err.rate', { time: hhmm(D.rateUntil) })}</span></div>` : '');
    function entryRow({ href, act, fk, title, sub, chipHTML, testid }) {
      return `<ul class="plist"><li class="prow erow-entry"><a class="prow__link" href="${href}" data-act="${act}" data-fk="${fk}" data-testid="${testid}">
        <span class="env-ico" aria-hidden="true">${IX.key}</span>
        <span class="prow__txt"><span class="entry__name">${title}</span><span class="entry__sub">${sub}</span></span>
        ${chipHTML}${IX.chev}</a></li></ul>`;
    }
    const subWithEnv = (key, env = D.thisEnv) => t(key, { env: 'ENV_SLOT' }).replace('ENV_SLOT', `<code>${esc(env)}</code>`);

    /* ----- Settings: the operator gets the last section, a customer never sees it ----- */
    function cEntryChip() {
      if (D.call === 'loading' || D.checking) return `<span class="status est est--checking">${dots}${t('env.entry.checking')}</span>`;
      if (['error', 'offline0', 'rate'].includes(D.call)) return `<span class="status est est--unknown">${IX.q}${t('env.entry.unknown')}</span>`;
      const c = cCounts(D.thisEnv);
      if (c.missing) return `<span class="status est est--missing">${IX.bang}${t('env.entry.missing', { n: c.missing })}</span>`;
      return `<span class="status est est--set">${IX.check}${t('env.entry.ok')}</span>`;
    }
    function settingsScreen() {
      const card = (icon, title, meta) => `<div class="ctx-card"><span class="gh__mark" style="background:var(--success-soft);color:var(--success-text)" aria-hidden="true">${icon}</span><div class="ctx-card__txt"><h3 class="ctx-card__title">${title}</h3><p class="ctx-card__meta">${meta}</p></div></div>`;
      const operator = D.customer ? '' : `<section class="sec sec--late" aria-labelledby="${uid}-s-op"><h2 class="sec-title" id="${uid}-s-op">${t('console.section')}</h2>
          ${entryRow({ href: `#/admin/environment/${D.thisEnv}`, act: 'go-admin', fk: 'entry', title: t('console.title'), sub: subWithEnv('console.entry.sub'), chipHTML: cEntryChip(), testid: 'console-env-entry' })}</section>`;
      return `<div class="set-head"><h1 tabindex="-1" data-fk="h1">${t('nav.settings')}</h1></div>
        <section class="sec" aria-labelledby="${uid}-s-gh"><h2 class="sec-title" id="${uid}-s-gh">${t('set.gh')}</h2>${card(IX.check, t('set.gh.title', { login: 'geeera' }), t('set.gh.meta', { env: D.thisEnv }))}</section>
        <section class="sec" aria-labelledby="${uid}-s-push"><h2 class="sec-title" id="${uid}-s-push">${t('set.push')}</h2>${card(IX.bell, t(mac ? 'set.push.onMac' : 'set.push.on'), t('set.push.meta'))}</section>
        <section class="sec" aria-labelledby="${uid}-s-run"><h2 class="sec-title" id="${uid}-s-run">${t('set.runners')}</h2>
          <ul class="plist"><li class="prow erow-entry"><a class="prow__link" href="#/settings/runners" data-act="space"><span class="env-ico" aria-hidden="true">${IX.server}</span><span class="prow__txt"><span class="entry__name">${t('set.runners.row')}</span><span class="entry__sub">${t('set.runners.sub')}</span></span><span></span>${IX.chev}</a></li></ul></section>
        <section class="sec" aria-labelledby="${uid}-s-lang"><h2 class="sec-title" id="${uid}-s-lang">${t('set.lang')}</h2>
          <div><button type="button" class="btn btn--tall" data-act="lang" data-v="${lang() === 'ru' ? 'en' : 'ru'}" lang="${lang() === 'ru' ? 'en' : 'ru'}">${t('set.lang.switch')}</button></div></section>
        ${operator}
        <p class="set-version" data-fk="version">${t('set.version')}</p>`;
    }

    /* ----- project setup: the checklist, then the new "Project environment" row ----- */
    const STEPS = ['app', 'owner', 'yml', 'events', 'routine'];
    function stepsNow() { const routine = pStatus(projectRows()[0] || { id: 'R' }, 'production'); return ['done', 'done', 'done', 'done', D.empty || routine === 'set' || D.thisEnv !== 'production' ? 'done' : 'missing']; }
    function pEntryChip() {
      if (D.call === 'loading' || D.checking) return `<span class="status est est--checking">${dots}${t('env.entry.checking')}</span>`;
      if (['error', 'offline0', 'rate'].includes(D.call) || D.thisEnv !== 'production') return `<span class="status est est--unknown">${IX.q}${t('env.entry.unknown')}</span>`;
      const c = pCounts(D.thisEnv);
      if (c.missing) return `<span class="status est est--missing">${IX.bang}${t('env.entry.missing', { n: c.missing })}</span>`;
      return `<span class="status est est--set">${IX.check}${t('env.entry.ok')}</span>`;
    }
    function setupScreen() {
      const steps = stepsNow(); const n = steps.filter((s) => s === 'missing').length;
      const ready = !n;
      let tone = 'warn'; let title; let body = '';
      if (S.justAdded) { tone = ''; title = t('add.saved.title', { n }); body = t('add.saved.body'); }
      else if (ready) { tone = 'ready'; title = t('setup.ready.title', { name: PROJECT.name }); body = t('setup.ready.body'); }
      else title = t('setup.incomplete.title', { n });
      const vars = { repo: PROJECT.repo, SLUG, time: hhmm(minsAgo(38)) };
      const ledger = `<ol class="ledger" aria-label="${t('setup.stepsAria')}">${steps.map((st, i) => {
        const k = STEPS[i];
        const mark = st === 'done' ? IX.check : IX.bang;
        const fix = t(`step.${k}.${st === 'done' ? 'done' : 'missing'}`, vars);
        let how = '';
        if (st === 'missing') {
          const id = `${uid}-how-${i}`; const open = !!S.how[i];
          how = `<button type="button" class="btn btn--quiet btn--sm how-btn" data-act="how" data-key="${i}" aria-expanded="${open}" aria-controls="${id}" data-fk="how-${i}">${t('step.how')}${IX.down}</button>
            <div class="how" id="${id}"${open ? '' : ' hidden'}><p>${t('step.routine.how')}</p>${codeline(`npx wrangler secret put ROUTINE_TOKEN_${SLUG} --env production`, plain(t('step.routine.copyAria')), 'step-cmd')}
            <a class="how__link" href="#/settings/projects/${PROJECT.slug}/environment" data-act="go-penv" data-fk="how-link">${t('setup.step.routine.link')}${IX.chev}</a></div>`;
        }
        return `<li class="step step--${st}"><span class="step__mark" aria-hidden="true">${mark}</span>
          <div class="step__body"><div class="step__head"><h3 class="step__title">${t(`step.${k}.title`, vars)}</h3><span class="step__state">${t(`step.${st}`)}</span></div>
          <p class="step__fix">${fix}</p>${how}</div></li>`;
      }).join('')}</ol>`;
      const envRow = D.customer ? '' : `<div class="setup-env">${entryRow({ href: `#/settings/projects/${PROJECT.slug}/environment`, act: 'go-penv', fk: 'penv-entry', title: t('proj.entry.row'), sub: subWithEnv('proj.entry.sub', ROW_ENVS[0]), chipHTML: pEntryChip(), testid: 'project-env-entry' })}</div>`;
      return `<div class="set-head set-head--proj">${mono(PROJECT.slug)}<div><h1 tabindex="-1" data-fk="h1">${esc(PROJECT.name)}</h1>
          <p class="set-meta">${extLink(`https://github.com/${PROJECT.repo}`)}<code>/p/${esc(PROJECT.slug)}</code></p></div></div>
        <section class="res${tone ? ` res--${tone}` : ''}" aria-labelledby="${uid}-res" data-res><h2 id="${uid}-res" tabindex="-1" data-fk="res">${title}</h2>${body ? `<p>${body}</p>` : ''}<p class="res__time">${t('setup.checkedAt', { time: hhmm(minsAgo(3)) })}</p>${ready && !S.justAdded ? stampSVG : ''}</section>
        ${ledger}${envRow}
        <div class="form-actions"><button type="button" class="btn ${ready ? '' : 'btn--primary'} btn--tall" data-act="space">${t('setup.checkAgain')}</button>
          <button type="button" class="btn ${ready ? 'btn--primary' : ''} btn--tall" data-act="space">${t('setup.open')}</button></div>
        <div class="danger-zone"><button type="button" class="btn btn--danger-quiet btn--tall" data-act="space">${IX.archive}${t('setup.archive')}</button></div>`;
    }

    /* ----- the project's environment screen: sections per environment, required rows first ----- */
    function pRow(i, env) {
      const s = pStatus(i, env);
      const did = domId(`p-${i.id}`);
      const cur = S.item === i.id && mac && S.route === 'pguide' ? ' aria-current="true"' : '';
      const fix = s === 'missing' && !i.opt ? `<div class="erow__fix"><span class="erow__fix-label" aria-hidden="true">${t('env.row.fix')}</span>${codeline(cmd(env), t('env.row.copyAria', { name: i.n }), `row-${i.id}`)}</div>` : '';
      return `<li class="erow${s === 'missing' && !i.opt ? ' erow--missing' : ''}" data-row="${esc(i.id)}"${cur}>
        <button type="button" class="erow__btn" data-act="pitem" data-id="${esc(i.id)}" data-fk="row-${esc(i.id)}" aria-labelledby="${did}-n${s ? ` ${did}-st` : ''}" aria-describedby="${did}-p">
          <span class="erow__txt"><span class="erow__name" id="${did}-n">${esc(i.n)}</span><span class="erow__purpose" id="${did}-p" lang="ru">${esc(fill(PG[i.g].purpose, pvars(i)))}</span></span>
          <span class="erow__chips">${chip(s, i, `${did}-st`, true)}</span>${IX.chev}</button>${fix}</li>`;
    }
    function pSummary(env) {
      const own = env === D.thisEnv;
      const v = { project: PROJECT.name, env };
      if (!own) return `<div class="esum esum--quiet"><div class="esum__top"><span class="esum__mark" aria-hidden="true">${IX.eyeOff}</span><p style="align-self:center">${t('env.sum.other', { this: D.thisEnv, env })}</p></div>${codeline(cmd(env, '--check'), t('env.copyAriaEnv', { env }), `sum-other-${env}`)}</div>`;
      if (D.call === 'loading') return skelSummary(t('proj.checkingSr'));
      if (D.call === 'error') return `<div class="block block--error" role="alert"><h3 tabindex="-1" data-fk="sum-h">${t('proj.err.load')}</h3><p>${t('env.err.load.body')}</p><button type="button" class="btn btn--tall" data-act="retry" data-fk="retry">${t('common.retry')}</button></div>`;
      if (D.call === 'offline0') return `<div class="paused env-note env-note--plain" role="status">${IX.wifi}<span>${t('env.err.offline0')}</span></div>`;
      const c = pCounts(env);
      const stamped = !c.missing && S.stamp;
      let h = callNotes();
      h += `<div class="esum ${c.missing ? 'esum--todo' : 'esum--ok'}${stamped ? ' esum--stamped' : ''}${D.fresh ? ' is-new' : ''}" data-sum>`;
      if (c.missing) {
        h += `<div class="esum__top"><span class="esum__mark" aria-hidden="true">${c.missing}</span><h3 class="esum__title" tabindex="-1" data-fk="sum-h">${t('proj.sum.missing', { ...v, n: c.missing })}</h3></div>
          <p>${t('proj.sum.missingBody')}</p>${codeline(cmd(env), t('env.copyAriaEnv', { env }), 'sum-set')}
          <button type="button" class="link-btn" data-act="jump" data-fk="jump">${t('env.sum.jump')}</button>`;
      } else {
        h += `<div class="esum__top"><span class="esum__mark" aria-hidden="true">${IX.check}</span><h3 class="esum__title" tabindex="-1" data-fk="sum-h">${t('proj.sum.ok', v)}</h3></div>`;
        if (c.optLeft) h += `<p class="esum__opt">${t('proj.sum.optionalLeft', { n: c.optLeft })}</p>`;
      }
      h += sumFoot();
      if (stamped) h += stampSVG;
      return `${h}</div>`;
    }
    function pSection(env) {
      const own = env === D.thisEnv;
      const rows = projectRows().filter((r) => r.envs.includes(env));
      const req = rows.filter((r) => !r.opt); const opt = rows.filter((r) => r.opt);
      const hid = `${uid}-sec-${env}`;
      const mine = own ? `<span class="psec__this"><span class="sr-only">, </span><i aria-hidden="true"></i>${t('proj.section.this')}</span>` : '';
      const list = (key, its) => (its.length ? `<div class="psub"><h3 class="psub__h" id="${hid}-${key}">${t(`proj.${key}`)}</h3><ul class="elist" aria-labelledby="${hid}-${key}">${its.map((i) => pRow(i, env)).join('')}</ul></div>` : '');
      return `<section class="psec" aria-labelledby="${hid}"><h2 class="psec__title" id="${hid}"><code>${esc(env)}</code>${mine}</h2>
        ${pSummary(env)}${list('required', req)}${list('optional', opt)}</section>`;
    }
    function quietLine() {
      const q = pQuietEnvs(); if (!q.length || !pEnvs().length) return '';
      const words = q.map((e) => (e === 'local' ? t('proj.list.local') : e));
      const list = words.length > 1 ? `${words.slice(0, -1).join(', ')}${t('proj.list.and')}${words[words.length - 1]}` : words[0];
      return `<p class="pnone">${IX.laptop}<span>${t('proj.none', { list: esc(list) })}</span></p>`;
    }
    function penvScreen() {
      const busy = D.call === 'loading' || D.checking;
      const head = `<div class="env-head"><h1 tabindex="-1" data-fk="h1">${t('proj.title')}</h1>${D.call === 'forbidden' ? '' : `<p class="set-lead">${t('proj.lead', { project: PROJECT.name })}</p>`}</div>`;
      if (D.call === 'forbidden') return head + lock(t('proj.err.forbidden.title'), t('proj.err.forbidden.body'), `<a class="btn btn--tall" href="#/settings/projects/${PROJECT.slug}" data-act="go-setup" data-fk="forbidden-back">${IX.back}${t('proj.err.forbidden.back')}</a>`);
      if (!pEnvs().length) return `${head}<div class="block pempty"><span class="esum__mark" aria-hidden="true">${IX.check}</span><p>${t('proj.empty')}</p></div>`;
      return `${head}<div class="env-panel"${busy ? ' aria-busy="true"' : ''}>${pEnvs().map(pSection).join('')}${quietLine()}</div>`;
    }
    function notFoundScreen() {
      return `<div class="env-head"><h1 tabindex="-1" data-fk="h1">${t('proj.notFound.title')}</h1></div>
        <div class="block pempty"><p>${t('proj.notFound.body', { slug: 'storyfy' })}</p><button type="button" class="btn btn--tall" data-act="space">${t('nav.all')}</button></div>`;
    }

    /* ----- the guide: one renderer for both screens ----- */
    function guideHTML(pane, i, env, s, content, backBtn) {
      const hl = pane ? 2 : 1;
      const sec = (key, body, cls = '') => `<section class="gsec${cls}" aria-labelledby="${uid}-gs-${key}"><h${hl + 1} class="gsec__h" id="${uid}-gs-${key}">${t(`env.g.${key}`)}</h${hl + 1}>${body}</section>`;
      const own = env === D.thisEnv && env !== 'local';
      let h = `<header><h${hl} class="guide__h" id="${uid}-gh" tabindex="-1" data-fk="g-h">${esc(i.n)}</h${hl}>
        <div class="guide__meta">${s ? chip(s, i, '', true) : ''}<span class="etag">${t(`env.g.kind.${i.k}`)}</span><span class="etag">${t(`env.g.place.${i.p}`, { env, project: PROJECT.name })}</span><span class="etag">${t(`env.g.src.${i.src}`)}</span><span class="etag">${t('env.g.needs', { who: i.who })}</span></div>
        ${s === 'set' && own && !unknownCall() ? `<p class="guide__time">${t('env.sum.checkedAt', { time: hhmm(D.checkedAt) })}</p>` : ''}</header>
        <p class="gnever">${IX.lock}<span>${t('env.g.never')}</span></p>`;
      if (content.ruOnly && lang() !== 'ru') h += `<p class="gplain gru">${t('proj.g.ruOnly')}</p>`;
      const L_ = content.ruOnly ? ' lang="ru"' : '';
      h += `<div class="guide__prose"${L_}>`;
      h += sec('purpose', `<p>${esc(content.purpose)}</p>`, ' gsec--purpose');
      if (content.impact) h += sec('impact', `<p>${esc(content.impact)}</p>`);
      if (i.src === 'gen') h += sec('where', `<p class="gplain">${t('env.g.where.gen')}</p>`);
      else if (i.src === 'app') h += sec('where', `<p class="gplain">${t('env.g.where.app')}</p>`);
      else if (content.where) h += sec('where', `<ol class="gsteps">${content.where.map(([txt, url], n) => `<li><span class="gstep__txt"><span>${esc(txt)}</span>${url ? extLink(url, `g-link-${n}`) : ''}</span></li>`).join('')}</ol>`);
      if (content.life) h += sec('life', `<p>${esc(content.life)}</p>`);
      if (content.gotchas) h += sec('gotchas', `<ul class="ggotchas">${content.gotchas.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`);
      h += '</div>';
      const aria = t('env.row.copyAria', { name: i.n });
      let how;
      if (s === 'unseen') how = `<p>${t('env.g.how.check')}</p>${codeline(cmd(env, '--check'), aria, 'g-check')}<p>${t('env.g.how.body')}</p>${codeline(cmd(env), aria, 'g-set')}`;
      else if (s === 'set') how = `<p>${t('env.g.how.rotate')}</p>${codeline(cmd(env, '--rotate'), aria, 'g-rotate')}`;
      else how = `<p>${t('env.g.how.body')}</p>${codeline(cmd(env), aria, 'g-set')}`;
      h += sec('how', `<div class="ghow">${how}</div>`);
      return `<article class="guide" aria-labelledby="${uid}-gh">${pane ? '' : backBtn || ''}${h}</article>`;
    }
    function guideNotFound(pane, title, body) {
      const hl = pane ? 2 : 1;
      return `<div class="gnf"><h${hl} class="gnf__h" id="${uid}-gh" tabindex="-1" data-fk="g-h">${title}</h${hl}><p>${body}</p></div>`;
    }
    function pGuide(pane) {
      const env = 'production'; const i = findP(S.item);
      if (!i) return guideNotFound(pane, t('proj.g.notFound', { project: PROJECT.name, env }), t('env.g.notFound.body'));
      const g = PG[i.g]; const v = pvars(i);
      const content = { ruOnly: true, purpose: fill(g.purpose, v), impact: fill(g.impact, v), where: g.where.map(([x, u]) => [fill(x, v), u]), life: fill(g.life, v), gotchas: g.gotchas.map((x) => fill(x, v)) };
      return guideHTML(pane, i, env, pStatus(i, env), content);
    }
    function cGuide(pane) {
      const env = S.env; const i = findC(S.item);
      if (!i) return guideNotFound(pane, t('env.g.notFound.title', { env }), t('env.g.notFound.body'));
      const g = i.g ? i.g[lang()] : {};
      return guideHTML(pane, i, env, cStatus(i, env), { purpose: i.pu[lang()], impact: g.impact, life: g.life, gotchas: g.gotchas });
    }

    /* ----- the operator's console screen: #104 unchanged, minus the projects group ----- */
    function tabs() {
      return `<div class="etabs" role="tablist" aria-label="${t('env.tabs')}">${ENVS.map((e) => {
        const sel = e === S.env;
        const mine = e === D.thisEnv ? `<span class="etab__this"><i aria-hidden="true"></i>${t('env.tab.this')}</span>` : '';
        return `<button type="button" role="tab" class="etab" id="${uid}-tab-${e}" aria-selected="${sel}" aria-controls="${uid}-panel" tabindex="${sel ? 0 : -1}" data-act="tab" data-env="${e}" data-fk="tab-${e}"><span class="etab__name">${e}</span>${mine}</button>`;
      }).join('')}</div>`;
    }
    function cSummary() {
      const env = S.env;
      if (env === 'local') return `<section class="esum esum--quiet" aria-labelledby="${uid}-sum"><div class="esum__top"><span class="esum__mark" aria-hidden="true">${IX.laptop}</span><h2 class="sr-only" id="${uid}-sum">${t('env.group.local')}</h2><p style="align-self:center">${t('env.sum.local')}</p></div>${codeline(cmd('local', '--check'), t('env.copyAriaEnv', { env: 'local' }), 'sum-local')}</section>`;
      if (env !== D.thisEnv) return `<section class="esum esum--quiet" aria-labelledby="${uid}-sum"><div class="esum__top"><span class="esum__mark" aria-hidden="true">${IX.eyeOff}</span><h2 class="sr-only" id="${uid}-sum">${t('env.st.unseen')}</h2><p style="align-self:center">${t('env.sum.other', { this: D.thisEnv, env })}</p></div>${codeline(cmd(env, '--check'), t('env.copyAriaEnv', { env }), 'sum-other')}</section>`;
      if (D.call === 'loading') return skelSummary(t('env.loading'));
      if (D.call === 'error') return `<div class="block block--error" role="alert"><h2 tabindex="-1" data-fk="sum-h">${t('env.err.load.title')}</h2><p>${t('env.err.load.body')}</p><button type="button" class="btn btn--tall" data-act="retry" data-fk="retry">${t('common.retry')}</button></div>`;
      if (D.call === 'offline0') return `<div class="paused env-note env-note--plain" role="status">${IX.wifi}<span>${t('env.err.offline0')}</span></div>`;
      const c = cCounts(env);
      let h = callNotes();
      h += `<section class="esum ${c.missing ? 'esum--todo' : 'esum--ok'}" aria-labelledby="${uid}-sum" data-sum>`;
      if (c.missing) {
        h += `<div class="esum__top"><span class="esum__mark" aria-hidden="true">${c.missing}</span><h2 class="esum__title" id="${uid}-sum" tabindex="-1" data-fk="sum-h">${t('env.sum.missing', { n: c.missing, env })}</h2></div>
          <p>${t('env.sum.missingBody')}</p>${codeline(cmd(env), t('env.copyAriaEnv', { env }), 'sum-set')}`;
      } else h += `<div class="esum__top"><span class="esum__mark" aria-hidden="true">${IX.check}</span><h2 class="esum__title" id="${uid}-sum" tabindex="-1" data-fk="sum-h">${t('env.sum.ok', { env })}</h2></div>`;
      if (c.unseen) h += `<div class="esum__unseen"><p>${IX.eyeOff}<span>${t('env.sum.unseen', { n: c.unseen })}</span></p>${codeline(cmd(env, '--check'), t('env.copyAriaEnv', { env }), 'sum-check')}</div>`;
      return `${h}${sumFoot()}</section>`;
    }
    function cRow(i, env) {
      const s = cStatus(i, env);
      const did = domId(`c-${i.id}`);
      const cur = S.item === i.id && mac ? ' aria-current="true"' : '';
      const fix = s === 'missing' ? `<div class="erow__fix"><span class="erow__fix-label" aria-hidden="true">${t('env.row.fix')}</span>${codeline(cmd(env), t('env.row.copyAria', { name: i.n }), `row-${i.id}`)}</div>` : '';
      return `<li class="erow${s === 'missing' ? ' erow--missing' : ''}" data-row="${esc(i.id)}"${cur}>
        <button type="button" class="erow__btn" data-act="citem" data-id="${esc(i.id)}" data-fk="row-${esc(i.id)}" aria-labelledby="${did}-n${s ? ` ${did}-st` : ''}" aria-describedby="${did}-p">
          <span class="erow__txt"><span class="erow__name" id="${did}-n">${esc(i.n)}</span><span class="erow__purpose" id="${did}-p">${esc(i.pu[lang()])}</span></span>
          <span class="erow__chips">${chip(s, i, `${did}-st`)}</span>${IX.chev}</button>${fix}</li>`;
    }
    function cGroups() {
      const env = S.env; const own = env === D.thisEnv;
      const RANK = { missing: 0, unseen: 1, set: 2 };
      let h = '';
      for (const p of env === 'local' ? ['local'] : PLACES.filter((x) => x !== 'local')) {
        const its = cItems(env).filter((i) => i.p === p).map((i, n) => ({ i, n })).sort((a, b) => ((RANK[cStatus(a.i, env)] ?? 3) - (RANK[cStatus(b.i, env)] ?? 3)) || a.n - b.n).map((x) => x.i);
        if (!its.length) continue;
        const visible = own && VISIBLE.has(p);
        const icon = p === 'local' ? IX.laptop : visible ? IX.eye : IX.eyeOff;
        const hint = own || ['local', 'repo', 'hooks', 'ghsec'].includes(p) ? `env.group.${p}.hint` : 'env.group.hooks.hint';
        h += `<section class="egrp${visible || p === 'local' ? '' : ' egrp--unseen'}" aria-labelledby="${uid}-g-${p}"><h2 class="egrp__title" id="${uid}-g-${p}">${t(`env.group.${p}`)}</h2><p class="egrp__hint">${icon}<span>${t(hint)}</span></p><ul class="elist">${its.map((i) => cRow(i, env)).join('')}</ul></section>`;
      }
      return h;
    }
    function adminScreen() {
      const head = `<div class="env-head"><h1 tabindex="-1" data-fk="h1">${t('console.title')}</h1>${S.adminDenied ? '' : `<p class="set-lead">${t('console.lead')}</p>`}</div>`;
      if (S.adminDenied) return head + lock(t('console.err.forbidden.title'), t('proj.err.forbidden.body'), `<a class="btn btn--tall" href="#/settings" data-act="go-settings" data-fk="forbidden-back">${IX.back}${t('nav.settings')}</a>`);
      const busy = S.env === D.thisEnv && (D.call === 'loading' || D.checking);
      return `${head}${tabs()}<div class="env-panel" role="tabpanel" id="${uid}-panel" aria-labelledby="${uid}-tab-${S.env}"${busy ? ' aria-busy="true"' : ''}>${cSummary()}${cGroups()}</div>`;
    }

    /* ----- chrome per route ----- */
    function backLabel() {
      return { settings: t('nav.projects'), admin: t('nav.settings'), aguide: t('env.g.back', { env: S.env }), setup: t('nav.all'), penv: PROJECT.name, pguide: t('proj.g.back', { project: PROJECT.name }) }[S.route];
    }
    function chrome() {
      if (mac) {
        const c = []; const a = (href, act, fk, label) => `<li><a href="${href}" data-act="${act}" data-fk="${fk}">${label}</a></li>`;
        const here = (label, url) => `<li><span aria-current="page"${url ? ' class="crumbs__url"' : ''}>${label}</span></li>`;
        if (S.route === 'settings') c.push(here(t('nav.settings')));
        if (isAdmin()) {
          c.push(a('#/settings', 'go-settings', 'crumb-settings', t('nav.settings')));
          if (S.item) { c.push(a(`#/admin/environment/${S.env}`, 'close-guide', 'crumb-env', t('console.title'))); const i = findC(S.item); c.push(here(esc(i ? i.n : S.item.split(':').pop()), true)); }
          else c.push(here(t('console.title')));
        }
        if (S.route === 'setup' || isProj()) {
          c.push(a('#/overview', 'space', 'crumb-all', t('nav.all')));
          if (S.route === 'setup') c.push(here(esc(PROJECT.name)));
          else if (S.notFound) c.push(here(t('proj.notFound.title')));
          else {
            c.push(a(`#/settings/projects/${PROJECT.slug}`, 'go-setup', 'crumb-setup', esc(PROJECT.name)));
            if (S.item) { c.push(a(`#/settings/projects/${PROJECT.slug}/environment`, 'close-guide', 'crumb-env', t('proj.crumb.env'))); const i = findP(S.item); c.push(here(esc(i ? i.n : 'ROUTINE_TOKEN_TEAM_CONSOLE'), true)); }
            else c.push(here(t('proj.crumb.env')));
          }
        }
        $('[data-slot=crumbs]').innerHTML = `<ol>${c.join('')}</ol>`;
        host.querySelectorAll('[data-nav]').forEach((b) => { const on = (b.dataset.nav === 'settings' && (S.route === 'settings' || isAdmin())) || (b.dataset.nav === 'all' && (S.route === 'setup' || isProj())); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
        return;
      }
      $('[data-slot=phead]').innerHTML = `<header class="p-bar"><button type="button" class="p-back" data-act="back" data-fk="back">${IX.back}<span>${esc(backLabel())}</span></button><span></span><span></span></header>`;
    }

    /* ----- render with focus kept by data-fk ----- */
    const scroller = () => host.querySelector('.env-split__list, .set-scroll, .p-scroll');
    function screenBody() {
      if (S.route === 'settings') return settingsScreen();
      if (S.route === 'setup') return setupScreen();
      if (isProj() && S.notFound) return notFoundScreen();
      if (isProj()) return penvScreen();
      return adminScreen();
    }
    function render(opts = {}) {
      const active = host.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
      const sc = scroller(); const top = sc ? sc.scrollTop : 0;
      const paneEl = host.querySelector('.env-split__pane'); const paneTop = paneEl ? paneEl.scrollTop : 0;
      chrome();
      let animEl = null;
      const guideFor = (pane) => (isAdmin() ? cGuide(pane) : pGuide(pane));
      if (mac) {
        const body = $('[data-slot=body]');
        if (S.item && (isAdmin() || isProj()) && !S.notFound) {
          body.innerHTML = `<div class="env-split"><div class="env-split__list"><div class="set-inner">${screenBody()}</div></div>
            <section class="env-split__pane" aria-labelledby="${uid}-gh" data-pane><div class="gpane__bar"><button type="button" class="icon-btn" data-act="close-guide" data-fk="g-close" aria-label="${t('env.g.close')}">${IX.x}</button></div>${guideFor(true)}</section></div>`;
          animEl = host.querySelector('[data-pane]');
        } else body.innerHTML = `<div class="set-scroll"><div class="set-inner">${screenBody()}</div></div>`;
      } else {
        const screen = $('[data-slot=screen]');
        screen.innerHTML = S.route === 'pguide' || S.route === 'aguide' ? guideFor(false) : screenBody();
        animEl = screen;
      }
      if (S.anim && animEl && !opts.noAnim) {
        const cls = { push: 'is-push', pop: 'is-pop', pane: 'is-pane' }[S.anim];
        if (cls && (S.anim !== 'pane' || mac)) { animEl.classList.add(cls); animEl.addEventListener('animationend', () => animEl.classList.remove(cls), { once: true }); }
      }
      S.anim = null;
      const sc2 = scroller();
      if (sc2) sc2.scrollTop = opts.scrollTop === 'top' ? 0 : opts.scrollTop != null ? opts.scrollTop : top;
      const pane2 = host.querySelector('.env-split__pane'); if (pane2 && !opts.newPane) pane2.scrollTop = paneTop;
      const target = opts.focus ? host.querySelector(`[data-fk="${opts.focus}"]`) : active ? host.querySelector(`[data-fk="${active}"]`) : null;
      if (target) target.focus({ preventScroll: !opts.focus });
      if (opts.focus && target && opts.reveal) target.scrollIntoView({ block: 'center', behavior: isReduced() ? 'auto' : 'smooth' });
      if (D.stampNow && host.querySelector('[data-sum] .stamp')) stamp();
    }
    const announce = (txt) => { const l = $('[data-slot=live]'); l.textContent = ''; setTimeout(() => { l.textContent = txt; }, 30); };
    let toastTimer;
    function toast(txt) {
      const el = $('[data-slot=toast]'); el.textContent = txt; el.hidden = false;
      clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, Proto.ms('--dur-toast'));
    }
    // #104's signature moment, reused: the ink stamp presses onto the summary when the last required item is set.
    function stamp() {
      const s = host.querySelector('[data-sum] .stamp'); if (!s || s.dataset.done) return;
      s.dataset.done = '1';
      if (isReduced()) { Proto.play(s, [{ opacity: 0 }, { opacity: 1 }], { duration: Proto.ms('--dur-fade') }); return; }
      const strokes = [...s.querySelectorAll('circle,path')];
      strokes.forEach((p) => { const l = p.getTotalLength(); p.style.strokeDasharray = l; p.style.strokeDashoffset = l; });
      Proto.play(s, [{ opacity: 0, transform: 'rotate(-20deg) scale(1.4)' }, { opacity: 1, transform: 'rotate(-9deg) scale(1)' }], { duration: Proto.ms('--dur-base'), easing: Proto.cssVar('--ease-emph') });
      strokes.forEach((p, n) => Proto.play(p, [{ strokeDashoffset: p.style.strokeDashoffset }, { strokeDashoffset: 0 }], { duration: Proto.ms('--dur-sig') * 0.6, delay: n * Proto.ms('--stagger'), easing: Proto.cssVar('--ease-emph'), fill: 'forwards' }));
    }

    /* ----- navigation ----- */
    function go(route, opts = {}) { S.route = route; S.item = null; S.anim = opts.anim || 'push'; render({ focus: opts.focus || 'h1', scrollTop: 'top' }); }
    function openItem(id, route) {
      const sc = scroller(); if (!mac && sc) S.listTop = sc.scrollTop;
      S.item = id;
      S.route = route;
      if (mac) { S.anim = 'pane'; render({ focus: 'g-h', newPane: true }); host.querySelector('.env-split__pane').scrollTop = 0; return; }
      S.anim = 'push'; render({ focus: 'g-h', scrollTop: 'top' });
    }
    function closeItem() {
      const id = S.item; S.item = null;
      S.route = S.route === 'pguide' || S.route === 'penv' ? 'penv' : 'admin';
      if (!mac) { S.anim = 'pop'; render({ focus: `row-${id}`, scrollTop: S.listTop }); return; }
      render({ focus: `row-${id}` });
    }
    function back() {
      if (S.route === 'settings') toast(t('demo.space'));
      else if (S.route === 'admin') { S.adminDenied = false; go('settings', { anim: 'pop', focus: 'entry' }); }
      else if (S.route === 'setup') toast(t('demo.space'));
      else if (S.route === 'penv') { S.notFound = false; go('setup', { anim: 'pop', focus: 'penv-entry' }); }
      else closeItem();
    }
    function selectTab(env) {
      if (env === S.env) return;
      S.env = env; S.item = null; S.copyFailKey = null; if (S.route === 'aguide') S.route = 'admin';
      render({ focus: `tab-${env}` });
      const h = host.querySelector('[data-fk=sum-h]') || host.querySelector('.esum p, .env-note');
      if (h) announce(plain(h.textContent));
    }
    function jump() {
      const first = projectRows().find((i) => pStatus(i, D.thisEnv) === 'missing' && !i.opt);
      if (!first) return;
      render({ focus: `row-${first.id}`, reveal: true });
      const li = host.querySelector(`[data-row="${CSS.escape(first.id)}"]`);
      if (li) { li.classList.remove('is-flash'); void li.offsetWidth; li.classList.add('is-flash'); }
    }
    async function copy(btn) {
      const key = btn.dataset.key;
      try {
        if (D.copyFail) throw new Error('Clipboard refused (demo)');
        await navigator.clipboard.writeText(btn.dataset.value);
      } catch (err) {
        console.warn('Copy failed; showing the copy-it-by-hand note', err);
        S.copyFailKey = key; render({ focus: btn.dataset.fk });
        announce(t('common.copyFailed'));
        return;
      }
      if (S.copyFailKey) { S.copyFailKey = null; render(); }
      const b = host.querySelector(`[data-fk="${CSS.escape(btn.dataset.fk)}"]`) || btn;
      const label = b.querySelector('span'); label.textContent = t('common.copied'); b.dataset.copied = '';
      announce(t('common.copied'));
      setTimeout(() => { if (b.isConnected) { label.textContent = t('common.copy'); delete b.dataset.copied; } }, 2000);
    }

    host.onclick = (e) => {
      const el = e.target.closest('[data-act]'); if (!el || !host.contains(el)) return;
      const act = el.dataset.act;
      if (el.tagName === 'A' && act) e.preventDefault();
      if (el.getAttribute('aria-disabled') === 'true') return;
      switch (act) {
        case 'go-settings': S.adminDenied = false; go('settings', { anim: 'pop' }); break;
        case 'go-admin': S.env = D.thisEnv; go('admin'); break;
        case 'go-setup': S.notFound = false; go('setup', { anim: 'pop' }); break;
        case 'go-penv': go('penv'); break;
        case 'pitem': openItem(el.dataset.id, 'pguide'); break;
        case 'citem': openItem(el.dataset.id, 'aguide'); break;
        case 'close-guide': closeItem(); break;
        case 'back': back(); break;
        case 'tab': selectTab(el.dataset.env); break;
        case 'jump': jump(); break;
        case 'recheck': recheck(host); break;
        case 'retry': retry(host); break;
        case 'how': S.how[el.dataset.key] = el.getAttribute('aria-expanded') !== 'true'; render(); break;
        case 'copy': copy(el); break;
        case 'lang': if (pageChrome) pageChrome.setControl('lang', el.dataset.v); break;
        case 'space': toast(t('demo.space')); break;
        default: break;
      }
    };
    host.onkeydown = (e) => {
      const tab = e.target.closest('[role=tab]');
      if (tab) {
        const i = ENVS.indexOf(tab.dataset.env);
        const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ENVS.length - 1 }[e.key];
        if (next != null) { e.preventDefault(); selectTab(ENVS[(next + ENVS.length) % ENVS.length]); }
        return;
      }
      if (e.key === 'Escape' && mac && S.item) { e.preventDefault(); closeItem(); }
    };

    const app = {
      render, S, announce,
      state(v) {
        Object.assign(S, { route: 'setup', env: D.thisEnv, item: null, copyFailKey: null, how: {}, justAdded: false, notFound: false, adminDenied: false, stamp: false });
        const P = ['missing', 'allSet', 'unseen', 'loading', 'error', 'offline', 'offline0', 'rate', 'forbidden', 'empty'];
        if (v === 'settings' || v === 'settingsCustomer') S.route = 'settings';
        else if (v === 'setupAdded') { S.justAdded = true; S.how[4] = true; }
        else if (P.includes(v)) S.route = 'penv';
        else if (v === 'notFound') { S.route = 'penv'; S.notFound = true; }
        else if (v === 'guide' || v === 'guideOpt' || v === 'guideNotFound') { S.route = 'penv'; render({ noAnim: true }); openItem({ guide: 'R', guideOpt: 'T:QA', guideNotFound: 'X' }[v], 'pguide'); return; }
        else if (v === 'admin') S.route = 'admin';
        else if (v === 'adminOther') { S.route = 'admin'; S.env = 'stage'; }
        else if (v === 'adminForbidden') { S.route = 'admin'; S.adminDenied = true; }
        else if (v === 'adminGuide') { S.route = 'admin'; render({ noAnim: true }); openItem('api:VAPID_PRIVATE_KEY', 'aguide'); return; }
        render({ focus: 'h1', scrollTop: 'top' });
      },
      reveal(fk) { const el = host.querySelector(`[data-fk="${fk}"]`); const sc = scroller(); if (el && sc) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 24; },
    };
    host.app = app;
    render();
    return app;
  }

  /* ---------- shared actions: one status call per console, both frames show it ---------- */
  function renderAll(except) { hosts.forEach((h) => { if (h.app && h !== except) h.app.render(); }); }
  async function recheck(host) {
    if (D.checking) return;
    const env = D.thisEnv; const proj = host.S.route === 'penv' || host.S.route === 'pguide';
    const before = new Map(projectRows().map((i) => [i.id, pStatus(i, env)]));
    const had = pCounts(env).missing > 0;
    D.checking = true; renderAll(); host.app.announce(plain(t(proj ? 'proj.checkingSr' : 'env.loading')));
    await wait(1100);
    D.checking = false;
    if (D.next === 'error') { D.call = 'error'; renderAll(host); host.app.render({ focus: 'sum-h' }); return; }
    if (D.next === 'fixed') D.fixed = true;
    D.call = 'ok'; D.checkedAt = new Date();
    D.fresh = projectRows().filter((i) => before.get(i.id) !== pStatus(i, env)).map((i) => i.id);
    if (had && !pCounts(env).missing) hosts.forEach((h) => { if (h.S) h.S.stamp = true; });
    D.stampNow = true;
    renderAll(host); host.app.render({ focus: 'recheck' });
    D.fresh = null; D.stampNow = false;
    const h = host.querySelector('[data-fk=sum-h]'); if (h) host.app.announce(plain(h.textContent));
  }
  async function retry(host) {
    D.call = 'loading'; renderAll();
    await wait(900);
    D.call = 'ok'; D.checkedAt = new Date();
    renderAll(host); host.app.render({ focus: 'sum-h' });
  }

  /* ---------- page controls ---------- */
  const mountAll = (keep) => hosts.forEach((h) => { const prev = keep && h.S ? h.S : null; h.className = 'app'; mountApp(h, h.dataset.app, prev); });
  pageChrome = Proto.page({ L, title: 'Team Console · #750', onLang: () => mountAll(true) });
  const sel = (id) => document.getElementById(id);
  function applyState(v) {
    const keep = { next: D.next, copyFail: D.copyFail };
    Object.assign(D, fresh0(), keep);
    if (v === 'settingsCustomer' || v === 'forbidden' || v === 'adminForbidden') D.customer = true;
    if (v === 'forbidden') D.call = 'forbidden';
    if (v === 'allSet') D.allSet = true;
    if (v === 'unseen') D.thisEnv = 'dev';
    if (v === 'empty') D.empty = true;
    if (['loading', 'error', 'offline', 'offline0', 'rate'].includes(v)) D.call = v;
    hosts.forEach((h) => h.app.state(v));
  }
  sel('d-state').addEventListener('change', (e) => applyState(e.target.value));
  sel('d-next').addEventListener('change', (e) => { D.next = e.target.value; });
  sel('d-copy').addEventListener('change', (e) => { D.copyFail = e.target.checked; });
  document.querySelector('[data-reset]').addEventListener('click', () => { D.next = 'same'; D.copyFail = false; sel('d-next').value = 'same'; sel('d-copy').checked = false; sel('d-state').value = 'setup'; applyState('setup'); });

  // ?state=…&view=…&theme=…&lang=…&motion=…&scroll=<data-fk>&shot=1 opens a state directly (used for the screenshots).
  const q = new URLSearchParams(location.search);
  if (q.has('shot')) Proto.root.dataset.shot = '';
  if (q.get('lang') === 'en' || q.get('lang') === 'ru') { L.save(q.get('lang')); pageChrome.setControl('lang', q.get('lang')); }
  mountAll(false);
  ['view', 'theme', 'motion'].forEach((k) => { if (q.get(k)) pageChrome.setControl(k, q.get(k)); });
  if (q.get('copy') === 'fail') { D.copyFail = true; sel('d-copy').checked = true; }
  const st = q.get('state') || 'setup';
  sel('d-state').value = st;
  applyState(st);
  if (q.get('scroll')) hosts.forEach((h) => h.app.reveal(q.get('scroll')));
  pageChrome.fit();
})();
