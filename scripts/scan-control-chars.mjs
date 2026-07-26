#!/usr/bin/env node
/**
 * scan-control-chars — refuse raw control and bidi characters in tracked files.
 *
 * Why this is a gate and not a lint rule (ADR-19): writing and editing tools
 * routinely turn the TEXT of an escape (backslash-u-2-0-2-E) into the actual
 * character. Seven independent occurrences landed in a single working session
 * of this repo, twice by agents who knew about the problem. The damage is
 * silent, which is what makes it expensive:
 *  - one NUL byte in a documentation file made `grep` return zero matches
 *    with exit 0 — the file looked empty to every search that followed;
 *  - an unterminated bidi override in a generated STATE.md mirrored every
 *    later column of the table row, so the rendered document disagreed with
 *    its own bytes (Trojan Source).
 *
 * The scan is byte-honest: it reports the file, the line, the column, the byte
 * offset and the codepoint, because "there is an invisible character somewhere
 * in this file" is not a fixable finding — it is a gate people switch off.
 *
 * Binary files are excluded through git itself, never through an extension
 * whitelist: a whitelist says nothing about the next file type someone adds.
 *
 * CLI:
 *   node scan-control-chars.mjs [repo-root]
 * Exit: 0 clean · 1 forbidden characters found · 2 usage/IO error
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Forbidden codepoint ranges, as numbers rather than string escapes — on
 * purpose. A regex literal written with escape notation is one careless
 * "helpful" rewrite away from becoming the very character it bans, and this
 * file would then fail its own scan. Numbers cannot be mangled that way, and
 * they double as the reporting vocabulary.
 */
export const FORBIDDEN = Object.freeze([
  // C0 controls, except TAB (0x09) and LF (0x0A) which are legal text.
  // CR (0x0D) is deliberately IN: this repo normalizes to LF (.gitattributes).
  Object.freeze({ lo: 0x00, hi: 0x08, what: 'C0 control character' }),
  Object.freeze({ lo: 0x0b, hi: 0x1f, what: 'C0 control character' }),
  Object.freeze({ lo: 0x7f, hi: 0x9f, what: 'DEL / C1 control character' }),
  Object.freeze({ lo: 0x061c, hi: 0x061c, what: 'bidi mark (ARABIC LETTER MARK)' }),
  Object.freeze({ lo: 0x200b, hi: 0x200f, what: 'zero-width or directional mark' }),
  Object.freeze({ lo: 0x202a, hi: 0x202e, what: 'bidi embedding or override' }),
  Object.freeze({ lo: 0x2066, hi: 0x2069, what: 'bidi isolate' }),
  Object.freeze({ lo: 0xfeff, hi: 0xfeff, what: 'byte order mark / zero-width no-break space' }),
]);

/** Names worth spelling out; everything else falls back to its range label. */
const NAMES = Object.freeze({
  0x00: 'NUL',
  0x07: 'BEL',
  0x08: 'BACKSPACE',
  0x0b: 'VERTICAL TAB',
  0x0c: 'FORM FEED',
  0x0d: 'CARRIAGE RETURN',
  0x1b: 'ESC',
  0x7f: 'DELETE',
  0x061c: 'ARABIC LETTER MARK',
  0x200b: 'ZERO WIDTH SPACE',
  0x200c: 'ZERO WIDTH NON-JOINER',
  0x200d: 'ZERO WIDTH JOINER',
  0x200e: 'LEFT-TO-RIGHT MARK',
  0x200f: 'RIGHT-TO-LEFT MARK',
  0x202a: 'LEFT-TO-RIGHT EMBEDDING',
  0x202b: 'RIGHT-TO-LEFT EMBEDDING',
  0x202c: 'POP DIRECTIONAL FORMATTING',
  0x202d: 'LEFT-TO-RIGHT OVERRIDE',
  0x202e: 'RIGHT-TO-LEFT OVERRIDE',
  0x2066: 'LEFT-TO-RIGHT ISOLATE',
  0x2067: 'RIGHT-TO-LEFT ISOLATE',
  0x2068: 'FIRST STRONG ISOLATE',
  0x2069: 'POP DIRECTIONAL ISOLATE',
  0xfeff: 'BYTE ORDER MARK',
});

function classify(cp) {
  for (const range of FORBIDDEN) {
    if (cp >= range.lo && cp <= range.hi) return range.what;
  }
  return null;
}

/** UTF-8 width of a codepoint — lets us report byte offsets without re-encoding. */
function utf8Len(cp) {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/** `U+00A0` style, always at least four hex digits. */
export function formatCodePoint(cp) {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Every forbidden codepoint in `text`, each with line, column (in codepoints),
 * byte offset and identity. Pure and file-free, which is what makes the rule
 * itself testable rather than only its command-line wrapper.
 */
export function scanText(text) {
  const findings = [];
  let line = 1;
  let column = 1;
  let byteOffset = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const what = classify(cp);
    if (what !== null) {
      findings.push({
        line,
        column,
        byteOffset,
        codePoint: cp,
        name: NAMES[cp] ?? null,
        what,
      });
    }
    byteOffset += utf8Len(cp);
    if (cp === 0x0a) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return findings;
}

/** One finding as an operator-readable line: file, position, identity. */
export function formatFinding(file, f) {
  const name = f.name ? ` ${f.name}` : '';
  return `${file}:${f.line}:${f.column} (byte ${f.byteOffset}): ${formatCodePoint(f.codePoint)}${name} — ${f.what}`;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Whether a file's bytes are valid UTF-8. This is the content criterion for
 * "is it text", and the choice matters more than it looks.
 *
 * The obvious criterion — git's own binary sniffing, via `ls-files --eol`
 * reporting `i/-text` — is CIRCULAR here, and it bit this very story. Git
 * calls a file binary when it finds a NUL in the first 8000 bytes. A source
 * file that gets poisoned with one stray NUL therefore becomes "binary" the
 * instant it is damaged, and a scanner that trusts git's answer excludes it
 * for exactly the reason it should have been flagged. That happened: this
 * repo's own fuzz test picked up a raw NUL, git reclassified it as binary,
 * and the scan reported "clean" over a poisoned tracked file.
 *
 * Valid UTF-8 has no such feedback loop. Real binaries (the JPEG in assets/)
 * fail it on their first stray byte; a NUL-poisoned Markdown or JavaScript
 * file is still perfectly valid UTF-8, so it stays in scope and gets caught.
 */
function isValidUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tracked files worth scanning — decided by git and by bytes, never by an
 * extension list, because a whitelist says nothing about the next file type
 * someone adds.
 *
 * A file is skipped only when:
 *  - .gitattributes EXPLICITLY marks it `binary` (an author's declaration,
 *    honoured even when the bytes look like text), or
 *  - its bytes are not valid UTF-8, so it cannot be source or documentation.
 *
 * Note what is deliberately NOT an exemption. `-text` is not: this repo sets
 * `tests/fixtures/** -text` to protect byte-exact goldens, and those goldens
 * are generated STATE.md files — precisely where the bidi bug that motivated
 * ADR-19 actually landed. Excluding them would aim the gate away from the
 * target. A binary file that happens to be valid UTF-8 will be scanned and
 * will fail; the fix is one line of .gitattributes, and it fails LOUDLY,
 * which is the trade this repo's rules ask for.
 */
export function listTextFiles(cwd = process.cwd()) {
  const listing = git(['ls-files', '-z'], cwd);
  const candidates = listing.split('\0').filter((p) => p !== '');
  if (candidates.length === 0) return [];

  const attr = execFileSync('git', ['check-attr', '-z', '--stdin', 'binary'], {
    cwd,
    encoding: 'utf8',
    input: candidates.join('\0') + '\0',
    maxBuffer: 64 * 1024 * 1024,
  });
  // NUL-separated triples: path, attribute name, value.
  const declaredBinary = new Set();
  const fields = attr.split('\0');
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] === 'set') declaredBinary.add(fields[i]);
  }

  return candidates.filter((path) => {
    if (declaredBinary.has(path)) return false;
    try {
      return isValidUtf8(readFileSync(resolve(cwd, path)));
    } catch (err) {
      if (err.code === 'ENOENT') return false; // tracked but absent: dirty tree
      throw err;
    }
  });
}

/** Scan every tracked text file under `cwd`. Returns findings grouped by file. */
export function scanRepo(cwd = process.cwd()) {
  const files = listTextFiles(cwd);
  const results = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(resolve(cwd, file), 'utf8');
    } catch (err) {
      // A tracked file missing from the working tree is a dirty checkout, not
      // a scan finding. In CI it cannot happen; locally it must not fail hard.
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    const findings = scanText(text);
    if (findings.length > 0) results.push({ file, findings });
  }
  return { scanned: files.length, results };
}

// ------------------------------------------------------------------- CLI

/** Findings printed per file before we stop repeating ourselves. */
const MAX_PER_FILE = 20;

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((a) => a.startsWith('-'))) {
    console.error('usage: scan-control-chars.mjs [repo-root]');
    process.exit(2);
  }
  const cwd = resolve(args[0] ?? process.cwd());
  let report;
  try {
    report = scanRepo(cwd);
  } catch (err) {
    console.error(`scan-control-chars: ${err.message}`);
    process.exit(2);
  }
  if (report.results.length === 0) {
    console.log(`scan-control-chars: clean (${report.scanned} tracked text files)`);
    return;
  }
  let total = 0;
  for (const { file, findings } of report.results) {
    total += findings.length;
    for (const f of findings.slice(0, MAX_PER_FILE)) {
      console.error(formatFinding(file, f));
    }
    if (findings.length > MAX_PER_FILE) {
      console.error(`${file}: ... and ${findings.length - MAX_PER_FILE} more in this file`);
    }
  }
  console.error(
    `\nscan-control-chars: ${total} forbidden character(s) in ${report.results.length} of ` +
      `${report.scanned} tracked text files.\n` +
      'These are RAW control/bidi characters, not escape sequences. A tool almost\n' +
      'certainly turned the text of an escape into the character itself. Write the\n' +
      'escape notation instead, or build the character with String.fromCodePoint().',
  );
  process.exit(1);
}

/** See journal.mjs — both sides canonicalized, or a symlinked path no-ops silently. */
function canonicalPath(path) {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  return canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(moduleUrl));
}

if (isMainModule(import.meta.url)) main();
