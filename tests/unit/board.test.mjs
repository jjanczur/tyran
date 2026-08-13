/**
 * Tests for the cross-initiative board.
 *
 * The properties that matter: an unreadable initiative is a VISIBLE entry
 * (a board that omits a broken initiative reads as "all is well" exactly
 * when it is not), the ceiling refuses loudly, `--check` is byte-exact, the
 * HTML embeds no raw `<` inside its data block, and the serve handler never
 * derives a filesystem path from a URL.
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
import { renderBoardHtml } from '../../scripts/board-html.mjs';
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

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('two initiatives merge into one payload with per-card provenance and honest totals', () => {
  const dir = tree({ alpha: demo(), beta: demo().replaceAll('"init":"demo"', '"init":"beta"') });
  const payload = crossBoard(readInitiativeBoards(dir));
  assert.equal(payload.schema, 1);
  assert.equal(payload.totals.initiatives, 2);
  assert.equal(payload.totals.tickets, 6);
  assert.equal(payload.totals.merged, 2);
  assert.equal(payload.asks.length, 2, 'one waiting-operator ask per copy of the fixture');
  assert.ok(payload.asks.every((a) => a.init === 'alpha' || a.init === 'beta'));
  assert.deepEqual(Object.keys(payload.lanes), [...LANES]);
  const md = renderCrossMd(payload);
  assert.match(md, /2 agent\(s\) running across 2 initiative\(s\)/);
  assert.match(md, /## Waiting on you/);
});

test('an unreadable journal is a VISIBLE error entry, and the rest still renders', () => {
  const dir = tree({ good: demo(), broken: 'not json at all\n{ neither' });
  const { initiatives, errors } = readInitiativeBoards(dir);
  // readJournal tolerates bad lines; a truly throwing journal is rare, so
  // simulate the throw path directly through crossBoard's contract:
  const payload = crossBoard({ initiatives, errors: [...errors, { name: 'exploded', error: 'EACCES' }] });
  assert.match(renderCrossMd(payload), /UNREADABLE.*exploded.*EACCES/);
  assert.ok(initiatives.some((i) => i.name === 'good'));
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
