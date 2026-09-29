D = dict(
  file='01-paper-desk.html', num='01', name='Paper Desk',
  fonts='https://fonts.googleapis.com/css2?family=Source+Code+Pro:wght@400;600&family=Source+Sans+3:wght@400;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap',
  shared='''
  --font-display:"Source Serif 4",Georgia,"Times New Roman",serif;--font-body:"Source Sans 3",-apple-system,system-ui,"Segoe UI",sans-serif;--font-mono:"Source Code Pro",ui-monospace,Menlo,monospace;--fw-display:600;
  --fs-xs:12px;--fs-sm:14px;--fs-md:15px;--fs-lg:18px;--fs-xl:22px;--fs-2xl:28px;--lh-body:1.55;--lh-tight:1.25;
  --r-sm:6px;--r-md:10px;--r-lg:16px;
  --btn-h:34px;--sidebar-w:256px;--pane-w:392px;--log-max:680px;--pad-x:32px;--gap-log:20px;--pad-card:18px 20px;--card-indent:40px;
  --dur-instant:0ms;--dur-fast:140ms;--dur-base:240ms;--dur-slow:380ms;--dur-sig:620ms;
  --ease-standard:cubic-bezier(.2,0,0,1);--ease-enter:cubic-bezier(0,0,.2,1);--ease-exit:cubic-bezier(.4,0,1,1);--ease-emph:cubic-bezier(.3,0,0,1);''',
  light='''
  --bg:#F7F3EC;--bg-sunken:#EFE9DF;--surface:#FFFDF9;--surface-2:#FAF6EF;--text:#29251F;--text-2:#5B5449;--text-3:#6D6459;
  --border:#E5DDD0;--border-strong:#CFC5B5;--accent:#3E6A48;--accent-contrast:#FFFFFF;--accent-soft:#E3ECE0;--accent-text:#2F5638;
  --success-soft:#E1EEDF;--success-text:#2D6A3E;--warning-soft:#F5E8CD;--warning-text:#7A510E;--danger-soft:#F6E0DA;--danger-text:#9A3324;
  --focus:#3E6A48;--owner-bubble:#EAE2D4;--owner-text:#29251F;
  --shadow-1:0 1px 2px rgba(60,45,20,.07),0 0 0 .5px rgba(60,45,20,.03);--shadow-2:0 8px 24px -8px rgba(60,45,20,.22);--shadow-3:0 -12px 40px -12px rgba(60,45,20,.28);''',
  dark='''
  --bg:#1C1A17;--bg-sunken:#161412;--surface:#25221E;--surface-2:#201E1A;--text:#EEE8DD;--text-2:#BDB4A5;--text-3:#999082;
  --border:#35312B;--border-strong:#4A443B;--accent:#8FBC92;--accent-contrast:#10200F;--accent-soft:#263428;--accent-text:#A8D0AA;
  --success-soft:#1F3122;--success-text:#9BCF9F;--warning-soft:#382D18;--warning-text:#E6BC6E;--danger-soft:#3D2420;--danger-text:#F0A091;
  --focus:#A8D0AA;--owner-bubble:#322D27;--owner-text:#EEE8DD;
  --shadow-1:0 1px 2px rgba(0,0,0,.35);--shadow-2:0 10px 28px -8px rgba(0,0,0,.6);--shadow-3:0 -12px 40px -12px rgba(0,0,0,.7);''',
  css='''
/* Paper Desk: the PM writes like a letter; decisions are stamped and become margin notes */
.msg--pm .bubble{font-family:var(--font-display);font-size:16px;line-height:1.62}
.app[data-app=phone] .msg--pm .bubble{font-size:16px}
.msg--pm .brief__h{font-family:var(--font-body);font-size:var(--fs-xs);letter-spacing:.08em;text-transform:uppercase;color:var(--text-2)}
.avatar--pm{background:none;border:1px solid var(--border-strong);color:var(--text-2);font-family:var(--font-display);font-style:italic;font-weight:600}
.card__kind{font-variant:small-caps;letter-spacing:.04em;font-size:13px}
.card{background:var(--surface);background-image:linear-gradient(var(--surface),var(--surface-2))}
.rec{background:none;border-left:2px solid var(--accent);border-radius:0;padding:2px 0 2px 12px}
.rec__choice{font-family:var(--font-display);font-size:16px}
.receipt{background:none;border-left:2px solid var(--accent);border-radius:0;padding:4px 0 4px 14px;font-family:var(--font-display);font-style:italic;font-size:15px}
.receipt--negative{border-left-color:var(--danger-text)}.receipt--neutral{border-left-color:var(--text-3)}
.receipt__icon{background:none!important;width:18px;height:18px}
.receipt__icon .ico{width:18px;height:18px;stroke-width:2}
.receipt__meta{font-style:normal}
.receipt{--receipt-indent:28px}
.receipt.is-new .receipt__icon path{stroke-dasharray:24;stroke-dashoffset:24;animation:ink var(--dur-slow) var(--ease-emph) var(--dur-fast) forwards}
@keyframes ink{to{stroke-dashoffset:0}}
.stamp{position:absolute;right:22px;top:calc(50% - 39px);width:78px;height:78px;color:var(--accent);pointer-events:none;opacity:0}
.stamp svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.stamp .stamp__inner{stroke-width:1;opacity:.6}
.stamp--negative{color:var(--danger-text)}.stamp--neutral{color:var(--text-2)}
.sidebar{background:var(--bg-sunken)}
.side-item[aria-current=true]{box-shadow:none;background:var(--surface);border:1px solid var(--border)}
.side-label{font-variant:small-caps;letter-spacing:.06em;font-size:13px}
.tabs button[aria-current=page] .ico{stroke-width:2.2}
.need__title,.ov__top b{font-weight:600}
.day span{font-family:var(--font-display);font-style:italic;font-size:14px}
.msg--owner .bubble{border-radius:var(--r-lg)}
''',
  js='''
const DIR = {
  id: 'paper', boardOpenByDefault: false, rollCounts: false,
  morph: { dur: '--dur-slow', ease: '--ease-emph' },
  // An ink stamp presses onto the card, then the card folds into a margin note.
  async before({ node, tone, H }) {
    const glyph = tone === 'negative' ? '<path d="M24 24l16 16M40 24L24 40"/>' : tone === 'neutral' ? '<path d="M22 32h20"/>' : '<path d="M21 33l8 8 15-17"/>';
    const s = document.createElement('div');
    s.className = `stamp stamp--${tone}`;
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="28"/><circle class="stamp__inner" cx="32" cy="32" r="23"/>${glyph}</svg>`;
    node.appendChild(s);
    const strokes = [...s.querySelectorAll('circle,path')];
    strokes.forEach((p) => { const l = p.getTotalLength(); p.style.strokeDasharray = l; p.style.strokeDashoffset = l; });
    H.play(s, [{ opacity: 0, transform: 'rotate(-20deg) scale(1.4)' }, { opacity: 1, transform: 'rotate(-9deg) scale(1)' }], { duration: H.ms('--dur-base'), easing: H.cssVar('--ease-emph'), fill: 'forwards' });
    await Promise.all(strokes.map((p, i) => H.play(p, [{ strokeDashoffset: p.style.strokeDashoffset }, { strokeDashoffset: 0 }], { duration: H.ms('--dur-sig') * 0.6, delay: i * 70, easing: H.cssVar('--ease-emph'), fill: 'forwards' })));
    await H.wait(H.ms('--dur-base'));
  },
};''',
  note='''
<div class="note__grid"><div>
<p><b>Idea.</b> A quiet, warm reading desk: the PM writes like a short letter in a serif, the interface speaks in a plain sans, and the only colour is a moss-green ink used for the next action. Nothing moves unless you act; when you do, the card is stamped and folds into a margin note that stays in the conversation as your recorded answer.</p>
<p><b>Signature moment.</b> Ink stamp: tap Approve / Reject / Done and a stamp presses onto the card, its ring and mark draw in, then the card folds into an italic margin note (#id, time, "recorded as owner"). Reduced motion: an instant swap with a 120 ms fade.</p>
<p class="try">Try: tap “Approve · close” on #13, switch to sheltrix (paused) and back (your place is kept), open Needs you, open Artifacts and search “ADR”. Mac keys after clicking in the window: B board, F artifacts, Y needs you, N message, / filter; focus a card and press its letter.</p>
</div><dl class="tok">
<dt>Colour</dt><dd><span class="sw"><i style="background:var(--bg)"></i>paper #F7F3EC / #1C1A17</span><span class="sw"><i style="background:var(--surface)"></i>sheet #FFFDF9 / #25221E</span><span class="sw"><i style="background:var(--text)"></i>ink #29251F / #EEE8DD</span><span class="sw"><i style="background:var(--accent)"></i>moss #3E6A48 / #8FBC92</span><span class="sw"><i style="background:var(--warning-soft)"></i>ochre</span><span class="sw"><i style="background:var(--danger-soft)"></i>clay</span></dd>
<dt>Type</dt><dd>Source Serif 4 (voice, titles) + Source Sans 3 (UI) + Source Code Pro (ids), all OFL. Scale 12 / 14 / 15 / 18 / 22 / 28, body 1.55.</dd>
<dt>Radius</dt><dd>6 / 10 / 16, pills for counts only. Spacing 4 px base, generous (log gap 20, card 18×20).</dd>
<dt>Motion</dt><dd>fast 140 · base 240 · slow 380 · signature 620 ms; standard (.2,0,0,1), emphasised (.3,0,0,1), no overshoot.</dd>
</dl></div>''',
)
