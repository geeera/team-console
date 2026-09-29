/* Team Console prototype runtime, shared by all directions. DIR (declared above) supplies the character. */
(() => {
  'use strict';
  const root = document.documentElement;
  const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
  const isReduced = () => root.dataset.motion === 'reduce' || mqReduce.matches;
  const cssVar = (n) => getComputedStyle(root).getPropertyValue(n).trim();
  const ms = (n) => { const v = cssVar(n); const x = parseFloat(v) || 0; return v.endsWith('ms') ? x : v.endsWith('s') ? x * 1000 : x; };
  const wait = (t) => new Promise((r) => setTimeout(r, t));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const clock = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const nodeFrom = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

  async function play(el, frames, opts) {
    if (!el || !el.animate) return;
    try { await el.animate(frames, opts).finished; }
    catch (err) { if (!err || err.name !== 'AbortError') throw err; } // a newer animation cancelled this one: expected
  }
  const H = { play, wait, ms, cssVar, isReduced };

  const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const I = {
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    x: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
    minus: svg('<path d="M6 12h12"/>'),
    warn: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.3v.2"/>'),
    chat: svg('<path d="M4.5 5.5h15v10h-9l-6 4z"/>'),
    inbox: svg('<path d="M4 13.5L6.5 5h11l2.5 8.5V19H4z"/><path d="M4 13.5h5l1 2h4l1-2h5"/>'),
    board: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15M15 4.5v15"/>'),
    grid: svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
    stack: svg('<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4M4 16l8 4 8-4"/>'),
    image: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-8 8.5"/>'),
    send: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
    chev: svg('<path d="M9.5 6l6 6-6 6"/>'),
    down: svg('<path d="M6 9.5l6 6 6-6"/>'),
    pause: svg('<path d="M9 5.5v13M15 5.5v13"/>'),
    play: svg('<path d="M8 5.5l11 6.5-11 6.5z"/>'),
    key: svg('<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l3 3"/>'),
    branch: svg('<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7.5v9M18 10c0 4-6 3-11.5 7"/>'),
    flag: svg('<path d="M5.5 21V4M5.5 4.5h11l-2 4 2 4h-11"/>'),
    cal: svg('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
    edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
    search: svg('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
    spark: svg('<path d="M12 3.5l1.8 6.7 6.7 1.8-6.7 1.8L12 20.5l-1.8-6.7L3.5 12l6.7-1.8z"/>'),
    doc: svg('<path d="M6.5 3.5h8l4 4v13h-12z"/><path d="M14.5 3.5v4h4M9 12h6M9 16h6"/>'),
    rocket: svg('<path d="M12 3c3.5 2 5 5.5 4.5 10l-2 3h-5l-2-3C7 8.5 8.5 5 12 3z"/><path d="M9.5 16l-2 4M14.5 16l2 4"/><circle cx="12" cy="9.5" r="1.5"/>'),
    shield: svg('<path d="M12 3.5l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9v-5z"/>'),
    link: svg('<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>'),
    pin: svg('<path d="M9 4h6l-1 5 3 3H7l3-3zM12 12v8"/>'),
    mark: '<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="6" fill="currentColor"/><path d="M7.5 9.5h9M7.5 14.5h5.5" stroke="var(--accent-contrast)" stroke-width="2.2" stroke-linecap="round"/></svg>',
    bars: '<svg viewBox="0 0 18 12" width="18" height="12" aria-hidden="true"><rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor"/><rect x="5" y="5" width="3" height="7" rx="1" fill="currentColor"/><rect x="10" y="2.5" width="3" height="9.5" rx="1" fill="currentColor"/><rect x="15" y="0" width="3" height="12" rx="1" fill="currentColor"/></svg>',
    battery: '<svg viewBox="0 0 27 13" width="27" height="13" aria-hidden="true"><rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="18" height="9" rx="2" fill="currentColor"/><rect x="24.5" y="4.5" width="2" height="4" rx="1" fill="currentColor" opacity=".4"/></svg>',
  };
  const TYPE_ICON = { design: 'image', demo: 'rocket', adr: 'doc', audit: 'shield', brief: 'chat', release: 'flag', deploy: 'link' };
  const STATUS_LABEL = { running: 'Running', paused: 'Paused', failing: 'Failing' };

  /* ---------- markup ---------- */
  const tier = (t) => `<span class="tier tier--${t}">${t}</span>`;
  const statusChip = (p) => `<span class="status status--${p.status}"><i aria-hidden="true"></i>${STATUS_LABEL[p.status]}</span>`;
  const mono = (p) => `<span class="prod-mono" data-status="${p.status}" aria-hidden="true">${esc(p.name[0])}</span>`;

  function thumbHTML(big) {
    const frame = (mod, cap) => `<span class="tf tf--${mod}"><span class="tf__bar"></span><span class="tf__center"><span class="tf__icon"></span><span class="tf__line"></span><span class="tf__line tf__line--s"></span><span class="tf__btn"></span></span><span class="tf__cap">${cap}</span></span>`;
    return `<button type="button" class="thumb${big ? ' thumb--big' : ''}" data-act="thumb" aria-label="Open the design prototype: story editor states">${frame('empty', 'Empty')}${frame('dark', 'Offline · dark')}${frame('error', 'Error')}</button>`;
  }

  function cardHTML(c, uid) {
    const tid = `${uid}-t-${c.id}`;
    let body = '';
    if (c.rec) body += `<div class="rec"><span class="rec__label">Team recommends</span><strong class="rec__choice">${esc(c.rec.choice)}</strong><p>${esc(c.rec.why)}</p></div>`;
    if (c.text) body += `<p class="card__text">${esc(c.text)}</p>`;
    if (c.thumb) body += thumbHTML(false);
    if (c.steps) body += `<ol class="steps">${c.steps.map((s) => `<li>${s}</li>`).join('')}</ol>`;
    if (c.checks) body += `<ul class="checks">${c.checks.map((k) => `<li class="check check--${k.s}">${I[k.s === 'ok' ? 'check' : 'warn']}<span>${esc(k.t)}</span></li>`).join('')}</ul>`;
    const actions = c.actions.map((a) => `<button type="button" class="btn${a.primary ? ' btn--primary' : ''}" data-act="resolve" data-card="${c.id}" data-choice="${a.id}" aria-keyshortcuts="${a.key}">${esc(a.label)}<kbd>${a.key.toUpperCase()}</kbd></button>`).join('');
    return `<article class="card card--${c.kind}" data-card-id="${c.id}" tabindex="0" aria-labelledby="${tid}">
      <header class="card__head"><span class="card__kind">${I[c.icon]}${esc(c.label)}</span><span class="card__num">#${c.id}</span></header>
      <h3 class="card__title" id="${tid}">${esc(c.title)}</h3>${body}
      <footer class="card__foot"><div class="card__actions">${actions}</div><span class="card__meta">${esc(c.meta)}</span></footer>
    </article>`;
  }

  const receiptHTML = (r) => `<div class="receipt receipt--${r.tone}" data-receipt-id="${r.id}" tabindex="-1">
      <span class="receipt__icon">${r.tone === 'negative' ? I.x : r.tone === 'neutral' ? I.minus : I.check}</span>
      <span class="receipt__body"><span class="receipt__verb">You: ${esc(r.verb)}</span> <span class="receipt__detail">${esc(r.detail)}</span></span>
      <span class="receipt__meta">#${r.id} · ${r.time} · recorded as owner</span>
    </div>`;

  function itemHTML(it, uid) {
    switch (it.t) {
      case 'day': return `<div class="day"><span>${esc(it.text)}</span></div>`;
      case 'note': return `<div class="sysnote"><i aria-hidden="true"></i><span>${it.html}</span></div>`;
      case 'card': return cardHTML(it, uid);
      case 'receipt': return receiptHTML(it);
      case 'typing': return `<div class="msg msg--pm is-typing"><span class="avatar avatar--pm" aria-hidden="true">PM</span><div class="typing"><i></i><i></i><i></i><span class="sr-only">PM is typing</span></div></div>`;
      case 'msg':
        return it.who === 'pm'
          ? `<div class="msg msg--pm"><span class="avatar avatar--pm" aria-hidden="true">PM</span><div class="msg__body"><div class="msg__meta"><b>PM</b><time>${it.time}</time></div><div class="bubble">${it.html}</div></div></div>`
          : `<div class="msg msg--owner"><div class="msg__body"><div class="bubble">${it.html}</div><div class="msg__meta"><span class="sr-only">You,</span><time>${it.time}</time></div></div></div>`;
      default: return '';
    }
  }

  function boardHTML(p, S) {
    const cols = DATA.boards[p.id];
    const pct = Math.round((p.done / p.total) * 100);
    const head = `<div class="board__head"><div><div class="board__kicker">${esc(p.name)} · ${statusChip(p)}</div><h3>${esc(p.sprint)}</h3></div>
      ${p.status === 'paused' ? '' : `<span class="demo-pill">${I.cal}Demo ${esc(p.demo)}${p.demoIn ? ` · ${p.demoIn}` : ''}</span>`}</div>`;
    const metrics = `<div class="progress" role="img" aria-label="${p.done} of ${p.total} done"><i style="--p:${pct}%"></i></div>
      <dl class="metrics"><div><dt>Done</dt><dd>${p.done}/${p.total}</dd></div><div><dt>Open PRs</dt><dd>${p.prs}</dd></div>
      <div><dt>CI · main</dt><dd class="${p.ci === 'red' ? 'bad' : 'ok'}">${p.ci}</dd></div><div><dt>Run log</dt><dd class="${p.status === 'failing' ? 'bad' : p.status === 'paused' ? '' : 'ok'}">${esc(p.run)}</dd></div></dl>`;
    let body;
    if (p.status === 'paused') {
      body = `<div class="board__empty">${I.pause}<p><b>${esc(p.name)} is paused${p.pausedSince ? ` since ${esc(p.pausedSince)}` : ''}.</b> The team does not run; questions wait. ${esc(p.sprint)} closed ${p.done} of ${p.total}.</p></div>`;
    } else if (cols) {
      body = `<div class="cols">${Object.entries(cols).map(([name, items]) => `<section class="col" aria-label="${name}"><h4>${name}<span>${items.length}</span></h4><ul>${items.map((i) => `<li class="item"><span class="item__num">#${i.n}</span><span class="item__title">${esc(i.t)}${i.sub ? `<small>${esc(i.sub)}</small>` : ''}</span>${tier(i.tier)}</li>`).join('')}</ul></section>`).join('')}</div>`;
    } else {
      body = `<div class="board__empty">${I.board}<p>${esc(p.sprint)}: ${p.done} of ${p.total} done, nothing needs you. Columns load from GitHub in the real app.</p></div>`;
    }
    const all = S.products;
    const counts = ['running', 'paused', 'failing'].map((s) => `${all.filter((x) => x.status === s).length} ${s}`).join(' · ');
    const foot = `<div class="board__foot"><button type="button" class="btn btn--quiet" data-act="pause">${p.status === 'paused' ? I.play + 'Resume ' : I.pause + 'Pause '}${esc(p.name)}</button><span>All projects: ${counts}</span></div>`;
    return `<div class="board">${head}${metrics}${body}${foot}</div>`;
  }

  function artifactGroupsHTML(p, st, S) {
    const q = (st.artQ || '').trim().toLowerCase();
    const list = DATA.artifacts[p.id] || [];
    const hits = list.filter((a) => (st.artType === 'all' || a.type === st.artType) && (!q || `${a.title} ${a.meta}`.toLowerCase().includes(q)));
    if (!hits.length) return `<p class="empty">Nothing matches “${esc(st.artQ || '')}” in ${esc(p.name)}.</p>`;
    return DATA.artifactTypes.map(([type, label]) => {
      const items = hits.filter((a) => a.type === type);
      if (!items.length) return '';
      return `<section class="art-group"><h4>${label}<span>${items.length}</span></h4><ul>${items.map((a) => {
        const open = a.awaiting && S.logs[p.id].some((i) => i.t === 'card' && i.id === a.awaiting);
        return `<li class="art${open ? ' art--awaiting' : ''}"><span class="art__icon">${I[TYPE_ICON[a.type]]}</span><span class="art__title">${esc(a.title)}<small>${esc(a.meta)}</small></span>${open ? `<button type="button" class="btn btn--primary btn--sm" data-act="goto" data-pid="${p.id}" data-card="${a.awaiting}">Review</button>` : I.chev}</li>${open ? `<li class="art__thumb">${thumbHTML(true)}</li>` : ''}`;
      }).join('')}</ul></section>`;
    }).join('');
  }

  function artifactsHTML(p, st, S, uid) {
    const types = [['all', 'All']].concat(DATA.artifactTypes.map(([t, l]) => [t, l.split(' ')[0].replace(/s$/, 's')]));
    return `<div class="arts">
      <label class="search">${I.search}<span class="sr-only">Search artifacts in ${esc(p.name)}</span><input type="search" id="${uid}-artq" data-art-q placeholder="Search ${esc(p.name)} artifacts" value="${esc(st.artQ || '')}" autocomplete="off"></label>
      <div class="chips" role="group" aria-label="Artifact type">${types.map(([t, l]) => `<button type="button" class="chip-btn" data-act="art-type" data-type="${t}" aria-pressed="${st.artType === t}">${l}</button>`).join('')}</div>
      <div data-art-groups>${artifactGroupsHTML(p, st, S)}</div></div>`;
  }

  /* ---------- app instance ---------- */
  let uidSeq = 0;
  function mountApp(host, mode) {
    const uid = `a${++uidSeq}`;
    const S = {
      mode, view: 'space', product: 'storify', products: clone(DATA.projects), logs: clone(DATA.logs),
      spaces: {}, sheet: null, moreOpen: false, filter: '', busy: new Set(),
    };
    const space = (pid) => (S.spaces[pid] ||= { scroll: null, pane: DIR.boardOpenByDefault && mode === 'mac' ? 'board' : null, draft: '', artQ: '', artType: 'all' });
    const product = (pid = S.product) => S.products.find((p) => p.id === pid);
    const openCards = (pid) => S.logs[pid].filter((i) => i.t === 'card');
    const allNeeds = () => S.products.flatMap((p) => openCards(p.id).map((c) => ({ p, c })))
      .sort((a, b) => (b.p.status === 'failing') - (a.p.status === 'failing'));
    host.innerHTML = mode === 'mac' ? macShell(uid) : phoneShell(uid);
    const slot = (n) => host.querySelector(`[data-slot="${n}"]`);
    let lastFocus = null;

    function productRow(p, rich) {
      const pct = Math.round((p.done / p.total) * 100);
      const sub = p.status === 'paused' ? `Paused${p.pausedSince ? ` since ${p.pausedSince}` : ''}` : p.status === 'failing' ? `${p.run} · demo ${p.demo}` : `${p.sprint} · demo ${p.demo}`;
      const current = S.view === 'space' && p.id === S.product;
      return `<li><button type="button" class="side-item side-prod${rich ? ' side-prod--rich' : ''}" data-act="product" data-id="${p.id}"${current ? ' aria-current="true"' : ''}>
        ${mono(p)}<span class="side-prod__name"><span class="side-prod__label">${esc(p.name)}${p.status !== 'running' ? `<i class="sdot sdot--${p.status}" aria-label="${STATUS_LABEL[p.status]}"></i>` : ''}</span><small>${esc(sub)}</small><span class="meter" aria-hidden="true"><i style="--p:${pct}%"></i></span></span>
        <span class="count" data-count-for="${p.id}" hidden></span></button></li>`;
    }

    function projectListHTML(rich) {
      const f = S.filter.trim().toLowerCase();
      const match = (p) => !f || p.name.includes(f);
      const pinned = S.products.filter((p) => p.pinned && match(p));
      const rest = S.products.filter((p) => !p.pinned && !p.quiet && match(p));
      const quiet = S.products.filter((p) => p.quiet && match(p));
      const moreOpen = S.moreOpen || !!f;
      let h = '';
      if (pinned.length) h += `<div class="side-label">${I.pin}Pinned</div><ul class="side-list">${pinned.map((p) => productRow(p, rich)).join('')}</ul>`;
      if (rest.length || quiet.length) {
        h += `<div class="side-label">Projects</div><ul class="side-list">${rest.map((p) => productRow(p, rich)).join('')}</ul>`;
        if (quiet.length) {
          h += `<button type="button" class="side-more" data-act="more" aria-expanded="${moreOpen}" aria-controls="${uid}-more-${rich ? 'r' : 's'}">${I.down}<span>${moreOpen ? 'Quiet projects' : `${quiet.length} more, nothing needs you`}</span></button>
            <ul class="side-list" id="${uid}-more-${rich ? 'r' : 's'}"${moreOpen ? '' : ' hidden'}>${quiet.map((p) => productRow(p, rich)).join('')}</ul>`;
        }
      }
      if (!h) h = `<p class="empty">No project matches “${esc(S.filter)}”.</p>`;
      return h;
    }

    function needsHTML() {
      const needs = allNeeds();
      const projCount = new Set(needs.map((n) => n.p.id)).size;
      if (!needs.length) return `<div class="needs"><div class="empty empty--big">${I.check}<p><b>Nothing needs you.</b> The teams are working; you will get a push when that changes.</p></div></div>`;
      return `<div class="needs"><p class="needs__lead">${needs.length} across ${projCount} project${projCount > 1 ? 's' : ''}. Each opens in its own conversation.</p>
        <ul class="needs__list">${needs.map(({ p, c }) => `<li><button type="button" class="need" data-act="goto" data-pid="${p.id}" data-card="${c.id}">
          <span class="need__top"><span class="ptag">${mono(p)}${esc(p.name)}</span><span class="need__kind">${esc(c.label)}</span></span>
          <span class="need__title">#${c.id} ${esc(c.title)}</span>
          ${c.rec ? `<span class="need__rec">Team recommends: ${esc(c.rec.choice)}</span>` : `<span class="need__rec">${esc(c.meta)}</span>`}
          ${I.chev}</button></li>`).join('')}</ul></div>`;
    }

    function overviewHTML() {
      const main = S.products.filter((p) => !p.quiet);
      const quiet = S.products.filter((p) => p.quiet);
      const tile = (p) => {
        const n = openCards(p.id).length; const pct = Math.round((p.done / p.total) * 100);
        return `<li><button type="button" class="ov" data-act="product" data-id="${p.id}">
          <span class="ov__top">${mono(p)}<b>${esc(p.name)}</b>${statusChip(p)}</span>
          <span class="ov__line">${esc(p.sprint)} · ${p.status === 'paused' ? 'no demo' : `demo ${esc(p.demo)}`}</span>
          <span class="meter meter--wide" aria-hidden="true"><i style="--p:${pct}%"></i></span>
          <span class="ov__foot"><span>${p.done}/${p.total} done · ${p.prs} PRs · CI ${p.ci}</span>${n ? `<span class="count">${n}</span>` : ''}</span></button></li>`;
      };
      return `<div class="overview"><ul class="ov-grid">${main.map(tile).join('')}</ul>
        <h4 class="ov-h">Quiet projects <span>${quiet.length}</span></h4><ul class="ov-grid ov-grid--quiet">${quiet.map(tile).join('')}</ul></div>`;
    }

    /* ----- render ----- */
    function renderChrome() {
      const p = product();
      if (mode === 'mac') {
        slot('projects').innerHTML = projectListHTML(false);
        host.querySelectorAll('[data-act="view"]').forEach((b) => b.setAttribute('aria-current', String(S.view === b.dataset.view)));
        slot('wintitle').textContent = S.view === 'space' ? `${p.name} · Team Console` : S.view === 'needs' ? 'Needs you · Team Console' : 'All projects · Team Console';
        slot('convohead').innerHTML = S.view === 'space'
          ? `<div class="convo__title">${mono(p)}<h2>${esc(p.name)}</h2>${statusChip(p)}<span class="convo__sub">${esc(p.sprint)}${p.status === 'paused' ? '' : ` · demo ${esc(p.demo)}`}</span></div>
             <button type="button" class="btn btn--quiet" data-act="pane" data-tab="board" aria-label="Board" aria-expanded="${space(p.id).pane === 'board'}">${I.board}<span class="lbl">Board</span><kbd>B</kbd></button>
             <button type="button" class="btn btn--quiet" data-act="pane" data-tab="artifacts" aria-label="Artifacts" aria-expanded="${space(p.id).pane === 'artifacts'}">${I.stack}<span class="lbl">Artifacts</span><kbd>F</kbd></button>`
          : `<div class="convo__title"><h2>${S.view === 'needs' ? 'Needs you' : 'All projects'}</h2><span class="convo__sub">${S.view === 'needs' ? 'across every project' : `${S.products.length} projects`}</span></div>`;
      } else {
        const inSpace = S.view === 'space';
        slot('phead').innerHTML = `<button type="button" class="p-switch" data-act="sheet" data-sheet="projects" aria-haspopup="dialog">${inSpace ? mono(p) : `<span class="prod-mono prod-mono--all" aria-hidden="true">${I.inbox}</span>`}
          <span class="p-switch__txt"><b>${inSpace ? esc(p.name) : 'Needs you'}</b><small>${inSpace ? `${STATUS_LABEL[p.status]} · ${esc(p.sprint)}${p.status === 'paused' ? '' : ` · demo ${esc(p.demo)}`}` : 'across every project'}</small></span>${I.down}</button>
          <button type="button" class="icon-btn" data-act="sheet" data-sheet="projects" aria-label="All projects">${I.grid}</button>`;
        slot('strip').innerHTML = inSpace ? `<button type="button" class="p-strip" data-act="tab" data-tab="board"><span>${esc(p.sprint)}</span><span class="meter" aria-hidden="true"><i style="--p:${Math.round((p.done / p.total) * 100)}%"></i></span><span>${p.done}/${p.total}</span><span class="sdot sdot--${p.ci === 'red' ? 'failing' : 'running'}" aria-hidden="true"></span><span>CI ${p.ci}</span><span>${p.prs} PRs</span>${I.chev}</button>` : '';
        host.querySelectorAll('.tabs [data-tab]').forEach((b) => {
          const t = b.dataset.tab;
          const on = S.sheet ? S.sheet === t : (t === 'needs' ? S.view === 'needs' : t === 'chat' && S.view === 'space');
          if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
        });
      }
      slot('banner').innerHTML = S.view === 'space' && p.status === 'paused'
        ? `<div class="banner-wrap"><div class="paused">${I.pause}<span><b>${esc(p.name)} is paused.</b> The team does not run; your messages wait.</span><button type="button" class="btn btn--sm" data-act="pause">Resume</button></div></div>`
        : S.view === 'space' && p.status === 'failing'
          ? `<div class="banner-wrap"><div class="paused paused--bad">${I.warn}<span><b>Nightly run failing.</b> ${esc(p.run)}; see #31.</span></div></div>` : '';
      host.classList.toggle('is-space', S.view === 'space');
    }

    function renderMain() {
      const log = slot('log');
      if (S.view === 'space') {
        log.setAttribute('role', 'log');
        log.setAttribute('aria-label', `Conversation with the ${product().name} PM`);
        log.innerHTML = `<div class="log__inner">${S.logs[S.product].map((i) => itemHTML(i, uid)).join('')}</div>`;
      } else {
        log.removeAttribute('role');
        log.setAttribute('aria-label', S.view === 'needs' ? 'Needs you' : 'All projects');
        log.innerHTML = `<div class="log__inner log__inner--view">${S.view === 'needs' ? needsHTML() : overviewHTML()}</div>`;
      }
      const ta = host.querySelector('.composer textarea');
      ta.value = S.view === 'space' ? space(S.product).draft : '';
      ta.placeholder = `Message the ${product().name} PM`;
      const st = S.view === 'space' ? space(S.product).scroll : null;
      log.scrollTop = S.view !== 'space' ? 0 : st == null ? log.scrollHeight : st;
    }

    function renderPane() {
      if (mode !== 'mac') return;
      const pane = slot('pane');
      const st = space(S.product);
      const tab = S.view === 'space' ? st.pane : null;
      pane.classList.toggle('is-open', !!tab);
      pane.inert = !tab;
      host.querySelectorAll('[data-act="pane"]').forEach((b) => b.setAttribute('aria-expanded', String(tab === b.dataset.tab)));
      host.querySelectorAll('[data-act="pane-tab"]').forEach((b) => b.setAttribute('aria-selected', String(tab === b.dataset.tab)));
      if (!tab) return;
      slot('panebody').innerHTML = tab === 'board' ? boardHTML(product(), S) : artifactsHTML(product(), st, S, uid);
    }

    function renderAll() { renderChrome(); renderMain(); renderPane(); updateCounts(); if (S.sheet) fillSheet(S.sheet); }

    /* ----- counts ----- */
    function setCount(b, v) {
      const old = b.dataset.n == null ? -1 : Number(b.dataset.n);
      if (old === v) return;
      b.dataset.n = String(v);
      b.hidden = v === 0;
      b.setAttribute('aria-label', `${v} need${v === 1 ? 's' : ''} you`);
      if (!DIR.rollCounts || old < 0 || isReduced() || v === 0) { b.textContent = String(v); return; }
      const out = document.createElement('span'); out.textContent = String(old);
      const inn = document.createElement('span'); inn.textContent = String(v);
      b.replaceChildren(out, inn);
      const d = ms('--dur-base'); const e = cssVar('--ease-standard');
      play(out, [{ transform: 'translateY(0)' }, { transform: 'translateY(-110%)' }], { duration: d, easing: e, fill: 'forwards' });
      play(inn, [{ transform: 'translateY(110%)' }, { transform: 'translateY(0)' }], { duration: d, easing: e }).then(() => { b.textContent = String(v); });
    }
    function updateCounts() {
      host.querySelectorAll('[data-count-for]').forEach((b) => {
        const f = b.dataset.countFor;
        const v = f === 'all' ? allNeeds().length : openCards(f === 'cur' ? S.product : f).length;
        setCount(b, v);
      });
    }

    /* ----- navigation ----- */
    function saveSpace() {
      if (S.view !== 'space') return;
      const st = space(S.product);
      const log = slot('log');
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
      st.scroll = atBottom ? null : log.scrollTop;
      st.draft = host.querySelector('.composer textarea').value;
    }
    async function crossfade(fn) {
      const log = slot('log');
      if (!isReduced()) await play(log, [{ opacity: 1 }, { opacity: 0 }], { duration: ms('--dur-fast'), easing: 'linear' });
      fn();
      play(log, [{ opacity: 0 }, { opacity: 1 }], { duration: isReduced() ? 1 : ms('--dur-base'), easing: 'linear' });
    }
    function openSpace(pid) {
      if (S.view === 'space' && S.product === pid) { closeSheet(); return; }
      saveSpace();
      const returning = S.spaces[pid] && S.spaces[pid].scroll != null;
      closeSheet(true);
      crossfade(() => { S.view = 'space'; S.product = pid; renderAll(); });
      if (returning) toast(`Back where you left ${product(pid).name}`);
    }
    function openView(view) {
      if (S.view === view) return;
      saveSpace();
      closeSheet(true);
      crossfade(() => { S.view = view; renderAll(); });
    }
    async function goto(pid, id) {
      if (S.view !== 'space' || S.product !== pid) {
        saveSpace();
        closeSheet(true);
        S.view = 'space'; S.product = pid; renderAll();
      } else closeSheet(true);
      await wait(isReduced() ? 0 : ms('--dur-fast'));
      const node = host.querySelector(`[data-card-id="${id}"], [data-receipt-id="${id}"]`);
      if (!node) return;
      node.scrollIntoView({ block: 'center', behavior: isReduced() ? 'auto' : 'smooth' });
      node.focus({ preventScroll: true });
      node.classList.remove('is-highlight'); void node.offsetWidth; node.classList.add('is-highlight');
    }

    /* ----- sheets (phone) ----- */
    const TITLES = { projects: 'Projects', board: 'Sprint board', artifacts: 'Artifacts' };
    function fillSheet(kind) {
      const p = product();
      slot('sheettitle').textContent = kind === 'projects' ? 'Projects' : `${TITLES[kind]} · ${p.name}`;
      let body = '';
      if (kind === 'projects') {
        body = `<div class="sheet__pad"><label class="search">${I.search}<span class="sr-only">Filter projects</span><input type="search" data-filter placeholder="Filter ${S.products.length} projects" value="${esc(S.filter)}" autocomplete="off"></label></div>
          <div class="sheet__pad"><button type="button" class="side-item side-item--needs" data-act="view" data-view="needs">${I.inbox}<span>Needs you, all projects</span><span class="count" data-count-for="all"></span></button></div>
          <div class="proj-list" data-proj-list>${projectListHTML(true)}</div>`;
      } else if (kind === 'board') body = boardHTML(p, S);
      else if (kind === 'artifacts') body = artifactsHTML(p, space(p.id), S, uid);
      slot('sheetbody').innerHTML = body;
      updateCounts();
    }
    function openSheet(kind, opener) {
      if (mode !== 'phone') return;
      if (kind !== 'projects' && S.view !== 'space') { S.view = 'space'; renderAll(); }
      S.sheet = kind;
      lastFocus = opener || document.activeElement;
      fillSheet(kind);
      host.classList.add('has-sheet');
      slot('sheet').classList.add('is-open');
      slot('sheet').inert = false;
      host.querySelectorAll('[data-behind-sheet]').forEach((n) => { n.inert = true; });
      renderChrome();
      requestAnimationFrame(() => slot('sheettitle').focus({ preventScroll: true }));
    }
    function closeSheet(silent) {
      if (mode !== 'phone' || !S.sheet) return;
      S.sheet = null;
      host.classList.remove('has-sheet');
      slot('sheet').classList.remove('is-open');
      slot('sheet').inert = true;
      host.querySelectorAll('[data-behind-sheet]').forEach((n) => { n.inert = false; });
      renderChrome();
      if (!silent && lastFocus && host.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
    }

    /* ----- messages ----- */
    function scrollEnd() { const l = slot('log'); l.scrollTo({ top: l.scrollHeight, behavior: isReduced() ? 'auto' : 'smooth' }); }
    function appendItem(item, animate) {
      const inner = slot('log').querySelector('.log__inner');
      const n = nodeFrom(itemHTML(item, uid));
      inner.appendChild(n);
      if (animate) {
        if (isReduced()) play(n, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
        else play(n, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: ms('--dur-base'), easing: cssVar('--ease-enter') });
      }
      return n;
    }
    const here = (pid) => S.view === 'space' && S.product === pid;
    function announce(t) { slot('live').textContent = t; }
    function toast(text) {
      const t = nodeFrom(`<div class="toast" role="status">${esc(text)}</div>`);
      host.appendChild(t);
      play(t, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: isReduced() ? 1 : ms('--dur-base'), easing: cssVar('--ease-enter') });
      setTimeout(async () => { await play(t, [{ opacity: 1 }, { opacity: 0 }], { duration: ms('--dur-base'), fill: 'forwards' }); t.remove(); }, 2200);
    }
    async function pmReply(pid, text) {
      await wait(250);
      const typing = here(pid) ? appendItem({ t: 'typing' }, true) : null;
      if (typing) scrollEnd();
      await wait(1100);
      if (typing) typing.remove();
      const m = { t: 'msg', who: 'pm', time: clock(), html: `<p>${esc(text)}</p>` };
      S.logs[pid].push(m);
      if (here(pid)) { appendItem(m, true); scrollEnd(); announce(`PM: ${text}`); }
    }
    async function send() {
      const ta = host.querySelector('.composer textarea');
      const text = ta.value.trim();
      if (!text || S.view !== 'space') return;
      ta.value = ''; space(S.product).draft = '';
      const pid = S.product;
      const m = { t: 'msg', who: 'owner', time: clock(), html: `<p>${esc(text)}</p>` };
      S.logs[pid].push(m);
      appendItem(m, true); scrollEnd();
      await pmReply(pid, DATA.replies[product(pid).status]);
    }
    function togglePause() {
      const p = product();
      p.status = p.status === 'paused' ? 'running' : 'paused';
      if (p.status === 'paused') { p.pausedSince = 'today'; p.run = 'paused'; } else { p.run = 'healthy'; }
      const note = { t: 'note', html: p.status === 'paused' ? `You paused <b>${esc(p.name)}</b> · the team stops after the current run` : `You resumed <b>${esc(p.name)}</b> · the next run starts within the hour` };
      S.logs[p.id].push(note);
      renderChrome(); renderPane(); updateCounts();
      if (S.sheet) fillSheet(S.sheet);
      if (S.view === 'space') { appendItem(note, true); scrollEnd(); }
      announce(note.html.replace(/<[^>]+>/g, ''));
    }

    /* ----- the signature: resolving a card into the conversation ----- */
    async function morph(node, html, reduced) {
      const parent = node.parentElement;
      const kids = [...parent.children];
      const followers = kids.slice(kids.indexOf(node) + 1);
      const had = node.contains(document.activeElement);
      const b = { x: node.offsetLeft, y: node.offsetTop, w: node.offsetWidth, h: node.offsetHeight, bg: getComputedStyle(node).backgroundColor };
      const tops = followers.map((f) => f.offsetTop);
      const next = nodeFrom(html);
      if (reduced) {
        node.replaceWith(next);
        if (had) next.focus({ preventScroll: true });
        await play(next, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
        return next;
      }
      const d = ms(DIR.morph.dur); const ease = cssVar(DIR.morph.ease); const fast = ms('--dur-fast');
      await Promise.all([...node.children].map((c) => play(c, [{ opacity: 1 }, { opacity: 0 }], { duration: fast, easing: 'linear', fill: 'forwards' })));
      node.replaceWith(next);
      next.classList.add('is-new');
      if (had) next.focus({ preventScroll: true });
      const a = { x: next.offsetLeft, y: next.offsetTop, w: next.offsetWidth, h: next.offsetHeight, bg: getComputedStyle(next).backgroundColor };
      const inner = [...next.children];
      inner.forEach((c) => { c.style.opacity = '0'; });
      // FLIP: only transform and colour animate; followers slide by transform, never by layout
      const ops = [play(next, [
        { transformOrigin: '0 0', transform: `translate(${b.x - a.x}px, ${b.y - a.y}px) scale(${b.w / a.w}, ${b.h / a.h})`, backgroundColor: b.bg },
        { transformOrigin: '0 0', transform: 'none', backgroundColor: a.bg }], { duration: d, easing: ease })];
      followers.forEach((f, k) => { const dy = tops[k] - f.offsetTop; if (dy) ops.push(play(f, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: d, easing: ease })); });
      await Promise.all(ops);
      inner.forEach((c) => { c.style.opacity = ''; play(c, [{ opacity: 0 }, { opacity: 1 }], { duration: fast, easing: 'linear' }); });
      return next;
    }

    async function resolve(id, choice, btn) {
      if (S.busy.has(id)) return;
      const pid = S.product; const log = S.logs[pid];
      const idx = log.findIndex((i) => i.t === 'card' && i.id === id);
      if (idx < 0) return;
      S.busy.add(id);
      const r = log[idx].receipts[choice];
      const node = host.querySelector(`.card[data-card-id="${id}"]`);
      node.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      const receipt = { t: 'receipt', id, tone: r.tone, verb: r.verb, detail: r.detail, time: clock() };
      log[idx] = receipt;
      const reduced = isReduced();
      try {
        if (!reduced && DIR.before) await DIR.before({ host, node, btn, tone: r.tone, verb: r.verb, H });
        const next = await morph(node, receiptHTML(receipt), reduced);
        if (!reduced && DIR.after) DIR.after({ host, node: next, tone: r.tone, H });
      } finally { S.busy.delete(id); }
      updateCounts();
      if (mode === 'mac' && space(pid).pane === 'artifacts') renderPane();
      announce(`${r.verb}: ${r.detail}. Recorded on #${id} as your answer.`);
      await pmReply(pid, r.pm);
    }

    /* ----- events ----- */
    host.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]');
      if (!t || !host.contains(t) || t.disabled) return;
      switch (t.dataset.act) {
        case 'resolve': resolve(t.dataset.card, t.dataset.choice, t); break;
        case 'product': openSpace(t.dataset.id); break;
        case 'view': openView(t.dataset.view); break;
        case 'pane': { const st = space(S.product); st.pane = st.pane === t.dataset.tab ? null : t.dataset.tab; renderPane(); break; }
        case 'pane-tab': space(S.product).pane = t.dataset.tab; renderPane(); break;
        case 'pane-close': space(S.product).pane = null; renderPane(); break;
        case 'tab': {
          const tab = t.dataset.tab;
          if (tab === 'chat') { closeSheet(true); if (S.view !== 'space') openView('space'); else renderChrome(); }
          else if (tab === 'needs') { closeSheet(true); openView('needs'); }
          else openSheet(tab, t);
          break;
        }
        case 'sheet': openSheet(t.dataset.sheet, t); break;
        case 'sheet-close': closeSheet(); break;
        case 'goto': goto(t.dataset.pid || S.product, t.dataset.card); break;
        case 'pause': togglePause(); break;
        case 'more': S.moreOpen = !S.moreOpen; if (S.sheet === 'projects') host.querySelector('[data-proj-list]').innerHTML = projectListHTML(true); else renderChrome(); updateCounts(); break;
        case 'thumb': toast('Opens the prototype full-screen'); break;
        case 'art-type': {
          const st = space(S.product); st.artType = t.dataset.type;
          t.parentElement.querySelectorAll('[data-type]').forEach((x) => x.setAttribute('aria-pressed', String(x === t)));
          t.closest('.arts').querySelector('[data-art-groups]').innerHTML = artifactGroupsHTML(product(), st, S);
          break;
        }
        case 'focus-composer': if (S.view !== 'space') openView('space'); host.querySelector('.composer textarea').focus(); break;
        default: break;
      }
    });
    host.addEventListener('input', (e) => {
      const el = e.target;
      if (el.matches('[data-art-q]')) {
        const st = space(S.product); st.artQ = el.value;
        el.closest('.arts').querySelector('[data-art-groups]').innerHTML = artifactGroupsHTML(product(), st, S);
      } else if (el.matches('[data-filter]')) {
        S.filter = el.value;
        const target = el.closest('.sheet') ? host.querySelector('[data-proj-list]') : slot('projects');
        target.innerHTML = projectListHTML(!!el.closest('.sheet'));
        updateCounts();
      } else if (el.matches('.composer textarea')) {
        el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
      }
    });
    host.querySelector('.composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
    host.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target;
      if (el.matches('textarea')) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
        if (e.key === 'Escape') el.blur();
        return;
      }
      if (el.matches('input')) { if (e.key === 'Escape') el.blur(); return; }
      if (e.key === 'Escape' && S.sheet) { closeSheet(); return; }
      const card = el.closest && el.closest('.card');
      if (card) {
        const c = S.logs[S.product].find((i) => i.t === 'card' && i.id === card.dataset.cardId);
        const a = c && c.actions.find((x) => x.key === e.key.toLowerCase());
        if (a) { e.preventDefault(); resolve(c.id, a.id, card.querySelector(`[data-choice="${a.id}"]`)); return; }
      }
      if (mode !== 'mac') return;
      const k = e.key.toLowerCase();
      const pane = (tab) => { if (S.view !== 'space') return; const st = space(S.product); st.pane = st.pane === tab ? null : tab; renderPane(); };
      if (k === 'b') { e.preventDefault(); pane('board'); }
      else if (k === 'f') { e.preventDefault(); pane('artifacts'); if (space(S.product).pane) host.querySelector('[data-art-q]').focus(); }
      else if (k === 'n') { e.preventDefault(); host.querySelector('.composer textarea').focus(); }
      else if (k === 'y') { e.preventDefault(); openView('needs'); }
      else if (k === '/') { e.preventDefault(); host.querySelector('[data-filter]').focus(); }
    });

    renderAll();
    return { remount: () => mountApp(host, mode) };
  }

  /* ---------- shells ---------- */
  function macShell(uid) {
    return `<div class="win">
      <div class="win__bar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="win__title" data-slot="wintitle"></span></div>
      <div class="win__body">
        <nav class="sidebar" aria-label="Projects">
          <div class="brand">${I.mark}<span>Team Console</span></div>
          <label class="search search--side">${I.search}<span class="sr-only">Filter projects</span><input type="search" data-filter placeholder="Filter projects" autocomplete="off"><kbd>/</kbd></label>
          <ul class="side-list side-list--top">
            <li><button type="button" class="side-item" data-act="view" data-view="needs">${I.inbox}<span>Needs you</span><kbd>Y</kbd><span class="count" data-count-for="all" hidden></span></button></li>
            <li><button type="button" class="side-item" data-act="view" data-view="overview">${I.grid}<span>All projects</span></button></li>
          </ul>
          <div class="side-projects" data-slot="projects"></div>
          <div class="side-foot"><span class="avatar avatar--owner" aria-hidden="true">K</span><span>Owner</span><span class="side-foot__sync"><i aria-hidden="true"></i>GitHub synced</span></div>
        </nav>
        <section class="convo" aria-label="Main">
          <header class="convo__head" data-slot="convohead"></header>
          <div class="log" data-slot="log" tabindex="-1"></div>
          <div data-slot="banner"></div>
          <form class="composer" autocomplete="off"><div class="composer__box"><label class="sr-only" for="${uid}-msg">Message</label><textarea id="${uid}-msg" rows="1"></textarea><span class="composer__hint"><kbd>N</kbd></span><button class="send" type="submit" aria-label="Send">${I.send}</button></div></form>
        </section>
        <aside class="pane" data-slot="pane" aria-label="Detail pane">
          <div class="pane__inner">
            <div class="pane__tabs" role="tablist" aria-label="Detail">
              <button type="button" class="tab-btn" role="tab" data-act="pane-tab" data-tab="board">${I.board}Board</button>
              <button type="button" class="tab-btn" role="tab" data-act="pane-tab" data-tab="artifacts">${I.stack}Artifacts</button>
              <button type="button" class="icon-btn" data-act="pane-close" aria-label="Close pane">${I.x}</button>
            </div>
            <div class="pane__body" data-slot="panebody" role="tabpanel"></div>
          </div>
        </aside>
      </div>
    </div><div class="sr-only" aria-live="polite" data-slot="live"></div>`;
  }

  function phoneShell(uid) {
    return `<div class="p-status" aria-hidden="true"><span>9:41</span><span class="p-island"></span><span class="p-status__icons">${I.bars}${I.battery}</span></div>
      <header class="p-head" data-slot="phead" data-behind-sheet></header>
      <div data-slot="strip" data-behind-sheet></div>
      <div class="log" data-slot="log" data-behind-sheet tabindex="-1"></div>
      <div data-slot="banner" data-behind-sheet></div>
      <form class="composer" autocomplete="off" data-behind-sheet><div class="composer__box"><label class="sr-only" for="${uid}-msg">Message</label><textarea id="${uid}-msg" rows="1"></textarea><button class="send" type="submit" aria-label="Send">${I.send}</button></div></form>
      <button type="button" class="p-needs" data-act="tab" data-tab="needs" data-behind-sheet>${I.spark}<span class="count" data-count-for="all" hidden></span><span>need you</span></button>
      <nav class="tabs" aria-label="Sections" data-behind-sheet>
        <button type="button" data-act="tab" data-tab="needs">${I.inbox}<span>Needs you</span><span class="count" data-count-for="all" hidden></span></button>
        <button type="button" data-act="tab" data-tab="chat">${I.chat}<span>Chat</span></button>
        <button type="button" data-act="tab" data-tab="board">${I.board}<span>Board</span></button>
        <button type="button" data-act="tab" data-tab="artifacts">${I.stack}<span>Artifacts</span></button>
      </nav>
      <div class="home-ind" aria-hidden="true"></div>
      <div class="scrim" data-act="sheet-close"></div>
      <section class="sheet" data-slot="sheet" role="dialog" aria-modal="true" aria-labelledby="${uid}-sheet-t" inert>
        <div class="sheet__grab" aria-hidden="true"></div>
        <header class="sheet__head"><h2 id="${uid}-sheet-t" tabindex="-1" data-slot="sheettitle"></h2><button type="button" class="icon-btn" data-act="sheet-close" aria-label="Close">${I.x}</button></header>
        <div class="sheet__body" data-slot="sheetbody"></div>
      </section>
      <div class="sr-only" aria-live="polite" data-slot="live"></div>`;
  }

  /* ---------- page controls ---------- */
  const hosts = [...document.querySelectorAll('[data-app]')];
  const mountAll = () => hosts.forEach((h) => { h.className = 'app'; mountApp(h, h.dataset.app); });
  const stage = document.querySelector('.stage');
  const macFrame = document.querySelector('.mac-frame');
  function fit() {
    const W = stage.clientWidth - 48; const view = stage.dataset.view;
    let z = 1;
    if (view === 'mac') { z = Math.min(1, W / 1182); stage.dataset.layout = 'stack'; }
    else if (view === 'both') {
      const room = W - 414 - 40;
      if (room / 1182 >= 0.62) { z = Math.min(1, room / 1182); stage.dataset.layout = 'row'; }
      else { z = Math.min(1, W / 1182); stage.dataset.layout = 'stack'; }
    }
    macFrame.style.zoom = String(Math.max(z, 0.3));
  }
  function setControl(ctrl, val) {
    if (ctrl === 'view') { stage.dataset.view = val; fit(); }
    if (ctrl === 'theme') { if (val === 'auto') delete root.dataset.theme; else root.dataset.theme = val; }
    if (ctrl === 'motion') { if (val === 'system') delete root.dataset.motion; else root.dataset.motion = val; }
    document.querySelectorAll(`[data-control="${ctrl}"] button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === val)));
  }
  document.querySelectorAll('[data-control]').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]'); if (b) setControl(g.dataset.control, b.dataset.value);
  }));
  document.querySelector('[data-reset]').addEventListener('click', mountAll);
  const small = matchMedia('(max-width: 520px)').matches;
  setControl('view', small ? 'phone' : 'both');
  setControl('theme', 'auto');
  setControl('motion', 'system');
  if (!small) document.querySelector('.note details').open = true;
  addEventListener('resize', fit);
  mountAll();
  fit();
})();
