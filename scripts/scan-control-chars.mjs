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
 * Binaries are exempted only where .gitattributes DECLARES them binary, never
 * by an extension whitelist and never by a property of their contents — see
 * partitionTrackedFiles for why every content-derived exemption is defeatable
 * by editing the content, and why no file may leave the scan silently.
 *
 * CLI:
 *   node scan-control-chars.mjs [repo-root]
 * Exit: 0 clean · 1 forbidden characters found, or a tracked file that is
 *       neither decodable nor declared binary · 2 usage/IO error, or a scan
 *       that covered zero files
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
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
 * four bits each, so a determined smuggler can encode data with them. That is
 * an argument for the direction ADR-19 correction 1 already names — an
 * ALLOWLIST for machine-generated text, where the legal repertoire is narrow —
 * not for a nineteenth range in a denylist that will always be one Unicode
 * revision behind.
 */
export const DELIBERATELY_ALLOWED = Object.freeze([
  Object.freeze({ lo: 0xfe00, hi: 0xfe0f, why: 'variation selectors: U+FE0F is legal emoji presentation' }),
]);

/** Names worth spelling out; everything else falls back to its range label. */
const NAMES = Object.freeze({
  0x00: 'NUL',
  0x07: 'BEL',
  0x08: 'BACKSPACE',
  0x0b: 'VERTICAL TAB',
  0x0c: 'FORM FEED',
  0x0d: 'CARRIAGE RETURN',
  0x09: 'TAB',
  0x1b: 'ESC',
  0x0a: 'LF',
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
  0x00ad: 'SOFT HYPHEN',
  0x115f: 'HANGUL CHOSEONG FILLER',
  0x1160: 'HANGUL JUNGSEONG FILLER',
  0x180e: 'MONGOLIAN VOWEL SEPARATOR',
  0x2060: 'WORD JOINER',
  0x2061: 'FUNCTION APPLICATION',
  0x2062: 'INVISIBLE TIMES',
  0x2063: 'INVISIBLE SEPARATOR',
  0x2064: 'INVISIBLE PLUS',
  0x3164: 'HANGUL FILLER',
  0xffa0: 'HALFWIDTH HANGUL FILLER',
  0xfeff: 'BYTE ORDER MARK',
  0xfff9: 'INTERLINEAR ANNOTATION ANCHOR',
  0xfffa: 'INTERLINEAR ANNOTATION SEPARATOR',
  0xfffb: 'INTERLINEAR ANNOTATION TERMINATOR',
  0xe0001: 'LANGUAGE TAG',
});

/**
 * The name to print for a codepoint, or null when the range label says enough.
 *
 * TAG characters get their ASCII equivalent spelled out, because U+E0041 is
 * not a fact anyone can act on while `TAG for ASCII "A"` tells the reader what
 * the invisible text actually SAID. A gate that reports an unfixable finding
 * is an obstacle (ADR-19).
 */
function nameOf(cp) {
  if (NAMES[cp] !== undefined) return NAMES[cp];
  if (cp >= 0xe0020 && cp <= 0xe007e) {
    return `TAG for ASCII ${JSON.stringify(String.fromCharCode(cp - 0xe0000))}`;
  }
  return null;
}

function classify(cp) {
  for (const range of FORBIDDEN) {
    if (cp >= range.lo && cp <= range.hi) return range.what;
  }
  return null;
}

/**
 * The same rule, plus TAB and LF, for text that is a PATH rather than file
 * contents. The asymmetry is deliberate: a tab is ordinary text inside a file
 * and a catastrophe in a filename, where it makes one path print as two
 * columns in every tool that lists it — and a newline in a path breaks the
 * line-oriented output of all of them.
 */
function classifyInPath(cp) {
  if (cp === 0x09 || cp === 0x0a) return 'control character in a path';
  return classify(cp);
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
export function scanText(text, classifier = classify) {
  const findings = [];
  let line = 1;
  let column = 1;
  let byteOffset = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const what = classifier(cp);
    if (what !== null) {
      findings.push({
        line,
        column,
        byteOffset,
        codePoint: cp,
        name: nameOf(cp),
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

/**
 * Every forbidden codepoint in a PATH — a file's name or a symlink's target.
 * Both reach the reader through tool output and through the projections an
 * agent reads, so both are part of the repository's text even though neither
 * is inside a file.
 */
export function scanPath(path) {
  return scanText(path, classifyInPath);
}

/**
 * One finding as an operator-readable line: file, position, identity.
 *
 * `where` says which text the position refers to. Without it a hit at 1:5 in a
 * NAME reads as a hit at 1:5 in the contents, and the reader edits the wrong
 * thing — the same "unfixable finding" failure the byte offsets exist to avoid.
 */
export function formatFinding(file, f, where = 'content') {
  const name = f.name ? ` ${f.name}` : '';
  const site = where === 'content' ? '' : ` [in the ${where === 'name' ? 'file NAME' : 'symlink TARGET'}]`;
  return `${file}:${f.line}:${f.column} (byte ${f.byteOffset}): ${formatCodePoint(f.codePoint)}${name} — ${f.what}${site}`;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Whether a file's bytes decode as UTF-8. Never used as a silent exemption. */
function isValidUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Partition tracked files into what gets scanned, what is exempt, and what is
 * refused. Never an extension whitelist: a whitelist says nothing about the
 * next file type someone adds.
 *
 * The shape of this function matters more than its criteria, because of a
 * lesson this gate learned twice.
 *
 * First attempt: skip what GIT calls binary. That is circular. Git calls a
 * file binary when it finds a NUL in the first 8000 bytes, so a source file
 * poisoned with one stray NUL becomes "binary" the instant it is damaged and
 * leaves the scan for exactly the reason it should have been flagged. It
 * happened here: this repo's own fuzz test picked up a raw NUL, git
 * reclassified it, and the scan reported the tree clean over a poisoned file.
 *
 * Second attempt: skip what is not valid UTF-8. Weaker loop, same shape —
 * appending ONE 0xFF byte to a poisoned README makes it "not text" and the
 * bidi override inside it sails through under a green tick. Measured, not
 * feared.
 *
 * So the conclusion is not "find a better content test". ANY exemption
 * derived from a file's content can be manufactured by editing that content.
 * The fix is structural: **no file may leave the scan silently.**
 *
 *  - `exempt` — declared `binary` in .gitattributes. A real escape hatch, and
 *    it must stay one, or an undecodable asset would jam CI forever. It is
 *    listed in the output on EVERY run, including clean ones, so using it is
 *    a visible act in a diff and in a log rather than a quiet edit.
 *  - `refused` — not valid UTF-8 and NOT declared. This is an ERROR, not a
 *    skip: it is the shape of both attacks above, and the remedy is one line
 *    of .gitattributes that a reviewer can see.
 *  - everything else is scanned.
 *
 * Note what is deliberately NOT an exemption: `-text`. This repo sets
 * `tests/fixtures/** -text` to protect byte-exact goldens, and those goldens
 * are generated STATE.md files — precisely where the bidi bug behind ADR-19
 * landed. Excusing them would aim the gate away from its own motivating case.
 */
const LINK_REMEDY =
  'Git records the mode of every entry. Inspect it with:\n' +
  '    git ls-files -s -- <path>\n' +
  'A 120000 entry whose target cannot be read is either a damaged working tree\n' +
  '(re-checkout the path) or a target this scanner must not guess at.';

/**
 * The target of an entry git records as a symlink (mode 120000), as
 * `{target}` | `{exempt}` | `{refused}` — never a throw.
 *
 * Three outcomes, and the reason each exists:
 *
 *  - **ENOENT** — the working tree is dirty and the entry is simply absent.
 *    An exemption, reported like every other one.
 *  - **EINVAL** — readlink was handed something that is not a link. This is
 *    NOT exotic: `core.symlinks=false` is git's DEFAULT on Windows, and under
 *    it a clone materializes mode 120000 as an ordinary file whose CONTENTS
 *    are the target path, while `ls-files -s` still says 120000. Git has
 *    already told us this is a link, so the target is read from those bytes.
 *    Failing here would be a regression: the previous scanner read that file
 *    with readFileSync and caught the payload inside it.
 *  - **anything else** — a refusal with an actionable message, not a bare
 *    errno escaping as an exception. A gate that dies with a stack trace has
 *    not made a finding; it has broken, and exit 2 tells the reader nothing
 *    about what to do next.
 *
 * The target is read as BYTES in both branches. `readlinkSync` with no
 * encoding replaces undecodable bytes with U+FFFD, which would quietly sand
 * the poison off a target — while the same bytes inside a file's CONTENTS are
 * refused outright. One criterion cannot hold on one side and not the other,
 * or the weaker side is the real rule.
 */
function readLinkTarget(abs) {
  let bytes;
  try {
    bytes = readlinkSync(abs, 'buffer');
  } catch (err) {
    if (err.code === 'ENOENT') return { exempt: 'tracked but missing from the working tree' };
    if (err.code !== 'EINVAL') {
      return { refused: `git records this as a symlink (mode 120000) but its target could not be read (${err.code})` };
    }
    try {
      bytes = readFileSync(abs);
    } catch (readErr) {
      return {
        refused:
          'git records this as a symlink (mode 120000), it is not one on disk, ' +
          `and its contents could not be read either (${readErr.code})`,
      };
    }
  }
  if (!isValidUtf8(bytes)) {
    return { refused: 'the symlink target is not valid UTF-8, so it cannot be scanned without mangling it' };
  }
  return { target: bytes.toString('utf8') };
}

export function partitionTrackedFiles(cwd = process.cwd()) {
  const empty = { paths: [], scan: [], links: [], exempt: [], refused: [] };
  // `-s` for the mode, because a symlink must never be read with readFileSync:
  // that FOLLOWS the link, so a link pointing outside the repo would have some
  // other project's contents scanned in its place, and a dangling one would be
  // filed as "missing" and skipped — target unread either way. Git's own
  // record (mode 120000) is the authority here, not a filesystem stat.
  const listing = git(['ls-files', '-s', '-z'], cwd);
  const modes = new Map();
  for (const entry of listing.split('\0')) {
    if (entry === '') continue;
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    modes.set(entry.slice(tab + 1), entry.slice(0, entry.indexOf(' ')));
  }
  const candidates = [...modes.keys()];
  if (candidates.length === 0) return empty;

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

  const out = { paths: candidates, scan: [], links: [], exempt: [], refused: [] };
  for (const path of candidates) {
    if (modes.get(path) === '120000') {
      const outcome = readLinkTarget(resolve(cwd, path));
      if (outcome.target !== undefined) out.links.push({ file: path, target: outcome.target });
      else if (outcome.exempt !== undefined) out.exempt.push({ file: path, reason: outcome.exempt });
      else out.refused.push({ file: path, reason: outcome.refused, remedy: LINK_REMEDY });
      continue;
    }
    if (declaredBinary.has(path)) {
      out.exempt.push({ file: path, reason: 'declared `binary` in .gitattributes' });
      continue;
    }
    let bytes;
    try {
      bytes = readFileSync(resolve(cwd, path));
    } catch (err) {
      // Tracked but absent is a dirty working tree, not an attack. Still
      // reported, because "the gate looked at fewer files than you think" is
      // exactly the class of fact this scanner must never keep to itself.
      if (err.code === 'ENOENT') {
        out.exempt.push({ file: path, reason: 'tracked but missing from the working tree' });
        continue;
      }
      throw err;
    }
    if (!isValidUtf8(bytes)) {
      out.refused.push({
        file: path,
        reason: 'not valid UTF-8 and not declared `binary` in .gitattributes',
      });
      continue;
    }
    out.scan.push(path);
  }
  return out;
}

/**
 * Scan every tracked file that is neither exempt nor refused.
 * Returns findings plus the full accounting of what was NOT scanned.
 */
export function scanRepo(cwd = process.cwd()) {
  const { paths, scan, links, exempt, refused } = partitionTrackedFiles(cwd);
  const results = [];
  // NAMES first, and for EVERY tracked path — including exempt and refused
  // ones. `binary` exempts a file's bytes; nothing exempts its name, which
  // still reaches `git log --stat`, a PR diff header and the projections an
  // agent reads. An override in a name mirrors the rest of the line exactly
  // as one inside a table row does.
  for (const file of paths) {
    const findings = scanPath(file);
    if (findings.length > 0) results.push({ file, findings, where: 'name' });
  }
  for (const { file, target } of links) {
    const findings = scanPath(target);
    if (findings.length > 0) results.push({ file, findings, where: 'target' });
  }
  for (const file of scan) {
    const findings = scanText(readFileSync(resolve(cwd, file), 'utf8'));
    if (findings.length > 0) results.push({ file, findings, where: 'content' });
  }
  return { scanned: scan.length + links.length, exempt, refused, results };
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
  // Announced BEFORE any verdict, on every run, clean or not — the same rule
  // the file exemptions below follow, for the same reason. A gap that lives
  // only in a source comment is invisible exactly where it is load-bearing:
  // fifty variation selectors carry twenty-five bytes of ASCII past all three
  // layers of this repo's defences, and without this line the gate would print
  // "clean" over them without a word. Derived from the export, never typed
  // twice, so emptying the export cannot leave the promise standing.
  for (const gap of DELIBERATELY_ALLOWED) {
    console.log(
      `scan-control-chars: deliberate gap: ${formatCodePoint(gap.lo)}..${formatCodePoint(gap.hi)} — ${gap.why}`,
    );
  }

  // Announced BEFORE any verdict, on every run, clean or not. An exemption
  // that only shows up when something else already failed is not visible —
  // and the whole point is that leaving the scan can never be quiet.
  for (const { file, reason } of report.exempt) {
    console.log(`scan-control-chars: not scanned: ${file} — ${reason}`);
  }
  if (report.exempt.length > 0) {
    console.log(
      `scan-control-chars: ${report.exempt.length} file(s) exempt, ${report.scanned} scanned.`,
    );
  }

  // Refusals are diagnosed BEFORE the empty-scan check, so the specific,
  // actionable message wins over the generic one when a repo's only file is
  // the undecodable one.
  if (report.refused.length > 0) {
    for (const { file, reason } of report.refused) {
      console.error(`scan-control-chars: ${file}: ${reason}`);
    }
    // Two classes of refusal, two remedies. Printing the `binary` advice for a
    // broken symlink would send the reader to declare a file that is not the
    // problem — an unactionable message is how a gate becomes an obstacle.
    const undecodable = report.refused.filter((r) => r.remedy === undefined);
    if (undecodable.length > 0) {
      console.error(
        `\nscan-control-chars: ${undecodable.length} tracked file(s) could not be read as\n` +
          'text and are not declared binary. This is refused rather than skipped: one\n' +
          'stray byte is enough to make a poisoned text file undecodable, which would\n' +
          'otherwise carry it out of the scan under a green tick.\n' +
          'If the file really is binary, declare it in .gitattributes:\n' +
          `    ${undecodable[0].file} binary`,
      );
    }
    for (const remedy of new Set(report.refused.map((r) => r.remedy).filter((r) => r !== undefined))) {
      console.error(`\n${remedy}`);
    }
    process.exit(1);
  }

  // Nothing scanned at all is never success. `* binary` in .gitattributes
  // silences this gate completely and would otherwise exit 0 over an empty
  // scan — a green tick meaning "we looked at nothing".
  if (report.scanned === 0) {
    console.error(
      'scan-control-chars: refusing to pass — 0 files were scanned.\n' +
        `  ${report.exempt.length} exempt, ${report.refused.length} refused. A gate that\n` +
        '  looked at nothing must not report success. Check .gitattributes for a\n' +
        '  rule that marks everything `binary`.',
    );
    process.exit(2);
  }

  if (report.results.length === 0) {
    console.log(`scan-control-chars: clean (${report.scanned} tracked text files)`);
    return;
  }
  let total = 0;
  for (const { file, findings, where } of report.results) {
    total += findings.length;
    for (const f of findings.slice(0, MAX_PER_FILE)) {
      console.error(formatFinding(file, f, where));
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
