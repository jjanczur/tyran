/**
 * Tests for the cross-initiative board.
 *
 * The properties that matter: an unreadable initiative is a VISIBLE entry
 * (a board that omits a broken initiative reads as "all is well" exactly
 * when it is not), the ceiling refuses loudly, `--check` is byte-exact, the
 * HTML embeds no raw `<` inside its data block, and the serve handler never
 * derives a filesystem path from a URL.
 *
 * The page's own behaviour — four tabs, selectable cards, the commands that
 * answer a question, the muted palette — is asserted against the RENDERED
 * page string, because all of it lives in the client script. No other test in
 * this repository executes that script, so a revert there is invisible
 * everywhere else: board.json is unchanged by every mutation below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOARD_HTML_FILE,
  MAX_INITIATIVES,
  MAX_DOC_CHARS,
  MAX_LOGGED_ERRORS,
  crossBoard,
  crossJson,
  readInitiativeBoards,
  readInitiativeDoc,
  renderAll,
  renderCrossMd,
  openInBrowser,
} from '../../scripts/board.mjs';
import { renderBoardError, renderBoardHtml } from '../../scripts/board-html.mjs';
import { COST_SCHEMA } from '../../scripts/cost.mjs';
import { BOARD_FILE, BOARD_JSON_FILE, LANES } from '../../scripts/project.mjs';
import { readJournal, validateJournal } from '../../scripts/journal.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/board.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../fixtures/journal-demo.jsonl', import.meta.url));

function tree(inits = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-board-'));
  for (const [name, content] of Object.entries(inits)) {
    mkdirSync(join(dir, 'state', name), { recursive: true });
    writeFileSync(join(dir, 'state', name, 'journal.jsonl'), content);
  }
  return dir;
}

const demo = () => readFileSync(FIXTURE, 'utf8');

/** The page exactly as an operator receives it, rendered from the fixture. */
const demoHtml = () => renderAll(tree({ demo: demo() })).files[BOARD_HTML_FILE];

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('readInitiativeBoards returns the journal path it already computed', () => {
  // MUTANT: drop the `journal` key. answer.mjs would then have to re-derive
  // `<dir>/state/<name>/journal.jsonl` for itself — a second spelling of where
  // an initiative's journal lives, in the file that WRITES to it (ADR-21).
  const dir = tree({ demo: demo(), other: demo() });
  const { initiatives } = readInitiativeBoards(dir);
  assert.equal(initiatives.length, 2);
  for (const it of initiatives) {
    assert.equal(it.journal, join(dir, 'state', it.name, 'journal.jsonl'));
    assert.equal(readFileSync(it.journal, 'utf8'), demo(), 'the path must open the journal it folded');
  }
  // extra keys never disturb the payload every other consumer reads
  assert.equal(crossBoard({ initiatives, errors: [] }).totals.initiatives, 2);
});

test('two initiatives merge into one payload with per-card provenance and honest totals', () => {
  const dir = tree({ alpha: demo(), beta: demo().replaceAll('"init":"demo"', '"init":"beta"') });
  const payload = crossBoard(readInitiativeBoards(dir));
  assert.equal(payload.schema, 1);
  assert.equal(payload.totals.initiatives, 2);
  assert.equal(payload.totals.tickets, 6);
  assert.equal(payload.totals.merged, 2);
  assert.equal(payload.asks.length, 4, 'two waiting-operator asks per copy of the fixture');
  assert.deepEqual([...new Set(payload.asks.map((a) => a.kind))].sort(), ['Q-1', 'Q-2']);
  assert.ok(payload.asks.every((a) => a.init === 'alpha' || a.init === 'beta'));
  assert.deepEqual(Object.keys(payload.lanes), [...LANES]);
  const md = renderCrossMd(payload);
  // "open", not "running": the headline counts OPEN SPAWNS, and calling every
  // one of those running is what let a week-old ghost read as live work.
  assert.match(md, /2 agent\(s\) open across 2 initiative\(s\)/);
  assert.doesNotMatch(md, /stale/, 'neither agent is stale, so the headline says nothing about staleness');
  assert.match(md, /## Waiting on you/);
});

test('a DAMAGED journal is a visible error entry, never a healthy empty initiative', () => {
  // MUTANT: fold and push to `initiatives` without the damage guard. Because
  // `readJournal` counts corruption instead of throwing, the catch never
  // fires, and a corrupt file renders as an initiative with nothing wrong —
  // the board reading "all is well" exactly when it is not.
  const dir = tree({ good: demo(), broken: 'not json at all\n{ neither' });
  const { initiatives, errors } = readInitiativeBoards(dir);
  assert.deepEqual(initiatives.map((i) => i.name), ['good'], 'a damaged journal was folded in as an initiative');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, 'broken');
  // the fixture's last line has no newline, so it is a truncated tail rather
  // than a second corrupt line — the message names what was actually found
  assert.match(errors[0].error, /0 readable events and 1 corrupt line\(s\), a truncated final line/);
  const md = renderCrossMd(crossBoard({ initiatives, errors }));
  assert.match(md, /UNREADABLE.*broken/, 'the damaged initiative must be named in the board');
  // an IO-level throw still reaches the same visible entry
  const thrown = crossBoard({ initiatives, errors: [...errors, { name: 'exploded', error: 'EACCES' }] });
  assert.match(renderCrossMd(thrown), /UNREADABLE.*exploded.*EACCES/);
});

test('the page NAMES an unreadable initiative and escapes what the JSON restored', () => {
  // MUTANT 1: drop the errors block from the client — a damaged initiative
  // becomes invisible on the one artifact built for the operator, which is
  // the same silence the fold guard exists to break.
  // MUTANT 2: render with String(text) instead of show(text) — board.json's
  // escaping is lossless, so JSON.parse hands the browser back a raw
  // right-to-left override, which mirrors the rest of the line.
  const html = renderBoardHtml(
    JSON.stringify({
      schema: 1,
      as_of: '2026-07-26T09:00:00.000Z',
      totals: { agents: 0, initiatives: 1, tickets: 0, merged: 0, percent: 0 },
      asks: [],
      agents: [],
      paused: [],
      lanes: {},
      errors: [{ name: 'broken', error: '0 readable events' }],
    }),
  );
  assert.match(html, /Unreadable/, 'the page must have an unreadable section');
  assert.match(html, /data\.errors/, 'the client must read data.errors');
  // the escaper is generated from the ONE forbidden table, and covers astral
  assert.match(html, /new RegExp\('\[\\u\{0\}/, 'the client escaper must be generated from FORBIDDEN');
  assert.match(html, /\\u\{E0000\}-\\u\{E007F\}/, 'the TAG block must reach the client class');
  assert.match(html, /textContent = show\(text\)/, 'every rendered value must go through the escaper');
});

test('the initiative ceiling refuses loudly instead of quietly truncating', () => {
  const inits = {};
  for (let i = 0; i < MAX_INITIATIVES + 1; i++) inits[`init-${String(i).padStart(3, '0')}`] = demo();
  const dir = tree(inits);
  assert.throws(() => readInitiativeBoards(dir), /ceiling is 64/);
  const cli = run(['--dir', dir]);
  assert.equal(cli.code, 2);
  assert.match(cli.stderr, /ceiling/);
});

test('--transcripts only means anything with --serve, exactly like --write', () => {
  const dir = tree({ demo: demo() });
  // MUTANT: let --transcripts through without --serve — it would silently do
  // nothing (the one-shot renderer never calls costReport at all), which is
  // the same kind of invisible no-op --write's own guard already refuses.
  const r = run(['--dir', dir, '--transcripts', '/tmp/somewhere']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--transcripts only means anything with --serve/);
});

test('the CLI writes three files, --check is clean after and drifts after a hand edit', () => {
  const dir = tree({ demo: demo() });
  assert.equal(run(['--dir', dir]).code, 0);
  assert.equal(run(['--dir', dir, '--check']).code, 0);
  writeFileSync(join(dir, 'state', BOARD_FILE), 'hand-edited\n');
  const drift = run(['--dir', dir, '--check']);
  assert.equal(drift.code, 1);
  assert.match(drift.stderr, /drift/);
});

test('the html page embeds the data with no raw < and renders with createElement only', () => {
  const hostile = crossJson({ schema: 1, as_of: null, totals: {}, paused: [], asks: [{ kind: 'k', question: 'closing </script><img src=x>' }], agents: [], lanes: Object.fromEntries(LANES.map((l) => [l, []])), errors: [] }).trimEnd();
  const html = renderBoardHtml(hostile);
  const dataBlock = html.split('id="board-data">')[1].split('</script>')[0];
  assert.ok(!dataBlock.includes('<'), 'raw < inside the embedded JSON');
  assert.ok(html.includes('\\u003C'), 'the < survives as an escape');
  assert.ok(!html.includes('innerHTML'), 'the client must build DOM with createElement/textContent');
});

test('renderAll is deterministic: byte-identical on a second run', () => {
  const dir = tree({ demo: demo() });
  const one = renderAll(dir).files;
  const two = renderAll(dir).files;
  for (const name of [BOARD_FILE, BOARD_JSON_FILE, BOARD_HTML_FILE]) {
    assert.equal(one[name], two[name], name);
  }
});

test('an empty state directory renders an honest empty board, exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-board-empty-'));
  mkdirSync(join(dir, 'state'), { recursive: true });
  const r = run(['--dir', dir]);
  assert.equal(r.code, 0);
  const md = readFileSync(join(dir, 'state', BOARD_FILE), 'utf8');
  assert.match(md, /0 agent\(s\) open across 0 initiative\(s\)/);
});

test('the page fetches spend rather than embedding it, so the artefacts stay byte-exact', () => {
  const dir = tree({ demo: demo() });
  const { files } = renderAll(dir);
  const html = files[BOARD_HTML_FILE];
  // MUTANT: inline the cost payload into board.html or board.json. Spend is
  // derived from transcripts under the operator's HOME directory — machine
  // local, different in every clone — so embedding it would break the
  // byte-exact --check contract and make two people with one journal
  // disagree about what their own board says.
  // The URL now carries the chosen window, so match the route rather than a
  // whole literal — the query string is exactly the part that varies.
  assert.match(html, /fetch\('cost\.json\?window='/, 'the page asks a server for spend, by window');
  assert.ok(!html.includes('"conductor_token_share":'), 'no spend numbers are baked into the page');
  assert.ok(!files[BOARD_JSON_FILE].includes('conductor_token_share'), 'board.json carries no spend');
  // Over file:// there is no server: the request fails and the section never
  // appears, which is why the failure path is a silent catch.
  assert.match(html, /\.catch\(function \(\) \{/);
});

test('the spend charts rank by the metric on screen, not by the one the server sorted', () => {
  const dir = tree({ demo: demo() });
  const html = renderAll(dir).files[BOARD_HTML_FILE];
  // MUTANT: revert either sort in board-html.mjs to the server's token order.
  // In cost view a cheap-and-chatty row is then listed above an
  // expensive-and-terse one — the precise inversion of the routing signal
  // that view exists to give — and nothing anywhere else in this suite sees
  // it, because the ordering lives entirely in the client script.
  assert.match(html, /var valueOf = function \(r\) \{ return metric === 'usd' \? r\.usd : r\.tokens; \};/,
    'the ranked charts must read the active metric');
  assert.match(html, /metric === 'usd' \? \(b\.usd \|\| 0\) - \(a\.usd \|\| 0\) : b\.tokens - a\.tokens/,
    'the composition bar must reorder with the metric too');
  // Rows with no price sort last rather than claiming the top slot.
  assert.match(html, /if \(typeof av !== 'number'\) return 1;/);
});

test('the page is four tabs, opens on Overview, and carries the queue count in its label', () => {
  // MUTANT 1: delete a tab and fold its panel back into the scroll. The four
  // questions were competing for one screen, which is the state the tabs
  // exist to end.
  // MUTANT 2: drop `asks.length` from the questions label. An operator
  // reading the Spend tab then has no signal anywhere that something is
  // waiting on them — the count in the label is the only thing that survives
  // being on another tab, and it is the board's whole reason to exist.
  const html = demoHtml();
  assert.match(html, /\['overview', '📊 Overview', null\]/);
  assert.match(html, /\['board', '🗂 Board', null\]/);
  assert.match(html, /\['questions', '❓ Waiting on you', asks\.length\]/, 'the queue label must count the open asks');
  assert.match(html, /\['spend', '💸 Spend', null\]/);
  assert.match(html, /el\('span', 'count', '\(' \+ spec\[2\] \+ '\)'\)/, 'the count must reach the tab label');
  assert.match(html, /panels\[k\]\.hidden = !on;/, 'an unselected tab must be hidden, not merely unstyled');
  // Overview is now the FALLBACK rather than an unconditional opening move —
  // the tab travels in the fragment (see the test below) — and a page reached
  // with no fragment, or with one no tab answers to, must still open here.
  assert.match(
    html,
    /hasOwnProperty\.call\(panels, wanted\) \? wanted : 'overview';/,
    'an absent or unknown fragment must fall back to Overview',
  );
});

test('the open tab travels in the URL, because the page reloads itself under the reader', () => {
  // MUTANT 1: drop the replaceState and let `select` keep tab state in memory
  // only. Every 30-second reload then throws the reader from Spend or
  // Settings back to Overview — measured on a real board, and the reason this
  // exists: the page whose whole pitch is that you can leave it open was
  // resetting twice a minute.
  // MUTANT 2: swap replaceState for `location.hash = key`. The tab is
  // restored, and the Back button now walks backwards through one history
  // entry per refresh instead of leaving the page.
  // MUTANT 3: read the fragment with `panels[wanted]` instead of
  // hasOwnProperty. A URL ending in a fragment spelling "constructor" then
  // selects an inherited property and the page throws while rendering.
  const html = demoHtml();
  assert.match(html, /history\.replaceState\(null, '', '#' \+ key\);/, 'the tab must be written to the fragment');
  assert.ok(!/location\.hash = /.test(html), 'assigning location.hash pushes a history entry per reload');
  assert.match(html, /var wanted = String\(location\.hash \|\| ''\)\.replace\(\/\^#\/, ''\);/);
  assert.match(html, /Object\.prototype\.hasOwnProperty\.call\(panels, wanted\)/);
  // MUTANT 4: drop the hashchange listener. Changing only the fragment is a
  // SAME-DOCUMENT navigation — nothing reloads — so a link to #board, or an
  // operator editing the address bar on the page they already have open,
  // moves the URL and leaves the page where it was. Found in a browser,
  // because no source reading shows it.
  assert.match(html, /window\.addEventListener\('hashchange', function \(\) \{ select\(tabFromHash\(\)\); \}\);/);
});

test('Spend and Settings hold the refresh; Overview and Board must not', () => {
  // MUTANT 1: drop `spend` from HELD_TABS. The cost tab then re-runs its
  // transcript scan under a reader comparing two rows, to redraw numbers that
  // did not move.
  // MUTANT 2: add `board` or `overview`. That is the failure this page exists
  // to prevent — an operator asleep in front of a board that stopped updating
  // at midnight cannot tell it from a fleet that stopped working.
  const html = demoHtml();
  assert.match(html, /var HELD_TABS = \{ settings: true, spend: true \};/);
  assert.match(html, /if \(HELD_TABS\[key\] === true\) holdRefresh\(\); else armRefresh\(\);/);
  // The lane filter is typing too, and it died on every reload like the
  // answer boxes used to. Re-armed when empty, or a filter left in the box
  // freezes the one view that has to stay live.
  assert.match(html, /if \(filterInput\.value\.trim\(\) === ''\) armRefresh\(\); else holdRefresh\(\);/);
});

test('a lane card is a button that presses, so the detail panel has something to hang off', () => {
  // MUTANT: render the cards as `div`s again, or drop `aria-pressed`. The
  // card can then never be selected, the panel under the lanes never opens,
  // and everything that does not fit on a card — the lane, the initiative,
  // the agents, the annotation, the ticket's own spend — has nowhere to go
  // but a wider card, which is what the lanes cannot afford.
  const html = demoHtml();
  assert.match(html, /var button = el\('button', 'card'\);/, 'a card must be a real button, not a clickable div');
  assert.match(html, /button\.setAttribute\('aria-pressed', 'false'\);/);
  assert.match(html, /button\.addEventListener\('click', function \(\) \{ showDetail\(c, lane, button\); \}\);/);
  // exactly one card is pressed: the previous selection is released first
  assert.match(html, /if \(selected\) selected\.setAttribute\('aria-pressed', 'false'\);/);
  assert.match(html, /\.card\[aria-pressed="true"\]\{/, 'the pressed card must be the visibly selected one');
  for (const row of [/row\('lane', lane\);/, /row\('initiative', card\.init\);/, /row\('agents',/, /row\('note', card\.annotation\);/]) {
    assert.match(html, row, `the detail panel dropped ${row}`);
  }
});

test('the questions tab prints the three commands that close a question', () => {
  // MUTANT: delete the `pre.how` block from the questions panel. The queue
  // then shows an operator precisely what is waiting on them and no way to
  // answer it — `answer render` / `answer apply` is the one thing on this
  // page that cannot be guessed from what is on screen. Spelled with `npx`
  // because a plugin install puts no `tyran` on the PATH and an adopting repo
  // has no `scripts/` of its own.
  const html = demoHtml();
  assert.match(html, /npx @jjanczur\/tyran answer render --dir \.tyran/);
  assert.match(html, /\$EDITOR \.tyran\/state\/ANSWERS\.md/);
  assert.match(html, /npx @jjanczur\/tyran answer apply --dir \.tyran/);
  // and the answer words, because a blank line is a recorded decision and
  // reads as one only if the page says so before it is typed
  assert.match(html, /Blank takes the recorded default and is still written down as your decision; a single dash leaves it for next time\./);
});

test('the terminal commands fold away on a board that can answer, and open on one that cannot', () => {
  // MUTANT 1: render the pre unwrapped again. Three commands an operator with
  // a writable board never needs then sit above the questions, which is where
  // the eye lands first — reported as "npx commands without any context".
  // MUTANT 2: keep the details but drop the two lines that open it. A
  // read-only board, or one opened over file://, then HIDES the only route
  // that can close a question there, which is strictly worse than printing it
  // unconditionally ever was.
  const html = demoHtml();
  assert.match(html, /var howBox = el\('details', 'howbox'\);/);
  assert.match(html, /el\('summary', null, 'Answer from the terminal instead'\)/);
  assert.ok(!/howBox\.open = true;\s*\n\s*qs\.appendChild/.test(html), 'it must not start open');
  // opened by the fact only the server has, on both branches: served
  // read-only, and not served at all
  assert.match(html, /if \(payload\.writable !== true\) howBox\.open = true;/);
  assert.match(html, /howBox\.open = true;\n\s*if \(String\(location\.protocol\) === 'file:'\) return;/);
});

test('a modifier plus Enter sends an answer, and Enter alone does not', () => {
  // MUTANT 1: delete the keydown listener. "Answer" is then the only way to
  // send, and an operator who types a sentence and presses Enter gets a
  // newline with nothing on the page to say why — reported as "there is no
  // send button".
  // MUTANT 2: drop the metaKey/ctrlKey test and send on bare Enter. This is a
  // textarea because answers are sentences, and what it sends is appended to
  // a journal that can never take it back: a gate closed by a stray keystroke
  // is a decision nobody made.
  const html = demoHtml();
  assert.match(html, /input\.addEventListener\('keydown', function \(e\) \{/);
  assert.match(html, /if \(\(e\.metaKey \|\| e\.ctrlKey\) && \(e\.key === 'Enter' \|\| e\.keyCode === 13\)\) \{/);
  assert.match(html, /e\.preventDefault\(\);\n\s*attempt\(\);/);
  // one code path, not two: the button and the shortcut must refuse an empty
  // box in the same words
  assert.match(html, /send\.addEventListener\('click', attempt\);/);
  // and the shortcut is named where the cursor already is
  assert.match(html, /Ctrl\+Enter sends\./);
});

test('the palette is the muted one, saturation on edges rather than on whole fills', () => {
  // MUTANT: restore the first version's tokens — `--gold`, `--glow`, `--red`,
  // `--green` at full saturation, filling whole bars and whole cards. It was
  // rejected as "a bit too flashy" (operator, 2026-08-14): an alarm colour on
  // every surface leaves nothing louder for the one card that IS an alarm.
  // The roles are unchanged, so no other assertion in this suite moves.
  const html = demoHtml();
  for (const token of ['--brass:', '--steel:', '--clay:', '--sage:']) {
    assert.ok(html.includes(token), `${token} is not defined`);
  }
  for (const gone of ['--gold', '--glow', '--red:', '--green:']) {
    assert.ok(!html.includes(gone), `${gone} is a token of the flashy palette`);
  }
  // the large surfaces take the muted `-low` tone; the accent itself is spent
  // on a border, a 3px rail and the text
  assert.match(html, /\.ask\{background:var\(--brass-low\);border:1px solid var\(--brass-edge\);border-left:3px solid var\(--brass\)/);
  assert.match(html, /\.paused\{background:var\(--clay-low\);border:1px solid var\(--clay\)/);
  assert.match(html, /\.agent\{[^}]*border-left:3px solid var\(--steel-edge\)/);
});

test('spend reaches three places from the one fetch, and explains itself when there is none', () => {
  // MUTANT: drop the overview headline, or the per-ticket row in showDetail.
  // Both hang off the same payload the Spend tab fetches, so losing either
  // costs nothing on the Spend tab — where every other spend test looks — and
  // the number quietly stops following the operator to the tab they are on.
  // MUTANT 2: delete the hint. A board opened over file:// then shows an
  // empty panel, which reads as broken rather than as unserved.
  const html = demoHtml();
  assert.match(html, /ovSpend\.appendChild/, 'the overview must carry a spend headline once the fetch lands');
  assert.match(html, /if \(cost\) \{/, 'a selected card must be able to show its own spend');
  assert.match(html, /row\('spend', fmtTokens\(hit\.tokens\) \+ ' tokens [^']*' \+ fmtUsd\(hit\.usd\)\);/);
  assert.match(html, /You are reading the file on disk, so this tab stays empty\./);
  // And it points at the form that returns the shell. `--serve` holds the
  // terminal, which is what a person at a prompt may want and what an operator
  // following a hint off a web page does not.
  assert.match(html, /--detach" to start one and print it\./);
});

test('the missing-transcript-dir hint renders even when nothing was found at all', () => {
  // MUTANT: revert the fetch handler's `if (!payload.transcripts_found)` back
  // to a bare `return;`. The pure function's own tests (board-client-literal
  // .test.mjs) would stay green — they never touch this call site — while the
  // Spend tab silently keeps its pre-fetch "you are reading the file" hint on the
  // exact payload review reproduced live: every `spend.transcript_dirs` entry
  // present but every one of them a typo. This test pins the WIRING, not just
  // the function it wires in.
  const html = demoHtml();
  const handler = html.slice(
    html.indexOf('if (!payload.transcripts_found) {'),
    html.indexOf('cost = payload;'),
  );
  assert.notEqual(handler.indexOf('if (!payload.transcripts_found) {'), -1, 'the guard itself must survive');
  assert.match(handler, /clear\(spBody\)/, 'the stale pre-fetch hint must be cleared, not left standing');
  assert.match(
    handler,
    /spendResolutionHints\(payload\)\.forEach\(function \(h\) \{ spBody\.appendChild\(el\('div', 'hint', h\)\); \}\)/,
    'the branch that never reaches renderSpend must still call the shared hint function',
  );
});

// --- the half that did not render -----------------------------------------
//
// The damage guard above fires only when NOTHING was readable. Everything
// below is the other half of the same argument: an initiative that folded
// successfully can still have lost lines, agents can go quiet, spend can fail
// to load, and each of those used to render as a board with nothing wrong.

/** The fixture with one line replaced by garbage — readable, but not whole. */
function partlyDamaged() {
  const lines = demo().trimEnd().split('\n');
  lines.splice(3, 0, '{not json at all');
  return lines.join('\n') + '\n';
}

test('a PARTIALLY damaged journal renders, and says what it lost', () => {
  // MUTANT: drop the warnings() call in readInitiativeBoards. The board folds
  // the readable events, reports errors: [], and renders an initiative in
  // perfect health while a line of its ledger is gone. This is the exact
  // shape the total-loss guard cannot see, and it is the likelier one: a
  // crash mid-write damages the tail, not the whole file.
  const dir = tree({ demo: partlyDamaged() });
  const read = readInitiativeBoards(dir);
  assert.equal(read.errors.length, 0, 'it is readable — this is not the total-loss case');
  assert.equal(read.initiatives.length, 1, 'and it must still render');
  assert.match(read.warned[0].warnings.join(' '), /corrupt line/);

  assert.match(renderCrossMd(crossBoard(read)), /\*\*WARNING\*\* — demo: .*corrupt line/);
  const html = renderAll(dir).files[BOARD_HTML_FILE];
  assert.match(html, /Warnings \(/, 'the page too — BOARD.md is not what the operator stares at');
});

test('an intact journal is never accused of corruption', () => {
  // The other half of the mutant above. A banner that is always on is a
  // banner nobody reads, which is the failure mode of the FIX rather than of
  // the bug — so the claim pinned here is specific: no integrity warning on a
  // journal whose bytes are all there. (The shipped fixture does carry one
  // state warning, a lease released by a non-holder, and that one is
  // deliberately surfaced too.)
  const read = readInitiativeBoards(tree({ demo: demo() }));
  const all = read.warned.flatMap((w) => w.warnings).join(' ');
  assert.doesNotMatch(all, /corrupt|truncated|non-object/);
  assert.ok(readInitiativeBoards(tree({ demo: partlyDamaged() })).warned[0].warnings.length > read.warned.length);
});

test('needs-a-human counts blocked AGENTS, not only blocked lanes', () => {
  // MUTANT: count lanes.blocked + lanes['changes-requested'] alone. A ticket
  // parked by a ticket.status override leaves no card in the blocked lane —
  // boardOf resolves the override BEFORE the blockage — so the tile read 0
  // while an agent chip on the same screen said "blocked". Measured on the
  // shipped fixture.
  const payload = crossBoard(readInitiativeBoards(tree({ demo: demo() })));
  const blockedAgents = payload.agents.filter((a) => a.state === 'blocked').length;
  assert.ok(blockedAgents > 0, 'the fixture must keep an agent blocked or this test proves nothing');
  const lanes = payload.lanes.blocked.length + payload.lanes['changes-requested'].length;
  assert.equal(payload.totals.blocked, lanes + blockedAgents);
  assert.ok(payload.totals.blocked > lanes, 'the agent is the whole point — lanes alone missed it');
});

test('the agent strip is ordered stalest first, whatever order the journals spawned them', () => {
  // MUTANT: keep journal order. The strip carries a last-signal age precisely
  // because the silent agent is the one worth looking at, and journal order
  // puts it anywhere — including last, below the fold.
  const dir = tree({ alpha: demo(), beta: demo().replaceAll('"init":"demo"', '"init":"beta"') });
  const { agents } = crossBoard(readInitiativeBoards(dir));
  assert.ok(agents.length >= 2);
  const signals = agents.map((a) => String(a.last_signal ?? ''));
  assert.deepEqual(signals, [...signals].sort(), 'ascending ISO time is ascending staleness-first');

  // MUTANT: drop the 'next:' line from the chip. The board then says an agent
  // went quiet without saying what it went quiet in the MIDDLE of — and the
  // field has been in board.json since the fold learned to read progress.
  assert.match(demoHtml(), /'next: ' \+ a\.next/);
  // MUTANT: keep three age buckets. Thirty minutes and six hours then share a
  // colour and a sentence, and they are not the same event.
  assert.match(demoHtml(), /likely dead/);
});

test('the drill-down lists the initiative files that exist, and invents none', () => {
  // MUTANT: return a fixed list of PLAN.md/NOTES.md/RETRO.md without the
  // existsSync. The panel then names files that are not there, which is the
  // same lie as omitting the ones that are — and the operator asked
  // explicitly that nothing be created to satisfy the link.
  const dir = tree({ demo: demo() });
  writeFileSync(join(dir, 'state', 'demo', 'PLAN.md'), '# plan\n');
  const payload = crossBoard(readInitiativeBoards(dir));
  assert.deepEqual(payload.files.demo.map((f) => f.name), ['PLAN.md']);
  assert.match(payload.files.demo[0].path, /state\/demo\/PLAN\.md$/);

  const bare = crossBoard(readInitiativeBoards(tree({ demo: demo() })));
  assert.deepEqual(bare.files, {}, 'no files on disk, no files claimed');
});

test('a document is reached by TWO CLOSED SETS, never by a path from the URL', () => {
  // The reason this route could be added at all. `initiativeFiles` has said
  // since it was written that the board derives a filesystem path from no URL,
  // and that promise is kept by never joining request text into a path until
  // it has matched a fixed list — the traversal cases below are refused
  // because they are never candidates, not because a filter caught them.
  //
  // MUTANT: accept any `name` and join it. Every one of these then reads a
  // file outside the initiative, from a server the operator left running.
  const dir = tree({ demo: demo() });
  writeFileSync(join(dir, 'state', 'demo', 'PLAN.md'), '# plan\n');
  writeFileSync(join(dir, 'secret.txt'), 'not yours\n');

  for (const name of ['../../secret.txt', '../secret.txt', '/etc/passwd', 'plan.md', 'PLAN.md ', '', 'journal.jsonl']) {
    const out = readInitiativeDoc(dir, 'demo', name);
    assert.equal(out.ok, false, `${JSON.stringify(name)} must be refused`);
    assert.equal(out.status, 400);
    assert.match(out.error, /this board serves only: PLAN\.md, NOTES\.md/);
  }
  for (const init of ['..', '../..', 'demo/../demo', 'nope', '']) {
    const out = readInitiativeDoc(dir, init, 'PLAN.md');
    assert.equal(out.ok, false, `initiative ${JSON.stringify(init)} must be refused`);
    assert.equal(out.status, 404);
  }
  // Nothing the caller sent is echoed back: a refusal naming what was asked
  // for carries attacker-chosen text into the operator's browser.
  assert.ok(!readInitiativeDoc(dir, '<script>', 'PLAN.md').error.includes('<script>'));

  const ok = readInitiativeDoc(dir, 'demo', 'PLAN.md');
  assert.equal(ok.ok, true);
  assert.equal(ok.text, '# plan\n');
  // Repo-relative, the form `initiativeFiles` already records: an absolute
  // path names a home directory and a username.
  assert.match(ok.path, /^[^/]+\/state\/demo\/PLAN\.md$/);
});

test('a document is invisible-escaped and capped, like every value that reaches a human', () => {
  // MUTANT 1: return the file raw. These documents are written by agents out
  // of reports about FOREIGN repositories, and the reader is looking at them
  // on a page rather than in the editor that would show the same bytes — the
  // exact asymmetry invisible.mjs was written to end.
  // MUTANT 2: slice a Buffer instead of codepoints. The cut then lands inside
  // a character and the panel shows a replacement mark that was never there.
  const dir = tree({ demo: demo() });
  writeFileSync(join(dir, 'state', 'demo', 'NOTES.md'), `bidi ${String.fromCodePoint(0x202e)} here\n`);
  const escaped = readInitiativeDoc(dir, 'demo', 'NOTES.md');
  assert.ok(!escaped.text.includes(String.fromCodePoint(0x202e)), 'a bidi override must not reach the page');
  assert.match(escaped.text, /<U\+202E>/);
  assert.equal(escaped.truncated, false);

  // One astral character per position, so a byte-wise cut would be visible.
  writeFileSync(join(dir, 'state', 'demo', 'PROGRESS.md'), '🙂'.repeat(MAX_DOC_CHARS + 10));
  const cut = readInitiativeDoc(dir, 'demo', 'PROGRESS.md');
  assert.equal(cut.truncated, true);
  assert.equal(cut.chars, MAX_DOC_CHARS);
  assert.equal([...cut.text].length, MAX_DOC_CHARS, 'the cut is counted in codepoints, not UTF-16 units');
  assert.ok(!cut.text.includes('�'), 'no character may be cut in half');
});

test('over the ceiling the SERVED page is readable prose, not a 500 it re-fetches every 30 s', () => {
  // MUTANT: leave the handler's catch writing a plain-text 500. The page sets
  // its own meta refresh, so the browser then re-requests an error nobody can
  // read twice a minute. The CLI keeps throwing — that pin is one test above,
  // and refusing loudly is right when a human is reading exit codes.
  const html = renderBoardError('65 initiative directories — the ceiling is 64.');
  assert.match(html, /The board cannot be rendered/);
  assert.match(html, /the ceiling is 64/);
  assert.doesNotMatch(html, /http-equiv="refresh"/, 'an error page that reloads itself is a loop');
  assert.doesNotMatch(html, /innerHTML/);
});

test('a hostile message on the error page stays text', () => {
  // MUTANT: interpolate the message into the markup. It comes from an
  // exception, an exception carries a path, and a path is input.
  const html = renderBoardError('<img src=x onerror=alert(1)> /tmp/</script><script>');
  assert.doesNotMatch(html, /<img src=x/);
  assert.ok(html.includes('\\u003C'), 'the message travels through the same JSON channel the board uses');
});

test('a spend failure says which failure it was', () => {
  // MUTANT: map every non-OK response to null and return silently. A crashed
  // reader, an unparseable rate card and an unserved page then look identical
  // — all three are simply a missing section — and the server had already
  // built the sentence that tells them apart.
  const html = demoHtml();
  assert.match(html, /Spend could not be read/);
  assert.match(html, /showCostFailure/);
  assert.match(html, /location\.protocol/, 'file:// is not a failure and must not be reported as one');
});

test('board.json carries no absolute path, so two clones of one journal agree', () => {
  // MUTANT: record the absolute path of each initiative file — which is the
  // obvious thing to record, since it is what an operator pastes. board.json
  // is committed and compared BYTE for byte, so an absolute path makes
  // `--check` fail on any machine whose home directory is spelled
  // differently. It is the same reason spend is served instead of embedded,
  // and it was nearly shipped here before this test existed.
  const dir = tree({ demo: demo() });
  writeFileSync(join(dir, 'state', 'demo', 'PLAN.md'), '# plan\n');
  const json = renderAll(dir).files[BOARD_JSON_FILE];
  assert.match(json, /PLAN\.md/, 'the file has to be in there or this proves nothing');
  assert.ok(!json.includes(dir), 'the temp directory leaked into a committed artefact');
  for (const line of json.split('\n')) {
    assert.doesNotMatch(line, /"path": "\//, 'a path starting at the filesystem root is machine-specific');
  }
});

test('the page reloads on a timer it can stop, never on a meta refresh', () => {
  // A real http-equiv refresh is scheduled by the browser when it PARSES the
  // tag, and removing the node afterwards does not cancel it. The page has a
  // Settings tab and an answer box now, so a reload it cannot stop destroys a
  // half-typed value — and the code used to claim, in a comment, that removing
  // the tag was enough.
  //
  // MUTANT: put `http-equiv="refresh"` back. Every other assertion about the
  // page still passes, and the one thing that breaks is invisible from here:
  // a value someone was typing.
  const html = demoHtml();
  assert.doesNotMatch(html, /http-equiv=["']refresh/i, 'the browser must schedule no navigation of its own');
  assert.match(html, /<meta name="tyran-refresh" content="30">/, 'the interval is declared as inert markup');
  assert.match(html, /meta\[name="tyran-refresh"\]/, 'and the client is what reads it');
  assert.match(html, /clearTimeout\(refreshTimer\)/, 'the timer must be cancellable');
});

test('the sandbox strips the marker, and stripping it is all it takes', () => {
  // MUTANT: leave the marker in. The published docs page would then reload
  // every 30 seconds and snap a reader back to the first tab mid-click, which
  // is exactly what the generator exists to prevent.
  const src = readFileSync(fileURLToPath(new URL('../../site/scripts/build-sandbox.mjs', import.meta.url)), 'utf8');
  assert.match(src, /const refresh = '<meta name="tyran-refresh" content="30">/);
  assert.match(src, /throw new Error\('the refresh tag moved/, 'a silent no-op here publishes a self-reloading page');
});

test('the client script actually parses, which nothing else in this suite proves', () => {
  // MUTANT: any stray backtick in CLIENT_JS. The whole client is one template
  // literal in board-html.mjs, so a backtick inside a COMMENT terminates it
  // and the module stops loading — which is how this was found, by a comment
  // that quoted an identifier. Every other test here matches strings in the
  // rendered page and would happily match a page that cannot run.
  const html = demoHtml();
  // TWO plain script elements since the theme override: the pre-paint head
  // script and the client. The JSON payload carries a type attribute, so a
  // bare <script> match cannot pick it up. Both must parse; the size floor
  // still proves the client is the last one.
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2, 'the head theme script and the client, nothing else');
  const js = scripts[scripts.length - 1];
  assert.ok(js.length > 1000, 'the client script is missing entirely');
  for (const s of scripts) {
    assert.doesNotThrow(() => new Function(s), 'the page ships JavaScript that does not parse');
  }
});

test('two palettes, three theme states, and the override lands before first paint', () => {
  // MUTANT 1: drop the dark blocks. The board goes light-only and a dark OS
  // gets a light page it never asked for.
  // MUTANT 2: drop the :not() guard. An explicit "light" choice then loses
  // to a dark OS and the toggle can never take the page light again.
  // MUTANT 3: move the stored-theme read into the client script. The page
  // paints light for a frame on every reload before snapping dark.
  const html = demoHtml();
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /:root:not\(\[data-theme="light"\]\)/);
  assert.match(html, /:root\[data-theme="dark"\]/);
  const headEnd = html.indexOf('</head>');
  const themeAt = html.indexOf('tyran-board-theme');
  assert.ok(themeAt !== -1 && themeAt < headEnd, 'the stored theme applies in the head, before the body paints');
  assert.match(html, /\[\['system', 'System'\], \['light', 'Light'\], \['dark', 'Dark'\]\]/, 'three states, system included');
  assert.match(html, /localStorage\.removeItem\(THEME_KEY\)/, '"system" clears the override rather than storing a third value');
});

test('the footer signs the work and the masthead links to its people', () => {
  // The docs site's sign-off, on the surface the operator actually lives on.
  const html = demoHtml();
  assert.match(html, /From Berlin with /);
  assert.match(html, /janczura\.com\/en\//);
  assert.match(html, /linkedin\.com\/in\/jacekjanczura/);
  assert.match(html, /github\.com\/jjanczur\/tyran/);
  assert.match(html, /GENERATED by tyran scripts\/board\.mjs/, 'the provenance line survives the attribution');
});

test('a question card says how long it has waited and what silence decides', () => {
  // MUTANT 1: drop the wait chip — "a question exists" and "a question has
  // waited a day" read identically again.
  // MUTANT 2: fold the default back into the plain dl rows — the answer to
  // "what happens if I never come back" renders at the weight of a slug.
  const html = demoHtml();
  assert.match(html, /'waiting ' \+ durText\(waitMs\)/);
  assert.match(html, /waitMs >= 86400000 \? ' long' : ''/, 'a day of waiting changes the chip, not just the number');
  assert.match(html, /'row defrow'/);
  assert.match(html, /default \\u2014 if you don\\u2019t answer/);
});

test('the queue count reaches the browser tab, not only the tab strip', () => {
  // MUTANT: drop the document.title line. The page is meant to be left open
  // overnight, and a background tab said nothing at all — the count existed
  // only on a tab you had to be looking at.
  assert.match(demoHtml(), /document\.title = \(asks\.length > 0/);
});

test('the seen baseline is written on a press, never on a load', () => {
  // MUTANT: call writeSeen() during startup. The page refreshes itself every
  // 30 seconds, so the baseline would be replaced twice a minute and "changed
  // since you marked seen" would permanently mean "changed in the last 30
  // seconds" — which is the same as showing nothing at all.
  const html = demoHtml();
  assert.match(html, /addEventListener\('click', function \(\) \{\s*if \(writeSeen\(\)\)/);
  const startup = html.slice(html.indexOf('var seen = readSeen'), html.indexOf('var app = document'));
  assert.doesNotMatch(startup, /writeSeen\(\)/, 'the baseline moved without the operator saying so');
});

test('localStorage refusing outright degrades to no baseline, not to a broken page', () => {
  // MUTANT: drop the try/catch. Safari over file:// and a locked-down private
  // window both THROW on localStorage access rather than returning null, and
  // the whole board would fail to render on a page that is documented to work
  // over file://.
  const html = demoHtml();
  const reader = html.slice(html.indexOf('var readSeen'), html.indexOf('var writeSeen'));
  assert.match(reader, /try \{/);
  assert.match(reader, /catch \(e\) \{ return null; \}/);
});

test('a merged ticket still names who did the work', () => {
  // MUTANT: leave the card carrying only the RUNNING agents. That list empties
  // the moment an agent reports, so every done card showed nobody — and "who
  // touched this" is a question asked about finished tickets, never about
  // running ones.
  const payload = crossBoard(readInitiativeBoards(tree({ demo: demo() })));
  const withHistory = [...Object.values(payload.lanes)].flat().filter((c) => (c.worked_by || []).length > 0);
  assert.ok(withHistory.length > 0, 'the fixture must have a ticket somebody worked on');
  for (const card of withHistory) {
    assert.deepEqual(card.worked_by, [...card.worked_by].sort(), 'board.json is byte-compared: spawn order is not an order');
    assert.equal(card.worked_by.length, new Set(card.worked_by).size, 'an agent listed twice is a rendering bug');
  }
  assert.match(demoHtml(), /'worked by'/);
});

test('nothing-started and nothing-finished do not render as the same board', () => {
  // MUTANT: keep one progress tile. "0% · 0 of 0 merged" is what a brand new
  // initiative shows AND what a fully stalled one shows, and those call for
  // opposite reactions.
  const html = renderAll(tree({})).files[BOARD_HTML_FILE];
  assert.match(html, /no initiatives yet/);
  assert.match(html, /no tickets declared yet/);
});

test('a STOP is on the board, because a halted fleet and a dead one look identical', () => {
  // Three chips reading "6 HOURS since last signal" cover four unrelated
  // situations, and the board could tell them apart in none of them. STOP is
  // committed repo state — identical in every clone — so it belongs in the
  // artefact rather than behind a route. MUTANT: drop `stop` from crossBoard.
  const dir = mkdtempSync(join(tmpdir(), 'tyran-stop-'));
  try {
    mkdirSync(join(dir, 'state', 'demo'), { recursive: true });
    writeFileSync(join(dir, 'state', 'demo', 'journal.jsonl'), readFileSync(FIXTURE, 'utf8'));
    assert.equal(renderAll(dir).payload.stop.stopped, false);

    writeFileSync(join(dir, 'STOP'), 'ci is red on main, do not continue\nsecond line ignored\n');
    const { payload, files } = renderAll(dir);
    assert.equal(payload.stop.stopped, true);
    assert.equal(payload.stop.reason, 'ci is red on main, do not continue');
    assert.match(files[BOARD_FILE], /\*\*STOPPED\*\* — an operator halted this repo: ci is red on main/);
    assert.match(files[BOARD_HTML_FILE], /STOPPED/);

    // The path `checkStopAt` also returns must NOT travel: board.json is
    // committed and compared byte for byte, so an absolute path makes two
    // clones of one journal disagree. MUTANT: spread the whole result in.
    assert.equal(payload.stop.path, undefined);
    assert.doesNotMatch(files[BOARD_JSON_FILE], /"path": "\//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an error with no ticket reaches the board, under a key that does not already mean something else', () => {
  // `fold()` collects state.errors and crossBoard carried neither it nor the
  // unknown-ticket list, so an agent logging a hard error showed nothing at
  // all on the page whose whole job is to say "not all is well".
  //
  // The key is `errors_logged`, NOT `errors`: that name already means "this
  // journal could not be read", and one key with two meanings is the defect
  // ADR-21 is named after. MUTANT: merge them into `errors`, and an unreadable
  // initiative and a logged error become indistinguishable.
  const dir = mkdtempSync(join(tmpdir(), 'tyran-errs-'));
  try {
    mkdirSync(join(dir, 'state', 'demo'), { recursive: true });
    const lines = [
      '{"ts":"2026-07-26T09:00:00.000Z","ev":"init.created","init":"demo","actor":"c","data":{"title":"t"}}',
      '{"ts":"2026-07-26T09:01:00.000Z","ev":"error","init":"demo","actor":"impl-1","data":{"class":"test-suite-hangs","detail":"vitest never exits"}}',
      '{"ts":"2026-07-26T09:02:00.000Z","ev":"error","init":"demo","actor":"impl-1","data":{"class":"x","detail":"y","ticket":"T-99"}}',
    ];
    writeFileSync(join(dir, 'state', 'demo', 'journal.jsonl'), lines.join('\n') + '\n');
    const { payload, files } = renderAll(dir);
    assert.equal(payload.errors_logged_total, 2);
    assert.equal(payload.errors_logged[0].class, 'x', 'newest first');
    assert.equal(payload.errors_logged.find((e) => e.ticket === 'T-99').ticket, 'T-99');
    assert.deepEqual(payload.errors, [], 'the unreadable-journal list is untouched');
    assert.match(files[BOARD_FILE], /\*\*ERROR\*\* — demo: test-suite-hangs: vitest never exits/);
    assert.match(files[BOARD_FILE], /never declared/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the logged-error list is capped, because board.json is committed', () => {
  // MUTANT: drop the slice. A repo having a bad night grows a byte-compared
  // artefact without limit.
  const dir = mkdtempSync(join(tmpdir(), 'tyran-errcap-'));
  try {
    mkdirSync(join(dir, 'state', 'demo'), { recursive: true });
    const lines = ['{"ts":"2026-07-26T09:00:00.000Z","ev":"init.created","init":"demo","actor":"c","data":{"title":"t"}}'];
    for (let i = 0; i < MAX_LOGGED_ERRORS + 7; i += 1) {
      lines.push(`{"ts":"2026-07-26T10:${String(i).padStart(2, '0')}:00.000Z","ev":"error","init":"demo","actor":"a","data":{"class":"c${i}"}}`);
    }
    writeFileSync(join(dir, 'state', 'demo', 'journal.jsonl'), lines.join('\n') + '\n');
    const { payload, files } = renderAll(dir);
    assert.equal(payload.errors_logged.length, MAX_LOGGED_ERRORS);
    assert.equal(payload.errors_logged_total, MAX_LOGGED_ERRORS + 7);
    // Silent truncation reads as "that was all of them".
    assert.match(files[BOARD_FILE], /and 7 older error\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cards say how long they have stood still, on the lanes where that is the defect', () => {
  // The board would tell you an agent had been silent for three hours and
  // refuse to tell you a ticket had been blocked for four days. MUTANT: delete
  // the STALLABLE branch — every string below still renders except this one.
  const html = demoHtml();
  assert.match(html, /STALLABLE/, 'the lane set exists');
  assert.match(html, /'● no event ' \+ ago\(c\.since\)/, 'the face carries the age');
  assert.match(html, /row\('last event'/, 'and the detail panel carries the timestamp');
  // Backlog and ready must NOT be in it: an unstarted ticket is waiting its
  // turn, not stalling, and marking every one stale makes the mark worthless.
  const set = html.slice(html.indexOf('var STALLABLE'), html.indexOf('var STALLABLE') + 220);
  for (const lane of ['blocked', 'changes-requested', 'in-review', 'waiting-operator']) {
    assert.ok(set.includes(`'${lane}'`), `${lane} should be markable as stalled`);
  }
  for (const lane of ['backlog', 'ready', 'done']) {
    assert.ok(!set.includes(`'${lane}'`), `${lane} must not be marked as stalled`);
  }
});

test('one staleness vocabulary, shared by the strip, the errors and the cards', () => {
  // Three renderings of "how long ago" would let the same gap read as fine in
  // one place and alarming in another. MUTANT: re-inline the age arithmetic in
  // the agent strip.
  const html = demoHtml();
  assert.match(html, /var ageMsOf = function/);
  assert.match(html, /var ageClass = function/);
  assert.match(html, /chip\.appendChild\(el\('div', ageClass\(ageMs\), ageText\)\)/);
});

test('the sandbox journals the docs publish are real journals', () => {
  // MUTANT: hand-edit site/sandbox/*.jsonl into something the fold silently
  // drops — a misspelled `ev`, a `progress` with no agent. The sandbox would
  // still build, still publish, and quietly show a smaller board than the
  // journals describe, on the page whose whole job is to show what the board
  // looks like.
  const dir = fileURLToPath(new URL('../../site/sandbox/', import.meta.url));
  const names = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.ok(names.length >= 2, 'the sandbox should show more than one initiative');
  for (const name of names) {
    const read = readJournal(join(dir, name));
    assert.equal(read.badLines.length, 0, `${name} has unparseable lines`);
    // The PATH, not the events. `validateJournal` reads the file itself, so
    // handing it an array made it validate an empty journal and return ok —
    // this assertion passed for weeks against sandbox journals carrying
    // thirteen real errors, including reviews with no `by`, which meant every
    // reviewer on the published demo rendered as still running forever.
    const { errors } = validateJournal(join(dir, name));
    assert.deepEqual(errors, [], `${name} is not a journal Tyran would accept`);
    assert.ok(read.events.length > 5, `${name} is too thin to show anything`);
  }
});

test('the sandbox ships spend built by the real rollup, not a hand-written blob', () => {
  // MUTANT: hand-write the sandbox's cost.json. It would render today and
  // drift silently the first time a field in the payload moved — on the one
  // page whose entire job is to show what the product looks like, where
  // nobody would notice until a reader did.
  const src = readFileSync(fileURLToPath(new URL('../../site/scripts/build-sandbox.mjs', import.meta.url)), 'utf8');
  assert.match(src, /import \{ costJson, rollup \} from '\.\.\/\.\.\/scripts\/cost\.mjs'/);
  assert.match(src, /rollup\(SANDBOX_SOURCES, SANDBOX_PRICING/);
  // The rate card must announce itself as invented: Tyran does not know what
  // anyone pays, and a demo that looks like a price list teaches the opposite.
  assert.match(src, /rate_card: 'sample-rates \(invented\)'/);
  // And the model names must stay outside any real tier: CLAUDE.md forbids a
  // model name anywhere but `tiers:`, and a sandbox is not an exemption.
  assert.doesNotMatch(src, /\b(haiku|sonnet|opus|fable)\b/i);
});

test('an ask says what it is holding up, and the queue sorts by it', () => {
  // `deps` is resolved FORWARD everywhere (a ticket is ready when its
  // dependencies are merged) and the reverse direction was never computed, so
  // nine questions sorted by age alone put the one gating six tickets wherever
  // it happened to fall. MUTANT: delete the blocks term from sortAsks.
  const ev = (ts, e, data, actor = 'c') => JSON.stringify({ ts, ev: e, init: 'x', actor, data });
  const journal = [
    ev('2026-01-01T00:00:00Z', 'init.created', { title: 't' }),
    ev('2026-01-01T00:01:00Z', 'ticket.created', { id: 'T-1', title: 'base', deps: [] }),
    ev('2026-01-01T00:02:00Z', 'ticket.created', { id: 'T-2', title: 'b', deps: ['T-1'] }),
    ev('2026-01-01T00:03:00Z', 'ticket.created', { id: 'T-3', title: 'c', deps: ['T-2'] }),
    ev('2026-01-01T00:04:00Z', 'ticket.created', { id: 'T-4', title: 'd', deps: ['T-1'] }),
    ev('2026-01-01T00:05:00Z', 'ticket.created', { id: 'T-5', title: 'e', deps: [] }),
    ev('2026-01-01T00:06:00Z', 'merge', { ticket: 'T-4', sha: 'a' }),
    // The SMALL question is older, so age alone would put it first.
    ev('2026-01-01T00:07:00Z', 'gate', { kind: 'Q-1', result: 'WAITING_ON_OPERATOR', ticket: 'T-5', question: 'small', default: 'd' }),
    ev('2026-01-01T00:08:00Z', 'gate', { kind: 'Q-2', result: 'WAITING_ON_OPERATOR', ticket: 'T-1', question: 'big', default: 'd' }),
  ].join('\n') + '\n';
  const { payload, files } = renderAll(tree({ x: journal }));

  const big = payload.asks.find((a) => a.kind === 'Q-2');
  // Transitive, and a MERGED dependent is not held up by anything.
  assert.deepEqual(big.blocks, { count: 2, ids: ['T-2', 'T-3'] });
  assert.deepEqual(payload.asks.find((a) => a.kind === 'Q-1').blocks, { count: 0, ids: [] });
  assert.equal(payload.asks[0].kind, 'Q-2', 'the question holding work up comes first');
  assert.match(files[BOARD_FILE], /blocks 2 ticket\(s\): T-2, T-3/);
});

test('an initiative that declares no dependencies reports nothing rather than zero', () => {
  // "blocks 0" on every ask is an absence rendered as a measurement, which is
  // worse than silence. MUTANT: always compute the reverse index.
  const { payload } = renderAll(tree({ demo: demo() }));
  const noDeps = payload.asks.find((a) => a.ticket === null);
  assert.equal(noDeps.blocks, null, 'an ask with no ticket cannot block anything');
});

test('the strip sorts on what agents SHOWED, not on what they said', () => {
  // An agent emitting progress every few minutes while achieving nothing is
  // the healthiest-looking chip on the board and sorted to the BOTTOM of a
  // strip ordered by staleness. MUTANT: sort on last_signal again.
  const ev = (ts, e, data, actor = 'c') => JSON.stringify({ ts, ev: e, init: 'x', actor, data });
  const journal = [
    ev('2026-01-01T00:00:00Z', 'init.created', { title: 't' }),
    ev('2026-01-01T00:01:00Z', 'ticket.created', { id: 'T-1', title: 'a', deps: [] }),
    ev('2026-01-01T00:02:00Z', 'ticket.created', { id: 'T-2', title: 'b', deps: [] }),
    ev('2026-01-01T00:03:00Z', 'spawn', { agent: 'chatty', role: 'implementer', ticket: 'T-1' }),
    ev('2026-01-01T00:04:00Z', 'spawn', { agent: 'quiet', role: 'implementer', ticket: 'T-2' }),
    // `quiet` showed something early and has said nothing since.
    ev('2026-01-01T00:05:00Z', 'finding', { area: 'x', claim: 'c', proof: 'p', ticket: 'T-2' }, 'quiet'),
    // `chatty` has shown nothing at all and keeps saying it is working.
    ev('2026-01-01T00:30:00Z', 'progress', { agent: 'chatty', state: 'working', ticket: 'T-1' }, 'chatty'),
  ].join('\n') + '\n';
  const { payload } = renderAll(tree({ x: journal }));
  const strip = payload.agents.map((a) => a.agent);
  assert.deepEqual(strip, ['chatty', 'quiet'], 'the one that has shown nothing is at the top');

  const chatty = payload.agents.find((a) => a.agent === 'chatty');
  assert.equal(chatty.last_evidence, null, 'it has shown nothing');
  assert.equal(chatty.last_signal, '2026-01-01T00:30:00Z', 'while saying plenty — timestamps are verbatim from the journal');
  const quiet = payload.agents.find((a) => a.agent === 'quiet');
  assert.equal(quiet.last_evidence, '2026-01-01T00:05:00Z');
  assert.equal(quiet.evidence_kind, 'finding');
  // MUTANT: restore `last_signal: signal?.ts ?? a.spawnTs`.
  //
  // `quiet` has never emitted a progress event, so its signal time is NOT a
  // time — it is an absence. The fallback published its spawn instead, and
  // every consumer printed that under a label reading "last signal": the chip
  // ("N min since last signal"), the BOARD.md column, and the cross-repo line.
  // Measured over 420 real journals: 72 running agents, `last_signal ===
  // since` for 72 of 72, never once an actual signal. The golden fixture hid
  // it because its one agent DOES signal — the case that is universal in the
  // wild was the case no fixture covered.
  assert.equal(quiet.last_signal, null, 'an agent that has never signalled has no signal time');
  assert.equal(quiet.since, '2026-01-01T00:04:00Z', 'its spawn is carried by `since`, where it belongs');
});

test('the page shows signal and evidence as two different facts', () => {
  const html = demoHtml();
  assert.match(html, /nothing shown yet/, 'an agent that has shown nothing says so');
  assert.match(html, /a\.evidence_kind/, 'and what it showed is named');
});

test('a card says who is on it RIGHT NOW, joined by initiative and ticket', () => {
  // MUTANT 1: drop the live join and keep only the historical `agents:` list.
  // On a large ticket that list answers "who ever touched this" — the
  // operator asked the kanban "who is doing what", and the strip knew while
  // the card did not.
  // MUTANT 2: join on ticket alone. Two initiatives both have a T-3; the
  // card in one then claims the worker of the other, which is worse than no
  // name because it reads as a measurement.
  const html = demoHtml();
  assert.match(html, /ag\.ticket === c\.id && \(ag\.init \|\| ''\) === \(c\.init \|\| ''\)/, 'the join must match initiative AND ticket');
  assert.match(html, /'now: ' \+ ag\.agent/, 'the live agent is named on the card face');
  assert.match(html, /— BLOCKED'/, 'a blocked worker is said out loud on the card');
  assert.match(html, /!live\.length && c\.agents && c\.agents\.length/, 'the historical list survives only when nobody is on it now');
});

test('the chip measures the age it can actually prove, and labels it that way', () => {
  // MUTANT: point the age line back at `a.last_signal`.
  //
  // The number was always the spawn age; only the words said otherwise. It is
  // worth keeping — an agent open for six hours IS the thing an operator wants
  // flagged — so this is a relabelling, not a deletion. The `said so` line
  // renders only when there is a signal to render, which is what makes the
  // instruction's effect visible on the board instead of hidden behind a
  // fallback.
  const html = demoHtml();
  assert.match(html, /ageMsOf\(a\.since\)/, 'the age is measured from spawn, which is the fact on hand');
  assert.match(html, /since it started/, 'and it is labelled as spawn age');
  assert.doesNotMatch(html, /since last signal/, 'nothing may print spawn time under the word signal');
  assert.match(html, /if \(a\.last_signal\)/, 'a real signal still gets its own line');
});

test('the header counts LIVE agents, and says how many are stale', () => {
  // MUTANT: drop agents_stale, or count every open spawn as running. The tile
  // an overnight operator reads first said "3 agents running" for a fleet that
  // died before they went to bed — an open spawn and live work are not the
  // same fact, and the header was asserting the second from the first.
  const agents = [
    { agent: 'a', state: 'running', stale: false, last_evidence: null, since: '2026-07-26T09:00:00.000Z' },
    { agent: 'b', state: 'stale', stale: true, last_evidence: null, since: '2026-07-26T01:00:00.000Z' },
  ];
  const payload = crossBoard({
    initiatives: [{
      name: 'demo',
      state: { merged: 0, ticketList: [], lastTs: '2026-07-26T10:00:00.000Z', errors: [] },
      board: { asks: [], agents, paused: null, lanes: new Map(LANES.map((l) => [l, []])) },
    }],
    errors: [],
  });
  assert.equal(payload.totals.agents, 2, 'both are still counted — a stale agent is not deleted');
  assert.equal(payload.totals.agents_stale, 1);
  const md = renderCrossMd(payload);
  assert.match(md, /2 agent\(s\) open across 1 initiative\(s\), 1 stale/);
  // And the page separates the two numbers rather than adding them together.
  const html = renderBoardHtml(crossJson(payload));
  assert.match(html, /agents_stale/, 'the client reads the stale count');
  assert.match(html, /STALE — open/, 'and marks the chip in journal time, not wall-clock');
});

test('the stale mark is a SERVER verdict, kept apart from the wall-clock colours', () => {
  // MUTANT: render staleness with ageClass, or compute it from Date.now() in
  // the client. The page already has an age vocabulary — fresh/warm/cold/dead —
  // and it answers a different question: "how long since it spoke, right now,
  // where you are sitting". Staleness is journal time and is the same for every
  // reader of the journal, forever. One vocabulary for two questions is how an
  // operator ends up with two contradictory answers on one strip.
  const html = renderBoardHtml(crossJson(crossBoard({ initiatives: [], errors: [] })));
  assert.match(html, /journal time/, 'the chip says which clock it used');
  assert.match(html, /\.agent\.stale\{/, 'and it is styled as its own thing');
  assert.doesNotMatch(html, /ageClass\(\s*a\.open_hours/, 'never coloured by the wall-clock scale');
});

// --- opening the board, which nothing used to do ------------------------

test('--open launches the platform opener with the served URL', () => {
  // The board was a URL printed to a terminal and nothing ever opened it: for
  // a non-technical operator that is "keep this window running, now type that
  // address somewhere else", and each step is a place to stop. MUTANT: drop
  // the call — installation then never reaches the one screen that makes
  // Tyran legible.
  const calls = [];
  const fake = (command, args, options) => {
    calls.push({ command, args, options });
    return { on() {}, unref() {} };
  };
  openInBrowser('http://127.0.0.1:4173/', { platform: 'darwin', spawn: fake });
  assert.deepEqual(calls[0].command, 'open');
  assert.deepEqual(calls[0].args, ['http://127.0.0.1:4173/']);
  openInBrowser('http://127.0.0.1:4173/', { platform: 'linux', spawn: fake });
  assert.equal(calls[1].command, 'xdg-open');
  openInBrowser('http://127.0.0.1:4173/', { platform: 'win32', spawn: fake });
  assert.equal(calls[2].command, 'cmd');
  assert.deepEqual(calls[2].args, ['/c', 'start', '', 'http://127.0.0.1:4173/']);
  // Never through a shell: the URL is the only variable and it must not be
  // able to become a command.
  for (const call of calls) assert.notEqual(call.options.shell, true);
});

test('a machine with no browser does not take the server down', () => {
  // Headless boxes, SSH sessions and locked-down desktops all land here. The
  // server is already listening and the URL is already printed, so a failure
  // to open one leaves things exactly where they were. MUTANT: let the throw
  // escape, or leave the async error unhandled — either kills a working board.
  const thrower = () => { throw new Error('ENOENT'); };
  assert.equal(openInBrowser('http://127.0.0.1:4173/', { platform: 'linux', spawn: thrower }), false);
  // An absent opener reports asynchronously rather than throwing, so the
  // handler has to be attached, not merely the call wrapped.
  let handled = false;
  const asyncFail = () => ({ on(event) { if (event === 'error') handled = true; }, unref() {} });
  assert.equal(openInBrowser('http://127.0.0.1:4173/', { platform: 'linux', spawn: asyncFail }), true);
  assert.equal(handled, true, 'the error event must be handled or it takes the process down');
});

test('--open without --serve is a usage error, like --write', () => {
  // A flag that silently does nothing reads as configuration.
  const r = run(['--open']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--open only means anything with --serve/);
});

test('the page accepts exactly the cost schema its server sends', () => {
  // MEASURED REGRESSION, shipped and caught the same day: the client script
  // carried a literal `payload.schema !== 1`, cost.mjs bumped COST_SCHEMA to
  // 2, and the whole Spend tab was replaced by "Spend was served in a format
  // this page does not know (schema 2)" — served BY the page's own server.
  //
  // The number now interpolates from the constant, so this test exists to
  // catch anyone typing it back in.
  const html = renderBoardHtml(
    JSON.stringify({
      schema: 1,
      as_of: null,
      totals: { agents: 0, initiatives: 0, tickets: 0, merged: 0, percent: 0 },
      asks: [], agents: [], paused: [], lanes: {}, errors: [],
    }),
  );
  // Scoped to the cost fetch: `settings.json` has its OWN schema, also gated
  // on a `payload.schema` literal, and it is legitimately 1. A whole-page
  // substring search cannot tell the two apart.
  const start = html.indexOf("fetch('cost.json?window='");
  assert.ok(start > -1, 'the page must fetch cost.json');
  const block = html.slice(start, start + 2000);
  const gate = /payload\.schema !== (\d+)/.exec(block);
  assert.ok(gate !== null, 'the cost fetch must check the schema it was served');
  assert.equal(
    Number(gate[1]),
    COST_SCHEMA,
    `the page gates cost on schema ${gate[1]} while its server sends ${COST_SCHEMA}`,
  );
});

// --- the initiatives section, which replaced archiving ----------------------

test('each initiative carries its own title and progress, not just a slug', () => {
  // MEASURED: `init.created` has carried a written sentence since the journal
  // existed — "The kanban board: one screen that answers what is going on" —
  // and the board rendered the DIRECTORY NAME. One blended percentage over
  // several initiatives is also not a fact about any of them: an operator
  // seeing 47% across three slugs cannot tell which is nearly done.
  const dir = tree({ alpha: demo(), beta: demo().replaceAll('"init":"demo"', '"init":"beta"') });
  const payload = crossBoard(readInitiativeBoards(dir));
  assert.equal(payload.initiatives.length, 2);
  assert.deepEqual(payload.initiatives.map((i) => i.name), ['alpha', 'beta']);
  for (const row of payload.initiatives) {
    assert.equal(typeof row.title, 'string', 'the human title must reach the payload');
    assert.ok(row.title.length > 0);
    assert.equal(typeof row.percent, 'number');
    assert.equal(row.tickets, 3);
    assert.equal(row.merged, 1);
  }
});

test('an initiative waiting on the operator is countable from the payload', () => {
  // The whole reason this section exists instead of an archive. Measured
  // across 63 real journals: 43 were waiting on a question nobody answered
  // and only 6 were finished-and-archivable, so the board was full of
  // ABANDONED work rather than completed work.
  const dir = tree({ demo: demo() });
  const payload = crossBoard(readInitiativeBoards(dir));
  assert.equal(payload.initiatives[0].waiting, 2, 'the fixture has two waiting-operator gates');
  assert.equal(payload.initiatives[0].waiting, payload.asks.length);
});

test('the payload reads no clock, so the section cannot break --check', () => {
  // MUTANT: compute an idle time here instead of shipping `last_ts`. Every
  // render would then differ from the last and `board.mjs --check` — the
  // byte-exact contract this whole layer rests on — would fail forever.
  const dir = tree({ demo: demo() });
  const once = crossJson(crossBoard(readInitiativeBoards(dir)));
  const twice = crossJson(crossBoard(readInitiativeBoards(dir)));
  assert.equal(once, twice, 'two renders of one journal set must be byte-identical');
  for (const row of crossBoard(readInitiativeBoards(dir)).initiatives) {
    assert.match(row.last_ts, /^\d{4}-\d{2}-\d{2}T/, 'a timestamp from the journal, never a computed age');
  }
});

test('the page renders the initiative rows and names what is waiting', () => {
  const html = demoHtml();
  assert.match(html, /data\.initiatives/, 'the client must read the initiatives rows');
  assert.match(html, /waiting on you/, 'the stalled count must be spelled out, not implied by a colour');
  assert.match(html, /initrow/);
});

test('a closing checkpoint marks an initiative finished; a percentage never does', () => {
  // MUTANT 1: derive `closed` from percent === 100. Work that stopped and
  // work that ended then read identically, which is the state the operator
  // reported: 100% on a row nobody could tell apart from an abandoned one.
  // MUTANT 2: set the flag on any checkpoint. Every initiative that ever
  // recorded a phase is then "finished" the moment it starts.
  const closing = demo() + JSON.stringify({
    ts: '2026-07-27T10:00:00.000Z',
    ev: 'checkpoint',
    init: 'demo',
    actor: 'conductor',
    data: { phase: 'Closed', next_steps: ['none'] },
  }) + '\n';
  const open = crossBoard(readInitiativeBoards(tree({ demo: demo() }))).initiatives[0];
  assert.equal(open.closed, null, 'an initiative with no closing checkpoint is not finished');
  assert.equal(typeof open.phase, 'string', 'its phase still travels — an open initiative has a word for where it is');

  const done = crossBoard(readInitiativeBoards(tree({ demo: closing }))).initiatives[0];
  // The TIMESTAMP, not a boolean: "closed 9 days ago" is the reading, and the
  // page ages it in the reader's browser like every other time on the page.
  assert.equal(done.closed, '2026-07-27T10:00:00.000Z');
  // Case-insensitive and trimmed, because a human writes this phase by hand —
  // the rule is journal.mjs's, imported rather than restated here.
  assert.equal(done.phase, 'Closed');
});

test('an initiative row is a button, and finished ones say so and sort last', () => {
  // MUTANT 1: render the rows as divs again. The one thing on this page an
  // operator could read and not open stays unopenable — reported verbatim:
  // "I can't open tickets and initiatives to read details".
  // MUTANT 2: drop the finished branch from the ordering. Completed work then
  // competes for the top of the section with the initiatives still running.
  const html = demoHtml();
  assert.match(html, /var row = el\('button', 'initrow'/, 'a row must be a real button, not a clickable div');
  assert.match(html, /row\.addEventListener\('click', function \(\) \{ showInit\(i, row\); \}\);/);
  assert.match(html, /\.concat\(finished\);/, 'finished initiatives sort last');
  assert.match(html, /'FINISHED · closed ' \+ ago\(i\.closed\)/);
  // and the board must not overclaim: nothing in the closed event set records
  // a deployment, so the page may not imply one
  assert.match(html, /is not a claim that anything was deployed/);
});

test('an ask offers its recommendation as one click, not as text to retype', () => {
  // For a non-technical operator the gap WAS the difficulty: the agent had
  // already said what it thought should happen, and accepting it meant
  // transcribing the sentence into the box underneath it.
  const html = demoHtml();
  assert.match(html, /Use the recommendation/);
  // MUTANT: submit on click. Filling the box keeps the wording editable and
  // the answer deliberate — a one-click SEND turns a recommendation into a
  // default, which is a different thing and already has its own button.
  assert.match(html, /input\.value = a\.recommendation/);
});

test('findings are POINTED AT, never copied into the payload', () => {
  // MEASURED across 63 distinct real journals: 3 carry any finding, 49 in
  // total, and NOT ONE names a ticket — so they cannot enrich a card, which
  // is where the obvious design would have put them. Median claim is 429
  // characters, and STATE.md already renders the full table.
  //
  // MUTANT: ship `claim` and `proof` on the payload. That is ADR-21's defect
  // — one answer in two places — and ~600 B per finding inside an artefact
  // that is committed and byte-compared.
  const dir = tree({ demo: demo() });
  const payload = crossBoard(readInitiativeBoards(dir));
  const row = payload.initiatives[0];
  assert.equal(typeof row.findings, 'number', 'the count travels');
  const json = crossJson(payload);
  assert.ok(!json.includes('"proof"'), 'no proof text may reach the board payload');
  assert.ok(!json.includes('"claim"'), 'no claim text may reach the board payload');
  // `command` rides the same rule, and it is stated here rather than assumed.
  // A finding's command is the one field somebody WILL be tempted to promote
  // onto a card — it is short, it looks like a label, and it reads as useful.
  // It is still per-finding text inside a byte-compared artefact, which is the
  // growth this whole design exists to avoid; the count points, STATE.md tells.
  assert.ok(!json.includes('"command"'), 'no command text may reach the board payload');
  assert.ok(!json.includes('"exit_code"'), 'no exit code may reach the board payload');
});

test('the detail panel renders the commit, the reviewer and the model that ran', () => {
  // All three live in the client script, so no other test in this repository
  // would notice them being reverted: board.json is unchanged by removing
  // the code that DISPLAYS these fields, and the lane the card sits in is
  // unchanged too. This asserts against the rendered page for that reason.
  //
  // MUTANT 1: drop the `card.review` / `card.merge` rows — the board goes
  // back to saying a ticket shipped without saying what shipped.
  // MUTANT 2: drop the Execution table — the model each run used, which is
  // the half of "what did this cost me" that the Spend tab cannot answer,
  // stops being reachable from the ticket entirely.
  const html = renderBoardHtml(
    JSON.stringify({
      schema: 1,
      as_of: '2026-07-26T09:00:00.000Z',
      totals: { agents: 0, initiatives: 1, tickets: 1, merged: 1, percent: 100 },
      asks: [], agents: [], paused: [], errors: [], initiatives: [], files: {},
      lanes: { done: [{
        id: 'T-1', title: 'a ticket', init: 'demo', agents: [], worked_by: ['impl-1'],
        since: '2026-07-26T09:00:00.000Z', report_text: null, annotation: null,
        review: { verdict: 'APPROVE', by: 'rev-1', ts: '2026-07-26T08:55:00.000Z' },
        merge: { sha: '88ea8cb', mode: 'rebase', ts: '2026-07-26T09:00:00.000Z' },
        execution: [{ agent: 'impl-1', role: 'implementer', model: 'deep', started: '2026-07-26T08:00:00.000Z', ended: '2026-07-26T08:50:00.000Z', verdict: 'done' }],
      }] },
    }),
  );
  assert.match(html, /card\.merge/, 'the merge row must exist in the client');
  assert.match(html, /card\.review/, 'the review row must exist in the client');
  assert.match(html, /card\.execution/, 'the execution table must exist in the client');
  assert.match(html, /'agent', 'model', 'started', 'verdict'/, 'the run columns are named');
  // The payload the client reads from must actually carry them. Whitespace
  // tolerant: the embedded copy is written as given, so this asserts the
  // DATA is there and not how the caller happened to format it.
  assert.match(html, /"sha":\s*"88ea8cb"/);
  assert.match(html, /"model":\s*"deep"/);
  assert.match(html, /"verdict":\s*"APPROVE"/);
  // And the table has to be styled, or it renders as run-together text.
  assert.match(html, /\.runs\{/, 'the execution table needs its CSS');
});
