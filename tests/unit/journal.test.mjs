import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  realpathSync,
  mkdirSync,
  rmdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  EVENT_TYPES,
  validateEvent,
  append,
  readJournal,
  query,
  validateJournal,
  nextId,
  tail,
  openSpawns,
  spawnStaleness,
  isClosingPhase,
  DEFAULT_STALE_HOURS,
  closeSpawn,
  pairSpawns,
  agentNameProblem,
  DATA_ENUMS,
  CAPPED_DATA_KEYS,
  cappedKeyProblem,
  ASK_KIND_RE,
  nextAskKind,
  raiseAsk,
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

// --- the 17-event additions --------------------------------------------

test('progress and ticket.status enums reject out-of-set values, naming the whole set', () => {
  const bad = validateEvent(ev({ ev: 'progress', data: { agent: 'a', state: 'flying' } }));
  assert.ok(bad.some((e) => e.includes('started, working, blocked, unblocked')), bad.join('; '));
  const badColumn = validateEvent(ev({ ev: 'ticket.status', data: { ticket: 'T-1', column: 'done' } }));
  assert.ok(badColumn.some((e) => e.includes('blocked, waiting-operator, parked')), badColumn.join('; '));
  // done is what merge means — the override set is deliberately narrow
  assert.deepEqual(validateEvent(ev({ ev: 'ticket.status', data: { ticket: 'T-1', column: 'parked' } })), []);
  assert.deepEqual(validateEvent(ev({ ev: 'progress', data: { agent: 'a', state: 'blocked' } })), []);
  assert.ok(Object.isFrozen(DATA_ENUMS) && Object.isFrozen(DATA_ENUMS.progress.state));
});

/**
 * The capped set is closed, and the table below spells it out INSTEAD OF
 * iterating `CAPPED_DATA_KEYS`: a loop over the map under test silently skips
 * whatever was deleted from it. Measured — with `detail` and `proof` dropped
 * from `CAPPED_DATA_KEYS` the whole suite stayed green while both doc surfaces
 * kept claiming all three keys are capped.
 *
 * Each key is carried by an event that legitimately holds it, so the rejection
 * is the cap and not some other missing requirement.
 */
const ask = (over) => ({ ev: 'gate', data: { kind: 'Q-1', result: 'WAITING_ON_OPERATOR', ...over } });
const OVERSIZED_EVENT_BY_KEY = [
  ['detail', (big) => ({ ev: 'progress', data: { agent: 'impl-1', state: 'blocked', detail: big } })],
  ['claim', (big) => ({ ev: 'finding', data: { id: 'F-1', area: 'a', claim: big } })],
  ['proof', (big) => ({ ev: 'finding', data: { id: 'F-1', area: 'a', claim: 'c', proof: big } })],
  // The ask fields. They reach BOARD.md, board.html and ANSWERS.md, so an
  // uncapped one is a document-sized cell in three artefacts at once.
  ['question', (big) => ask({ question: big })],
  ['recommendation', (big) => ask({ question: 'q', recommendation: big })],
  ['default', (big) => ask({ question: 'q', default: big })],
  ['answer', (big) => ask({ result: 'answered', answer: big })],
];

test('EVERY capped key is REJECTED at append and only WARNED about in history', () => {
  assert.deepEqual(
    Object.keys(CAPPED_DATA_KEYS).sort(),
    OVERSIZED_EVENT_BY_KEY.map(([key]) => key).sort(),
    'the capped key set changed — docs/journal.md and its site mirror name these seven',
  );
  for (const [key, build] of OVERSIZED_EVENT_BY_KEY) {
    const cap = CAPPED_DATA_KEYS[key];
    assert.equal(cap, 2000, `both doc surfaces claim a 2 000-codepoint cap for data.${key}`);
    const file = tmp();
    const big = 'x'.repeat(cap + 1);
    assert.throws(
      () => append(file, ev({ ...build(big), ts: undefined })),
      new RegExp(`data\\.${key} is ${cap + 1} codepoints \\(cap ${cap}\\)`),
      `an oversized data.${key} must be rejected at append, naming the key and the cap`,
    );
    assert.deepEqual(readJournal(file).events, [], `a rejected append must write nothing (data.${key})`);
  }
  // the same event hand-written into the file: validate stays ok, warns loudly
  const file = tmp();
  const big = 'x'.repeat(CAPPED_DATA_KEYS.claim + 1);
  writeFileSync(file, JSON.stringify(ev({ ev: 'finding', data: { id: 'F-1', area: 'a', claim: big } })) + '\n');
  const result = validateJournal(file);
  assert.equal(result.ok, true, 'no retroactive errors');
  assert.ok(result.warnings.some((w) => w.includes('data.claim')), result.warnings.join('; '));
  // codepoints, not UTF-16 units
  assert.equal(cappedKeyProblem({ claim: '\u{1D400}'.repeat(CAPPED_DATA_KEYS.claim) }), null);

  // Kills the mutant that pushes a historical oversize into `errors`: a
  // journal written before the ask keys were capped carries a 3 000-codepoint
  // question, and `validate` must still say ok.
  const legacy = tmp();
  writeFileSync(
    legacy,
    JSON.stringify(ev(ask({ question: 'x'.repeat(3000) }))) + '\n',
  );
  const legacyResult = validateJournal(legacy);
  assert.equal(legacyResult.ok, true, 'a pre-cap journal must not turn red retroactively');
  assert.ok(legacyResult.warnings.some((w) => w.includes('data.question')), legacyResult.warnings.join('; '));
});

test('progress events never disturb spawn-report pairing (ADR-18)', () => {
  const spawnEv = ev({ ev: 'spawn', ts: '2026-07-26T10:00:01.000Z', data: { agent: 'impl-1', role: 'implementer' } });
  const progressEv = ev({ ev: 'progress', ts: '2026-07-26T10:00:02.000Z', data: { agent: 'impl-1', state: 'working' } });
  const reportEv = ev({ ev: 'report', ts: '2026-07-26T10:00:03.000Z', data: { agent: 'impl-1', verdict: 'done' } });
  const withProgress = pairSpawns([spawnEv, progressEv, reportEv]);
  const without = pairSpawns([spawnEv, reportEv]);
  assert.equal(withProgress.open.size, without.open.size);
  assert.equal(withProgress.pairs.length, without.pairs.length);
  assert.equal(withProgress.orphanReports.length, 0);
});

test('progress rejects an unusable agent name at append — it is a fold correlator', () => {
  const file = tmp();
  assert.throws(
    () => append(file, ev({ ev: 'progress', ts: undefined, data: { agent: ' padded ', state: 'working' } })),
    /data\.agent/,
  );
});

test('finding gets F-ids issued by the CLI when omitted', () => {
  const file = tmp();
  const run = (args) => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  run(['append', file, 'finding', 'demo', '--actor', 'scout-1', '--data', '{"area":"src/**","claim":"c"}']);
  run(['append', file, 'finding', 'demo', '--actor', 'scout-1', '--data', '{"area":"src/**","claim":"d"}']);
  const ids = readJournal(file).events.map((e) => e.data.id);
  assert.deepEqual(ids, ['F-1', 'F-2']);
});


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

test('a non-object data is REFUSED by name, and refused before an id is issued', () => {
  // MUTANT 1: drop `!Array.isArray(data)` from isDataObject — an array is an
  // object to typeof and takes string properties, so `--data '["a"]'` would be
  // WRITTEN, carrying a shape no reader expects.
  // MUTANT 2: drop the isDataObject term from the issuance guard — issuing an
  // id onto null/a string crashes with a raw TypeError instead of naming the
  // problem, and the crash happens before validation can report it.
  for (const data of [null, [], ['a'], 'str', 5, true]) {
    const errs = validateEvent(ev({ data }));
    assert.ok(
      errs.some((e) => e.includes('data must be a JSON object')),
      `data=${JSON.stringify(data)} must be refused by name, got ${JSON.stringify(errs)}`,
    );
  }
  // Through the CLI, where issuance runs: the refusal must be the validator's
  // sentence, never a TypeError from building an id on a non-object.
  const file = tmp();
  for (const raw of ['null', '"str"', '5', '["array","as","data"]']) {
    const out = spawnSync(process.execPath, [SCRIPT, 'append', file, 'decision', 'demo', '--data', raw], { encoding: 'utf8' });
    assert.equal(out.status, 1, `--data ${raw} must exit 1`);
    assert.match(out.stderr, /data must be a JSON object/, `--data ${raw} must name the problem`);
    assert.doesNotMatch(out.stderr, /Cannot (read|create)/, `--data ${raw} must not crash raw`);
  }
  assert.deepEqual(readJournal(file).events, [], 'nothing may be written by a refused append');
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
  assert.deepEqual(validateJournal(f), {
    ok: true,
    errors: [],
    warnings: [],
    count: 2,
    truncatedTail: false,
  });
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

// --- the contract discovers itself -------------------------------------
//
// Two independent field reports raised these. `skills/run/SKILL.md` says IDs
// never come from memory, because after a compaction memory hands out the same
// number twice — and `append` then REJECTED a missing id rather than issuing
// one. Measured: 12 decision IDs hand-assigned from memory in a single
// initiative, the exact failure the rule names, with nothing objecting.

test('CLI: append ISSUES a decision id when none is given, and never reuses one', () => {
  const f = tmp();
  const idOf = (out) => JSON.parse(out).data.id;
  const first = idOf(execFileSync(process.execPath, [SCRIPT, 'append', f, 'decision', 'demo', '--data', '{"text":"a"}'], { encoding: 'utf8' }));
  const second = idOf(execFileSync(process.execPath, [SCRIPT, 'append', f, 'decision', 'demo', '--data', '{"text":"b"}'], { encoding: 'utf8' }));
  assert.equal(first, 'D-1');
  assert.equal(second, 'D-2');
  // An explicit id still wins — this issues one, it does not take the choice away.
  const mine = idOf(execFileSync(process.execPath, [SCRIPT, 'append', f, 'decision', 'demo', '--data', '{"id":"D-99","text":"c"}'], { encoding: 'utf8' }));
  assert.equal(mine, 'D-99');
});

test('CLI: a rejected event names the whole closed set, and the whole data contract', () => {
  // Both were discoverable only by grepping the plugin's source or by failing
  // one invocation per missing key. The agent recovering from these errors has
  // no other source of truth.
  const f = tmp();
  const fails = (args) => {
    try {
      execFileSync(process.execPath, [SCRIPT, ...args], { stdio: 'pipe', encoding: 'utf8' });
      return '';
    } catch (err) {
      return `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
  };
  const unknown = fails(['append', f, 'review.verdict', 'demo', '--data', '{}']);
  for (const ev of EVENT_TYPES) assert.match(unknown, new RegExp(ev.replace('.', '\\.')), `must list ${ev}`);

  const incomplete = fails(['append', f, 'review', 'demo', '--data', '{}']);
  for (const key of ['ticket', 'verdict', 'by']) {
    assert.match(incomplete, new RegExp(`\\b${key}\\b`), `must name the ${key} requirement up front`);
  }
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

// An issued id is the referencing mechanism of the whole ledger — "see D-2" —
// in a file that is never rewritten, so a number handed out twice is ambiguous
// forever. Issuing one is read-compute-write, which is only atomic under the
// same lock as the write.
//
// Kills the mutant that issues the id BEFORE the lock is taken (`nextId(file,
// …)` in the CLI, then `append`): measured on that code over seven runs, 6
// simultaneous decision appends against one fresh journal issued between 1 and
// 4 distinct ids for 6 events. Sequential appends cannot see it — every writer
// must read before any of them has written.
test('8 truly concurrent appends issue 8 DISTINCT decision ids', { timeout: 60_000 }, async () => {
  const f = tmp();
  const launched = [];
  const finished = [];
  const t0 = Date.now();
  const procs = Array.from({ length: 8 }, (_, i) => {
    const p = spawn(process.execPath, [
      SCRIPT, 'append', f, 'decision', 'demo', '--actor', `p${i}`, '--data', JSON.stringify({ text: `d${i}` }),
    ]);
    launched.push(Date.now() - t0);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    return new Promise((res, rej) => {
      p.on('close', (code) => {
        finished.push(Date.now() - t0);
        code === 0 ? res() : rej(new Error(`p${i} exit ${code}: ${err}`));
      });
    });
  });
  await Promise.all(procs);

  // the same overlap proof the ADR-18 race uses: without it, 8 appends that
  // happened to serialize would pass while proving nothing
  assert.ok(
    Math.max(...launched) < Math.min(...finished),
    `not concurrent: last launch ${Math.max(...launched)}ms >= first exit ${Math.min(...finished)}ms`,
  );
  const ids = query(f, { ev: 'decision' }).map((e) => e.data.id);
  assert.equal(ids.length, 8, 'every writer must have appended exactly one event');
  assert.equal(new Set(ids).size, ids.length, `ids issued twice: ${ids.join(', ')}`);
  // contiguous, not merely distinct: max+1 under the lock can produce nothing else
  assert.deepEqual([...ids].sort(), ['D-1', 'D-2', 'D-3', 'D-4', 'D-5', 'D-6', 'D-7', 'D-8']);
  const { badLines, truncatedTail } = readJournal(f);
  assert.deepEqual(badLines, []);
  assert.equal(truncatedTail, false);
  assert.equal(validateJournal(f).ok, true);
});

// --- operator asks -----------------------------------------------------

// An ask id is a gate KIND, and the fold keys gates by kind with
// last-write-wins — so two writers handed one id do not collide loudly, they
// collide SILENTLY: the second question replaces the first on that Map and the
// first is gone from every artefact with nothing objecting anywhere.
//
// Kills the mutant that computes `nextAskKind` BEFORE `withLock` (read the
// journal, mint, then call append): every concurrent writer reads the same
// snapshot and mints the same `Q-1`.
test('8 truly concurrent asks mint 8 DISTINCT ask ids', { timeout: 60_000 }, async () => {
  const f = tmp();
  const launched = [];
  const finished = [];
  const t0 = Date.now();
  const procs = Array.from({ length: 8 }, (_, i) => {
    const p = spawn(process.execPath, [SCRIPT, 'ask', f, 'demo', '--actor', `p${i}`, '--question', `q${i}`]);
    launched.push(Date.now() - t0);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    return new Promise((res, rej) => {
      p.on('close', (code) => {
        finished.push(Date.now() - t0);
        code === 0 ? res() : rej(new Error(`p${i} exit ${code}: ${err}`));
      });
    });
  });
  await Promise.all(procs);

  // the overlap proof: 8 appends that happened to serialize would pass while
  // proving nothing about the lock
  assert.ok(
    Math.max(...launched) < Math.min(...finished),
    `not concurrent: last launch ${Math.max(...launched)}ms >= first exit ${Math.min(...finished)}ms`,
  );
  const kinds = query(f, { ev: 'gate' }).map((e) => e.data.kind);
  assert.equal(kinds.length, 8, 'every writer must have appended exactly one gate');
  assert.deepEqual([...kinds].sort(), ['Q-1', 'Q-2', 'Q-3', 'Q-4', 'Q-5', 'Q-6', 'Q-7', 'Q-8']);
  assert.equal(validateJournal(f).ok, true);
});

// Kills the mutant that drops the guard and lets a questionless ask through to
// `validateEvent`, whose complaint would be about `data.kind` — and the mutant
// that answers a missing --question with the usage dump, which does not say
// which flag was missing.
test('ask demands a question, and says so specifically rather than dumping usage', () => {
  const f = tmp();
  assert.throws(() => raiseAsk(f, { init: 'demo', question: '   ' }), /non-empty --question/);
  assert.deepEqual(readJournal(f).events, [], 'a refused ask writes nothing');
  const cli = spawnSync(process.execPath, [SCRIPT, 'ask', f, 'demo'], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /non-empty --question/);
  assert.doesNotMatch(cli.stderr, /^usage:/m, 'a missing flag gets its own message (the close-spawn precedent)');
});

// Kills the mutant that unanchors the regex to /Q-(\d+)/: a gate kind of
// `usage-limit-Q-99` would then raise the next ask to Q-100 and leave every id
// between free for a later collision.
test('nextAskKind reads only anchored Q- gate kinds', () => {
  assert.equal(nextAskKind([]), 'Q-1');
  assert.equal(
    nextAskKind([
      { ev: 'gate', data: { kind: 'usage-limit-Q-99' } },
      { ev: 'decision', data: { id: 'Q-50' } },
      { ev: 'gate', data: { kind: 'Q-2' } },
      { ev: 'gate', data: { kind: 'tests' } },
      { ev: 'gate', data: {} },
    ]),
    'Q-3',
  );
  assert.equal(ASK_KIND_RE.test('Q-7'), true);
  assert.equal(ASK_KIND_RE.test('xQ-7'), false);
  assert.equal(ASK_KIND_RE.test('Q-7x'), false);
});

test('ask writes the queue shape the board renders, and answering it is the same kind', () => {
  const f = tmp();
  const written = raiseAsk(f, {
    init: 'demo',
    actor: 'impl-t10',
    ticket: 'T-10',
    question: 'Flat fee or per-seat on the team plan?',
    recommendation: 'per-seat',
    default: 'per-seat ships Friday if no answer',
  });
  assert.equal(written.ev, 'gate');
  assert.equal(written.data.kind, 'Q-1');
  assert.equal(written.data.result, 'WAITING_ON_OPERATOR');
  assert.equal(written.data.ticket, 'T-10');
  // an ask with nothing optional carries no null keys the board would print
  const bare = raiseAsk(f, { init: 'demo', question: 'en dash or em dash?' });
  assert.deepEqual(Object.keys(bare.data), ['kind', 'result', 'question']);
  assert.equal(bare.data.kind, 'Q-2');
  assert.equal(validateJournal(f).ok, true);
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

test('CLI: invoked through a symlinked path, the script still does its work', () => {
  // The self-run guard compared resolve(argv[1]) — which keeps symlinks — with
  // import.meta.url, which Node has already canonicalized. Reaching the script
  // through a link therefore made main() never run: no output, no append, and
  // EXIT 0. A critical tool that succeeds without doing anything is the exact
  // failure "critical gates fail loudly" exists to forbid, and it is not
  // exotic: /tmp and /var are symlinks on macOS and plugin installs resolve
  // through links routinely.
  const base = mkdtempSync(join(tmpdir(), 'tyran-symlink-'));
  const realScripts = join(base, 'real-scripts');
  mkdirSync(realScripts);
  // journal.mjs now imports the shared invisibility rule (ADR-21), so the
  // sibling has to travel with it — a copy that omits it fails at module
  // resolution and would report the guard as broken when it is not.
  for (const name of ['journal.mjs', 'invisible.mjs']) {
    writeFileSync(join(realScripts, name), readFileSync(new URL(`../../scripts/${name}`, import.meta.url)));
  }
  const linked = join(base, 'linked-scripts');
  symlinkSync(realScripts, linked);

  const f = join(base, 'journal.jsonl');
  const out = execFileSync(
    process.execPath,
    [join(linked, 'journal.mjs'), 'append', f, 'init.created', 'demo', '--data', '{"title":"t"}'],
    { encoding: 'utf8' },
  );
  assert.match(out, /"ev":"init.created"/, 'the CLI produced no output at all');
  assert.equal(readJournal(f).events.length, 1, 'nothing was appended');
});

test('the self-run guard survives an argv[1] that cannot be canonicalized', () => {
  // The guard canonicalizes argv[1] with realpathSync, which THROWS when the
  // path cannot be followed. Without the fallback that throw escapes from
  // module scope and the tool dies at startup — importing journal.mjs would
  // fail outright, taking project.mjs (which imports it) down too.
  //
  // Reached in reality when argv[1] no longer resolves: the script directory
  // was renamed or removed after launch, a parent component became unreadable,
  // or a launcher/shim rewrote argv[1] to a logical name. NOT reached under
  // `node --eval`, where argv[1] is undefined and the earlier guard returns
  // first — this test pins the real reason, not the one first written down.
  const base = mkdtempSync(join(tmpdir(), 'tyran-argv-'));
  const harness = join(base, 'harness.mjs');
  writeFileSync(
    harness,
    "process.argv[1] = '/nonexistent-dir-" +
      "e2s6/entry.mjs';\n" +
      `await import(${JSON.stringify(SCRIPT)});\n` +
      "console.log('SURVIVED');\n",
  );
  const r = execFileSync(process.execPath, [harness], { encoding: 'utf8' });
  // Survived the import, and correctly declined to run main() for a foreign
  // entry point: no CLI usage text, no exception.
  assert.equal(r.trim(), 'SURVIVED');
});

test('EVENT_TYPES is frozen and matches the documented closed set size', () => {
  assert.ok(Object.isFrozen(EVENT_TYPES));
  assert.equal(EVENT_TYPES.length, 17);
});

// --- ADR-18: one open spawn per agent name -----------------------------

const spawnEv = (agent, { data = {}, ...over } = {}) => ({
  ev: 'spawn',
  init: 'demo',
  actor: 'conductor',
  ...over,
  data: { agent, role: 'implementer', ...data },
});
const reportEv = (agent, { data = {}, ...over } = {}) => ({
  ev: 'report',
  init: 'demo',
  actor: 'conductor',
  ...over,
  data: { agent, verdict: 'done', ...data },
});

test('ADR-18: a second spawn for an agent that is still open is rejected', () => {
  const f = tmp();
  append(f, spawnEv('impl-1', { data: { ticket: 'T-3' } }));
  const before = readFileSync(f); // Buffer — compare bytes, not events
  assert.throws(
    () => append(f, spawnEv('impl-1')),
    /already has an open spawn/,
  );
  assert.deepEqual(readFileSync(f), before, 'a rejected spawn must write NOTHING');
  assert.equal(query(f, { ev: 'spawn' }).length, 1);
});

test('ADR-18: spawn -> report -> spawn of the same name is allowed', () => {
  const f = tmp();
  append(f, spawnEv('impl-1'));
  append(f, reportEv('impl-1'));
  append(f, spawnEv('impl-1')); // previous one is closed — legal
  assert.equal(query(f, { ev: 'spawn' }).length, 2);
  assert.deepEqual(openSpawns(f).map((s) => s.agent), ['impl-1']);
  // ...and the reopened one is itself protected again
  assert.throws(() => append(f, spawnEv('impl-1')), /already has an open spawn/);
});

test('ADR-18: distinct agent names stay open in parallel', () => {
  const f = tmp();
  append(f, spawnEv('impl-1'));
  append(f, spawnEv('impl-2'));
  append(f, spawnEv('reviewer'));
  assert.deepEqual(openSpawns(f).map((s) => s.agent), ['impl-1', 'impl-2', 'reviewer']);
  append(f, reportEv('impl-2'));
  assert.deepEqual(openSpawns(f).map((s) => s.agent), ['impl-1', 'reviewer']);
  assert.equal(validateJournal(f).ok, true);
  // agent names are untrusted strings: the open set is a Map, so a name like
  // __proto__ is an ordinary key and still guarded
  append(f, spawnEv('__proto__'));
  assert.throws(() => append(f, spawnEv('__proto__')), /already has an open spawn/);
});

test('ADR-18: the rejection message names the agent, the previous spawn and the fix', () => {
  const f = tmp();
  append(f, spawnEv('tyran-implementer', { ts: '2026-07-26T09:00:00.000Z', data: { ticket: 'T-7' } }));
  let err;
  try {
    append(f, spawnEv('tyran-implementer'));
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'the duplicate spawn must throw');
  const m = err.message;
  assert.match(m, /"tyran-implementer"/); // which name
  assert.match(m, /2026-07-26T09:00:00\.000Z/); // when it was opened
  assert.match(m, /T-7/); // what it is working on
  assert.match(m, /close-spawn/); // how to get unstuck
  assert.match(m, /distinct name/); // how to run two agents at once
  assert.match(m, /ADR-18/); // why
});

test('ADR-18: the guard keys on file order, not on ts (future / duplicate ts cannot fool it)', () => {
  const f = tmp();
  append(f, spawnEv('impl-1', { ts: '2099-01-01T00:00:00.000Z' })); // far future
  assert.throws(() => append(f, spawnEv('impl-1', { ts: '2026-07-26T10:00:00.000Z' })), /open spawn/);
  assert.throws(() => append(f, spawnEv('impl-1', { ts: '2099-01-01T00:00:00.000Z' })), /open spawn/);
  const g = tmp();
  const same = '2026-07-26T10:00:00.000Z';
  append(g, spawnEv('impl-1', { ts: same }));
  append(g, reportEv('impl-1', { ts: same })); // identical ts still closes it
  append(g, spawnEv('impl-1', { ts: same }));
  assert.equal(query(g, { ev: 'spawn' }).length, 2);
});

test('ADR-18: a truncated final line cannot pose as a closing report', () => {
  const f = tmp();
  append(f, spawnEv('impl-1'));
  // crash mid-write of the report that WOULD have closed it: no trailing newline
  appendFileSync(f, '{"ts":"2026-07-26T10:30:00.000Z","ev":"report","init":"demo","actor":"c","data":{"agent":"impl-1","verd');
  assert.equal(readJournal(f).truncatedTail, true);
  assert.throws(() => append(f, spawnEv('impl-1')), /already has an open spawn/);
});

test('append heals a missing final newline instead of fusing onto a truncated line', () => {
  const f = tmp();
  append(f, spawnEv('impl-1'));
  appendFileSync(f, '{"ts":"2026-07-26T10:30:00.000Z","ev":"report","init":"demo","actor":"c","data":{"agent":"impl-1","verd');
  append(f, ev({ ts: '2026-07-26T10:31:00.000Z', ev: 'error', data: { class: 'crash' } }));
  const { events, badLines, truncatedTail } = readJournal(f);
  // the new event survives as its own line; the crashed remnant becomes
  // VISIBLE corruption (validate reports it) instead of silently eating it
  assert.equal(events.length, 2);
  assert.equal(events.at(-1).data.class, 'crash');
  assert.deepEqual(badLines, [2]);
  assert.equal(truncatedTail, false);
});

test('journals written before the guard still read; validate warns instead of erroring', () => {
  const f = tmp();
  const line = (over) => JSON.stringify({ ...spawnEv('impl-1'), ts: '2026-07-26T10:00:00.000Z', ...over });
  writeFileSync(f, line() + '\n' + line({ ts: '2026-07-26T10:05:00.000Z' }) + '\n');
  const { events, badLines } = readJournal(f); // rule: reads NEVER break
  assert.equal(events.length, 2);
  assert.deepEqual(badLines, []);
  assert.equal(query(f, { ev: 'spawn' }).length, 2);
  const result = validateJournal(f);
  assert.equal(result.ok, true, 'legacy duplicates are not a hard error — history is append-only');
  assert.equal(result.errors.length, 0);
  assert.ok(result.warnings.some((w) => /2 open spawns/.test(w) && /impl-1/.test(w)));
  // and the pairing rule stays FIFO: one report closes the OLDEST one only
  const { open } = pairSpawns([...events, { ev: 'report', data: { agent: 'impl-1' } }]);
  assert.equal(open.get('impl-1').length, 1);
  assert.equal(open.get('impl-1')[0].ts, '2026-07-26T10:05:00.000Z');
});

test('a report with no open spawn is written, but surfaced as an orphan', () => {
  const f = tmp();
  const written = append(f, reportEv('ghost')); // never silently dropped
  assert.equal(written.ev, 'report');
  const result = validateJournal(f);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => /"ghost"/.test(w) && /closes no open spawn/.test(w)));
  assert.deepEqual(openSpawns(f), []);
  // an orphan report does NOT bank credit against a future spawn
  append(f, spawnEv('ghost'));
  assert.throws(() => append(f, spawnEv('ghost')), /already has an open spawn/);
});

test('close-spawn closes an abandoned spawn, demands a reason, refuses no-ops', () => {
  const f = tmp();
  append(f, spawnEv('impl-1'));
  assert.throws(() => closeSpawn(f, { init: 'demo', agent: 'impl-1' }), /non-empty --reason/);
  assert.throws(() => closeSpawn(f, { init: 'demo', agent: 'nobody', reason: 'x' }), /no open spawn/);
  const written = closeSpawn(f, { init: 'demo', agent: 'impl-1', reason: 'agent killed by timeout' });
  assert.equal(written.ev, 'report'); // an ordinary event, not a bypass
  assert.equal(written.data.verdict, 'abandoned');
  assert.equal(written.data.closed_by, 'close-spawn');
  assert.deepEqual(openSpawns(f), []);
  append(f, spawnEv('impl-1')); // the name is usable again
  assert.deepEqual(validateJournal(f).warnings, []);
});

test('non-canonical agent names are refused on write (they would defeat the guard)', () => {
  const f = tmp();
  append(f, spawnEv('worker'));
  const bads = [
    'worker ', // trailing space
    ' worker', // leading space
    'worker\u00a0', // trailing NBSP - invisible in every terminal
    'wor\u200bker', // zero-width space inside
    'worker\u0007', // control character
    'e\u0301gide', // NFD - renders identically to the NFC form
    42, // not a string at all
    '', // empty
  ];
  for (const bad of bads) {
    assert.throws(
      () => append(f, spawnEv(bad)),
      /invalid event: data\.agent/,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
  // reports are held to the same standard - otherwise they could not close
  assert.throws(() => append(f, reportEv('worker ')), /invalid event: data\.agent/);
  // case IS significant: an agent name is an address, not prose
  assert.equal(agentNameProblem('Worker'), null);
  append(f, spawnEv('Worker'));
  assert.deepEqual(openSpawns(f).map((s) => s.agent), ['worker', 'Worker']);
  assert.equal(readJournal(f).events.length, 2);
});

test('a rejected spawn releases the lock (next append is immediate, not a 5s timeout)', () => {
  const f = tmp();
  append(f, spawnEv('impl-1'));
  assert.throws(() => append(f, spawnEv('impl-1')), /open spawn/);
  const t0 = Date.now();
  append(f, ev({ ev: 'error', data: { class: 'after-rejection' } }));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `append after a rejected one took ${elapsed}ms — lock leaked?`);
  assert.equal(readJournal(f).events.length, 2);
});

test('CLI: open-spawns and close-spawn round-trip; duplicate spawn exits 1', () => {
  const f = tmp();
  const run = (...args) => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  run('append', f, 'spawn', 'demo', '--data', '{"agent":"impl-1","role":"implementer"}');
  assert.equal(JSON.parse(run('open-spawns', f)).length, 1);
  let stderr = '';
  try {
    execFileSync(process.execPath, [SCRIPT, 'append', f, 'spawn', 'demo', '--data', '{"agent":"impl-1","role":"implementer"}'], { stdio: 'pipe' });
    assert.fail('duplicate spawn should exit 1');
  } catch (err) {
    assert.equal(err.status, 1);
    stderr = String(err.stderr);
  }
  assert.match(stderr, /already has an open spawn/);
  assert.match(stderr, /close-spawn/);
  try {
    execFileSync(process.execPath, [SCRIPT, 'close-spawn', f, 'demo', 'impl-1'], { stdio: 'pipe' });
    assert.fail('close-spawn without --reason should fail');
  } catch (err) {
    assert.equal(err.status, 1);
    assert.match(String(err.stderr), /requires a non-empty --reason/); // not a usage dump
  }
  run('close-spawn', f, 'demo', 'impl-1', '--reason', 'died in a fire');
  assert.deepEqual(JSON.parse(run('open-spawns', f)), []);
  run('append', f, 'spawn', 'demo', '--data', '{"agent":"impl-1","role":"implementer"}');
  assert.equal(JSON.parse(run('open-spawns', f)).length, 1);
  execFileSync(process.execPath, [SCRIPT, 'validate', f]); // still exit 0
});

// The guard is worthless if it only holds when nobody is racing. 12 separate
// OS processes attack the same name at once; the parent proves the overlap by
// measuring that the last child was launched before the first one exited.
test('ADR-18 under a real race: 12 concurrent processes, exactly one spawn survives', async () => {
  const f = tmp();
  const launched = [];
  const finished = [];
  const t0 = Date.now();
  const procs = Array.from({ length: 12 }, (_, i) => {
    const p = spawn(process.execPath, [
      SCRIPT, 'append', f, 'spawn', 'demo', '--actor', `p${i}`,
      '--data', JSON.stringify({ agent: 'racer', role: 'implementer', ticket: `T-${i}` }),
    ]);
    launched.push(Date.now() - t0);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    return new Promise((res) => {
      p.on('close', (code) => {
        finished.push(Date.now() - t0);
        res({ code, err });
      });
    });
  });
  const results = await Promise.all(procs);

  assert.ok(
    Math.max(...launched) < Math.min(...finished),
    `not concurrent: last launch ${Math.max(...launched)}ms >= first exit ${Math.min(...finished)}ms`,
  );
  const winners = results.filter((r) => r.code === 0);
  const losers = results.filter((r) => r.code !== 0);
  assert.equal(winners.length, 1, `expected exactly one winner, got ${winners.length}`);
  assert.equal(losers.length, 11);
  for (const l of losers) {
    assert.equal(l.code, 1);
    assert.match(l.err, /already has an open spawn/);
  }
  const { events, badLines, truncatedTail } = readJournal(f);
  assert.equal(events.length, 1);
  assert.equal(events[0].ev, 'spawn');
  assert.deepEqual(badLines, []);
  assert.equal(truncatedTail, false);
  const result = validateJournal(f);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

// --- review round 2: the five mutants that survived the first suite -----

// B1. A guard degraded to "look at the previous event only" passed all 36
// tests, because every duplicate in them sat next to its original. This is
// exactly the difference between a guarantee and a heuristic.
test('ADR-18: a duplicate separated from its original is still rejected', () => {
  const f = tmp();
  append(f, spawnEv('impl-1'));
  append(f, spawnEv('impl-2'));
  assert.throws(() => append(f, spawnEv('impl-1')), /already has an open spawn/);
  append(f, reportEv('impl-2')); // a report for ANOTHER name closes nothing here
  assert.throws(() => append(f, spawnEv('impl-1')), /already has an open spawn/);
  append(f, ev({ ev: 'error', data: { class: 'noise' } })); // unrelated events either
  assert.throws(() => append(f, spawnEv('impl-1')), /already has an open spawn/);
  assert.deepEqual(openSpawns(f).map((s) => s.agent), ['impl-1']);
  assert.equal(query(f, { ev: 'spawn' }).length, 2);
});

// B2. "warnings never change the exit code" is a documented promise and the
// backward-compatibility rule for pre-guard journals — pin it at the CLI.
test('CLI: validate on a legacy duplicate exits 0 and still lists the warning', () => {
  const f = tmp();
  const line = (ts) => JSON.stringify({ ...spawnEv('impl-1'), ts });
  writeFileSync(f, `${line('2026-07-26T10:00:00.000Z')}\n${line('2026-07-26T10:05:00.000Z')}\n`);
  // execFileSync throws on a non-zero exit — this call IS the exit-0 assertion
  const parsed = JSON.parse(execFileSync(process.execPath, [SCRIPT, 'validate', f], { encoding: 'utf8' }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /"impl-1" has 2 open spawns/);
});

// B3. The hint is what an autonomous caller executes. Names may legally
// contain spaces, apostrophes or a leading dash — run what we print.
test('the printed recovery commands actually run, for hostile agent names', () => {
  for (const agent of ['my agent', "o'brien", '--reason']) {
    const label = JSON.stringify(agent);
    const f = tmp();
    append(f, spawnEv(agent));
    let msg = '';
    try {
      append(f, spawnEv(agent));
    } catch (e) {
      msg = e.message;
    }
    assert.match(msg, /already has an open spawn/, label);
    const lines = msg.split('\n');
    const asShell = (cmd) => cmd.replace('node scripts/journal.mjs', `node '${SCRIPT}'`);

    // 1. the "record its report" hint (two lines, backslash continuation)
    const ai = lines.findIndex((l) => l.includes('journal.mjs append'));
    const appendCmd = asShell(`${lines[ai]}\n${lines[ai + 1]}`).replace('<verdict>', 'done');
    execFileSync('/bin/sh', ['-c', appendCmd], { stdio: 'pipe' });
    assert.deepEqual(openSpawns(f), [], `append hint did not close ${label}`);

    // 2. the "close it explicitly" hint, on a fresh open spawn
    const g = tmp();
    append(g, spawnEv(agent));
    let msg2 = '';
    try {
      append(g, spawnEv(agent));
    } catch (e) {
      msg2 = e.message;
    }
    const closeCmd = asShell(
      msg2.split('\n').find((l) => l.includes('close-spawn')).trim(),
    ).replace('<why>', 'died in a fire');
    execFileSync('/bin/sh', ['-c', closeCmd], { stdio: 'pipe' });
    assert.deepEqual(openSpawns(g), [], `close-spawn hint did not close ${label}`);
    assert.equal(query(g, { ev: 'report' }).at(-1).data.reason, 'died in a fire');
    assert.equal(query(g, { ev: 'report' }).at(-1).init, 'demo'); // real init, not "<init>"
  }
});

test('CLI: an agent named like a flag is closable via the POSIX -- separator', () => {
  const f = tmp();
  const run = (...args) => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  run('append', f, 'spawn', 'demo', '--data', JSON.stringify({ agent: '--reason', role: 'r' }));
  assert.equal(JSON.parse(run('open-spawns', f))[0].agent, '--reason');
  run('close-spawn', f, '--reason', 'stuck otherwise', 'demo', '--', '--reason');
  assert.deepEqual(JSON.parse(run('open-spawns', f)), []);
  run('append', f, 'spawn', 'demo', '--data', JSON.stringify({ agent: '--reason', role: 'r' }));
  assert.equal(JSON.parse(run('open-spawns', f)).length, 1); // the name is usable again
});

// B4. The "unusable agent name" warning branch had no coverage at all.
test('validate warns about agent names that cannot serve as a correlator', () => {
  const f = tmp();
  const bad = { ts: '2026-07-26T10:00:00.000Z', ev: 'spawn', init: 'demo', actor: 'c', data: { agent: ' worker', role: 'r' } };
  writeFileSync(f, JSON.stringify(bad) + '\n');
  const result = validateJournal(f);
  assert.equal(result.ok, true); // still not an error: reads never break
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /unusable data\.agent/);
  assert.match(result.warnings[0], /leading\/trailing whitespace/);
  assert.deepEqual(openSpawns(f), []); // excluded from pairing, never half-trusted
});

// B5. close-spawn is the way OUT of a deadlock; nothing pinned that it goes
// through the ordinary append path (a direct appendFileSync passed 36 tests).
test('close-spawn writes through the ordinary append path (validated, clamped, healed)', () => {
  const f = tmp();
  append(f, spawnEv('impl-1', { ts: '2099-01-01T00:00:00.000Z' }));
  // crash remnant: no trailing newline
  appendFileSync(f, '{"ts":"2099-01-02T00:00:00.000Z","ev":"report","init":"demo","actor":"c","data":{"agent":"impl-1","verd');
  const written = closeSpawn(f, { init: 'demo', agent: 'impl-1', reason: 'died' });
  assert.equal(written.ts, '2099-01-01T00:00:00.000Z'); // ts CLAMPED, not "now"
  const { events } = readJournal(f);
  assert.equal(events.at(-1).data.closed_by, 'close-spawn'); // survived: newline HEALED
  assert.deepEqual(validateEvent(events.at(-1)), []);
  assert.ok(!validateJournal(f).errors.some((e) => /earlier than previous/.test(e)));
  // and it is VALIDATED like every other event, writing nothing when invalid
  append(f, spawnEv('impl-2', { ts: '2099-01-03T00:00:00.000Z' }));
  const bytes = readFileSync(f);
  assert.throws(() => closeSpawn(f, { init: '', agent: 'impl-2', reason: 'y' }), /invalid event: init/);
  assert.deepEqual(readFileSync(f), bytes);
});

// B6. The lock is keyed by the canonical path, so an alias cannot buy a
// second lock. Asserted on the lock itself, not on a race outcome: a race
// only *sometimes* exposes the second lock, and evidence that only sometimes
// appears is not evidence. (Hard links still alias — documented, not fixed.)
//
// There is deliberately NO observation window here. "Still running after N ms"
// cannot tell a child blocked on the lock from a child that has not reached it
// yet, so a slow-starting process makes such an assertion pass for the wrong
// reason — verified: with a 1 s busy-wait at CLI entry, a mutant keying the
// lock by the given path survives that form of the test. The child is instead
// left to run to completion: with the lock held it has exactly two possible
// endings, and only one of them is reachable without a second lock.
test('the lock is keyed by the canonical path: a symlink alias cannot buy a second lock', async () => {
  const f = tmp();
  append(f, ev({ ev: 'init.created', data: {} }));
  const link = `${f}.link`;
  symlinkSync(f, link);
  const heldLock = `${realpathSync(f)}.lock`;
  mkdirSync(heldLock); // a live writer holds the lock through the REAL path
  const spawnArgs = [SCRIPT, 'append', link, 'spawn', 'demo', '--data', '{"agent":"racer","role":"r"}'];
  let result;
  try {
    result = await new Promise((res) => {
      const child = spawn(process.execPath, spawnArgs);
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => res({ code, out, err }));
    });
  } finally {
    rmdirSync(heldLock);
  }
  // Either it acquired a second lock and wrote (mutant), or it ran into ITS
  // OWN 5 s timeout on the lock we hold — which no amount of slowness fakes.
  assert.equal(result.code, 1, `the alias bought a second lock (stdout: ${result.out})`);
  assert.match(result.err, /journal lock timeout/);
  assert.equal(query(f, { ev: 'spawn' }).length, 0); // nothing slipped past the lock
  // Positive control: the very same command succeeds once the lock is free —
  // so the failure above was the lock, not a broken command. It also proves
  // the alias writes into the very same file.
  execFileSync(process.execPath, spawnArgs);
  assert.equal(query(f, { ev: 'spawn' }).length, 1);
});

// --- operator-facing output --------------------------------------------------

/**
 * `JSON.stringify` escapes C0 controls and nothing else, so bidi overrides,
 * TAG characters and zero-width marks came out RAW from every subcommand that
 * prints journal content. Same class as the blocker a security review found in
 * `project.warnings()`, on a channel nobody had swept.
 *
 * Driven through the real CLI, because the escaping lives in the CLI's sink:
 * a unit test of `jsonEscapeInvisible` alone stays green while every
 * `console.log` in this file goes back to printing raw bytes (measured — that
 * mutant survived until this test existed).
 */
const INVISIBLE_IN = (text) =>
  [...text].filter((c) => {
    const n = c.codePointAt(0);
    if (n === 0x0a || n === 0x09) return false;
    return /^[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}]$/u.test(c);
  });

test('every CLI subcommand escapes invisible characters, and stays parseable', () => {
  const RLO = String.fromCodePoint(0x202e);
  const TAG = String.fromCodePoint(0xe0041);
  const ZWSP = String.fromCodePoint(0x200b);
  const d = mkdtempSync(join(tmpdir(), 'tyran-journal-cli-'));
  const f = join(d, 'journal.jsonl');
  const poisoned = `demo${RLO}${TAG}${ZWSP}`;
  writeFileSync(
    f,
    [
      { ts: '2026-07-26T10:00:00.000Z', ev: 'checkpoint', init: poisoned, actor: `a${TAG}`, data: { phase: `p${RLO}`, next_steps: [`s${TAG}`] } },
      { ts: '2026-07-26T10:00:01.000Z', ev: 'spawn', init: poisoned, actor: 'c', data: { agent: 'impl', role: `r${ZWSP}` } },
      { ts: '2026-07-26T10:00:02.000Z', ev: `bogus${TAG}`, init: poisoned, actor: 'c', data: {} },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
    'utf8',
  );

  for (const args of [['query', f], ['tail', f], ['open-spawns', f], ['validate', f], ['next-id', f, 'T']]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    assert.ok(r.status === 0 || r.status === 1, `${args[0]} crashed: ${r.stderr}`);
    assert.deepEqual(
      INVISIBLE_IN(r.stdout).map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`),
      [],
      `journal.mjs ${args[0]} printed invisible characters to the terminal`,
    );
  }

  // Safety must not have cost fidelity: `query` output is parsed by tooling.
  const q = spawnSync(process.execPath, [SCRIPT, 'query', f], { encoding: 'utf8' });
  const parsed = q.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(parsed[0].init, poisoned, 'escaping the CLI output must be LOSSLESS');
  assert.equal(parsed.length, 3);
});

test('validateJournal messages carry no raw journal values', () => {
  // The module that BUILDS a message owns making it safe. Both of today's
  // consumers happen to sanitize as well, which makes this redundant — and
  // redundant is the point: relying on every consumer remembering is the
  // caller-discipline mechanism this project distrusts. Without this test the
  // source-level escaping is an unguarded claim (measured: the mutant that
  // removes it survives on consumer tests alone).
  const TAG = String.fromCodePoint(0xe0041);
  const RLO = String.fromCodePoint(0x202e);
  const d = mkdtempSync(join(tmpdir(), 'tyran-journal-msg-'));
  const f = join(d, 'journal.jsonl');
  writeFileSync(
    f,
    [
      { ts: '2026-07-26T10:00:00.000Z', ev: `bogus${TAG}type`, init: 'demo', actor: 'a', data: {} },
      { ts: '2026-07-26T10:00:01.000Z', ev: 'report', init: 'demo', actor: 'a', data: { agent: `ghost${RLO}`, verdict: 'v' } },
      { ts: '2026-07-26T09:00:00.000Z', ev: 'checkpoint', init: 'demo', actor: 'a', data: { phase: 'p', next_steps: [] } },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
    'utf8',
  );
  const result = validateJournal(f);
  assert.ok(result.errors.length > 0 && result.warnings.length > 0, 'premise: this journal produces both');
  for (const message of [...result.errors, ...result.warnings]) {
    assert.deepEqual(
      INVISIBLE_IN(message).map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`),
      [],
      `a raw journal value reached a message: ${JSON.stringify(message)}`,
    );
  }
});

// --- field fixes: reviews close reviewer spawns; empty ids are issued ---

const reviewEv = (by, { data = {}, ...over } = {}) => ({
  ev: 'review',
  init: 'demo',
  actor: by,
  ...over,
  data: { ticket: 'T-1', verdict: 'APPROVE', by, ...data },
});

test('a review whose `by` names an open spawn closes it, like a report', () => {
  const f = tmp();
  append(f, spawnEv('reviewer-1', { data: { role: 'reviewer' } }));
  append(f, reviewEv('reviewer-1'));
  assert.deepEqual(openSpawns(f), []);
  // the pairing is visible to consumers, verdict included
  const { pairs } = pairSpawns(readJournal(f).events);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].report.data.verdict, 'APPROVE');
  // ADR-18 still holds: the name can be spawned again, once
  append(f, spawnEv('reviewer-1'));
  assert.throws(() => append(f, spawnEv('reviewer-1')), /already has an open spawn/);
});

test('a review with no open spawn of that name is not an orphan', () => {
  const f = tmp();
  append(f, reviewEv('never-spawned'));
  const { orphanReports, unusable } = pairSpawns(readJournal(f).events);
  assert.deepEqual(orphanReports, []);
  assert.deepEqual(unusable, []);
  assert.equal(validateJournal(f).ok, true);
});

test('legacy close-spawn report after a review-closure is not an orphan', () => {
  const f = tmp();
  append(f, spawnEv('reviewer-1', { data: { role: 'reviewer' } }));
  append(f, reviewEv('reviewer-1')); // closes the spawn under the new rule
  // a journal written under the old rule then carries the close-spawn report:
  append(f, reportEv('reviewer-1', { data: { closed_by: 'close-spawn' } }));
  assert.deepEqual(pairSpawns(readJournal(f).events).orphanReports, []);
  // a stray ORDINARY report with no spawn is still an orphan
  append(f, reportEv('reviewer-1'));
  assert.equal(pairSpawns(readJournal(f).events).orphanReports.length, 1);
});

test('an explicit empty data.id is issued by CLI append, not stored blank', () => {
  const f = tmp();
  execFileSync(process.execPath, [SCRIPT, 'append', f, 'decision', 'demo', '--data', '{"id":"","text":"picked a default"}']);
  execFileSync(process.execPath, [SCRIPT, 'append', f, 'decision', 'demo', '--data', '{"id":"","text":"second"}']);
  assert.deepEqual(query(f, { ev: 'decision' }).map((e) => e.data.id), ['D-1', 'D-2']);
});

test('append itself issues the id — explicit wins, "" is absent, other types get none', () => {
  // Every assertion goes through `append`, never the CLI: the mutant this
  // kills is issuance moved back out to any caller (which is outside the write
  // lock), and the CLI tests above stay green under exactly that mutant.
  const f = tmp();
  const decide = (data) => append(f, { ev: 'decision', init: 'demo', actor: 'c', data });
  assert.equal(decide({ text: 'issued' }).data.id, 'D-1');
  assert.equal(decide({ id: '', text: 'empty is not explicit' }).data.id, 'D-2');
  assert.equal(decide({ id: 'D-99', text: 'mine' }).data.id, 'D-99');
  assert.equal(decide({ text: 'after the explicit one' }).data.id, 'D-100');
  const mine = { text: 'the caller keeps its own object' };
  decide(mine);
  assert.equal(mine.id, undefined);
  // only the types in ID_ISSUED_FOR are issued one
  const checkpoint = append(f, { ev: 'checkpoint', init: 'demo', actor: 'c', data: { phase: 'p', next_steps: [] } });
  assert.equal('id' in checkpoint.data, false);
  assert.deepEqual(query(f, { ev: 'decision' }).map((e) => e.data.id), ['D-1', 'D-2', 'D-99', 'D-100', 'D-101']);
  assert.equal(validateJournal(f).ok, true);
});

test('a review cannot close a colliding non-reviewer spawn', () => {
  // Review finding: `by` is a free string; a collision with a still-working
  // implementer's name must not mark that implementer reported.
  const f = tmp();
  append(f, spawnEv('worker-1'));
  append(f, reviewEv('worker-1'));
  assert.deepEqual(openSpawns(f).map((s) => s.agent), ['worker-1']);
  assert.equal(pairSpawns(readJournal(f).events).pairs.length, 0);
  // and ADR-18 still refuses a second live spawn of the same name
  assert.throws(() => append(f, spawnEv('worker-1')), /already has an open spawn/);
});

// --- the one staleness rule, and the one closing phase -------------------

test('spawnStaleness is measured in JOURNAL time and owns the threshold', () => {
  // This predicate exists so doctor and the board cannot disagree. It lived in
  // doctor alone, and the projection had no notion of staleness at all — so an
  // agent doctor called abandoned went on reading `running` on the board for as
  // long as the journal survived. MUTANT: compare against Date.now().
  const spawn = '2026-07-26T09:00:00.000Z';
  assert.equal(spawnStaleness(spawn, '2026-07-26T12:59:00.000Z').stale, false, 'under 4 h');
  assert.equal(spawnStaleness(spawn, '2026-07-26T13:00:00.000Z').stale, true, 'AT the threshold is stale');
  assert.equal(spawnStaleness(spawn, '2026-07-26T13:00:00.000Z').ageHours, 4);
  assert.equal(spawnStaleness(spawn, '2026-07-26T11:00:00.000Z', 2).stale, true, 'the threshold is a parameter');
  assert.equal(DEFAULT_STALE_HOURS, 4);
});

test('an unreadable or absent reference is not a staleness verdict', () => {
  // MUTANT: default ageHours to 0, or treat null as stale. A journal whose
  // last timestamp cannot be parsed knows nothing about how long anything has
  // been open, and guessing either way is worse than saying so.
  for (const reference of [null, undefined, 'not-a-timestamp']) {
    const r = spawnStaleness('2026-07-26T09:00:00.000Z', reference);
    assert.equal(r.ageHours, null, `reference ${JSON.stringify(reference)}`);
    assert.equal(r.stale, false, 'no reference is "unknown", never "stale"');
  }
  assert.equal(spawnStaleness('nonsense', '2026-07-26T09:00:00.000Z').stale, false);
});

test('exactly one checkpoint phase closes an initiative', () => {
  // `phase` is free text — it carries epic labels and lifecycle notes — so the
  // one value that MEANS something is compared trimmed and case-insensitively,
  // and everything else is left alone.
  for (const yes of ['closed', 'CLOSED', 'Closed', '  closed  ']) assert.equal(isClosingPhase(yes), true, yes);
  for (const no of ['closing', 'close', 'E2', 'resumed', 'usage-limit-pause', '', null, undefined, 3]) {
    assert.equal(isClosingPhase(no), false, JSON.stringify(no));
  }
});
