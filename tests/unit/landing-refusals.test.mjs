/**
 * The landing page quotes two refusals. This checks it still quotes THEM.
 *
 * `site/src/components/landing/Gates.astro` prints the evidence gate's and
 * the retro gate's real refusal text rather than a paraphrase, because a
 * marketing page that summarises its own product's behaviour is how the gap
 * between claim and mechanism opens. Copying the strings closed that gap
 * once, at one moment in time.
 *
 * A copy is a STATE, not a guarantee. Edit a refusal in the gate — to soften
 * it, to add a hint, to fix a typo — and the landing keeps advertising text
 * the product no longer produces, indefinitely, with every test green. The
 * page would be lying about the one thing it exists to demonstrate, and it
 * would be lying in the most credible possible register: a verbatim quote.
 *
 * So the identity is asserted rather than assumed. If this test fails, the
 * fix is to update the page, not to loosen the comparison.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { REFUSALS, DENY } from '../../hooks/scripts/evidence-gate.mjs';
import { buildReason } from '../../hooks/scripts/retro-gate.mjs';

const GATES = fileURLToPath(new URL('../../site/src/components/landing/Gates.astro', import.meta.url));

/**
 * Pull a template literal out of the component source.
 *
 * Deliberately a plain scan rather than a parser: the thing under test is
 * whether two strings are equal, and a parser would be a second place for
 * this check to be subtly wrong. Backtick and backslash escapes are undone
 * because the source is JavaScript and the comparison is against a runtime
 * value.
 */
function templateLiteral(source, name) {
  const open = source.indexOf(`const ${name} = \``);
  assert.notEqual(open, -1, `${name} not found in Gates.astro`);
  const start = open + `const ${name} = \``.length;
  let out = '';
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      const next = source[i + 1];
      out += next === '`' ? '`' : next === '\\' ? '\\' : `\\${next}`;
      i++;
      continue;
    }
    if (c === '`') return out;
    out += c;
  }
  assert.fail(`unterminated template literal for ${name}`);
}

test('the landing page still exists to be checked', () => {
  // Not a skip. This repo's CI asserts zero skipped tests, and a control that
  // quietly disappears with its subject is the failure mode the whole project
  // distrusts. If the section is removed on purpose, remove this test on
  // purpose too.
  assert.ok(existsSync(GATES), `${GATES} is gone — if the gates section was removed deliberately, delete this test in the same change`);
});

test('the evidence refusal on the landing is byte-identical to the gate that emits it', () => {
  const onPage = templateLiteral(readFileSync(GATES, 'utf8'), 'EVIDENCE_REFUSAL');
  assert.equal(onPage, REFUSALS[DENY.NO_EVIDENCE]);
});

test('the retro refusal on the landing is byte-identical to buildReason()', () => {
  // The page fills the two interpolated values with an example initiative,
  // which is exactly what the function's placeholders are for. Rebuilding it
  // from the same values is the only comparison that means anything.
  const onPage = templateLiteral(readFileSync(GATES, 'utf8'), 'RETRO_REFUSAL');
  const example = /initiative "([^"]+)" has all (\d+) of its tickets/.exec(onPage);
  assert.ok(example, 'could not read the example initiative and ticket count off the page');
  assert.equal(onPage, buildReason({ init: example[1], tickets: Number(example[2]) }));
});

test('the quoted evidence refusal would itself be refused if an agent pasted it back', () => {
  // A property of the real refusal, re-asserted here because the landing
  // makes it visible to thousands of readers: the placeholders in it carry no
  // digits, so an agent that cites the refusal as its evidence is refused
  // again rather than let through by its own quotation. If someone "improves"
  // the page copy by filling in example numbers, this reds.
  const onPage = templateLiteral(readFileSync(GATES, 'utf8'), 'EVIDENCE_REFUSAL');
  assert.doesNotMatch(
    onPage,
    /\b\d+\s+(passed|failed|tests?)\b/i,
    'the quoted refusal now contains a digit next to a runner keyword — pasting it back would satisfy the gate',
  );
});
