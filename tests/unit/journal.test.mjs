import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import {
  EVENT_TYPES,
  validateEvent,
  append,
  readJournal,
  query,
  validateJournal,
  nextId,
  tail,
} from '../../scripts/journal.mjs';

const SCRIPT = new URL('../../scripts/journal.mjs', import.meta.url).pathname;
const tmp = () => join(mkdtempSync(join(tmpdir(), 'tyran-journal-')), 'journal.jsonl');
const ev = (over = {}) => ({
  ts: '2026-07-26T10:00:00.000Z',
  ev: 'checkpoint',
  init: 'demo',
  actor: 'conductor',
  data: { phase: 'F1', next_steps: ['a'] },
  ...over,
});

// --- validateEvent -----------------------------------------------------

test('accepts a fully valid event', () => {
  assert.deepEqual(validateEvent(ev()), []);
});

test('rejects unknown event types (closed set)', () => {
  const errs = validateEvent(ev({ ev: 'made.up' }));
  assert.ok(errs.some((e) => e.includes('closed event set')));
});

test('rejects missing/invalid top-level fields', () => {
  assert.ok(validateEvent(ev({ ts: 'not-a-date' })).length > 0);
  assert.ok(validateEvent(ev({ init: '' })).length > 0);
  assert.ok(validateEvent(ev({ actor: undefined })).length > 0);
  assert.ok(validateEvent(ev({ data: [] })).length > 0);
});

test('enforces per-type required data keys but allows extras', () => {
  const bad = validateEvent(ev({ ev: 'report', data: { agent: 'x' } }));
  assert.ok(bad.some((e) => e.includes('data.verdict')));
  const good = validateEvent(
    ev({ ev: 'report', data: { agent: 'x', verdict: 'ok', evidence: [{ cmd: 'npm test', exit: 0 }] } }),
  );
  assert.deepEqual(good, []);
});

// --- append / read roundtrip ------------------------------------------

test('append writes one JSON line and stamps ts when absent', () => {
  const f = tmp();
  const written = append(f, { ev: 'init.created', init: 'demo', actor: 'conductor', data: {} });
  assert.ok(!Number.isNaN(Date.parse(written.ts)));
  const { events, truncatedTail, badLines } = readJournal(f);
  assert.equal(events.length, 1);
  assert.equal(truncatedTail, false);
  assert.deepEqual(badLines, []);
});

test('append rejects invalid events loudly (nothing written)', () => {
  const f = tmp();
  assert.throws(() => append(f, { ev: 'nope', init: 'demo', actor: 'a', data: {} }), /closed event set/);
  assert.equal(readJournal(f).events.length, 0);
});

test('a truncated final line (crash mid-write) is discarded and flagged', () => {
  const f = tmp();
  append(f, ev());
  appendFileSync(f, '{"ts":"2026-07-26T10:01:00.000Z","ev":"repo'); // no newline, cut mid-JSON
  const { events, truncatedTail } = readJournal(f);
  assert.equal(events.length, 1);
  assert.equal(truncatedTail, true);
});

test('mid-file corruption is a validation error, not silent loss', () => {
  const f = tmp();
  append(f, ev());
  appendFileSync(f, 'GARBAGE LINE\n');
  append(f, ev({ ts: '2026-07-26T10:02:00.000Z' }));
  const result = validateJournal(f);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('mid-file corruption')));
});

// --- query -------------------------------------------------------------

test('query filters by ev, init and ticket (incl. ticket.created id)', () => {
  const f = tmp();
  append(f, ev({ ev: 'ticket.created', data: { id: 'T-1' } }));
  append(f, ev({ ts: '2026-07-26T10:03:00.000Z', ev: 'report', data: { agent: 'impl', verdict: 'done', ticket: 'T-1' } }));
  append(f, ev({ ts: '2026-07-26T10:04:00.000Z', init: 'other' }));
  assert.equal(query(f, { ev: 'report' }).length, 1);
  assert.equal(query(f, { init: 'demo' }).length, 2);
  assert.equal(query(f, { ticket: 'T-1' }).length, 2);
  assert.equal(query(f, { limit: 1 }).at(0).init, 'other');
});

// --- validateJournal ---------------------------------------------------

test('detects timestamp regression', () => {
  const f = tmp();
  append(f, ev({ ts: '2026-07-26T10:05:00.000Z' }));
  append(f, ev({ ts: '2026-07-26T10:04:00.000Z' }));
  const result = validateJournal(f);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('earlier than previous')));
});

test('valid journal validates ok with count', () => {
  const f = tmp();
  append(f, ev());
  append(f, ev({ ts: '2026-07-26T10:06:00.000Z' }));
  assert.deepEqual(validateJournal(f), { ok: true, errors: [], count: 2, truncatedTail: false });
});

// --- nextId ------------------------------------------------------------

test('nextId starts at 1 on empty journal and never reuses numbers', () => {
  const f = tmp();
  assert.equal(nextId(f, 'D'), 'D-1');
  append(f, ev({ ev: 'decision', data: { id: 'D-1', text: 'x' } }));
  append(f, ev({ ts: '2026-07-26T10:07:00.000Z', ev: 'decision', data: { id: 'D-7', text: 'y' } }));
  assert.equal(nextId(f, 'D'), 'D-8');
  assert.equal(nextId(f, 'T'), 'T-1'); // prefixes are independent
});

test('nextId rejects regex-hostile prefixes; non-string data.id is rejected at append', () => {
  const f = tmp();
  assert.throws(() => nextId(f, '('), /invalid id prefix/);
  assert.throws(
    () => append(f, ev({ ev: 'decision', data: { id: 42, text: 'numeric id' } })),
    /data\.id must be a string/,
  );
});

// --- tail --------------------------------------------------------------

test('tail returns latest checkpoint and open (unreleased) leases', () => {
  const f = tmp();
  append(f, ev({ data: { phase: 'F1', next_steps: ['old'] } }));
  append(f, ev({ ts: '2026-07-26T10:08:00.000Z', ev: 'lease.acquired', data: { resource: 'dev-server', holder: 'impl-1' } }));
  append(f, ev({ ts: '2026-07-26T10:09:00.000Z', ev: 'lease.acquired', data: { resource: 'worktree-a', holder: 'impl-2' } }));
  append(f, ev({ ts: '2026-07-26T10:10:00.000Z', ev: 'lease.released', data: { resource: 'dev-server', holder: 'impl-1' } }));
  append(f, ev({ ts: '2026-07-26T10:11:00.000Z', data: { phase: 'F2', next_steps: ['resume here'] } }));
  const t = tail(f);
  assert.equal(t.checkpoint.data.phase, 'F2');
  assert.deepEqual(t.openLeases, [{ resource: 'worktree-a', holder: 'impl-2' }]);
});

test('tail: a release by a non-holder does NOT free the lease and is reported', () => {
  const f = tmp();
  append(f, ev({ ev: 'lease.acquired', data: { resource: 'dev-server', holder: 'impl-1' } }));
  append(f, ev({ ts: '2026-07-26T10:12:00.000Z', ev: 'lease.released', data: { resource: 'dev-server', holder: 'intruder' } }));
  const t = tail(f);
  assert.deepEqual(t.openLeases, [{ resource: 'dev-server', holder: 'impl-1' }]);
  assert.deepEqual(t.mismatchedReleases, [{ resource: 'dev-server', by: 'intruder', holder: 'impl-1' }]);
});

test('CLI: unknown flags and non-integer --limit fail loudly', () => {
  const f = tmp();
  execFileSync(process.execPath, [SCRIPT, 'append', f, 'init.created', 'demo']);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, 'validate', f, '--data', '{}'], { stdio: 'pipe' }), /Command failed|status 1/);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, 'query', f, '--limit', 'abc'], { stdio: 'pipe' }), /Command failed|status 1/);
});

// --- concurrency -------------------------------------------------------
// Review finding E2S1-R2: earlier versions of these tests were tautologies
// (sequential execFileSync / microtasks). This one spawns 20 processes
// SIMULTANEOUSLY, with auto-stamped ts, so it exercises the real race that
// R1 demonstrated: without the lock+clamp, validate failed in 5/5 runs.

test('20 truly concurrent processes: intact lines AND monotonic timestamps', async () => {
  const f = tmp();
  const procs = Array.from({ length: 20 }, (_, i) =>
    new Promise((resolveP, rejectP) => {
      const p = spawn(process.execPath, [
        SCRIPT, 'append', f, 'decision', 'demo', '--actor', `p${i}`, '--data', JSON.stringify({ id: `P-${i + 1}`, text: 'race' }),
      ]);
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => (code === 0 ? resolveP() : rejectP(new Error(`p${i} exit ${code}: ${err}`))));
    }),
  );
  await Promise.all(procs);
  const { events, badLines, truncatedTail } = readJournal(f);
  assert.equal(events.length, 20);
  assert.deepEqual(badLines, []);
  assert.equal(truncatedTail, false);
  const result = validateJournal(f);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true); // ts monotonic BY CONSTRUCTION under the lock
});

test('stamped ts is clamped to last event; explicit past ts is caller-owned', () => {
  const f = tmp();
  const future = new Date(Date.now() + 60_000).toISOString();
  append(f, ev({ ts: future }));
  const stamped = append(f, { ev: 'checkpoint', init: 'demo', actor: 'c', data: { phase: 'x', next_steps: [] } });
  assert.equal(stamped.ts, future); // clamped up, no regression
  assert.equal(validateJournal(f).ok, true);
  append(f, ev({ ts: '2020-01-01T00:00:00.000Z' })); // explicit past ts
  assert.equal(validateJournal(f).ok, false); // validate flags it — caller owns it
});

test('ts: undefined is stamped, not rejected (spread-order regression guard)', () => {
  const f = tmp();
  const written = append(f, { ts: undefined, ev: 'init.created', init: 'demo', actor: 'c', data: {} });
  assert.ok(!Number.isNaN(Date.parse(written.ts)));
});

// --- CLI ---------------------------------------------------------------

test('CLI: append -> query -> next-id -> validate roundtrip', () => {
  const f = tmp();
  execFileSync(process.execPath, [SCRIPT, 'append', f, 'init.created', 'demo']);
  execFileSync(process.execPath, [SCRIPT, 'append', f, 'ticket.created', 'demo', '--data', '{"id":"T-1"}']);
  const out = execFileSync(process.execPath, [SCRIPT, 'query', f, '--ev', 'ticket.created'], { encoding: 'utf8' });
  assert.equal(out.trim().split('\n').length, 1);
  const id = execFileSync(process.execPath, [SCRIPT, 'next-id', f, 'T'], { encoding: 'utf8' }).trim();
  assert.equal(id, 'T-2');
  execFileSync(process.execPath, [SCRIPT, 'validate', f]); // exit 0
});

test('CLI: validate exits 1 on a broken journal; bad usage exits 2', () => {
  const f = tmp();
  writeFileSync(f, 'NOT JSON\n{"also": "incomplete"\n');
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, 'validate', f]), /status 1|Command failed/);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, 'append']), /status 2|Command failed/);
});

test('EVENT_TYPES is frozen and matches the documented closed set size', () => {
  assert.ok(Object.isFrozen(EVENT_TYPES));
  assert.equal(EVENT_TYPES.length, 14);
});
