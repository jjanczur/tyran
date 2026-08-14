#!/usr/bin/env node
import { FORBIDDEN } from './invisible.mjs';
/**
 * board-html — the one page an operator stares at overnight.
 *
 * Renders the cross-initiative board payload (see board.mjs) as a single
 * self-contained HTML file: inline CSS, inline JS, no network requests, works
 * over file://. A <meta refresh> keeps it current — fetch() of a sibling file
 * is blocked over file:// in Chromium, so meta-refresh is the one reliable
 * primitive; under `board.mjs --serve` the same refresh hits the server.
 *
 * ## Four tabs, because the page answers four questions
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
  --clay:#c07a70;--clay-bright:#d9998f;--clay-low:#2a1a18;--sage:#88a06a;
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
      var chip = el('div', 'agent');
      chip.appendChild(el('div', 'name', a.agent + (a.role ? ' · ' + a.role : '')));
      chip.appendChild(el('div', null, (a.init ? a.init + ' · ' : '') + (a.ticket || 'no ticket') + ' · ' + a.state));
      if (a.detail) chip.appendChild(el('div', 'note', a.detail));
      // What the agent said it would do next. It has been in board.json since
      // the fold learned to read progress events, and the strip has never
      // shown it — so the chip could say an agent went quiet without saying
      // what it went quiet in the middle of.
      if (a.next) chip.appendChild(el('div', 'note', 'next: ' + a.next));
      var ageMs = a.last_signal ? Date.now() - Date.parse(a.last_signal) : null;
      var cls = ageMs === null ? 'age-cold' : ageMs < 600000 ? 'age-fresh' : ageMs < 1800000 ? 'age-warm' : 'age-cold';
      // Four buckets, not three. The old top bucket was "30 minutes or six
      // hours", which are not the same event: one is a long test run, the
      // other is an agent that is not coming back.
      var ageText = ageMs === null ? 'no signal recorded'
        : ageMs >= 10800000 ? Math.round(ageMs / 3600000) + ' HOURS since last signal — likely dead'
        : Math.round(ageMs / 60000) + ' min since last signal';
      chip.appendChild(el('div', ageMs !== null && ageMs >= 10800000 ? 'age-dead' : cls, ageText));
      strip.appendChild(chip);
    });
    return strip;
  };

  // ---- overview ---------------------------------------------------------
  var ov = panels.overview;
  (data.paused || []).forEach(function (p) {
    ov.appendChild(el('div', 'paused', 'PAUSED — ' + p.init + ': gate ' + p.kind + ' (' + p.result + ') since ' + p.since));
  });
  var laneCount = function (name) { return (lanes[name] || []).length; };
  var ovTiles = el('div', 'tiles');
  ovTiles.appendChild(tile('waiting on you', String(asks.length),
    asks.length === 0 ? 'nothing blocked on a decision' : 'answer them on the next tab', asks.length > 0 ? 'lead' : null));
  ovTiles.appendChild(tile('agents running', String(agents.length), 'across ' + (totals.initiatives || 0) + ' initiative(s)'));
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
    var emptyMark = el('div', 'empty', '—');
    if (cards.length === 0) box.appendChild(emptyMark);
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
  asks.forEach(function (a) {
    var card = el('div', 'ask');
    card.appendChild(el('div', 'q', a.question || '(no question recorded — gate ' + a.kind + ')'));
    [['answer with', a.kind], ['recommendation', a.recommendation], ['default', a.default],
     ['ticket', a.ticket], ['initiative', a.init], ['since', a.since]].forEach(function (pair) {
      if (pair[1] === null || pair[1] === undefined) return;
      var row = el('div', 'row');
      row.appendChild(el('span', 'label', pair[0]));
      row.appendChild(el('span', null, pair[1]));
      card.appendChild(row);
    });
    qs.appendChild(card);
  });

  // ---- spend ------------------------------------------------------------
  var sp = panels.spend;
  var spBody = el('div');
  sp.appendChild(spBody);
  spBody.appendChild(el('div', 'hint', 'Spend is read from the transcripts Claude Code already writes, and it is served rather than embedded — open this board with "board.mjs --serve" to see it. Over file:// there is no server, so this tab stays empty.'));

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
    into.appendChild(header);

    var tiles = el('div', 'tiles');
    tiles.appendChild(tile('tokens', fmtTokens(t.tokens || 0), (t.requests || 0) + ' requests'));
    tiles.appendChild(tile('cost through the API', fmtUsd(t.usd),
      cost.rate_card ? 'rate card ' + cost.rate_card : 'no rate card set', 'lead'));
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
          c.kind.replace('_', ' ') + ' ' + (metric === 'usd' ? fmtUsd(c.usd) : fmtTokens(c.tokens))));
        key.appendChild(legend);
      });
      into.appendChild(bar);
      into.appendChild(key);
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
  if (typeof fetch === 'function') {
    fetch('cost.json', { headers: { accept: 'application/json' } })
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
        if (!payload || payload.schema !== 1) {
          showCostFailure('Spend was served in a format this page does not know (schema ' +
            ((payload && payload.schema) || 'absent') + ') — regenerate the board with the Tyran that served it.');
          return;
        }
        if (!payload.transcripts_found) return; // genuinely nothing to show
        cost = payload;
        renderSpend(spBody, 'tokens');
        var t = cost.totals || {};
        var strip = el('div', 'tiles');
        strip.appendChild(tile('spend so far', fmtUsd(t.usd),
          fmtTokens(t.tokens || 0) + ' tokens · see the Spend tab'));
        ovSpend.appendChild(el('h2', null, 'Spend'));
        ovSpend.appendChild(strip);
      })
      .catch(function () {
        // Over file:// there is no server to ask, which is not a failure —
        // it is the documented shape of this page without one.
        if (String(location.protocol) === 'file:') return;
        showCostFailure('Spend could not be read: the board server did not answer. It is served, never embedded — start it with: npx @jjanczur/tyran board --dir .tyran --serve');
      });
  }

  select('overview');

  var foot = el('footer');
  foot.appendChild(el('div', null, 'GENERATED by tyran scripts/board.mjs — do not edit. Refreshes every 30 s; ages are computed in this browser.'));
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
    '<meta http-equiv="refresh" content="30">\n' +
    '<title>Tyran board</title>\n' +
    `<style>${CSS}</style>\n` +
    '</head><body><main id="app"></main>\n' +
    `<script type="application/json" id="board-data">${embedded}</script>\n` +
    `<script>${CLIENT_JS}</script>\n` +
    '</body></html>\n'
  );
}
