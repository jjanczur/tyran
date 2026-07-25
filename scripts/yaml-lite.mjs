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
 * Rejected loudly: anchors/aliases (& *), tags (!!), multi-line scalars
 * (| >), flow mappings ({}), tabs for indentation, duplicate keys.
 */

const BOOL = { true: true, false: false, yes: true, no: false, on: true, off: false };

export class YamlLiteError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.line = line ?? null;
  }
}

function parseScalar(raw, lineNo) {
  const value = raw.trim();
  if (value === '') return '';
  if (value[0] === '&' || value[0] === '*') {
    throw new YamlLiteError('anchors and aliases are not supported', lineNo);
  }
  if (value.startsWith('!!')) throw new YamlLiteError('tags are not supported', lineNo);
  if (value === '|' || value === '>' || value.startsWith('|') || value.startsWith('>')) {
    throw new YamlLiteError('multi-line block scalars are not supported', lineNo);
  }
  if (value.startsWith('{')) throw new YamlLiteError('flow mappings are not supported', lineNo);
  if (value.startsWith('[')) {
    const inner = value.slice(1, value.lastIndexOf(']')).trim();
    if (!value.includes(']')) throw new YamlLiteError('unterminated flow sequence', lineNo);
    if (inner === '') return [];
    return inner.split(',').map((part) => parseScalar(part, lineNo));
  }
  if ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'")) {
    return value.slice(1, -1);
  }
  if (value === 'null' || value === '~') return null;
  if (value.toLowerCase() in BOOL) return BOOL[value.toLowerCase()];
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d*\.\d+$/.test(value)) return Number(value);
  return value;
}

function stripComment(line) {
  // Comments start at ` #` outside quotes; a leading `#` is a full-line comment.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Parse a YAML-subset document into a plain JS object. */
export function parse(text) {
  const rawLines = text.split('\n');
  const lines = [];
  rawLines.forEach((raw, i) => {
    const lineNo = i + 1;
    if (raw.includes('\t')) {
      const beforeContent = raw.slice(0, raw.search(/\S|$/));
      if (beforeContent.includes('\t')) throw new YamlLiteError('tabs are not allowed for indentation', lineNo);
    }
    const line = stripComment(raw).replace(/\s+$/, '');
    if (line.trim() === '' || line.trim() === '---') return;
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
          const map = {};
          const key = unquoteKey(rest.slice(0, colon), lineNo);
          const inlineValue = rest.slice(colon + 1).trim();
          pos++;
          if (inlineValue === '') map[key] = parseBlock(indent + 4);
          else map[key] = parseScalar(inlineValue, lineNo);
          const childIndent = indent + 2;
          while (pos < lines.length && lines[pos].indent === childIndent && !lines[pos].text.startsWith('- ')) {
            const child = lines[pos];
            const c = keyColonIndex(child.text);
            if (c === -1) throw new YamlLiteError('expected "key: value" inside sequence item', child.lineNo);
            const k = unquoteKey(child.text.slice(0, c), child.lineNo);
            if (k in map) throw new YamlLiteError(`duplicate key "${k}"`, child.lineNo);
            const v = child.text.slice(c + 1).trim();
            pos++;
            map[k] = v === '' ? parseBlock(childIndent + 2) : parseScalar(v, child.lineNo);
          }
          items.push(map);
        }
      }
      return items;
    }

    // Mapping
    const map = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const { text, lineNo } = lines[pos];
      if (text.startsWith('- ')) break;
      const colon = keyColonIndex(text);
      if (colon === -1) throw new YamlLiteError(`expected "key: value", got "${text}"`, lineNo);
      const key = unquoteKey(text.slice(0, colon), lineNo);
      if (key in map) throw new YamlLiteError(`duplicate key "${key}"`, lineNo);
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
    return map;
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
  if ((key[0] === '"' && key.at(-1) === '"') || (key[0] === "'" && key.at(-1) === "'")) {
    return key.slice(1, -1);
  }
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
          return `${pad}${k}:\n${stringify(v, indent + 2)}`;
        }
        if (v !== null && typeof v === 'object') return `${pad}${k}: ${Array.isArray(v) ? '[]' : 'null'}\n`;
        return `${pad}${k}: ${formatScalar(v)}\n`;
      })
      .join('');
  }
  return `${pad}${formatScalar(value)}\n`;
}

function formatScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const s = String(value);
  const needsQuotes =
    s === '' ||
    /^[\s]|[\s]$/.test(s) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(s) ||
    /:\s/.test(s) ||
    s.toLowerCase() in BOOL ||
    s === 'null' ||
    s === '~' ||
    /^-?\d+(\.\d+)?$/.test(s);
  return needsQuotes ? `'${s.replace(/'/g, "''")}'` : s;
}
