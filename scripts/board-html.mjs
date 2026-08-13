#!/usr/bin/env node
/**
 * board-html — the one page an operator stares at overnight.
 *
 * Renders the cross-initiative board payload (see board.mjs) as a single
 * self-contained HTML file: inline CSS, inline JS, no network requests, works
 * over file://. A <meta refresh> keeps it current — fetch() of a sibling file
 * is blocked over file:// in Chromium, so meta-refresh is the one reliable
 * primitive; under `board.mjs --serve` the same refresh hits the server.
 *
 * ## Style: the landing page's system, not a new one
 *
 * Tokens are copied from `site/src/styles/landing.css` (operator-decided
 * 2026-08-14): the stone/gold/glow palette read off the banner, system font
 * stacks (no web fonts), dark only. The semantic mapping keeps the landing's
 * own rules — gold is the ONE accent, so it marks the operator's waiting
 * queue (the page's only call to action); the glow is a light source, so it
 * lights the agent strip (literally the cold light off the agents' screens);
 * red stays refusal (the PAUSED banner, the blocked lane); green stays the
 * ledger `+` (the done lane).
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
  --bg:#12100e;--bg-raised:#1c1917;--bg-sunken:#0d0c0a;
  --text:#d9d2c6;--heading:#f5efe3;--muted:#a29788;
  --hairline:#3b342c;--hairline-soft:#29241f;
  --gold:#d4a017;--gold-bright:#e8bc4d;--gold-low:#2a2110;
  --glow:#8fd8ea;--glow-dim:#1e3a44;
  --red:#f2665e;--red-low:#35191a;--green:#8fce6a;
  --display:ui-serif,'Iowan Old Style','Palatino Linotype',Palatino,'Book Antiqua',Georgia,'Times New Roman',serif;
  --font:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;
  --radius:0.75rem;color-scheme:dark;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);font-size:1rem;line-height:1.55;-webkit-font-smoothing:antialiased;padding:1.25rem}
main{max-width:68rem;margin:0 auto}
h1{font-family:var(--display);color:var(--heading);font-size:1.6rem;margin:0 0 .25rem}
h2{font-family:var(--display);color:var(--heading);font-size:1.05rem;margin:1.5rem 0 .5rem;border-bottom:1px solid var(--hairline-soft);padding-bottom:.3rem}
.meta{color:var(--muted);font-family:var(--mono);font-size:.8rem}
.paused{background:var(--red-low);border:1px solid var(--red);color:var(--red);border-radius:var(--radius);padding:.6rem .9rem;margin:.9rem 0;font-weight:600}
.ask{background:var(--gold-low);border:1px solid var(--gold);border-radius:var(--radius);padding:.7rem .9rem;margin:.5rem 0}
.ask .q{color:var(--gold-bright);font-size:1.05rem;font-weight:600}
.ask .row{margin-top:.25rem;font-size:.9rem}
.ask .label{color:var(--muted);text-transform:uppercase;font-size:.7rem;letter-spacing:.06em;margin-right:.4rem}
.agents{display:flex;flex-wrap:wrap;gap:.5rem}
.agent{background:var(--bg-raised);border:1px solid var(--glow-dim);border-left:3px solid var(--glow);border-radius:var(--radius);padding:.45rem .7rem;font-family:var(--mono);font-size:.8rem;min-width:14rem}
.agent .name{color:var(--glow);font-weight:600}
.agent .age-fresh{color:var(--green)}
.agent .age-warm{color:var(--gold-bright)}
.agent .age-cold{color:var(--red)}
.lanes{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:.7rem;align-items:start}
.lane{background:var(--bg-sunken);border:1px solid var(--hairline-soft);border-radius:var(--radius);padding:.6rem}
.lane h3{margin:0 0 .4rem;font-size:.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.lane h3 .count{color:var(--text)}
.lane.blocked{border-color:var(--red)}
.lane.blocked h3 .count{color:var(--red)}
.lane.done h3 .count{color:var(--green)}
.lane.waiting-operator{border-color:var(--gold-dim, #6d5410)}
.card{background:var(--bg-raised);border:1px solid var(--hairline);border-radius:.5rem;padding:.4rem .55rem;margin:.3rem 0;font-size:.85rem}
.card .id{font-family:var(--mono);color:var(--heading)}
.card .init{font-family:var(--mono);color:var(--muted);font-size:.7rem}
.card .note{color:var(--muted);font-size:.78rem;display:block}
.empty{color:var(--hairline);font-size:.8rem}
footer{margin-top:2rem;color:var(--muted);font-size:.75rem;border-top:1px solid var(--hairline-soft);padding-top:.6rem}
`;

const CLIENT_JS = `
'use strict';
var data = JSON.parse(document.getElementById('board-data').textContent);
if (data.schema !== 1) {
  document.getElementById('app').textContent = 'This board.json is schema ' + data.schema + ' — regenerate with a newer Tyran.';
} else {
  var el = function (tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  var app = document.getElementById('app');
  var head = el('div');
  head.appendChild(el('h1', null, 'Tyran board'));
  var totals = data.totals || {};
  head.appendChild(el('div', 'meta',
    (totals.agents || 0) + ' agent(s) running across ' + (totals.initiatives || 0) + ' initiative(s) · ' +
    (totals.merged || 0) + '/' + (totals.tickets || 0) + ' tickets merged (' + (totals.percent || 0) + '%) · as of ' + (data.as_of || 'unknown')));
  app.appendChild(head);

  (data.paused || []).forEach(function (p) {
    app.appendChild(el('div', 'paused', 'PAUSED — ' + p.init + ': gate ' + p.kind + ' (' + p.result + ') since ' + p.since));
  });

  var asks = data.asks || [];
  app.appendChild(el('h2', null, 'Waiting on you (' + asks.length + ')'));
  if (asks.length === 0) app.appendChild(el('div', 'empty', 'nothing — the agents have what they need'));
  asks.forEach(function (a) {
    var card = el('div', 'ask');
    card.appendChild(el('div', 'q', a.question || '(no question recorded — gate ' + a.kind + ')'));
    [['recommendation', a.recommendation], ['default', a.default],
     ['ticket', a.ticket], ['initiative', a.init], ['since', a.since]].forEach(function (pair) {
      if (pair[1] === null || pair[1] === undefined) return;
      var row = el('div', 'row');
      row.appendChild(el('span', 'label', pair[0]));
      row.appendChild(el('span', null, pair[1]));
      card.appendChild(row);
    });
    app.appendChild(card);
  });

  var agents = data.agents || [];
  app.appendChild(el('h2', null, 'Agents (' + agents.length + ')'));
  var strip = el('div', 'agents');
  if (agents.length === 0) strip.appendChild(el('div', 'empty', 'none running'));
  agents.forEach(function (a) {
    var chip = el('div', 'agent');
    chip.appendChild(el('div', 'name', a.agent + (a.role ? ' · ' + a.role : '')));
    chip.appendChild(el('div', null, (a.init ? a.init + ' · ' : '') + (a.ticket || 'no ticket') + ' · ' + a.state));
    if (a.detail) chip.appendChild(el('div', 'note', a.detail));
    var ageMs = a.last_signal ? Date.now() - Date.parse(a.last_signal) : null;
    var cls = ageMs === null ? 'age-cold' : ageMs < 600000 ? 'age-fresh' : ageMs < 1800000 ? 'age-warm' : 'age-cold';
    var ageText = ageMs === null ? 'no signal' : Math.round(ageMs / 60000) + ' min since last signal';
    chip.appendChild(el('div', cls, ageText));
    strip.appendChild(chip);
  });
  app.appendChild(strip);

  app.appendChild(el('h2', null, 'Lanes'));
  var lanesWrap = el('div', 'lanes');
  Object.keys(data.lanes || {}).forEach(function (lane) {
    var cards = data.lanes[lane];
    var box = el('div', 'lane ' + lane);
    var h = el('h3');
    h.appendChild(el('span', null, lane + ' '));
    h.appendChild(el('span', 'count', '(' + cards.length + ')'));
    box.appendChild(h);
    if (cards.length === 0) box.appendChild(el('div', 'empty', '—'));
    cards.forEach(function (c) {
      var card = el('div', 'card');
      card.appendChild(el('span', 'id', c.id));
      if (c.title) card.appendChild(el('span', null, ' — ' + c.title));
      if (c.init) card.appendChild(el('span', 'init', '  ' + c.init));
      if (c.agents && c.agents.length) card.appendChild(el('span', 'note', 'agents: ' + c.agents.join(', ')));
      if (c.annotation) card.appendChild(el('span', 'note', c.annotation));
      box.appendChild(card);
    });
    lanesWrap.appendChild(box);
  });
  app.appendChild(lanesWrap);

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
