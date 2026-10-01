/* Shared runtime of the feature design pages: motion and escaping helpers, the inline icon set, the i18n lookup
   and the page chrome (layout, theme, language, motion). Each page passes its own I18N table and demo wiring.
   Design prototypes only: mock data, no network. */
const Proto = (() => {
  'use strict';
  const root = document.documentElement;
  const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
  const isReduced = () => root.dataset.motion === 'reduce' || mqReduce.matches;
  const cssVar = (n) => getComputedStyle(root).getPropertyValue(n).trim();
  const ms = (n) => { const v = cssVar(n); const x = parseFloat(v) || 0; return v.endsWith('ms') ? x : v.endsWith('s') ? x * 1000 : x; };
  const wait = (t) => new Promise((r) => setTimeout(r, t));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function play(el, frames, opts) {
    if (!el || !el.animate) return;
    try { await el.animate(frames, opts).finished; } catch (err) { if (!err || err.name !== 'AbortError') throw err; }
  }
  const plain = (html) => { const d = document.createElement('template'); d.innerHTML = html; return d.content.textContent; };

  /* ---------- language (same preference key as the Paper Desk prototype) ---------- */
  const LANG_KEY = 'team-console.lang';
  function i18n(table) {
    const L = { lang: 'ru', fmt: null };
    try { const v = localStorage.getItem(LANG_KEY); L.lang = v === 'en' || v === 'ru' ? v : /^en\b/i.test(navigator.language || '') ? 'en' : 'ru'; }
    catch (err) { console.warn('Language preference unavailable, using Russian', err); }
    L.apply = (v) => {
      L.lang = v; root.lang = v;
      const loc = v === 'ru' ? 'ru-RU' : 'en-GB';
      L.fmt = { time: new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit' }), plural: new Intl.PluralRules(loc) };
    };
    L.save = (v) => { try { localStorage.setItem(LANG_KEY, v); } catch (err) { console.warn('Language preference not saved', err); } };
    L.pl = (n, forms) => { const c = L.fmt.plural.select(n); if (forms.length === 2) return c === 'one' ? forms[0] : forms[1]; return c === 'one' ? forms[0] : c === 'few' ? forms[1] : forms[2]; };
    L.t = (key, vars = {}) => {
      const v = table[L.lang][key] ?? table.en[key];
      if (v == null) { console.warn(`Missing UI string: ${key}`); return key; }
      if (typeof v === 'function') return v(vars, L.pl, { esc });
      return v.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? esc(vars[k]) : m));
    };
    L.hhmm = (d) => L.fmt.time.format(d);
    L.apply(L.lang);
    return L;
  }

  /* ---------- icons: inline strokes, as in the prototype ---------- */
  const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const I = {
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'), x: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
    bang: svg('<path d="M12 6.5v7M12 17.3v.2"/>'), q: svg('<path d="M9.3 9a2.8 2.8 0 015.4 1c0 2-2.7 2.3-2.7 4M12 17.3v.2"/>'),
    warn: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.3v.2"/>'),
    chev: svg('<path d="M9.5 6l6 6-6 6"/>'), back: svg('<path d="M14.5 6l-6 6 6 6"/>'), down: svg('<path d="M6 9.5l6 6 6-6"/>'),
    plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'), minus: svg('<path d="M6 12h12"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4L6 18M18 18l-1.6-1.6M7.6 7.6L6 6"/>'),
    ext: svg('<path d="M14 4.5h5.5V10M19.5 4.5L11 13M17 13.5v5a1 1 0 01-1 1H5.5a1 1 0 01-1-1V8a1 1 0 011-1h5"/>'),
    copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V5.5a1 1 0 00-1-1h-9a1 1 0 00-1 1v9a1 1 0 001 1h3"/>'),
    inbox: svg('<path d="M4 13.5L6.5 5h11l2.5 8.5V19H4z"/><path d="M4 13.5h5l1 2h4l1-2h5"/>'),
    grid: svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
    search: svg('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
    chat: svg('<path d="M4.5 5.5h15v10h-9l-6 4z"/>'),
    board: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15M15 4.5v15"/>'),
    stack: svg('<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4M4 16l8 4 8-4"/>'),
    archive: svg('<rect x="3.5" y="4.5" width="17" height="4.5" rx="1"/><path d="M5 9v10.5h14V9M10 13h4"/>'),
    link: svg('<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>'),
    lock: svg('<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5"/>'),
    wifi: svg('<path d="M3.5 9.5a12 12 0 0117 0M6.5 12.8a7.5 7.5 0 0111 0M9.5 16a3 3 0 015 0"/><path d="M4 4l16 16"/>'),
    pause: svg('<path d="M9 6v12M15 6v12"/>'),
    play: svg('<path d="M8 5.5v13l10.5-6.5z"/>'),
    refresh: svg('<path d="M19.5 12a7.5 7.5 0 11-2.2-5.3"/><path d="M19.5 4.5v4.5H15"/>'),
    sliders: svg('<path d="M5 7h8M17 7h2M5 17h2M11 17h8"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
    clock: svg('<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>'),
    key: svg('<circle cx="8" cy="15" r="3.5"/><path d="M10.5 12.5l8-8M16 7l2.5 2.5M14 9l2 2"/>'),
    mark: '<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="6" fill="currentColor"/><path d="M7.5 9.5h9M7.5 14.5h5.5" stroke="var(--accent-contrast)" stroke-width="2.2" stroke-linecap="round"/></svg>',
    bars: '<svg viewBox="0 0 18 12" width="18" height="12" aria-hidden="true"><rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor"/><rect x="5" y="5" width="3" height="7" rx="1" fill="currentColor"/><rect x="10" y="2.5" width="3" height="9.5" rx="1" fill="currentColor"/><rect x="15" y="0" width="3" height="12" rx="1" fill="currentColor"/></svg>',
    battery: '<svg viewBox="0 0 27 13" width="27" height="13" aria-hidden="true"><rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="18" height="9" rx="2" fill="currentColor"/><rect x="24.5" y="4.5" width="2" height="4" rx="1" fill="currentColor" opacity=".4"/></svg>',
  };
  const dots = '<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>';

  /* ---------- page chrome: layout, theme, motion and language controls ---------- */
  // `onLang(value)` re-renders the page's apps; `title` is the document title prefix ("Team Console · #24").
  function page({ L, title, onLang }) {
    const stage = document.querySelector('.stage');
    const macFrame = document.querySelector('.mac-frame');
    function fit() {
      const W = stage.clientWidth - 48; const view = stage.dataset.view; let z = 1;
      if (view === 'mac') { z = Math.min(1, W / 1182); stage.dataset.layout = 'stack'; }
      else if (view === 'both') {
        const room = W - 414 - 40;
        if (room / 1182 >= 0.62) { z = Math.min(1, room / 1182); stage.dataset.layout = 'row'; } else { z = Math.min(1, W / 1182); stage.dataset.layout = 'stack'; }
      }
      macFrame.style.zoom = String(Math.max(z, 0.3));
    }
    function translatePage() {
      document.querySelectorAll('[data-i18n]').forEach((el) => { el.innerHTML = L.t(el.dataset.i18n); });
      document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', plain(L.t(el.dataset.i18nAria))));
      document.title = `${title} · ${plain(L.t('page.title'))}`;
    }
    function setControl(ctrl, val) {
      if (ctrl === 'view') { stage.dataset.view = val; fit(); }
      if (ctrl === 'theme') { if (val === 'auto') delete root.dataset.theme; else root.dataset.theme = val; }
      if (ctrl === 'motion') { if (val === 'system') delete root.dataset.motion; else root.dataset.motion = val; }
      if (ctrl === 'lang' && val !== L.lang) { L.save(val); L.apply(val); translatePage(); onLang(val); }
      document.querySelectorAll(`[data-control="${ctrl}"] button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === val)));
    }
    document.querySelectorAll('[data-control]').forEach((g) => g.addEventListener('click', (e) => { const b = e.target.closest('button[data-value]'); if (b) setControl(g.dataset.control, b.dataset.value); }));
    const small = matchMedia('(max-width: 520px)').matches;
    translatePage();
    setControl('view', small ? 'phone' : 'both');
    setControl('theme', 'auto');
    setControl('motion', 'system');
    setControl('lang', L.lang);
    document.querySelectorAll('[data-control=lang] button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === L.lang)));
    addEventListener('resize', fit);
    return { fit, setControl };
  }

  return { root, isReduced, cssVar, ms, wait, esc, play, plain, i18n, I, dots, page };
})();
