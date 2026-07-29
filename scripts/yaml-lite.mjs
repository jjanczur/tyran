#!/usr/bin/env node
/**
 * yaml-lite — a deliberately small YAML subset parser/serializer.
 *
 * Tyran's core has zero dependencies (see CONTRIBUTING). Rather than ship a
 * full YAML implementation, we support the strict subset our own config,
 * knowledge and policy files are allowed to use — and REJECT everything
 * else loudly, so a file that would parse differently under a real YAML
 * engine can never silently mean something else here.
 *
 * Supported
 *   key: value                      scalars: string, number, bool, null
 *   key:                            nested mappings (2-space indent)
 *     nested: value
 *   key:                            block sequences of scalars or mappings
 *     - item
 *     - key: v
 *       key2: v
 *   key: [a, b]                     inline flow sequences of scalars
 *   'single' / "double" quoted strings · # comments · --- document start
 *
 * Rejected loudly (with a line number): anchors/aliases (& *), tags (! !!),
 * multi-line scalars (| >), flow mappings ({}), nested flow sequences,
 * tabs for indentation, duplicate keys, multiple documents.
 */
import { formatCodePoint, invisibleProblem } from './invisible.mjs';

// Prototype-free lookup: `constructor`/`__proto__` must be data, not
// inherited members (review E2S2-R2).
const BOOL = Object.assign(Object.create(null), {
  true: true,
  false: false,
  yes: true,
  no: false,
  on: true,
  off: false,
});

export class YamlLiteError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.line = line ?? null;
  }
}

/** Guards shared by keys and values — the subset boundary in one place. */
function rejectUnsupported(value, lineNo, what) {
  if (value[0] === '&' || value[0] === '*') {
    throw new YamlLiteError(`anchors and aliases are not supported (in ${what})`, lineNo);
  }
  if (value[0] === '!') throw new YamlLiteError(`tags are not supported (in ${what})`, lineNo);
  if (value[0] === '|' || value[0] === '>') {
    throw new YamlLiteError(`multi-line block scalars are not supported (in ${what})`, lineNo);
  }
  if (value[0] === '{') throw new YamlLiteError(`flow mappings are not supported (in ${what})`, lineNo);
}

/** Split a flow sequence body on commas that sit outside quotes. */
function splitFlow(inner, lineNo) {
  const parts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (const c of inner) {
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    if (c === ',' && !inSingle && !inDouble) {
      parts.push(current);
      current = '';
    } else current += c;
  }
  if (inSingle || inDouble) throw new YamlLiteError('unterminated quoted string in flow sequence', lineNo);
  parts.push(current);
  return parts;
}

function unquote(value, lineNo) {
  // Single-quoted YAML escapes a quote by doubling it — undo that, so
  // stringify→parse is symmetric (review E2S2-R3).
  if (value[0] === "'" && value.at(-1) === "'") return value.slice(1, -1).replace(/''/g, "'");
  const inner = value.slice(1, -1);
  // Backslash escapes inside double quotes are real YAML but not part of
  // this subset — decoding them half-way would mean something different
  // than a real loader (review E2S2 note 2).
  if (inner.includes('\\')) {
    throw new YamlLiteError('backslash escapes inside double quotes are not supported — use single quotes', lineNo);
  }
  return inner;
}

function parseScalar(raw, lineNo, { allowFlow = true } = {}) {
  const value = raw.trim();
  if (value === '') return '';
  rejectUnsupported(value, lineNo, 'value');
  if (value.startsWith('[')) {
    if (!allowFlow) throw new YamlLiteError('nested flow sequences are not supported', lineNo);
    const close = value.lastIndexOf(']');
    if (close === -1) throw new YamlLiteError('unterminated flow sequence', lineNo);
    if (value.slice(close + 1).trim() !== '') {
      throw new YamlLiteError('unexpected content after flow sequence', lineNo);
    }
    const inner = value.slice(1, close).trim();
    if (inner === '') return [];
    return splitFlow(inner, lineNo).map((part) => parseScalar(part, lineNo, { allowFlow: false }));
  }
  if ((value[0] === '"' && value.at(-1) === '"' && value.length > 1) ||
      (value[0] === "'" && value.at(-1) === "'" && value.length > 1)) {
    return unquote(value, lineNo);
  }
  if (value === 'null' || value === '~') return null;
  const lower = value.toLowerCase();
  if (Object.hasOwn(BOOL, lower)) return BOOL[lower];
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d*\.\d+$/.test(value)) return Number(value);
  return value;
}

function stripComment(line, lineNo) {
  // Comments start at ` #` outside quotes; a leading `#` is a full-line comment.
  let inSingle = false;
  let inDouble = false;
  let cut = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      cut = i;
      break; // the comment body is not YAML — stop tracking quotes there
    }
  }
  // An unbalanced quote means our comment detection disagreed with a real
  // YAML loader (`a: don't ask # why`) — refuse rather than guess
  // (review E2S2 note 1).
  if (inSingle || inDouble) {
    // Name the construct, not one guess at its cause.
    //
    // This said "quote the whole value if it contains an apostrophe" for every
    // unbalanced quote there is. Measured on a real install: an operator wrote
    // a long `source:` as a multi-line double-quoted string, got told to worry
    // about an apostrophe that was not there, and burned three round-trips
    // looking for one. A diagnosis that confidently names the wrong cause is
    // worse than one that names none — it sends the reader somewhere else.
    //
    // The two cases are distinguishable from what is already known here: a
    // value that OPENS with the quote still in flight was never closed on this
    // line, which in a subset with no multi-line scalars is the whole answer.
    const opener = inSingle ? "'" : '"';
    const body = line.slice(line.indexOf(':') + 1).trim();
    const opensWithQuote = body.startsWith(opener);
    throw new YamlLiteError(
      opensWithQuote
        ? `a ${opener}-quoted value that never closes on this line. This subset has no multi-line ` +
          'scalars (no >-, no |), so put the whole value on one line however long it gets'
        : `unbalanced ${opener} — if the value contains an apostrophe, quote the whole value`,
      lineNo,
    );
  }
  return cut === -1 ? line : line.slice(0, cut);
}

/** Parse a YAML-subset document into a plain JS object. */
export function parse(text) {
  const rawLines = text.split('\n');
  const lines = [];
  let sawDocStart = false;
  rawLines.forEach((raw, i) => {
    const lineNo = i + 1;
    const beforeContent = raw.slice(0, raw.search(/\S|$/));
    if (beforeContent.includes('\t')) {
      throw new YamlLiteError('tabs are not allowed for indentation', lineNo);
    }
    const line = stripComment(raw, lineNo).replace(/\s+$/, '');
    if (line.trim() === '') return;
    if (line.trim() === '---' || line.trim() === '...') {
      // Only a leading document marker is allowed: a second one would mean
      // a multi-document stream, where a real YAML loader takes only the
      // first document (review E2S2-R4).
      if (sawDocStart || lines.length > 0) {
        throw new YamlLiteError('multiple documents are not supported', lineNo);
      }
      sawDocStart = true;
      return;
    }
    const indent = line.length - line.trimStart().length;
    if (indent % 2 !== 0) throw new YamlLiteError('indentation must be a multiple of 2 spaces', lineNo);
    lines.push({ indent, text: line.trim(), lineNo });
  });

  let pos = 0;

  function parseBlock(indent) {
    // Sequence?
    if (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) {
      const items = [];
      while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) {
        const { text, lineNo } = lines[pos];
        const rest = text.slice(2).trim();
        const colon = keyColonIndex(rest);
        if (colon === -1) {
          items.push(parseScalar(rest, lineNo));
          pos++;
        } else {
          // Mapping item: first pair sits on the dash line, siblings follow indented.
          const map = Object.create(null);
          const key = unquoteKey(rest.slice(0, colon), lineNo);
          const inlineValue = rest.slice(colon + 1).trim();
          pos++;
          if (inlineValue === '') {
            const next = lines[pos];
            map[key] = next && next.indent > indent + 2 ? parseBlock(next.indent) : null;
          } else map[key] = parseScalar(inlineValue, lineNo);
          const childIndent = indent + 2;
          while (pos < lines.length && lines[pos].indent === childIndent && !lines[pos].text.startsWith('- ')) {
            const child = lines[pos];
            const c = keyColonIndex(child.text);
            if (c === -1) throw new YamlLiteError('expected "key: value" inside sequence item', child.lineNo);
            const k = unquoteKey(child.text.slice(0, c), child.lineNo);
            if (Object.hasOwn(map, k)) throw new YamlLiteError(`duplicate key "${k}"`, child.lineNo);
            const v = child.text.slice(c + 1).trim();
            pos++;
            if (v === '') {
              const next = lines[pos];
              map[k] = next && next.indent > childIndent ? parseBlock(next.indent) : null;
            } else map[k] = parseScalar(v, child.lineNo);
          }
          items.push({ ...map });
        }
      }
      return items;
    }

    // Mapping
    const map = Object.create(null);
    while (pos < lines.length && lines[pos].indent === indent) {
      const { text, lineNo } = lines[pos];
      if (text.startsWith('- ')) break;
      const colon = keyColonIndex(text);
      if (colon === -1) throw new YamlLiteError(`expected "key: value", got "${text}"`, lineNo);
      const key = unquoteKey(text.slice(0, colon), lineNo);
      if (Object.hasOwn(map, key)) throw new YamlLiteError(`duplicate key "${key}"`, lineNo);
      const value = text.slice(colon + 1).trim();
      pos++;
      if (value === '') {
        const next = lines[pos];
        if (!next || next.indent <= indent) map[key] = null;
        else map[key] = parseBlock(next.indent);
      } else {
        map[key] = parseScalar(value, lineNo);
      }
    }
    return { ...map }; // hand back an ordinary object, prototype-free during construction
  }

  const result = lines.length === 0 ? {} : parseBlock(lines[0].indent);
  if (pos < lines.length) {
    throw new YamlLiteError(`unexpected indentation`, lines[pos].lineNo);
  }
  return result;
}

function keyColonIndex(text) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ':' && !inSingle && !inDouble && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      return i;
    }
  }
  return -1;
}

function unquoteKey(raw, lineNo) {
  const key = raw.trim();
  if (key === '') throw new YamlLiteError('empty key', lineNo);
  if ((key[0] === '"' && key.at(-1) === '"' && key.length > 1) ||
      (key[0] === "'" && key.at(-1) === "'" && key.length > 1)) {
    return unquote(key, lineNo);
  }
  // Keys go through the same subset guards as values (review E2S2-R4):
  // `&anchor key:` and `!!tag key:` must not be swallowed into the key name.
  rejectUnsupported(key, lineNo, 'key');
  return key;
}

/** Serialize a plain object back into the same subset (stable key order). */
export function stringify(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    return value
      .map((item) => {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const body = stringify(item, indent + 2);
          return `${pad}- ${body.slice(indent + 2)}`;
        }
        return `${pad}- ${formatScalar(item)}\n`;
      })
      .join('');
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => {
        if (v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)) {
          return `${pad}${formatKey(k)}:\n${stringify(v, indent + 2)}`;
        }
        if (v !== null && typeof v === 'object') return `${pad}${formatKey(k)}: ${Array.isArray(v) ? '[]' : 'null'}\n`;
        return `${pad}${formatKey(k)}: ${formatScalar(v)}\n`;
      })
      .join('');
  }
  return `${pad}${formatScalar(value)}\n`;
}

/**
 * Refuse to SERIALIZE an invisible codepoint, the same way this file already
 * refuses a newline and for the same reason.
 *
 * This subset has no lossless way to carry one. Double-quoted \uXXXX escapes
 * are real YAML but explicitly out of the subset — `unquote` rejects a
 * backslash rather than decode it half-way — so the only representations
 * available are RAW (a Trojan Source payload in a config file) or VISIBLY
 * ESCAPED (which parses back as different data and breaks the round trip this
 * file guarantees). Neither is acceptable, so the answer is the one
 * `formatScalar` already gives for newlines: fail loudly at serialization
 * time rather than write a file that reads back as something else.
 *
 * Refusing is the strongest fix available TO A SERIALIZER, which is a narrower
 * claim than the one that stood here first. The worst case is a poisoned value
 * PERSISTED to a config file: it would re-enter the conductor's context at
 * every session start, through a path where none of the runtime layers is
 * looking. This guard stops THIS WRITER from authoring such a file.
 *
 * It does NOT make the file impossible, and the earlier wording here said it
 * did — corrected after a review disproved it by measurement. `parse` is
 * untouched and reads a hand-written hostile file without complaint (measured:
 * 7 invisible codepoints straight into a value), and the file can arrive by an
 * editor, an agent's write tool, or a template copied from elsewhere. The
 * honest guarantee is "tyran will not author one", not "one cannot exist".
 * Closing the READ side is a separate decision with a live consumer question
 * behind it — `schema.mjs` is the only importer today and its parsed values do
 * not leave the validating function — so it is deliberately not done here.
 *
 * Measured before choosing: `stringify` has ZERO production consumers today —
 * only its own unit test imports it, and `schema.mjs` imports `parse` alone.
 * So the persisted-poison case is not reachable in this repository right now,
 * and this guard is prophylactic. It is still worth having, because "no caller
 * yet" is a fact about today and this module is published API.
 */
function rejectInvisible(s, what) {
  for (const ch of s) {
    const problem = invisibleProblem(ch.codePointAt(0));
    if (problem !== null) {
      throw new YamlLiteError(
        `cannot serialize a ${what} containing ${formatCodePoint(ch.codePointAt(0))} — ${problem}. ` +
          'This subset has no escape for it, so writing it would either hide it in the file ' +
          'or change the value on the way back.',
      );
    }
  }
}

function formatKey(key) {
  const s = String(key);
  if (s.includes('\n')) {
    // Mirrors the guard in formatScalar: a newline has no representation in
    // this subset, so refuse at serialization time instead of emitting a file
    // our own parser rejects with a confusing "unbalanced quote" (review
    // E2S2-R11, note 1).
    throw new YamlLiteError('cannot serialize a key containing a newline (no block scalars in this subset)');
  }
  rejectInvisible(s, 'key');
  if (s === '' || /[\s:#'"&*!|>[\]{},]/.test(s)) return `'${s.replace(/'/g, "''")}'`;
  return s;
}

function formatScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const s = String(value);
  if (s.includes('\n')) {
    // The subset has no block scalars, so a newline cannot be represented.
    // Failing loudly beats writing a file that reads back as different data
    // (review E2S2-R1).
    throw new YamlLiteError('cannot serialize a string containing a newline (no block scalars in this subset)');
  }
  rejectInvisible(s, 'string');
  const needsQuotes =
    s === '' ||
    /^\s|\s$/.test(s) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(s) ||
    /:\s/.test(s) ||
    /\s#/.test(s) || // ` #` would be read back as a comment (review E2S2-R1)
    s.includes("'") ||
    s.includes('"') || // an unquoted apostrophe now fails to parse (review E2S2-R11)
    Object.hasOwn(BOOL, s.toLowerCase()) ||
    s === 'null' ||
    s === '~' ||
    /^-?\d+(\.\d+)?$/.test(s);
  return needsQuotes ? `'${s.replace(/'/g, "''")}'` : s;
}
