import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COST_SCHEMA,
  TICKET_IN_DESCRIPTION_RE,
  costJson,
  costOf,
  costOfTable,
  costReport,
  emptyCounters,
  forEachLine,
  listSources,
  rollup,
  scanAll,
  scanTranscript,
  tokensOf,
  transcriptDirFor,
} from '../../scripts/cost.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const COST_CLI = resolve(HERE, '..', '..', 'scripts', 'cost.mjs');

/** Built, never typed: a raw bidi override in a tracked file is what ADR-19
 * refuses, and the write guard refused this very file until it was built
 * from its codepoint instead. */
const RLO = String.fromCodePoint(0x202e);

/* ------------------------------- fixtures -------------------------------- */

const usage = (input, cacheWrite, cacheRead, output) => ({
  input_tokens: input,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
  output_tokens: output,
});

function assistant(model, u, requestId, cwd, ts = '2026-08-14T10:00:00.000Z') {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    cwd,
    requestId,
    message: { model, usage: u },
  });
}

/**
 * A repo with a transcript tree the platform would have written for it.
 * `slugged` controls whether the project directory is named the way the
 * platform names it, which is what separates the direct lookup from the
 * cwd-matching fallback.
 */
function makeTree({ slugged = true, pricing = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'tyran-cost-'));
  const repo = join(base, 'repo');
  const projects = join(base, 'projects');
  mkdirSync(join(repo, '.tyran', 'state'), { recursive: true });

  const slug = slugged ? resolve(repo).split(sep).join('-') : 'some-other-project';
  const project = join(projects, slug);
  mkdirSync(join(project, 'sess-1', 'subagents'), { recursive: true });

  const cwd = resolve(repo);
  writeFileSync(
    join(project, 'sess-1.jsonl'),
    [
      // The SAME request twice: the platform writes one record per content
      // block and repeats the request's cumulative usage on each.
      assistant('m-expensive', usage(10, 1000, 20000, 500), 'r1', cwd),
      assistant('m-expensive', usage(10, 1000, 20000, 500), 'r1', cwd),
      assistant('m-expensive', usage(0, 500, 10000, 200), 'r2', cwd),
      // Two different kinds of line that are not a usage record, and they are
      // NOT the same case: one never looks like a record at all, the other
      // does and then fails to parse.
      'not json at all, and not shaped like it either',
      '{"type":"assistant","message":{"usage":',
      JSON.stringify({ type: 'user', cwd, timestamp: '2026-08-14T10:00:01.000Z' }),
    ].join('\n') + '\n'
  );

  const agents = join(project, 'sess-1', 'subagents');
  writeFileSync(join(agents, 'agent-a1.jsonl'), assistant('m-cheap', usage(5, 200, 3000, 100), 'r3', cwd) + '\n');
  writeFileSync(
    join(agents, 'agent-a1.meta.json'),
    JSON.stringify({ agentType: 'implementer', description: 'T-7 wire the thing' })
  );
  writeFileSync(join(agents, 'agent-a2.jsonl'), assistant('m-unpriced', usage(1, 100, 2000, 50), 'r4', cwd) + '\n');
  writeFileSync(
    join(agents, 'agent-a2.meta.json'),
    JSON.stringify({ agentType: 'scout', description: 'look around, no ticket named' })
  );

  const config = ["profile: 'balanced'"];
  if (pricing) {
    config.push(
      'pricing:',
      "  rate_card: 'test-card'",
      '  models:',
      '    m-expensive:',
      '      input: 15',
      '      cache_write: 18.75',
      '      cache_read: 1.5',
      '      output: 75',
      '    m-cheap:',
      '      input: 1',
      '      cache_write: 1.25',
      '      cache_read: 0.1',
      '      output: 5'
    );
  }
  writeFileSync(join(repo, '.tyran', 'config.yaml'), config.join('\n') + '\n');

  return { base, repo, projects, project, tyranDir: join(repo, '.tyran') };
}

const report = (tree) => costReport({ tyranDir: tree.tyranDir, projectsRoot: tree.projects });
const row = (rows, key, name) => rows.find((r) => r[key] === name);

/* --------------------------------- tests --------------------------------- */

test('one request counted once, however many records carry it', () => {
  const tree = makeTree();
  const scan = scanTranscript(join(tree.project, 'sess-1.jsonl'));
  // MUTANT: drop the `seen` set in scanTranscript and this reads 3 requests
  // and 63 210 tokens — every number in the feature inflates by the streaming
  // record count, which varies per response.
  assert.equal(scan.byModel['m-expensive'].requests, 2);
  assert.equal(tokensOf(scan.byModel['m-expensive']), 10 + 1000 + 20000 + 500 + 0 + 500 + 10000 + 200);
});

test('a malformed line is skipped, not fatal, and non-assistant records are ignored', () => {
  const tree = makeTree();
  const scan = scanTranscript(join(tree.project, 'sess-1.jsonl'));
  // MUTANT: let JSON.parse throw instead of counting — one corrupt line in a
  // 20 MB transcript takes the whole report down.
  assert.equal(scan.malformed, 1);
  assert.equal(Object.keys(scan.byModel).length, 1);
});

test('an unpriced model is null, never zero, and never blanks a priced row', () => {
  const priced = { 'm-cheap': { input: 1, cache_write: 1.25, cache_read: 0.1, output: 5 } };
  const counters = { ...emptyCounters(), output: 1_000_000 };
  // MUTANT: return 0 for a model absent from the table — an unpriced model
  // then reads as free, which is the one reading that changes routing for the
  // wrong reason.
  assert.equal(costOf('m-unknown', counters, priced), null);
  assert.equal(costOf('m-cheap', counters, priced), 5);
});

test('partial pricing is a partial sum; null means nothing here is priced at all', () => {
  const priced = { 'm-cheap': { input: 1, cache_write: 0, cache_read: 0, output: 0 } };
  const mixed = {
    'm-cheap': { ...emptyCounters(), input: 1_000_000 },
    'm-unknown': { ...emptyCounters(), input: 1_000_000 },
  };
  // MUTANT: return null when ANY model lacks a rate. A real rate card always
  // misses something, so the grand total would be blank forever.
  assert.equal(costOfTable(mixed, priced), 1);
  assert.equal(costOfTable({ 'm-unknown': { ...emptyCounters(), input: 5 } }, priced), null);
});

test('a ticket id at the head of the task description attributes the agent', () => {
  const tree = makeTree();
  const sources = listSources(tree.project, null);
  const a1 = sources.find((s) => s.agent_id === 'agent-a1');
  const a2 = sources.find((s) => s.agent_id === 'agent-a2');
  // MUTANT: match the ticket anywhere in the description instead of at the
  // head — "fix the thing that broke T-3" would file spend against T-3.
  assert.equal(a1.ticket, 'T-7');
  assert.equal(a2.ticket, null);
  assert.equal(TICKET_IN_DESCRIPTION_RE.test('later mention of T-3'), false);
  assert.equal(TICKET_IN_DESCRIPTION_RE.exec('[T-12] do it')[1], 'T-12');
});

test('an agent with no ticket is counted and shown, never dropped', () => {
  const out = report(makeTree());
  // MUTANT: skip untickets instead of bucketing them — the per-ticket rows
  // stop summing to the total and the table quietly understates the bill.
  assert.equal(out.coverage.agent_transcripts, 2);
  assert.equal(out.coverage.attributed, 1);
  assert.equal(out.coverage.unattributed, 1);
  assert.ok(row(out.by_ticket, 'ticket', 'unattributed'));
  const summed = out.by_ticket.reduce((n, r) => n + r.tokens, 0);
  assert.equal(summed, out.totals.tokens);
});

test('the conductor is its own row and its share is measured in tokens', () => {
  const out = report(makeTree());
  const conductor = row(out.by_ticket, 'ticket', 'conductor');
  assert.ok(conductor);
  const expected = Math.round((conductor.tokens / out.totals.tokens) * 100);
  // MUTANT: compute the share from dollars. With one model unpriced the ratio
  // is taken over whichever subset happened to be priced; this same tree
  // reads 86% by tokens and 99% by dollars.
  assert.equal(out.totals.conductor_token_share, expected);
  assert.notEqual(out.totals.conductor_token_share, 99);
});

test('a model that billed no tokens is not reported as unpriced', () => {
  const scanned = [
    { kind: 'conductor', by_model: { synthetic: emptyCounters() }, last_ts: null },
    {
      kind: 'agent',
      agent_type: 'scout',
      ticket: null,
      by_model: { 'm-unknown': { ...emptyCounters(), requests: 1, output: 5 } },
      last_ts: null,
    },
  ];
  const out = rollup(scanned, { rate_card: null, models: Object.create(null) }, {});
  // MUTANT: drop the tokens>0 guard — the platform's `<synthetic>` records
  // appear in live data with zero tokens, so every report would carry a
  // permanent warning about a model that cannot cost anything, teaching
  // operators to ignore the line.
  assert.deepEqual(out.unpriced, ['m-unknown']);
});

test('the rate card label travels with the report', () => {
  assert.equal(report(makeTree()).rate_card, 'test-card');
  // MUTANT: keep the amounts and drop the label — two people quoting
  // different cards produce different money from one set of tokens, and a
  // figure that cannot say which card produced it is not a measurement.
  assert.equal(report(makeTree({ pricing: false })).rate_card, null);
});

test('with no rate card the tokens still count and the money stays absent', () => {
  const out = report(makeTree({ pricing: false }));
  assert.ok(out.totals.tokens > 0);
  // MUTANT: fall back to a built-in price list. Tyran does not know what
  // anyone pays; inventing a number is worse than showing none.
  assert.equal(out.totals.usd, null);
});

test('the transcript directory is found by cwd when the slug does not match', () => {
  const tree = makeTree({ slugged: false });
  // MUTANT: delete the fallback scan and trust the computed slug — a repo
  // reached through a symlink or renamed after its first session reports
  // "no transcripts" forever.
  assert.equal(transcriptDirFor(tree.repo, tree.projects), tree.project);
  assert.equal(report(tree).transcripts_found, true);
});

test('a repo with no transcripts says so rather than reporting zero spend', () => {
  const tree = makeTree();
  const empty = costReport({ tyranDir: tree.tyranDir, projectsRoot: join(tree.base, 'nowhere') });
  // MUTANT: return an all-zero report — "this cost nothing" and "this was
  // never measured" become the same screen.
  assert.equal(empty.transcripts_found, false);
});

test('an unchanged transcript is reused from cache; a changed one is rescanned', () => {
  const tree = makeTree();
  const sources = listSources(tree.project, null);
  const first = scanAll(sources, null);
  assert.equal(first.reused, 0);

  const cache = {
    schema: COST_SCHEMA,
    sources: first.scanned.map((s) => ({
      path: s.path,
      mtime_ms: s.mtime_ms,
      size: s.size,
      by_model: s.by_model,
      last_ts: s.last_ts,
    })),
  };
  assert.equal(scanAll(sources, cache).reused, 3);

  // Touching a file must invalidate its entry: the running session's own
  // transcript grows during the sitting and a stale total is a wrong total.
  const touched = join(tree.project, 'sess-1.jsonl');
  const later = new Date(Date.now() + 60_000);
  utimesSync(touched, later, later);
  const after = scanAll(listSources(tree.project, null), cache);
  // MUTANT: key the cache on path alone — the page then shows the first
  // render's numbers for the rest of the session.
  assert.equal(after.reused, 2);
});

test('cost.json escapes invisibles rather than dropping them', () => {
  const scanned = [
    {
      kind: 'agent',
      agent_type: `scout${RLO}evil`,
      ticket: null,
      by_model: { m: { ...emptyCounters(), requests: 1, output: 1 } },
      last_ts: null,
    },
  ];
  const text = costJson(rollup(scanned, { rate_card: null, models: Object.create(null) }, {}));
  // MUTANT: JSON.stringify without the escape — an unterminated
  // right-to-left override then sits raw in a file an operator may open in a
  // terminal or an editor, mirroring every character after it.
  assert.ok(!text.includes(RLO), 'the BYTES on disk carry no raw override');
  assert.ok(text.includes('u202E'), 'escaped, never removed: a value nobody can see is a value nobody can judge');
  // The escaping is deliberately LOSSLESS, exactly like board.json: JSON.parse
  // hands a consumer the original codepoint back. That is why neutralising for
  // display is the PAGE's job — board-html routes every string through its own
  // escaper — and asserting the parsed value is clean here would be asserting
  // a property this format intentionally does not have.
  assert.equal(JSON.parse(text).by_agent_type[0].agent_type.includes(RLO), true);
});

test('rows are ranked by size with a stable tiebreak, so reruns agree', () => {
  const tree = makeTree();
  const a = report(tree);
  const b = report(tree);
  // MUTANT: drop the name tiebreak in the sort — two equal rows swap between
  // renders and the page flickers for no reason.
  assert.deepEqual(a.by_model.map((r) => r.model), b.by_model.map((r) => r.model));
  const tokens = a.by_model.map((r) => r.tokens);
  assert.deepEqual(tokens, [...tokens].sort((x, y) => y - x));
});

test('CLI prints a report, and --json writes the sidecar under state/', () => {
  const tree = makeTree();
  const human = execFileSync(
    process.execPath,
    [COST_CLI, '--dir', tree.tyranDir, '--projects', tree.projects],
    { encoding: 'utf8' }
  );
  assert.match(human, /^Spend — /);
  assert.match(human, /rate card test-card/);
  assert.match(human, /Conductor overhead: \d+% of tokens/);
  // The gap report is not optional decoration: it is how an operator tells a
  // low number from an incomplete one.
  assert.match(human, /Coverage: 1 of 2 agent transcripts/);
  assert.match(human, /Unpriced models/);

  const out = execFileSync(
    process.execPath,
    [COST_CLI, '--dir', tree.tyranDir, '--projects', tree.projects, '--json'],
    { encoding: 'utf8' }
  ).trim();
  assert.equal(out, join(tree.tyranDir, 'state', 'cost.json'));
  const parsed = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(parsed.schema, COST_SCHEMA);
  assert.ok(parsed.sources.length > 0, 'the sidecar carries its own cache');
});

test('CLI refuses an unknown flag and a missing directory with exit 2', () => {
  const tree = makeTree();
  for (const args of [['--nope'], ['--dir', join(tree.base, 'absent')]]) {
    assert.throws(
      () => execFileSync(process.execPath, [COST_CLI, ...args], { encoding: 'utf8', stdio: 'pipe' }),
      (err) => err.status === 2
    );
  }
});

test('records the reader could not use reach the report, not just the scanner', () => {
  const tree = makeTree();
  const out = report(tree);
  // MUTANT: drop `malformed` from scanAll's carried fields or from coverage.
  // The fixture's truncated record then vanishes between the scanner and the
  // report, and a transcript being appended to WHILE it is read — which is
  // the running conductor's own file, every time — looks complete while
  // being short by its whole tail.
  assert.equal(out.coverage.malformed, 1);
  assert.equal(typeof out.coverage.skipped_lines, 'number');
  const human = execFileSync(
    process.execPath,
    [COST_CLI, '--dir', tree.tyranDir, '--projects', tree.projects],
    { encoding: 'utf8' }
  );
  assert.match(human, /Records this reader could not use: 1 unparseable/);
});

test('a gap survives the cache: a reused source keeps its malformed count', () => {
  const tree = makeTree();
  const sources = listSources(tree.project, null);
  const first = scanAll(sources, null);
  const cache = {
    schema: COST_SCHEMA,
    sources: first.scanned.map((s) => ({
      path: s.path,
      mtime_ms: s.mtime_ms,
      size: s.size,
      by_model: s.by_model,
      last_ts: s.last_ts,
      malformed: s.malformed,
      skipped_lines: s.skipped_lines,
    })),
  };
  const again = scanAll(sources, cache);
  assert.equal(again.reused, 3);
  // MUTANT: rebuild the cached entry without its gap fields. A damaged
  // transcript then reports its damage once and looks healthy on every
  // render after that.
  assert.equal(
    again.scanned.reduce((n, s) => n + (s.malformed ?? 0), 0),
    first.scanned.reduce((n, s) => n + (s.malformed ?? 0), 0)
  );
});

test('the cache is written by costReport itself, so the served page benefits', () => {
  const tree = makeTree();
  const first = report(tree);
  assert.equal(first.coverage.reused_from_cache, 0);
  // MUTANT: write the sidecar only in the CLI's --json branch. The board
  // server calls costReport per request and refreshes every 30 s, so the
  // cache the docs promise would never be populated for the one consumer it
  // was built for — measured at 1.15 s per request, reuse stuck at zero.
  const second = report(tree);
  assert.ok(second.coverage.reused_from_cache > 0, 'a second read reuses the first');
  assert.deepEqual(second.totals, first.totals);
});

test('a session filter never persists, and --session with --json is refused', () => {
  const tree = makeTree();
  report(tree); // populate the full sidecar
  const full = JSON.parse(readFileSync(join(tree.tyranDir, 'state', 'cost.json'), 'utf8'));
  assert.ok(full.totals.tokens > 0);

  costReport({ tyranDir: tree.tyranDir, projectsRoot: tree.projects, session: 'no-such-session' });
  const after = JSON.parse(readFileSync(join(tree.tyranDir, 'state', 'cost.json'), 'utf8'));
  // MUTANT: persist a filtered run. A repo with real spend then holds a
  // sidecar reading "this cost nothing" while `transcripts_found` asserts the
  // measurement succeeded — the exact "all is well" reading this feature
  // exists to prevent.
  assert.equal(after.totals.tokens, full.totals.tokens);

  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [COST_CLI, '--dir', tree.tyranDir, '--projects', tree.projects, '--session', 'x', '--json'],
        { encoding: 'utf8', stdio: 'pipe' }
      ),
    (err) => err.status === 2
  );
});

test('the probe stops at the match and the byte cap bounds it — mechanism, not wall clock', () => {
  const tree = makeTree({ slugged: false });
  const cwd = resolve(tree.repo);
  const padded = join(tree.project, 'huge.jsonl');
  const filler = JSON.stringify({ type: 'user', cwd, pad: 'x'.repeat(4000) });
  writeFileSync(padded, [JSON.stringify({ type: 'user', cwd }), ...Array(4000).fill(filler)].join('\n') + '\n');

  // MUTANT A: drop the `return false` stop signal. The probe reads every
  // candidate to EOF after it has ALREADY matched — 83 ms on a 200 MB file,
  // paid per file, per request. A wall-clock budget did not catch this (the
  // pre-fix code still came in 25x under it), so count the callbacks.
  let calls = 0;
  forEachLine(padded, () => {
    calls += 1;
    return calls < 1;
  });
  assert.equal(calls, 1, 'a callback returning false must end the read at once');

  // MUTANT B: drop the `maxBytes` cap. A file far larger than the cap must
  // deliver far fewer lines than it holds.
  let capped = 0;
  forEachLine(
    padded,
    () => {
      capped += 1;
      return true;
    },
    { maxBytes: 64 * 1024 }
  );
  assert.ok(capped > 0 && capped < 4000, `capped read delivered ${capped} of 4001 lines`);

  assert.equal(transcriptDirFor(tree.repo, tree.projects), tree.project);
});

test('the byte cap binds the PROBE, not just the primitive it calls', () => {
  // Round-three finding: the previous pin called forEachLine directly, so it
  // proved the primitive honours `maxBytes` while proving nothing about the
  // only caller — and all three of the reviewer's mutants on findTranscriptDir
  // stayed green. This asserts the caller, on the IDENTITY of its result
  // rather than on a stopwatch.
  const tree = makeTree({ slugged: false });
  const cwd = resolve(tree.repo);
  // One candidate directory. Its transcript matches this repo — but only far
  // past the cap, behind 2 MiB of records belonging to somebody else.
  const decoy = join(tree.projects, 'a-decoy');
  mkdirSync(decoy, { recursive: true });
  const filler = JSON.stringify({ type: 'user', cwd: '/some/other/repo', pad: 'y'.repeat(4000) });
  const buried = [];
  let bytes = 0;
  while (bytes < 2 * 1024 * 1024) {
    buried.push(filler);
    bytes += filler.length + 1;
  }
  buried.push(JSON.stringify({ type: 'user', cwd }));
  writeFileSync(join(decoy, 'sess.jsonl'), buried.join('\n') + '\n');
  rmSync(tree.project, { recursive: true, force: true });

  // MUTANT: drop `{ maxBytes: PROBE_BYTES }` from findTranscriptDir's call —
  // byte-for-byte the pre-fix caller. The probe then reads the decoy to EOF,
  // finds the buried match and returns it, restoring the measured 1371 ms
  // miss. With the cap it never reaches that line.
  assert.equal(transcriptDirFor(tree.repo, tree.projects), null);
});

test('a missing transcript directory is never remembered as missing', () => {
  const tree = makeTree({ slugged: false });
  const elsewhere = join(tree.base, 'not-yet');
  assert.equal(transcriptDirFor(tree.repo, elsewhere), null);
  // The board is left open overnight and is routinely started in a repo whose
  // first session has not run. MUTANT: memoise the null too — the Spend
  // section then stays hidden for the life of the server after the
  // transcripts appear, with nothing on the page saying why.
  mkdirSync(elsewhere, { recursive: true });
  const late = join(elsewhere, 'late-project');
  mkdirSync(late, { recursive: true });
  writeFileSync(join(late, 'sess.jsonl'), JSON.stringify({ type: 'user', cwd: resolve(tree.repo) }) + '\n');
  assert.equal(transcriptDirFor(tree.repo, elsewhere), late);
});

test('an abandoned over-long record cannot be billed as a record of its own', () => {
  const tree = makeTree();
  const ghost = join(tree.project, 'oversize.jsonl');
  const cwd = resolve(tree.repo);
  // ONE physical line larger than the 8 MB cap, whose TAIL is a well-formed
  // usage record, then one genuine record.
  const tail = assistant('phantom', usage(0, 0, 0, 777777), 'GHOST', cwd);
  const real = assistant('m-cheap', usage(0, 0, 0, 5), 'r-real', cwd);
  writeFileSync(ghost, 'a'.repeat(9 << 20) + tail + '\n' + real + '\n');

  const scan = scanTranscript(ghost);
  // MUTANT: clear `rest` without resyncing to the next newline. The tail of
  // the discarded record is delivered as its own line, parses, and is
  // BILLED — 777 777 invented tokens against a model that never existed,
  // while the gap counters read clean. This is the inverse of losing spend:
  // the reader manufactures it.
  assert.equal(scan.skippedLines, 1, 'the oversized record is counted as skipped');
  assert.deepEqual(Object.keys(scan.byModel), ['m-cheap'], 'no phantom model');
  assert.equal(scan.byModel['m-cheap'].output, 5);
});

test('a character split across a read boundary is decoded, not mangled', () => {
  const tree = makeTree();
  const wide = join(tree.project, 'wide.jsonl');
  // Push a non-ASCII character across the 1 MiB read boundary.
  const pad = 'a'.repeat((1 << 20) - 1);
  writeFileSync(wide, JSON.stringify({ type: 'user', pad, note: 'zażółć' }) + '\n');
  const seen = [];
  forEachLine(wide, (line) => {
    seen.push(line);
    return true;
  });
  // MUTANT: decode each chunk with buffer.toString('utf8') instead of a
  // StringDecoder. The character splits into replacement characters, and the
  // reachable consequence is the `cwd` equality check in the directory probe:
  // a repo path with a non-ASCII character reports "no transcripts" forever.
  assert.equal(JSON.parse(seen[0]).note, 'zażółć');
  assert.ok(!seen[0].includes('�'));
});

test('--json refuses to print a path to a sidecar it could not write', () => {
  const tree = makeTree();
  // `state` as a FILE rather than a directory: deterministic on every uid,
  // unlike a permission bit, which root ignores. It has to live inside the
  // real fixture repo, or the run fails for the unrelated reason that no
  // transcripts belong to it.
  const broken = tree.tyranDir;
  rmSync(join(broken, 'state'), { recursive: true, force: true });
  writeFileSync(join(broken, 'state'), 'not a directory');
  const result = spawnSync(
    process.execPath,
    [COST_CLI, '--dir', broken, '--projects', tree.projects],
    { encoding: 'utf8' }
  );
  // The report itself still works — a cache that cannot be written is a slow
  // report, not a wrong one.
  assert.equal(result.status, 0, 'the human report does not depend on the cache');

  const json = spawnSync(
    process.execPath,
    [COST_CLI, '--dir', broken, '--projects', tree.projects, '--json'],
    { encoding: 'utf8' }
  );
  // MUTANT: swallow the write failure and print the path anyway. `--json`'s
  // whole contract is "the sidecar exists, here is its path", so an exit 0
  // over a file that was never written turns a permission error into a
  // downstream failure with a healthy-looking upstream.
  assert.equal(json.status, 2, json.stdout);
  assert.match(json.stderr, /could not write the sidecar/);
  assert.equal(json.stdout.trim(), '');
});
