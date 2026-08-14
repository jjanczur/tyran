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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOARD_HTML_FILE,
  MAX_INITIATIVES,
  crossBoard,
  crossJson,
  readInitiativeBoards,
  renderAll,
  renderCrossMd,
} from '../../scripts/board.mjs';
import { renderBoardError, renderBoardHtml } from '../../scripts/board-html.mjs';
import { BOARD_FILE, BOARD_JSON_FILE, LANES } from '../../scripts/project.mjs';

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
  assert.match(md, /2 agent\(s\) running across 2 initiative\(s\)/);
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
  assert.match(md, /0 agent\(s\) running across 0 initiative\(s\)/);
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
  assert.ok(html.includes("fetch('cost.json'"), 'the page asks a server for spend');
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
  assert.match(html, /\['overview', 'Overview', null\]/);
  assert.match(html, /\['board', 'Board', null\]/);
  assert.match(html, /\['questions', 'Waiting on you', asks\.length\]/, 'the queue label must count the open asks');
  assert.match(html, /\['spend', 'Spend', null\]/);
  assert.match(html, /el\('span', 'count', '\(' \+ spec\[2\] \+ '\)'\)/, 'the count must reach the tab label');
  assert.match(html, /panels\[k\]\.hidden = !on;/, 'an unselected tab must be hidden, not merely unstyled');
  assert.match(html, /^\s*select\('overview'\);$/m, 'the page must open on Overview');
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
  assert.match(html, /Over file:\/\/ there is no server, so this tab stays empty\./);
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
