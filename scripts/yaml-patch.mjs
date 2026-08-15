#!/usr/bin/env node
/**
 * yaml-patch — change ONE value in a YAML-subset file and keep the file.
 *
 * `yaml-lite.stringify` can serialize a whole document, and using it here
 * would be the obvious move and the wrong one. `templates/config.yaml` is 91
 * lines of which 60 are comments, and those comments are the only place an
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
import { YamlLiteError, formatScalar, parse, splitInlineComment } from './yaml-lite.mjs';

export class YamlPatchError extends Error {}

/** Lines with their code half, comment half and indentation, once. */
function scan(text) {
  return text.split('\n').map((raw, i) => {
    const { code, comment } = splitInlineComment(raw, i + 1);
    const trimmed = code.trim();
    return {
      i,
      raw,
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
 * dash line is presented to the locator as an ordinary key line indented two
 * further. Without this the first key of every rule would be unreachable by
 * the same code that reaches the rest.
 */
function asKeyLine(line, seqIndent) {
  if (line.indent === seqIndent && line.trimmed.startsWith('- ')) {
    return { ...line, indent: seqIndent + 2, trimmed: line.trimmed.slice(2).trim(), dash: true };
  }
  return line;
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
  let from = 0;
  let to = lines.length;
  let indent = 0;
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
      found = { line: hit, key: null };
      from = hit;
      to = blockEnd(lines, hit + 1, indent);
      // The item's keys sit two columns in from the dash, and the FIRST of
      // them shares the dash line — `- path: x`. Both facts are needed: the
      // search indent moves to the keys, and the dash line is presented as a
      // key line at that same indent by `asKeyLine`.
      indent = lines[hit].indent + 2;
      continue;
    }

    let hit = -1;
    for (let i = from; i < to; i += 1) {
      const line = asKeyLine(lines[i], indent - 2);
      if (line.blank || line.indent !== indent) continue;
      const colon = line.trimmed.indexOf(':');
      if (colon === -1) continue;
      if (line.trimmed.slice(0, colon).trim().replace(/^['"]|['"]$/g, '') !== segment) continue;
      hit = i;
      break;
    }
    if (hit === -1) throw new YamlPatchError(`"${where}" is not in this file — yaml-patch edits existing keys, it does not add them`);
    found = { line: hit, key: segment };
    from = hit + 1;
    to = blockEnd(lines, hit + 1, lines[hit].indent);
    indent = lines[hit].indent + 2;
  }

  if (found === null) throw new YamlPatchError('an empty path addresses nothing');
  return found;
}

/** Deep structural equality over the plain data yaml-lite produces. */
function sameValue(a, b) {
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

/** Rewrite the value on a `key: value` line, keeping indent and comment. */
function scalarLine(line, seqIndent, value) {
  const view = asKeyLine(line, seqIndent);
  const colon = view.trimmed.indexOf(':');
  const head = view.dash
    ? `${' '.repeat(line.indent)}- ${view.trimmed.slice(0, colon + 1)}`
    : `${' '.repeat(line.indent)}${view.trimmed.slice(0, colon + 1)}`;
  const tail = line.comment === '' ? '' : ` ${line.comment}`;
  return `${head} ${formatScalar(value)}${tail}`;
}

/**
 * Set `path` to `value` in `text`, returning the new text.
 *
 * Throws `YamlPatchError` if the path is absent, if the change cannot be made
 * without losing a comment, or — the one that matters — if the result does not
 * parse back to exactly the document intended.
 */
export function patch(text, path, value) {
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

  const lines = scan(text);
  const seqIndent = typeof path.at(-2) === 'number' ? lines[locate(lines, path.slice(0, -1)).line].indent : -2;
  const target = locate(lines, path);
  const line = lines[target.line];

  const out = text.split('\n');
  if (Array.isArray(value)) {
    const view = asKeyLine(line, seqIndent);
    const colon = view.trimmed.indexOf(':');
    const inlineValue = view.trimmed.slice(colon + 1).trim();
    const childIndent = line.indent + 2;
    const end = inlineValue === '' ? blockEnd(lines, target.line + 1, line.indent) : target.line + 1;
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
    const head = `${' '.repeat(line.indent)}${view.trimmed.slice(0, colon + 1)}`;
    const tail = line.comment === '' ? '' : ` ${line.comment}`;
    const body = value.length === 0
      ? [`${head} []${tail}`]
      : [`${head}${tail}`, ...value.map((item) => `${' '.repeat(childIndent)}- ${formatScalar(item)}`)];
    out.splice(target.line, end - target.line, ...body);
  } else {
    out[target.line] = scalarLine(line, seqIndent, value);
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
