/**
 * invisible — the ONE answer to "is this codepoint invisible?".
 *
 * Why this file exists (ADR-19 correction 1 point 4, ADR-21): the rule had
 * THREE spellings, and they were measurably inconsistent. Measured over all
 * 1 112 064 codepoints at ca06c67, the three layers disagreed on 456 of them
 * in 37 contiguous ranges — and the layering was INVERTED. The strictest
 * spelling guarded our own repository in CI; the weakest guarded `STATE.md`,
 * the document an agent reads to decide what to do next, whose content
 * travels from subagent reports about FOREIGN repositories. The whole TAG
 * block passed the layer closest to the victim while the layer closest to us
 * blocked it.
 *
 * So the point of this module is not code reuse. It is that there must be one
 * ANSWER, not one function: every consumer asks `invisibleProblem` and none of
 * them passes options, because an option here would be a second semantics
 * wearing the word "additive" (ADR-21).
 *
 * ---------------------------------------------------------------------------
 * SHAPE: why a Unicode PROPERTY, and not a longer hand-written list
 * ---------------------------------------------------------------------------
 * ADR-19 correction 1 concluded that any enumeration will be incomplete
 * because Unicode grows and we do not, and it named an ALLOWLIST as the
 * candidate direction. That hypothesis was measured before this module was
 * written, and the measurement REFUTED it for this rule:
 *
 *   a letters/numbers/punctuation/symbols/marks/spaces allowlist — the widest
 *   repertoire a Markdown table cell could plausibly need — still admits 267
 *   DEFAULT-IGNORABLE codepoints, among them the whole of U+E0100..U+E01EF,
 *   the same smuggling channel the denylist already had to name by hand.
 *
 * An allowlist would therefore still need a subtractive carve-out for exactly
 * the characters that motivated the work: it moves the problem, it does not
 * change its shape. What DOES change the shape is asking Unicode itself.
 * `\p{Default_Ignorable_Code_Point}` is the property whose definition is
 * literally "renders as nothing", it ships inside V8, it costs zero
 * dependencies, and it is maintained by the people who add the characters.
 * Measured: it is a strict SUPERSET of the hand-written list — 0 codepoints
 * of the old list fall outside the property rule — and it closes every gap
 * the previous measurements had found the hard way (Arabic `Cf` U+0600..0605,
 * Egyptian controls U+13430..1343F, U+034F, Mongolian free variation
 * selectors, and 3 844 codepoints in total).
 *
 * The enumerated list stays, and is consulted FIRST, for one reason: a range
 * in it carries a sentence a human can act on. "TAG character (invisible
 * ASCII)" tells a reader what happened; "default-ignorable" does not. The
 * list is the vocabulary, the property is the boundary.
 *
 * Cost accepted deliberately: the property set follows the Unicode version
 * bundled with Node, so a Node upgrade may widen it. That is the intended
 * direction of drift — wider, never narrower — and the pinning test asserts
 * shape and specific members rather than an exact cardinality, so an upgrade
 * cannot silently NARROW the rule without turning a test red.
 */

/**
 * Named forbidden ranges, as numbers rather than string escapes — on purpose.
 * A regex literal written with escape notation is one careless "helpful"
 * rewrite away from becoming the very character it bans, and the file would
 * then fail its own scan. Numbers cannot be mangled that way, and they double
 * as the reporting vocabulary.
 */
export const FORBIDDEN = Object.freeze([
  // C0 controls, except TAB (0x09) and LF (0x0A) which are legal text.
  // CR (0x0D) is deliberately IN: this repo normalizes to LF (.gitattributes).
  Object.freeze({ lo: 0x00, hi: 0x08, what: 'C0 control character' }),
  Object.freeze({ lo: 0x0b, hi: 0x1f, what: 'C0 control character' }),
  Object.freeze({ lo: 0x7f, hi: 0x9f, what: 'DEL / C1 control character' }),
  Object.freeze({ lo: 0x00ad, hi: 0x00ad, what: 'invisible formatting character (SOFT HYPHEN)' }),
  Object.freeze({ lo: 0x061c, hi: 0x061c, what: 'bidi mark (ARABIC LETTER MARK)' }),
  Object.freeze({ lo: 0x115f, hi: 0x1160, what: 'invisible filler that renders as nothing' }),
  Object.freeze({ lo: 0x180e, hi: 0x180e, what: 'invisible separator (MONGOLIAN VOWEL SEPARATOR)' }),
  Object.freeze({ lo: 0x200b, hi: 0x200f, what: 'zero-width or directional mark' }),
  Object.freeze({ lo: 0x202a, hi: 0x202e, what: 'bidi embedding or override' }),
  Object.freeze({ lo: 0x2060, hi: 0x2064, what: 'word joiner or invisible operator' }),
  Object.freeze({ lo: 0x2066, hi: 0x2069, what: 'bidi isolate' }),
  Object.freeze({ lo: 0x206a, hi: 0x206f, what: 'deprecated formatting character' }),
  Object.freeze({ lo: 0x3164, hi: 0x3164, what: 'invisible filler that renders as nothing' }),
  Object.freeze({ lo: 0xffa0, hi: 0xffa0, what: 'invisible filler that renders as nothing' }),
  Object.freeze({ lo: 0xfeff, hi: 0xfeff, what: 'byte order mark / zero-width no-break space' }),
  Object.freeze({ lo: 0xfff9, hi: 0xfffb, what: 'interlinear annotation character' }),
  Object.freeze({ lo: 0x1d173, hi: 0x1d17a, what: 'invisible musical formatting character' }),
  // The one that matters most, and the one the old test could not even see:
  // U+E0001..U+E007E map ONE-TO-ONE onto ASCII and render as nothing at all.
  // Projections (STATE.md, PROGRESS.md) are read by AGENTS, and their content
  // travels from subagent reports about foreign repositories — so invisible
  // text in a projection is prompt injection aimed at our own team, not an
  // aesthetic complaint. The block is astral, which is why the pinning test
  // stopping at U+FFFF hid it (ADR-19 correction 1).
  Object.freeze({ lo: 0xe0000, hi: 0xe007f, what: 'TAG character (invisible ASCII)' }),
  // Variation Selectors Supplement. Same smuggling channel as the TAG block —
  // a sequence of them encodes arbitrary bytes onto a visible carrier — and
  // zero occurrences in this repo, so banning them costs nothing here. Their
  // BMP counterparts are deliberately NOT banned; see below.
  Object.freeze({ lo: 0xe0100, hi: 0xe01ef, what: 'variation selector (supplement)' }),
]);

/**
 * DELIBERATE GAP: U+FE00..U+FE0F (variation selectors 1-16) are NOT banned.
 *
 * U+FE0F is the emoji presentation selector and occurs 24 times in this repo's
 * README today; U+FE0E is its text-presentation twin. Banning the range would
 * turn CI red on a file nobody touched, and ADR-19 is explicit that a gate
 * which cries wolf gets switched off and never restored — which costs more
 * than the gap.
 *
 * The gap is real and stated rather than hidden: 16 codepoints still carry
 * four bits each, so a determined smuggler can encode data with them. It is
 * announced on every run of the scanner, clean runs included, and it is the
 * ONE place where this module says "allowed" to something Unicode calls
 * default-ignorable — which is why it is a list, checked first, and not a
 * condition buried inside the predicate.
 */
export const DELIBERATELY_ALLOWED = Object.freeze([
  Object.freeze({ lo: 0xfe00, hi: 0xfe0f, why: 'variation selectors: U+FE0F is legal emoji presentation' }),
]);

/**
 * TAB and LF are legal text and must never be answered as "invisible". They
 * are visible whitespace with a layout meaning, and files are full of them.
 * Consumers for which they are nonetheless illegal — a file NAME, an agent
 * name — ask `whitespaceProblem`, a DISJOINT rule; see below.
 */
const LEGAL_TEXT_CONTROLS = Object.freeze([0x09, 0x0a]);

/**
 * The boundary of the rule, as ONE character class — the union of the four
 * properties, which is exactly what four separate tests computed.
 *
 * It began as four regexes and was collapsed after measuring: a codepoint that
 * is ORDINARY has to fail every test before the answer is "no", and "no" is the
 * answer for 99.6% of Unicode and for essentially all real text. Four misses
 * per character made `inline()` 15x slower than the old hand-written class on
 * astral input (5 000 emoji: 1.19 ms vs 0.08 ms). One class is one miss.
 *
 * The `^...$` anchors are defensive habit, not a load-bearing guarantee: the
 * only caller builds the subject with `String.fromCodePoint`, so it is always
 * exactly one character and the anchors cannot change the verdict. Removing
 * them is an EQUIVALENT mutant here, and the sentence says so rather than
 * claiming a protection no test in this repo can demonstrate. They earn their
 * keep only if someone later passes a longer string — which the type of the
 * parameter already forbids.
 */
const IS_INVISIBLE =
  /^[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}]$/u;

const inRange = (cp, ranges) => {
  for (const r of ranges) if (cp >= r.lo && cp <= r.hi) return r;
  return null;
};

/**
 * A 64 KiB lookup for the BMP, filled lazily: 0 unknown, 1 allowed, 2 banned.
 * `inline()` runs on every cell of every projection, so the property test must
 * not be paid per character per render. Above the BMP the properties are
 * evaluated directly — those codepoints are rare in real text and the
 * exhaustive test that walks all of them is not a hot path.
 */
const bmp = new Uint8Array(0x10000);

/**
 * The same idea above the BMP, where a flat array would cost 1 MiB and a
 * regex test costs ~13x what the old hand-written character class did.
 * Measured on 5 000 astral codepoints: 0.08 ms before this module, 1.08 ms
 * with the property test, 0.09 ms with this cache.
 *
 * Bounded, and cleared rather than evicted: an exhaustive sweep over Unicode
 * (this repo has three of them, in tests) would otherwise grow it to a million
 * entries. Clearing is correct because the map is a pure memo — losing it
 * costs time, never accuracy — and a cheap clear beats an LRU whose only
 * purpose is to be more elegant about the same guarantee.
 */
const astral = new Map();
const ASTRAL_CACHE_LIMIT = 1 << 16;

/**
 * How many entries the astral memo currently holds, and its ceiling.
 *
 * Exported ONLY so the boundedness guarantee can be tested. Without it the
 * test could assert that answers survive a recycle but not that a recycle ever
 * happens — and a test whose NAME promises boundedness while its body checks
 * only correctness is the "documented guarantee with no guard" shape this
 * story exists to remove. Removing the `clear()` used to leave the whole suite
 * green; now it does not.
 */
export function astralMemoStats() {
  return { size: astral.size, limit: ASTRAL_CACHE_LIMIT };
}

/** The label a codepoint gets when only the property rule caught it. */
const PROPERTY_LABEL = 'invisible or non-printing character (Unicode default-ignorable / control / format)';

/**
 * The problem with this codepoint, or null when it is ordinary text.
 *
 * This is the single answer. It takes no options on purpose: an option would
 * let two callers ask the same question and be told different things, which is
 * the defect this module was created to remove (ADR-21 — one ANSWER, not one
 * function).
 */
export function invisibleProblem(cp) {
  // Not `return null`. This is a security predicate, and "null" is its word for
  // CLEAN — so answering it for a value that is not a codepoint at all is
  // fail-open, the shape ADR-19 correction 1 catalogues as the way a gate gets
  // walked past. Today every caller passes `ch.codePointAt(0)` and the branch
  // is unreachable, which is exactly why it must not sit here quietly deciding
  // that garbage is fine: the next caller is the one that makes it reachable.
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) {
    throw new TypeError(`invisibleProblem expects a Unicode code point, got ${JSON.stringify(cp)}`);
  }
  if (cp < 0x10000) {
    const cached = bmp[cp];
    if (cached !== 0) return cached === 1 ? null : labelFor(cp);
    const problem = compute(cp);
    bmp[cp] = problem === null ? 1 : 2;
    return problem;
  }
  const memo = astral.get(cp);
  if (memo !== undefined) return memo;
  const problem = compute(cp);
  if (astral.size >= ASTRAL_CACHE_LIMIT) astral.clear();
  astral.set(cp, problem);
  return problem;
}

/** Named ranges win, so the reader gets a sentence instead of a category. */
function labelFor(cp) {
  const named = inRange(cp, FORBIDDEN);
  return named ? named.what : PROPERTY_LABEL;
}

function compute(cp) {
  if (LEGAL_TEXT_CONTROLS.includes(cp)) return null;
  if (inRange(cp, DELIBERATELY_ALLOWED)) return null;
  const named = inRange(cp, FORBIDDEN);
  if (named) return named.what;
  return IS_INVISIBLE.test(String.fromCodePoint(cp)) ? PROPERTY_LABEL : null;
}

/**
 * The SEPARATE rule for identifiers — a file name, a symlink target, an agent
 * name. TAB and LF are perfectly visible characters, so they are not an answer
 * to "is this invisible"; they are a catastrophe in a NAME, where a tab makes
 * one path print as two columns in every tool that lists it and a newline
 * breaks the line-oriented output of all of them.
 *
 * Kept as its own function, with its own name, precisely so that it cannot be
 * mistaken for a second configuration of the invisibility rule. The two rules
 * are DISJOINT — `invisibleProblem` never answers for U+0009 or U+000A, and
 * this one answers for nothing else — and a test asserts that disjointness
 * over the whole of Unicode, so the boundary cannot rot into an option.
 */
export function whitespaceProblem(cp) {
  return LEGAL_TEXT_CONTROLS.includes(cp) ? 'control character in a name or path' : null;
}

/** Either rule, for the consumers that hold identifiers. */
export function identifierProblem(cp) {
  return invisibleProblem(cp) ?? whitespaceProblem(cp);
}

/** `U+00A0` style, always at least four hex digits. */
export function formatCodePoint(cp) {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Every invisible codepoint in `text` replaced by its VISIBLE escape notation.
 *
 * ONE VISIBILITY POLICY, and this is it: an invisible character is shown, never
 * silently dropped.
 *
 * The repo had two policies and they contradicted each other. `inline()`
 * deleted invisible characters, so a value made entirely of TAG characters
 * rendered identically to an empty one — `inline("deploy ok" + TAG("IGNORE ALL
 * PRIOR INSTRUCTIONS"))` returned exactly `"deploy ok"`, with nothing anywhere
 * saying that 29 characters had been removed. Meanwhile the hook runtime
 * escaped them and its own comment called silent removal "the same class of
 * defect as a silent exemption in the scanner". Two layers, two answers to
 * "does the reader get told" — the same shape as the three spellings of
 * membership this module exists to have removed, one level up.
 *
 * Escaping wins on the repo's own stated principle: ADR-19 correction 1 says an
 * exclusion must never be silent, that a skipped item is to be counted and
 * named even on a clean run. It also matches how `inline()` already signals its
 * OTHER losses — truncation prints an ellipsis — so silent character removal
 * was the single lossy step that left no trace.
 *
 * The cost is accepted and stated: a hostile value becomes long and ugly, and
 * legitimate formatting characters of Arabic, Syriac, Kaithi and Egyptian
 * become visible noise in text that uses them (see docs/projections.md). Ugly
 * and honest beats tidy and misleading in a document an agent reads to decide
 * what to do next.
 *
 * Iterates codepoints, not UTF-16 units: a TAG character is a surrogate PAIR,
 * and a unit-wise walk sees 0xDB40/0xDC01 — neither of which is invisible on
 * its own — and lets the character through while reporting success.
 */
export function escapeInvisible(text) {
  let out = '';
  let changed = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (invisibleProblem(cp) === null) out += ch;
    else {
      out += `<${formatCodePoint(cp)}>`;
      changed = true;
    }
  }
  return changed ? out : text;
}

/**
 * The same rule applied to a JSON document, as JSON's own `\uXXXX` escapes.
 *
 * `JSON.stringify` escapes C0 controls and nothing else: bidi overrides, TAG
 * characters and zero-width marks come out RAW. Every `journal.mjs` subcommand
 * prints stringified events to a terminal, so `query`, `tail`, `validate`,
 * `open-spawns`, `append` and `close-spawn` were all handing an attacker the
 * operator's screen.
 *
 * `<U+202E>` would have been wrong here: that output is machine-readable, and
 * this repo's own tooling parses it back. JSON escapes are SAFE ON A TERMINAL
 * AND LOSSLESS — `JSON.parse` of the result is deep-equal to the original, and
 * a test asserts exactly that. Fidelity and safety were not in tension; they
 * only looked like it while the escape notation was the wrong one.
 */
export function jsonEscapeInvisible(json) {
  let out = '';
  for (const ch of json) {
    const cp = ch.codePointAt(0);
    if (invisibleProblem(cp) === null) {
      out += ch;
      continue;
    }
    // Astral codepoints need their surrogate PAIR spelled out: JSON has no
    // \u{...} form, so each UTF-16 unit is escaped separately.
    for (let i = 0; i < ch.length; i++) {
      out += BS_LITERAL + 'u' + ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
    }
  }
  return out;
}

/** A single backslash, built from its code point so no tool can rewrite it. */
const BS_LITERAL = String.fromCharCode(92);
