/**
 * One guard, on the SOURCE TEXT of board-html.mjs, in its own file.
 *
 * The whole browser client is a single template literal, so a backtick
 * anywhere inside it — including inside a comment — ends the literal and the
 * module stops loading. `board.test.mjs` already compiles the emitted script
 * and would catch it, but it cannot REPORT it: that file imports the module,
 * so a stray backtick makes the import throw before any test runs, and the
 * whole file fails with "Unexpected identifier 'describe'" — the name of the
 * innocent word that happened to follow.
 *
 * This file therefore reads the source as TEXT and imports nothing from it.
 * Four comments in one sitting quoted an identifier in backticks and cost a
 * debugging round each; the message below is what those rounds were for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('../../scripts/board-html.mjs', import.meta.url));

test('no backtick reaches the client template literal', () => {
  // MUTANT: put a backtick in any comment inside CLIENT_JS.
  const src = readFileSync(SOURCE, 'utf8');
  const marker = 'const CLIENT_JS = ';
  const open = src.indexOf(marker);
  assert.notEqual(open, -1, 'CLIENT_JS is gone — this guard needs rewriting');
  const body = open + marker.length + 1;
  const close = src.indexOf('\n`;', body);
  assert.ok(close > body, 'CLIENT_JS is no longer one template literal — this guard needs rewriting');

  const offenders = src.slice(body, close).split('\n')
    .map((line, i) => `line ${i + 1}: ${line.trim()}`)
    .filter((line) => line.includes('`'));
  assert.deepEqual(
    offenders,
    [],
    'A backtick inside CLIENT_JS ends the template literal and the whole page stops loading. ' +
      'Reword the comment: name identifiers in prose, never in backticks.',
  );
});

/**
 * Two callers share one hint-selecting function: `renderSpend`, which only
 * runs once spend resolved successfully, and the cost-fetch handler, which
 * has to decide what to show on the branch where nothing resolved at all —
 * exactly the branch `renderSpend` never reaches. There is no DOM in this
 * test file (see the header above for why CLIENT_JS cannot be imported), so
 * this pulls `spendResolutionHints` out of the source as TEXT, the same way
 * the guard above does, and evaluates JUST that function with `new Function`
 * — no browser, no `document`, because the function needs neither.
 */
test('spendResolutionHints reports a missing directory even when nothing was found at all', () => {
  const src = readFileSync(SOURCE, 'utf8');
  const marker = 'var spendResolutionHints = function (payload) {';
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, 'spendResolutionHints is gone — this guard needs rewriting');
  const bodyStart = start + 'var spendResolutionHints = '.length; // begins at "function (payload) {"
  const closeMarker = '\n  };\n';
  const closeAt = src.indexOf(closeMarker, bodyStart);
  assert.ok(closeAt > bodyStart, 'the closing brace could not be found — this guard needs rewriting');
  const fnSource = src.slice(bodyStart, closeAt + closeMarker.length - 1); // through the closing "  };"
  const spendResolutionHints = new Function('return ' + fnSource)();

  // MUST-PASS: the exact shape review reproduced live against a real board —
  // every `--transcripts` / `spend.transcript_dirs` entry given, and every
  // one of them missing (the everyday single-typo case). Before this fix the
  // fetch handler's `if (!payload.transcripts_found) return;` fired first and
  // silently, so the Spend tab kept showing the pre-fetch "open this board
  // with board.mjs --serve" hint forever — indistinguishable from a repo that
  // had never been served at all, with nothing on the page about the typo.
  const hits = spendResolutionHints({
    schema: 1,
    transcripts_found: false,
    transcript_dirs: [],
    transcript_dirs_missing: ['/nope'],
  });
  assert.equal(hits.length, 2, 'both the missing-dir hint and the not-found hint must render');
  assert.match(hits[0], /^Given transcript directory not found: \/nope\.$/);
  assert.match(hits[1], /No transcripts found for this repo/);
  assert.match(hits[1], /--transcripts/);
  assert.match(hits[1], /spend\.transcript_dirs/);

  // Several missing dirs pluralise the noun rather than mis-stating one.
  const plural = spendResolutionHints({ transcripts_found: false, transcript_dirs_missing: ['/a', '/b'] });
  assert.match(plural[0], /^Given transcript directories not found: \/a, \/b\.$/);

  // MUTANT this line guards against: unconditionally push the "no transcripts
  // found" line. On a SUCCESSFUL resolution (the shape renderSpend's own call
  // produces) that line would flatly contradict the numbers rendered right
  // next to it, so it must not appear here — only the missing-dir line may.
  const partial = spendResolutionHints({ transcripts_found: true, transcript_dirs_missing: ['/nope'] });
  assert.deepEqual(partial, ['Given transcript directory not found: /nope.']);

  // The everyday healthy case has nothing to say.
  assert.deepEqual(spendResolutionHints({ transcripts_found: true, transcript_dirs_missing: [] }), []);
});
