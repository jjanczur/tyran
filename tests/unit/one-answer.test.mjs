import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  invisibleProblem,
  whitespaceProblem,
  identifierProblem,
  FORBIDDEN,
  DELIBERATELY_ALLOWED,
} from '../../scripts/invisible.mjs';
import { scanText, scanPath } from '../../scripts/scan-control-chars.mjs';
import { agentNameProblem, pairSpawns } from '../../scripts/journal.mjs';
import { inline, fold, warnings, renderProjections, STATE_FILE } from '../../scripts/project.mjs';

/**
 * The control this story exists to satisfy: do all three layers give the SAME
 * ANSWER to "is this codepoint invisible?" — measured over every codepoint,
 * not over a sample and not over the BMP only.
 *
 * This is the definition of done that cannot be passed by accident, in
 * contrast to "the tests still pass" (ADR-20 applied at the level of
 * architecture, ADR-21). Before the unification it failed on 456 codepoints in
 * 37 ranges, the largest of them the TAG block: the CI scanner blocked all 128
 * TAG characters and `inline()`, the layer that guards the document an AGENT
 * reads, passed all 128 through.
 *
 * The layers are driven through their PUBLIC surface — scanText,
 * agentNameProblem, inline — never through the shared module they now call.
 * A test that asked the shared module three times would be green over any
 * wiring mistake, which is the failure mode ADR-20 names.
 */

/** EVERY forbidden character here is built, never typed. */
const cp = (...points) => String.fromCodePoint(...points);

/** The one verdict `agentNameProblem` gives to the invisibility question. */
const INVISIBLE_VERDICT = 'must not contain control or invisible formatting characters';

test('the journal states the invisibility verdict in exactly one way', () => {
  // The sweep below compares against this string. If the message changed and
  // the sweep silently stopped matching, the journal layer would read as
  // "answers no to everything" and the whole conformance test would pass over
  // a layer that had dropped out. Pin it where a reader can see it.
  assert.equal(agentNameProblem(`a${cp(0x200b)}b`), INVISIBLE_VERDICT);
  assert.equal(agentNameProblem(`a${cp(0xe0041)}b`), INVISIBLE_VERDICT);
  assert.equal(agentNameProblem('ordinary-name'), null);
  // ...and the disjoint identifier rule has its OWN verdict, not this one.
  assert.equal(agentNameProblem(`a${cp(0x09)}b`), 'must not contain a tab or a newline');
});

/**
 * The one place where a layer legitimately differs, named and pinned rather
 * than tolerated: `inline()` COLLAPSES Unicode whitespace to a single space as
 * a separate normalization, so those codepoints vanish from a cell without the
 * invisibility rule having anything to say about them. TAB and LF are also
 * rejected inside an IDENTIFIER by the disjoint `whitespaceProblem` rule.
 *
 * The list is asserted to be exactly what it claims to be below, so it cannot
 * become a place to hide a real disagreement.
 */
const COLLAPSED_WHITESPACE = [
  0x09, 0x0a, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
].sort((a, b) => a - b);

test('the whitespace exception list is exactly whitespace, and nothing invisible hides in it', () => {
  for (const point of COLLAPSED_WHITESPACE) {
    assert.match(cp(point), /^\s$/u, `${point.toString(16)} is not JS whitespace`);
    assert.equal(
      invisibleProblem(point),
      null,
      `U+${point.toString(16).toUpperCase()} is INVISIBLE — it must not sit on the whitespace exception list`,
    );
  }
});

test('the invisibility rule and the identifier whitespace rule are disjoint', () => {
  // Two rules, not two configurations of one rule (ADR-21). If they ever
  // overlap, "identifier" has quietly become an option on the invisibility
  // answer, and the second semantics is back.
  for (let point = 0; point <= 0x10ffff; point++) {
    if (point >= 0xd800 && point <= 0xdfff) continue;
    if (invisibleProblem(point) !== null && whitespaceProblem(point) !== null) {
      assert.fail(`U+${point.toString(16).toUpperCase()} is answered by BOTH rules`);
    }
  }
  assert.equal(whitespaceProblem(0x09), 'control character in a name or path');
  assert.equal(whitespaceProblem(0x0a), 'control character in a name or path');
  assert.equal(whitespaceProblem(0x0d), null, 'CR is invisible, not identifier-whitespace');
});

test('ALL THREE layers give the same answer for every codepoint in Unicode', () => {
  const exception = new Set(COLLAPSED_WHITESPACE);
  const disagreements = [];
  let examined = 0;

  for (let point = 0; point <= 0x10ffff; point++) {
    if (point >= 0xd800 && point <= 0xdfff) continue; // lone surrogates are not codepoints
    examined++;
    const ch = cp(point);
    const truth = invisibleProblem(point) !== null;

    // Layer 1 — the CI scanner over file contents.
    const scanner = scanText(ch).length > 0;

    // Layer 2 — the journal's agent-name validation. Compared against the ONE
    // verdict that answers this question; `agentNameProblem` also rejects
    // names for NFC, for surrounding whitespace and for tabs/newlines, and
    // none of those is a claim that the character is invisible. Matching the
    // message exactly, rather than excluding patterns, means a renamed verdict
    // fails this test instead of quietly widening it.
    const journal = agentNameProblem(`a${ch}b`) === INVISIBLE_VERDICT;

    // Layer 3 — the projection sanitizer that guards STATE.md. Measured by
    // whether the character is REMOVED, not by whether the output changed:
    // HTML-escaping a visible "<" is a different act from deleting something
    // nobody can see, and conflating them would let escaping pose as defence.
    const projection = exception.has(point) ? truth : inline(`a${ch}b`) === 'a b';

    if (scanner !== truth || journal !== truth || projection !== truth) {
      disagreements.push(
        `U+${point.toString(16).toUpperCase().padStart(4, '0')} invisible=${truth} ` +
          `scanner=${scanner} journal=${journal} projection=${projection}`,
      );
    }
  }

  assert.equal(examined, 1112064, 'the sweep must cover every codepoint, astral planes included');
  assert.deepEqual(
    disagreements.slice(0, 40),
    [],
    `${disagreements.length} codepoint(s) where the layers disagree — the rule has more than one spelling again`,
  );
});

test('every COMPOSITION of the two rules gives the same answer too', () => {
  // Round 2, raised as a gap in the previous report and correctly refused as
  // "accept it and move on": the two rules are composed in three places, and
  // three compositions of one pair is exactly how a fourth spelling gets in
  // through the back door — the defect this whole story removes.
  //
  //   1. invisible.identifierProblem   — invisibleProblem ?? whitespaceProblem
  //   2. scan-control-chars.scanPath   — file NAMEs and symlink TARGETs
  //   3. journal.agentNameProblem      — two separate loops, two messages
  //
  // Driven through the PUBLIC surface of each, so a composition that starts
  // disagreeing fails here rather than in a security review.
  //
  // `agentNameProblem` also rejects names that are not NFC-normalized, which
  // is a third, unrelated rule. Those codepoints are excluded from the
  // comparison — and the exclusion is asserted to be disjoint from the two
  // rules being compared, so it cannot become a place to hide a real
  // disagreement.
  const nfcOnly = [];
  const disagreements = [];
  for (let point = 0; point <= 0x10ffff; point++) {
    if (point >= 0xd800 && point <= 0xdfff) continue;
    const ch = cp(point);
    const truth = identifierProblem(point) !== null;

    // Composition 2 — the scanner over a PATH.
    const path = scanPath(`a${ch}b`).length > 0;

    // Composition 3 — the journal over an agent NAME.
    const name = `a${ch}b`;
    if (name !== name.normalize('NFC')) {
      nfcOnly.push(point);
      // Still checked, but only in the direction that cannot be confounded:
      // whatever NFC says, an identifier-illegal codepoint must be rejected.
      if (truth && agentNameProblem(name) === null) {
        disagreements.push(`U+${point.toString(16).toUpperCase()} journal ACCEPTED an illegal identifier`);
      }
      continue;
    }
    const journal = agentNameProblem(name) !== null;

    if (path !== truth || journal !== truth) {
      disagreements.push(
        `U+${point.toString(16).toUpperCase().padStart(4, '0')} identifierProblem=${truth} ` +
          `scanPath=${path} agentNameProblem=${journal}`,
      );
    }
  }
  assert.deepEqual(disagreements.slice(0, 40), [], `${disagreements.length} composition disagreement(s)`);

  // The excluded set must be about NORMALIZATION only. If an invisible or an
  // identifier-illegal codepoint ever lands in it, the exclusion above would
  // be silently carrying the very thing it claims not to cover.
  for (const point of nfcOnly) {
    assert.equal(
      identifierProblem(point),
      null,
      `U+${point.toString(16).toUpperCase()} was excluded as an NFC case but IS identifier-illegal`,
    );
  }
});

test('the TAG block: the case that made the layering visible', () => {
  // U+E0001..U+E007E map one-to-one onto ASCII and render as nothing. This is
  // the exact payload of U-46: the layer guarding OUR repository caught it,
  // the layer guarding the USER's STATE.md did not.
  for (const point of [0xe0000, 0xe0001, 0xe0041, 0xe007f]) {
    const ch = cp(point);
    assert.ok(invisibleProblem(point) !== null, `U+${point.toString(16)} must be invisible`);
    assert.equal(scanText(ch).length, 1, 'the scanner must catch it');
    assert.ok(agentNameProblem(`impl${ch}worker`) !== null, 'the journal must refuse it in a name');
    assert.equal(inline(`a${ch}b`), 'a b', 'inline() must remove it from the projection');
  }
  // End to end: a TAG character in journal data must not reach STATE.md.
  const { files } = renderProjections({
    events: [
      {
        ts: '2026-07-26T10:00:00.000Z',
        ev: 'ticket.created',
        init: 'demo',
        actor: 'c',
        data: { id: 'T-1', title: `visible${cp(0xe0041)}text` },
      },
    ],
  });
  assert.equal(scanText(files[STATE_FILE]).length, 0, 'a TAG character reached STATE.md');
});

test('the gaps the hand-written list missed are now closed by the property rule', () => {
  // Measured misses, each one found by a previous review and each one
  // impossible to fix by adding "one more range" — that is why the boundary is
  // a Unicode property now (ADR-19 correction 1 point 1).
  const previouslyMissed = [
    [0x0600, 'ARABIC NUMBER SIGN'],
    [0x0605, 'ARABIC NUMBER MARK ABOVE'],
    [0x06dd, 'ARABIC END OF AYAH'],
    [0x070f, 'SYRIAC ABBREVIATION MARK'],
    [0x08e2, 'ARABIC DISPUTED END OF AYAH'],
    [0x034f, 'COMBINING GRAPHEME JOINER'],
    [0x110bd, 'KAITHI NUMBER SIGN'],
    [0x13430, 'EGYPTIAN HIEROGLYPH VERTICAL JOINER'],
    [0x1bca0, 'SHORTHAND FORMAT LETTER OVERLAP'],
    [0xfffe, 'noncharacter'],
  ];
  for (const [point, name] of previouslyMissed) {
    assert.ok(invisibleProblem(point) !== null, `${name} (U+${point.toString(16)}) still passes`);
    assert.equal(scanText(cp(point)).length, 1, `${name} still passes the scanner`);
    assert.equal(inline(`a${cp(point)}b`), 'a b', `${name} still reaches a projection`);
  }
});

test('the deliberate gap survives the shape change, and is still the only one', () => {
  // U+FE0F appears 24 times in this repo's README. If the property rule had
  // swallowed the declared gap, CI would go red on a file nobody touched and
  // the gate would be switched off (ADR-19).
  for (const gap of DELIBERATELY_ALLOWED) {
    for (const point of [gap.lo, gap.hi]) {
      assert.equal(invisibleProblem(point), null, `${point.toString(16)} is documented as allowed`);
      assert.equal(scanText(cp(point)).length, 0);
      assert.equal(inline(`a${cp(point)}b`), `a${cp(point)}b`, 'the gap must be a gap in EVERY layer');
    }
  }
  // TAB and LF are legal file content and must never become invisible.
  assert.equal(invisibleProblem(0x09), null);
  assert.equal(invisibleProblem(0x0a), null);
  assert.equal(scanText('a\tb\nc').length, 0);
  // ...but they are still refused in a PATH, by the disjoint rule.
  assert.equal(scanPath(`a${cp(0x09)}b`).length, 1);
});

test('every named range is still named: the property rule did not eat the vocabulary', () => {
  // The property rule is the boundary; FORBIDDEN is the vocabulary. If a named
  // range stopped producing its sentence, findings would degrade to
  // "default-ignorable", which is not something a reader can act on.
  for (const range of FORBIDDEN) {
    for (const point of [range.lo, range.hi]) {
      assert.equal(invisibleProblem(point), range.what, `U+${point.toString(16)} lost its name`);
    }
  }
});

test('an unusable agent name gets ONE answer from both artefacts doctor produces', () => {
  // Point 3 of the story, measured at ca06c67: for a spawn whose agent name
  // carried a zero-width joiner, STATE.md rendered it as **running (no report
  // yet)** while pairSpawns reported no open spawn at all — the two artefacts
  // doctor produces and checks contradicted each other, and the operator got
  // both answers at once.
  for (const point of [0x200d, 0xe0041]) {
    const name = `impl${cp(point)}worker`;
    const events = [
      { ts: '2026-07-26T10:00:00.000Z', ev: 'spawn', init: 'demo', actor: 'c', data: { agent: name, role: 'implementer' } },
    ];
    const { open, badNames } = pairSpawns(events);
    const state = fold({ events });

    assert.equal(open.size, 0, 'pairSpawns must not treat an unusable name as an open spawn');
    assert.equal(badNames.size, 1, 'pairSpawns must report the name as unusable');

    // The resolution: NOT invisible (a silent exclusion is the failure ADR-19
    // correction 1 forbids) and NOT "running" (a false picture of state is
    // worse than none, ADR-18). Visible, and visibly unusable.
    assert.equal(state.agents.length, 1, 'the spawn must not vanish from the projection');
    assert.equal(
      state.agents[0].status,
      'unusable agent name (excluded from pairing)',
      'STATE.md and pairSpawns must give the same answer',
    );
    assert.ok(
      warnings(state).some((w) => /unusable/.test(w)),
      'the exclusion must never be silent',
    );

    // And no invisible byte reaches the document either way.
    const { files } = renderProjections({ events });
    assert.equal(scanText(files[STATE_FILE]).length, 0, 'a raw invisible codepoint reached STATE.md');
  }
});
