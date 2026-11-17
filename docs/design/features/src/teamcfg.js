/* #688 Settings › Team (ADR 0009). Design prototype runtime with mock data only; the real page reads and writes
   `…/team-config` (If-Match revision), `…/team-config/import`, `…/team-config/revisions[/:n]` and `…/team/status`.
   Two independent instances (iPhone, Mac) share the demo controls and the stored document. Every user-supplied or
   server-supplied string (reason, author, paths, raw JSON) goes through esc() into text: never HTML (T4). */
(() => {
  'use strict';
  const { isReduced, cssVar, ms, wait, esc, play, plain, I, dots } = Proto;
  const L = Proto.i18n(I18N);
  const { t } = L;
  const PROJECT = 'storify';

  /* ---------- the contract, mirrored from @shared/contracts team-config.ts ---------- */
  const ROLES = ['orchestrator', 'pm', 'architect', 'dev', 'dev-light', 'dev-heavy', 'qa', 'reviewer', 'security', 'devops', 'analyst', 'ux-designer', 'ui-designer', 'scribe'];
  const NEVER_OFF = ['orchestrator', 'pm', 'dev', 'qa', 'reviewer'];
  const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
  const MODEL_ID = { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5-20251001' };
  const EFFORT_OF = { fable: 'high', opus: 'high', sonnet: 'medium', haiku: 'low' };
  const EFFORTS = ['low', 'medium', 'high'];
  const allowedModels = (r) => MODELS.filter((m) => (m !== 'haiku' || r === 'scribe') && (m !== 'fable' || r !== 'security'));
  const PRESETS = ['economy', 'recommended', 'max'];
  const P = (o, d) => Object.fromEntries(ROLES.map((r) => [r, o[r] || d]));
  const PRESET_MODELS = {
    economy: P({ architect: 'opus', 'dev-heavy': 'opus', security: 'opus', scribe: 'haiku' }, 'sonnet'),
    recommended: P({ architect: 'fable', 'dev-heavy': 'fable', dev: 'opus', orchestrator: 'opus', pm: 'opus', qa: 'opus', 'ux-designer': 'opus', 'ui-designer': 'opus', security: 'opus', scribe: 'haiku' }, 'sonnet'),
    max: P({ architect: 'fable', 'dev-heavy': 'fable', dev: 'fable', scribe: 'sonnet' }, 'opus'),
  };
  const SUGGESTED = { economy: 400, recommended: 700, max: null };
  const BOUNDS = { max_minutes: [1, 720], max_turns: [1, 1000], max_parallel: [1, 5], max_rework_rounds: [0, 3], dev_tasks: [0, 10], parallel_devs: [1, 5], length_days: [7, 28], freeze_days: [0, 7], monthly_usd: [1, 100000] };
  const roleLimits = (r) => ({ max_parallel: 5, max_minutes: r === 'dev-heavy' ? 120 : r === 'scribe' ? 15 : 90, max_turns: r === 'scribe' ? 40 : 400 });
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function presetDoc(preset) {
    return {
      preset, access: 'api_key',
      roles: Object.fromEntries(ROLES.map((r) => { const m = PRESET_MODELS[preset][r]; return [r, { enabled: true, model: m, effort: EFFORT_OF[m], ...roleLimits(r) }]; })),
      gates: { qa: 'always', reviewer: 'code', code_paths: ['apps/**', 'libs/**', 'tools/**'], max_rework_rounds: 1 },
      caps: { normal: { dev_tasks: 2, parallel_devs: 2 }, burn: { dev_tasks: 5, parallel_devs: 3 }, freeze: { dev_tasks: 0, parallel_devs: 1 } },
      sprint: { length_days: 14, freeze_days: 2 }, language: 'ru', budget: { monthly_usd: null },
      cost: { prompt_caching: true, batch_api: false, reviewer_context: 'diff' },
    };
  }
  const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function set(o, path, v) { const ks = path.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; }
  function flat(o, pre = '', out = []) {
    Object.entries(o).forEach(([k, v]) => { const p = pre ? `${pre}.${k}` : k; if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, p, out); else out.push(p); });
    return out;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const diff = (a, b) => flat(b).filter((p) => !same(get(a, p), get(b, p))).map((p) => ({ path: p, old: get(a, p), new: get(b, p) }));
  const overridesOf = (d) => ROLES.filter((r) => d.roles[r].model !== PRESET_MODELS[d.preset][r]);

  /* ---------- labels and values in words ---------- */
  const roleName = (r) => t(`r.${r}`);
  function label(path) {
    const k = path.split('.');
    if (k[0] === 'roles') return k[2] === 'enabled' ? roleName(k[1]) : `${roleName(k[1])} · ${t(`f.${k[2]}`)}`;
    if (k[0] === 'caps') return t('f.caps', { mode: t(`caps.${k[1]}`), what: t(`f.${k[2]}`) });
    return t(`f.${path}`);
  }
  const usd = (n) => `$${Number(n).toLocaleString(L.lang === 'ru' ? 'ru-RU' : 'en-GB')}`;
  function val(path, v) {
    const k = path.split('.'); const f = k[k.length - 1];
    if (path === 'preset') return t(`preset ${v}`);
    if (path === 'access') return t(`v.${v}`);
    if (f === 'enabled') return t(v ? 'v.on' : 'v.off');
    if (f === 'model') return t(`m.${v}`);
    if (f === 'effort') return t(`e.${v}`);
    if (path === 'gates.qa' || path === 'gates.reviewer') return t(`g.${v}`);
    if (f === 'code_paths') return v.join(', ');
    if (k[0] === 'sprint') return t('v.days', { n: v });
    if (path === 'language') return t(`lang.${v}`);
    if (path === 'budget.monthly_usd') return v == null ? t('v.noBudget') : usd(v);
    if (f === 'prompt_caching' || f === 'batch_api') return t(v ? 'v.yes' : 'v.no');
    if (f === 'reviewer_context') return t(v === 'diff' ? 'cost.diff' : 'cost.repo');
    return String(v);
  }
  const loc = () => (L.lang === 'ru' ? 'ru-RU' : 'en-GB');
  const fmtDay = (d) => new Intl.DateTimeFormat(loc(), { day: 'numeric', month: 'long' }).format(d);
  const fmtWhen = (d) => new Intl.DateTimeFormat(loc(), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(d);
  const MONTH = new Date(Date.UTC(2026, 10, 1));
  const monthName = () => new Intl.DateTimeFormat(loc(), { month: 'long', timeZone: 'UTC' }).format(MONTH);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const who = (w) => (w === 'you' ? t('you') : w === 'anna' ? (L.lang === 'ru' ? 'Анна К.' : 'Anna K.') : w);
  const whoCap = (w) => cap(who(w));

  /* ---------- the stored document and its history (shared by both frames) ---------- */
  const D = (day, h, m) => new Date(2026, 10, day, h, m);
  function seedHistory() {
    return [
      { n: 12, who: 'anna', at: D(14, 18, 20), reason: L.lang === 'ru' ? 'Подняли лимит шагов QA: длинные e2e не укладывались' : 'Raised QA turns: long e2e runs did not fit', changes: [{ path: 'roles.qa.max_turns', old: 400, new: 500 }] },
      { n: 11, who: 'you', at: D(10, 9, 5), reason: L.lang === 'ru' ? 'Ревьюер на Opus до конца спринта' : 'Reviewer on Opus until the sprint ends', changes: [{ path: 'roles.reviewer.model', old: 'sonnet', new: 'opus' }, { path: 'roles.reviewer.effort', old: 'medium', new: 'high' }] },
      { n: 10, who: 'you', at: D(3, 21, 40), reason: L.lang === 'ru' ? 'В этом спринте нет UI-задач' : 'No UI work this sprint', changes: [{ path: 'roles.ui-designer.enabled', old: true, new: false }] },
      // T4: the reason is free text from a person; it must render as text, never as HTML.
      { n: 9, who: 'anna', at: D(1, 12, 2), reason: '<img src=x onerror="alert(1)"> QA на Sonnet', changes: [{ path: 'roles.qa.model', old: 'opus', new: 'sonnet' }, { path: 'roles.qa.effort', old: 'high', new: 'medium' }, { path: 'budget.monthly_usd', old: null, new: 200 }] },
      { n: 8, who: 'you', at: new Date(2026, 9, 28, 10, 15), reason: '', changes: [{ path: 'gates.reviewer', old: 'always', new: 'code' }] },
      ...[7, 6, 5, 4, 3, 2, 1].map((n) => ({ n, who: n % 2 ? 'you' : 'anna', at: new Date(2026, 9, 20 + (n % 7), 9, 0), reason: n === 1 ? (L.lang === 'ru' ? 'Импорт из project.yml' : 'Imported from project.yml') : '', changes: [{ path: 'caps.burn.dev_tasks', old: 4, new: 5 }] })),
    ];
  }
  function storedRev12() {
    const d = presetDoc('recommended');
    Object.assign(d.roles.qa, { model: 'sonnet', effort: 'medium', max_turns: 500 });
    Object.assign(d.roles.reviewer, { model: 'opus', effort: 'high' });
    d.roles['ui-designer'].enabled = false;
    d.budget.monthly_usd = 200;
    return d;
  }
  // The next revision, saved by Anna while you edit: the conflict's "their changes".
  function theirs13(base) {
    const d = clone(base);
    Object.assign(d.roles.dev, { model: 'sonnet', effort: 'medium' });
    d.budget.monthly_usd = 180;
    return d;
  }
  const SPEND = { normal: 64, stopped: 200, waived: 212 };
  const G = {};
  function resetG() {
    Object.assign(G, { data: 'loaded', member: false, offline: false, hosted: false, budget: 'normal', history: 'ok', save: 'ok', impFail: false, rev: 12, stored: storedRev12(), entries: seedHistory(), waivedAt: D(16, 8, 30) });
  }
  resetG();
  const docAt = (n) => { const d = clone(G.stored); G.entries.filter((e) => e.n > n).forEach((e) => e.changes.forEach((c) => set(d, c.path, clone(c.old)))); return d; };

  const hosts = [...document.querySelectorAll('[data-app]')];
  const renderAll = () => hosts.forEach((h) => h.app && h.app.render());

  /* ---------- one app instance ---------- */
  function mountApp(host, kind, keep) {
    const phone = kind === 'phone';
    const fresh = () => ({ route: 'team', draft: clone(G.stored), open: { preset: true, access: !phone, roles: true, limits: !phone, rules: !phone }, dlg: null, banner: null, errs: {}, revN: null, raw: false, more: false, overlap: null, opener: null, r403: false, theirs: null, saveErr: false, busy: false, slowTimer: null, hl: null });
    const S = keep || fresh();
    host.S = S;
    const uid = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const $ = (s) => host.querySelector(s);
    const editable = () => !G.member && !S.r403;
    const changes = () => diff(G.stored, S.draft);
    const dis = (on) => (on ? ' aria-disabled="true"' : '');

    host.innerHTML = kind === 'mac' ? `<div class="win" data-bg>
        <div class="win__bar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="win__title">Team Console</span></div>
        <div class="win__body">
          <nav class="sidebar" aria-label="${t('nav.aria')}">
            <div class="brand">${I.mark}<span>Team Console</span></div>
            <label class="search search--side">${I.search}<span class="sr-only">${t('filter.ph')}</span><input type="search" placeholder="${t('filter.ph')}" autocomplete="off"><kbd>/</kbd></label>
            <ul class="side-list side-list--top">
              <li><button type="button" class="side-item">${I.inbox}<span>${t('nav.needs')}</span></button></li>
              <li><button type="button" class="side-item">${I.grid}<span>${t('nav.all')}</span></button></li>
            </ul>
            <div class="side-label">${t('nav.projects')}</div>
            <ul class="side-list">${['storify', 'team-console', 'fieldnote'].map((p) => `<li><button type="button" class="side-item"><span class="prod-mono" aria-hidden="true">${p[0]}</span><span class="side-prod__label">${p}</span></button></li>`).join('')}</ul>
            <div class="side-foot">
              <button type="button" class="side-item side-item--settings" aria-current="page">${I.gear}<span>${t('nav.settings')}</span></button>
              <div class="side-foot__row"><span class="avatar avatar--owner" aria-hidden="true">K</span><span>${t('shell.owner')}</span></div>
            </div>
          </nav>
          <section class="set-main" aria-label="${t('nav.settings')}">
            <header class="convo__head"><nav class="crumbs" aria-label="${t('nav.crumbs')}" data-slot="crumbs"></nav></header>
            <div class="set-scroll" data-slot="scroll"><div class="set-inner" data-slot="screen"></div></div>
          </section>
        </div>
      </div>
      <div data-slot="modal"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`
      : `<div class="p-status" aria-hidden="true"><span>9:41</span><span class="p-island"></span><span class="p-status__icons">${I.bars}${I.battery}</span></div>
      <div data-slot="phead" data-bg></div>
      <div class="p-scroll" data-bg data-slot="scroll"><div class="set-inner" data-slot="screen"></div></div>
      <div class="home-ind" aria-hidden="true"></div>
      <div data-slot="modal"></div><div class="toast" role="status" data-slot="toast" hidden></div><div class="sr-only" aria-live="polite" data-slot="live"></div>`;

    /* ----- small parts ----- */
    const fieldErr = (path) => (S.errs[path] ? `<p class="field__err" id="${uid}-err-${path}" role="alert">${I.bang}<span>${esc(S.errs[path])}</span></p>` : '');
    const errAttrs = (path, hintId) => { const ids = [hintId, S.errs[path] ? `${uid}-err-${path}` : ''].filter(Boolean).join(' '); return `${ids ? ` aria-describedby="${ids}"` : ''}${S.errs[path] ? ' aria-invalid="true"' : ''}`; };
    function radios(path, opts, legend, { disabled = false, reason = '' } = {}) {
      const v = get(S.draft, path); const rid = reason ? `${uid}-why-${path}` : '';
      if (!editable()) return `<div class="tm-group"><span class="tm-label">${legend}</span><span class="tm-plain">${esc(val(path, v))}</span></div>`;
      return `<fieldset class="tm-group"${rid ? ` aria-describedby="${rid}"` : ''}><legend>${legend}</legend><div class="tm-radios">${opts.map(([o, lab]) => `<label class="tm-radio"${dis(disabled)}><input type="radio" name="${uid}-${path}" value="${o}" data-path="${path}" data-fk="r-${path}-${o}"${v === o ? ' checked' : ''}${disabled ? ' aria-disabled="true"' : ''}>${lab}</label>`).join('')}</div>${reason ? `<p class="field__hint" id="${rid}">${reason}</p>` : ''}</fieldset>`;
    }
    function num(path, lab, { hint = '', cls = '' } = {}) {
      const v = get(S.draft, path); const f = path.split('.').pop(); const [mn, mx] = BOUNDS[f];
      const hid = `${uid}-h-${path}`;
      if (!editable()) return `<div class="field"><span class="field__label">${lab}</span><span class="tm-plain">${esc(val(path, v))}</span></div>`;
      return `<div class="field ${cls}"><label class="field__label" for="${uid}-${path}">${lab}</label><input class="field__input tm-num" id="${uid}-${path}" type="number" inputmode="numeric" min="${mn}" max="${mx}" step="1" value="${esc(v)}" data-path="${path}" data-fk="n-${path}"${errAttrs(path, hid)}><p class="field__hint" id="${hid}">${hint || t('range', { min: mn, max: mx })}</p>${fieldErr(path)}</div>`;
    }
    const plainVal = (lab, v) => `<div class="field"><span class="field__label">${lab}</span><span class="tm-plain">${esc(v)}</span></div>`;

    function section(id, title, summary, body, { flush = false, aside = '' } = {}) {
      const bid = `${uid}-sec-${id}`;
      const inner = `<div class="tm-sec__body${flush ? ' tm-sec__body--flush' : ''}" id="${bid}">${body}</div>`;
      if (!phone) return `<section class="tm-sec" aria-labelledby="${bid}-h" data-sec="${id}"><header class="tm-sec__head"><h2 id="${bid}-h">${title}</h2>${aside}</header>${inner}</section>`;
      const open = S.open[id];
      return `<section class="tm-sec" aria-labelledby="${bid}-h" data-sec="${id}"><h2 class="tm-sec__h" id="${bid}-h"><button type="button" class="tm-sec__toggle" aria-expanded="${open}" aria-controls="${bid}" data-act="sec" data-id="${id}" data-fk="sec-${id}"><b>${title}</b><small>${esc(summary)}</small>${I.down}</button></h2>${open ? inner : `<div id="${bid}" hidden></div>`}</section>`;
    }

    /* ----- sections ----- */
    const presetLine = (d) => t('preset line', { preset: t(`preset ${d.preset}`), n: overridesOf(d).length });
    function presetSec() {
      const d = S.draft; const ov = overridesOf(d).length;
      const seg = editable()
        ? `<div class="tm-seg" role="radiogroup" aria-label="${t('sec.preset')}" data-fk="preset-group">${PRESETS.map((p) => `<button type="button" role="radio" aria-checked="${d.preset === p}" tabindex="${d.preset === p ? 0 : -1}" data-act="preset" data-preset="${p}" data-fk="preset-${p}">${t(`preset ${p}`)}</button>`).join('')}</div>`
        : `<span class="tm-plain">${t(`preset ${d.preset}`)}</span>`;
      const reset = editable() && ov ? `<button type="button" class="link-btn" data-act="reset-all" data-fk="reset-all">${t('reset preset', { preset: t(`preset ${d.preset}`) })}</button>` : '';
      return section('preset', t('sec.preset'), presetLine(d), `<div class="tm-preset">${seg}<p class="tm-preset__hint">${t(`preset.hint.${d.preset}`)}</p><p class="tm-preset__line" style="margin:0"><span>${presetLine(d)}</span>${reset}</p></div>`);
    }
    function accessSec() {
      const v = S.draft.access; const sub = v === 'subscription';
      const risk = `<div class="tm-call" id="${uid}-risk">${I.warn}<p>${t('risk warning')}</p></div>`;
      if (!editable()) return section('access', t('sec.access'), t(`v.${v}`), `<p class="tm-plain" style="margin:0">${t(v)}</p>${sub ? risk : ''}`);
      const blocked = G.hosted;
      const body = `<fieldset class="tm-acc"${errAttrs('access')}><legend class="sr-only">${t('sec.access')}</legend>
        <div class="tm-card${!sub ? ' is-on' : ''}"><label class="tm-opt"><input type="radio" name="${uid}-access" value="api_key" data-act="access" data-fk="acc-api"${!sub ? ' checked' : ''}><span><b>${t('api_key')}</b></span><small>${t('access.api.hint')}</small></label></div>
        <div class="tm-card${sub ? ' is-on' : ''}"><label class="tm-opt"${dis(blocked && !sub)}><input type="radio" name="${uid}-access" value="subscription" data-act="access" data-fk="acc-sub"${sub ? ' checked' : ''}${blocked && !sub ? ` aria-disabled="true" aria-describedby="${uid}-subwhy ${uid}-risk"` : ` aria-describedby="${uid}-risk"`}><span><b>${t('subscription')}</b></span>${blocked && !sub ? `<small id="${uid}-subwhy">${t('subscription disabled')}</small>` : ''}</label>
          ${blocked && !sub ? `<a class="ext" href="#runners" data-act="runners" data-fk="runners">${t('access.runners')}${I.chev}</a>` : ''}${risk}</div>
      </fieldset>${fieldErr('access')}`;
      return section('access', t('sec.access'), t(`v.${v}`), body);
    }
    function roleRow(r) {
      const x = S.draft.roles[r]; const locked = NEVER_OFF.includes(r); const sec = r === 'security';
      const ov = x.model !== PRESET_MODELS[S.draft.preset][r];
      const on = sec || x.enabled;
      const whyId = `${uid}-why-${r}`;
      const why = locked ? `<p class="tm-role__why" id="${whyId}">${I.lock}<span>${t('role locked')}</span></p>`
        : sec ? `<p class="tm-role__why" id="${whyId}">${I.lock}<span>${t('security')}</span></p>`
        : !x.enabled ? `<p class="tm-role__why" id="${whyId}">${I.minus}<span>${t('role off')}</span></p>` : '';
      const chip = ov ? `<span class="tm-chip">${t('override chip')}</span>` : '';
      const name = `<span class="tm-role__name"><b>${roleName(r)}</b>${chip}</span>`;
      const modelTxt = `${t(`m.${x.model}`)} · ${t(`e.${x.effort}`)}`;
      const limTxt = t('role.limitsBtn', { min: x.max_minutes, turns: x.max_turns, par: x.max_parallel });
      if (!editable()) {
        const state = sec ? '' : locked ? t('role.alwaysWord') : x.enabled ? t('role.on') : t('role.offWord');
        return `<li class="tm-role${on ? '' : ' is-off'}">${name}<span class="tm-role__val">${phone ? '' : esc(state)}</span><span class="tm-role__ctl"><span class="tm-role__val">${esc(modelTxt)}</span><span class="tm-role__val">${esc(limTxt)}</span></span><span></span>${why}</li>`;
      }
      const sw = sec ? '<span class="tm-switch-wrap" aria-hidden="true"></span>'
        : locked ? `<span class="tm-switch-wrap"><button type="button" class="tm-switch" role="switch" aria-checked="true" aria-disabled="true" aria-label="${t('role.switchAria', { role: roleName(r) })}" aria-describedby="${whyId}" data-act="locked" data-fk="sw-${r}">${I.lock}</button></span>`
        : `<span class="tm-switch-wrap"><button type="button" class="tm-switch" role="switch" aria-checked="${x.enabled}" aria-label="${roleName(r)}"${x.enabled ? '' : ` aria-describedby="${whyId}"`} data-act="toggle" data-role="${r}" data-fk="sw-${r}"></button></span>`;
      const pick = `<button type="button" class="tm-pick" aria-haspopup="dialog" aria-label="${esc(plain(t('role.modelAria', { role: roleName(r), model: modelTxt })))}" data-act="picker" data-role="${r}" data-fk="pick-${r}"><span><b>${t(`m.${x.model}`)}</b> <small>· ${t(`e.${x.effort}`)}</small></span>${I.down}</button>`;
      const lim = `<button type="button" class="tm-lim" aria-haspopup="dialog" aria-label="${esc(plain(t('role.limitsAria', { role: roleName(r) })))}: ${esc(limTxt)}" data-act="limits" data-role="${r}" data-fk="lim-${r}"><small>${phone ? t('sec.limits') : esc(limTxt)}</small>${I.chev}</button>`;
      const reset = ov ? `<button type="button" class="link-btn tm-role__reset" aria-label="${esc(plain(t('reset rowAria', { role: roleName(r) })))}" data-act="reset-row" data-role="${r}" data-fk="reset-${r}">${t('reset row')}</button>` : '<span></span>';
      const hl = S.hl === r ? ' is-hl' : '';
      return `<li class="tm-role${on ? '' : ' is-off'}${hl}" data-role-row="${r}">${name}${sw}<span class="tm-role__ctl">${pick}${lim}</span>${reset}${why}</li>`;
    }
    function rolesSec() {
      const on = ROLES.filter((r) => r === 'security' || S.draft.roles[r].enabled).length;
      const head = phone ? '' : `<div class="tm-rhead" aria-hidden="true"><span>${t('role.head.role')}</span><span>${editable() ? t('role.head.on') : ''}</span><span>${t('role.head.model')}</span><span>${t('role.head.limits')}</span><span></span></div>`;
      return section('roles', t('sec.roles'), t('roles.sum', { on, total: ROLES.length }), `${head}<ul class="tm-roles">${ROLES.map(roleRow).join('')}</ul>`, { flush: true });
    }
    function limitsSec() {
      const b = S.draft.budget.monthly_usd; const stored = G.stored.budget.monthly_usd; const spent = SPEND[G.budget];
      const mon = monthName(); const hid = `${uid}-bhelp`;
      const field = editable()
        ? `<div class="field"><label class="field__label" for="${uid}-budget">${t('budget label')}</label><span class="tm-money"><input class="field__input" id="${uid}-budget" type="number" inputmode="numeric" min="1" max="100000" step="1" placeholder="—" value="${b == null ? '' : b}" data-path="budget.monthly_usd" data-fk="budget"${errAttrs('budget.monthly_usd', hid)}></span><p class="field__hint" id="${hid}">${t('budget help')}</p>${fieldErr('budget.monthly_usd')}</div>`
        : plainVal(t('budget label'), val('budget.monthly_usd', b));
      const capNow = stored; const pct = capNow ? Math.min(100, Math.round((spent / capNow) * 100)) : 0;
      const meterCls = G.budget === 'waived' ? ' tm-meter--waived' : G.budget === 'stopped' ? ' tm-meter--full' : '';
      const spend = `<div class="tm-spend"><p>${capNow ? t('budget.spent', { month: mon, spent: usd(spent), budget: usd(capNow) }) : t('budget.spentNoCap', { month: mon, spent: usd(spent) })}</p>${capNow ? `<div class="tm-meter${meterCls}" aria-hidden="true"><i style="width:${pct}%"></i></div>` : ''}${SUGGESTED[S.draft.preset] && editable() ? `<p class="tm-small">${t('budget.suggest', { preset: t(`preset ${S.draft.preset}`), usd: usd(SUGGESTED[S.draft.preset]) })}</p>` : ''}</div>`;
      let waived = '';
      if (G.budget === 'waived') {
        const editing = editable() && b !== stored;
        const next = new Date(2026, 11, 1);
        waived = `<div class="tm-waived${editing ? ' tm-waived--editing' : ''}" id="${uid}-waived" data-fk="waived"><b>${t('budget.waived.title', { month: cap(mon) })}</b><p>${t('budget.waived', { date: fmtDay(G.waivedAt), spent: usd(spent), budget: usd(stored), next: fmtDay(next) })}</p><p>${editing && b != null ? t('budget.waived.editing', { month: mon, budget: usd(b) }) : t('budget.waived.ends')}</p></div>`;
      }
      const sum = capNow ? t('limits.sum', { budget: usd(capNow), spent: usd(spent) }) : t('v.noBudget');
      return section('limits', t('sec.limits'), sum, `<div class="tm-budget">${field}${spend}</div>${waived}<p class="tm-small">${t('budget.overshoot')}</p>`);
    }
    function rulesSec() {
      const d = S.draft; const sub = d.access === 'subscription';
      const pathsHint = `${uid}-h-paths`;
      const paths = editable()
        ? `<div class="tm-group tm-wide"><span class="tm-label" id="${uid}-paths-l">${t('g.paths')}</span><div class="tm-paths" role="list" aria-labelledby="${uid}-paths-l">${d.gates.code_paths.map((p, i) => `<span class="tm-path${p.startsWith('/') && S.errs['gates.code_paths'] ? ' tm-path--bad' : ''}" role="listitem">${esc(p)}<button type="button" aria-label="${esc(plain(t('g.pathRemove', { path: p })))}" data-act="path-rm" data-i="${i}" data-fk="path-rm-${i}">${I.x}</button></span>`).join('')}</div>
            <div class="tm-path-add"><input class="field__input" type="text" id="${uid}-path-new" placeholder="${t('g.pathPh')}" aria-label="${t('g.pathAdd')}" autocomplete="off" spellcheck="false" data-fk="path-new"${errAttrs('gates.code_paths', pathsHint)}><button type="button" class="btn btn--tall" data-act="path-add" data-fk="path-add">${I.plus}<span>${t('g.pathAdd')}</span></button></div>
            <p class="field__hint" id="${pathsHint}">${t('g.codeHint')}</p>${fieldErr('gates.code_paths')}</div>`
        : plainVal(t('g.paths'), d.gates.code_paths.join(', '));
      const caps = editable()
        ? `<fieldset class="tm-group tm-wide"><legend>${t('caps.title')}</legend><p class="field__hint" style="margin:0">${t('caps.hint')}</p><div class="tm-caps">${['normal', 'burn', 'freeze'].map((m) => `<span>${t(`caps.${m}`)}</span><input class="field__input" type="number" inputmode="numeric" min="0" max="10" value="${d.caps[m].dev_tasks}" aria-label="${esc(plain(label(`caps.${m}.dev_tasks`)))}" data-path="caps.${m}.dev_tasks" data-fk="caps-${m}-t"><input class="field__input" type="number" inputmode="numeric" min="1" max="5" value="${d.caps[m].parallel_devs}" aria-label="${esc(plain(label(`caps.${m}.parallel_devs`)))}" data-path="caps.${m}.parallel_devs" data-fk="caps-${m}-p">`).join('')}</div></fieldset>`
        : plainVal(t('caps.title'), ['normal', 'burn', 'freeze'].map((m) => `${t(`caps.${m}`)} ${d.caps[m].dev_tasks} · ${d.caps[m].parallel_devs}`).join(' / '));
      const subWhy = sub ? t('cost.subOnly') : '';
      const costId = `${uid}-costwhy`;
      const cost = editable()
        ? `<fieldset class="tm-group tm-wide"${sub ? ` aria-describedby="${costId}"` : ''}><legend>${t('cost.title')}</legend>
            ${sub ? `<p class="tm-small" id="${costId}">${subWhy}</p>` : ''}
            <div class="tm-sub"><label class="tm-check"${dis(sub)}><input type="checkbox" data-path="cost.prompt_caching" data-fk="c-cache"${d.cost.prompt_caching ? ' checked' : ''}${sub ? ' aria-disabled="true"' : ''}>${t('cost.cache')}</label><p class="field__hint">${t('cost.cacheHint')}</p></div>
            <div class="tm-sub"><label class="tm-check"${dis(sub)}><input type="checkbox" data-path="cost.batch_api" data-fk="c-batch"${d.cost.batch_api ? ' checked' : ''}${sub ? ' aria-disabled="true"' : ''}>${t('batch')}</label></div>
            ${radios('cost.reviewer_context', [['diff', t('cost.diff')], ['repo', t('cost.repo')]], t('cost.reviewer'), { disabled: sub, reason: t('cost.reviewerHint') })}
          </fieldset>`
        : plainVal(t('cost.title'), `${t('cost.cache')}: ${val('cost.prompt_caching', d.cost.prompt_caching)} · ${t('f.cost.batch_api')}: ${val('cost.batch_api', d.cost.batch_api)} · ${t('cost.reviewer')}: ${val('cost.reviewer_context', d.cost.reviewer_context)}`);
      const body = `<div class="tm-rules">
        ${radios('gates.qa', [['always', t('g.always')], ['code', t('g.code')]], t('g.qa'))}
        ${radios('gates.reviewer', [['always', t('g.always')], ['code', t('g.code')]], t('g.reviewer'))}
        ${paths}
        ${num('gates.max_rework_rounds', t('g.rework'), { hint: t('g.reworkHint') })}
        ${radios('language', [['ru', t('lang.ru')], ['en', t('lang.en')]], t('lang.title'))}
        ${caps}
        ${num('sprint.length_days', t('sprint.len'))}
        ${num('sprint.freeze_days', t('sprint.freeze'))}
        ${cost}
      </div>`;
      const sum = `${t('g.qa')}: ${val('gates.qa', d.gates.qa)} · ${t('g.reviewer')}: ${val('gates.reviewer', d.gates.reviewer)}`;
      return section('rules', t('sec.rules'), sum, body);
    }

    /* ----- banners and callouts ----- */
    function banners() {
      const out = [];
      if (S.r403) out.push(`<div class="tm-ban tm-ban--bad" role="alert">${I.lock}<h2 tabindex="-1" data-fk="ban">${t('not owner now')}</h2></div>`);
      else if (G.member) out.push(`<div class="tm-ban">${I.lock}<p style="color:var(--text)">${t('read-only')}</p></div>`);
      if (G.offline) out.push(`<div class="tm-ban">${I.wifi}<p style="color:var(--text)">${t('offline')}</p></div>`);
      if (S.banner === 'conflict') {
        out.push(`<div class="tm-ban tm-ban--warn" role="alert">${I.warn}<div><h2 tabindex="-1" data-fk="ban">${t('conflict', { who: whoCap('anna'), n: G.rev + 1 })}</h2><p>${t('conflict.sub')}</p></div>
          <div class="tm-ban__acts"><button type="button" class="btn" data-act="c-show" data-fk="c-show">${t('conflict actions.show')}</button><button type="button" class="btn btn--primary" data-act="c-keep" data-fk="c-keep">${t('conflict actions.keep')}</button><button type="button" class="btn btn--quiet" data-act="c-discard" data-fk="c-discard">${t('conflict actions.discard')}</button></div></div>`);
      }
      if (S.banner === 'merged' && S.overlap) {
        const items = S.overlap.map((o) => `<li><b>${esc(label(o.path))}</b><div class="tm-radios" role="radiogroup" aria-label="${esc(plain(label(o.path)))}">
          <label class="tm-radio"><input type="radio" name="${uid}-m-${o.path}" data-act="m-pick" data-path="${o.path}" data-side="mine" data-fk="m-${o.path}-mine"${same(get(S.draft, o.path), o.mine) ? ' checked' : ''}>${esc(t('merged.mine', { v: val(o.path, o.mine) }))}</label>
          <label class="tm-radio"><input type="radio" name="${uid}-m-${o.path}" data-act="m-pick" data-path="${o.path}" data-side="theirs" data-fk="m-${o.path}-theirs"${same(get(S.draft, o.path), o.theirs) ? ' checked' : ''}>${esc(t('merged.theirs', { who: whoCap('anna'), v: val(o.path, o.theirs) }))}</label></div></li>`).join('');
        out.push(`<div class="tm-ban tm-ban--warn" role="region" aria-labelledby="${uid}-mt">${I.warn}<div><h2 id="${uid}-mt" tabindex="-1" data-fk="ban">${t('merged.title', { n: G.rev })}</h2><p>${t('merged.sub', { who: whoCap('anna'), n: S.overlap.length })}</p></div><ul class="tm-merge">${items}</ul>
          <div class="tm-ban__acts"><button type="button" class="btn" data-act="m-done" data-fk="m-done">${t('done')}</button></div></div>`);
      }
      if (G.budget === 'stopped' && !G.member) {
        out.push(`<div class="tm-call tm-call--bad tm-call--stop" role="region" aria-labelledby="${uid}-stop">${I.pause}<div><b id="${uid}-stop">${t('budget needs-you.title')}</b><p>${t('budget needs-you', { spent: usd(SPEND.stopped), budget: usd(G.stored.budget.monthly_usd), month: monthName() })}</p></div>
          <div class="tm-call__acts"><button type="button" class="btn btn--primary" data-act="resume" data-fk="resume"${dis(G.offline)}>${t('budget actions.resume')}</button><button type="button" class="btn" data-act="raise" data-fk="raise">${t('budget actions.raise')}</button></div></div>`);
      }
      return out.join('');
    }
    function saveBar() {
      const n = changes().length;
      if (!editable() || !n) return '';
      const off = G.offline; const offId = `${uid}-baroff`;
      return `<div class="tm-bar" role="region" aria-label="${t('bar.aria')}"><span class="tm-bar__count">${t('bar.count', { n })}${off ? `<small id="${offId}">${t('bar.offline')}</small>` : ''}</span>
        <button type="button" class="btn" data-act="discard" data-fk="discard">${t('save / discard.discard')}</button>
        <button type="button" class="btn btn--primary" data-act="review" data-fk="review"${off ? ` aria-disabled="true" aria-describedby="${offId}"` : ''}>${t('save / discard.save')}</button></div>`;
    }

    /* ----- screens ----- */
    function headHTML() {
      const empty = G.data === 'empty';
      const last = G.entries[0];
      const meta = empty || !last ? t('not customised') : `${t('revision', { n: G.rev, who: who(last.who), date: fmtDay(last.at) })}${last.reason ? ` · <q>${esc(last.reason)}</q>` : ''}`;
      const acts = `<div class="tm-acts">${editable() ? `<button type="button" class="btn" data-act="import" data-fk="import"${dis(G.offline)}>${I.copy}<span>${t('actions.import')}</span></button>` : ''}<button type="button" class="btn" data-act="history" data-fk="history">${I.clock}<span>${t('actions.history')}</span></button></div>`;
      return `<header class="tm-head"><div><h1 tabindex="-1" data-fk="h1">${t('title')}</h1><p class="tm-meta">${meta}</p></div>${acts}</header>`;
    }
    function skeleton() {
      const row = '<div class="skel-row"><span class="skel-stack"><span class="skel skel--a"></span><span class="skel skel--b"></span></span></div>';
      return `<header class="tm-head"><div><h1 tabindex="-1" data-fk="h1">${t('title')}</h1><p class="tm-meta"><span class="skel" style="width:220px;display:inline-block"></span></p></div></header>
        <div class="tm-skel" aria-busy="true" aria-label="${t('load.aria')}">${G.data === 'slow' ? `<p class="tm-slow" role="status">${dots}<span>${t('load.slow')}</span></p>` : ''}${[2, 1, 4, 2].map((n) => `<div class="tm-sec">${row.repeat(n)}</div>`).join('')}</div>`;
    }
    function teamScreen() {
      if (G.data === 'loading' || G.data === 'slow') return skeleton();
      if (G.data === 'error') return `<header class="tm-head"><div><h1 tabindex="-1" data-fk="h1">${t('title')}</h1></div></header><div class="block block--error" role="alert"><h2>${t('load.fail.title')}</h2><p>${t('load.fail')}</p><button type="button" class="btn btn--tall" data-act="reload" data-fk="reload">${I.refresh}<span>${t('retry')}</span></button></div>`;
      return `${headHTML()}${banners()}${presetSec()}${accessSec()}${rolesSec()}${limitsSec()}${rulesSec()}${saveBar()}`;
    }
    function diffTable(rows, { notes = {} } = {}) {
      const cell = (p, v) => (v == null || (Array.isArray(v) && !v.length) ? `<span class="tm-diff__tag">${t('diff.none')}</span>` : esc(val(p, v)));
      return `<table class="tm-diff"><thead><tr><th scope="col">${t('review.field')}</th><th scope="col">${t('review.old')}</th><th scope="col">${t('review.new')}</th></tr></thead><tbody>${rows.map((c) => {
        const sr = esc(plain(t('diff.changed', { old: val(c.path, c.old), new: val(c.path, c.new) })));
        const added = c.old == null && c.new != null; const removed = c.new == null && c.old != null;
        return `<tr><th scope="row">${esc(label(c.path))}${notes[c.path] ? `<span class="tm-diff__note">${esc(notes[c.path])}</span>` : ''}<span class="sr-only">: ${added ? t('diff.added') : removed ? t('diff.removed') : sr}</span></th><td class="is-old">${cell(c.path, c.old)}</td><td class="is-new">${added ? `<span class="tm-diff__tag">${t('diff.added')}</span>` : ''}${cell(c.path, c.new)}</td></tr>`;
      }).join('')}</tbody></table>`;
    }
    function historyScreen() {
      const lead = `<header class="tm-head"><div><h1 tabindex="-1" data-fk="h1">${t('history / empty.title')}</h1><p class="tm-lead">${t('history.lead')}</p></div></header>`;
      if (G.history === 'error') return `${lead}<div class="block block--error" role="alert"><h2>${t('history.fail.title')}</h2><p>${t('history.fail')}</p><button type="button" class="btn btn--tall" data-act="hist-retry" data-fk="hist-retry">${I.refresh}<span>${t('retry')}</span></button></div>`;
      if (!G.entries.length) return `${lead}<div class="block"><h2>${t('history / empty')}</h2><p>${t('not customised')}</p></div>`;
      const shown = S.more ? G.entries : G.entries.slice(0, 5);
      const rows = shown.map((e) => `<li><button type="button" class="tm-rev" data-act="rev" data-n="${e.n}" data-fk="rev-${e.n}"><span class="tm-rev__n" aria-hidden="true">${e.n}</span>
        <span class="tm-rev__top"><span class="sr-only">${esc(t('rev.title', { n: e.n }))}: </span><b>${esc(whoCap(e.who))}</b><span>${esc(fmtWhen(e.at))} · ${t('history.paths', { n: e.changes.length })}</span></span>
        <span class="tm-rev__why${e.reason ? '' : ' is-none'}">${e.reason ? esc(e.reason) : t('history.noReason')}</span>${I.chev}</button></li>`).join('');
      const more = !S.more && G.entries.length > 5 ? `<button type="button" class="btn btn--tall tm-hist__more" data-act="more" data-fk="more">${t('history.more', { n: G.entries.length - 5 })}</button>` : '';
      return `${lead}<ol class="tm-hist" reversed>${rows}</ol>${more}`;
    }
    function revScreen() {
      const e = G.entries.find((x) => x.n === S.revN); if (!e) return historyScreen();
      const raw = JSON.stringify(Object.fromEntries(e.changes.map((c) => [c.path, { from: c.path.endsWith('.model') ? MODEL_ID[c.old] : c.old, to: c.path.endsWith('.model') ? MODEL_ID[c.new] : c.new }])), null, 2);
      return `<header class="tm-head"><div><h1 tabindex="-1" data-fk="h1">${t('rev.title', { n: e.n })}</h1><p class="tm-meta">${esc(t('rev.by', { who: whoCap(e.who), date: fmtWhen(e.at) }))}</p></div>
        ${editable() ? `<div class="tm-acts"><button type="button" class="btn" data-act="use-rev" data-fk="use-rev">${t('diff.use')}</button></div>` : ''}</header>
        <p class="tm-reason${e.reason ? '' : ' tm-reason--none'}">${e.reason ? esc(e.reason) : t('history.noReason')}</p>
        <section class="tm-sec"><div class="tm-sec__body">${diffTable(e.changes)}
          <div><button type="button" class="link-btn" aria-expanded="${S.raw}" aria-controls="${uid}-raw" data-act="raw" data-fk="raw">${S.raw ? t('diff.rawHide') : t('diff.raw')}</button>${S.raw ? `<pre class="tm-raw" id="${uid}-raw" tabindex="0">${esc(raw)}</pre>` : ''}</div></div></section>`;
    }
    function settingsStub() {
      return `<header class="tm-head"><div><h1 tabindex="-1" data-fk="h1">${t('nav.settings')}</h1></div></header><ul class="plist"><li class="prow"><button type="button" class="prow__link" style="border:0;background:none;text-align:left" data-act="back-team" data-fk="back-team"><span class="prod-mono" aria-hidden="true">s</span><span class="prow__txt"><span class="prow__name">${PROJECT}</span><span class="prow__repo">geeera/${PROJECT}</span></span><span>${t('title')}</span>${I.chev}</button></li></ul>`;
    }

    /* ----- dialogs: centred on the Mac, a bottom sheet on the iPhone (kit alert dialog) ----- */
    function dlgShell(title, sub, body, actions, { wide = true, role = 'dialog' } = {}) {
      return `<div class="modal"><div class="modal__scrim" data-act="dlg-close"></div><div class="adialog${wide ? ' adialog--wide' : ''}" role="${role}" aria-modal="true" aria-labelledby="${uid}-dt"${sub ? ` aria-describedby="${uid}-ds"` : ''}>
        ${wide ? `<header><div class="tm-grab" aria-hidden="true"></div><h2 id="${uid}-dt" tabindex="-1">${title}</h2>${sub ? `<p id="${uid}-ds">${sub}</p>` : ''}</header><div class="adialog__body">${body}</div>` : `<div class="tm-grab" aria-hidden="true"></div><h2 id="${uid}-dt" tabindex="-1">${title}</h2>${sub ? `<p id="${uid}-ds">${sub}</p>` : ''}${body}`}
        <div class="adialog__actions">${actions}</div></div></div>`;
    }
    const btn = (act, txt, cls = '', extra = '') => `<button type="button" class="btn ${cls}" data-act="${act}" data-fk="d-${act}"${extra}>${txt}</button>`;
    function dialogHTML() {
      const d = S.dlg; if (!d) return '';
      if (d.kind === 'picker') {
        const r = d.role; const allowed = allowedModels(r); const excluded = MODELS.filter((m) => !allowed.includes(m));
        const opts = allowed.map((m) => `<label class="tm-opt"><input type="radio" name="${uid}-pm" value="${m}" data-act="pm-model" data-fk="pm-${m}"${d.model === m ? ' checked' : ''}><span><b>${t(`m.${m}`)}</b></span>${PRESET_MODELS[S.draft.preset][r] === m ? `<span class="tm-opt__tag">${t('picker.inPreset', { preset: t(`preset ${S.draft.preset}`) })}</span>` : '<span></span>'}<small>${t(`m.hint.${m}`)}</small><code>${MODEL_ID[m]}</code></label>`).join('');
        const eff = `<div class="tm-group"><span class="tm-label" id="${uid}-eff">${t('picker.effort')}</span><div class="tm-seg tm-seg--row" role="radiogroup" aria-labelledby="${uid}-eff" aria-describedby="${uid}-effh">${EFFORTS.map((e) => `<button type="button" role="radio" aria-checked="${d.effort === e}" tabindex="${d.effort === e ? 0 : -1}" data-act="pm-effort" data-effort="${e}" data-fk="pe-${e}">${t(`e.${e}`)}</button>`).join('')}</div><p class="field__hint" id="${uid}-effh">${t('picker.effortHint')}</p></div>`;
        const foot = excluded.length ? `<p class="tm-foot">${I.lock}<span>${t('picker.notAllowedList', { models: excluded.map((m) => t(`m.${m}`)).join(', ') })}</span></p>` : '';
        return dlgShell(t('picker.title', { role: roleName(r) }), '', `<fieldset class="tm-opts"><legend class="sr-only">${t('picker.title', { role: roleName(r) })}</legend>${opts}</fieldset>${eff}${foot}`, btn('dlg-close', t('cancel')) + btn('pm-done', t('done'), 'btn--primary'));
      }
      if (d.kind === 'limits') {
        const r = d.role;
        const f = (k, lab) => { const [mn, mx] = BOUNDS[k]; const e = d.errs[k]; return `<div class="field"><label class="field__label" for="${uid}-l-${k}">${lab}</label><input class="field__input tm-num" id="${uid}-l-${k}" type="number" inputmode="numeric" min="${mn}" max="${mx}" value="${esc(d.v[k])}" data-lim="${k}" data-fk="l-${k}" aria-describedby="${uid}-lh-${k}${e ? ` ${uid}-le-${k}` : ''}"${e ? ' aria-invalid="true"' : ''}><p class="field__hint" id="${uid}-lh-${k}">${t('range', { min: mn, max: mx })}</p>${e ? `<p class="field__err" id="${uid}-le-${k}">${I.bang}<span>${e}</span></p>` : ''}</div>`; };
        return dlgShell(t('limits.title', { role: roleName(r) }), t('applies next'), `${f('max_minutes', t('lim.min'))}${f('max_turns', t('lim.turns'))}${f('max_parallel', t('lim.par'))}`, btn('dlg-close', t('cancel')) + btn('lim-done', t('done'), 'btn--primary'));
      }
      if (d.kind === 'preset') {
        const n = ROLES.filter((r) => PRESET_MODELS[d.preset][r] !== S.draft.roles[r].model).length;
        const ov = overridesOf(S.draft).length;
        return dlgShell(t('preset confirm.title', { preset: t(`preset ${d.preset}`) }), t('preset confirm', { n }), ov ? `<p class="adialog__note">${t('preset confirm.overrides', { n: ov })}</p>` : '', btn('dlg-close', t('cancel')) + btn('preset-ok', t('preset confirm.ok'), 'btn--primary'), { wide: false });
      }
      if (d.kind === 'sub') {
        return dlgShell(t('sub.title'), '', `<div class="tm-call" role="note">${I.warn}<p>${t('risk warning')}</p></div><p>${t('sub.levers')}</p><label class="tm-check"><input type="checkbox" data-act="sub-check" data-fk="sub-check"${d.checked ? ' checked' : ''}>${t('sub.check')}</label>`,
          btn('dlg-close', t('cancel')) + btn('sub-ok', t('sub.ok'), 'btn--primary', d.checked ? '' : ' aria-disabled="true"'), { wide: false, role: 'alertdialog' });
      }
      if (d.kind === 'review') {
        const rows = changes(); const notes = {};
        if (G.budget === 'waived' && rows.some((c) => c.path === 'budget.monthly_usd')) notes['budget.monthly_usd'] = t('budget.waived.review', { month: monthName() });
        const err = S.saveErr ? `<div class="adialog__err" role="alert">${I.bang}<span>${t('save failed')}</span></div>` : '';
        const body = `${diffTable(rows, { notes })}<p class="adialog__note">${t('applies next')}</p>
          <div class="field"><label class="field__label" for="${uid}-reason">${t('reason label')}</label><textarea class="tm-textarea" id="${uid}-reason" maxlength="500" placeholder="${t('reason.ph')}" data-fk="reason" aria-describedby="${uid}-rc">${esc(d.reason || '')}</textarea><span class="tm-count" id="${uid}-rc" data-slot="rc">${(d.reason || '').length} / 500</span></div>${err}`;
        const save = S.busy ? btn('save', t('review.saving'), 'btn--primary', ' aria-disabled="true"') : S.saveErr ? btn('save', t('retry'), 'btn--primary') : btn('save', t('review.save'), 'btn--primary');
        return dlgShell(t('review.title'), esc(t('bar.count', { n: rows.length })), body, btn('dlg-close', t('cancel')) + save);
      }
      if (d.kind === 'theirs') {
        const rows = diff(G.stored, d.doc);
        return dlgShell(t('diff.their', { n: G.rev + 1 }), esc(t('rev.by', { who: whoCap('anna'), date: fmtWhen(D(17, 11, 4)) })), `<p class="tm-reason">${esc(L.lang === 'ru' ? 'Снизили бюджет до конца месяца' : 'Lowered the budget for the rest of the month')}</p>${diffTable(rows)}`, btn('dlg-close', t('diff.close')));
      }
      if (d.kind === 'import') {
        if (d.phase === 'loading') return dlgShell(t('import'), '', `<p class="tm-slow" role="status">${dots}<span>${t('import.loading')}</span></p>`, btn('dlg-close', t('cancel')));
        if (d.phase === 'error') return dlgShell(t('import'), '', `<div class="block block--error" role="alert"><h3>${t('import.fail.title')}</h3><p>${t('import.fail')}</p></div>`, btn('dlg-close', t('cancel')) + btn('imp-retry', t('retry'), 'btn--primary'));
        const rows = Object.entries(IMPORTED).map(([p, v]) => ({ path: p, old: get(S.draft, p), new: v })).filter((c) => !same(c.old, c.new));
        const body = `<h3 class="tm-label" style="margin:0">${t('import.values')}</h3>${diffTable(rows)}
          <div class="tm-call" role="note">${I.warn}<div><b>${t('import.notes')}</b><p>${t('import note')}</p></div></div>
          <div><h3 class="tm-label" style="margin:0 0 var(--sp-1)">${t('import.ignored')}</h3><ul class="tm-small" style="margin:0;padding-left:1.2em"><li><code>roles.dev.model</code> — ${t('import.ign.model')}</li><li><code>budget.monthly_usd</code> — ${t('import.ign.budget')}</li></ul></div>
          <p class="adialog__note">${t('import.never')}</p>`;
        return dlgShell(t('import'), esc(t('import.sub', { branch: 'main', n: 4 })), body, btn('dlg-close', t('cancel')) + btn('imp-use', t('import use'), 'btn--primary'));
      }
      if (d.kind === 'resume') return dlgShell(t('resume.title', { project: PROJECT }), t('resume.message', { budget: usd(G.stored.budget.monthly_usd) }), '', btn('dlg-close', t('cancel')) + btn('resume-ok', t('resume.ok'), 'btn--primary'), { wide: false, role: 'alertdialog' });
      if (d.kind === 'leave') return dlgShell(t('leave'), t('leave.sub', { n: changes().length }), '', btn('dlg-close', t('leave.stay'), 'btn--primary') + btn('leave-ok', t('leave.go'), 'btn--danger-quiet'), { wide: false, role: 'alertdialog' });
      return '';
    }
    // project.yml as the import route returns it: only review.*, caps.*, sprint.* and owner.language are read (T8).
    const IMPORTED = { 'gates.qa': 'code', 'gates.reviewer': 'code', 'gates.code_paths': ['apps/**', 'libs/**'], 'gates.max_rework_rounds': 2, 'caps.normal.dev_tasks': 3, 'sprint.length_days': 14, 'language': 'ru' };

    /* ----- chrome per route ----- */
    function chrome() {
      const backTo = S.route === 'rev' ? 'history' : S.route === 'history' ? 'team' : S.route === 'team' ? 'settings' : null;
      if (kind === 'mac') {
        const c = [`<li><a href="#/settings" data-act="back" data-to="settings" data-fk="cr-settings">${t('nav.settings')}</a></li>`];
        if (S.route === 'settings') c.splice(0, 1, `<li><span aria-current="page">${t('nav.settings')}</span></li>`);
        else {
          c.push(`<li><span>${PROJECT}</span></li>`);
          c.push(S.route === 'team' ? `<li><span aria-current="page">${t('title')}</span></li>` : `<li><a href="#/team" data-act="back" data-to="team" data-fk="cr-team">${t('title')}</a></li>`);
          if (S.route === 'history') c.push(`<li><span aria-current="page">${t('actions.history')}</span></li>`);
          if (S.route === 'rev') { c.push(`<li><a href="#/history" data-act="back" data-to="history" data-fk="cr-history">${t('actions.history')}</a></li>`); c.push(`<li><span aria-current="page">${esc(t('rev.title', { n: S.revN }))}</span></li>`); }
        }
        $('[data-slot=crumbs]').innerHTML = `<ol>${c.join('')}</ol>`;
        return;
      }
      const lab = backTo === 'settings' ? t('nav.settings') : backTo === 'team' ? t('title') : backTo === 'history' ? t('actions.history') : '';
      $('[data-slot=phead]').innerHTML = `<header class="p-bar">${backTo ? `<button type="button" class="p-back" data-act="back" data-to="${backTo}" data-fk="back">${I.back}<span>${lab}</span></button>` : '<span></span>'}<span></span><span></span></header>`;
    }

    /* ----- render, keeping focus by data-fk ----- */
    function render(opts = {}) {
      const active = host.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
      chrome();
      const screen = $('[data-slot=screen]');
      screen.innerHTML = S.route === 'history' ? historyScreen() : S.route === 'rev' ? revScreen() : S.route === 'settings' ? settingsStub() : teamScreen();
      $('[data-slot=modal]').innerHTML = dialogHTML();
      host.querySelectorAll('[data-bg]').forEach((el) => { el.inert = !!S.dlg; });
      const fk = opts.focus || (S.dlg && !opts.keep ? null : active);
      const target = fk ? host.querySelector(`[data-fk="${fk}"]`) : null;
      if (target) target.focus({ preventScroll: !opts.focus });
      if (opts.dlgFocus && S.dlg) $('[data-slot=modal] h2')?.focus();
      if (opts.scrollTop) $('[data-slot=scroll]').scrollTop = 0;
      if (opts.scrollTo) scrollToEl(host.querySelector(opts.scrollTo));
      if (opts.focus && target && !opts.scrollTo) scrollToEl(target, true);
    }
    function scrollToEl(el, ifNeeded) {
      if (!el) return;
      const box = $('[data-slot=scroll]'); const a = el.getBoundingClientRect(); const b = box.getBoundingClientRect();
      if (ifNeeded && a.top >= b.top && a.bottom <= b.bottom - 90) return;
      box.scrollTop += a.top - b.top - (phone ? 12 : 24);
    }
    const announce = (txt) => { const l = $('[data-slot=live]'); l.textContent = ''; setTimeout(() => { l.textContent = plain(txt); }, 30); };
    let toastTimer;
    function toast(txt) {
      const el = $('[data-slot=toast]'); el.textContent = plain(txt); el.hidden = false;
      if (!isReduced()) play(el, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: ms('--dur-base'), easing: cssVar('--ease-enter') });
      else play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: ms('--dur-fade') });
      clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms('--dur-toast') + 1200);
    }
    let countTimer;
    function edited() {
      const n = changes().length;
      clearTimeout(countTimer); countTimer = setTimeout(() => announce(t('unsaved.announce', { n })), 600);
    }
    function openDlg(d, opener) { S.dlg = d; S.opener = opener || S.opener; render({ dlgFocus: true }); }
    function closeDlg(focusFk) { const back = focusFk || S.opener; S.dlg = null; S.saveErr = false; S.busy = false; render({ focus: back }); }

    /* ----- navigation ----- */
    function go(route, focus = 'h1') { S.route = route; S.raw = false; render({ focus, scrollTop: true }); }
    function back(to) {
      if (to === 'settings' && S.route === 'team' && editable() && changes().length) { openDlg({ kind: 'leave' }, 'back'); return; }
      go(to, S.route === 'rev' && to === 'history' ? `rev-${S.revN}` : 'h1');
    }

    /* ----- saving: PUT with If-Match; the answer comes from the demo's "Next save" ----- */
    async function save() {
      if (S.busy) return;
      S.busy = true; S.saveErr = false; render({ focus: 'd-save', keep: true });
      await wait(isReduced() ? 300 : 900);
      S.busy = false;
      const result = S.failedOnce ? 'ok' : G.save;
      if (result === 'network') { S.saveErr = true; S.failedOnce = true; render({ focus: 'd-save', keep: true }); announce(t('save failed')); return; }
      S.failedOnce = false;
      const reason = S.dlg?.reason || '';
      S.dlg = null;
      if (result === 'invalid') {
        S.draft.gates.code_paths = [...S.draft.gates.code_paths.filter((p) => !p.startsWith('/')), '/srv/**'];
        S.errs['gates.code_paths'] = t('invalid', { field: t('g.paths'), why: t('invalid.path') });
        S.open.rules = true; render({ focus: 'path-new' }); return;
      }
      if (result === 'conflict') { S.banner = 'conflict'; S.theirs = theirs13(G.stored); render({ focus: 'ban' }); return; }
      if (result === 'forbidden') { S.r403 = true; render({ focus: 'ban', scrollTop: true }); return; }
      const before = G.stored;
      G.stored = clone(S.draft); G.rev += 1; S.errs = {};
      G.entries.unshift({ n: G.rev, who: 'you', at: new Date(), reason, changes: diff(before, G.stored) });
      if (G.data === 'empty') G.data = 'loaded';
      const nb = G.stored.budget.monthly_usd;
      if (before.budget.monthly_usd !== nb && G.budget !== 'normal') G.budget = nb != null && SPEND[G.budget] >= nb ? 'stopped' : 'normal';
      renderAll();
      render({ focus: 'h1', scrollTop: true });
      toast(t('saved', { n: G.rev })); announce(t('saved', { n: G.rev }));
    }
    function keepMine() {
      const base = G.stored; const theirs = S.theirs || theirs13(base);
      G.rev += 1;
      G.entries.unshift({ n: G.rev, who: 'anna', at: D(17, 11, 4), reason: L.lang === 'ru' ? 'Снизили бюджет до конца месяца' : 'Lowered the budget for the rest of the month', changes: diff(base, theirs) });
      G.stored = theirs;
      mergeOnto(base, theirs);
      hosts.forEach((h) => { if (h.S !== S && h.app && !diff(base, h.S.draft).length) h.S.draft = clone(G.stored); });
      renderAll(); render({ focus: 'ban' });
    }
    // Reload their revision and reapply the fields I touched; a field both of us changed is asked, mine preselected.
    function mergeOnto(base, theirs) {
      const touched = diff(base, S.draft);
      const next = clone(theirs); const overlap = [];
      touched.forEach((c) => {
        const tv = get(theirs, c.path);
        if (!same(tv, get(base, c.path)) && !same(tv, c.new)) overlap.push({ path: c.path, mine: c.new, theirs: tv });
        set(next, c.path, clone(c.new));
      });
      S.draft = next; S.overlap = overlap; S.banner = 'merged';
    }

    /* ----- events ----- */
    host.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]'); if (!el || !host.contains(el)) return;
      const act = el.dataset.act; const r = el.dataset.role;
      if (el.tagName === 'A') e.preventDefault();
      if (el.getAttribute('aria-disabled') === 'true' && !['locked'].includes(act)) { if (act === 'access') e.preventDefault(); return; }
      switch (act) {
        case 'sec': S.open[el.dataset.id] = !S.open[el.dataset.id]; render(); break;
        case 'preset': if (el.dataset.preset !== S.draft.preset || overridesOf(S.draft).length) openDlg({ kind: 'preset', preset: el.dataset.preset }, el.dataset.fk); break;
        case 'preset-ok': { const p = S.dlg.preset; const keep = S.draft; const nd = presetDoc(p); ROLES.forEach((x) => { nd.roles[x] = { ...keep.roles[x], model: PRESET_MODELS[p][x], effort: EFFORT_OF[PRESET_MODELS[p][x]] }; }); Object.assign(keep, { preset: p, roles: nd.roles }); S.dlg = null; render({ focus: `preset-${p}` }); edited(); break; }
        case 'reset-all': ROLES.forEach((x) => { const m = PRESET_MODELS[S.draft.preset][x]; Object.assign(S.draft.roles[x], { model: m, effort: EFFORT_OF[m] }); }); render({ focus: `preset-${S.draft.preset}` }); edited(); break;
        case 'reset-row': { const m = PRESET_MODELS[S.draft.preset][r]; Object.assign(S.draft.roles[r], { model: m, effort: EFFORT_OF[m] }); render({ focus: `pick-${r}` }); edited(); break; }
        case 'toggle': S.draft.roles[r].enabled = !S.draft.roles[r].enabled; render({ focus: `sw-${r}` }); edited(); break;
        case 'locked': announce(t('role locked')); break;
        case 'picker': openDlg({ kind: 'picker', role: r, model: S.draft.roles[r].model, effort: S.draft.roles[r].effort, effortTouched: false }, el.dataset.fk); break;
        case 'pm-effort': S.dlg.effort = el.dataset.effort; S.dlg.effortTouched = true; render({ focus: `pe-${S.dlg.effort}`, keep: true }); break;
        case 'pm-done': Object.assign(S.draft.roles[S.dlg.role], { model: S.dlg.model, effort: S.dlg.effort }); S.hl = S.dlg.role; closeDlg(); S.hl = null; edited(); break;
        case 'limits': { const x = S.draft.roles[r]; openDlg({ kind: 'limits', role: r, v: { max_minutes: x.max_minutes, max_turns: x.max_turns, max_parallel: x.max_parallel }, errs: {} }, el.dataset.fk); break; }
        case 'lim-done': {
          const d = S.dlg; d.errs = {};
          Object.keys(d.v).forEach((k) => { const n = Number(d.v[k]); const [mn, mx] = BOUNDS[k]; if (!Number.isInteger(n) || n < mn || n > mx) d.errs[k] = t('range', { min: mn, max: mx }); });
          const bad = Object.keys(d.errs)[0];
          if (bad) { render({ focus: `l-${bad}`, keep: true }); break; }
          Object.keys(d.v).forEach((k) => { S.draft.roles[d.role][k] = Number(d.v[k]); });
          closeDlg(); edited(); break;
        }
        case 'sub-ok': S.draft.access = 'subscription'; delete S.errs.access; closeDlg('acc-sub'); edited(); break;
        case 'runners': toast(t('access.runners')); break;
        case 'path-rm': S.draft.gates.code_paths.splice(Number(el.dataset.i), 1); if (!S.draft.gates.code_paths.some((p) => p.startsWith('/'))) delete S.errs['gates.code_paths']; render({ focus: 'path-new' }); edited(); break;
        case 'path-add': addPath(); break;
        case 'discard': S.draft = clone(G.stored); S.errs = {}; S.banner = S.banner === 'merged' ? null : S.banner; render({ focus: `preset-${S.draft.preset}` }); announce(t('unsaved.announce', { n: 0 })); break;
        case 'review': { const bad = Object.keys(S.errs)[0]; if (bad) { render({ focus: bad === 'budget.monthly_usd' ? 'budget' : `n-${bad}` }); break; } openDlg({ kind: 'review', reason: '' }, 'review'); break; }
        case 'save': save(); break;
        case 'dlg-close': closeDlg(); break;
        case 'c-show': openDlg({ kind: 'theirs', doc: S.theirs || theirs13(G.stored) }, 'c-show'); break;
        case 'c-keep': keepMine(); break;
        case 'c-discard': { const th = S.theirs || theirs13(G.stored); G.rev += 1; G.entries.unshift({ n: G.rev, who: 'anna', at: D(17, 11, 4), reason: '', changes: diff(G.stored, th) }); G.stored = th; S.draft = clone(th); S.banner = null; renderAll(); render({ focus: `preset-${S.draft.preset}` }); break; }
        case 'm-done': S.banner = null; S.overlap = null; render({ focus: 'review' }); break;
        case 'import': openDlg({ kind: 'import', phase: 'loading' }, 'import'); loadImport(); break;
        case 'imp-retry': S.dlg.phase = 'loading'; render({ dlgFocus: true }); loadImport(true); break;
        case 'imp-use': { Object.entries(IMPORTED).forEach(([p, v]) => set(S.draft, p, clone(v))); S.dlg = null; S.open.rules = true; render({ focus: 'r-gates.qa-code' }); const n = changes().length; announce(t('import.done', { n })); toast(t('import.done', { n })); break; }
        case 'history': go('history'); break;
        case 'hist-retry': G.history = 'ok'; renderAll(); render({ focus: 'h1' }); break;
        case 'more': S.more = true; render({ focus: `rev-${G.entries[5].n}` }); break;
        case 'rev': S.revN = Number(el.dataset.n); go('rev'); break;
        case 'raw': S.raw = !S.raw; render({ focus: 'raw' }); break;
        case 'use-rev': S.draft = docAt(S.revN); S.route = 'team'; render({ scrollTop: true }); { const first = changes()[0]; const fk = first ? fkOf(first.path) : 'h1'; render({ focus: fk }); toast(t('diff.used', { n: S.revN })); } break;
        case 'back': back(el.dataset.to); break;
        case 'back-team': go('team'); break;
        case 'leave-ok': S.dlg = null; S.draft = clone(G.stored); go('settings'); break;
        case 'resume': openDlg({ kind: 'resume' }, 'resume'); break;
        case 'resume-ok': G.budget = 'waived'; G.waivedAt = new Date(); S.dlg = null; S.open.limits = true; renderAll(); render({ focus: 'h1' }); toast(t('budget resumed')); announce(t('budget resumed')); break;
        case 'raise': S.open.limits = true; render({ focus: 'budget', scrollTo: '[data-sec=limits]' }); break;
        case 'reload': G.data = 'loading'; renderAll(); setTimeout(() => { G.data = 'loaded'; renderAll(); }, 1200); break;
        default: break;
      }
    });
    const fkOf = (path) => { const k = path.split('.'); if (k[0] === 'roles') return k[2] === 'enabled' ? `sw-${k[1]}` : k[2] === 'model' || k[2] === 'effort' ? `pick-${k[1]}` : `lim-${k[1]}`; if (path === 'budget.monthly_usd') return 'budget'; if (path === 'access') return 'acc-api'; return `n-${path}`; };
    function addPath() {
      const inp = host.querySelector('[data-fk=path-new]'); const v = (inp?.value || '').trim(); if (!v) return;
      if (v.startsWith('/') || v.includes('..') || v.includes('\\')) { S.errs['gates.code_paths'] = t('invalid', { field: t('g.paths'), why: t('invalid.path') }); render({ focus: 'path-new' }); return; }
      delete S.errs['gates.code_paths'];
      if (!S.draft.gates.code_paths.includes(v)) S.draft.gates.code_paths.push(v);
      render({ focus: 'path-new' }); edited();
    }
    async function loadImport(retry) {
      await wait(isReduced() ? 300 : 900);
      if (!S.dlg || S.dlg.kind !== 'import') return;
      S.dlg.phase = G.impFail && !retry ? 'error' : 'ok';
      render({ dlgFocus: true });
    }
    host.addEventListener('change', (e) => {
      const el = e.target;
      if (el.dataset.act === 'access') {
        if (el.value === 'subscription') { if (el.getAttribute('aria-disabled') === 'true') { e.preventDefault(); render({ focus: 'acc-api' }); return; } el.checked = false; host.querySelector('[data-fk=acc-api]').checked = S.draft.access === 'api_key'; openDlg({ kind: 'sub', checked: false }, 'acc-sub'); return; }
        S.draft.access = 'api_key'; delete S.errs.access; render({ focus: 'acc-api' }); edited(); return;
      }
      if (['pm-model', 'sub-check'].includes(el.dataset.act) || el.dataset.lim) { if (!S.dlg) return; }
      if (el.dataset.act === 'pm-model') { S.dlg.model = el.value; if (!S.dlg.effortTouched) S.dlg.effort = EFFORT_OF[el.value]; render({ focus: `pm-${el.value}`, keep: true }); return; }
      if (el.dataset.act === 'sub-check') { S.dlg.checked = el.checked; render({ focus: 'sub-check', keep: true }); return; }
      if (el.dataset.act === 'm-pick') { const o = S.overlap.find((x) => x.path === el.dataset.path); set(S.draft, o.path, clone(el.dataset.side === 'mine' ? o.mine : o.theirs)); render({ focus: el.dataset.fk }); return; }
      if (el.dataset.lim) { S.dlg.v[el.dataset.lim] = el.value; return; }
      const path = el.dataset.path; if (!path) return;
      if (el.getAttribute('aria-disabled') === 'true') { render(); return; }
      if (el.type === 'checkbox') set(S.draft, path, el.checked);
      else if (el.type === 'radio') set(S.draft, path, el.value);
      else if (el.type === 'number') {
        const f = path.split('.').pop(); const raw = el.value.trim();
        if (path === 'budget.monthly_usd' && raw === '') { set(S.draft, path, null); delete S.errs[path]; }
        else {
          const n = Number(raw); const [mn, mx] = BOUNDS[f];
          if (!Number.isInteger(n) || n < mn || n > mx) S.errs[path] = t('invalid', { field: plain(label(path)), why: plain(t('range', { min: mn, max: mx })).replace(/\.$/, '').toLowerCase() });
          else { delete S.errs[path]; set(S.draft, path, n); }
        }
      }
      render({ focus: el.dataset.fk }); edited();
    });
    host.addEventListener('input', (e) => { if (e.target.dataset.fk === 'reason' && S.dlg) { S.dlg.reason = e.target.value; const c = host.querySelector('[data-slot=rc]'); if (c) c.textContent = `${e.target.value.length} / 500`; } });
    host.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && S.dlg) { e.preventDefault(); closeDlg(); return; }
      if (e.key === 'Enter' && e.target.dataset.fk === 'path-new') { e.preventDefault(); addPath(); return; }
      const radio = e.target.closest('.tm-seg [role=radio]');
      if (radio && ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        // arrow keys move along the group; Space or Enter chooses (a preset change opens its confirm sheet)
        e.preventDefault();
        const all = [...radio.parentElement.querySelectorAll('[role=radio]')]; const i = all.indexOf(radio);
        const next = all[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length];
        all.forEach((b) => b.setAttribute('tabindex', b === next ? '0' : '-1')); next.focus();
      }
      if (S.dlg && e.key === 'Tab') {
        const f = [...host.querySelectorAll('[data-slot=modal] button, [data-slot=modal] input, [data-slot=modal] textarea, [data-slot=modal] [tabindex="0"]')].filter((x) => !x.closest('[hidden]'));
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });

    /* ----- demo hooks ----- */
    const app = {
      render: () => render(),
      state(v) {
        Object.assign(S, fresh());
        const seed = () => { Object.assign(S.draft.roles.dev, { model: 'fable', effort: 'high' }); S.draft.roles['ui-designer'].enabled = true; S.draft.budget.monthly_usd = 250; };
        const at = { scrollTop: true };
        switch (v) {
          case 'member': break;
          case 'locked': Object.assign(at, { scrollTo: '[data-role-row=orchestrator]', focus: 'sw-orchestrator' }); break;
          case 'picker': S.dlg = { kind: 'picker', role: 'dev', model: 'opus', effort: 'high' }; S.opener = 'pick-dev'; break;
          case 'subscription': S.dlg = { kind: 'sub', checked: true }; S.opener = 'acc-sub'; S.open.access = true; break;
          case 'hosted': S.open.access = true; at.scrollTo = '[data-sec=access]'; break;
          case 'hostedErr': S.open.access = true; S.draft.access = 'subscription'; S.errs.access = t('error access-source-hosted'); at.scrollTo = '[data-sec=access]'; break;
          case 'preset': S.dlg = { kind: 'preset', preset: 'economy' }; S.opener = 'preset-economy'; break;
          case 'review': seed(); S.dlg = { kind: 'review', reason: L.lang === 'ru' ? 'Fable разработчику на время рефакторинга' : 'Fable for the developer during the refactor' }; S.opener = 'review'; break;
          case 'network': seed(); S.dlg = { kind: 'review', reason: '' }; S.saveErr = true; S.failedOnce = true; S.opener = 'review'; break;
          case 'conflict': seed(); S.banner = 'conflict'; S.theirs = theirs13(G.stored); at.focus = 'ban'; break;
          case 'merged': { const base = storedRev12(); S.draft = clone(base); seed(); mergeOnto(base, G.stored); at.focus = 'ban'; break; }
          case 'invalid': seed(); S.draft.gates.code_paths.push('/srv/**'); S.errs['gates.code_paths'] = t('invalid', { field: t('g.paths'), why: t('invalid.path') }); S.open.rules = true; Object.assign(at, { scrollTo: '[id$=paths-l]', focus: 'path-new' }); break;
          case 'forbidden': seed(); S.r403 = true; at.focus = 'ban'; break;
          case 'import': S.dlg = { kind: 'import', phase: 'ok' }; S.opener = 'import'; break;
          case 'importFail': S.dlg = { kind: 'import', phase: 'error' }; S.opener = 'import'; break;
          case 'history': case 'partial': S.route = 'history'; break;
          case 'diff': S.route = 'rev'; S.revN = 9; break;
          case 'raw': S.route = 'rev'; S.revN = 9; S.raw = true; break;
          case 'resume': S.dlg = { kind: 'resume' }; S.opener = 'resume'; break;
          case 'waived': S.open.limits = true; at.scrollTo = '[data-sec=limits]'; break;
          case 'offline': seed(); break;
          case 'leave': seed(); S.dlg = { kind: 'leave' }; S.opener = 'back'; break;
          case 'saved': setTimeout(() => toast(t('saved', { n: G.rev })), 50); break;
          default: break;
        }
        render(at);
        if (S.dlg) $('[data-slot=modal] h2')?.focus({ preventScroll: true });
      },
    };
    host.app = app;
    render();
    return app;
  }

  /* ---------- page controls ---------- */
  const mountAll = (keep) => hosts.forEach((h) => { const prev = keep && h.S ? h.S : null; h.className = 'app'; mountApp(h, h.dataset.app, prev); });
  const pageChrome = Proto.page({ L, title: 'Team Console · #688', onLang: () => { G.entries = seedHistory().filter((e) => e.n <= G.rev); mountAll(true); } });
  const sel = (id) => document.getElementById(id);
  let slowTimer;
  function applyState(v) {
    clearTimeout(slowTimer);
    const keepSave = G.save; const keepHosted = G.hosted; const keepImp = G.impFail;
    resetG(); G.save = keepSave; G.hosted = keepHosted; G.impFail = keepImp;
    if (v === 'member') G.member = true;
    if (v === 'hosted') G.hosted = true;
    if (v === 'partial') G.history = 'error';
    if (v === 'budget' || v === 'resume') G.budget = 'stopped';
    if (v === 'waived') G.budget = 'waived';
    if (v === 'loading' || v === 'slow' || v === 'error') G.data = v;
    if (v === 'offline') G.offline = true;
    if (v === 'importFail') G.impFail = true;
    if (v === 'merged') { const base = G.stored; G.stored = theirs13(base); G.rev = 13; G.entries.unshift({ n: 13, who: 'anna', at: D(17, 11, 4), reason: L.lang === 'ru' ? 'Снизили бюджет до конца месяца' : 'Lowered the budget for the rest of the month', changes: diff(base, G.stored) }); }
    if (v === 'empty') { G.data = 'empty'; G.stored = presetDoc('recommended'); G.entries = []; G.rev = 0; }
    if (v === 'loading') slowTimer = setTimeout(() => { if (G.data === 'loading') { G.data = 'slow'; renderAll(); } }, 3000);
    sel('d-hosted').checked = G.hosted; sel('d-impfail').checked = G.impFail;
    hosts.forEach((h) => h.app.state(v));
  }
  sel('d-state').addEventListener('change', (e) => applyState(e.target.value));
  sel('d-save').addEventListener('change', (e) => { G.save = e.target.value; hosts.forEach((h) => { h.S.failedOnce = false; }); });
  sel('d-hosted').addEventListener('change', (e) => { G.hosted = e.target.checked; renderAll(); });
  sel('d-impfail').addEventListener('change', (e) => { G.impFail = e.target.checked; });
  document.querySelector('[data-reset]').addEventListener('click', () => { G.save = 'ok'; G.hosted = false; G.impFail = false; sel('d-save').value = 'ok'; sel('d-state').value = 'loaded'; applyState('loaded'); });

  // ?state=…&view=…&theme=…&lang=…&motion=…&shot=1 opens a state directly (used for the screenshots).
  const q = new URLSearchParams(location.search);
  if (q.has('shot')) Proto.root.dataset.shot = '';
  if (q.get('lang') === 'en' || q.get('lang') === 'ru') { L.save(q.get('lang')); pageChrome.setControl('lang', q.get('lang')); }
  mountAll(false);
  ['view', 'theme', 'motion'].forEach((k) => { if (q.get(k)) pageChrome.setControl(k, q.get(k)); });
  if (q.get('save')) { G.save = q.get('save'); sel('d-save').value = G.save; }
  const st = q.get('state') || 'loaded';
  sel('d-state').value = st;
  applyState(st);
  pageChrome.fit();
})();
