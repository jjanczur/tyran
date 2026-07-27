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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOCS = join(ROOT, 'docs');

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

const docsWithClaims = readdirSync(DOCS)
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({ file: f, text: readFileSync(join(DOCS, f), 'utf8') }))
  .filter(({ text }) => CLAIM.test(text));

test('every document that claims a test count is mapped to the file it claims about', () => {
  // Guards the guard. A new doc with an unmapped count would otherwise be
  // silently exempt, which is the exact shape of hole this file exists to
  // close.
  for (const { file } of docsWithClaims) {
    assert.ok(BACKED_BY[file], `docs/${file} claims a test count but is not mapped in BACKED_BY`);
  }
  assert.ok(docsWithClaims.length > 0, 'no document claims a count — did the pattern stop matching?');
});

for (const [doc, testFile] of Object.entries(BACKED_BY)) {
  test(`docs/${doc} states the real number of tests in ${testFile}`, () => {
    const text = readFileSync(join(DOCS, doc), 'utf8');
    const claimed = Number(CLAIM.exec(text)[1]);
    const actual = countTests(testFile);
    assert.equal(
      claimed,
      actual,
      `docs/${doc} says ${claimed} unit tests, ${testFile} has ${actual}. ` +
        'Update the document — a number in prose that nothing checks is how the last three drifted.',
    );
  });
}
