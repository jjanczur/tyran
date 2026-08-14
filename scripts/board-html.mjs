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
.spend-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:.8rem}
.toggle{display:flex;gap:.25rem;margin-left:auto}
.toggle button{font-family:var(--mono);font-size:.7rem;letter-spacing:.06em;text-transform:uppercase;background:var(--bg-raised);color:var(--muted);border:1px solid var(--hairline);border-radius:.35rem;padding:.2rem .6rem;cursor:pointer}
.toggle button[aria-pressed="true"]{background:var(--gold-low);border-color:var(--gold);color:var(--gold-bright)}
.toggle button:focus-visible{outline:2px solid var(--glow);outline-offset:2px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.6rem;margin:.6rem 0}
.stile{background:var(--bg-raised);border:1px solid var(--hairline);border-radius:.55rem;padding:.6rem .8rem}
.stile .lbl{display:block;font-family:var(--mono);font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.stile .big{display:block;font-family:var(--mono);font-size:1.35rem;color:var(--heading);font-variant-numeric:tabular-nums;line-height:1.25}
.stile .sub{display:block;font-family:var(--mono);font-size:.7rem;color:var(--muted)}
.stile.gold{background:var(--gold-low);border-color:var(--gold)}
.stile.gold .big{color:var(--gold-bright)}
.comp{display:flex;height:1.5rem;border:1px solid var(--hairline);border-radius:.35rem;overflow:hidden}
.comp span{display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:.65rem;color:var(--bg);font-weight:700;white-space:nowrap;overflow:hidden}
.comp .s-cache_read{background:var(--gold)}
.comp .s-cache_write{background:var(--glow)}
.comp .s-output{background:var(--green)}
.comp .s-input{background:var(--muted)}
.compkey{display:flex;flex-wrap:wrap;gap:.9rem;font-family:var(--mono);font-size:.68rem;color:var(--muted);margin-top:.35rem}
.compkey i{display:inline-block;width:.6rem;height:.6rem;border-radius:.15rem;margin-right:.3rem}
.chart{display:flex;flex-direction:column;gap:.28rem;margin-top:.4rem}
.chartrow{display:grid;grid-template-columns:minmax(7rem,14rem) 1fr auto;gap:.6rem;align-items:center;font-size:.8rem}
.chartrow .rl{font-family:var(--mono);color:var(--heading);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chartrow .rb{background:var(--bg-sunken);border-radius:.25rem;height:.85rem;overflow:hidden}
.chartrow .rb i{display:block;height:100%;background:var(--gold);border-radius:.25rem}
.chartrow.dim .rl{color:var(--muted);font-style:italic}
.chartrow.dim .rb i{background:var(--hairline)}
.chartrow .rv{font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--text);min-width:5.5rem;text-align:right}
.caveat{color:var(--muted);font-size:.78rem;margin-top:.5rem}
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

  var fmtTokens = function (n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' k';
    return String(n);
  };
  // An amount that rounds to nothing still cost something. Printing $0.00
  // there reads as free, which is the one reading that would change a
  // routing decision for the wrong reason.
  var fmtUsd = function (v) {
    if (v === null || v === undefined) return '—';
    if (v > 0 && v < 0.01) return '<$0.01';
    return '$' + v.toFixed(2);
  };

  var tile = function (label, big, sub, cls) {
    var box = el('div', cls ? 'stile ' + cls : 'stile');
    box.appendChild(el('span', 'lbl', label));
    box.appendChild(el('span', 'big', big));
    box.appendChild(el('span', 'sub', sub));
    return box;
  };

  // One ranked bar chart. The bar is the comparison; the number beside it is
  // the fact. A row whose models have no rate shows no bar at all rather than
  // a zero-length one, because "not priced" and "cost nothing" must not look
  // the same.
  var chart = function (allRows, key, metric, dimKeys) {
    var box = el('div', 'chart');
    // Ranked by the metric on screen, not by the one the server happened to
    // sort by. In cost view a cheap-and-chatty row was being listed above an
    // expensive-and-terse one — the precise inversion of the routing signal
    // this view exists to give. Rows with no price sort last.
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

  var renderSpend = function (into, cost, metric) {
    while (into.firstChild) into.removeChild(into.firstChild);
    var t = cost.totals || {};
    var cov = cost.coverage || {};

    var header = el('div', 'spend-head');
    header.appendChild(el('h2', null, 'Spend'));
    var toggle = el('div', 'toggle');
    [['tokens', 'tokens'], ['usd', 'cost']].forEach(function (pair) {
      var button = el('button', null, pair[1]);
      button.setAttribute('type', 'button');
      button.setAttribute('aria-pressed', metric === pair[0] ? 'true' : 'false');
      button.addEventListener('click', function () { renderSpend(into, cost, pair[0]); });
      toggle.appendChild(button);
    });
    header.appendChild(toggle);
    into.appendChild(header);

    var tiles = el('div', 'tiles');
    tiles.appendChild(tile('tokens', fmtTokens(t.tokens || 0), (t.requests || 0) + ' requests'));
    tiles.appendChild(tile(
      'cost through the API', fmtUsd(t.usd),
      cost.rate_card ? 'rate card ' + cost.rate_card : 'no rate card set', 'gold'));
    tiles.appendChild(tile(
      'conductor overhead', (t.conductor_token_share || 0) + '%', 'of tokens, no ticket'));
    tiles.appendChild(tile(
      'attributed', (cov.attributed || 0) + ' / ' + (cov.agent_transcripts || 0),
      (cov.unattributed || 0) + ' agent(s) without a ticket'));
    into.appendChild(tiles);

    // The composition is the point of the whole section: cache reads dominate
    // the bill, so the lever is context size and turn count, not model price.
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
        // Normalised to a share, not set to the raw value: flex-grow below 1
        // does not fill its container, and dollar amounts are routinely
        // fractions. Measured — the cost view drew a bar 13% of the width
        // while the token view, whose values are thousands, filled it.
        seg.style.flex = String((value / compTotal) * 100);
        bar.appendChild(seg);
        var legend = el('span', null);
        var swatch = el('i', 's-' + c.kind);
        legend.appendChild(swatch);
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

    var notes = [];
    notes.push('Conductor context is not attributable to any ticket; it is shown as its own row so the rows sum to the total.');
    if ((cov.unattributed || 0) > 0) {
      notes.push(cov.unattributed + ' agent(s) carry no ticket id in their task description and are grouped as unattributed.');
    }
    if ((cost.unpriced || []).length > 0) {
      notes.push('Counted in tokens but absent from every amount, having no rate: ' + cost.unpriced.join(', ') + '.');
    }
    // A gap the page must never keep to itself: a transcript appended to while
    // it is read ends in a partial record, so the number above is low by an
    // amount only this line reports.
    if ((cov.malformed || 0) > 0 || (cov.skipped_lines || 0) > 0) {
      notes.push((cov.malformed || 0) + ' unparseable and ' + (cov.skipped_lines || 0) +
        ' oversized record(s) were skipped; their tokens are missing from every figure here.');
    }
    into.appendChild(el('div', 'caveat', notes.join(' ')));
  };

  // Spend is FETCHED, never embedded. It is derived from transcripts under the
  // operator's home directory — machine-local, different in every clone — so
  // writing it into board.json would break the byte-exact --check contract and
  // make two people with one journal disagree. Opened over file:// there is no
  // server, the request fails, and the section simply never appears.
  var spendAt = el('div');
  app.appendChild(spendAt);
  if (typeof fetch === 'function') {
    fetch('cost.json', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cost) {
        if (cost && cost.schema === 1 && cost.transcripts_found) renderSpend(spendAt, cost, 'tokens');
      })
      .catch(function () { /* no server: the board is complete without it */ });
  }

  // An initiative the board could not read is the one thing this page must
  // never omit: a missing card is indistinguishable from an initiative with
  // no work, which is the "all is well" reading the board exists to prevent.
  var errors = data.errors || [];
  if (errors.length > 0) {
    app.appendChild(el('h2', null, 'Unreadable (' + errors.length + ')'));
    errors.forEach(function (e) {
      app.appendChild(el('div', 'paused', 'UNREADABLE — ' + e.name + ': ' + e.error));
    });
  }

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
