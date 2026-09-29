D = dict(
  file='02-switchboard.html', num='02', name='Switchboard',
  fonts='https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap',
  shared='''
  --font-display:"IBM Plex Sans",-apple-system,system-ui,"Segoe UI",sans-serif;--font-body:"IBM Plex Sans",-apple-system,system-ui,"Segoe UI",sans-serif;--font-mono:"IBM Plex Mono",ui-monospace,Menlo,monospace;--fw-display:600;
  --fs-xs:11px;--fs-sm:12.5px;--fs-md:13.5px;--fs-lg:15px;--fs-xl:18px;--fs-2xl:24px;--lh-body:1.45;--lh-tight:1.3;
  --r-sm:3px;--r-md:5px;--r-lg:7px;
  --btn-h:28px;--sidebar-w:236px;--pane-w:520px;--log-max:720px;--pad-x:20px;--gap-log:12px;--pad-card:12px 14px;--card-indent:36px;
  --dur-instant:0ms;--dur-fast:90ms;--dur-base:160ms;--dur-slow:220ms;--dur-sig:320ms;
  --ease-standard:cubic-bezier(.2,0,0,1);--ease-enter:cubic-bezier(0,0,.2,1);--ease-exit:cubic-bezier(.4,0,1,1);--ease-emph:cubic-bezier(.2,0,0,1);''',
  light='''
  --bg:#F5F6F8;--bg-sunken:#ECEEF1;--surface:#FFFFFF;--surface-2:#F9FAFB;--text:#15171C;--text-2:#434956;--text-3:#5F6674;
  --border:#E0E3E8;--border-strong:#C8CDD5;--accent:#2D59D0;--accent-contrast:#FFFFFF;--accent-soft:#E5EBFB;--accent-text:#2349AF;
  --success-soft:#DFF2E7;--success-text:#15653D;--warning-soft:#FBEFD6;--warning-text:#7F5100;--danger-soft:#FBE3E3;--danger-text:#A11F1F;
  --focus:#2D59D0;--owner-bubble:#15171C;--owner-text:#F5F6F8;
  --shadow-1:0 1px 0 rgba(20,24,32,.05);--shadow-2:0 6px 18px -6px rgba(20,24,32,.25);--shadow-3:0 -10px 30px -10px rgba(20,24,32,.3);''',
  dark='''
  --bg:#0E1014;--bg-sunken:#0A0B0E;--surface:#161920;--surface-2:#12151A;--text:#E4E7EC;--text-2:#A7AEBA;--text-3:#818999;
  --border:#232830;--border-strong:#333A46;--accent:#7096FF;--accent-contrast:#0A1024;--accent-soft:#19223A;--accent-text:#9CB5FF;
  --success-soft:#0F2A1C;--success-text:#5ED49B;--warning-soft:#2D230E;--warning-text:#F0C060;--danger-soft:#331616;--danger-text:#FF8A8A;
  --focus:#9CB5FF;--owner-bubble:#E4E7EC;--owner-text:#0E1014;
  --shadow-1:0 0 0 rgba(0,0,0,0);--shadow-2:0 8px 22px -6px rgba(0,0,0,.7);--shadow-3:0 -10px 30px -10px rgba(0,0,0,.8);''',
  css='''
/* Switchboard: dense, keyboard-first; board beside the conversation, decisions commit to a log */
.app[data-app=mac] .btn kbd,.app[data-app=mac] .card .btn kbd{display:inline-block;background:transparent;border-color:currentColor;color:inherit;opacity:.7;padding:2px 4px}
.card__num,.card__meta,.msg__meta time,.convo__sub,.side-prod small{font-family:var(--font-mono)}
.card{box-shadow:none;gap:10px}
.card__title{font-size:14.5px}
.card__kind{text-transform:uppercase;letter-spacing:.06em;font-size:10.5px}
.rec{border:1px solid color-mix(in oklab,var(--accent) 30%,transparent);gap:0}
.msg{gap:10px}.avatar{width:24px;height:24px;border-radius:var(--r-sm);font-size:9px}
.msg--owner .bubble{border-radius:var(--r-lg);font-family:var(--font-mono);font-size:12.5px}
.receipt{font-family:var(--font-mono);font-size:12px;padding:6px 10px;border-radius:var(--r-sm);background:var(--surface-2);border:1px solid var(--border);border-left:3px solid var(--success-text)}
.receipt--negative{border-left-color:var(--danger-text)}.receipt--neutral{border-left-color:var(--text-3)}
.receipt__icon{width:18px;height:18px;border-radius:var(--r-sm)}
.receipt__body{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto}
.receipt{--receipt-indent:28px}
.receipt__verb{text-transform:uppercase;letter-spacing:.04em}
.app[data-app=phone] .receipt{flex-wrap:wrap}
.app[data-app=phone] .receipt__body{white-space:normal}
.card.is-committing{border-color:var(--success-text);transition:border-color var(--dur-fast) linear}
.card.is-committing.tone-negative{border-color:var(--danger-text)}.card.is-committing.tone-neutral{border-color:var(--text-3)}
.commit-chip{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 10px;border-radius:var(--r-sm);font-family:var(--font-mono);font-size:11px;background:var(--success-soft);color:var(--success-text);transform-origin:50% 100%}
.commit-chip b{text-transform:uppercase;letter-spacing:.08em}
.commit-chip--negative{background:var(--danger-soft);color:var(--danger-text)}.commit-chip--neutral{background:var(--bg-sunken);color:var(--text-2)}
.count{border-radius:var(--r-sm);font-family:var(--font-mono);position:relative}
.side-prod .meter{display:block;margin-top:4px;height:2px}
.side-item{min-height:30px}
.side-prod{align-items:flex-start;padding-top:6px;padding-bottom:6px}
.side-prod .prod-mono{width:22px;height:22px;font-size:11px;margin-top:1px}
.pane .metrics{grid-template-columns:repeat(4,1fr)}
.pane .cols{grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.pane .col{background:var(--bg-sunken);border-radius:var(--r-md);padding:8px}
.pane .item{grid-template-columns:auto 1fr;gap:2px 6px;padding:6px 7px;font-size:12px}
.pane .item .tier{grid-column:1/-1;justify-self:start}
.tier{border-radius:var(--r-sm);font-family:var(--font-mono);font-size:10px;text-transform:uppercase;letter-spacing:.04em}
.board{gap:12px;padding:14px 16px 20px}
.p-strip{display:flex;align-items:center;gap:8px;width:100%;flex:none;height:34px;padding:0 14px;border:0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);background:var(--surface-2);font-family:var(--font-mono);font-size:11px;color:var(--text-2);text-align:left}
.p-strip .meter{width:48px;height:3px}
.p-strip .sdot{margin:0}
.p-strip .ico{margin-left:auto;width:14px;height:14px}
.p-head{padding-bottom:4px}
.tabs button{font-size:10.5px}
.app[data-app=mac] .ov-grid{grid-template-columns:1fr;gap:4px}
.app[data-app=mac] .ov{grid-template-columns:minmax(200px,1.3fr) 1.2fr 110px 1.3fr;align-items:center;padding:8px 12px;border-radius:var(--r-md)}
.app[data-app=mac] .ov .meter{height:4px}
.need{border-radius:var(--r-md);padding:10px 12px}
.need__title{font-size:13.5px}
.ptag{border-radius:var(--r-sm)}
.ptag .prod-mono{border-radius:var(--r-sm)}
''',
  js='''
const DIR = {
  id: 'switchboard', boardOpenByDefault: true, rollCounts: true,
  morph: { dur: '--dur-slow', ease: '--ease-standard' },
  // The answer flips in as a status chip ("committing"), then the card collapses into one log line.
  async before({ node, tone, verb, H }) {
    node.classList.add('is-committing', `tone-${tone}`);
    const chip = document.createElement('span');
    chip.className = `commit-chip commit-chip--${tone}`;
    const b = document.createElement('b'); b.textContent = verb;
    const s = document.createElement('span'); s.textContent = 'writing to GitHub';
    chip.append(b, s);
    node.querySelector('.card__actions').replaceChildren(chip);
    await H.play(chip, [{ transform: 'perspective(240px) rotateX(80deg)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: H.ms('--dur-base'), easing: H.cssVar('--ease-standard') });
    await H.wait(H.ms('--dur-sig'));
    s.textContent = 'recorded';
    await H.wait(H.ms('--dur-base'));
  },
};''',
  note='''
<div class="note__grid"><div>
<p><b>Idea.</b> A dense, keyboard-first control room: on the Mac the sprint board is open beside the conversation, every project shows its sprint progress in the sidebar, and numbers and ids are set in mono. Graphite neutrals, one signal-blue accent; colour otherwise only carries status.</p>
<p><b>Signature moment.</b> Commit to log: your answer flips in as a status chip ("APPROVED · writing to GitHub → recorded"), the card collapses into a single mono log line, and the needs-you counters roll down. Reduced motion: instant swap, 120 ms fade, no roll.</p>
<p class="try">Try: click in the Mac window, focus #13 and press A; B toggles the board, F artifacts, Y needs you, / filters projects. On iPhone the strip under the header opens the board.</p>
</div><dl class="tok">
<dt>Colour</dt><dd><span class="sw"><i style="background:var(--bg)"></i>graphite bg #F5F6F8 / #0E1014</span><span class="sw"><i style="background:var(--surface)"></i>panel #FFF / #161920</span><span class="sw"><i style="background:var(--text)"></i>text #15171C / #E4E7EC</span><span class="sw"><i style="background:var(--accent)"></i>signal #2D59D0 / #7096FF</span><span class="sw"><i style="background:var(--success-text)"></i>ok</span><span class="sw"><i style="background:var(--danger-text)"></i>fail</span></dd>
<dt>Type</dt><dd>IBM Plex Sans + IBM Plex Mono (OFL). Scale 11 / 12.5 / 13.5 / 15 / 18 / 24, body 1.45.</dd>
<dt>Radius</dt><dd>3 / 5 / 7, square-ish. Spacing 4 px base, tight (log gap 12, card 12×14).</dd>
<dt>Motion</dt><dd>fast 90 · base 160 · slow 220 · signature 320 ms; standard (.2,0,0,1), no overshoot.</dd>
</dl></div>''',
)
