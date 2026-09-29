D = dict(
  file='03-signal.html', num='03', name='Signal',
  fonts='https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Figtree:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap',
  shared='''
  --font-display:"Bricolage Grotesque",-apple-system,system-ui,"Segoe UI",sans-serif;--font-body:"Figtree",-apple-system,system-ui,"Segoe UI",sans-serif;--font-mono:"JetBrains Mono",ui-monospace,Menlo,monospace;--fw-display:700;
  --fs-xs:12px;--fs-sm:14px;--fs-md:15.5px;--fs-lg:19px;--fs-xl:25px;--fs-2xl:34px;--lh-body:1.5;--lh-tight:1.2;
  --r-sm:10px;--r-md:14px;--r-lg:22px;
  --btn-h:38px;--sidebar-w:264px;--pane-w:404px;--log-max:660px;--pad-x:28px;--gap-log:18px;--pad-card:18px 20px;--card-indent:0px;
  --dur-instant:0ms;--dur-fast:150ms;--dur-base:260ms;--dur-slow:420ms;--dur-sig:620ms;
  --ease-standard:cubic-bezier(.2,0,0,1);--ease-enter:cubic-bezier(0,0,.2,1);--ease-exit:cubic-bezier(.4,0,1,1);--ease-emph:cubic-bezier(.34,1.4,.64,1);''',
  light='''
  --bg:#FAF8F5;--bg-sunken:#F1EDE8;--surface:#FFFFFF;--surface-2:#FCFAF7;--text:#16131E;--text-2:#4B4658;--text-3:#676176;
  --border:#E8E3EA;--border-strong:#D3CCD8;--accent:#5A3DF0;--accent-contrast:#FFFFFF;--accent-soft:#EDE9FF;--accent-text:#4A2DDA;
  --success-soft:#DDF3E6;--success-text:#17693F;--warning-soft:#FCEFD5;--warning-text:#7F500A;--danger-soft:#FCE3E1;--danger-text:#A42A20;
  --focus:#5A3DF0;--owner-bubble:#5A3DF0;--owner-text:#FFFFFF;
  --shadow-1:0 1px 2px rgba(30,20,60,.06);--shadow-2:0 12px 30px -10px rgba(40,20,120,.28);--shadow-3:0 -14px 44px -12px rgba(30,20,60,.3);''',
  dark='''
  --bg:#110F16;--bg-sunken:#0C0A10;--surface:#1B1823;--surface-2:#16131D;--text:#F2EFF7;--text-2:#B8B1C6;--text-3:#8F889E;
  --border:#2A2634;--border-strong:#3B3548;--accent:#9B89FF;--accent-contrast:#140D33;--accent-soft:#261F4B;--accent-text:#BEB3FF;
  --success-soft:#112A1D;--success-text:#6CD7A0;--warning-soft:#2F250F;--warning-text:#F2C46A;--danger-soft:#361718;--danger-text:#FF9189;
  --focus:#BEB3FF;--owner-bubble:#9B89FF;--owner-text:#140D33;
  --shadow-1:0 1px 2px rgba(0,0,0,.4);--shadow-2:0 14px 34px -10px rgba(0,0,0,.7);--shadow-3:0 -14px 44px -12px rgba(0,0,0,.8);''',
  css='''
/* Signal: one vivid violet reserved for "you are needed"; answering sweeps colour into your own reply */
.card{border:1.5px solid var(--accent);box-shadow:0 0 0 4px var(--accent-soft),var(--shadow-2)}
.card__title{font-size:21px;letter-spacing:-.01em}
.app[data-app=phone] .card__title{font-size:20px}
.card__kind{color:var(--accent-text)}
.rec{background:var(--bg-sunken)}
.rec__label{color:var(--text-2)}
.btn{border-radius:999px;padding:0 18px}
.btn--primary{box-shadow:0 6px 16px -6px color-mix(in oklab,var(--accent) 70%,transparent)}
.sweep{position:absolute;inset:0;background:var(--accent);pointer-events:none;clip-path:circle(0 at 50% 50%)}
.sweep--negative{background:var(--text)}.sweep--neutral{background:var(--text-2)}
.receipt{align-self:flex-end;max-width:88%;background:var(--owner-bubble);color:var(--owner-text);border-radius:var(--r-lg) var(--r-lg) var(--r-sm) var(--r-lg);padding:10px 16px 10px 10px}
.receipt--negative,.receipt--neutral{background:var(--text);color:var(--bg)}
.receipt__verb{color:inherit}
.receipt__meta{color:inherit;opacity:.72;flex-basis:100%;padding-left:34px}
.receipt__icon,.receipt--negative .receipt__icon,.receipt--neutral .receipt__icon{background:color-mix(in oklab,currentColor 18%,transparent);color:inherit}
.receipt.is-new .receipt__icon{animation:pop var(--dur-slow) var(--ease-emph) var(--dur-fast) both}
@keyframes pop{from{transform:scale(.3)}to{transform:none}}
.msg--pm .bubble{font-size:16px}
.avatar--pm{background:var(--text);color:var(--bg)}
.msg--owner .bubble{box-shadow:0 8px 18px -10px color-mix(in oklab,var(--accent) 80%,transparent)}
.convo__title h2{font-size:22px;letter-spacing:-.01em}
.prod-mono{border-radius:9px}
.side-item{border-radius:12px;min-height:38px}
.side-item[aria-current=true]{background:var(--accent-soft);color:var(--accent-text);box-shadow:none}
.side-item[aria-current=true] .side-prod__label{color:var(--accent-text)}
.brand{font-size:17px}
.p-head{padding-top:6px}
.p-switch b{font-size:23px;letter-spacing:-.01em}
.p-switch .prod-mono{width:40px;height:40px;font-size:19px;border-radius:12px}
.app[data-app=phone] .tabs{margin:0 14px 26px;padding:5px;border:1px solid var(--border);border-radius:999px;background:var(--surface);box-shadow:var(--shadow-2)}
.app[data-app=phone] .tabs button{min-height:46px;border-radius:999px;font-size:10.5px}
.app[data-app=phone] .tabs button[aria-current=page]{background:var(--accent-soft)}
.app[data-app=phone] .composer{padding-bottom:10px}
.p-needs{display:flex;position:absolute;bottom:184px;left:50%;translate:-50% 0;z-index:5;align-items:center;gap:6px;height:34px;padding:0 14px 0 10px;border:0;border-radius:999px;background:var(--accent);color:var(--accent-contrast);font-weight:700;font-size:13px;box-shadow:var(--shadow-2)}
.p-needs .ico{width:16px;height:16px;fill:currentColor;stroke:none}
.p-needs .count{background:var(--accent-contrast);color:var(--accent);height:20px}
.p-needs:has(.count[hidden]),.app:not(.is-space) .p-needs,.app.has-sheet .p-needs{display:none}
.app[data-app=phone] .log__inner{padding-bottom:56px}
.need{border-radius:var(--r-lg);border-color:color-mix(in oklab,var(--accent) 35%,var(--border))}
.need__title{font-size:17px}
.ov{border-radius:var(--r-lg)}
.art--awaiting{box-shadow:0 0 0 3px var(--accent-soft)}
''',
  js='''
const DIR = {
  id: 'signal', boardOpenByDefault: false, rollCounts: false,
  morph: { dur: '--dur-sig', ease: '--ease-emph' },
  // Colour sweeps out from the tapped button across the card, then the card springs into your own reply bubble.
  async before({ node, btn, tone, H }) {
    let x = node.offsetWidth / 2; let y = node.offsetHeight / 2;
    if (btn) {
      let el = btn; let ox = 0; let oy = 0;
      while (el && el !== node) { ox += el.offsetLeft; oy += el.offsetTop; el = el.offsetParent; }
      if (el === node) { x = ox + btn.offsetWidth / 2; y = oy + btn.offsetHeight / 2; }
    }
    const r = Math.hypot(Math.max(x, node.offsetWidth - x), Math.max(y, node.offsetHeight - y));
    const sweep = document.createElement('div');
    sweep.className = `sweep sweep--${tone}`;
    sweep.setAttribute('aria-hidden', 'true');
    node.appendChild(sweep);
    await H.play(sweep, [{ clipPath: `circle(0px at ${x}px ${y}px)` }, { clipPath: `circle(${r}px at ${x}px ${y}px)` }], { duration: H.ms('--dur-slow'), easing: H.cssVar('--ease-enter'), fill: 'forwards' });
    node.style.backgroundColor = getComputedStyle(sweep).backgroundColor;
    node.style.borderColor = 'transparent';
    node.style.boxShadow = 'none';
  },
};''',
  note='''
<div class="note__grid"><div>
<p><b>Idea.</b> Bolder and more personal: a confident grotesque for project names and questions, big touch targets, and one vivid violet reserved for "you are needed", so decision cards glow and everything else steps back. On iPhone a floating pill says how many things need you, and the tab bar floats above the home indicator.</p>
<p><b>Signature moment.</b> Colour sweep: the violet spreads from your thumb across the card, then the card springs into your own reply bubble on the right, so the answer visibly becomes yours. Reduced motion: instant swap, 120 ms fade, no spring.</p>
<p class="try">Try: tap “Go” on the Sprint 01 card, tap the “need you” pill, switch to fieldnote (failing) and back, open Artifacts and search “demo”. Mac keys after clicking in the window: B, F, Y, N, /.</p>
</div><dl class="tok">
<dt>Colour</dt><dd><span class="sw"><i style="background:var(--bg)"></i>bg #FAF8F5 / #110F16</span><span class="sw"><i style="background:var(--surface)"></i>surface #FFF / #1B1823</span><span class="sw"><i style="background:var(--text)"></i>text #16131E / #F2EFF7</span><span class="sw"><i style="background:var(--accent)"></i>violet #5A3DF0 / #9B89FF</span><span class="sw"><i style="background:var(--accent-soft)"></i>glow</span></dd>
<dt>Type</dt><dd>Bricolage Grotesque (display) + Figtree (UI) + JetBrains Mono (ids), all OFL. Scale 12 / 14 / 15.5 / 19 / 25 / 34, body 1.5.</dd>
<dt>Radius</dt><dd>10 / 14 / 22 and full pills for buttons and tab bar. Spacing 4 px base, roomy.</dd>
<dt>Motion</dt><dd>fast 150 · base 260 · slow 420 · signature 620 ms; emphasised spring (.34,1.4,.64,1) only for the signature.</dd>
</dl></div>''',
)
