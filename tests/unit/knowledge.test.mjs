import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadEntries,
  entryMatches,
  selectEntries,
  renderBrief,
  knowledgeFiles,
  auditEntries,
  retirementReport,
  supersededSet,
  DEFAULT_BUDGET,
} from '../../scripts/knowledge.mjs';

const KNOWLEDGE = fileURLToPath(new URL('../../scripts/knowledge.mjs', import.meta.url));

// --------------------------------------------------------------- fixtures

function dir() {
  return mkdtempSync(join(tmpdir(), 'tyran-knowledge-'));
}

const entry = (over = {}) => ({
  id: 'K-1',
  kind: 'gotcha',
  text: 'the suite takes 9 minutes; do not run it per file',
  confidence: 0.8,
  provenance: [{ source: 'initiative:a', reference: 'run 1' }],
  ...over,
});

function yamlFor(entries) {
  const lines = ['entries:'];
  for (const e of entries) {
    lines.push(`  - id: ${e.id}`);
    lines.push(`    kind: ${e.kind}`);
    lines.push(`    text: '${e.text}'`);
    lines.push(`    confidence: ${e.confidence}`);
    lines.push('    provenance:');
    for (const p of e.provenance) {
      lines.push(`      - source: '${p.source}'`);
      lines.push(`        reference: '${p.reference}'`);
    }
    if (e.applies_to) {
      lines.push('    applies_to:');
      for (const g of e.applies_to) lines.push(`      - '${g}'`);
    }
    for (const counter of ['used', 'helpful', 'outdated_reports']) {
      if (counter in e) lines.push(`    ${counter}: ${e[counter]}`);
    }
    // Both spellings, because the CLI must be exercised through each: a
    // scalar is what every entry written before the list form carries.
    if (typeof e.supersedes === 'string') {
      lines.push(`    supersedes: ${e.supersedes}`);
    } else if (Array.isArray(e.supersedes)) {
      lines.push('    supersedes:');
      for (const id of e.supersedes) lines.push(`      - ${id}`);
    }
  }
  return lines.join('\n') + '\n';
}

function store(entriesByFile) {
  const d = dir();
  for (const [name, entries] of Object.entries(entriesByFile)) {
    writeFileSync(join(d, name), yamlFor(entries));
  }
  return d;
}

function cli(args) {
  try {
    const stdout = execFileSync(process.execPath, [KNOWLEDGE, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// --------------------------------------------------------------- selection

test('an applies_to glob selects the entry for a matching path and not otherwise', () => {
  const e = entry({ applies_to: ['src/lib/**'] });
  assert.equal(entryMatches(e, ['src/lib/feed/page.ts']), true);
  assert.equal(entryMatches(e, ['docs/readme.md']), false);
});

test('matching is symmetric: a glob-shaped input intersects a concrete applies_to', () => {
  // files_predicted often carries globs; the entry side may be concrete.
  const concrete = entry({ applies_to: ['src/lib/feed/pagination.ts'] });
  assert.equal(entryMatches(concrete, ['src/lib/**']), true);
  const glob = entry({ applies_to: ['src/lib/**'] });
  assert.equal(entryMatches(glob, ['src/lib/feed/**']), true);
});

test('an entry with no applies_to is repo-global — it matches any path set', () => {
  assert.equal(entryMatches(entry(), ['whatever/x.ts']), true);
  assert.equal(entryMatches(entry({ applies_to: [] }), ['whatever/x.ts']), true);
});

test('with zero paths, only global entries are selected', () => {
  const entries = [entry({ id: 'K-G' }), entry({ id: 'K-S', applies_to: ['src/**'] })];
  const { selected, matched } = selectEntries(entries, { paths: [] });
  assert.deepEqual(selected.map((e) => e.id), ['K-G']);
  assert.equal(matched, 1);
});

test('kinds filter narrows selection and rank is confidence desc then file order', () => {
  const entries = [
    entry({ id: 'K-1', kind: 'fact', confidence: 0.5 }),
    entry({ id: 'K-2', kind: 'gotcha', confidence: 0.9 }),
    entry({ id: 'K-3', kind: 'gotcha', confidence: 0.9 }),
    entry({ id: 'K-4', kind: 'gotcha', confidence: 0.7 }),
  ];
  const { selected } = selectEntries(entries, { paths: ['x.ts'] });
  assert.deepEqual(selected.map((e) => e.id), ['K-2', 'K-3', 'K-4', 'K-1'], 'ties keep file order');
  const gotchas = selectEntries(entries, { paths: ['x.ts'], kinds: ['gotcha'] });
  assert.deepEqual(gotchas.selected.map((e) => e.id), ['K-2', 'K-3', 'K-4']);
});

test('the same store and paths produce the same brief, byte for byte', () => {
  const d = store({ 'b.yaml': [entry({ id: 'K-B' })], 'a.yaml': [entry({ id: 'K-A' })] });
  const one = cli(['brief', 'x.ts', '--dir', d]).stdout;
  const two = cli(['brief', 'x.ts', '--dir', d]).stdout;
  assert.equal(one, two);
  // files are read in sorted order, so a.yaml's entry ranks first on the tie
  assert.ok(one.indexOf('K-A') < one.indexOf('K-B'));
});

// ------------------------------------------------------------------ budget

test('a budget cut always ends with an explicit omission line naming the budget', () => {
  const entries = Array.from({ length: 5 }, (_, i) => entry({ id: `K-${i + 1}` }));
  const brief = renderBrief(entries, 5, { budget: 150 });
  assert.match(brief, /omitted \(4 by the 150-codepoint budget\)/);
  assert.match(brief, /raise --budget/);
  assert.match(brief, /1 of 5 entries/);
});

test('the first entry is kept even when it alone exceeds the budget', () => {
  const big = entry({ id: 'K-BIG', text: 'z'.repeat(500) });
  const brief = renderBrief([big], 1, { budget: 100 });
  assert.match(brief, /K-BIG/, 'a brief that omits everything explains nothing');
});

test('a --limit cut names --limit, not the budget that did no cutting', () => {
  const entries = Array.from({ length: 4 }, (_, i) => entry({ id: `K-${i + 1}` }));
  const { selected, matched, limited } = selectEntries(entries, { paths: ['x.ts'], limit: 2 });
  assert.equal(limited, 2);
  const brief = renderBrief(selected, matched, { budget: DEFAULT_BUDGET, limited });
  assert.match(brief, /2 of 4 entries/);
  assert.match(brief, /omitted \(2 by --limit\)/);
  assert.match(brief, /raise --limit/);
  assert.doesNotMatch(brief, /raise --budget/, 'the budget did not do this cutting');
});

test('the budget is charged in codepoints — the unit the oversize warning predicts', () => {
  // 120 astral codepoints are 240 UTF-16 units; a budget of 200 must KEEP an
  // entry whose codepoint cost fits, or the warning threshold and the budget
  // measure two different things.
  const astral = entry({ id: 'K-A', text: '\u{1D400}'.repeat(100) });
  const brief = renderBrief([astral], 1, { budget: 200 });
  assert.match(brief, /K-A/);
  assert.match(brief, /1 of 1 entry/);
});

test('no matches is an explicit statement, never empty output', () => {
  const brief = renderBrief([], 0, {});
  assert.match(brief, /no matching entries/);
  assert.notEqual(brief.trim(), '');
});

// ------------------------------------------------------------------ safety

test('invisible codepoints in entry text never reach stdout raw', () => {
  const zwsp = String.fromCodePoint(0x200b);
  const d = store({ 'k.yaml': [entry({ text: `before${zwsp}after` })] });
  const { code, stdout } = cli(['brief', 'x.ts', '--dir', d]);
  assert.equal(code, 0);
  assert.ok(!stdout.includes(zwsp), 'raw ZWSP reached the brief');
  assert.match(stdout, /before/);
});

test('an invalid knowledge file is a LOUD exit 1 naming the file, never a silent skip', () => {
  const d = store({ 'good.yaml': [entry()] });
  writeFileSync(join(d, 'bad.yaml'), 'entries:\n  - id: X\n');
  const { code, stdout, stderr } = cli(['brief', 'x.ts', '--dir', d]);
  assert.equal(code, 1);
  assert.match(stderr, /bad\.yaml/);
  assert.match(stderr, /refusing to brief/);
  assert.ok(!stdout.includes('K-1'), 'no partial brief was printed');
});

test('loadEntries reports invalid files and still returns the valid ones', () => {
  const d = store({ 'good.yaml': [entry()] });
  writeFileSync(join(d, 'bad.yaml'), 'entries:\n  - id: X\n');
  const { entries, invalid } = loadEntries(d);
  assert.equal(entries.length, 1);
  assert.equal(invalid.length, 1);
  assert.match(invalid[0].file, /bad\.yaml/);
});

test('only .yaml/.yml files are read, in sorted order', () => {
  const d = store({ 'b.yaml': [entry({ id: 'K-B' })], 'a.yml': [entry({ id: 'K-A' })] });
  writeFileSync(join(d, 'README.md'), 'not yaml');
  assert.deepEqual(
    knowledgeFiles(d).map((f) => f.split('/').pop()),
    ['a.yml', 'b.yaml'],
  );
});

// --------------------------------------------------------------------- CLI

test('a missing knowledge directory is explicit and exit 0 — absence is not an error', () => {
  const { code, stdout } = cli(['brief', 'x.ts', '--dir', join(dir(), 'nope')]);
  assert.equal(code, 0);
  assert.match(stdout, /no knowledge directory/);
});

test('--json round-trips the selected entries', () => {
  const d = store({ 'k.yaml': [entry({ applies_to: ['src/**'] })] });
  const { code, stdout } = cli(['brief', 'src/a.ts', '--dir', d, '--json']);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].id, 'K-1');
  assert.deepEqual(payload[0].applies_to, ['src/**']);
});

test('usage errors are exit 2: unknown flag, unknown kind, bad numbers, no subcommand', () => {
  const d = store({ 'k.yaml': [entry()] });
  assert.equal(cli(['brief', 'x', '--dir', d, '--frobnicate']).code, 2);
  assert.equal(cli(['brief', 'x', '--dir', d, '--kinds', 'vibes']).code, 2);
  assert.equal(cli(['brief', 'x', '--dir', d, '--budget', 'many']).code, 2);
  assert.equal(cli(['brief', 'x', '--dir', d, '--limit', '-3']).code, 2);
  assert.equal(cli([]).code, 2);
  assert.match(cli(['brief', 'x', '--dir', d, '--kinds', 'vibes']).stderr, /fact \| convention \| gotcha/);
});

test('a value flag never eats a following flag — --dir --json is a usage error, not an empty brief', () => {
  const r = cli(['brief', 'x', '--dir', '--json']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--dir needs a value/);
});

test('--dir naming a FILE is exit 2 — an empty brief must not claim the store was consulted', () => {
  const d = store({ 'k.yaml': [entry()] });
  const r = cli(['brief', 'x', '--dir', join(d, 'k.yaml')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not a directory/);
});

// --- is the store readable AS A WHOLE? ----------------------------------

const sized = (id, chars, confidence = 0.9) => ({
  id, kind: 'gotcha', confidence, text: 'x'.repeat(chars), applies_to: ['**'], file: 'k.yaml',
});

test('the audit reports how many entries can reach ONE brief', () => {
  // The per-entry oversize warning fires once per fat entry and each reads as
  // a small local untidiness. Measured on a real install it fired five times
  // while `brief` was returning 1 of 31 entries — 104,178 codepoints reaching
  // nobody. MUTANT: report only the count of oversized entries; the ratio is
  // the number that gets acted on and the per-entry note never added up to it.
  const report = auditEntries([sized('a', 1500), sized('b', 1500), sized('c', 1500)], { budget: 4000 });
  assert.equal(report.entries, 3);
  assert.equal(report.reachable, 2, 'two fit the budget; the third does not');
  assert.equal(report.unreachable, 1);
});

test('an entry too big to appear ALONE is called out separately', () => {
  // The diagnostic that matters most: this entry is not competing for space,
  // it is unreachable under any budget a caller passes. MUTANT: fold it into
  // the plain unreachable count and the remedy becomes "raise the budget",
  // which cannot work.
  const report = auditEntries([sized('small', 100), sized('huge', 9000)], { budget: 4000 });
  assert.deepEqual(report.aloneTooBig.map((e) => e.id), ['huge']);
  assert.ok(report.aloneTooBig[0].cost > 4000);
});

test('a store that fits reports nothing unreachable', () => {
  // Pressure that is being obeyed is not a finding — a check red on every
  // healthy repo is one people learn to skip.
  const report = auditEntries([sized('a', 100), sized('b', 100)], { budget: 4000 });
  assert.equal(report.unreachable, 0);
  assert.deepEqual(report.aloneTooBig, []);
});

test('reachability is counted the way brief actually ranks', () => {
  // MUTANT: count in file order. `brief` ranks by confidence, so an audit that
  // counted differently would report a reachability no brief ever delivers.
  const report = auditEntries([sized('low', 3000, 0.1), sized('high', 3000, 0.99)], { budget: 4000 });
  assert.equal(report.reachable, 1);
  assert.equal(report.widest.length, 2, 'both are still measured and listed');
});

test('the audit never edits — it returns a measurement', () => {
  // Which of two overlapping entries is the true one is a judgement, and a
  // script that guessed would delete exactly the hard-won detail the store
  // exists to hold. Consolidation is a retro judgement, performed by
  // APPENDING an entry whose `supersedes:` names the ones it replaces.
  const entries = [sized('a', 9000)];
  const before = JSON.stringify(entries);
  auditEntries(entries, { budget: 4000 });
  assert.equal(JSON.stringify(entries), before, 'inputs are untouched');
});

test('if the audit names a mechanism, the mechanism runs', () => {
  // RETUNED, NOT REMOVED. Until 0.1.35 this asserted the audit contained no
  // /consolidat/i at all, because the audit printed "/tyran:retro
  // consolidates, writing a NEW file for review" and no such step existed on
  // any surface. A tool that names a downstream step BY NAME is the last
  // place a reader will doubt it, which is what made that survive three
  // surfaces at once.
  //
  // The ban was a proxy for the property that actually matters, and the
  // proxy expires the moment the step is built. So this now asserts the
  // property directly: the audit may describe consolidation only while a
  // brief genuinely stops delivering a superseded entry. Weakening
  // `selectEntries` fails this test through the CLI, not through a grep.
  const d = store({
    'a.yaml': [entry({ id: 'K-1' }), entry({ id: 'K-2', text: 'the merged statement' })],
    'merged.yaml': [entry({ id: 'K-9', text: 'says both better', supersedes: ['K-1', 'K-2'] })],
  });
  const r = cli(['audit', '--dir', d]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /consolidat/i, 'the audit should now describe the mechanism it has');
  // Still true, and still the point: the script measures and never writes.
  assert.match(r.stdout, /never edits/);
  // The claim, executed. This is what the old ban was standing in for.
  const brief = cli(['brief', '**', '--dir', d]);
  assert.equal(brief.code, 0);
  assert.doesNotMatch(brief.stdout, /\[K-1\]/, 'a superseded entry still reached a brief');
  assert.doesNotMatch(brief.stdout, /\[K-2\]/, 'a superseded entry still reached a brief');
  assert.match(brief.stdout, /\[K-9\]/);
});

test('both self-improvement surfaces describe consolidation in identical words', () => {
  // RETUNED, NOT REMOVED. This used to ban consolidation prose on either
  // surface unless some scripts/*.mjs matched /export function consolidate/.
  // That predicate had an escape hatch by design — but letting it early-
  // return once the feature exists would trade a real guard for none, and
  // the original defect was never "the claim exists". It was that the SAME
  // claim lived in three places and drifted, so correcting one was never
  // going to be enough.
  //
  // So the guard becomes the house rule it was always protecting: the two
  // surfaces must agree line for line. That catches the next divergence,
  // which is the failure that actually recurs here.
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const linesOf = (surface) =>
    readFileSync(join(root, surface), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /consolidat|supersede/i.test(l));
  const md = linesOf('docs/self-improvement.md');
  const mdx = linesOf('site/src/content/docs/self-improvement.mdx');
  assert.ok(md.length > 0, 'the doc surface says nothing about the shipped mechanism');
  assert.deepEqual(mdx, md, 'the two self-improvement surfaces have drifted');
});

// ------------------------------------------------------- supersedes / merge

test('a superseded entry is dropped from every brief', () => {
  const entries = [entry({ id: 'K-1' }), entry({ id: 'K-9', supersedes: 'K-1' })];
  const { selected } = selectEntries(entries, {});
  assert.deepEqual(selected.map((e) => e.id), ['K-9']);
});

test('suppression is store-wide, not scoped to the query', () => {
  // MUTANT: build the superseded set AFTER the path filter. The superseder
  // below is scoped to docs/**, so a brief about src/** would not see it —
  // and the entry it retired would rise from the dead on that brief only.
  // The store would then disagree with itself about what is retired,
  // depending on what was asked, which is the worst possible shape for a
  // fact an agent is about to act on.
  const entries = [
    entry({ id: 'K-1', applies_to: ['src/**'] }),
    entry({ id: 'K-9', applies_to: ['docs/**'], supersedes: 'K-1' }),
  ];
  const { selected } = selectEntries(entries, { paths: ['src/lib/a.ts'] });
  assert.deepEqual(selected.map((e) => e.id), [], 'a narrowly-scoped superseder still retires globally');
});

test('one entry retires several — a merge is many-to-one', () => {
  // MUTANT: honour only the first id of the list. Two of the three entries
  // this merge replaced would stay live and keep competing for the budget,
  // so the store would grow by one and shrink by one.
  const entries = [
    entry({ id: 'K-1' }), entry({ id: 'K-2' }), entry({ id: 'K-3' }),
    entry({ id: 'K-9', supersedes: ['K-1', 'K-2', 'K-3'] }),
  ];
  const { selected } = selectEntries(entries, {});
  assert.deepEqual(selected.map((e) => e.id), ['K-9']);
});

test('a chain resolves in one flat pass', () => {
  // MUTANT: resolve one level only. C replaced B which replaced A; if A came
  // back, a brief would carry the oldest statement of a fact alongside its
  // newest, with no way for the reader to tell which superseded which.
  const entries = [
    entry({ id: 'K-a' }),
    entry({ id: 'K-b', supersedes: 'K-a' }),
    entry({ id: 'K-c', supersedes: 'K-b' }),
  ];
  assert.deepEqual(supersededSet(entries), new Set(['K-a', 'K-b']));
  const { selected } = selectEntries(entries, {});
  assert.deepEqual(selected.map((e) => e.id), ['K-c']);
});

test('a superseded entry keeps its bytes, its counters and its place on disk', () => {
  // THE constraint this whole design exists to satisfy: entries carry
  // counters earned over months, and a bad merge must not destroy that
  // history. Retirement is suppression at READ time — nothing rewrites the
  // file that holds the retired entry.
  const d = store({
    'a.yaml': [entry({ id: 'K-1', used: 7, helpful: 4 })],
    'merged.yaml': [entry({ id: 'K-9', text: 'says it better', supersedes: ['K-1'] })],
  });
  const before = readFileSync(join(d, 'a.yaml'), 'utf8');
  assert.equal(cli(['brief', '**', '--dir', d]).code, 0);
  assert.equal(readFileSync(join(d, 'a.yaml'), 'utf8'), before, 'the retired entry was rewritten');
  assert.match(before, /used: 7/);
  // still LOADED — it is retired from delivery, not deleted from the store
  const { entries } = loadEntries(d);
  assert.deepEqual(entries.map((e) => e.id).sort(), ['K-1', 'K-9']);
});

test('deleting the merged file brings every superseded entry back, counters intact', () => {
  // The undo property, executed. This is what makes a bad merge cost one
  // `git rm` rather than a history — and it is why no conservation checking
  // is needed: nothing was consumed to produce the merge.
  const d = store({
    'a.yaml': [entry({ id: 'K-1', used: 7 }), entry({ id: 'K-2', text: 'second' })],
    'merged.yaml': [entry({ id: 'K-9', text: 'both at once', supersedes: ['K-1', 'K-2'] })],
  });
  const merged = cli(['brief', '**', '--dir', d]).stdout;
  assert.match(merged, /\[K-9\]/);
  assert.doesNotMatch(merged, /\[K-1\]/);
  rmSync(join(d, 'merged.yaml'));
  const restored = cli(['brief', '**', '--dir', d]);
  assert.match(restored.stdout, /\[K-1\]/);
  assert.match(restored.stdout, /\[K-2\]/);
  assert.match(readFileSync(join(d, 'a.yaml'), 'utf8'), /used: 7/);
});

test('the audit measures the budget over LIVE entries while still counting the store', () => {
  // MUTANT A: charge the budget for superseded entries. Reachability would
  // then under-report at exactly the moment consolidation began to work,
  // which is the number `doctor --state` prints.
  // MUTANT B: let `entries` shrink to the live count. The operator's number
  // would stop matching the files on disk, and retired entries would read as
  // entries that went missing.
  const report = auditEntries([
    sized('a', 3000), sized('b', 3000), { ...sized('c', 100), supersedes: ['a', 'b'] },
  ], { budget: 4000 });
  assert.equal(report.entries, 3, 'the on-disk count must survive');
  assert.equal(report.live, 1);
  assert.equal(report.superseded, 2);
  assert.equal(report.reachable, 1);
  assert.equal(report.unreachable, 0, 'nothing live is crowded out any more');
  assert.ok(report.supersededCost > 6000, 'the reclaimable cost is named');
});

test('a supersedes naming an id nowhere in the store is reported, not silently ignored', () => {
  // The one mechanical way this design fails. A typo means the intended
  // retirement did not happen: the old entry keeps competing AND the new one
  // adds to the total, so the store grows by exactly the merge that was
  // supposed to shrink it. Silent, and in the direction of growth.
  const report = auditEntries([entry({ id: 'K-9', supersedes: ['K-1', 'K-404'] }), entry({ id: 'K-1' })]);
  assert.deepEqual(report.danglingSupersedes, [{ id: 'K-9', missing: 'K-404' }]);
});

test('a mutually superseding pair is named, because it hides BOTH entries', () => {
  // Neither supersedes itself, so the validator passes it; the flat set then
  // hides each of them, emptying two facts out of every brief at once.
  const report = auditEntries([
    entry({ id: 'K-1', supersedes: 'K-2' }),
    entry({ id: 'K-2', supersedes: 'K-1' }),
  ]);
  assert.deepEqual(report.mutualSupersedes, [{ a: 'K-1', b: 'K-2' }]);
  assert.equal(report.live, 0);
});

// -------------------------------------------------- retirement on counters

test('retirement candidates come from the counters, not from taste', () => {
  const r = retirementReport(
    [entry({ id: 'K-1', used: 5, helpful: 0 }), entry({ id: 'K-2', used: 5, helpful: 1 })],
    [entry({ id: 'K-1', used: 5, helpful: 0 }), entry({ id: 'K-2', used: 5, helpful: 1 })],
  );
  assert.equal(r.counterEvidence, true);
  assert.deepEqual(r.retirementCandidates.map((c) => c.id), ['K-1']);
  assert.equal(r.retirementCandidates[0].reason, 'never-helpful');
});

test('an entry delivered once and not yet helpful is NOT a candidate', () => {
  // MUTANT: flag `helpful === 0` regardless of `used`. Never having been
  // delivered is not evidence of uselessness — it is absence of evidence,
  // and flagging it would retire brand-new entries on their own newness.
  // This assertion is the semantic core of the whole finding class.
  const one = [entry({ id: 'K-1', used: 1, helpful: 0 }), entry({ id: 'K-x', used: 9, helpful: 2 })];
  const r = retirementReport(one, one);
  assert.deepEqual(r.retirementCandidates.map((c) => c.id), []);
});

test('reported-wrong outranks the delivery threshold', () => {
  const e = [entry({ id: 'K-1', used: 1, helpful: 0, outdated_reports: 2 })];
  const r = retirementReport(e, e);
  assert.deepEqual(r.retirementCandidates.map((c) => c.reason), ['reported-wrong']);
});

test('a store with no counter evidence reports the FOLD, and flags nothing', () => {
  // The degenerate case, and the most useful thing this can say. The
  // counters are maintained only by a model hand-editing YAML at retro
  // close; if that fold never runs, every entry reads helpful: 0 and the
  // never-helpful rule would flag the ENTIRE store — confidently, and on no
  // evidence at all. MUTANT: skip this branch and trust the counters.
  const bare = [entry({ id: 'K-1' }), entry({ id: 'K-2' })];
  const r = retirementReport(bare, bare);
  assert.equal(r.counterEvidence, false);
  assert.deepEqual(r.retirementCandidates, []);
  const d = store({ 'a.yaml': bare });
  assert.match(cli(['audit', '--dir', d]).stdout, /the fold at retro close is not happening/);
});

test('evidence is asked of the whole store, so merging a counted entry away does not fake the fold', () => {
  // MUTANT: scope the evidence check to live entries. Consolidating the one
  // counter-bearing entry would flip the report to "the fold is not
  // happening" — a strong claim, and false: the fold plainly did happen.
  // Found by running the real CLI, not by reading the code.
  const entries = [
    entry({ id: 'K-1', used: 5, helpful: 2 }),
    entry({ id: 'K-9', text: 'replaces it', supersedes: ['K-1'] }),
  ];
  const report = auditEntries(entries);
  assert.equal(report.counterEvidence, true);
  assert.deepEqual(report.retirementCandidates, [], 'a retired entry is not also a retirement candidate');
});

// ------------------------------------------------------ store-wide ids

test('the same id in two files is a loud refusal naming both', () => {
  // The validator allocates its `seen` set per DOCUMENT and runs per file,
  // so only the loop that assembles the store can catch this. It matters
  // more now than it did: `supersedes` names an id, and an ambiguous one
  // retires whichever entry the loop happened to reach first.
  const d = store({ 'a.yaml': [entry({ id: 'K-1' })], 'b.yaml': [entry({ id: 'K-1', text: 'other' })] });
  const r = cli(['brief', '**', '--dir', d]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /duplicate id "K-1"/);
  assert.match(r.stderr, /a\.yaml/, 'the refusal must name the file it collides with');
  assert.match(r.stderr, /b\.yaml/);
});
