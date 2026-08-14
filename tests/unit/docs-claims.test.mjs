/**
 * Numeric claims in the documentation, checked against the thing they claim.
 *
 * Three status lines in `docs/` each froze a test count — 43, 46, 54 — and by
 * the time anyone looked the real numbers were 47, 48 and 76. Nothing was
 * wrong with the code; the documentation had simply drifted away from it
 * while every test stayed green. An audit caught it, which is the expensive
 * way to catch it.
 *
 * A number in prose is a claim with no mechanism behind it, and this
 * repository's whole argument is that such claims decay. So the numbers stay
 * — they are genuinely useful to a reader deciding whether to trust a
 * component — and this file makes them checkable. Drift now fails CI on the
 * day it is introduced rather than on the day someone audits.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * BOTH surfaces that publish the same claims.
 *
 * `docs/*.md` is what GitHub renders; `site/src/content/docs/*.mdx` is what
 * the documentation site renders. They were migrated from each other once and
 * immediately diverged: every correction made to the markdown — a gate listed
 * as registered when it is not, three status headers claiming their own
 * subject was unbuilt, three stale test counts — came back through the MDX,
 * because the migration had copied the older text.
 *
 * Two surfaces for one claim is two places to drift, and the second one drifts
 * silently because nobody re-reads a page they already reviewed. So the guard
 * covers both, and a claim that appears in one is checked in whichever it
 * appears.
 */
const SURFACES = [
  { label: 'docs', dir: join(ROOT, 'docs'), ext: '.md' },
  { label: 'site', dir: join(ROOT, 'site', 'src', 'content', 'docs'), ext: '.mdx' },
];

/**
 * Which test file backs which document's count.
 *
 * Explicit rather than inferred from the filename: `projections.md` is backed
 * by `project.test.mjs`, and a clever mapping would have to encode that
 * anyway. An unmapped document carrying a count is a FAILURE below, not a
 * skip — otherwise a new doc could quietly opt itself out of the check.
 */
const BACKED_BY = Object.freeze({
  'journal.md': 'journal.test.mjs',
  'projections.md': 'project.test.mjs',
  'doctor.md': 'doctor.test.mjs',
});

const CLAIM = /(\d+)\s+unit tests/;

/**
 * The env a nested `node --test` needs in order to say anything at all.
 *
 * Measured: spawned with the parent runner's environment inherited, the child
 * produces ZERO BYTES on stdout — the parent sets `NODE_TEST_CONTEXT`, and a
 * child that sees it reports through a channel this process is not reading.
 * Clearing it (and `NODE_OPTIONS`, which can carry runner flags of its own)
 * restores ordinary TAP output.
 *
 * The failure mode this avoids is worth naming: an empty string parses to no
 * match, and a laxer implementation would have turned that into a count of 0
 * or a silent skip. The assertion below refuses to guess instead.
 */
function childEnv() {
  const env = { ...process.env, NODE_OPTIONS: '' };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function countTests(testFile) {
  // `node --test` exits non-zero if any test fails; we want the COUNT either
  // way, so read the output rather than trusting the exit code.
  let stdout;
  try {
    stdout = execFileSync(process.execPath, ['--test', '--test-reporter=tap', join('tests', 'unit', testFile)], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(),
    });
  } catch (error) {
    stdout = String(error.stdout ?? '');
  }
  const m = /^# tests (\d+)$/m.exec(stdout);
  assert.ok(m, `could not read a test count out of ${testFile} (child produced ${stdout.length} bytes)`);
  return Number(m[1]);
}

/** Every page, on every surface that exists, that states a count. */
const pagesWithClaims = SURFACES.filter((s) => existsSync(s.dir)).flatMap((s) =>
  readdirSync(s.dir)
    .filter((f) => f.endsWith(s.ext))
    .map((f) => ({ surface: s.label, file: f, path: join(s.dir, f), stem: f.replace(s.ext, '') }))
    .filter(({ path }) => CLAIM.test(readFileSync(path, 'utf8'))),
);

test('every page that claims a test count is mapped to the file it claims about', () => {
  // Guards the guard. A page with an unmapped count would otherwise be
  // silently exempt, which is the exact shape of hole this file exists to
  // close — and the MDX surface is where an unmapped page would appear first.
  for (const { surface, file, stem } of pagesWithClaims) {
    assert.ok(BACKED_BY[`${stem}.md`], `${surface}/${file} claims a test count but is not mapped in BACKED_BY`);
  }
  assert.ok(pagesWithClaims.length > 0, 'no page claims a count — did the pattern stop matching?');
});

test('both surfaces are checked when both exist', () => {
  // The whole point. If the site is present and only the markdown gets
  // verified, the MDX drifts unobserved — which is exactly what happened.
  if (!existsSync(SURFACES[1].dir)) return;
  const surfaces = new Set(pagesWithClaims.map((p) => p.surface));
  assert.ok(surfaces.has('site'), 'the site surface exists but no page on it was checked');
  assert.ok(surfaces.has('docs'), 'the docs surface exists but no page on it was checked');
});

for (const { surface, file, path, stem } of pagesWithClaims) {
  const testFile = BACKED_BY[`${stem}.md`];
  if (!testFile) continue; // reported by the mapping test above, not swallowed here
  test(`${surface}/${file} states the real number of tests in ${testFile}`, () => {
    const claimed = Number(CLAIM.exec(readFileSync(path, 'utf8'))[1]);
    const actual = countTests(testFile);
    assert.equal(
      claimed,
      actual,
      `${surface}/${file} says ${claimed} unit tests, ${testFile} has ${actual}. ` +
        'Update it — a number in prose that nothing checks is how the last three drifted, twice.',
    );
  });
}

/**
 * The README's competitor table against the FAQ's, cell by cell.
 *
 * The README carries five rows of the eleven-row comparison in
 * `docs/faq.md`, because a reader deciding whether to install this thing will
 * not click through for it. That is a summary, not a second answer — but only
 * for as long as the five rows still say what the eleven say. A verdict
 * corrected in the FAQ and left alone in the README is the exact shape of
 * every claim this file exists to catch, and the README is the copy people
 * read.
 */
const README_TEXT = readFileSync(join(ROOT, 'README.md'), 'utf8');
const FAQ_TEXT = readFileSync(join(ROOT, 'docs', 'faq.md'), 'utf8');

/** Rows of the first markdown table whose header names another orchestrator. */
function comparisonRows(text) {
  const lines = text.split('\n');
  const head = lines.findIndex((l) => l.includes('| oh-my-claudecode |'));
  if (head === -1) return null;
  const rows = new Map();
  for (const line of lines.slice(head + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    // The label carries the emphasis and the wording; the verdicts are what a
    // reader compares, so those are what get pinned.
    rows.set(cells[0], cells.slice(1));
  }
  return rows;
}

test('every competitor verdict in the README matches the FAQ it summarises', () => {
  const readme = comparisonRows(README_TEXT);
  const faq = comparisonRows(FAQ_TEXT);
  assert.ok(readme, 'the README no longer carries a named-competitor table');
  assert.ok(faq, 'docs/faq.md no longer carries a named-competitor table');
  assert.ok(readme.size >= 1 && readme.size < faq.size, 'the README should carry a SUBSET of the FAQ rows');

  for (const [label, verdicts] of readme) {
    assert.ok(faq.has(label), `the README row "${label}" has no counterpart in docs/faq.md`);
    assert.deepEqual(
      verdicts,
      faq.get(label),
      `"${label}" reads differently in the README than in docs/faq.md. The FAQ is the ` +
        'measured one; whichever moved, the other has to follow.',
    );
  }
});
