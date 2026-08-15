#!/usr/bin/env node
/**
 * yaml-patch — change ONE value in a YAML-subset file and keep the file.
 *
 * `yaml-lite.stringify` can serialize a whole document, and using it here
 * would be the obvious move and the wrong one. `templates/config.yaml` is 90
 * lines of which 63 are comments, and those comments are the only place an
 * operator is told that bare `off` is the boolean false, or why `autonomy:`
 * being AUTO is a trade rather than an oversight. Round-tripping the document
 * through a serializer deletes all of it, silently, the first time anyone
 * moves a slider in a web page.
 *
 * So this module edits TEXT, not data: it finds the line that owns a path and
 * rewrites the value on it, leaving every other byte — comments, blank lines,
 * key order, the operator's own spacing — exactly where it was.
 *
 * ## Why a text edit is safe here
 *
 * Because it is verified rather than trusted. Every patch is applied and then
 * PROVED, by parsing the result and comparing it to the document we meant to
 * produce: the target path holds the new value, and every other path is
 * byte-for-byte the value it held before. A locator bug cannot ship a wrong
 * file; it can only fail loudly. That inverts the usual risk of hand-editing
 * structured text, where the damage is silent and found later.
 *
 * The guarantee, stated exactly: if `patch()` returns, the returned text
 * parses to the intended document. If it cannot prove that, it throws and the
 * caller writes nothing.
 *
 * ## What it deliberately will not do
 *
 * - **Create keys.** A path that does not already exist is refused. Adding a
 *   key means choosing where it goes and what comment explains it, which is
 *   authoring, not editing.
 * - **Eat comments inside a list it replaces.** Replacing a block sequence
 *   rewrites its lines, so a comment among the items would vanish. That is
 *   refused instead, with the line number, because the alternative is the
 *   silent loss this whole module exists to prevent.
 */
import { YamlLiteError, formatScalar, keyColonIndex, parse, splitInlineComment, unquoteKey } from './yaml-lite.mjs';

export class YamlPatchError extends Error {}

/**
 * Lines with their code half, comment half, indentation and line ending.
 *
 * The `\r` is carried separately so a rewritten line in a CRLF file keeps the
 * ending every other line has. Dropping it produced a file with mixed endings
 * — correct data, and a diff that looks like the whole file moved.
 */
function scan(text) {
  return text.split('\n').map((line, i) => {
    const eol = line.endsWith('\r') ? '\r' : '';
    const raw = eol === '' ? line : line.slice(0, -1);
    const { code, comment } = splitInlineComment(raw, i + 1);
    const trimmed = code.trim();
    return {
      i,
      raw,
      eol,
      code,
      comment,
      trimmed,
      blank: trimmed === '',
      indent: code.length - code.trimStart().length,
    };
  });
}

/**
 * A sequence item carries its first key on the dash line (`- path: x`), so the
 * dash line is presented to the locator as an ordinary key line at the indent
 * its siblings use. Without this the first key of every rule would be
 * unreachable by the same code that reaches the rest.
 */
function asKeyLine(line, dashIndent, keyIndent) {
  if (dashIndent >= 0 && line.indent === dashIndent && line.trimmed.startsWith('- ')) {
    return { ...line, indent: keyIndent, trimmed: line.trimmed.slice(2).trim(), dash: true };
  }
  return line;
}

/**
 * How far in the block under `from` is indented, or -1 if there is no block.
 *
 * DISCOVERED, never assumed. `yaml-lite` recurses with `parseBlock(next.indent)`
 * — whatever the next line happens to be indented by, as long as it is deeper
 * and even — so a config indented four spaces is as legal as one indented two,
 * and `validateConfig` accepts it. A hardcoded step here made every nested key
 * in such a file report "is not in this file" while the page, which reads the
 * PARSED document, rendered all fifteen controls enabled. The operator got a
 * false error under a live control telling them to add a key that was already
 * there.
 *
 * The one step that genuinely is fixed is a sequence item's siblings, at
 * exactly dash + 2 — that is `yaml-lite.parseBlock`'s `indent + 2`, and it
 * follows from `- ` being two characters wide.
 */
function childIndentOf(lines, from, to, parentIndent) {
  for (let i = from; i < to; i += 1) {
    if (lines[i].blank) continue;
    return lines[i].indent > parentIndent ? lines[i].indent : -1;
  }
  return -1;
}

/** The indent step this document uses, for a block that has no children yet. */
function documentStep(lines, topIndent) {
  let step = -1;
  for (const line of lines) {
    if (line.blank || line.indent <= topIndent) continue;
    if (step === -1 || line.indent < step) step = line.indent;
  }
  return step === -1 ? 2 : step - topIndent;
}

/**
 * One past the last line belonging to the block that starts at `from`.
 *
 * The last CONTENT line, not the last line before the next key: a blank line
 * and the comment introducing the following section sit between the two, and
 * counting them as part of this block is how a list replacement would eat the
 * next section's heading.
 */
function blockEnd(lines, from, indent) {
  let end = from;
  for (let i = from; i < lines.length; i += 1) {
    if (lines[i].blank) continue;
    if (lines[i].indent <= indent) break;
    end = i + 1;
  }
  return end;
}

/**
 * Find the line that owns `path`, and where on it the value sits.
 *
 * `path` segments are keys, or integers for a position in a block sequence.
 */
function locate(lines, path) {
  const first = lines.find((line) => !line.blank);
  const topIndent = first === undefined ? 0 : first.indent;
  let from = 0;
  let to = lines.length;
  let indent = topIndent;
  let dashIndent = -1;
  let found = null;

  for (let depth = 0; depth < path.length; depth += 1) {
    const segment = path[depth];
    const where = `${path.slice(0, depth + 1).join('.')}`;

    if (typeof segment === 'number') {
      let seen = -1;
      let hit = -1;
      for (let i = from; i < to; i += 1) {
        const line = lines[i];
        if (line.blank || line.indent !== indent || !line.trimmed.startsWith('- ')) continue;
        seen += 1;
        if (seen === segment) {
          hit = i;
          break;
        }
      }
      if (hit === -1) throw new YamlPatchError(`no item ${segment} in the list at "${path.slice(0, depth).join('.')}"`);
      dashIndent = lines[hit].indent;
      found = { line: hit, dash: false, keyIndent: dashIndent + 2 };
      from = hit;
      to = blockEnd(lines, hit + 1, dashIndent);
      // A sequence item's sibling keys sit at exactly dash + 2, and the FIRST
      // of them shares the dash line — `- path: x`. This is the one step that
      // is not discovered, because it is not a style choice: `- ` is two
      // characters, and yaml-lite reads siblings at `indent + 2` for that
      // reason.
      indent = dashIndent + 2;
      continue;
    }

    let hit = -1;
    let view = null;
    for (let i = from; i < to; i += 1) {
      const line = asKeyLine(lines[i], dashIndent, indent);
      if (line.blank || line.indent !== indent) continue;
      // The PARSER's key rule, not a bare indexOf: a colon inside a key name
      // (`a:b: 1`) otherwise ends the key early, and the edit lands on a
      // different key's line — a wrong write rather than a failed one.
      const colon = keyColonIndex(line.trimmed);
      if (colon === -1) continue;
      let key;
      try {
        key = unquoteKey(line.trimmed.slice(0, colon), line.i + 1);
      } catch {
        continue;
      }
      if (key !== segment) continue;
      hit = i;
      view = line;
      break;
    }
    if (hit === -1) throw new YamlPatchError(`"${where}" is not in this file — yaml-patch edits existing keys, it does not add them`);
    found = { line: hit, dash: view.dash === true, keyIndent: indent };
    const parentIndent = lines[hit].indent;
    from = hit + 1;
    to = blockEnd(lines, from, parentIndent);
    indent = childIndentOf(lines, from, to, parentIndent);
    if (indent === -1) indent = parentIndent + documentStep(lines, topIndent);
    dashIndent = -1;
  }

  if (found === null) throw new YamlPatchError('an empty path addresses nothing');
  return found;
}

/**
 * Deep structural equality over the plain data yaml-lite produces.
 *
 * Exported so the proof at the end of `patch()` can be tested directly, and
 * because it is the mutable logic the guarantee rests on.
 *
 * It is NOT unreachable, and an earlier version of this comment said it was.
 * A review found the case: `formatScalar` used a stricter number pattern than
 * `parseScalar`, so the string ".5" was written unquoted and read back as the
 * number 0.5 — a changed type, caught here and nowhere else. That specific
 * disagreement is fixed in yaml-lite, which is the right place for it; this
 * check is what noticed.
 */
export function sameValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameValue(item, b[i]));
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]));
}

function readAt(doc, path) {
  let node = doc;
  for (const segment of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[segment];
  }
  return node;
}

function writeAt(doc, path, value) {
  let node = doc;
  for (const segment of path.slice(0, -1)) node = node[segment];
  node[path.at(-1)] = value;
}

/** Rewrite the value on a `key: value` line, keeping indent, comment and ending. */
function scalarLine(line, target, value) {
  const body = target.dash ? line.trimmed.slice(2).trim() : line.trimmed;
  const colon = keyColonIndex(body);
  const tail = line.comment === '' ? '' : ` ${line.comment}`;
  // A plain sequence item (`- npm test`) is a value with no key at all, which
  // an address ending in an integer reaches. Treating it like a mapping line
  // dropped the dash and shifted the indent by one, and the round-trip proof
  // then blamed a NEIGHBOURING line for the indentation it had broken.
  if (colon === -1) {
    return `${' '.repeat(line.indent)}- ${formatScalar(value)}${tail}${line.eol}`;
  }
  const head = `${' '.repeat(line.indent)}${target.dash ? '- ' : ''}${body.slice(0, colon + 1)}`;
  return `${head} ${formatScalar(value)}${tail}${line.eol}`;
}

/**
 * Set `path` to `value` in `text`, returning the new text.
 *
 * Throws `YamlPatchError` if the path is absent, if the change cannot be made
 * without losing a comment, or — the one that matters — if the result does not
 * parse back to exactly the document intended.
 */
export function patch(text, path, value) {
  // A BOM is an encoding marker, not content — and `trimStart` counts it as
  // whitespace, so it read as one column of indentation and the rebuilt line
  // replaced it with a SPACE, producing an odd indent the parser then refused.
  // Split it off here and put it back on the result, so the file keeps the
  // marker it came with and nothing downstream has to know about it.
  const bom = text.charCodeAt(0) === 0xfeff ? text.slice(0, 1) : '';
  if (bom !== '') return bom + patch(text.slice(1), path, value);

  let before;
  try {
    before = parse(text);
  } catch (err) {
    if (err instanceof YamlLiteError) throw new YamlPatchError(`this file does not parse, so it cannot be edited safely: ${err.message}`);
    throw err;
  }
  if (readAt(before, path) === undefined) {
    throw new YamlPatchError(`"${path.join('.')}" is not in this file — yaml-patch edits existing keys, it does not add them`);
  }

  return build(text, path, value, before);
}

/**
 * The edit itself, with every refusal this module makes reported as one error
 * type.
 *
 * `formatScalar` throws `YamlLiteError` for a value the subset cannot spell —
 * a newline, an invisible codepoint — and that is ordinary rejected input, not
 * a fault. Letting it escape made the caller classify it as a server error:
 * HTTP 500 and a line in the terminal the docs designate as the audit trail,
 * for someone pasting a model name with a stray newline in it.
 */
function build(text, path, value, before) {
  try {
    return edit(text, path, value, before);
  } catch (err) {
    if (err instanceof YamlLiteError) throw new YamlPatchError(err.message);
    throw err;
  }
}

function edit(text, path, value, before) {
  const lines = scan(text);
  const first = lines.find((l) => !l.blank);
  const target = locate(lines, path);
  const line = lines[target.line];

  const out = text.split('\n');
  if (Array.isArray(value)) {
    const body = target.dash ? line.trimmed.slice(2).trim() : line.trimmed;
    const colon = body.indexOf(':');
    const inlineValue = body.slice(colon + 1).trim();
    // The block boundary is the KEY's indent, not the line's. On the first key
    // of a sequence item (`- tags:`) the line is indented at the DASH, so
    // using it ran the block to the end of the whole item and the splice took
    // the item's sibling keys out with the list.
    const ownIndent = target.dash ? target.keyIndent : line.indent;
    const end = inlineValue === '' ? blockEnd(lines, target.line + 1, ownIndent) : target.line + 1;
    // The items' indent is the one they already have; a list with none yet
    // (`shared_zones: []`) takes the step the rest of the document uses.
    const discovered = childIndentOf(lines, target.line + 1, end, ownIndent);
    const childIndent = discovered === -1
      ? ownIndent + documentStep(lines, first === undefined ? 0 : first.indent)
      : discovered;
    // Rewriting the block rewrites its lines, so a comment living among the
    // items would disappear. Refusing keeps the promise this module is for.
    for (let i = target.line + 1; i < end; i += 1) {
      if (lines[i].comment !== '') {
        throw new YamlPatchError(
          `line ${i + 1} of this list is a comment, and replacing the list would delete it — ` +
            `edit ${path.join('.')} in the file by hand instead`,
        );
      }
    }
    const head = `${' '.repeat(line.indent)}${target.dash ? '- ' : ''}${body.slice(0, colon + 1)}`;
    const tail = line.comment === '' ? '' : ` ${line.comment}`;
    const rendered = value.length === 0
      ? [`${head} []${tail}${line.eol}`]
      : [`${head}${tail}${line.eol}`, ...value.map((item) => `${' '.repeat(childIndent)}- ${formatScalar(item)}${line.eol}`)];
    out.splice(target.line, end - target.line, ...rendered);
  } else {
    out[target.line] = scalarLine(line, target, value);
  }
  const next = out.join('\n');

  // The proof. A locator that picked the wrong line, a quoting rule that read
  // back as a different type, a list block whose extent was misjudged — each
  // shows up here as a mismatch, before anything reaches the disk.
  const expected = structuredClone(before);
  writeAt(expected, path, value);
  let after;
  try {
    after = parse(next);
  } catch (err) {
    throw new YamlPatchError(`the edit produced a file that no longer parses (${err.message}) — nothing was written`);
  }
  if (!sameValue(after, expected)) {
    throw new YamlPatchError(
      `the edit did not produce the intended document — nothing was written. ` +
        `Wanted ${path.join('.')} = ${JSON.stringify(value)}, got ${JSON.stringify(readAt(after, path))}` +
        (sameValue(readAt(after, path), value) ? ', and something else in the file changed too' : ''),
    );
  }
  return next;
}
