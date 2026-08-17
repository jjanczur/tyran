#!/usr/bin/env node
import { FORBIDDEN } from './invisible.mjs';
// Interpolated into the client script below rather than typed there as a
// literal. It was a literal `1`, cost.mjs bumped to 2, and the Spend tab
// started rejecting the very payload its own server was sending — the whole
// tab replaced by "a format this page does not know". ADR-21 exactly: one
// answer, one place. No cycle: cost.mjs does not import this file.
import { COST_SCHEMA } from './cost.mjs';
/**
 * board-html — the one page an operator stares at overnight.
 *
 * Renders the cross-initiative board payload (see board.mjs) as a single
 * self-contained HTML file: inline CSS, inline JS, no network requests, works
 * over file://. A <meta refresh> keeps it current — fetch() of a sibling file
 * is blocked over file:// in Chromium, so meta-refresh is the one reliable
 * primitive; under `board.mjs --serve` the same refresh hits the server.
 *
 * ## Five tabs, because the page answers five questions
 *
 * Overview (what is the state), Board (where is every ticket), Waiting on you
 * (what is blocked on a decision, and how to answer it), Spend (what it
 * cost). They were competing for one scroll. The queue keeps its count in the
 * tab label, so "something is waiting on me" survives being on another tab.
 *
 * ## Style: the landing page's system, muted
 *
 * Roles are the landing page's — one warm accent for the operator's call to
 * action, a cool one for the agent strip, red for refusal, green for the
 * ledger's `+`. The TONES are deliberately pulled back from the first
 * version (operator-decided 2026-08-14: "a bit too flashy"), which filled
 * whole bars and whole cards at full saturation. Saturation is now spent on
 * text, edges and 3px rails; every large fill is a muted tone of the same
 * hue. System font stacks, no web fonts, dark only.
 *
 * ## Safety
 *
 * Three layers, each pinned by a test that fails with the layer removed:
 * board.json is already invisible-escaped (`jsonEscapeInvisible`); the JSON
 * embedded in the page additionally escapes `<` as < so a journal value
 * containing `</script>` cannot break out; and the client renders with
 * createElement/textContent ONLY — no innerHTML anywhere.
 *
 * Determinism: the page shows "as of <newest event ts>", never the wall
 * clock, so `--check` covers board.html byte-for-byte. Ages in the agent
 * strip are computed client-side from Date.now() — the one place a clock is
 * allowed, because it runs in the viewer's browser, not in the artifact.
 */

const CSS = `
:root{
  /* Warm near-black ground, unchanged in role. The accents below are the
     change: the first version filled whole bars and whole cards at full
     saturation, which reads as an alarm rather than as information. Colour is
     now spent on small things — text, edges, a 3px rail — and every large
     fill drops to a muted tone of the same hue. */
  --bg:#141210;--bg-raised:#1c1a16;--bg-sunken:#100e0c;
  --text:#cec7ba;--heading:#ece5d7;--muted:#8f8779;
  --hairline:#332e27;--hairline-soft:#26221d;
  --brass:#a8863c;--brass-bright:#cfae63;--brass-low:#221c11;--brass-edge:#5d4c22;
  --steel:#7d9ea9;--steel-bright:#9dbcc6;--steel-low:#17242a;--steel-edge:#3a545d;
  --clay:#c07a70;--clay-bright:#d9998f;--clay-low:#2a1a18;--clay-edge:#5a3430;
  --sage:#88a06a;--sage-bright:#a3ba86;
  --display:ui-serif,'Iowan Old Style','Palatino Linotype',Palatino,'Book Antiqua',Georgia,'Times New Roman',serif;
  --font:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;
  --radius:0.6rem;color-scheme:dark;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);font-size:1rem;line-height:1.55;-webkit-font-smoothing:antialiased;padding:1.25rem}
main{max-width:70rem;margin:0 auto}
h1{font-family:var(--display);color:var(--heading);font-size:1.5rem;margin:0 0 .2rem;font-weight:600}
h2{font-family:var(--display);color:var(--heading);font-size:1.02rem;margin:1.4rem 0 .5rem;border-bottom:1px solid var(--hairline-soft);padding-bottom:.3rem;font-weight:600}
h3{font-family:var(--font);color:var(--heading);font-size:.85rem;margin:1.1rem 0 .2rem;font-weight:650}
.meta{color:var(--muted);font-family:var(--mono);font-size:.78rem}

/* ---- tabs ---- */
.tabs{display:flex;flex-wrap:wrap;gap:.3rem;margin:.9rem 0 1.1rem;border-bottom:1px solid var(--hairline);padding-bottom:.5rem;position:sticky;top:0;background:var(--bg);z-index:5}
.tabs button{font-family:var(--font);font-size:.82rem;font-weight:600;letter-spacing:.01em;background:transparent;color:var(--muted);border:1px solid transparent;border-radius:.4rem;padding:.34rem .8rem;cursor:pointer}
.tabs button:hover{color:var(--text);background:var(--bg-raised)}
.tabs button[aria-selected="true"]{color:var(--brass-bright);background:var(--brass-low);border-color:var(--brass-edge)}
.tabs button:focus-visible{outline:2px solid var(--steel);outline-offset:2px}
.tabs .count{font-family:var(--mono);font-size:.72rem;opacity:.85;margin-left:.3rem}
.panel[hidden]{display:none}
.hint{color:var(--muted);font-size:.82rem;margin:.2rem 0 .9rem;max-width:52rem}

/* ---- banners ---- */
.paused{background:var(--clay-low);border:1px solid var(--clay);border-left:3px solid var(--clay);color:var(--clay);border-radius:var(--radius);padding:.55rem .85rem;margin:.7rem 0;font-weight:600;font-size:.9rem}

/* ---- tiles ---- */
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(10.5rem,1fr));gap:.55rem;margin:.5rem 0 .2rem}
.stile{background:var(--bg-raised);border:1px solid var(--hairline);border-radius:.5rem;padding:.6rem .8rem}
.stile .lbl{display:block;font-family:var(--mono);font-size:.63rem;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}
.stile .big{display:block;font-family:var(--mono);font-size:1.3rem;color:var(--heading);font-variant-numeric:tabular-nums;line-height:1.3}
.stile .sub{display:block;font-family:var(--mono);font-size:.68rem;color:var(--muted)}
.stile.lead{border-color:var(--brass-edge)}
.stile.lead .big{color:var(--brass-bright)}
.stile.warn{border-color:var(--clay)}
.stile.warn .big{color:var(--clay)}

/* ---- agents ---- */
.agents{display:flex;flex-wrap:wrap;gap:.45rem}
.agent{background:var(--bg-raised);border:1px solid var(--hairline);border-left:3px solid var(--steel-edge);border-radius:.45rem;padding:.42rem .65rem;font-family:var(--mono);font-size:.76rem;min-width:15rem}
.agent .name{color:var(--steel-bright);font-weight:600}
.agent .age-fresh{color:var(--sage)}
.agent .age-warm{color:var(--brass-bright)}
.agent .age-cold{color:var(--clay)}
/* Stale is a SERVER verdict in journal time, so it marks the whole chip rather
   than joining the wall-clock age colours below — two different questions must
   not share one vocabulary. Muted border, not red: an abandoned agent is a
   bookkeeping fact, while the red below is "this died mid-flight". */
.agent.stale{border-left-color:var(--brass);opacity:.82}
.agent .stale-mark{color:var(--brass-bright);font-weight:600}
/* A dead agent gets the only bold red on the page: three hours of silence is
   a different event from thirty minutes, and it used to share a colour. */
.agent .age-dead{color:var(--clay-bright);font-weight:700}

/* ---- what did not render ---- */
.damaged{background:var(--bg-raised);border-left:3px solid var(--brass);border-radius:.45rem;padding:.42rem .65rem;margin:.3rem 0;font-family:var(--mono);font-size:.78rem;color:var(--brass-bright)}
.err{background:var(--bg-raised);border-left:3px solid var(--clay);border-radius:.45rem;padding:.6rem .75rem;color:var(--clay-bright);font-size:.85rem}

/* ---- what moved while you were away ---- */
.moved{background:var(--brass-low);border:1px solid var(--brass-edge);border-radius:var(--radius);padding:.5rem .75rem;margin:.6rem 0;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;color:var(--brass-bright);font-size:.85rem}
.markseen{background:var(--bg-raised);color:var(--text);border:1px solid var(--hairline);border-radius:.4rem;padding:.25rem .6rem;font:inherit;font-size:.78rem;cursor:pointer}
.markseen:hover{border-color:var(--brass-edge);color:var(--brass-bright)}
.card .movedtag{display:inline-block;background:var(--brass-low);color:var(--brass-bright);border:1px solid var(--brass-edge);border-radius:.3rem;padding:0 .3rem;font-size:.65rem;margin-left:.3rem;letter-spacing:.04em}

/* ---- filter ---- */
.filter{display:flex;gap:.6rem;align-items:center;margin:.5rem 0 .7rem}
.filter input{background:var(--bg-sunken);color:var(--text);border:1px solid var(--hairline);border-radius:.4rem;padding:.35rem .6rem;font:inherit;font-size:.82rem;min-width:20rem;max-width:100%}
.filter input:focus{outline:none;border-color:var(--steel-edge)}

/* ---- the files an initiative actually has ---- */
.files{display:flex;flex-direction:column;gap:.2rem;margin-top:.3rem}
.file{display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap;font-size:.76rem}
.file .fname{color:var(--steel-bright);font-family:var(--mono);font-weight:600;min-width:6rem}
.file code{color:var(--muted);font-size:.72rem;word-break:break-all}

/* ---- lanes ---- */
.lanes{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:.6rem;align-items:start}
.lane{background:var(--bg-sunken);border:1px solid var(--hairline-soft);border-radius:var(--radius);padding:.55rem}
.lane h4{margin:0 0 .35rem;font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-family:var(--font);font-weight:650}
.lane h4 .count{color:var(--text);font-family:var(--mono)}
.lane.blocked{border-color:var(--clay)}
.lane.blocked h4 .count{color:var(--clay)}
.lane.done h4 .count{color:var(--sage)}
.lane.waiting-operator{border-color:var(--brass-edge)}
.lane.waiting-operator h4 .count{color:var(--brass-bright)}
.card{background:var(--bg-raised);border:1px solid var(--hairline);border-radius:.4rem;padding:.38rem .5rem;margin:.28rem 0;font-size:.82rem;cursor:pointer;text-align:left;width:100%;font-family:var(--font);color:var(--text);display:block}
.card:hover{border-color:var(--steel-edge)}
.card[aria-pressed="true"]{border-color:var(--brass);background:var(--brass-low)}
.card:focus-visible{outline:2px solid var(--steel);outline-offset:1px}
.card .id{font-family:var(--mono);color:var(--heading)}
.card .init{font-family:var(--mono);color:var(--muted);font-size:.68rem}
.card .note{color:var(--muted);font-size:.74rem;display:block}
.card .note.age-warm{color:var(--brass)}
.card .note.age-cold{color:var(--clay)}
.card .note.age-dead{color:var(--clay-bright);font-weight:600}
.empty{color:var(--hairline);font-size:.78rem}

/* ---- detail ---- */
.detail{background:var(--bg-raised);border:1px solid var(--hairline);border-left:3px solid var(--brass-edge);border-radius:var(--radius);padding:.8rem 1rem;margin:.9rem 0 0}
.detail .dt{font-family:var(--mono);color:var(--heading);font-size:.95rem}
.detail dl{display:grid;grid-template-columns:auto 1fr;gap:.2rem .8rem;margin:.5rem 0 0;font-size:.84rem}
.detail dt{font-family:var(--mono);font-size:.68rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);padding-top:.16rem}
.detail dd{margin:0;color:var(--text)}

/* ---- questions ---- */
.ask{background:var(--brass-low);border:1px solid var(--brass-edge);border-left:3px solid var(--brass);border-radius:var(--radius);padding:.7rem .9rem;margin:.5rem 0}
.ask .q{color:var(--brass-bright);font-size:1rem;font-weight:600}
.ask .row{margin-top:.22rem;font-size:.86rem}
.ask .label{color:var(--muted);text-transform:uppercase;font-size:.66rem;letter-spacing:.07em;margin-right:.4rem;font-family:var(--mono)}
.ask .kindtag{display:inline-block;font-family:var(--mono);font-size:.63rem;letter-spacing:.06em;text-transform:uppercase;border-radius:.25rem;padding:.1rem .4rem;margin-bottom:.35rem}
.ask .kindtag.blocking{background:var(--clay-low);color:var(--clay-bright);border:1px solid var(--clay-edge)}
.ask .kindtag.decision{background:var(--steel-low);color:var(--steel-bright);border:1px solid var(--steel-edge)}
.reply{margin-top:.6rem;border-top:1px solid var(--brass-edge);padding-top:.55rem}
.reply textarea{display:block;width:100%;font-family:var(--font);font-size:.86rem;background:var(--bg-raised);color:var(--text);border:1px solid var(--hairline);border-radius:.35rem;padding:.4rem .55rem;min-height:3.4rem;resize:vertical}
.reply textarea:focus-visible{outline:2px solid var(--steel);outline-offset:1px}
.reply textarea:disabled{opacity:.55;cursor:not-allowed}
.reply .acts{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;margin-top:.4rem}
.reply .hint{font-size:.75rem;color:var(--muted);margin-top:.3rem}
pre.how{background:var(--bg-sunken);border:1px solid var(--hairline);border-radius:.45rem;padding:.7rem .85rem;font-family:var(--mono);font-size:.76rem;color:var(--text);overflow-x:auto;margin:.4rem 0 .7rem}
pre.how .c{color:var(--muted)}

/* ---- spend ---- */
.spend-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:.7rem}
.toggle{display:flex;gap:.25rem;margin-left:auto}
.toggle button{font-family:var(--mono);font-size:.68rem;letter-spacing:.06em;text-transform:uppercase;background:var(--bg-raised);color:var(--muted);border:1px solid var(--hairline);border-radius:.3rem;padding:.18rem .55rem;cursor:pointer}
.toggle button[aria-pressed="true"]{background:var(--brass-low);border-color:var(--brass-edge);color:var(--brass-bright)}
.toggle button:focus-visible{outline:2px solid var(--steel);outline-offset:2px}
.comp{display:flex;height:1.35rem;border:1px solid var(--hairline);border-radius:.3rem;overflow:hidden;margin-top:.5rem}
.comp span{display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:.63rem;color:var(--bg);font-weight:700;white-space:nowrap;overflow:hidden}
.comp .s-cache_read{background:var(--brass)}
.comp .s-cache_write{background:var(--steel)}
/* The 1-hour write is its own segment because it is its own PRICE — 2x base
   input against the 5-minute write's 1.25x. Without a distinct colour the
   most expensive caching decision on the page is invisible. */
.comp .s-cache_write_1h{background:var(--ink)}
/* ---- initiatives ---- */
.inits{display:flex;flex-direction:column;gap:.3rem;margin:.5rem 0}
.initrow{display:grid;grid-template-columns:minmax(0,1.6fr) 5rem auto minmax(0,1fr);
  gap:.6rem;align-items:center;padding:.35rem .5rem;border-radius:4px}
/* An initiative nobody can move without the operator is the one thing on this
   section worth catching an eye. */
.initrow.waiting{background:color-mix(in srgb,var(--brass) 12%,transparent)}
.initrow .il{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.initrow .islug{color:var(--muted);margin-left:.4rem;font-size:.85em}
.initrow .ib{height:6px;background:var(--line);border-radius:3px;overflow:hidden}
.initrow .ib i{display:block;height:100%;background:var(--sage)}
.initrow .iv,.initrow .iw{color:var(--muted);font-size:.9em;white-space:nowrap}
.initrow .iw.warn{color:var(--brass);font-weight:600}

/* ---- the per-day series ---- */
.days{display:flex;align-items:flex-end;gap:2px;height:74px;margin:.5rem 0 .3rem;
  overflow-x:auto;padding-bottom:2px}
.day{flex:1 0 6px;min-width:6px;height:100%;display:flex;align-items:flex-end}
.day i{display:block;width:100%;background:var(--brass);border-radius:1px 1px 0 0}
/* Outside the chosen window: context, not absence. */
.day.out i{background:var(--line)}
.comp .s-output{background:var(--sage)}
.comp .s-input{background:var(--muted)}
.compkey{display:flex;flex-wrap:wrap;gap:.85rem;font-family:var(--mono);font-size:.66rem;color:var(--muted);margin-top:.3rem}
.compkey i{display:inline-block;width:.55rem;height:.55rem;border-radius:.12rem;margin-right:.3rem}
.chart{display:flex;flex-direction:column;gap:.24rem;margin-top:.35rem}
.chartrow{display:grid;grid-template-columns:minmax(7rem,13rem) 1fr auto;gap:.55rem;align-items:center;font-size:.78rem}
.chartrow .rl{font-family:var(--mono);color:var(--heading);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chartrow .rb{background:var(--bg-sunken);border-radius:.2rem;height:.75rem;overflow:hidden}
.chartrow .rb i{display:block;height:100%;background:var(--brass);border-radius:.2rem;opacity:.85}
.chartrow.dim .rl{color:var(--muted);font-style:italic}
.chartrow.dim .rb i{background:var(--hairline)}
.chartrow .rv{font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--text);min-width:5.5rem;text-align:right}

/* ---- settings ---- */
.setnote{border:1px solid var(--hairline);border-left:3px solid var(--steel);border-radius:.4rem;padding:.6rem .8rem;margin:.2rem 0 1.2rem;font-size:.85rem;color:var(--muted);line-height:1.6}
.setnote.warn{border-left-color:var(--brass)}
.setnote.bad{border-left-color:var(--clay)}
.setnote b{color:var(--heading);font-weight:600}
.setnote code{font-family:var(--mono);font-size:.8rem;color:var(--brass-bright);background:var(--brass-low);padding:.08rem .3rem;border-radius:.25rem}
.sgroup{margin:0 0 1.6rem}
.sgroup .blurb{font-size:.85rem;color:var(--muted);line-height:1.6;margin:.15rem 0 .9rem;max-width:60rem}
.srow{display:grid;grid-template-columns:minmax(10rem,14rem) 1fr;gap:.4rem 1.1rem;padding:.75rem 0;border-top:1px solid var(--hairline);align-items:start}
.srow .sname{font-weight:600;color:var(--heading);font-size:.88rem;padding-top:.3rem}
.srow .sname .sunit{font-family:var(--mono);font-weight:400;color:var(--muted);font-size:.76rem}
.srow .sbody{min-width:0}
.srow select,.srow input[type="text"],.srow textarea{display:block;font-family:var(--font);font-size:.85rem;background:var(--bg-raised);color:var(--text);border:1px solid var(--hairline);border-radius:.35rem;padding:.3rem .5rem;max-width:32rem;width:100%}
.srow textarea{font-family:var(--mono);font-size:.8rem;line-height:1.7;min-height:5rem;resize:vertical}
.srow input[type="number"]{display:block;font-family:var(--mono);font-size:.85rem;background:var(--bg-raised);color:var(--text);border:1px solid var(--hairline);border-radius:.35rem;padding:.3rem .5rem;width:7rem}
.srow select:focus-visible,.srow input:focus-visible,.srow textarea:focus-visible{outline:2px solid var(--steel);outline-offset:1px}
.srow select:disabled,.srow input:disabled,.srow textarea:disabled{opacity:.55;cursor:not-allowed}
.srow .shelp{font-size:.8rem;color:var(--muted);line-height:1.6;margin-top:.35rem;max-width:52rem}
.srow .schoice{font-size:.8rem;color:var(--text);line-height:1.6;margin-top:.3rem;padding-left:.6rem;border-left:2px solid var(--steel-edge)}
.sstat{font-family:var(--mono);font-size:.75rem;line-height:1.7;margin-top:.35rem;color:var(--muted);word-break:break-word;white-space:pre-wrap}
.sstat.ok{color:var(--sage-bright)}
.sstat.bad{color:var(--clay-bright)}
.sbtn{font-family:var(--font);font-size:.78rem;font-weight:600;background:var(--brass-low);color:var(--brass-bright);border:1px solid var(--brass-edge);border-radius:.35rem;padding:.26rem .7rem;cursor:pointer;margin-top:.4rem}
.sbtn:hover:not(:disabled){background:var(--brass-edge)}
.sbtn:disabled{opacity:.5;cursor:not-allowed}
.sbtn.danger{background:var(--clay-low);color:var(--clay-bright);border-color:var(--clay-edge);margin-top:.5rem}
.sbtn.danger:hover:not(:disabled){background:var(--clay-edge);color:var(--heading)}
.rule{display:grid;grid-template-columns:1fr minmax(7rem,9rem);gap:.3rem .9rem;padding:.6rem 0;border-top:1px solid var(--hairline);align-items:start}
.rule .glob{font-family:var(--mono);font-size:.82rem;color:var(--heading);word-break:break-all}
.rule .why{font-size:.78rem;color:var(--muted);line-height:1.6;grid-column:1;max-width:52rem}
.rule .lock{font-family:var(--mono);font-size:.72rem;color:var(--clay-bright);border:1px solid var(--clay-edge);background:var(--clay-low);border-radius:.3rem;padding:.16rem .4rem;text-align:center;align-self:start}
.rule .sstat{grid-column:1 / -1}
.caveat{color:var(--muted);font-size:.76rem;margin-top:.5rem;max-width:52rem}
footer{margin-top:2rem;color:var(--muted);font-size:.72rem;border-top:1px solid var(--hairline-soft);padding-top:.6rem}
`;

/**
 * The FORBIDDEN ranges as a regex character class, generated rather than
 * retyped: this is the same question `escapeInvisible` answers, and ADR-21
 * gives it one answer. Emitted as `\u{...}` escapes so this file's own bytes
 * stay ASCII — writing the characters themselves is what the write guard
 * refuses, and it refused this very edit once.
 */
const CLIENT_INVISIBLE_CLASS = FORBIDDEN.map(({ lo, hi }) => {
  const cp = (n) => `\\u{${n.toString(16).toUpperCase()}}`;
  return lo === hi ? cp(lo) : `${cp(lo)}-${cp(hi)}`;
}).join('');

const CLIENT_JS = `
'use strict';
var data = JSON.parse(document.getElementById('board-data').textContent);
if (data.schema !== 1) {
  document.getElementById('app').textContent = 'This board.json is schema ' + data.schema + ' — regenerate with a newer Tyran.';
} else {
  // board.json's escaping is LOSSLESS — JSON.parse hands the browser the
  // original codepoints back — so the page is where invisibles must be
  // neutralised. They cannot inject (textContent never parses markup), but an
  // unterminated right-to-left override mirrors every character after it and
  // rewrites the page a human is reading, and TAG characters map one-to-one
  // onto ASCII while rendering as nothing. Escaped, never dropped: a value the
  // operator cannot see is a value they cannot judge.
  var INVISIBLE = new RegExp('[${CLIENT_INVISIBLE_CLASS}]', 'gu');
  var show = function (value) {
    return String(value).replace(INVISIBLE, function (ch) {
      return '\\\\u' + ch.codePointAt(0).toString(16).toUpperCase();
    });
  };
  var el = function (tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = show(text);
    return node;
  };
  var clear = function (node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  };

  var totals = data.totals || {};
  var asks = data.asks || [];
  var agents = data.agents || [];
  var lanes = data.lanes || {};
  var errors = data.errors || [];
  var cost = null;
  var costError = null;
  var spendWindow = '30d';

  // How the period reads to a person. The window carries machine dates; a
  // reader wants "last 30 days", and for the billing period the actual start
  // date, because that is the number they can check against their invoice.
  var windowLabel = function (payload) {
    var w = payload && payload.window;
    if (!w) return 'all time';
    if (w.name === 'period') return 'this billing period, since ' + w.from;
    if (w.name === '30d') return 'last 30 days';
    return w.from + ' to ' + w.to;
  };

  // The queue count, in the browser tab. The whole point of this page is that
  // you can leave it open while agents work overnight, and a background tab
  // was saying nothing at all — the count existed only on a tab you had to be
  // looking at to see.
  try {
    document.title = (asks.length > 0 ? '(' + asks.length + ') ' : '') + 'Tyran board';
  } catch (e) { /* a title is a nicety; never let it take the page down */ }

  // ---- what moved since you last acknowledged it ------------------------
  //
  // The page is a snapshot; the journal is a timeline. Someone who leaves
  // agents running overnight comes back to ten lanes and has to re-read all
  // of them to find the two that moved.
  //
  // The baseline is only replaced when the operator presses "Mark seen" —
  // deliberately NOT on load, because the page reloads itself every 30
  // seconds and an auto-updating baseline would mean "since you last looked"
  // was always "since half a minute ago", which is the same as nothing.
  // localStorage can throw outright (Safari over file://, a private window),
  // so every access degrades to "no baseline" rather than to a broken page.
  var SEEN_KEY = 'tyran-board-seen-v1';
  var laneOfCard = {};
  Object.keys(lanes).forEach(function (lane) {
    (lanes[lane] || []).forEach(function (c) { laneOfCard[(c.init || '') + '/' + c.id] = lane; });
  });
  var readSeen = function () {
    try {
      var raw = localStorage.getItem(SEEN_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  };
  var writeSeen = function () {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ at: new Date().toISOString(), cards: laneOfCard }));
      return true;
    } catch (e) { return false; }
  };
  var seen = readSeen();
  var moved = {};
  var movedCount = 0;
  if (seen && seen.cards) {
    Object.keys(laneOfCard).forEach(function (key) {
      var was = seen.cards[key];
      if (was === undefined) { moved[key] = 'new'; movedCount += 1; }
      else if (was !== laneOfCard[key]) { moved[key] = was; movedCount += 1; }
    });
  }

  var app = document.getElementById('app');
  var head = el('div');
  head.appendChild(el('h1', null, 'Tyran board'));
  head.appendChild(el('div', 'meta',
    (totals.initiatives || 0) + ' initiative(s) · ' + (totals.merged || 0) + '/' + (totals.tickets || 0) +
    ' tickets merged (' + (totals.percent || 0) + '%) · as of ' + (data.as_of || 'unknown')));
  app.appendChild(head);

  // ---- tabs -------------------------------------------------------------
  // The board answers four different questions and they were competing for
  // one scroll. Each gets a panel; the queue keeps its count in the tab, so
  // "something is waiting on me" survives being on another tab.
  var tabbar = el('div', 'tabs');
  tabbar.setAttribute('role', 'tablist');
  var panels = {};
  var buttons = {};
  var TABS = [
    ['overview', 'Overview', null],
    ['board', 'Board', null],
    ['questions', 'Waiting on you', asks.length],
    ['spend', 'Spend', null],
    ['settings', 'Settings', null],
  ];
  var select = function (key) {
    for (var i = 0; i < TABS.length; i += 1) {
      var k = TABS[i][0];
      var on = k === key;
      buttons[k].setAttribute('aria-selected', on ? 'true' : 'false');
      panels[k].hidden = !on;
    }
  };
  TABS.forEach(function (spec) {
    var b = el('button', null, spec[1]);
    b.setAttribute('type', 'button');
    b.setAttribute('role', 'tab');
    if (spec[2] !== null && spec[2] !== undefined) b.appendChild(el('span', 'count', '(' + spec[2] + ')'));
    b.addEventListener('click', function () { select(spec[0]); });
    buttons[spec[0]] = b;
    tabbar.appendChild(b);
    var p = el('div', 'panel');
    p.setAttribute('role', 'tabpanel');
    panels[spec[0]] = p;
  });
  app.appendChild(tabbar);
  TABS.forEach(function (spec) { app.appendChild(panels[spec[0]]); });

  var tile = function (label, big, sub, cls) {
    var box = el('div', cls ? 'stile ' + cls : 'stile');
    box.appendChild(el('span', 'lbl', label));
    box.appendChild(el('span', 'big', big));
    box.appendChild(el('span', 'sub', sub));
    return box;
  };

  // One staleness vocabulary, used by the agent strip, the logged errors and
  // the lane cards. Three renderings of "how long ago" would let the same
  // gap read as fine in one place and alarming in another.
  //
  // This is the only clock on the page. The ARTEFACT never reads one — "as of"
  // is the newest event timestamp, which is what keeps --check valid for the
  // HTML — so every age here is computed in the reader's own browser.
  var ageMsOf = function (ts) {
    if (!ts) return null;
    var t = Date.parse(ts);
    return isNaN(t) ? null : Date.now() - t;
  };
  var ageClass = function (ms) {
    if (ms === null) return 'age-cold';
    return ms < 600000 ? 'age-fresh' : ms < 1800000 ? 'age-warm' : ms < 10800000 ? 'age-cold' : 'age-dead';
  };
  var ago = function (ts) {
    var ms = ageMsOf(ts);
    if (ms === null) return 'no time recorded';
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return Math.round(ms / 60000) + ' min ago';
    if (ms < 172800000) return Math.round(ms / 3600000) + ' h ago';
    return Math.round(ms / 86400000) + ' d ago';
  };

  var fmtTokens = function (n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' k';
    return String(n);
  };
  // An amount that rounds to nothing still cost something; printing $0.00
  // there reads as free.
  var fmtUsd = function (v) {
    if (v === null || v === undefined) return '—';
    if (v > 0 && v < 0.01) return '<$0.01';
    return '$' + v.toFixed(2);
  };

  var agentStrip = function () {
    var strip = el('div', 'agents');
    if (agents.length === 0) strip.appendChild(el('div', 'empty', 'none running'));
    agents.forEach(function (a) {
      var chip = el('div', 'agent' + (a.stale ? ' stale' : ''));
      chip.appendChild(el('div', 'name', a.agent + (a.role ? ' · ' + a.role : '')));
      chip.appendChild(el('div', null, (a.init ? a.init + ' · ' : '') + (a.ticket || 'no ticket') + ' · ' + a.state));
      // NOT the same statement as the age lines below, and the wording keeps
      // them apart on purpose. Those are wall-clock: "how long since it spoke,
      // right now, where you are sitting". This one is journal time and comes
      // from the server, where doctor's own threshold computed it — "the
      // initiative moved on without it", which is still true tomorrow and is
      // the same for every reader of this journal. An agent can be quiet for
      // hours without being stale, and stale while chattering every minute.
      if (a.stale) {
        chip.appendChild(el('div', 'stale-mark',
          'STALE — open ' + (a.open_hours === null ? '?' : a.open_hours) + ' h of journal time'));
      }
      if (a.detail) chip.appendChild(el('div', 'note', a.detail));
      // What the agent said it would do next. It has been in board.json since
      // the fold learned to read progress events, and the strip has never
      // shown it — so the chip could say an agent went quiet without saying
      // what it went quiet in the middle of.
      if (a.next) chip.appendChild(el('div', 'note', 'next: ' + a.next));
      // Four buckets, not three. The old top bucket was "30 minutes or six
      // hours", which are not the same event: one is a long test run, the
      // other is an agent that is not coming back.
      var ageMs = ageMsOf(a.last_signal);
      var ageText = ageMs === null ? 'no signal recorded'
        : ageMs >= 10800000 ? Math.round(ageMs / 3600000) + ' HOURS since last signal — likely dead'
        : Math.round(ageMs / 60000) + ' min since last signal';
      chip.appendChild(el('div', ageClass(ageMs), ageText));
      // Signal is what the agent SAID; evidence is what it SHOWED. An agent
      // emitting progress every few minutes while achieving nothing is the
      // healthiest-looking chip on the board, and the strip is sorted by the
      // first of those two, so it also sorts to the bottom.
      var evMs = ageMsOf(a.last_evidence);
      chip.appendChild(el('div', evMs === null ? 'age-cold' : ageClass(evMs),
        evMs === null
          ? 'nothing shown yet'
          : (a.evidence_kind || 'evidence') + ' ' + ago(a.last_evidence)));
      strip.appendChild(chip);
    });
    return strip;
  };

  // ---- overview ---------------------------------------------------------
  var ov = panels.overview;
  // A STOP outranks everything, and it goes first. It is the one state in
  // which a strip of silent agents is the system doing exactly as it was told,
  // and without it that strip reads identically to a fleet that died.
  if (data.stop && data.stop.stopped === true) {
    var stopBox = el('div', 'paused');
    stopBox.appendChild(el('b', null, 'STOPPED \\u2014 '));
    stopBox.appendChild(el('span', null, 'an operator halted this repo: ' + (data.stop.reason || '(no reason given)')));
    stopBox.appendChild(el('div', 'hint', 'Nothing new will be started until .tyran/STOP is deleted. Agents already running are not killed by it.'));
    ov.appendChild(stopBox);
  }
  (data.paused || []).forEach(function (p) {
    ov.appendChild(el('div', 'paused', 'PAUSED — ' + p.init + ': gate ' + p.kind + ' (' + p.result + ') since ' + p.since));
  });
  var laneCount = function (name) { return (lanes[name] || []).length; };
  var ovTiles = el('div', 'tiles');
  ovTiles.appendChild(tile('waiting on you', String(asks.length),
    asks.length === 0 ? 'nothing blocked on a decision' : 'answer them on the next tab', asks.length > 0 ? 'lead' : null));
  // The headline number is the LIVE one. "Agents running" counted every open
  // spawn, so an initiative abandoned a week ago reported a busy fleet; the
  // stale ones are still counted, still listed in the strip, and now said out
  // loud rather than folded into a figure that reads as live work.
  var staleCount = totals.agents_stale || 0;
  ovTiles.appendChild(tile('agents running', String(agents.length - staleCount),
    staleCount > 0
      ? staleCount + ' more stale · across ' + (totals.initiatives || 0) + ' initiative(s)'
      : 'across ' + (totals.initiatives || 0) + ' initiative(s)',
    staleCount > 0 ? 'lead' : null));
  // An initiative with no tickets used to read "0% · 0 of 0 merged", which is
  // exactly what a fully stalled one reads. Nothing-started and
  // nothing-finished are different situations and deserve different words.
  ovTiles.appendChild((totals.tickets || 0) === 0
    ? tile('progress', '—', (totals.initiatives || 0) === 0
        ? 'no initiatives yet — run /tyran to start one'
        : 'no tickets declared yet')
    : tile('progress', (totals.percent || 0) + '%', (totals.merged || 0) + ' of ' + totals.tickets + ' merged'));
  // Counted by the server, from the lanes AND the agents. Counting lanes here
  // read zero while an agent chip on the same screen said "blocked", because a
  // ticket parked by an override leaves no card in the blocked lane.
  var blockedAgents = agents.filter(function (a) { return a.state === 'blocked'; }).length;
  var stuck = totals.blocked !== undefined ? totals.blocked
    : laneCount('blocked') + laneCount('changes-requested') + blockedAgents;
  ovTiles.appendChild(tile('needs a human', String(stuck),
    laneCount('blocked') + ' blocked · ' + laneCount('changes-requested') + ' changes requested · '
      + blockedAgents + ' agent(s) blocked', stuck > 0 ? 'warn' : null));
  ov.appendChild(ovTiles);

  // The bar only appears once there IS a baseline: on a first visit nothing
  // has "changed", and saying so would be noise on the one screen that is
  // supposed to be only signal.
  if (seen) {
    var since = el('div', movedCount > 0 ? 'moved' : 'hint');
    since.appendChild(el('span', null, movedCount > 0
      ? movedCount + ' ticket(s) changed lane since you marked seen (' + seen.at + ')'
      : 'Nothing has moved since you marked seen (' + seen.at + ').'));
    var mark = el('button', 'markseen', 'Mark seen');
    mark.addEventListener('click', function () {
      if (writeSeen()) location.reload();
      else since.appendChild(el('span', 'note', ' — this browser refused to store it'));
    });
    since.appendChild(mark);
    ov.appendChild(since);
  } else {
    var first = el('div', 'hint');
    first.appendChild(el('span', null, 'Mark this board seen and the next visit will tell you what moved while you were away.'));
    var firstBtn = el('button', 'markseen', 'Mark seen');
    firstBtn.addEventListener('click', function () { if (writeSeen()) location.reload(); });
    first.appendChild(firstBtn);
    ov.appendChild(first);
  }

  // ---- initiatives, and the ones that have stopped moving ----------------
  //
  // MEASURED, and the reason this section exists rather than an archive: of 63
  // real journals, 43 were waiting on a question nobody answered and only 6
  // were finished-and-archivable. The board was not cluttered with completed
  // work; it was full of ABANDONED work, and archiving the finished 6 would
  // have removed the only initiatives at 100% and pulled the headline
  // percentage down.
  //
  // "Waiting" is the initiative's own count of open operator questions. The
  // idle time is computed HERE, from last_ts, because the payload is
  // byte-compared and reads no clock — the same split the agent strip uses.
  var inits = Array.isArray(data.initiatives) ? data.initiatives : [];
  if (inits.length > 0) {
    var stalled = inits.filter(function (i) { return i.waiting > 0; }).sort(function (a, b) {
      return (ageMsOf(b.last_ts) || 0) - (ageMsOf(a.last_ts) || 0);
    });
    ov.appendChild(el('h2', null, 'Initiatives'));
    if (stalled.length > 0) {
      ov.appendChild(el('div', 'hint',
        stalled.length + ' of ' + inits.length + ' are waiting on an answer from you. ' +
        'Longest-waiting first — an initiative with an open question does not move until it is answered.'));
    }
    var table = el('div', 'inits');
    var ordered = stalled.concat(inits.filter(function (i) { return !(i.waiting > 0); }));
    ordered.forEach(function (i) {
      var row = el('div', i.waiting > 0 ? 'initrow waiting' : 'initrow');
      // The TITLE, which the journal has carried all along while this page
      // showed a directory slug.
      var label = el('div', 'il');
      label.appendChild(el('b', null, i.title || i.name));
      if (i.title) label.appendChild(el('span', 'islug', i.name));
      row.appendChild(label);
      var bar = el('div', 'ib');
      var fill = el('i');
      fill.style.width = (typeof i.percent === 'number' ? i.percent : 0) + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
      var counts = i.merged + '/' + i.tickets + ' merged';
      // Named only when there is something to name. A findings count of zero
      // on every row is noise that teaches the eye to skip the column.
      if (i.findings > 0) counts += ' \u00b7 ' + i.findings + ' finding' + (i.findings === 1 ? '' : 's');
      row.appendChild(el('div', 'iv', counts));
      var age = ageMsOf(i.last_ts);
      row.appendChild(el('div', i.waiting > 0 ? 'iw warn' : 'iw',
        i.waiting > 0
          ? i.waiting + ' waiting on you \u00b7 quiet ' + ago(i.last_ts)
          : (age === null ? '' : 'last moved ' + ago(i.last_ts))));
      table.appendChild(row);
    });
    ov.appendChild(table);
  }

  ov.appendChild(el('h2', null, 'Agents'));
  // Named, not implied by the order: the strip is sorted stalest-first by the
  // server, and a reader who does not know that reads the first chip as the
  // newest one.
  if (agents.length > 1) ov.appendChild(el('div', 'hint', 'Stalest first — the agent that has said nothing longest is at the top.'));
  ov.appendChild(agentStrip());
  var ovSpend = el('div');
  ov.appendChild(ovSpend);

  // An initiative the board could not read is the one thing this page must
  // never omit: a missing card is indistinguishable from an initiative with
  // no work, which is the "all is well" reading the board exists to prevent.
  if (errors.length > 0) {
    ov.appendChild(el('h2', null, 'Unreadable (' + errors.length + ')'));
    errors.forEach(function (e) {
      ov.appendChild(el('div', 'paused', 'UNREADABLE — ' + e.name + ': ' + e.error));
    });
  }

  // An agent that logged a hard error with no ticket to hang it on used to
  // land in that initiative's STATE.md and nowhere else, so the page whose
  // whole job is to say "not all is well" showed nothing at all.
  var logged = data.errors_logged || [];
  if (logged.length > 0) {
    var total = data.errors_logged_total || logged.length;
    ov.appendChild(el('h2', null, 'Errors logged (' + total + ')'));
    ov.appendChild(el('div', 'hint', 'Agents recorded these as failures. Newest first. An error carrying no ticket belongs to the initiative rather than to any one card, which is why it appears here and in no lane.'));
    logged.forEach(function (e) {
      var text = (e.class || 'error') + (e.detail ? ': ' + e.detail : '')
        + (e.ticket_unknown ? ' \u2014 it names ticket ' + e.ticket + ', which this journal has never declared' : '');
      ov.appendChild(el('div', 'damaged', e.init + ' \\u00b7 ' + text + ' \\u00b7 ' + ago(e.ts)));
    });
    if (total > logged.length) {
      ov.appendChild(el('div', 'hint', 'and ' + (total - logged.length) + ' older \\u2014 the journals have the rest.'));
    }
  }

  // The same argument one step down. An initiative whose journal is PARTLY
  // damaged folds to a board with nothing wrong on it — the lost half leaves
  // no trace — so it used to render as an initiative in perfect health.
  var warned = data.warned || [];
  if (warned.length > 0) {
    var warnCount = 0;
    warned.forEach(function (d) { warnCount += d.warnings.length; });
    ov.appendChild(el('h2', null, 'Warnings (' + warnCount + ')'));
    ov.appendChild(el('div', 'hint', 'These initiatives rendered. What follows is what the fold could not account for — a skipped line is missing from every lane above, and a lease released by a non-holder is still open.'));
    warned.forEach(function (d) {
      d.warnings.forEach(function (w) {
        ov.appendChild(el('div', 'damaged', d.name + ': ' + w));
      });
    });
  }

  // ---- board ------------------------------------------------------------
  var bd = panels.board;
  bd.appendChild(el('div', 'hint', 'Every lane is derived from the journal — moving a ticket means appending an event, never editing this page. Select a card to see what the board knows about it.'));
  // Lanes where a ticket sitting still is worth saying out loud. The backlog
  // and ready lanes are deliberately absent — an unstarted ticket is not
  // stalling, it is waiting its turn, and marking every one of them stale
  // would make the signal worthless on the lanes where it means something.
  // Done, likewise: a merged ticket is supposed to stop moving.
  var STALLABLE = ['blocked', 'changes-requested', 'in-review', 'waiting-operator', 'in-progress', 'paused-limit'];

  var detail = el('div');
  var selected = null;
  var lanesWrap = el('div', 'lanes');
  var showDetail = function (card, lane, button) {
    if (selected) selected.setAttribute('aria-pressed', 'false');
    selected = button;
    button.setAttribute('aria-pressed', 'true');
    clear(detail);
    var box = el('div', 'detail');
    box.appendChild(el('div', 'dt', card.id + (card.title ? ' — ' + card.title : '')));
    var dl = el('dl');
    var row = function (k, v) {
      if (v === null || v === undefined || v === '') return;
      dl.appendChild(el('dt', null, k));
      dl.appendChild(el('dd', null, v));
    };
    row('lane', lane);
    var was = moved[(card.init || '') + '/' + card.id];
    if (was) row('since you marked seen', was === 'new' ? 'new ticket' : 'moved out of ' + was);
    row('initiative', card.init);
    row('agents', card.agents && card.agents.length ? card.agents.join(', ') : null);
    // Who ever held it, which is the question people ask about a ticket that
    // is already done — precisely when the running-agents list is empty.
    row('worked by', card.worked_by && card.worked_by.length ? card.worked_by.join(', ') : null);
    row('note', card.annotation);
    // What the agent SAID when it handed this back. The verdict alone told you
    // a ticket had come back and never why, which is the one thing the card is
    // opened for.
    row('reported', card.report_text);
    row('last event', card.since ? ago(card.since) + ' (' + card.since + ')' : null);
    if (cost) {
      var hit = (cost.by_ticket || []).filter(function (r) { return r.ticket === card.id; })[0];
      if (hit) row('spend', fmtTokens(hit.tokens) + ' tokens · ' + fmtUsd(hit.usd));
    } else if (costError) {
      row('spend', costError);
    }
    box.appendChild(dl);
    // The files this initiative ACTUALLY has, listed by the server after an
    // existsSync — never a fixed list of what a well-run initiative ought to
    // contain. Paths, not links: the board serves three URLs and derives a
    // filesystem path from none of them, which is worth more than a click.
    var docs = (data.files || {})[card.init] || [];
    if (docs.length > 0) {
      box.appendChild(el('div', 'dt', 'Files'));
      var list = el('div', 'files');
      docs.forEach(function (f) {
        var line = el('div', 'file');
        line.appendChild(el('span', 'fname', f.name));
        line.appendChild(el('code', null, f.path));
        list.appendChild(line);
      });
      box.appendChild(list);
    }
    detail.appendChild(box);
  };
  // A filter, because ten lanes across dozens of initiatives is a pile.
  // Substring over the id, the title and the initiative — no query language,
  // nothing to learn, and it never hides a lane HEADING, so "0" after
  // filtering still reads as a fact about the lane rather than as an
  // absence.
  var filterRow = el('div', 'filter');
  var filterInput = el('input');
  filterInput.setAttribute('type', 'search');
  filterInput.setAttribute('placeholder', 'filter by ticket, title or initiative');
  filterInput.setAttribute('aria-label', 'filter tickets');
  var filterCount = el('span', 'note');
  filterRow.appendChild(filterInput);
  filterRow.appendChild(filterCount);
  bd.appendChild(filterRow);

  var allCards = [];
  Object.keys(lanes).forEach(function (lane) {
    var cards = lanes[lane];
    var box = el('div', 'lane ' + lane);
    var h = el('h4');
    h.appendChild(el('span', null, lane));
    var count = el('span', 'count', ' (' + cards.length + ')');
    h.appendChild(count);
    box.appendChild(h);
    // Appended ALWAYS, hidden when it is not wanted. It used to be appended
    // only for a lane that was empty at build time, so a lane emptied by the
    // filter showed a heading, a count of "0 of 4", and then nothing — and the
    // display toggle below was setting a style on a node that was not in the
    // document.
    var emptyMark = el('div', 'empty', '—');
    box.appendChild(emptyMark);
    emptyMark.style.display = cards.length === 0 ? '' : 'none';
    var buttons = [];
    cards.forEach(function (c) {
      var button = el('button', 'card');
      button.setAttribute('type', 'button');
      button.setAttribute('aria-pressed', 'false');
      button.appendChild(el('span', 'id', c.id));
      if (c.title) button.appendChild(el('span', null, ' — ' + c.title));
      if (c.init) button.appendChild(el('span', 'init', '  ' + c.init));
      // The badge is the whole point of the baseline: it puts what moved in
      // front of you instead of asking you to compare ten lanes by eye.
      if (moved[(c.init || '') + '/' + c.id]) button.appendChild(el('span', 'movedtag', 'moved'));
      if (c.agents && c.agents.length) button.appendChild(el('span', 'note', 'agents: ' + c.agents.join(', ')));
      if (c.annotation) button.appendChild(el('span', 'note', c.annotation));
      // How long this card has stood still, on the lanes where standing still
      // IS the defect. The board would tell you an agent had been quiet for
      // three hours and refuse to tell you a ticket had been blocked for four
      // days — the timestamp has been in board.json since the lanes existed
      // and nothing ever rendered it.
      //
      // Worded as an observation, never a verdict: the board reports the last
      // event on the ticket, and only a human knows whether that is a stall or
      // a long test run.
      if (STALLABLE.indexOf(lane) !== -1 && c.since) {
        button.appendChild(el('span', 'note ' + ageClass(ageMsOf(c.since)), 'no event ' + ago(c.since).replace(/ ago$/, '')));
      }
      button.addEventListener('click', function () { showDetail(c, lane, button); });
      box.appendChild(button);
      buttons.push(button);
      allCards.push({ card: c, button: button, hay: ((c.id || '') + ' ' + (c.title || '') + ' ' + (c.init || '')).toLowerCase() });
    });
    lanesWrap.appendChild(box);
    box.tyranApply = function (q) {
      var shown = 0;
      buttons.forEach(function (b, i) {
        var hit = q === '' || ((cards[i].id || '') + ' ' + (cards[i].title || '') + ' ' + (cards[i].init || '')).toLowerCase().indexOf(q) !== -1;
        b.style.display = hit ? '' : 'none';
        if (hit) shown += 1;
      });
      count.textContent = q === '' ? ' (' + cards.length + ')' : ' (' + shown + ' of ' + cards.length + ')';
      emptyMark.style.display = shown === 0 && cards.length > 0 ? '' : (cards.length === 0 ? '' : 'none');
      return shown;
    };
  });
  var applyFilter = function () {
    var q = filterInput.value.trim().toLowerCase();
    var shown = 0;
    [].forEach.call(lanesWrap.children, function (box) { shown += box.tyranApply(q); });
    filterCount.textContent = q === '' ? '' : shown + ' of ' + allCards.length + ' ticket(s)';
  };
  filterInput.addEventListener('input', applyFilter);
  bd.appendChild(lanesWrap);
  bd.appendChild(detail);

  // ---- questions --------------------------------------------------------
  var qs = panels.questions;
  qs.appendChild(el('div', 'hint', 'Every question here is a gate in the journal, and it stays open until you close it. Blank takes the recorded default and is still written down as your decision; a single dash leaves it for next time.'));
  var how = el('pre', 'how');
  how.textContent =
    'npx @jjanczur/tyran answer render --dir .tyran   # writes .tyran/state/ANSWERS.md\\n' +
    '$EDITOR .tyran/state/ANSWERS.md                  # fill the answer: lines\\n' +
    'npx @jjanczur/tyran answer apply --dir .tyran    # closes what you answered';
  qs.appendChild(how);
  if (asks.length === 0) qs.appendChild(el('div', 'empty', 'nothing — the agents have what they need'));

  // Answering from the page. The three commands above still work and stay
  // printed: this box is a convenience, not a replacement, and a board opened
  // over file:// or without --write has to leave the operator somewhere to go.
  //
  // The request carries only WHICH ask and the operator's own words. The
  // question, the recorded default, the ticket and the gate id are all read
  // back out of the journal by the server — the same guarantee the answer
  // sheet makes, for the same reason.
  var replyBox = function (a, hasDefault) {
    var box = el('div', 'reply');
    var input = el('textarea');
    input.placeholder = hasDefault
      ? 'Your answer, in your own words \\u2014 or use the default button.'
      : 'Your answer, in your own words. There is no recorded default for this one.';
    var acts = el('div', 'acts');
    var send = el('button', 'sbtn', 'Answer');
    send.setAttribute('type', 'button');
    var useDefault = hasDefault ? el('button', 'sbtn', 'Take the default') : null;
    if (useDefault) useDefault.setAttribute('type', 'button');
    // The recommendation was already shown, as TEXT, and the only way to
    // accept it was to retype it into the box below it. For an operator who
    // is not an engineer that gap is most of the difficulty of the whole
    // page: the agent has said what it thinks should happen and the human is
    // asked to transcribe it. This fills the box instead of submitting, so
    // the wording stays editable and the answer is still deliberate.
    var useRec = a.recommendation ? el('button', 'sbtn', 'Use the recommendation') : null;
    if (useRec) {
      useRec.setAttribute('type', 'button');
      useRec.addEventListener('click', function () {
        input.value = a.recommendation;
        input.focus();
        holdRefresh();
      });
    }
    var status = el('div', 'sstat');

    var submit = function (text) {
      [send, useDefault].forEach(function (b) { if (b) b.disabled = true; });
      post('/answer', { init: a.init, kind: a.kind, answer: text }, status, function (ok) {
        if (!ok) {
          [send, useDefault].forEach(function (b) { if (b) b.disabled = false; });
          return;
        }
        // The board re-rendered on the server before it replied, so the next
        // load is already correct — and leaving an answered question on screen
        // with a live box invites answering it twice.
        input.disabled = true;
      }, function (p) {
        return (p.mode === 'default' ? 'answered with the recorded default' : 'answered')
          + ': ' + p.recorded + ' \\u00b7 decision ' + p.decision + ' \\u2014 reload to refresh the board';
      });
    };
    send.addEventListener('click', function () {
      if (input.value.trim() === '') {
        status.className = 'sstat bad';
        status.textContent = hasDefault
          ? 'type an answer, or press "Take the default"'
          : 'type an answer \\u2014 this question has no default to fall back on';
        return;
      }
      submit(input.value);
    });
    if (useDefault) useDefault.addEventListener('click', function () { submit(''); });

    // Typing here must survive the 30-second reload, exactly like a settings
    // field. Same mechanism, same reason.
    //
    // Wrapped, not passed: the hold-refresh helper is defined further down and
    // is still undefined while these cards are built, and addEventListener with
    // undefined is a silent no-op rather than an error — the listener would
    // simply never exist and a half-typed answer would vanish on the next
    // reload with nothing to show for it.
    input.addEventListener('input', function () { holdRefresh(); });

    box.appendChild(input);
    acts.appendChild(send);
    if (useRec) acts.appendChild(useRec);
    if (useDefault) acts.appendChild(useDefault);
    box.appendChild(acts);
    box.appendChild(status);
    box.appendChild(el('div', 'hint', 'Answering writes a decision and closes the gate in ' + a.init + '\\u2019s journal. Needs the board started with --write.'));
    return box;
  };
  asks.forEach(function (a) {
    var card = el('div', 'ask');
    // The one distinction that changes what an operator does about it, and it
    // costs no new event type to say: an ask WITH a recorded default is a
    // decision you may leave to the recommendation, and an ask without one is
    // blocking, because there saying nothing has no safe outcome. That is
    // already why the answer sheet sorts no-default first.
    var hasDefault = a.default !== null && a.default !== undefined;
    card.appendChild(el('span', 'kindtag ' + (hasDefault ? 'decision' : 'blocking'),
      hasDefault ? 'decision \\u00b7 a default is recorded' : 'blocking \\u00b7 no safe default'));
    card.appendChild(el('div', 'q', a.question || '(no question recorded — gate ' + a.kind + ')'));
    [['answer with', a.kind], ['recommendation', a.recommendation], ['default', a.default],
     ['blocks', a.blocks && a.blocks.count > 0 ? a.blocks.count + ' ticket(s): ' + a.blocks.ids.join(', ') : null],
     ['ticket', a.ticket], ['initiative', a.init], ['since', a.since]].forEach(function (pair) {
      if (pair[1] === null || pair[1] === undefined) return;
      var row = el('div', 'row');
      row.appendChild(el('span', 'label', pair[0]));
      row.appendChild(el('span', null, pair[1]));
      card.appendChild(row);
    });
    card.appendChild(replyBox(a, hasDefault));
    qs.appendChild(card);
  });

  // ---- spend ------------------------------------------------------------
  var sp = panels.spend;
  var spBody = el('div');
  sp.appendChild(spBody);
  spBody.appendChild(el('div', 'hint', 'Spend is read from the transcripts Claude Code already writes, and it is served rather than embedded — open this board with "board.mjs --serve" to see it. Over file:// there is no server, so this tab stays empty.'));

  // Mirrors compositionLabel in cost.mjs. Restated rather than imported
  // because this file is a browser bundle with no module graph — the two are
  // pinned equal by a test so the drift is caught rather than lived with.
  var compLabel = function (kind) {
    if (kind === 'cache_write') return 'cache write (5 min)';
    if (kind === 'cache_write_1h') return 'cache write (1 hour)';
    return kind.replace(/_/g, ' ');
  };

  var chart = function (allRows, key, metric, dimKeys) {
    var box = el('div', 'chart');
    // Ranked by the metric on screen, not by the one the server sorted by:
    // in cost view a cheap-and-chatty row above an expensive-and-terse one
    // is the exact inversion of the signal this view exists to give.
    var valueOf = function (r) { return metric === 'usd' ? r.usd : r.tokens; };
    var rows = allRows.slice().sort(function (a, b) {
      var av = valueOf(a);
      var bv = valueOf(b);
      if (typeof av !== 'number' && typeof bv !== 'number') return 0;
      if (typeof av !== 'number') return 1;
      if (typeof bv !== 'number') return -1;
      return bv - av || String(a[key]).localeCompare(String(b[key]));
    });
    var values = rows.map(valueOf);
    var max = 0;
    values.forEach(function (v) { if (typeof v === 'number' && v > max) max = v; });
    rows.forEach(function (r, i) {
      var value = values[i];
      var unpriced = metric === 'usd' && (value === null || value === undefined);
      var dim = unpriced || dimKeys.indexOf(r[key]) !== -1;
      var row = el('div', dim ? 'chartrow dim' : 'chartrow');
      row.appendChild(el('div', 'rl', r[key]));
      var track = el('div', 'rb');
      var fill = el('i');
      fill.style.width = (max > 0 && typeof value === 'number' ? (value / max) * 100 : 0) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('div', 'rv', metric === 'usd' ? fmtUsd(value) : fmtTokens(value)));
      box.appendChild(row);
    });
    return box;
  };

  // A PURE function on purpose: no DOM, so a test can extract this one
  // function's source out of the page and evaluate it standalone, without a
  // browser, and check what it decides for a payload it never had to fetch.
  //
  // Two callers, one decision. renderSpend calls this once spend loaded
  // normally; the cost-fetch handler below calls it BEFORE the early return
  // on a payload with transcripts_found false — a directory named in
  // transcript_dirs_missing is exactly as real a fact when nothing was
  // found at all as when something was, and a single function neither call
  // site can restate differently is what keeps that true.
  var spendResolutionHints = function (payload) {
    var hints = [];
    var missing = (payload && payload.transcript_dirs_missing) || [];
    if (missing.length > 0) {
      var noun = missing.length === 1 ? 'directory' : 'directories';
      hints.push('Given transcript ' + noun + ' not found: ' + missing.join(', ') + '.');
    }
    // Only on the branch that never reaches renderSpend at all: when spend
    // WAS found, "no transcripts" would be false and misleading — the tab
    // renders its own numbers and, if it turns out zero agents were among
    // them, the separate agents-vs-coverage hint inside renderSpend covers it.
    if (payload && payload.transcripts_found === false) {
      hints.push(
        'No transcripts found for this repo. If the conductor ran from another working directory, ' +
        'point the board at that session: board.mjs --serve --transcripts <dir> or set ' +
        'spend.transcript_dirs in .tyran/config.yaml.'
      );
    }
    return hints;
  };

  var renderSpend = function (into, metric) {
    clear(into);
    var t = cost.totals || {};
    var cov = cost.coverage || {};
    var header = el('div', 'spend-head');
    header.appendChild(el('h2', null, 'Spend'));
    var toggle = el('div', 'toggle');
    [['tokens', 'tokens'], ['usd', 'cost']].forEach(function (pair) {
      var button = el('button', null, pair[1]);
      button.setAttribute('type', 'button');
      button.setAttribute('aria-pressed', metric === pair[0] ? 'true' : 'false');
      button.addEventListener('click', function () { renderSpend(into, pair[0]); });
      toggle.appendChild(button);
    });
    header.appendChild(toggle);

    // The period the numbers describe. A plan is billed MONTHLY, so an
    // all-time total has nothing to compare against; these two windows do.
    // "this period" is offered only when the subscription date was readable,
    // because a period guessed from an assumed anniversary is wrong for
    // almost everyone.
    var periods = [['30d', 'last 30 days'], ['all', 'all time']];
    if (cost.subscription && cost.subscription.created_at) {
      periods.splice(1, 0, ['period', 'this billing period']);
    }
    var picker = el('div', 'toggle');
    periods.forEach(function (pair) {
      var button = el('button', null, pair[1]);
      button.setAttribute('type', 'button');
      button.setAttribute('aria-pressed', spendWindow === pair[0] ? 'true' : 'false');
      button.addEventListener('click', function () { loadCost(pair[0], metric); });
      picker.appendChild(button);
    });
    header.appendChild(picker);
    into.appendChild(header);

    var tiles = el('div', 'tiles');
    tiles.appendChild(tile('tokens', fmtTokens(t.tokens || 0), (t.requests || 0) + ' requests'));
    tiles.appendChild(tile('cost through the API', fmtUsd(t.usd),
      cost.rate_card ? 'rate card ' + cost.rate_card : 'no rate card set', 'lead'));
    // What the API-equivalent figure is actually WORTH knowing against. On a
    // subscription the marginal cost of a token is zero, so the dollar total
    // above is true of the API and false of the operator's bank account —
    // shown alone it invites exactly the wrong conclusion. Rendered only when
    // the plan is known; a guess here would be worse than the silence.
    var w = cost.window;
    var sub = cost.subscription;
    if (sub && typeof sub.monthly_usd === 'number') {
      // The multiple is shown ONLY under a month-shaped window. Against an
      // all-time total it would be off by however long this machine has been
      // running Claude Code — measured at 6.9x when the honest figure was
      // about 11x — so under "all time" the tile states the span and stops.
      var monthly = w && (w.name === '30d' || w.name === 'period') && typeof t.usd === 'number';
      var note = sub.label;
      if (monthly && sub.monthly_usd > 0) {
        note += ' — the API cost of ' + windowLabel(cost) + ' is ' +
          (t.usd / sub.monthly_usd).toFixed(1) + 'x that';
      } else if (cost.covers && cost.covers.days) {
        note += ' — the total above covers ' + cost.covers.days +
          ' day' + (cost.covers.days === 1 ? '' : 's');
      }
      tiles.appendChild(tile('you pay', fmtUsd(sub.monthly_usd) + '/mo', note, 'lead'));
    }
    tiles.appendChild(tile('conductor overhead', (t.conductor_token_share || 0) + '%', 'of tokens, no ticket'));
    tiles.appendChild(tile('attributed', (cov.attributed || 0) + ' / ' + (cov.agent_transcripts || 0),
      (cov.unattributed || 0) + ' agent(s) without a ticket'));
    into.appendChild(tiles);

    // The composition is the point of the whole tab: cache reads dominate the
    // bill, so the lever is context size and turn count, not model price.
    var comp = (cost.composition || []).slice().sort(function (a, b) {
      return metric === 'usd' ? (b.usd || 0) - (a.usd || 0) : b.tokens - a.tokens;
    });
    var compTotal = 0;
    comp.forEach(function (c) { compTotal += metric === 'usd' ? (c.usd || 0) : c.tokens; });
    if (compTotal > 0) {
      var bar = el('div', 'comp');
      var key = el('div', 'compkey');
      comp.forEach(function (c) {
        var value = metric === 'usd' ? (c.usd || 0) : c.tokens;
        if (value <= 0) return;
        var pct = Math.round((value / compTotal) * 100);
        var seg = el('span', 's-' + c.kind, pct >= 8 ? pct + '%' : '');
        // Normalised to a share: flex-grow below 1 does not fill its
        // container, and dollar amounts are routinely fractions.
        seg.style.flex = String((value / compTotal) * 100);
        bar.appendChild(seg);
        var legend = el('span', null);
        legend.appendChild(el('i', 's-' + c.kind));
        legend.appendChild(el('span', null,
          compLabel(c.kind) + ' ' + (metric === 'usd' ? fmtUsd(c.usd) : fmtTokens(c.tokens))));
        key.appendChild(legend);
      });
      into.appendChild(bar);
      into.appendChild(key);
    }

    // The series. Every other view on this tab is a snapshot, so nothing has
    // ever been able to answer "am I getting cheaper" — the single question a
    // spend page exists for. Always the FULL history regardless of the window:
    // a chart that shrank with the window could not show you that last month
    // was worse, which is the comparison worth having.
    var series = cost.per_day || [];
    if (series.length > 1) {
      into.appendChild(el('h3', null, 'By day'));
      var peak = 0;
      series.forEach(function (d) {
        var v = metric === 'usd' ? (d.usd || 0) : d.tokens;
        if (v > peak) peak = v;
      });
      var days = el('div', 'days');
      series.forEach(function (d) {
        var value = metric === 'usd' ? (d.usd || 0) : d.tokens;
        var col = el('div', 'day');
        var bar = el('i');
        bar.style.height = (peak > 0 ? Math.max(2, (value / peak) * 100) : 0) + '%';
        // Inside the window is the emphasis; outside it is context, not
        // absence — the days either side are exactly what makes the window
        // legible as a choice.
        if (w && (d.day < w.from || d.day > w.to)) col.className = 'day out';
        col.appendChild(bar);
        col.setAttribute('title', d.day + ' \u2014 ' + fmtTokens(d.tokens) + ' tokens' +
          (typeof d.usd === 'number' ? ' \u00b7 ' + fmtUsd(d.usd) : ''));
        days.appendChild(col);
      });
      into.appendChild(days);
      into.appendChild(el('div', 'hint',
        series[0].day + ' to ' + series[series.length - 1].day + ' \u00b7 ' +
        series.length + ' day(s) with recorded activity \u00b7 hover a bar for its total'));
    }

    [['By model', cost.by_model || [], 'model', []],
     ['By agent type', cost.by_agent_type || [], 'agent_type', ['conductor']],
     ['By ticket', cost.by_ticket || [], 'ticket', ['conductor', 'unattributed']]].forEach(function (spec) {
      into.appendChild(el('h3', null, spec[0]));
      into.appendChild(chart(spec[1], spec[2], metric, spec[3]));
    });

    var notes = ['Conductor context is not attributable to any ticket; it is its own row so the rows sum to the total.'];
    if ((cov.unattributed || 0) > 0) {
      notes.push(cov.unattributed + ' agent(s) carry no ticket id in their task description and are grouped as unattributed.');
    }
    if ((cost.unpriced || []).length > 0) {
      notes.push('Counted in tokens but absent from every amount, having no rate: ' + cost.unpriced.join(', ') + '.');
    }
    if ((cov.malformed || 0) > 0 || (cov.skipped_lines || 0) > 0) {
      notes.push((cov.malformed || 0) + ' unparseable and ' + (cov.skipped_lines || 0) +
        ' oversized record(s) were skipped; their tokens are missing from every figure here.');
    }
    into.appendChild(el('div', 'caveat', notes.join(' ')));

    // Zero agent transcripts while the board itself lists agents is not "no
    // agents ran" — it is the resolved directory being the WRONG one. A
    // conductor session started from a working directory other than the repo
    // it operates on files its transcript under a project directory no
    // derivation from the repo path reaches, and this is the one place an
    // operator would otherwise have no reason to suspect it: the tab renders,
    // the totals are honest numbers, and they are honest numbers about the
    // wrong session.
    if ((cov.agent_transcripts || 0) === 0 && agents.length > 0) {
      into.appendChild(el('div', 'hint',
        'No agent transcripts found where this repo\\u2019s transcripts are expected. If the conductor ' +
        'ran from another working directory, point the board at that session: board.mjs --serve ' +
        '--transcripts <dir> or set spend.transcript_dirs in .tyran/config.yaml.'));
    }
    // cost.transcripts_found is true whenever this function runs at all, so
    // spendResolutionHints only ever contributes the missing-dirs line here
    // — the "no transcripts found" line is reachable exclusively through the
    // fetch handler's own call below, on the branch that never reaches this
    // function.
    spendResolutionHints(cost).forEach(function (h) { into.appendChild(el('div', 'hint', h)); });
  };

  // Spend is FETCHED, never embedded: it is derived from transcripts under
  // the operator's home directory — machine-local, different in every clone —
  // so writing it into board.json would break the byte-exact --check contract
  // and make two people with one journal disagree.
  // Three different things used to look identical here: an unserved page, a
  // crashed reader, and a rate card that does not parse. All three ended as a
  // silently absent section, so the operator could not tell "there is nothing
  // to show" from "the thing that shows it is broken". The server already
  // builds an error string for the 503 and it was never displayed.
  var showCostFailure = function (why) {
    costError = why;
    clear(spBody);
    spBody.appendChild(el('div', 'err', why));
  };
  // Re-fetches with a chosen window. The server recomputes rather than the
  // page filtering, because only the server has the per-day buckets and a
  // page that filtered a total it was handed could only ever subtract wrong.
  var loadCost = function (window, metric) {
    if (typeof fetch !== 'function') return;
    spendWindow = window;
    fetch('cost.json?window=' + encodeURIComponent(window), { headers: { accept: 'application/json' } })
      .then(function (r) {
        // 404 is not a failure, it is an ANSWER: no such route, so this page
        // is not being served by the board server — a copy on a docs site, a
        // file behind some other static host. Distinct from a 503, which
        // means the reader ran and could not finish.
        if (r.status === 404) return { absent: true };
        return r.json().then(function (body) { return { ok: r.ok, body: body }; });
      })
      .then(function (res) {
        if (res.absent) {
          showCostFailure('Spend is not served on this page. Run the board against your own repo to see it: npx @jjanczur/tyran board --dir .tyran --serve');
          return;
        }
        var payload = res.body;
        if (!res.ok) {
          showCostFailure('Spend could not be read: ' + ((payload && payload.error) || 'the server refused the request') + '.');
          return;
        }
        if (!payload || payload.schema !== ${COST_SCHEMA}) {
          showCostFailure('Spend was served in a format this page does not know (schema ' +
            ((payload && payload.schema) || 'absent') + ') — regenerate the board with the Tyran that served it.');
          return;
        }
        if (!payload.transcripts_found) {
          // Genuinely nothing to roll up — but the explanation still has to
          // reach the page. This used to be a silent early return that left
          // spBody carrying the "open with --serve" hint written before the
          // fetch even started, unconditionally wrong once the fetch answers:
          // it made the everyday single-typo spend.transcript_dirs case
          // (payload carries transcript_dirs_missing but no coverage at all,
          // since renderSpend — the only other place that hint used to live
          // — never runs on this branch) look exactly like a repo that had
          // never been served at all. Reviewed and reproduced live via
          // cost.json before this fix.
          clear(spBody);
          spendResolutionHints(payload).forEach(function (h) { spBody.appendChild(el('div', 'hint', h)); });
          return;
        }
        cost = payload;
        renderSpend(spBody, metric || 'tokens');
        var t = cost.totals || {};
        // CLEARED first: this runs again on every window change, and appending
        // left one "Spend" heading and one tile stacked up per click.
        clear(ovSpend);
        var strip = el('div', 'tiles');
        strip.appendChild(tile('spend so far', fmtUsd(t.usd),
          fmtTokens(t.tokens || 0) + ' tokens · ' + windowLabel(cost) + ' · see the Spend tab'));
        ovSpend.appendChild(el('h2', null, 'Spend'));
        ovSpend.appendChild(strip);
      })
      .catch(function () {
        // Over file:// there is no server to ask, which is not a failure —
        // it is the documented shape of this page without one.
        if (String(location.protocol) === 'file:') return;
        showCostFailure('Spend could not be read: the board server did not answer. It is served, never embedded — start it with: npx @jjanczur/tyran board --dir .tyran --serve');
      });
  };

  // The DEFAULT is 30 days, not all time: a plan is billed monthly, so a
  // month-shaped window is the only one an operator can compare against the
  // price without doing arithmetic. All time remains one click away.
  loadCost('30d', 'tokens');

  // ---- settings ---------------------------------------------------------
  //
  // The one tab that writes. Everything else on this page is a projection of
  // the journal and hand-editing it would be drift; config and the autonomy
  // policy are the opposite — operator-owned files that nothing generates, and
  // the only place they could be changed until now was an editor and a memory
  // of what each key meant.
  //
  // Served, never embedded, exactly like spend: these are not journal state,
  // so writing them into board.json would break the byte-exact check and make
  // two clones of one journal disagree.
  var st = panels.settings;
  var stBody = el('div');
  st.appendChild(stBody);
  stBody.appendChild(el('div', 'setnote', 'Settings are read from .tyran/config.yaml and .tyran/policies/autonomy.yaml, and they are served rather than embedded — open this board with "board.mjs --serve" to see them.'));

  // Auto-refresh, and the reason it is a timer rather than a meta tag.
  //
  // A real http-equiv refresh is scheduled by the browser when it PARSES the
  // tag, and removing the node afterwards does not cancel it — measured, in a
  // browser, after this page reloaded under a half-typed value that the code
  // sincerely believed it had protected. So the page carries an inert
  // tyran-refresh marker instead, and the only thing that reloads it is this
  // timer, which can be stopped while an operator is typing.
  //
  // Absent marker, no timer at all: that is what the docs sandbox wants, and
  // it gets it by stripping the marker rather than by special-casing anything.
  var refreshTag = document.querySelector('meta[name="tyran-refresh"]');
  var refreshSeconds = refreshTag === null ? 0 : Number(refreshTag.getAttribute('content'));
  var refreshTimer = null;
  var armRefresh = function () {
    if (!(refreshSeconds > 0) || refreshTimer !== null) return;
    refreshTimer = setTimeout(function () { location.reload(); }, refreshSeconds * 1000);
  };
  var holdRefresh = function () {
    if (refreshTimer !== null) { clearTimeout(refreshTimer); refreshTimer = null; }
  };
  armRefresh();

  // The describe callback turns a successful payload into the sentence the
  // operator reads. Settings and answers succeed differently — one reports a
  // value that moved, the other what was recorded and under which decision id —
  // and a single hard-coded message rendered "undefined -> undefined" for the
  // route it was not written for.
  var post = function (route, body, status, onDone, describe) {
    status.className = 'sstat';
    status.textContent = 'saving\\u2026';
    fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (payload) { return { ok: r.ok, payload: payload }; });
    }).then(function (result) {
      var payload = result.payload || {};
      if (!result.ok || payload.ok !== true) {
        status.className = 'sstat bad';
        status.textContent = show(payload.error || 'the change was refused');
        // A refusal the operator can answer, rather than one they can only
        // read. The server sends back the exact token that answers it, and
        // pressing this re-sends the same change carrying that token — which
        // is why nothing here decides what "confirmed" means.
        if (payload.widens === true && typeof payload.confirm_with === 'string') {
          var go = el('button', 'sbtn danger', 'Yes \\u2014 loosen it');
          go.setAttribute('type', 'button');
          go.addEventListener('click', function () {
            var again = {};
            Object.keys(body).forEach(function (k) { again[k] = body[k]; });
            again.confirm = payload.confirm_with;
            post(route, again, status, onDone);
          });
          status.appendChild(document.createElement('br'));
          status.appendChild(go);
        }
        if (onDone) onDone(false);
        return;
      }
      status.className = 'sstat ok';
      status.textContent = show(describe
        ? describe(payload)
        : 'saved \\u2014 ' + JSON.stringify(payload.before) + ' \\u2192 ' + JSON.stringify(payload.after));
      if (onDone) onDone(true);
    }).catch(function () {
      status.className = 'sstat bad';
      status.textContent = 'the board server did not answer \\u2014 nothing was written';
      if (onDone) onDone(false);
    });
  };

  var settingRow = function (setting, writable) {
    var row = el('div', 'srow');
    var name = el('div', 'sname', setting.label);
    if (setting.unit) name.appendChild(el('span', 'sunit', ' ' + setting.unit));
    row.appendChild(name);
    var bodyCell = el('div', 'sbody');
    row.appendChild(bodyCell);

    var status = el('div', 'sstat');
    var choiceNote = null;
    var control = null;

    if (setting.present !== true) {
      // Absent is not the same as unset, and saying so beats an empty box: a
      // key that is not in the file has no line for the patcher to edit, and
      // inventing one means choosing where it goes and what comment explains
      // it. That is authoring, and it stays a hand edit.
      bodyCell.appendChild(el('div', 'shelp', 'Not set in this config. Add the key by hand once and it becomes editable here.'));
      bodyCell.appendChild(el('div', 'shelp', setting.help));
      return row;
    }

    if (setting.kind === 'choice') {
      control = el('select');
      setting.choices.forEach(function (c) {
        var option = el('option', null, c.value);
        option.value = c.value;
        if (c.value === setting.value) option.selected = true;
        control.appendChild(option);
      });
      choiceNote = el('div', 'schoice');
      var describe = function () {
        var picked = setting.choices.filter(function (c) { return c.value === control.value; })[0];
        choiceNote.textContent = show(picked ? picked.describe : '');
      };
      describe();
      control.addEventListener('change', function () {
        describe();
        post('/settings/config', { id: setting.id, value: control.value }, status);
      });
    } else if (setting.kind === 'boolean') {
      control = el('select');
      [['false', 'off'], ['true', 'on']].forEach(function (pair) {
        var option = el('option', null, pair[1]);
        option.value = pair[0];
        if ((pair[0] === 'true') === (setting.value === true)) option.selected = true;
        control.appendChild(option);
      });
      control.addEventListener('change', function () {
        post('/settings/config', { id: setting.id, value: control.value === 'true' }, status);
      });
    } else if (setting.kind === 'number') {
      control = el('input');
      control.type = 'number';
      control.value = String(setting.value);
      if (setting.min !== null) control.min = String(setting.min);
      if (setting.max !== null) control.max = String(setting.max);
      control.addEventListener('change', function () {
        post('/settings/config', { id: setting.id, value: Number(control.value) }, status);
      });
    } else if (setting.kind === 'list') {
      control = el('textarea');
      control.value = (setting.value || []).join('\\n');
      if (setting.placeholder) control.placeholder = setting.placeholder + '\\n(one per line)';
    } else {
      control = el('input');
      control.type = 'text';
      control.value = String(setting.value === null ? '' : setting.value);
      if (setting.placeholder) control.placeholder = setting.placeholder;
    }

    control.disabled = !writable;
    bodyCell.appendChild(control);

    // Discrete controls save the moment they change; free text does not,
    // because there is no moment during typing that is the whole value.
    if (setting.kind === 'list' || setting.kind === 'text') {
      var save = el('button', 'sbtn', 'Save');
      save.setAttribute('type', 'button');
      save.disabled = !writable;
      control.addEventListener('input', holdRefresh);
      save.addEventListener('click', function () {
        var value = setting.kind === 'list'
          ? control.value.split('\\n').map(function (line) { return line.trim(); }).filter(function (line) { return line !== ''; })
          : control.value;
        post('/settings/config', { id: setting.id, value: value }, status, function (ok) { if (ok) armRefresh(); });
      });
      bodyCell.appendChild(save);
    }

    if (choiceNote) bodyCell.appendChild(choiceNote);
    bodyCell.appendChild(el('div', 'shelp', setting.help));
    bodyCell.appendChild(status);
    return row;
  };

  // The address is what the write route is told to change, and it is NOT the
  // label: the file's own default key is addressed as null, while a rule is
  // addressed by its path glob. By glob and not by position, so that a file
  // edited underneath an open page cannot land the write on a neighbouring
  // boundary — the server re-resolves the glob against the file as it is now.
  var ruleRow = function (rule, classes, describe, writable, address) {
    var row = el('div', 'rule');
    row.appendChild(el('div', 'glob', rule.path));
    var status = el('div', 'sstat');
    if (rule.locked) {
      var lock = el('div', 'lock', rule.class + ' \\u00b7 locked');
      lock.title = 'This path protects the gate itself and cannot be lowered.';
      row.appendChild(lock);
    } else {
      var pick = el('select');
      classes.forEach(function (klass) {
        var option = el('option', null, klass);
        option.value = klass;
        if (klass === rule.class) option.selected = true;
        pick.appendChild(option);
      });
      pick.disabled = !writable;
      pick.addEventListener('change', function () {
        post('/settings/policy', { path: address, class: pick.value }, status);
      });
      row.appendChild(pick);
    }
    if (rule.reason) row.appendChild(el('div', 'why', rule.reason));
    else if (rule.locked) row.appendChild(el('div', 'why', describe[rule.class] || ''));
    row.appendChild(status);
    return row;
  };

  var renderSettings = function (payload) {
    clear(stBody);
    var writable = payload.writable === true;
    var note = el('div', writable ? 'setnote' : 'setnote warn');
    if (writable) {
      note.appendChild(el('b', null, 'Changes are written straight to disk.'));
      note.appendChild(el('span', null,
        ' Comments in these files are kept; the value on one line is all that moves, and every write is checked by the same validator "tyran doctor" runs before it lands. Nothing is written if the result would be invalid. Review what changed with git diff.'));
    } else {
      note.appendChild(el('b', null, 'Read-only.'));
      note.appendChild(el('span', null, ' This board was started without editing. To turn these controls on, restart it with: '));
      note.appendChild(el('code', null, 'npx @jjanczur/tyran board --dir .tyran --serve --write'));
    }
    stBody.appendChild(note);

    [['config', payload.files.config], ['policy', payload.files.policy]].forEach(function (pair) {
      if (pair[1].present && pair[1].error === null) return;
      var bad = el('div', 'setnote bad');
      bad.appendChild(el('b', null, pair[1].present ? 'This file does not parse: ' : 'This file is missing: '));
      bad.appendChild(el('span', null, pair[1].path + (pair[1].error ? ' \\u2014 ' + pair[1].error : '')));
      stBody.appendChild(bad);
    });

    payload.groups.forEach(function (group) {
      var box = el('div', 'sgroup');
      box.appendChild(el('h2', null, group.title));
      box.appendChild(el('div', 'blurb', group.blurb));
      group.settings.forEach(function (setting) { box.appendChild(settingRow(setting, writable)); });
      stBody.appendChild(box);
    });

    var policy = payload.policy || {};
    var pol = el('div', 'sgroup');
    pol.appendChild(el('h2', null, 'Autonomy policy'));
    pol.appendChild(el('div', 'blurb',
      'Which paths agents may write on their own. The most specific matching rule wins, and a path no rule matches gets the default. ' +
      (policy.classes || []).map(function (k) { return k + ' \\u2014 ' + (policy.describe || {})[k]; }).join('  \\u00b7  ')));
    if (policy.default !== null && policy.default !== undefined) {
      pol.appendChild(ruleRow(
        { path: 'default \\u2014 everything no rule matches', class: policy.default, reason: 'GATED is the safe answer: it means "ask me".', locked: false },
        policy.classes || [], policy.describe || {}, writable, null));
    }
    (policy.rules || []).forEach(function (rule) {
      pol.appendChild(ruleRow(rule, policy.classes || [], policy.describe || {}, writable, rule.path));
    });
    stBody.appendChild(pol);
  };

  // Leaving this tab re-arms the refresh, entering it stops it. A page that
  // reloads under an open select is a page that loses the change you were
  // halfway through making, and the board has three other tabs that want to
  // stay live.
  Object.keys(buttons).forEach(function (key) {
    buttons[key].addEventListener('click', function () {
      if (key === 'settings') holdRefresh(); else armRefresh();
    });
  });

  // Machine-local run state, fetched beside spend. A 404 means this page is
  // not being served by a board server — a copy on a docs site, a file behind
  // some other host — and that is an answer, not a failure.
  fetch('run.json', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (run) {
      if (run === null || run.schema !== 1) return;
      var lines = [];
      if (run.paused) {
        lines.push(run.paused.overdue
          ? 'A usage-limit pause was due to resume ' + ago(run.paused.resume_at) + ' and has not.'
          : 'Paused on the ' + (run.paused.window || 'usage') + ' window at ' +
            (run.paused.used_percentage === null ? 'the threshold' : run.paused.used_percentage + '%') +
            '. Resumes ' + (run.paused.wait || 'later') + '.');
      }
      if (run.watcher && run.watcher.alive === false) {
        lines.push('The resume watcher is not running, so nothing will restart this by itself.');
      }
      if (run.usage && run.usage.stale === true) {
        lines.push('Usage telemetry is stale — the statusline helper may not be installed.');
      }
      if (lines.length === 0) return;
      var box = el('div', 'paused');
      box.appendChild(el('b', null, 'This run is not simply working. '));
      lines.forEach(function (line) { box.appendChild(el('div', 'hint', line)); });
      box.appendChild(el('div', 'hint', 'npx @jjanczur/tyran overnight status --dir .tyran'));
      ov.insertBefore(box, ov.firstChild);
    })
    .catch(function () { /* no server, or none of this applies */ });

  fetch('settings.json', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(String(r.status))); })
    .then(function (payload) {
      if (payload.schema !== 1) {
        clear(stBody);
        stBody.appendChild(el('div', 'setnote bad', 'Settings were served in a format this page does not know (schema ' +
          (payload.schema || 'absent') + ') \\u2014 regenerate the board with the Tyran that served it.'));
        return;
      }
      // A failure INSIDE the renderer is not a failure to reach the server,
      // and reporting it as one sends the operator to restart something that
      // was answering perfectly well. Caught here so the outer handler keeps
      // its one meaning: the fetch did not land.
      try {
        renderSettings(payload);
      } catch (err) {
        clear(stBody);
        stBody.appendChild(el('div', 'setnote bad',
          'Settings were served but this page could not draw them: ' + show(String((err && err.message) || err)) +
          ' \\u2014 the board and the Tyran that served it are probably different versions.'));
      }
    })
    .catch(function () {
      if (String(location.protocol) === 'file:') return;
      clear(stBody);
      stBody.appendChild(el('div', 'setnote bad',
        'Settings could not be read: the board server did not answer. They are served, never embedded \\u2014 start it with: npx @jjanczur/tyran board --dir .tyran --serve --write'));
    });

  select('overview');

  var foot = el('footer');
  foot.appendChild(el('div', null, 'GENERATED by tyran scripts/board.mjs — do not edit. Reloads itself every 30 s unless you are editing; ages are computed in this browser.'));
  app.appendChild(foot);
}
`;

/**
 * The page, from an already-serialized cross-board JSON string (the exact
 * bytes of board.json, so the two artefacts can never disagree). The extra
 * `<` escape is the script-element breakout layer.
 */
/**
 * The page for a board that could not be rendered at all.
 *
 * Built through the same JSON channel as the real page rather than by
 * interpolating the message into markup: the text comes from an exception, an
 * exception carries a path, and a path is attacker-adjacent input on a page
 * the operator opens in a browser. `<` on the JSON, `textContent` on the
 * other side, no innerHTML anywhere — the same three rules the board itself
 * follows.
 */
export function renderBoardError(message) {
  const data = JSON.stringify({ message }).replace(/</g, '\\u003C');
  return (
    '<!doctype html>\n' +
    '<html lang="en"><head><meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>Tyran board — cannot render</title>\n' +
    `<style>${CSS}</style>\n` +
    '</head><body><main id="app"></main>\n' +
    `<script type="application/json" id="board-error">${data}</script>\n` +
    '<script>\n' +
    'var d = JSON.parse(document.getElementById("board-error").textContent);\n' +
    'var app = document.getElementById("app");\n' +
    'var h = document.createElement("h1"); h.textContent = "The board cannot be rendered";\n' +
    'var p = document.createElement("p"); p.className = "err"; p.textContent = d.message;\n' +
    'var n = document.createElement("p");\n' +
    'n.textContent = "This page does not refresh itself \\u2014 fix the cause above, then reload.";\n' +
    'app.appendChild(h); app.appendChild(p); app.appendChild(n);\n' +
    '</script>\n' +
    '</body></html>\n'
  );
}

export function renderBoardHtml(payloadJsonText) {
  const embedded = payloadJsonText.replace(/</g, '\\u003C');
  return (
    '<!doctype html>\n' +
    '<!-- GENERATED by tyran scripts/board.mjs - DO NOT EDIT. Source of truth: the journals under .tyran/state/ -->\n' +
    '<html lang="en"><head><meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    // NOT `http-equiv="refresh"`. A real meta refresh is scheduled by the
    // browser the moment it parses the tag, and REMOVING THE NODE DOES NOT
    // CANCEL IT — measured, after this page reloaded under a half-typed model
    // name that the code sincerely believed it had protected. The tag is now
    // inert markup that only this page's own script reads, so the timer it
    // arms is one the page can actually stop while you are typing into it.
    // The page is built entirely by that script anyway, so nothing is lost:
    // a browser that cannot run it has no board to refresh.
    '<meta name="tyran-refresh" content="30">\n' +
    '<title>Tyran board</title>\n' +
    `<style>${CSS}</style>\n` +
    '</head><body><main id="app"></main>\n' +
    `<script type="application/json" id="board-data">${embedded}</script>\n` +
    `<script>${CLIENT_JS}</script>\n` +
    '</body></html>\n'
  );
}
