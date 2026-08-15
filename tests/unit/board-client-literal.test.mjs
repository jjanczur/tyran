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
