import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  // exists to hold. Consolidation is a retro step that writes a NEW file.
  const entries = [sized('a', 9000)];
  const before = JSON.stringify(entries);
  auditEntries(entries, { budget: 4000 });
  assert.equal(JSON.stringify(entries), before, 'inputs are untouched');
});

test('the audit does not promise a consolidation step that nobody implements', () => {
  // It did, for as long as the feature has existed: the audit printed
  // "/tyran:retro consolidates, writing a NEW file for review", and both doc
  // surfaces said the same. Grep the skill and the agent — there is no
  // consolidation step in either, and no such file is ever written.
  //
  // A tool that names a downstream step BY NAME is the last place a reader
  // will doubt it, which is what made this survive three surfaces.
  const d = store({ 'a.yaml': [entry()] });
  const r = cli(['audit', '--dir', d]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(
    r.stdout,
    /consolidat/i,
    'the audit must not claim a consolidation step until one exists',
  );
  // What it SHOULD say is what the retro really does to this store.
  assert.match(r.stdout, /never edits/);
});

test('no shipped surface claims consolidation while no code implements it', () => {
  // The claim lived in three places at once, which is why correcting one was
  // never going to be enough. This test fails if any of them grows it back
  // while `scripts/` still has no consolidation.
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const implemented = readdirSync(join(root, 'scripts'))
    .filter((f) => f.endsWith('.mjs'))
    .some((f) => /export function consolidate|'consolidate'/.test(readFileSync(join(root, 'scripts', f), 'utf8')));
  if (implemented) return; // someone built it — the claim is then allowed
  for (const surface of ['docs/self-improvement.md', 'site/src/content/docs/self-improvement.mdx']) {
    const text = readFileSync(join(root, surface), 'utf8');
    const promises = text
      .split('\n')
      .filter((l) => /consolidat/i.test(l) && !/nothing merges|said otherwise|still yours/i.test(l));
    assert.deepEqual(promises, [], `${surface} promises consolidation, which nothing implements`);
  }
});
