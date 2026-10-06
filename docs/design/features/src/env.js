/* #104 Environment setup. Design prototype runtime with mock data only; the real app reads the presence-only endpoint
   (never a value, a length, a prefix or a hash) and renders the guides from the manifest (#102). Two independent
   instances (iPhone, Mac) share the demo controls and the environment's state, like the Paper Desk prototype. */
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
  };
  const lang = () => L.lang;

  /* ---------- the manifest, as #102 will carry it (mock) ---------- */
  const ENVS = ['dev', 'stage', 'production', 'local'];
  const ALL3 = ['dev', 'stage', 'production'];
  const SLOTS = ['planning', 'development', 'qa'];
  const PLACES = ['api', 'ghvar', 'project', 'hooks', 'ghsec', 'repo', 'local'];
  const VISIBLE = new Set(['api', 'ghvar', 'project']);
  const ITEMS = [
    { id: 'api:OWNER_EMAIL', n: 'OWNER_EMAIL', k: 'secret', p: 'api', src: 'owner', g: 'ownerEmail', who: 'api' },
    { id: 'api:GITHUB_APP_PRIVATE_KEY', n: 'GITHUB_APP_PRIVATE_KEY', k: 'secret', p: 'api', src: 'app', g: 'appKey', who: 'api' },
    { id: 'api:GITHUB_APP_CLIENT_SECRET', n: 'GITHUB_APP_CLIENT_SECRET', k: 'secret', p: 'api', src: 'app', who: 'api',
      pu: { ru: 'Секрет GitHub App: им консоль подключает ваш аккаунт GitHub.', en: 'The GitHub App’s secret: the console connects your GitHub account with it.' } },
    { id: 'api:TOKEN_ENCRYPTION_KEY', n: 'TOKEN_ENCRYPTION_KEY', k: 'secret', p: 'api', src: 'gen', who: 'api',
      pu: { ru: 'Ключ, которым консоль шифрует ваш токен GitHub в базе.', en: 'The key the console encrypts your GitHub token with in its database.' },
      life: { ru: 'Не истекает. После замены консоль попросит подключить GitHub заново: старый токен в базе больше не расшифровать.', en: 'Doesn’t expire. After a replacement the console asks you to connect GitHub again: the stored token can no longer be decrypted.' } },
    { id: 'api:VAPID_PRIVATE_KEY', n: 'VAPID_PRIVATE_KEY', k: 'secret', p: 'api', src: 'gen', g: 'vapid', who: 'api, hooks' },
    { id: 'var:ACCESS_TEAM_DOMAIN', n: 'ACCESS_TEAM_DOMAIN', k: 'var', p: 'ghvar', src: 'owner', who: 'deploy.yml → api',
      pu: { ru: 'Домен вашей команды Cloudflare Zero Trust.', en: 'Your Cloudflare Zero Trust team domain.' } },
    { id: 'var:ACCESS_AUD', n: 'ACCESS_AUD', k: 'var', p: 'ghvar', src: 'owner', g: 'aud', who: 'deploy.yml → api' },
    { id: 'var:VAPID_PUBLIC_KEY', n: 'VAPID_PUBLIC_KEY', k: 'var', p: 'ghvar', src: 'gen', who: 'deploy.yml → api',
      pu: { ru: 'Открытый ключ веб-пушей; пара к VAPID_PRIVATE_KEY.', en: 'The web push public key; pairs with VAPID_PRIVATE_KEY.' } },
    { id: 'var:CONSOLE_GITHUB_APP_ID', n: 'CONSOLE_GITHUB_APP_ID', k: 'var', p: 'ghvar', src: 'app', who: 'deploy.yml → api',
      pu: { ru: 'Номер GitHub App этого окружения.', en: 'This environment’s GitHub App id.' } },
    { id: 'var:CONSOLE_GITHUB_APP_CLIENT_ID', n: 'CONSOLE_GITHUB_APP_CLIENT_ID', k: 'var', p: 'ghvar', src: 'app', who: 'deploy.yml → api',
      pu: { ru: 'Client ID GitHub App этого окружения.', en: 'This environment’s GitHub App client id.' } },
    { id: 'var:OWNER_GITHUB_LOGIN', n: 'OWNER_GITHUB_LOGIN', k: 'var', p: 'ghvar', src: 'app', who: 'deploy.yml → api',
      pu: { ru: 'Ваш логин GitHub: только он может подключить аккаунт.', en: 'Your GitHub login: only it can connect an account.' } },
    { id: 'hooks:WEBHOOK_SECRET', n: 'WEBHOOK_SECRET', k: 'secret', p: 'hooks', src: 'app', who: 'hooks',
      pu: { ru: 'Подпись событий от GitHub: по ней hooks отличает настоящие события.', en: 'Signs GitHub’s events, so hooks can tell real ones.' } },
    { id: 'hooks:VAPID_PRIVATE_KEY', n: 'VAPID_PRIVATE_KEY', k: 'secret', p: 'hooks', src: 'gen', g: 'vapid', who: 'api, hooks' },
    { id: 'sec:CLOUDFLARE_API_TOKEN', n: 'CLOUDFLARE_API_TOKEN', k: 'secret', p: 'ghsec', src: 'owner', g: 'cfToken', who: 'deploy.yml' },
    { id: 'sec:CLOUDFLARE_ACCOUNT_ID', n: 'CLOUDFLARE_ACCOUNT_ID', k: 'secret', p: 'ghsec', src: 'owner', who: 'deploy.yml',
      pu: { ru: 'Номер вашего аккаунта Cloudflare для деплоя.', en: 'Your Cloudflare account id, for deploys.' } },
    { id: 'sec:ACCESS_SERVICE_TOKEN_ID', n: 'ACCESS_SERVICE_TOKEN_ID', k: 'secret', p: 'ghsec', src: 'owner', envs: ['dev', 'stage'], who: 'e2e',
      pu: { ru: 'Client ID сервисного токена Access для e2e-тестов.', en: 'The Access service token’s client id, for the e2e tests.' } },
    { id: 'sec:ACCESS_SERVICE_TOKEN_SECRET', n: 'ACCESS_SERVICE_TOKEN_SECRET', k: 'secret', p: 'ghsec', src: 'owner', envs: ['dev', 'stage'], who: 'e2e',
      pu: { ru: 'Client Secret того же сервисного токена.', en: 'The same service token’s client secret.' } },
    { id: 'repo:PT_NTFY_TOPIC', n: 'PT_NTFY_TOPIC', k: 'secret', p: 'repo', src: 'owner', opt: true, who: 'product-team',
      pu: { ru: 'Тема ntfy для уведомлений команды. Без неё команда пишет только в задачи.', en: 'The ntfy topic for team notifications. Without it the team writes to issues only.' } },
    { id: 'repo:PT_TELEGRAM_TOKEN', n: 'PT_TELEGRAM_TOKEN', k: 'secret', p: 'repo', src: 'owner', opt: true, who: 'product-team',
      pu: { ru: 'Токен Telegram-бота для уведомлений команды.', en: 'The Telegram bot token for team notifications.' } },
    { id: 'local:CF_ACCESS_CLIENT_ID', n: 'CF_ACCESS_CLIENT_ID', k: 'secret', p: 'local', src: 'owner', envs: ['local'], who: 'console-e2e',
      pu: { ru: 'Client ID сервисного токена — e2e против stage на вашем Mac.', en: 'The service token client id — e2e against stage on your Mac.' } },
    { id: 'local:CF_ACCESS_CLIENT_SECRET', n: 'CF_ACCESS_CLIENT_SECRET', k: 'secret', p: 'local', src: 'owner', envs: ['local'], who: 'console-e2e',
      pu: { ru: 'Client Secret того же токена.', en: 'The same token’s client secret.' } },
  ];
  const PROJECTS = [{ slug: 'storify', name: 'Storify' }, { slug: 'team-console', name: 'Team Console' }];
  const SLUG = (slug) => slug.toUpperCase().replace(/-/g, '_');
  function projectItems() {
    const out = [];
    for (const pr of PROJECTS) {
      const S_ = SLUG(pr.slug);
      out.push({ id: `proj:${pr.slug}:R`, n: `ROUTINE_TOKEN_${S_}`, k: 'secret', p: 'project', src: 'owner', g: 'routine', proj: pr, who: 'api' });
      for (const sl of SLOTS) {
        out.push({ id: `proj:${pr.slug}:T:${sl}`, n: `SLOT_TOKEN_${S_}_${sl.toUpperCase()}`, k: 'secret', p: 'project', src: 'owner', proj: pr, who: 'api',
          pu: { ru: `Токен API-триггера рутины «${sl}» — для «Запустить сейчас».`, en: `The API trigger token of the “${sl}” routine — for Run now.` } });
        out.push({ id: `proj:${pr.slug}:I:${sl}`, n: `SLOT_ROUTINE_${S_}_${sl.toUpperCase()}`, k: 'secret', p: 'project', src: 'owner', proj: pr, who: 'api',
          pu: { ru: `Id рутины «${sl}» (trig_… из адреса триггера).`, en: `The “${sl}” routine id (trig_… from the trigger URL).` } });
      }
    }
    return out;
  }
  // Which items the demo reports missing on the console's own environment.
  const MISSING = new Set(['api:VAPID_PRIVATE_KEY', 'var:VAPID_PUBLIC_KEY', 'proj:storify:T:qa', 'proj:storify:I:qa']);

  /* ---------- guide content for six items (manifest data, adapted from the owner checklist) ---------- */
  const GUIDES = {
    cfToken: {
      ru: { purpose: 'Даёт GitHub Actions право деплоить Worker’ы, базу D1 и Storybook в {env}.',
        impact: 'Деплой в {env} падает на первом шаге. Работающая консоль не ломается, но обновления до неё не доходят.',
        where: [['Откройте dash.cloudflare.com → My Profile → API Tokens.', 'https://dash.cloudflare.com/profile/api-tokens'], ['Нажмите Create Token → Create Custom Token.'], ['Выберите права из списка ниже; в Account Resources — только ваш аккаунт.'], ['Нажмите Continue to summary → Create Token и скопируйте значение: Cloudflare показывает его один раз.']],
        perms: ['Account · Workers Scripts · Edit', 'Account · D1 · Edit', 'Account · Account Settings · Read', 'Account · Cloudflare Pages · Edit'],
        life: 'Живёт, пока вы его не удалите. Чтобы заменить: в том же списке нажмите Roll, затем выполните команду замены ниже. Старое значение перестаёт работать сразу.',
        gotchas: ['Только в секреты окружения GitHub, не в секреты репозитория: оттуда его видит любой workflow на любой ветке.', 'Один токен на все три окружения допустим, но тогда замена задевает все три сразу.'] },
      en: { purpose: 'Lets GitHub Actions deploy the Workers, the D1 database and Storybook to {env}.',
        impact: 'Deploys to {env} fail at the first step. The running console keeps working, but no update reaches it.',
        where: [['Open dash.cloudflare.com → My Profile → API Tokens.', 'https://dash.cloudflare.com/profile/api-tokens'], ['Click Create Token → Create Custom Token.'], ['Choose the permissions below; under Account Resources, only your account.'], ['Click Continue to summary → Create Token and copy the value: Cloudflare shows it once.']],
        perms: ['Account · Workers Scripts · Edit', 'Account · D1 · Edit', 'Account · Account Settings · Read', 'Account · Cloudflare Pages · Edit'],
        life: 'Lives until you delete it. To replace it, click Roll in the same list, then run the replace command below. The old value stops working at once.',
        gotchas: ['Environment secrets only, never repository secrets: every workflow on every branch can read those.', 'One token for all three environments is fine, but replacing it then affects all three at once.'] } },
    ownerEmail: {
      ru: { purpose: 'Адрес, с которым вы входите через Cloudflare Access. По нему консоль понимает, что вход — ваш.',
        impact: 'Консоль отвечает «нет доступа» на каждый запрос, в том числе вам.',
        where: [['Это ваш адрес — тот же, что в правиле Access этого окружения: Zero Trust → Access → Applications → team-console-{env} → Policies.', 'https://one.dash.cloudflare.com/']],
        life: 'Не истекает. Если меняете адрес, сначала поправьте правило Access, потом этот секрет — иначе потеряете вход.',
        gotchas: ['Задаётся только на Worker’е api, не на hooks.'] },
      en: { purpose: 'The address you sign in with through Cloudflare Access. The console uses it to know the session is yours.',
        impact: 'The console answers “no access” to every request, yours included.',
        where: [['It’s your own address — the one in this environment’s Access policy: Zero Trust → Access → Applications → team-console-{env} → Policies.', 'https://one.dash.cloudflare.com/']],
        life: 'Doesn’t expire. To change the address, update the Access policy first, then this secret — otherwise you lock yourself out.',
        gotchas: ['Set on the api Worker only, not on hooks.'] } },
    aud: {
      ru: { purpose: 'Метка приложения Access (AUD). По ней консоль проверяет, что вход выдан именно её приложением Access.',
        impact: 'Консоль не может проверить вход и отвечает «нет доступа» на каждый запрос.',
        where: [['Zero Trust → Access → Applications → team-console-{env} → Overview.', 'https://one.dash.cloudflare.com/'], ['Скопируйте Application Audience (AUD) Tag.']],
        life: 'Меняется, только если пересоздать приложение Access.',
        gotchas: ['Это переменная окружения GitHub, а не секрет: значение не тайное, но до Worker’а оно доходит только со следующим деплоем.'] },
      en: { purpose: 'The Access application’s tag (AUD). The console checks with it that the session was issued by its own Access application.',
        impact: 'The console can’t verify sign-ins and answers “no access” to every request.',
        where: [['Zero Trust → Access → Applications → team-console-{env} → Overview.', 'https://one.dash.cloudflare.com/'], ['Copy the Application Audience (AUD) Tag.']],
        life: 'Changes only if the Access application is recreated.',
        gotchas: ['A GitHub environment variable, not a secret: the value isn’t private, but it reaches the Worker only with the next deploy.'] } },
    vapid: {
      ru: { purpose: 'Закрытый ключ веб-пушей: им консоль подписывает уведомления на ваш iPhone и Mac.',
        impact: 'Уведомления не приходят; в Настройках блок «Уведомления» пишет, что сервер не настроен.',
        life: 'Не истекает. После замены каждое устройство нужно подписать заново: старые подписки перестанут получать уведомления.',
        gotchas: ['У каждого окружения своя пара: ключ из dev не подходит к production.', 'Задаётся одинаковым на api и на hooks; открытый ключ — переменная VAPID_PUBLIC_KEY, setup задаёт её вместе с ним.'] },
      en: { purpose: 'The web push private key: the console signs the notifications to your iPhone and Mac with it.',
        impact: 'No notifications arrive; the Notifications block in Settings says the server isn’t set up.',
        life: 'Doesn’t expire. After a replacement every device has to subscribe again: old subscriptions stop receiving.',
        gotchas: ['Each environment has its own pair: a dev key doesn’t work in production.', 'The same value goes on api and hooks; the public key is the VAPID_PUBLIC_KEY variable, which setup sets with it.'] } },
    routine: {
      ru: { purpose: 'Токен API-триггера рутины PM проекта {project}. Им консоль будит PM, когда вы пишете в чат.',
        impact: 'PM проекта {project} не отвечает в чате.',
        where: [['Откройте claude.ai/code/routines → рутину PM проекта {project}.', 'https://claude.ai/code/routines'], ['Добавьте триггер: Add trigger → API.'], ['Скопируйте токен: Claude показывает его один раз.']],
        life: 'Живёт, пока вы не удалите триггер. Чтобы заменить: создайте новый триггер, задайте токен командой замены ниже, затем удалите старый.',
        gotchas: ['Имя секрета строится из slug проекта заглавными буквами: {slug} → {name}.'] },
      en: { purpose: 'The API trigger token of {project}’s PM routine. The console wakes the PM with it when you write in the chat.',
        impact: '{project}’s PM doesn’t answer in the chat.',
        where: [['Open claude.ai/code/routines → {project}’s PM routine.', 'https://claude.ai/code/routines'], ['Add a trigger: Add trigger → API.'], ['Copy the token: Claude shows it once.']],
        life: 'Lives until you delete the trigger. To replace it: create a new trigger, set the token with the replace command below, then delete the old one.',
        gotchas: ['The secret’s name is the project slug in capitals: {slug} → {name}.'] } },
    appKey: {
      ru: { purpose: 'Закрытый ключ GitHub App этого окружения: им консоль читает ваши репозитории.',
        impact: 'Консоль не видит ни одного проекта: вопросы, доска и артефакты не загружаются.',
        life: 'Не истекает. Чтобы заменить: создайте новый ключ в настройках приложения на GitHub, выполните команду замены, затем удалите старый ключ там же.',
        gotchas: ['setup переводит ключ в PKCS#8 сам — вручную конвертировать ничего не нужно.'] },
      en: { purpose: 'This environment’s GitHub App private key: the console reads your repositories with it.',
        impact: 'The console can’t see any project: questions, board and artifacts don’t load.',
        life: 'Doesn’t expire. To replace it: generate a new key in the app’s settings on GitHub, run the replace command, then delete the old key there.',
        gotchas: ['setup converts the key to PKCS#8 itself — nothing to convert by hand.'] } },
  };

  /* ---------- shared state of the environment (one per console, both frames read it) ---------- */
  const D = { thisEnv: 'production', call: 'ok', allSet: false, proj: 'two', next: 'same', copyFail: false, fixed: false, checking: false, projLoading: false, checkedAt: null, fresh: null, stamp: false };
  const minsAgo = (m) => new Date(Date.now() - m * 60000);
  D.checkedAt = minsAgo(4);
  const offlineAt = minsAgo(26);
  const rateUntil = () => new Date(Date.now() + 9 * 60000);
  const unknownCall = () => ['loading', 'error', 'offline0', 'forbidden'].includes(D.call);
  const cmd = (env, flag) => `setup --env ${env}${flag ? ` ${flag}` : ''}`;

  function itemsFor(env) {
    let list = ITEMS.filter((i) => (i.envs || ALL3).includes(env));
    if (env !== 'local' && D.proj === 'two') list = list.concat(projectItems());
    return list;
  }
  function statusOf(i, env) {
    if (env === 'local' || env !== D.thisEnv || !VISIBLE.has(i.p)) return 'unseen';
    if (unknownCall()) return null;
    if (D.allSet || D.fixed) return 'set';
    return MISSING.has(i.id) ? 'missing' : 'set';
  }
  function counts(env) {
    let missing = 0; let unseen = 0;
    for (const i of itemsFor(env)) { const s = statusOf(i, env); if (s === 'missing' && !i.opt) missing += 1; if (s === 'unseen') unseen += 1; }
    return { missing, unseen };
  }
  const RANK = { missing: 0, unseen: 1, set: 2 };
  const sorted = (list, env) => list.map((i, n) => ({ i, n })).sort((a, b) => ((RANK[statusOf(a.i, env)] ?? 3) - (RANK[statusOf(b.i, env)] ?? 3)) || a.n - b.n).map((x) => x.i);
  function placesFor(env) {
    if (env === 'local') return ['local'];
    const own = env === D.thisEnv;
    const order = PLACES.filter((p) => p !== 'local');
    return own ? order : order; // visible groups are already first in the spec's order
  }
  function orderedItems(env) {
    const list = itemsFor(env); const out = [];
    for (const p of placesFor(env)) {
      if (p === 'project') { for (const pr of PROJECTS) out.push(...sorted(list.filter((i) => i.proj && i.proj.slug === pr.slug), env)); }
      else out.push(...sorted(list.filter((i) => i.p === p), env));
    }
    return out;
  }
  const guideOf = (i) => (i.g && GUIDES[i.g] ? GUIDES[i.g][lang()] : null);
  const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  const varsOf = (i, env) => ({ env, project: i.proj ? i.proj.name : '', slug: i.proj ? i.proj.slug : '', name: i.n });
  function purposeOf(i, env) { const g = guideOf(i); if (g) return fill(g.purpose, varsOf(i, env)); return i.pu ? i.pu[lang()] : ''; }

  const hosts = [...document.querySelectorAll('[data-app]')];
  let pageChrome = null;

  /* ---------- one app instance ---------- */
  function mountApp(host, kind, keep) {
    const S = keep || { route: 'settings', env: D.thisEnv, item: null, from: 'env', open: {}, anim: null, copyFailKey: null, listTop: 0 };
    host.S = S;
    const uid = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const $ = (s) => host.querySelector(s);
    const domId = (id) => `${uid}-${id.replace(/[^A-Za-z0-9]/g, '_')}`;
    const find = (id) => itemsFor(S.env).find((i) => i.id === id);
    const mac = kind === 'mac';

    host.innerHTML = mac ? `<div class="win">
        <div class="win__bar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="win__title">Team Console</span></div>
        <div class="win__body">
          <nav class="sidebar" aria-label="${t('nav.aria')}">
            <div class="brand">${IX.mark}<span>Team Console</span></div>
            <ul class="side-list side-list--top">
              <li><button type="button" class="side-item" data-act="space">${IX.inbox}<span>${t('nav.needs')}</span></button></li>
              <li><button type="button" class="side-item" data-act="space">${IX.grid}<span>${t('nav.all')}</span></button></li>
            </ul>
            <div class="side-label">${t('nav.projects')}</div>
            <ul class="side-list">${PROJECTS.map((p) => `<li><button type="button" class="side-item" data-act="space"><span class="prod-mono" aria-hidden="true">${esc(p.slug[0])}</span><span class="side-prod__label">${esc(p.name)}</span></button></li>`).join('')}</ul>
            <div class="side-foot">
              <button type="button" class="side-item side-item--settings" data-act="go-settings" data-fk="nav-settings" aria-current="page">${IX.gear}<span>${t('nav.settings')}</span></button>
              <div class="side-foot__row"><span class="avatar avatar--owner" aria-hidden="true">K</span><span>${t('shell.owner')}</span></div>
            </div>
          </nav>
          <section class="set-main" aria-label="${t('nav.settings')}">
            <header class="convo__head"><nav class="crumbs" aria-label="${t('nav.crumbs')}" data-slot="crumbs"></nav></header>
            <div class="env-body" data-slot="body" style="display:flex;flex-direction:column;flex:1;min-height:0"></div>
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
    const dis = (on, reason) => (on ? ` aria-disabled="true"${reason ? ` aria-describedby="${reason}"` : ''}` : '');
    function codeline(value, aria, key) {
      const fail = S.copyFailKey === key ? `<p class="copy-fail" role="status">${t('common.copyFailed')}</p>` : '';
      const words = String(value).split(' ').map((w) => `<span class="cw">${esc(w)}</span>`).join(' ');
      return `<div class="codeline"><code>${words}</code><button type="button" class="btn btn--sm" data-act="copy" data-value="${esc(value)}" data-key="${esc(key)}" data-fk="copy-${esc(key)}" aria-label="${esc(aria)}">${IX.copy}<span aria-hidden="true">${t('common.copy')}</span></button></div>${fail}`;
    }
    const extLink = (href, fk) => `<a class="ext" href="${esc(href)}" target="_blank" rel="noopener noreferrer"${fk ? ` data-fk="${fk}"` : ''}>${esc(href.replace(/^https:\/\//, '').replace(/\/$/, ''))}<span class="sr-only"> ${t('env.g.external')}</span>${IX.ext}</a>`;
    function chip(s, i, id) {
      const fresh = D.fresh && i && D.fresh.includes(i.id);
      const freshAttr = fresh ? ` is-new" style="--i:${D.fresh.indexOf(i.id)}` : '';
      const idAttr = id ? ` id="${id}"` : '';
      let c = '';
      if (s === 'set') c = `<span class="status est est--set${freshAttr}"${idAttr}>${IX.check}${t('env.st.set')}</span>`;
      if (s === 'missing') c = `<span class="status est est--missing${freshAttr}"${idAttr}>${IX.bang}${t('env.st.missing')}</span>`;
      if (s === 'unseen') c = `<span class="status est est--unseen"${idAttr}>${IX.eyeOff}${t('env.st.unseen')}</span>`;
      const opt = i && i.opt && s !== 'set' ? `<span class="etag etag--opt">${t('env.st.optional')}</span>` : '';
      return c + opt;
    }

    /* ----- Settings, with the new Environment section ----- */
    function entryChip() {
      if (D.call === 'loading' || D.checking) return `<span class="status est est--checking">${dots}${t('env.entry.checking')}</span>`;
      if (['error', 'offline0', 'forbidden', 'rate'].includes(D.call)) return `<span class="status est est--unknown">${IX.q}${t('env.entry.unknown')}</span>`;
      const c = counts(D.thisEnv);
      if (c.missing) return `<span class="status est est--missing">${IX.bang}${t('env.entry.missing', { n: c.missing })}</span>`;
      return `<span class="status est est--set">${IX.check}${t('env.entry.ok')}</span>`;
    }
    function settingsScreen() {
      const pushOff = !unknownCall() && statusOf(ITEMS.find((i) => i.id === 'api:VAPID_PRIVATE_KEY'), D.thisEnv) === 'missing';
      const push = pushOff
        ? `<div class="ctx-card ctx-card--warn"><span class="gh__mark" aria-hidden="true">${IX.bang}</span><div class="ctx-card__txt"><h3 class="ctx-card__title">${t('set.push.off')}</h3><p class="ctx-card__meta">${t('set.push.offBody')}</p></div>
            <button type="button" class="btn" data-act="deep" data-fk="push-guide">${t('set.push.guide')}</button></div>`
        : `<div class="ctx-card"><span class="gh__mark" style="background:var(--success-soft);color:var(--success-text)" aria-hidden="true">${IX.bell}</span><div class="ctx-card__txt"><h3 class="ctx-card__title">${t(mac ? 'set.push.onMac' : 'set.push.on')}</h3><p class="ctx-card__meta">${t('set.push.meta')}</p></div></div>`;
      return `<div class="set-head"><h1 tabindex="-1" data-fk="h1">${t('nav.settings')}</h1></div>
        <section class="sec" aria-labelledby="${uid}-s-gh"><h2 class="sec-title" id="${uid}-s-gh">${t('set.gh')}</h2>
          <div class="ctx-card"><span class="gh__mark" style="background:var(--success-soft);color:var(--success-text)" aria-hidden="true">${IX.check}</span><div class="ctx-card__txt"><h3 class="ctx-card__title">${t('set.gh.title', { login: 'geeera' })}</h3><p class="ctx-card__meta">${t('set.gh.meta', { env: D.thisEnv })}</p></div></div></section>
        <section class="sec" aria-labelledby="${uid}-s-push"><h2 class="sec-title" id="${uid}-s-push">${t('set.push')}</h2>${push}</section>
        <section class="sec" aria-labelledby="${uid}-s-env"><h2 class="sec-title" id="${uid}-s-env">${t('env.entry.section')}</h2>
          <ul class="plist"><li class="prow erow-entry"><a class="prow__link" href="#/settings/environment/${D.thisEnv}" data-act="go-env" data-fk="entry" data-testid="env-entry">
            <span class="env-ico" aria-hidden="true">${IX.key}</span>
            <span class="prow__txt"><span class="entry__name">${t('env.entry.row')}</span><span class="entry__sub">${fill(esc(t('env.entry.sub', { env: '\u0000' })), { }).replace('\u0000', `<code>${esc(D.thisEnv)}</code>`)}</span></span>
            ${entryChip()}${IX.chev}</a></li></ul></section>
        <section class="sec" aria-labelledby="${uid}-s-pj"><h2 class="sec-title" id="${uid}-s-pj">${t('set.projects')}</h2>
          <ul class="plist">${PROJECTS.map((p) => `<li class="prow"><a class="prow__link" href="#/settings/projects/${p.slug}" data-act="space"><span class="prod-mono" aria-hidden="true">${esc(p.slug[0])}</span><span class="prow__txt"><span class="prow__name">${esc(p.name)}</span><span class="prow__repo">geeera/${esc(p.slug)}</span></span><span></span>${IX.chev}</a></li>`).join('')}</ul></section>
        <section class="sec" aria-labelledby="${uid}-s-lang"><h2 class="sec-title" id="${uid}-s-lang">${t('set.lang')}</h2>
          <div class="lang-seg" role="group" aria-labelledby="${uid}-s-lang"><button type="button" lang="ru" data-act="lang" data-v="ru" aria-pressed="${lang() === 'ru'}">Русский</button><button type="button" lang="en" data-act="lang" data-v="en" aria-pressed="${lang() === 'en'}">English</button></div></section>`;
    }

    /* ----- Environment setup ----- */
    function tabs() {
      return `<div class="etabs" role="tablist" aria-label="${t('env.tabs')}" data-tabs>${ENVS.map((e) => {
        const sel = e === S.env;
        const mine = e === D.thisEnv ? `<span class="etab__this"><i aria-hidden="true"></i>${t('env.tab.this')}</span>` : '';
        return `<button type="button" role="tab" class="etab" id="${uid}-tab-${e}" aria-selected="${sel}" aria-controls="${uid}-panel" tabindex="${sel ? 0 : -1}" data-act="tab" data-env="${e}" data-fk="tab-${e}"><span class="etab__name">${e}</span>${mine}</button>`;
      }).join('')}</div>`;
    }
    function summary() {
      const env = S.env;
      if (env === 'local') {
        return `<section class="esum esum--quiet" aria-labelledby="${uid}-sum"><div class="esum__top"><span class="esum__mark" aria-hidden="true">${IX.laptop}</span><h2 class="sr-only" id="${uid}-sum">${t('env.group.local')}</h2><p style="align-self:center">${t('env.sum.local')}</p></div>${codeline(cmd('local', '--check'), t('env.copyAriaEnv', { env: 'local' }), 'sum-local')}</section>`;
      }
      if (env !== D.thisEnv) {
        return `<section class="esum esum--quiet" aria-labelledby="${uid}-sum"><div class="esum__top"><span class="esum__mark" aria-hidden="true">${IX.eyeOff}</span><h2 class="sr-only" id="${uid}-sum">${t('env.st.unseen')}</h2><p style="align-self:center">${t('env.sum.other', { this: D.thisEnv, env })}</p></div>${codeline(cmd(env, '--check'), t('env.copyAriaEnv', { env }), 'sum-other')}</section>`;
      }
      if (D.call === 'loading') {
        return `<div class="esum"><span class="sr-only">${t('env.loading')}</span><div class="esum__top" aria-hidden="true"><span class="esum__mark skel" style="width:var(--env-mark);height:var(--env-mark);border-radius:50%"></span><div class="esum-skel" style="flex:1"><span class="skel skel--c"></span><span class="skel skel--d"></span></div></div><div class="esum-skel" aria-hidden="true"><span class="skel skel--e"></span></div></div>`;
      }
      if (D.call === 'error') {
        return `<div class="block block--error" role="alert"><h2 tabindex="-1" data-fk="sum-h">${t('env.err.load.title')}</h2><p>${t('env.err.load.body')}</p><button type="button" class="btn btn--tall" data-act="retry" data-fk="retry">${t('common.retry')}</button></div>`;
      }
      if (D.call === 'forbidden') {
        return `<div class="block block--lock" role="alert">${IX.lock.replace('class="ico"', 'class="ico ico-lead"')}<h2 tabindex="-1" data-fk="sum-h">${t('env.err.forbidden.title')}</h2><p>${t('env.err.forbidden.body')}</p></div>`;
      }
      if (D.call === 'offline0') {
        return `<div class="paused env-note env-note--plain" role="status">${IX.wifi}<span>${t('env.err.offline0')}</span></div>`;
      }
      const c = counts(env);
      const fresh = D.fresh ? ' is-new' : '';
      let h = '';
      if (D.call === 'offline') h += `<div class="paused env-note" role="status" id="${uid}-why">${IX.wifi}<span>${t('env.err.offline', { time: hhmm(offlineAt) })}</span></div>`;
      if (D.call === 'rate') h += `<div class="paused env-note" role="status" id="${uid}-why">${IX.clock}<span>${t('env.err.rate', { time: hhmm(D.rateUntil) })}</span></div>`;
      const stamped = !c.missing && S.stamp;
      h += `<section class="esum ${c.missing ? 'esum--todo' : 'esum--ok'}${stamped ? ' esum--stamped' : ''}${fresh}" aria-labelledby="${uid}-sum" data-testid="env-summary" data-sum>`;
      if (c.missing) {
        h += `<div class="esum__top"><span class="esum__mark" aria-hidden="true">${c.missing}</span><h2 class="esum__title" id="${uid}-sum" tabindex="-1" data-fk="sum-h">${t('env.sum.missing', { n: c.missing, env })}</h2></div>
          <p>${t('env.sum.missingBody')}</p>${codeline(cmd(env), t('env.copyAriaEnv', { env }), 'sum-set')}
          <button type="button" class="link-btn" data-act="jump" data-fk="jump">${t('env.sum.jump')}</button>`;
      } else {
        h += `<div class="esum__top"><span class="esum__mark" aria-hidden="true">${IX.check}</span><h2 class="esum__title" id="${uid}-sum" tabindex="-1" data-fk="sum-h">${t('env.sum.ok', { env })}</h2></div>`;
      }
      if (c.unseen) h += `<div class="esum__unseen"><p>${IX.eyeOff}<span>${t('env.sum.unseen', { n: c.unseen })}</span></p>${codeline(cmd(env, '--check'), t('env.copyAriaEnv', { env }), 'sum-check')}</div>`;
      const off = D.call === 'offline' || D.call === 'rate';
      const reason = D.call === 'offline' ? t('env.sum.offReason') : D.call === 'rate' ? t('env.sum.rateReason', { time: hhmm(D.rateUntil) }) : '';
      h += `<div class="esum__foot"><p class="res__time">${t('env.sum.checkedAt', { time: hhmm(D.checkedAt) })}</p>
        <button type="button" class="btn btn--tall" data-act="recheck" data-fk="recheck"${dis(off || D.checking, off ? `${uid}-reason` : '')}>${IX.refresh}${D.checking ? t('env.sum.rechecking') : t('env.sum.recheck')}</button>
        ${off ? `<p class="esum__reason" id="${uid}-reason">${reason}</p>` : ''}</div>`;
      if (stamped) h += '<div class="stamp" aria-hidden="true"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="28"/><circle class="stamp__inner" cx="32" cy="32" r="23"/><path d="M21 33l8 8 15-17"/></svg></div>';
      return `${h}</section>`;
    }
    function row(i, env) {
      const s = statusOf(i, env);
      const did = domId(i.id);
      const cur = S.item === i.id && mac ? ' aria-current="true"' : '';
      const fix = s === 'missing' ? `<div class="erow__fix"><span class="erow__fix-label" aria-hidden="true">${t('env.row.fix')}</span>${codeline(cmd(env), t('env.row.copyAria', { name: i.n }), `row-${i.id}`)}</div>` : '';
      const chips = chip(s, i, `${did}-st`);
      return `<li class="erow${s === 'missing' ? ' erow--missing' : ''}" data-row="${esc(i.id)}"${cur}>
        <button type="button" class="erow__btn" data-act="item" data-id="${esc(i.id)}" data-fk="row-${esc(i.id)}" aria-labelledby="${did}-n${s ? ` ${did}-st` : ''}" aria-describedby="${did}-p">
          <span class="erow__txt"><span class="erow__name" id="${did}-n">${esc(i.n)}</span><span class="erow__purpose" id="${did}-p">${esc(purposeOf(i, env))}</span></span>
          <span class="erow__chips">${chips}</span>${IX.chev}</button>${fix}</li>`;
    }
    function groups() {
      const env = S.env; const own = env === D.thisEnv;
      if (own && D.call === 'forbidden') return '';
      const list = itemsFor(env);
      let h = '';
      for (const p of placesFor(env)) {
        const visible = own && VISIBLE.has(p);
        const hintKey = p === 'local' || p === 'repo' || p === 'hooks' || p === 'ghsec' || own ? `env.group.${p}.hint` : 'env.group.hooks.hint';
        const icon = p === 'local' ? IX.laptop : visible ? IX.eye : IX.eyeOff;
        const head = `<h2 class="egrp__title" id="${uid}-g-${p}">${t(`env.group.${p}`)}</h2><p class="egrp__hint">${icon}<span>${t(p === 'project' && !own ? 'env.group.hooks.hint' : hintKey)}</span></p>`;
        if (p === 'project') {
          let body;
          if (D.projLoading) body = `<div aria-busy="true"><span class="sr-only">${t('env.loading')}</span><div class="elist" aria-hidden="true">${'<div class="skel-row"><span class="skel skel--mono"></span><span class="skel-stack"><span class="skel skel--a"></span><span class="skel skel--b"></span></span></div>'.repeat(2)}</div></div>`;
          else if (D.proj === 'none') body = `<div class="block"><p>${t('env.proj.none')}</p></div>`;
          else if (D.proj === 'error') body = `<div class="block block--error" role="alert"><p>${t('env.proj.error')}</p><button type="button" class="btn btn--sm" data-act="proj-retry" data-fk="proj-retry">${t('common.retry')}</button></div>`;
          else {
            body = `<div class="eprojs">${PROJECTS.map((pr) => {
              const its = list.filter((i) => i.proj && i.proj.slug === pr.slug);
              const sts = its.map((i) => statusOf(i, env));
              const miss = sts.includes('missing');
              const open = S.open[`${env}:${pr.slug}`] ?? miss;
              const set = sts.filter((x) => x === 'set').length;
              let c = '';
              if (!own) c = `<span class="status est est--unseen">${IX.eyeOff}${t('env.st.unseen')}</span>`;
              else if (sts[0]) c = `<span class="status est ${miss ? 'est--missing' : 'est--set'}">${miss ? IX.bang : IX.check}${t('env.proj.count', { set, total: its.length })}</span>`;
              const lid = `${uid}-p-${pr.slug}`;
              return `<div class="eproj"><button type="button" class="eproj__btn" aria-expanded="${open}" aria-controls="${lid}" data-act="proj" data-slug="${pr.slug}" data-fk="proj-${pr.slug}"><span class="prod-mono" aria-hidden="true">${esc(pr.slug[0])}</span><span class="eproj__name">${esc(pr.name)}</span>${c}${IX.down}</button>
                <ul class="elist" id="${lid}"${open ? '' : ' hidden'}>${sorted(its, env).map((i) => row(i, env)).join('')}</ul></div>`;
            }).join('')}</div>`;
          }
          h += `<section class="egrp${visible ? '' : ' egrp--unseen'}" aria-labelledby="${uid}-g-${p}">${head}${body}</section>`;
          continue;
        }
        const its = list.filter((i) => i.p === p);
        if (!its.length) continue;
        h += `<section class="egrp${visible || p === 'local' ? '' : ' egrp--unseen'}" aria-labelledby="${uid}-g-${p}">${head}<ul class="elist">${sorted(its, env).map((i) => row(i, env)).join('')}</ul></section>`;
      }
      return h;
    }
    function envScreen() {
      const busy = S.env === D.thisEnv && (D.call === 'loading' || D.checking);
      return `<div class="env-head">${mac ? '' : ''}<h1 tabindex="-1" data-fk="h1">${t('env.title')}</h1><p class="set-lead">${t('env.lead')}</p></div>
        ${tabs()}
        <div class="env-panel" role="tabpanel" id="${uid}-panel" aria-labelledby="${uid}-tab-${S.env}"${busy ? ' aria-busy="true"' : ''}>${summary()}${groups()}</div>`;
    }

    /* ----- the guide: its own page on iPhone, a pane beside the list on the Mac ----- */
    function guide(pane) {
      const i = find(S.item); const env = S.env;
      const hl = pane ? 2 : 1;
      if (!i) {
        const back = pane ? '' : `<button type="button" class="btn btn--tall" data-act="back" data-fk="nf-back">${IX.back}${S.from === 'settings' ? t('env.g.back.settings') : t('env.g.back', { env })}</button>`;
        return `<div class="gnf"><h${hl} class="gnf__h" id="${uid}-gh" tabindex="-1" data-fk="g-h">${t('env.g.notFound.title', { env })}</h${hl}><p>${t('env.g.notFound.body')}</p>${back}</div>`;
      }
      const s = statusOf(i, env); const g = guideOf(i); const v = varsOf(i, env);
      const tx = (str) => esc(fill(str, v));
      const own = env === D.thisEnv && env !== 'local';
      const sec = (key, body, cls = '') => `<section class="gsec${cls}" aria-labelledby="${uid}-gs-${key}"><h${hl + 1} class="gsec__h" id="${uid}-gs-${key}">${t(`env.g.${key}`)}</h${hl + 1}>${body}</section>`;
      let h = `<header><h${hl} class="guide__h" id="${uid}-gh" tabindex="-1" data-fk="g-h">${esc(i.n)}</h${hl}>
        <div class="guide__meta">${s ? chip(s, i) : ''}<span class="etag">${t(`env.g.kind.${i.k}`)}</span><span class="etag">${t(`env.g.place.${i.p}`, { env, project: v.project })}</span><span class="etag">${t(`env.g.src.${i.src}`)}</span><span class="etag">${t('env.g.needs', { who: i.who })}</span></div>
        ${s === 'set' && own && !unknownCall() ? `<p class="guide__time">${t('env.sum.checkedAt', { time: hhmm(D.checkedAt) })}</p>` : ''}</header>
        <p class="gnever">${IX.lock}<span>${t('env.g.never')}</span></p>`;
      h += sec('purpose', `<p>${esc(purposeOf(i, env))}</p>`, ' gsec--purpose');
      if (g && g.impact) h += sec('impact', `<p>${tx(g.impact)}</p>`);
      if (i.src === 'gen') h += sec('where', `<p class="gplain">${t('env.g.where.gen')}</p>`);
      else if (i.src === 'app') h += sec('where', `<p class="gplain">${t('env.g.where.app')}</p>`);
      else if (g && g.where) h += sec('where', `<ol class="gsteps">${g.where.map(([txt, url], n) => `<li><span class="gstep__txt"><span>${tx(txt)}</span>${url ? extLink(url, `g-link-${n}`) : ''}</span></li>`).join('')}</ol>`);
      if (g && g.perms) h += sec('perms', `<ul class="gperms">${g.perms.map((x) => `<li>${IX.check}<span>${esc(x)}</span></li>`).join('')}</ul>`);
      const life = g && g.life ? g.life : i.life ? i.life[lang()] : '';
      if (life) h += sec('life', `<p>${tx(life)}</p>`);
      if (g && g.gotchas) h += sec('gotchas', `<ul class="ggotchas">${g.gotchas.map((x) => `<li>${tx(x)}</li>`).join('')}</ul>`);
      let how;
      const aria = t('env.row.copyAria', { name: i.n });
      if (s === 'unseen') how = `<p>${t('env.g.how.check')}</p>${codeline(cmd(env, '--check'), aria, 'g-check')}<p>${t('env.g.how.body')}</p>${codeline(cmd(env), aria, 'g-set')}`;
      else if (s === 'set') how = `<p>${t('env.g.how.rotate')}</p>${codeline(cmd(env, '--rotate'), aria, 'g-rotate')}`;
      else how = `<p>${t('env.g.how.body')}</p>${codeline(cmd(env), aria, 'g-set')}`;
      h += sec('how', `<div class="ghow">${how}</div>`);
      return `<article class="guide" aria-labelledby="${uid}-gh">${h}</article>`;
    }

    /* ----- chrome per route ----- */
    function chrome() {
      if (mac) {
        const c = [];
        if (S.route === 'settings') c.push(`<li><span aria-current="page">${t('nav.settings')}</span></li>`);
        else {
          c.push(`<li><a href="#/settings" data-act="go-settings" data-fk="crumb-settings">${t('nav.settings')}</a></li>`);
          if (S.item) {
            const i = find(S.item);
            c.push(`<li><a href="#/settings/environment/${S.env}" data-act="close-guide" data-fk="crumb-env">${t('env.title')}</a></li>`);
            c.push(`<li><span aria-current="page" class="crumbs__url">${esc(i ? i.n : S.item.split(':').pop())}</span></li>`);
          } else c.push(`<li><span aria-current="page">${t('env.title')}</span></li>`);
        }
        $('[data-slot=crumbs]').innerHTML = `<ol>${c.join('')}</ol>`;
        return;
      }
      const back = S.route === 'settings' ? t('nav.projects') : S.route === 'env' ? t('nav.settings') : S.from === 'settings' ? t('env.g.back.settings') : t('env.g.back', { env: S.env });
      $('[data-slot=phead]').innerHTML = `<header class="p-bar"><button type="button" class="p-back" data-act="back" data-fk="back">${IX.back}<span>${esc(back)}</span></button><span></span><span></span></header>`;
    }

    /* ----- render with focus kept by data-fk ----- */
    const scroller = () => host.querySelector('.env-split__list, .set-scroll, .p-scroll');
    function render(opts = {}) {
      const active = host.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
      const sc = scroller(); const top = sc ? sc.scrollTop : 0;
      const pane = host.querySelector('.env-split__pane'); const paneTop = pane ? pane.scrollTop : 0;
      chrome();
      let animEl = null;
      if (mac) {
        const body = $('[data-slot=body]');
        if (S.route === 'settings') body.innerHTML = `<div class="set-scroll"><div class="set-inner">${settingsScreen()}</div></div>`;
        else if (S.item) {
          body.innerHTML = `<div class="env-split"><div class="env-split__list"><div class="set-inner">${envScreen()}</div></div>
            <section class="env-split__pane" aria-labelledby="${uid}-gh" data-pane><div class="gpane__bar"><button type="button" class="icon-btn" data-act="close-guide" data-fk="g-close" aria-label="${t('env.g.close')}">${IX.x}</button></div>${guide(true)}</section></div>`;
          animEl = host.querySelector('[data-pane]');
        } else body.innerHTML = `<div class="set-scroll"><div class="set-inner">${envScreen()}</div></div>`;
      } else {
        const screen = $('[data-slot=screen]');
        screen.innerHTML = S.route === 'settings' ? settingsScreen() : S.route === 'env' ? envScreen() : guide(false);
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
      if (D.stamp && host.querySelector('[data-sum] .stamp')) stamp();
    }
    const announce = (txt) => { const l = $('[data-slot=live]'); l.textContent = ''; setTimeout(() => { l.textContent = txt; }, 30); };
    let toastTimer;
    function toast(txt) {
      const el = $('[data-slot=toast]'); el.textContent = txt; el.hidden = false;
      clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, Proto.ms('--dur-toast'));
    }
    // Signature moment, reused from Paper Desk: the ink stamp presses onto the summary when the last missing item is set.
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
    function goSettings(focus) { S.route = 'settings'; S.item = null; S.anim = 'pop'; render({ focus: focus || 'h1', scrollTop: 'top' }); }
    function goEnv(env) { S.route = 'env'; S.env = env || D.thisEnv; S.item = null; S.from = 'env'; S.anim = 'push'; render({ focus: 'h1', scrollTop: 'top' }); }
    function openItem(id, from) {
      S.from = from || 'env';
      const sc = scroller(); if (!mac && sc && S.route === 'env') S.listTop = sc.scrollTop;
      S.item = id;
      if (mac) { S.route = 'env'; S.anim = 'pane'; render({ focus: 'g-h', newPane: true }); host.querySelector('.env-split__pane').scrollTop = 0; return; }
      S.route = 'guide'; S.anim = 'push'; render({ focus: 'g-h', scrollTop: 'top' });
    }
    function closeItem() {
      const id = S.item;
      if (S.from === 'settings') { S.from = 'env'; goSettings('push-guide'); return; }
      S.item = null; S.route = 'env';
      if (!mac) { S.anim = 'pop'; render({ focus: `row-${id}`, scrollTop: S.listTop }); return; }
      render({ focus: `row-${id}` });
    }
    function selectTab(env) {
      if (env === S.env) return;
      S.env = env; S.item = null; S.copyFailKey = null;
      render({ focus: `tab-${env}` });
      const h = host.querySelector(`#${uid}-sum`) || host.querySelector('[data-fk=sum-h]') || host.querySelector('.env-note, .esum p');
      if (h) announce(plain(h.textContent));
    }
    function jump() {
      const first = orderedItems(S.env).find((i) => statusOf(i, S.env) === 'missing' && !i.opt);
      if (!first) return;
      if (first.proj) S.open[`${S.env}:${first.proj.slug}`] = true;
      render({ focus: `row-${first.id}`, reveal: true });
      const li = host.querySelector(`[data-row="${CSS.escape(first.id)}"]`);
      if (li) { li.classList.remove('is-flash'); void li.offsetWidth; li.classList.add('is-flash'); }
    }

    /* ----- copy ----- */
    async function copy(btn) {
      const key = btn.dataset.key;
      try {
        if (D.copyFail) throw new Error('Clipboard refused (demo)');
        await navigator.clipboard.writeText(btn.dataset.value);
      } catch (err) {
        console.warn('Copy failed; showing the copy-it-by-hand note', err);
        S.copyFailKey = key; render({ focus: btn.dataset.fk });
        const code = host.querySelector(`[data-fk="${CSS.escape(btn.dataset.fk)}"]`)?.parentElement.querySelector('code');
        if (code) { const r = document.createRange(); r.selectNodeContents(code); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
        announce(t('common.copyFailed'));
        return;
      }
      if (S.copyFailKey) { S.copyFailKey = null; render(); }
      const b = host.querySelector(`[data-fk="${CSS.escape(btn.dataset.fk)}"]`) || btn;
      const label = b.querySelector('span'); label.textContent = t('common.copied'); b.dataset.copied = '';
      announce(t('common.copied'));
      setTimeout(() => { if (b.isConnected) { label.textContent = t('common.copy'); delete b.dataset.copied; } }, 2000);
    }

    /* ----- events ----- */
    host.onclick = (e) => {
      const el = e.target.closest('[data-act]'); if (!el || !host.contains(el)) return;
      const act = el.dataset.act;
      if (el.tagName === 'A' && act) e.preventDefault();
      if (el.getAttribute('aria-disabled') === 'true') return;
      switch (act) {
        case 'go-settings': goSettings(); break;
        case 'go-env': goEnv(); break;
        case 'item': openItem(el.dataset.id); break;
        case 'deep': S.env = D.thisEnv; openItem('api:VAPID_PRIVATE_KEY', 'settings'); break;
        case 'close-guide': closeItem(); break;
        case 'back':
          if (S.route === 'settings') toast(t('demo.space'));
          else if (S.route === 'env') goSettings('entry');
          else closeItem();
          break;
        case 'tab': selectTab(el.dataset.env); break;
        case 'jump': jump(); break;
        case 'recheck': recheck(host); break;
        case 'retry': retry(host); break;
        case 'proj': { const k = `${S.env}:${el.dataset.slug}`; S.open[k] = el.getAttribute('aria-expanded') !== 'true'; render(); break; }
        case 'proj-retry': projRetry(host); break;
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
      render, S, uid,
      announce,
      go(screen) {
        S.copyFailKey = null;
        const guides = { gCf: 'sec:CLOUDFLARE_API_TOKEN', gOwner: 'api:OWNER_EMAIL', gAud: 'var:ACCESS_AUD', gVapid: 'api:VAPID_PRIVATE_KEY', gRoutine: 'proj:storify:R', gApp: 'api:GITHUB_APP_PRIVATE_KEY', gGen: 'api:TOKEN_ENCRYPTION_KEY', gUnknown: 'api:NO_SUCH_SETTING' };
        if (screen === 'settings') { goSettings(); return; }
        if (screen === 'env') { goEnv(D.thisEnv); return; }
        if (screen === 'tabOther') { goEnv(D.thisEnv === 'stage' ? 'dev' : 'stage'); return; }
        if (screen === 'tabLocal') { goEnv('local'); return; }
        if (screen === 'deep') { S.route = 'settings'; S.env = D.thisEnv; openItem('api:VAPID_PRIVATE_KEY', 'settings'); return; }
        if (guides[screen]) { S.route = 'env'; S.env = D.thisEnv; openItem(guides[screen]); }
      },
    };
    host.app = app;
    render();
    return app;
  }

  /* ---------- shared actions: the status call is one per environment, both frames show it ---------- */
  const others = (host) => hosts.filter((h) => h !== host && h.app);
  function renderAll(except) { hosts.forEach((h) => { if (h.app && h !== except) h.app.render(); }); }
  async function recheck(host) {
    if (D.checking) return;
    const env = D.thisEnv;
    const before = new Map(itemsFor(env).map((i) => [i.id, statusOf(i, env)]));
    const hadMissing = counts(env).missing > 0;
    D.checking = true; renderAll(); host.app.announce(plain(t('env.loading')));
    await wait(1100);
    D.checking = false;
    if (D.next === 'error') { D.call = 'error'; renderAll(host); host.app.render({ focus: 'sum-h' }); return; }
    if (D.next === 'fixed') D.fixed = true;
    D.call = 'ok'; D.checkedAt = new Date();
    D.fresh = itemsFor(env).filter((i) => before.get(i.id) !== statusOf(i, env)).map((i) => i.id);
    if (hadMissing && !counts(env).missing) hosts.forEach((h) => { if (h.S) h.S.stamp = true; });
    D.stamp = true;
    renderAll(host); host.app.render({ focus: 'recheck' });
    D.fresh = null; D.stamp = false;
    syncDemo();
    const h = host.querySelector('[data-fk=sum-h]'); if (h) host.app.announce(plain(h.textContent));
  }
  async function retry(host) {
    D.call = 'loading'; renderAll();
    await wait(900);
    D.call = 'ok'; D.checkedAt = new Date(); syncDemo();
    renderAll(host); host.app.render({ focus: 'sum-h' });
  }
  async function projRetry(host) {
    D.projLoading = true; renderAll(host); host.app.render({ focus: 'h1' });
    await wait(800);
    D.projLoading = false; D.proj = 'two'; syncDemo();
    renderAll(host); host.app.render({ focus: `proj-${PROJECTS[0].slug}`, reveal: true });
  }

  /* ---------- page controls ---------- */
  const mountAll = (keep) => hosts.forEach((h) => { const prev = keep && h.S ? h.S : null; h.className = 'app'; mountApp(h, h.dataset.app, prev); });
  pageChrome = Proto.page({ L, title: 'Team Console · #104', onLang: () => mountAll(true) });
  const sel = (id) => document.getElementById(id);
  function syncDemo() { sel('d-this').value = D.thisEnv; sel('d-call').value = D.call; sel('d-all').checked = D.allSet; sel('d-proj').value = D.proj; sel('d-next').value = D.next; sel('d-copy').checked = D.copyFail; }
  sel('d-this').addEventListener('change', (e) => { const old = D.thisEnv; D.thisEnv = e.target.value; hosts.forEach((h) => { if (h.S && h.S.env === old) { h.S.env = D.thisEnv; h.S.item = null; if (h.S.route === 'guide') h.S.route = 'env'; } }); renderAll(); });
  sel('d-call').addEventListener('change', (e) => { D.call = e.target.value; D.fixed = false; if (D.call === 'rate') D.rateUntil = rateUntil(); renderAll(); });
  sel('d-all').addEventListener('change', (e) => { D.allSet = e.target.checked; D.fixed = false; renderAll(); });
  sel('d-proj').addEventListener('change', (e) => { D.proj = e.target.value; renderAll(); });
  sel('d-next').addEventListener('change', (e) => { D.next = e.target.value; });
  sel('d-copy').addEventListener('change', (e) => { D.copyFail = e.target.checked; });
  sel('d-screen').addEventListener('change', (e) => { const v = e.target.value; if (!v) return; hosts.forEach((h) => h.app.go(v)); e.target.value = ''; });
  document.querySelector('[data-reset]').addEventListener('click', () => { Object.assign(D, { thisEnv: 'production', call: 'ok', allSet: false, proj: 'two', next: 'same', copyFail: false, fixed: false, checking: false, projLoading: false, checkedAt: minsAgo(4) }); syncDemo(); mountAll(false); });
  D.rateUntil = rateUntil();
  mountAll(false);
  syncDemo();
  pageChrome.fit();
  void others;
})();
