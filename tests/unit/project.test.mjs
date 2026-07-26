import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { EVENT_TYPES } from '../../scripts/journal.mjs';
import {
  STATE_FILE,
  PROGRESS_FILE,
  fold,
  inline,
  naturalCompare,
  parseArgs,
  progressLine,
  projectFile,
  renderProjections,
  checkFile,
} from '../../scripts/project.mjs';

const SCRIPT = new URL('../../scripts/project.mjs', import.meta.url).pathname;
const FIXTURE = new URL('../fixtures/journal-demo.jsonl', import.meta.url).pathname;
const GOLDEN_DIR = new URL('../fixtures/golden/', import.meta.url).pathname;

const dir = () => mkdtempSync(join(tmpdir(), 'tyran-project-'));
const run = (args, opts = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', ...opts });

/** Write a journal from event objects (one JSON per line) into a fresh dir. */
function journal(events, { trailingNewline = true } = {}) {
  const d = dir();
  const file = join(d, 'journal.jsonl');
  const body = events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n');
  writeFileSync(file, body + (trailingNewline && body !== '' ? '\n' : ''));
  return { d, file };
}

const ev = (over = {}) => ({
  ts: '2026-07-26T10:00:00.000Z',
  ev: 'checkpoint',
  init: 'demo',
  actor: 'conductor',
  data: { phase: 'F1', next_steps: ['a'] },
  ...over,
});

// --- golden files -------------------------------------------------------

test('golden: STATE.md is byte-identical to the committed projection', () => {
  const { files } = projectFile(FIXTURE);
  assert.equal(files[STATE_FILE], readFileSync(join(GOLDEN_DIR, STATE_FILE), 'utf8'));
});

test('golden: PROGRESS.md is byte-identical to the committed projection', () => {
  const { files } = projectFile(FIXTURE);
  assert.equal(files[PROGRESS_FILE], readFileSync(join(GOLDEN_DIR, PROGRESS_FILE), 'utf8'));
});

test('golden: the CLI writes exactly those bytes to --out-dir', () => {
  const out = dir();
  const r = run([FIXTURE, '--out-dir', out]);
  assert.equal(r.status, 0, r.stderr);
  for (const name of [STATE_FILE, PROGRESS_FILE]) {
    assert.deepEqual(readFileSync(join(out, name)), readFileSync(join(GOLDEN_DIR, name)));
  }
});

// --- idempotence / determinism -----------------------------------------

test('idempotence: a second run on an unchanged journal rewrites identical bytes', () => {
  const out = dir();
  assert.equal(run([FIXTURE, '--out-dir', out]).status, 0);
  const first = [STATE_FILE, PROGRESS_FILE].map((n) => readFileSync(join(out, n)));
  assert.equal(run([FIXTURE, '--out-dir', out]).status, 0);
  const second = [STATE_FILE, PROGRESS_FILE].map((n) => readFileSync(join(out, n)));
  assert.deepEqual(second, first);
  // and --check agrees that nothing drifted
  assert.equal(run([FIXTURE, '--out-dir', out, '--check']).status, 0);
});

test('determinism: reordering independent events does not change the output', () => {
  const lines = readFileSync(FIXTURE, 'utf8').trim().split('\n');
  const idx = lines.map((l, i) => [l, i]).filter(([l]) => l.includes('"ticket.created"')).map(([, i]) => i);
  assert.equal(idx.length, 3);
  const shuffled = [...lines];
  // fixed permutation (no RNG — a flaky test proves nothing)
  [shuffled[idx[0]], shuffled[idx[2]]] = [shuffled[idx[2]], shuffled[idx[0]]];
  const { file } = journal(shuffled);
  const a = projectFile(FIXTURE).files;
  const b = projectFile(file).files;
  assert.equal(b[STATE_FILE], a[STATE_FILE]);
  assert.equal(b[PROGRESS_FILE], a[PROGRESS_FILE]);
});

test('determinism: tickets sort naturally (T-2 before T-10), not lexically', () => {
  assert.ok(naturalCompare('T-2', 'T-10') < 0);
  assert.ok(naturalCompare('T-10', 'T-2') > 0);
  assert.equal(naturalCompare('T-2', 'T-2'), 0);
  const { files } = projectFile(FIXTURE);
  const rows = files[STATE_FILE].split('\n').filter((l) => l.startsWith('| `T-'));
  assert.deepEqual(rows.map((r) => r.split('|')[1].trim()), ['`T-1`', '`T-2`', '`T-10`']);
});

// --- resilience ---------------------------------------------------------

test('a truncated final line is skipped with a warning, exit 0', () => {
  const { d, file } = journal([ev({ ev: 'init.created', data: {} })]);
  appendFileSync(file, '{"ts":"2026-07-26T10:01:00.000Z","ev":"repo'); // crash mid-write
  const r = run([file, '--out-dir', d]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /truncated final line/);
  assert.match(readFileSync(join(d, STATE_FILE), 'utf8'), /\*\*Truncated final line:\*\* yes/);
  assert.match(readFileSync(join(d, STATE_FILE), 'utf8'), /\*\*Events folded:\*\* 1/);
});

test('an unknown event type is counted and named, never fatal', () => {
  const { d, file } = journal([ev(), ev({ ev: 'quantum.entangled', data: { x: 1 } })]);
  const r = run([file, '--out-dir', d]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /unknown event type "quantum\.entangled" x1/);
  const state = readFileSync(join(d, STATE_FILE), 'utf8');
  assert.match(state, /\*\*Unknown event types:\*\* quantum\.entangled/);
  assert.match(state, /`quantum\.entangled` 1/); // still visible in the type census
});

test('mid-file corruption and non-object lines are skipped and counted, exit 0', () => {
  const { d, file } = journal([ev(), 'GARBAGE LINE', '42', '"a string"', '[1,2]', ev({ ev: 'error', data: { class: 'x' } })]);
  const r = run([file, '--out-dir', d]);
  assert.equal(r.status, 0, r.stderr);
  const state = readFileSync(join(d, STATE_FILE), 'utf8');
  assert.match(state, /\*\*Corrupt lines skipped:\*\* 1/);
  assert.match(state, /\*\*Non-object lines skipped:\*\* 3/);
  assert.match(r.stderr, /corrupt line\(s\) mid-file/);
});

test('an empty journal projects empty documents, exit 0', () => {
  const { d, file } = journal([]);
  const r = run([file, '--out-dir', d]);
  assert.equal(r.status, 0, r.stderr);
  const state = readFileSync(join(d, STATE_FILE), 'utf8');
  assert.match(state, /^<!-- GENERATED by tyran/);
  assert.match(state, /\*\*Events folded:\*\* 0/);
  assert.match(readFileSync(join(d, PROGRESS_FILE), 'utf8'), /^# PROGRESS: 0% · 0\/0 tickets merged · phase: \(none\)$/m);
});

test('sections without data render as explicitly empty, never disappear', () => {
  const { d, file } = journal([]);
  assert.equal(run([file, '--out-dir', d]).status, 0);
  const state = readFileSync(join(d, STATE_FILE), 'utf8');
  for (const heading of [
    'Agents',
    'Ledger',
    'Open gates',
    'All gates',
    'Open leases',
    'Lease releases by a non-holder',
    'Decisions',
    'Retro entries',
    'Errors',
    'Resume steps',
  ]) {
    const section = state.split(`## ${heading}\n`)[1];
    assert.ok(section !== undefined, `section "${heading}" vanished`);
    assert.ok(section.startsWith('\n_none_\n'), `section "${heading}" is not explicitly empty`);
  }
});

// --- agents / ledger semantics ------------------------------------------

test('an unclosed spawn stays visible as running', () => {
  const state = fold({
    events: [
      ev({ ev: 'spawn', data: { agent: 'impl-9', role: 'implementer', ticket: 'T-9', worktree: 'wt-9' } }),
    ],
  });
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].status, 'running');
  const { files } = renderProjections({ events: [ev({ ev: 'spawn', data: { agent: 'impl-9', role: 'implementer' } })] });
  assert.match(files[STATE_FILE], /\| impl-9 \|.*\*\*running \(no report yet\)\*\*/);
});

test('two spawns of one agent name: a single report closes only the older one', () => {
  const state = fold({
    events: [
      ev({ ev: 'spawn', data: { agent: 'impl', role: 'implementer', ticket: 'T-1' } }),
      ev({ ev: 'spawn', data: { agent: 'impl', role: 'implementer', ticket: 'T-2' } }),
      ev({ ev: 'report', data: { agent: 'impl', verdict: 'done', ticket: 'T-1' } }),
    ],
  });
  assert.deepEqual(state.agents.map((a) => a.status), ['reported', 'running']);
});

test('a report without a matching spawn is surfaced, not dropped', () => {
  const state = fold({ events: [ev({ ev: 'report', data: { agent: 'ghost', verdict: 'done' } })] });
  assert.equal(state.agents[0].status, 'reported (no spawn event)');
});

test('a ticket referenced only by merge still appears in the ledger', () => {
  const { files } = renderProjections({
    events: [ev({ ev: 'merge', data: { ticket: 'T-42', sha: 'deadbee' } })],
  });
  assert.match(files[STATE_FILE], /\| `T-42` _\(no ticket\.created\)_ \|/);
  assert.match(files[STATE_FILE], /merged \(deadbee\)/);
});

test('a lease released by a non-holder stays open and is reported', () => {
  const state = fold({
    events: [
      ev({ ev: 'lease.acquired', data: { resource: 'wt-a', holder: 'impl-1' } }),
      ev({ ev: 'lease.released', data: { resource: 'wt-a', holder: 'intruder' } }),
    ],
  });
  assert.equal(state.leases.size, 1);
  assert.equal(state.mismatchedReleases.length, 1);
});

test('every event type of the closed set is folded into a section (no silent loss)', () => {
  const sample = {
    'init.created': {},
    'plan.accepted': {},
    'ticket.created': { id: 'T-1' },
    spawn: { agent: 'a', role: 'implementer' },
    report: { agent: 'a', verdict: 'done' },
    gate: { kind: 'tests', result: 'pass' },
    review: { ticket: 'T-1', verdict: 'APPROVE', by: 'r' },
    merge: { ticket: 'T-1', sha: 'abc' },
    decision: { id: 'D-1', text: 't' },
    'lease.acquired': { resource: 'r', holder: 'h' },
    'lease.released': { resource: 'r', holder: 'h' },
    checkpoint: { phase: 'F1', next_steps: ['s'] },
    'retro.entry': { kind: 'skill', target: 't' },
    error: { class: 'c' },
  };
  assert.deepEqual(Object.keys(sample).sort(), [...EVENT_TYPES].sort());
  const state = fold({ events: EVENT_TYPES.map((t) => ev({ ev: t, data: sample[t] })) });
  assert.equal(state.unknownTypes.size, 0, `unfolded types: ${[...state.unknownTypes.keys()]}`);
  assert.equal(state.total, EVENT_TYPES.length);
});

test('progress percentage counts merged tickets and survives a zero denominator', () => {
  assert.match(progressLine(fold({ events: [] })), /^PROGRESS: 0% · 0\/0 tickets merged · phase: \(none\)$/);
  const state = fold({
    events: [
      ev({ ev: 'ticket.created', data: { id: 'T-1' } }),
      ev({ ev: 'ticket.created', data: { id: 'T-2' } }),
      ev({ ev: 'merge', data: { ticket: 'T-1', sha: 'a' } }),
      ev({ data: { phase: 'E2', next_steps: [] } }),
    ],
  });
  assert.match(progressLine(state), /^PROGRESS: 50% · 1\/2 tickets merged · phase: E2$/);
});

// --- injection hardening -------------------------------------------------

test('hostile journal data cannot break tables, the header, or inject HTML', () => {
  const nasty = 'a | b\nrow2 | c `code` <script>alert(1)</script> --> & \\pipe';
  const { files } = renderProjections({
    events: [ev({ ev: 'ticket.created', data: { id: 'T-1', title: nasty } })],
  });
  const state = files[STATE_FILE];
  const row = state.split('\n').find((l) => l.startsWith('| `T-1`'));
  assert.equal(row.split('|').length - 2, 6); // exactly the 6 declared columns
  assert.ok(!state.includes('<script>'));
  assert.ok(!row.includes('\n'));
  // No journal value can ever emit a raw `<`, `>` or `|` — so it can neither
  // inject HTML nor close/forge the GENERATED comment.
  const body = state.slice(state.indexOf('\n# STATE'));
  assert.ok(!/[<>]/.test(body), 'raw angle bracket leaked into the document body');
  assert.equal((state.match(/<!--/g) ?? []).length, 2);
  assert.equal((state.match(/-->/g) ?? []).length, 2);
  assert.equal(
    state.split('\n')[0],
    '<!-- GENERATED by tyran scripts/project.mjs - DO NOT EDIT. Source of truth: journal.jsonl -->',
  );
});

test('review/merge without a ticket land in a visible pseudo-ticket, not the void', () => {
  const state = fold({
    events: [
      ev({ ev: 'merge', data: { sha: 'abc1234' } }),
      ev({ ev: 'review', data: { verdict: 'APPROVE', by: 'r' } }),
    ],
  });
  assert.deepEqual(state.ticketList.map((t) => t.id), ['(no ticket)']);
  assert.equal(state.ticketList[0].merge.sha, 'abc1234');
});

test('a lease event without a resource is still visible', () => {
  const state = fold({ events: [ev({ ev: 'lease.acquired', data: { holder: 'h' } })] });
  assert.deepEqual([...state.leases.keys()], ['(no resource)']);
});

test('inline() normalizes, escapes and caps a value', () => {
  assert.equal(inline(null), '&mdash;');
  assert.equal(inline('   '), '&mdash;');
  assert.equal(inline('a|b'), 'a&#124;b');
  assert.equal(inline('<b>'), '&lt;b&gt;');
  assert.equal(inline('a\nb'), 'a b');
  assert.equal(inline(['x', 'y']), 'x, y');
  const long = inline('x'.repeat(500));
  assert.ok(Array.from(long).length <= 160, `cell too long: ${long.length}`);
  assert.ok(long.endsWith('…'));
});

// --- --check -------------------------------------------------------------

test('--check exits 0 on fresh projections and 1 after a hand edit', () => {
  const out = dir();
  assert.equal(run([FIXTURE, '--out-dir', out]).status, 0);
  const ok = run([FIXTURE, '--out-dir', out, '--check']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /projections up to date/);

  const path = join(out, STATE_FILE);
  writeFileSync(path, readFileSync(path, 'utf8').replace('## Errors', '## Errors (I edited this by hand)'));
  const drift = run([FIXTURE, '--out-dir', out, '--check']);
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /drift/);
  assert.match(drift.stderr, /1 of \d+ line\(s\) differ, first at line \d+/);
  assert.match(drift.stderr, /regenerate with/);
});

test('--check is byte-exact: whitespace, CRLF, BOM and a missing final newline all drift', () => {
  const { files } = projectFile(FIXTURE);
  const good = files[STATE_FILE];
  const out = dir();
  const path = join(out, STATE_FILE);
  const cases = {
    'trailing space': good.replace('## Errors', '## Errors '),
    'missing final newline': good.replace(/\n$/, ''),
    CRLF: good.replace(/\n/g, '\r\n'),
    BOM: '﻿' + good,
    'extra blank line': good + '\n',
  };
  for (const [name, content] of Object.entries(cases)) {
    writeFileSync(path, content);
    assert.equal(checkFile(path, good).ok, false, `${name} was NOT detected as drift`);
  }
  writeFileSync(path, good);
  assert.equal(checkFile(path, good).ok, true);
  assert.equal(run([FIXTURE, '--out-dir', out, '--check']).status, 1); // PROGRESS.md still missing
});

test('--check reports a missing projection instead of crashing', () => {
  const out = dir();
  const r = run([FIXTURE, '--out-dir', out, '--check']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing on disk/);
  assert.deepEqual(readdirSync(out), []); // --check writes NOTHING
});

// --- CLI contract --------------------------------------------------------

test('CLI: an unknown flag fails loudly (never silently ignored)', () => {
  const out = dir();
  const r = run([FIXTURE, '--out-dir', out, '--verbose']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag --verbose/);
  assert.deepEqual(readdirSync(out), []);
  assert.throws(() => parseArgs(['j.jsonl', '--nope']), /unknown flag --nope/);
  assert.throws(() => parseArgs(['j.jsonl', '--out-dir']), /requires a value/);
  assert.throws(() => parseArgs(['j.jsonl', '--out-dir', '--check']), /requires a value/);
  assert.throws(() => parseArgs(['a.jsonl', 'b.jsonl']), /unexpected extra argument/);
  assert.throws(() => parseArgs(['j.jsonl', '--out-dir', 'a', '--out-dir', 'b']), /given twice/);
  assert.throws(() => parseArgs(['j.jsonl', '--check', '--check']), /given twice/);
  assert.deepEqual(parseArgs(['j.jsonl', '--check']), { journal: 'j.jsonl', outDir: undefined, check: true });
});

test('CLI: a missing journal file exits non-zero with a readable message', () => {
  const r = run([join(dir(), 'nope.jsonl'), '--out-dir', dir()]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /journal not found: .*nope\.jsonl/);
  const usage = run([]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: project\.mjs/);
});

test('CLI: --out-dir defaults to the journal directory', () => {
  const { d, file } = journal([ev()]);
  const r = run([file]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(d, STATE_FILE)) && existsSync(join(d, PROGRESS_FILE)));
});

// --- atomic writes -------------------------------------------------------

test('concurrent projections never leave a partial or temporary file', async () => {
  const out = dir();
  await Promise.all(
    Array.from({ length: 8 }, () =>
      new Promise((res, rej) => {
        const p = spawn(process.execPath, [SCRIPT, FIXTURE, '--out-dir', out]);
        let err = '';
        p.stderr.on('data', (c) => (err += c));
        p.on('close', (code) => (code === 0 ? res() : rej(new Error(`exit ${code}: ${err}`))));
      }),
    ),
  );
  assert.deepEqual(readdirSync(out).sort(), [PROGRESS_FILE, STATE_FILE].sort());
  for (const name of [STATE_FILE, PROGRESS_FILE]) {
    assert.deepEqual(readFileSync(join(out, name)), readFileSync(join(GOLDEN_DIR, name)));
  }
});
