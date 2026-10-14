/* #109 Team analytics: the space's Stats tab («Показатели»). Design prototype runtime with mock data only, no network.
   Every GitHub text (titles, reasons) goes through esc(); a reason keeps only https://github.com/ URLs as links, as the
   app will interpolate it (plain text, withoutInvisibles, dir="auto"). Numbers are formatted through the active locale. */
(() => {
  'use strict';
  const { isReduced, esc, wait, I } = Proto;
  const L = Proto.i18n(I18N);
  const { t } = L;

  const svg = (d, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`;
  const ICO = {
    chart: svg('<path d="M4 19.5h16"/><path d="M7.5 16v-4.5M12 16V7M16.5 16v-6.5"/>'),
    up: svg('<path d="M12 18.5v-13M6.5 11L12 5.5l5.5 5.5"/>'),
    bang: svg('<path d="M12 6.5v7M12 17.3v.2"/>'),
    arrowDown: svg('<path d="M12 5.5v13M6.5 13l5.5 5.5 5.5-5.5"/>'),
  };
  // Kit glyphs tier-light|standard|heavy from #134 (a three-step meter).
  const BAR1 = 'M5 14h2v6H5z'; const BAR2 = 'M11 9h2v11h-2z'; const BAR3 = 'M17 4h2v16h-2z';
  const TIER = { light: `${BAR1}M11 20h2M17 20h2`, standard: `${BAR1}${BAR2}M17 20h2`, heavy: `${BAR1}${BAR2}${BAR3}` };
  const tierIco = (k) => `<span class="tier-ico tier-ico--${k}">${svg(`<path d="${TIER[k]}"/>`)}</span>`;

  // The review-round tally: four upright strokes and a fifth across, like a ledger. Decorative; the words say it.
  function tally(n) {
    let paths = ''; let maxX = 4;
    for (let k = 0; k < n; k += 1) {
      const x0 = Math.floor(k / 5) * 22 + 2; const j = k % 5;
      if (j < 4) { const x = x0 + j * 4; paths += `<path style="--k:${k}" d="M${x} 2.5v11"/>`; maxX = Math.max(maxX, x + 2); }
      else { paths += `<path style="--k:${k}" d="M${x0 - 1} 11.5L${x0 + 15} 4.5"/>`; maxX = Math.max(maxX, x0 + 17); }
    }
    return `<svg class="tally" viewBox="0 0 ${maxX} 16" width="${maxX}" aria-hidden="true" focusable="false">${paths}</svg>`;
  }

  /* ---------- mock data ---------- */
  const REPO = 'https://github.com/geeera/team-console';
  const DATES = {
    ru: { start: '2 окт', demo: '16 окт', since: '30 сен', paused: '11 окт, 09:00', pausedDay: '11 окт' },
    en: { start: '2 Oct', demo: '16 Oct', since: '30 Sep', paused: '11 Oct, 09:00', pausedDay: '11 Oct' },
  };
  const BLOCKED = [
    { n: 274, d: 9, title: 'Console dialogs: fit the viewport, one scroll, sticky actions',
      reason: 'Ждём решения владельца: какой размер окна считать основным на Mac — 1280 или 1440. Вопрос в https://github.com/geeera/team-console/issues/280. Без ответа дизайн не утвердить, а без дизайна диалоги не переделать.\nПока делаем остальное из спринта.' },
    { n: 276, d: 3, title: '«Вопросы»: enough context to decide in the console',
      reason: 'QA: e2e на webkit падает на загрузке превью, нужен фикс в #290. Прогон: https://example.com/run/123' },
    { n: 152, d: 1, title: 'Stage and production GitHub Apps', reason: '' },
  ];
  const PRS = [
    { n: 301, title: 'feat(#277): design viewer', rounds: 3, qa: 1, rv: 1, failed: true, up: true },
    { n: 296, title: 'feat(#276): question context on cards', rounds: 2, qa: 1, rv: 0 },
    { n: 288, title: 'fix(#288): fences close on the same marker', rounds: 2, qa: 0, rv: 1 },
    { n: 284, title: 'feat(#284): session expired screen', rounds: 1, qa: 0, rv: 0 },
    { n: 282, title: 'fix(#282): sheet footer order', rounds: 1, qa: 0, rv: 0 },
    { n: 279, title: 'chore: bump wrangler to 4.130.0', rounds: 1, qa: 0, rv: 0 },
    { n: 271, title: 'feat(#219): owner requests to the PM', rounds: 1, qa: 0, rv: 0 },
  ];
  const MAX_REWORK = 1; // review.max_rework_rounds from project.yml: rounds above 1 + 1 get the strong mark
  const SLOTS = [
    { key: 'dev', runs: 18, failed: 3, minutes: 24 },
    { key: 'qa', runs: 14, failed: 1, minutes: 12 },
    { key: 'pm', runs: 8, failed: 0, minutes: null },
    { key: 'slot-burn', runs: 1, failed: 0, minutes: 95 },
  ];
  const TIERS = [['light', 6, 4, 0], ['standard', 11, 5, 1], ['heavy', 2, 1, 0], ['unsized', 1, 0, null]];

  function dataOf(name) {
    const D = {
      team: 'running', stuck: BLOCKED, untrustedReason: false,
      reviews: { rate: 0.6, a: 6, b: 10, changes: 5, prs: PRS },
      sprint: { name: 'Sprint 03', planned: 20, shipped: 10, cycle: 2.4, cycleN: 10, tiers: TIERS },
      runs: { slots: SLOTS, untrusted: 0 },
    };
    if (name === 'calm') { D.stuck = []; D.runs = { slots: SLOTS.map((s) => ({ ...s, failed: 0 })), untrusted: 0 }; }
    if (name === 'paused') D.team = 'paused';
    if (name === 'failing') D.team = 'failing';
    if (name === 'nolog') D.runs = 'nolog';
    if (name === 'unreadable') D.runs = 'unreadable';
    if (name === 'nosprint') { D.sprint = null; D.reviews = null; }
    if (name === 'early') {
      D.reviews = { rate: null, a: 0, b: 0, changes: 0, prs: [] };
      D.sprint = { name: 'Sprint 03', planned: 20, shipped: 0, cycle: null, cycleN: 0, tiers: TIERS.map(([k, p, , r]) => [k, p, 0, r === null ? null : 0]) };
    }
    if (name === 'partialReviews') D.reviews = { ...D.reviews, partial: true };
    if (name === 'partialSprint') D.sprint = { ...D.sprint, partial: true };
    if (name === 'untrusted') { D.untrustedReason = true; D.runs = { slots: SLOTS, untrusted: 2 }; }
    return D;
  }

  const G = { load: 'loaded', data: 'typical', refreshFails: false };
  const hosts = [...document.querySelectorAll('[data-app]')];

  /* ---------- formatting through the active locale ---------- */
  const loc = () => (L.lang === 'ru' ? 'ru-RU' : 'en-GB');
  const pct = (r) => new Intl.NumberFormat(loc(), { style: 'percent', maximumFractionDigits: 0 }).format(r);
  const dec = (x) => new Intl.NumberFormat(loc(), { maximumFractionDigits: 1 }).format(x);
  const dur = (m) => (m < 60 ? t('stats.runs.minutes', { n: m }) : t('stats.runs.hours', { h: Math.floor(m / 60), m: m % 60 }));
  const slotName = (k) => (['pm', 'dev', 'qa'].includes(k) ? t(`commands.slot.${k}`) : `<span class="an-raw">${esc(k)}</span>`);
  const slotPlain = (k) => (['pm', 'dev', 'qa'].includes(k) ? t(`commands.slot.${k}`) : k);
  const GH = /https:\/\/github\.com\/[^\s<>"'()]+/g;
  // Plain text; only https://github.com/ URLs become links (new tab, noopener noreferrer). Any other URL stays text.
  function reasonHTML(s) {
    let out = ''; let i = 0;
    for (const m of s.matchAll(GH)) {
      const u = m[0].replace(/[.,;:!?]+$/, '');
      out += esc(s.slice(i, m.index));
      out += `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer" data-act="gh">${esc(u.replace('https://', ''))}</a>`;
      i = m.index + u.length;
    }
    return out + esc(s.slice(i));
  }

  /* ---------- one app instance (iPhone or Mac) ---------- */
  function mountApp(host, kind) {
    const uid = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    host.S = { load: G.load, open: new Set(), prMore: false, newFrom: -1, asOf: '14:05', refreshing: false, refreshFailed: false, again: {}, done: {}, inking: true };
    const S = host.S;
    const d = () => DATES[L.lang];

    /* ----- the tiles ----- */
    function tilesHTML(D) {
      const nd = (why) => ({ value: t('stats.noData'), sub: t(`stats.tile.why.${why}`), nodata: true });
      const stuck = D.stuck.length
        ? { value: String(D.stuck.length), sub: t('stats.tile.sub.oldest', { d: D.stuck[0].d }), aria: t('stats.tile.blockedValue', { n: D.stuck.length, d: D.stuck[0].d }), marked: true }
        : { value: t('stats.tile.none'), sub: t('stats.tile.sub.none') };
      let fails;
      if (D.runs === 'nolog') fails = nd('noLog');
      else if (D.runs === 'unreadable') fails = nd('unreadable');
      else {
        const a = D.runs.slots.reduce((s, x) => s + x.failed, 0); const b = D.runs.slots.reduce((s, x) => s + x.runs, 0);
        fails = { value: t('stats.tile.of', { a, b }), sub: t('stats.tile.sub.days'), marked: a > 0 && D.team !== 'paused' };
      }
      const rv = D.reviews;
      let qa;
      if (!rv) qa = nd('noSprint');
      else if (rv.partial && !S.done.reviews) qa = nd('partial');
      else if (rv.rate === null) qa = nd('noVerdict');
      else qa = { value: pct(rv.rate), sub: t('stats.tile.sub.ofPrs', { a: rv.a, b: rv.b }), aria: `${pct(rv.rate)} · ${t('stats.tile.of', { a: rv.a, b: rv.b })}` };
      const sp = D.sprint;
      let done;
      if (!sp) done = nd('noSprint');
      else if (sp.partial && !S.done.sprint) done = nd('partial');
      else done = { value: t('stats.tile.of', { a: sp.shipped, b: sp.planned }), sub: sp.name };
      const tiles = [['stuck', 'blocked', stuck], ['runs', 'fails', fails], ['reviews', 'qa', qa], ['sprint', 'done', done]];
      return `<ul class="an-tiles" aria-label="${esc(t('stats.tiles'))}">${tiles.map(([sec, key, v]) => {
        const label = t(`stats.tile.${key}`);
        const said = v.nodata ? `${v.value}, ${v.sub}` : (v.aria || v.value);
        return `<li><a class="an-tile${v.marked ? ' is-marked' : ''}" href="#${sec}" data-jump="${sec}" aria-label="${esc(Proto.plain(t('stats.tile.aria', { label, value: said.replace(/\.$/, '') })))}">
          <span class="an-tile__label">${v.marked ? `<span class="an-mark">${ICO.bang}</span>` : ''}<span>${label}</span><span class="an-tile__go">${ICO.arrowDown}</span></span>
          <span class="an-tile__value${v.nodata ? ' nodata' : ''}">${esc(v.value)}</span><span class="an-tile__sub">${esc(v.sub)}</span></a></li>`;
      }).join('')}</ul>`;
    }

    /* ----- a block: heading (focus target of the tiles), period line, body ----- */
    const secHTML = (key, title, period, body, count = '') => `<section class="an-sec" id="${uid}-${key}" aria-labelledby="${uid}-${key}-h">
      <header class="an-sec__head"><h2 class="an-sec__title" id="${uid}-${key}-h" tabindex="-1">${title}${count}</h2>${period ? `<p class="an-sec__period">${period}</p>` : ''}</header>${body}</section>`;
    const stateHTML = (tone, ico, title, hint, act = '', titleCls = '', role = '') => `<div class="an-state an-state--${tone}"${role}>${ico}<p class="an-state__t${titleCls}">${title}</p>${hint ? `<p class="an-state__h">${hint}</p>` : ''}${act ? `<div class="an-state__act">${act}</div>` : ''}</div>`;
    const partialHTML = (block, titleKey) => {
      const busy = S.again[block];
      const btn = `<button type="button" class="btn" data-act="again" data-block="${block}" data-fk="again-${block}"${busy ? ' aria-disabled="true"' : ''}>${busy ? `<span class="ring" aria-hidden="true"></span>${t('stats.partial.loading')}` : `${I.refresh}${t('stats.partial.action')}`}</button>`;
      return stateHTML('partial', I.warn, t(titleKey), t('stats.partial.hint'), btn);
    };
    const ghLink = (href, text, cls = 'an-row__title') => `<a class="${cls}" href="${href}" target="_blank" rel="noopener noreferrer" data-act="gh" dir="auto">${text}<span class="sr-only"> ${t('board.opensGitHub')}</span>${I.ext}</a>`;

    function stuckHTML(D) {
      let body;
      if (!D.stuck.length) body = stateHTML('empty', I.check, t('stats.stuck.emptyTitle'), t('stats.stuck.emptyHint'));
      else {
        body = `<div class="an-card an-card--list"><ul class="an-list">${D.stuck.map((b, i) => {
          const rid = `${uid}-r${b.n}`; const open = S.open.has(b.n); const long = b.reason.length > 140;
          const untrusted = D.untrustedReason && b.n === 276;
          const reason = b.reason
            ? `<div class="an-reason"><p class="an-reason__text${long && !open ? ' is-clamped' : ''}" id="${rid}" dir="auto"><span class="sr-only">${t('stats.stuck.reasonLabel')} </span>${reasonHTML(b.reason)}</p>${long ? `<button type="button" class="link-btn" data-act="reason" data-n="${b.n}" data-fk="reason-${b.n}" aria-expanded="${open}" aria-controls="${rid}">${t(open ? 'stats.stuck.less' : 'stats.stuck.more')}${I.down}</button>` : ''}</div>`
            : `<div class="an-reason"><p class="an-reason__text an-reason__text--none">${t('stats.stuck.noReason')}</p></div>`;
          return `<li><div class="an-row" style="--i:${i}"><span class="an-row__num">#${b.n}</span><div class="an-row__main">
            ${ghLink(`${REPO}/issues/${b.n}`, esc(b.title))}
            <div class="an-row__chips"><span class="an-chip${b.d >= 7 ? ' an-chip--strong' : ''}">${I.clock}${t('stats.stuck.days', { n: b.d })}</span>${untrusted ? `<span class="an-chip an-chip--untrusted">${I.warn}${t('board.untrusted')}</span>` : ''}</div>
            ${reason}</div></div></li>`;
        }).join('')}</ul></div>`;
      }
      const count = D.stuck.length ? ` <span class="an-sec__count">${D.stuck.length}</span>` : '';
      return secHTML('stuck', t('stats.stuck.title'), t('stats.stuck.period'), body, count);
    }

    function reviewsHTML(D) {
      const rv = D.reviews;
      const period = t('stats.reviews.period', { date: d().start });
      if (!rv) return secHTML('reviews', t('stats.reviews.title'), '', stateHTML('nodata', I.clock, t('stats.sprint.noneTitle'), t('stats.sprint.noneHint')));
      if (rv.partial && !S.done.reviews) return secHTML('reviews', t('stats.reviews.title'), period, partialHTML('reviews', 'stats.partial.reviewsTitle'));
      const first = rv.rate === null
        ? `<span class="an-fig__v nodata">${t('stats.noData')}</span><span class="an-fig__s">${t('stats.reviews.noVerdict')}</span>`
        : `<span class="an-fig__v">${pct(rv.rate)}</span><span class="an-fig__s">${t('stats.reviews.firstPassSub', { a: rv.a, b: rv.b })}</span>`;
      const figs = `<dl class="an-figs"><div class="an-fig"><dt>${t('stats.reviews.firstPass')}</dt><dd>${first}</dd></div>
        <div class="an-fig"><dt>${t('stats.reviews.changes')}</dt><dd><span class="an-fig__v">${rv.changes}</span><span class="an-fig__s">${t('stats.reviews.changesSub')}</span></dd></div></dl>`;
      const lid = `${uid}-prs-h`;
      let list;
      if (!rv.prs.length) list = `<p class="an-state__h">${t('stats.reviews.noneMerged')}</p>`;
      else {
        const sorted = [...rv.prs].sort((a, b) => b.rounds - a.rounds); // then most recently merged: the mock is in merge order
        const shown = S.prMore ? sorted : sorted.slice(0, 5);
        const rows = shown.map((p, i) => {
          const strong = p.rounds > MAX_REWORK + 1;
          const chips = [p.qa ? `<span class="an-chip">${t('stats.reviews.qaChanges', { n: p.qa })}</span>` : '', p.rv ? `<span class="an-chip">${t('stats.reviews.reviewChanges', { n: p.rv })}</span>` : '',
            p.failed ? `<span class="an-chip an-chip--danger">${I.x}${t('stats.reviews.failed')}</span>` : '', p.up ? `<span class="an-chip an-chip--warn">${ICO.up}${t('stats.reviews.tierUp')}</span>` : ''].join('');
          const isNew = S.newFrom >= 0 && i >= S.newFrom;
          return `<li><div class="an-row an-row--pr${isNew ? ' is-new' : ''}" style="--i:${isNew ? i - S.newFrom : i}"><span class="an-row__num">#${p.n}</span><div class="an-row__main">
            <div class="an-row__head">${ghLink(`${REPO}/pull/${p.n}`, esc(p.title)).replace('<a ', `<a data-fk="pr-${p.n}" `)}<span class="an-rounds${strong ? ' is-strong' : ''}">${tally(p.rounds)}${t('stats.reviews.rounds', { n: p.rounds })}</span></div>
            ${chips ? `<div class="an-row__chips">${chips}</div>` : ''}</div></div></li>`;
        }).join('');
        const more = !S.prMore && sorted.length > 5 ? `<li class="an-more-li"><button type="button" class="an-more" data-act="more" data-fk="more">${t('stats.reviews.more', { n: sorted.length - 5 })}${I.down}</button></li>` : '';
        list = `<div class="an-card an-card--list"><ul class="an-list" aria-labelledby="${lid}">${rows}${more}</ul></div>`;
      }
      const body = `<div class="an-card">${figs}</div><h3 class="an-sub" id="${lid}">${t('stats.reviews.listTitle')}</h3>${list}`;
      return secHTML('reviews', t('stats.reviews.title'), period, body);
    }

    function sprintHTML(D) {
      const sp = D.sprint;
      if (!sp) return secHTML('sprint', t('stats.sprint.title'), '', stateHTML('nodata', I.clock, t('stats.sprint.noneTitle'), t('stats.sprint.noneHint')));
      const period = t('stats.sprint.period', { sprint: sp.name, start: d().start, demo: d().demo });
      if (sp.partial && !S.done.sprint) return secHTML('sprint', t('stats.sprint.title'), period, partialHTML('sprint', 'stats.partial.sprintTitle'));
      const open = sp.planned - sp.shipped; const p = sp.planned ? Math.round((sp.shipped / sp.planned) * 100) : 0;
      const meter = `<div class="an-meter" role="img" aria-label="${esc(t('stats.sprint.meterAria', { shipped: sp.shipped, planned: sp.planned, open }))}"><i class="an-meter__done" style="--p:${p}%"></i></div>
        <p class="an-legend" aria-hidden="true"><span><i class="an-sw an-sw--done"></i>${t('stats.sprint.shipped')} ${sp.shipped}</span><span><i class="an-sw an-sw--open"></i>${t('stats.sprint.open')} ${open}</span></p>`;
      const figs = `<dl class="an-figs an-figs--3 an-figs--sprint"><div class="an-fig"><dt>${t('stats.sprint.planned')}</dt><dd><span class="an-fig__v">${sp.planned}</span></dd></div>
        <div class="an-fig"><dt>${t('stats.sprint.shipped')}</dt><dd><span class="an-fig__v">${sp.shipped}</span></dd></div>
        <div class="an-fig"><dt>${t('stats.sprint.open')}</dt><dd><span class="an-fig__v">${open}</span><span class="an-fig__s">${t('stats.sprint.openHint')}</span></dd></div>
        <div class="an-fig an-fig--wide"><dt>${t('stats.sprint.cycle')}</dt><dd>${sp.cycle === null
          ? `<span class="an-fig__v nodata">${t('stats.noData')}</span><span class="an-fig__s">${t('stats.sprint.noCycle')}</span>`
          : `<span class="an-fig__v">${t('stats.sprint.cycleValue', { d: dec(sp.cycle), n: sp.cycle })}</span><span class="an-fig__s">${t('stats.sprint.cycleHint', { n: sp.cycleN })}</span>`}</dd></div></dl>`;
      const table = `<table class="an-table"><caption>${t('stats.sprint.byTier')}</caption><thead><tr><th scope="col">${t('stats.sprint.tierCol')}</th><th scope="col">${t('stats.sprint.plannedCol')}</th><th scope="col">${t('stats.sprint.shippedCol')}</th><th scope="col">${t('stats.sprint.raisedCol')}</th></tr></thead>
        <tbody>${sp.tiers.map(([k, a, b, r]) => `<tr><th scope="row">${k === 'unsized' ? `<span class="an-tier-none" aria-hidden="true"></span>${t('stats.sprint.unsized')}` : `${tierIco(k)}${t(`board.tier.${k}`)}`}</th><td>${a}</td><td>${b}</td><td>${r === null ? '—' : r}</td></tr>`).join('')}</tbody></table>`;
      return secHTML('sprint', t('stats.sprint.title'), period, `<div class="an-card">${meter}${figs}</div><div class="an-card">${table}</div>`);
    }

    function runsHTML(D) {
      const period = t('stats.runs.period', { date: d().since });
      const log = `<div class="an-foot">${ghLink(`${REPO}/issues/22`, t('board.runs.log'), 'ext')}</div>`;
      if (D.runs === 'nolog') return secHTML('runs', t('stats.runs.title'), period, stateHTML('nodata', I.clock, t('stats.runs.noLogTitle'), t('stats.runs.noLogHint'), '', ' nodata'));
      if (D.runs === 'unreadable') return secHTML('runs', t('stats.runs.title'), period, stateHTML('nodata', I.warn, t('stats.runs.unreadable'), t('board.runs.unavailableHint'), '', ' nodata') + log);
      const R = D.runs;
      const noMin = R.slots.filter((s) => s.minutes === null);
      const medianCell = (s) => (s.minutes === null ? `<span class="nodata">${t('stats.noData')}</span><sup class="an-fn" aria-hidden="true">*</sup>` : dur(s.minutes));
      let table;
      if (kind === 'mac') {
        table = `<table class="an-table"><caption class="sr-only">${t('stats.runs.caption')}</caption><thead><tr><th scope="col">${t('stats.runs.slotCol')}</th><th scope="col">${t('stats.runs.runsCol')}</th><th scope="col">${t('stats.runs.failedCol')}</th><th scope="col">${t('stats.runs.medianCol')}</th></tr></thead>
          <tbody>${R.slots.map((s) => `<tr><th scope="row">${slotName(s.key)}</th><td>${s.runs}</td><td>${s.failed ? `<span class="an-fail">${s.failed}</span>` : 0}</td><td>${medianCell(s)}</td></tr>`).join('')}</tbody></table>`;
      } else {
        table = `<ul class="an-list">${R.slots.map((s) => `<li><div class="an-slot"><b>${slotName(s.key)}</b><span class="an-slot__nums">${t('stats.runs.runs', { n: s.runs })} · ${s.failed ? `<span class="an-fail">${t('stats.runs.failed', { n: s.failed })}</span>` : t('stats.runs.failed', { n: 0 })} · ${t('stats.runs.medianOf', { v: '§' }).replace('§', medianCell(s))}</span></div></li>`).join('')}</ul>`;
      }
      const notes = [
        ...noMin.map((s) => `<p class="an-note"><span class="an-fn" aria-hidden="true">*</span>${esc(t('stats.runs.noMinutes', { slot: slotPlain(s.key) }))}</p>`),
        R.untrusted ? `<p class="an-note an-note--untrusted">${I.warn}<span>${t('stats.runs.untrusted', { n: R.untrusted })}</span></p>` : '',
      ].join('');
      const pause = D.team === 'paused' ? `<p class="an-note an-note--pause" role="note">${I.pause}<span>${t('stats.runs.paused', { date: d().pausedDay })}</span></p>` : '';
      const card = kind === 'mac' ? `<div class="an-card">${table}</div>` : `<div class="an-card an-card--list">${table}</div>`;
      return secHTML('runs', t('stats.runs.title'), period, `${pause}${card}${notes}${log}`);
    }

    function headHTML(D) {
      const team = D.team === 'paused'
        ? `<span class="status status--paused">${I.pause}${t('stats.pausedSince', { date: d().paused })}</span>`
        : `<span class="status${D.team === 'failing' ? ' status--failing' : ''}"><i></i>${t(`board.team.${D.team}`)}</span>`;
      const sprint = D.sprint ? `<span>${t('stats.meta', { sprint: D.sprint.name, demo: d().demo })}</span><span class="an-meta__sep" aria-hidden="true">·</span>` : '';
      const btn = `<button type="button" class="btn btn--quiet btn--sm" data-act="refresh" data-fk="refresh"${S.refreshing ? ' aria-disabled="true"' : ''}>${S.refreshing ? '<span class="ring" aria-hidden="true"></span>' : I.refresh}<span>${t(S.refreshing ? 'stats.refreshing' : 'stats.refresh')}</span></button>`;
      return `<header class="an-head"><h1 class="an-title" tabindex="-1">${t('stats.title')}</h1>
        <p class="an-meta">${sprint}${team}<span class="an-meta__sep an-meta__sep--when" aria-hidden="true">·</span><span class="an-meta__when"><span>${t('stats.asOf', { time: S.asOf })}</span>${btn}</span></p></header>`;
    }

    function skeletonHTML() {
      const tile = '<li class="an-skel-tile" aria-hidden="true"><span class="skel skel--t1"></span><span class="skel skel--t2"></span></li>';
      const block = (rows) => `<div class="an-skel-block" aria-hidden="true"><span class="skel skel--h"></span><span class="skel skel--p"></span><div class="an-skel-card">${'<span class="skel skel--r"></span>'.repeat(rows)}</div></div>`;
      return `<div class="an" aria-busy="true"><header class="an-head"><h1 class="an-title" tabindex="-1">${t('stats.title')}</h1><span class="skel skel--p" aria-hidden="true"></span></header>
        <ul class="an-tiles" aria-hidden="true">${tile.repeat(4)}</ul>
        ${kind === 'mac' ? `<div class="an-cols"><div class="an-col">${block(3)}${block(2)}</div><div class="an-col">${block(2)}${block(3)}</div></div>` : block(3)}</div>`;
    }

    function wholeHTML(load) {
      const btn = `<button type="button" class="btn" data-act="retry" data-fk="retry">${I.refresh}${t('ui.error.retry')}</button>`;
      const st = {
        error: ['error', I.bang, t('stats.error.unavailable.title'), t('stats.error.unavailable.hint'), btn],
        offline: ['offline', I.wifi, t('stats.error.offline.title'), t('stats.error.offline.hint'), btn],
        rate: ['wait', I.clock, t('stats.error.rate.title'), t('stats.error.rate.hint', { time: '14:08' }), ''],
        notinstalled: ['setup', I.key, t('board.error.not-installed.title'), t('board.error.not-installed.hint'), btn],
      }[load];
      return `<div class="an"><header class="an-head"><h1 class="an-title" tabindex="-1">${t('stats.title')}</h1></header>
        <div class="an-state an-state--big an-state--${st[0]} is-new" role="alert">${st[1]}<p class="an-state__t">${st[2]}</p><p class="an-state__h">${st[3]}</p>${st[4] ? `<div class="an-state__act">${st[4]}</div>` : ''}</div></div>`;
    }

    function contentHTML() {
      if (S.load === 'loading') return skeletonHTML();
      if (S.load !== 'loaded') return wholeHTML(S.load);
      const D = dataOf(G.data);
      const banner = S.refreshFailed ? `<p class="an-banner" role="status">${I.warn}<span>${t('stats.refreshFailed', { time: S.asOf })}</span></p>` : '';
      return `<div class="an${S.inking ? ' is-inking' : ''}">${headHTML(D)}${banner}${tilesHTML(D)}
        <div class="an-cols"><div class="an-col">${stuckHTML(D)}${reviewsHTML(D)}</div><div class="an-col">${sprintHTML(D)}${runsHTML(D)}</div></div></div>`;
    }

    const navItems = [['inbox', 'questions'], ['board', 'board'], ['chart', 'stats'], ['stack', 'artifacts'], ['play', 'demo']];
    const icon = (k) => ICO[k] || I[k];
    const cmd = `<button type="button" class="btn ${kind === 'phone' ? 'btn--sm' : ''}" aria-label="${esc(t('space.commandsAria', { name: 'team-console' }))}" aria-haspopup="dialog"${kind === 'mac' ? ' aria-keyshortcuts="K"' : ''}>${I.sliders}<span>${t('space.commands')}</span>${kind === 'mac' ? '<kbd aria-hidden="true">K</kbd>' : ''}</button>`;
    const live = '<p class="sr-only" role="status" aria-live="polite" data-live></p>';
    if (kind === 'phone') {
      host.innerHTML = `<div class="p-status" aria-hidden="true"><span>9:41</span><span class="p-island"></span><span class="p-status__icons">${I.bars}${I.battery}</span></div>
        <header class="p-head bd-top an-top"><button type="button" class="bd-proj" aria-label="${esc(t('nav.switch', { name: 'team-console' }))}" aria-haspopup="dialog">team-console${I.down}</button>${cmd}<button type="button" class="bd-icon" aria-label="${esc(t('nav.settings'))}">${I.gear}</button></header>
        <div class="bd-scroll" data-slot="content"></div>${live}
        <nav class="tabs bd-tabs" aria-label="${esc(t('nav.sections'))}">${navItems.map(([ico, key]) => `<button type="button"${key === 'stats' ? ' aria-current="page"' : ''}>${icon(ico)}<span>${t(`nav.${key}`)}</span></button>`).join('')}</nav>
        <div class="home-ind" aria-hidden="true"></div>`;
    } else {
      host.innerHTML = `<div class="win"><div class="win__bar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="win__title">Team Console</span></div>
        <div class="win__body">
          <nav class="sidebar" aria-label="${esc(t('nav.projects'))}"><div class="brand">${I.mark}<span>${t('nav.app')}</span></div>
            <ul class="side-list side-list--top"><li><button type="button" class="side-item">${I.inbox}<span>${t('nav.waiting')}</span><span class="count">9</span></button></li><li><button type="button" class="side-item">${I.grid}<span>${t('nav.all')}</span></button></li></ul>
            <div class="side-label">${t('nav.projects')}</div>
            <ul class="side-list">${['ghost', 'storify', 'team-console'].map((p) => `<li><button type="button" class="side-item"${p === 'team-console' ? ' aria-current="true"' : ''}><span class="side-prod__label">${p}</span></button></li>`).join('')}</ul></nav>
          <section class="convo bd-mac" aria-label="team-console"><header class="convo__head"><div class="convo__title"><span class="bd-mac__name">team-console</span></div>
            <nav class="bd-seg" aria-label="${esc(t('nav.sections'))}">${navItems.map(([ico, key]) => `<button type="button"${key === 'stats' ? ' aria-current="page"' : ''}>${icon(ico)}<span>${t(`nav.${key}`)}</span></button>`).join('')}</nav>${cmd}</header>
            <div class="bd-scroll" data-slot="content"></div>${live}</section>
        </div></div>`;
    }
    const scroller = host.querySelector('[data-slot=content]');
    const say = async (msg) => { const r = host.querySelector('[data-live]'); r.textContent = ''; await wait(60); r.textContent = Proto.plain(msg); };

    function render(focusKey) {
      const top = scroller.scrollTop;
      scroller.innerHTML = contentHTML();
      scroller.scrollTop = top;
      S.inking = false; S.newFrom = -1;
      if (focusKey) scroller.querySelector(`[data-fk="${focusKey}"]`)?.focus({ preventScroll: true });
    }
    host.renderStats = render;

    // A tile, or a #fragment once loaded: scroll the block under the top, ring it once (the kit's markArrival), focus its heading.
    function jump(key) {
      const sec = scroller.querySelector(`#${uid}-${key}`); if (!sec) return;
      scroller.querySelectorAll('.tc-arrival').forEach((x) => x.classList.remove('tc-arrival'));
      let y = 0; for (let el = sec; el && el !== scroller; el = el.offsetParent) y += el.offsetTop;
      scroller.scrollTo({ top: Math.max(0, y - 16), behavior: isReduced() ? 'auto' : 'smooth' });
      sec.classList.add('tc-arrival');
      sec.querySelector('.an-sec__title').focus({ preventScroll: true });
      const off = (e) => { if (!sec.contains(e.relatedTarget)) { sec.classList.remove('tc-arrival'); sec.removeEventListener('focusout', off); } };
      sec.addEventListener('focusout', off);
    }
    host.jump = jump;

    async function load(after) {
      S.load = 'loading'; render(); say(t('stats.loading'));
      await wait(900);
      S.load = 'loaded'; S.inking = true; S.asOf = '14:05'; render(); say(t('stats.loaded'));
      if (after) after(); else scroller.querySelector('.an-title')?.focus({ preventScroll: true });
    }
    host.loadStats = load;

    host.onclick = async (e) => {
      const jumpTo = e.target.closest('[data-jump]');
      if (jumpTo) { e.preventDefault(); jump(jumpTo.dataset.jump); return; }
      if (e.target.closest('a[data-act=gh]')) { e.preventDefault(); return; }
      const b = e.target.closest('button[data-act]'); if (!b || b.getAttribute('aria-disabled') === 'true') return;
      const act = b.dataset.act;
      if (act === 'reason') { const n = Number(b.dataset.n); if (S.open.has(n)) S.open.delete(n); else S.open.add(n); render(b.dataset.fk); }
      if (act === 'more') {
        S.prMore = true; S.newFrom = 5; render();
        const first = [...dataOf(G.data).reviews.prs].sort((a, c) => c.rounds - a.rounds)[5];
        scroller.querySelector(`[data-fk="pr-${first.n}"]`)?.focus();
      }
      if (act === 'refresh') {
        S.refreshing = true; render('refresh');
        await wait(1200);
        S.refreshing = false;
        if (G.refreshFails) { S.refreshFailed = true; render('refresh'); say(t('stats.refreshFailed', { time: S.asOf })); }
        else { S.refreshFailed = false; S.asOf = '14:07'; render('refresh'); say(t('stats.refreshed')); }
      }
      if (act === 'retry') load();
      if (act === 'again') {
        const block = b.dataset.block; S.again[block] = true; render(b.dataset.fk);
        await wait(1000);
        S.again[block] = false; S.done[block] = true; S.inking = true; render();
        scroller.querySelector(`#${uid}-${block}-h`)?.focus({ preventScroll: true });
        say(t('stats.refreshed'));
      }
    };
    render();
  }

  /* ---------- page controls ---------- */
  const mountAll = () => hosts.forEach((h) => { h.className = 'app'; mountApp(h, h.dataset.app); });
  const pageChrome = Proto.page({ L, title: 'Team Console · #109', onLang: mountAll });
  const sel = (id) => document.getElementById(id);
  const syncDemo = () => { sel('d-load').value = G.load; sel('d-data').value = G.data; sel('d-fail').checked = G.refreshFails; };
  sel('d-load').addEventListener('change', (e) => { G.load = e.target.value; mountAll(); });
  sel('d-data').addEventListener('change', (e) => { G.data = e.target.value; G.load = 'loaded'; syncDemo(); mountAll(); });
  sel('d-fail').addEventListener('change', (e) => { G.refreshFails = e.target.checked; });
  sel('d-deep').addEventListener('click', () => { G.load = 'loaded'; syncDemo(); hosts.forEach((h) => h.loadStats(() => h.jump('runs'))); });
  addEventListener('online', () => hosts.forEach((h) => { if (h.S && h.S.load === 'offline') h.loadStats(); }));
  document.querySelector('[data-reset]').addEventListener('click', () => { G.load = 'loaded'; G.data = 'typical'; G.refreshFails = false; syncDemo(); mountAll(); });
  mountAll();
  syncDemo();
  pageChrome.fit();
})();
