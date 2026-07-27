#!/usr/bin/env node
/**
 * write-guard — a raw control or bidi character does not reach a file.
 *
 * ## Why a second layer at all
 *
 * `scripts/scan-control-chars.mjs` already refuses these characters in tracked
 * files, but it runs in CI — AFTER the write, after the commit, on a machine
 * that is not the author's. This one runs at the moment of the write, which is
 * the only moment at which the answer is cheap and the cause is still visible.
 *
 * The need is not theoretical and it is not about an attacker. In this
 * repository's own construction, editing tools replaced the TEXT of an escape
 * with the character itself **nine times in one session, across three agents,
 * twice inside the very code written to prevent it**. Every occurrence was
 * silent. One NUL byte made `grep` return zero matches with exit 0, so the
 * file looked empty to every search that followed it.
 *
 * ## A gate on ONE entrance is not a gate
 *
 * That is why this is registered for every tool that writes file content, not
 * for the one that happens to be the usual suspect. The set is not a judgement
 * call: `FILE_WRITING_TOOLS` is imported from `scripts/hooks-check.mjs`, where
 * it is transcribed from the platform's OWN enumeration of the tools whose
 * input adds file content (`Edit`, `Write`, `NotebookEdit`). `Bash` is
 * registered alongside them for a different reason, stated under LIMITS below.
 *
 * ## The rule is imported, never restated
 *
 * The membership question — "is this codepoint invisible?" — is asked of
 * `scanText`, which asks `invisibleProblem` in `scripts/invisible.mjs`. This
 * file contains no list of codepoints and no character class, deliberately:
 * ADR-19 correction 1 measured three spellings of that rule disagreeing on 456
 * codepoints, with the weakest spelling standing closest to the reader. A
 * fourth spelling here would recreate exactly that, in the layer with the
 * shortest distance to a file on disk.
 *
 * ## Why the whole input is walked, not three known fields
 *
 * Measured: the platform types `tool_input` as `h.unknown()`. It does not
 * validate the shape, so the shape is genuinely arbitrary and a guard keyed on
 * `content` / `new_string` / `new_source` would be correct for exactly today's
 * three tools and silently blind for the fourth. Every string in the payload
 * is therefore scanned, at any depth, and a payload this guard cannot walk to
 * the bottom is REFUSED rather than passed — the coverage doctrine the secrets
 * gate arrived at the hard way: a partial scan that reports nothing looks
 * exactly like a clean one.
 *
 * ## LIMITS, stated because an unstated limit is a false guarantee
 *
 *  - **For `Bash` this guard checks the TEXT of the command, never the effect
 *    of running it. That is a KNOWN, MEASURED HOLE, not a theoretical one.**
 *    Review ran it live: a `Write` carrying a TAG character was refused, and
 *    in the same turn the model proposed `printf` via Bash by itself. That
 *    route worked, because the command text was pure ASCII and the character
 *    only came into existence when the shell expanded the escape:
 *
 *        $ od -c payload.txt
 *        0000000    X 363 240 201 201   Y      <- UTF-8 for U+E0041
 *
 *    `decodeShellEscapes` now closes that specific route by decoding escape
 *    notations in the command text. It is a DENYLIST and therefore a FLOOR,
 *    NOT A CEILING — `ESCAPE_DECLARED_MISSES` enumerates what still gets
 *    through, and the largest entry is unavoidable: a character assembled at
 *    runtime, or written by any program the command launches, cannot be seen
 *    without executing the command. So the honest claim for Bash is "the
 *    obvious routes are closed", never "covered".
 *  - **MCP tools ARE covered**, via the `mcp__.*` alternative — see
 *    `MCP_TOOL_PATTERN` for what that costs. What is still NOT covered is a
 *    tool whose name contains no `mcp__` and is not one of the four named
 *    ones; there is no way to enumerate those in advance.
 *  - **CR (U+000D) is forbidden**, so an Edit against a file with CRLF line
 *    endings is refused. That is the shared rule, not a local choice, and it
 *    is the one place this gate is likely to bounce honest work; the refusal
 *    says so and names the remedy.
 */
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FILE_WRITING_TOOLS } from '../../scripts/hooks-check.mjs';
import { formatCodePoint, formatFinding, scanPath, scanText } from '../../scripts/scan-control-chars.mjs';
import { PASS, field, main, runGate } from './hook-io.mjs';

/**
 * This gate's own budget, well under the `timeout` its hooks.json entry
 * declares (ADR-22 point 2); a test reads both numbers and refuses to let them
 * cross.
 *
 * Sized from measurement rather than from a round number that felt safe.
 * `hook-io` caps stdin at MAX_INPUT_BYTES (1 MiB), and `scanText` over 1 MiB
 * of text costs 13.8 ms on this machine; the astral worst case — 200 000
 * codepoints that are all surrogate pairs — costs 9.4 ms. The work is pure
 * CPU over an in-memory object with no I/O and no child process, so 2 000 ms
 * is roughly 130x the measured ceiling. It exists to bound a pathological
 * input, not to accommodate a slow one.
 */
export const DEADLINE_MS = 2000;

/** Tools registered by NAME: the platform's own set, plus Bash. */
export const GUARDED_TOOLS = Object.freeze([...FILE_WRITING_TOOLS, 'Bash']);

/**
 * The alternative that covers every MCP server, and the reason it is here.
 *
 * The first version of this file declared MCP tools out of scope because "the
 * equality branch cannot wildcard them". That sentence is true and the
 * conclusion drawn from it was false: nothing forces the matcher to STAY in
 * the equality branch. Adding a single alternative containing `.` and `*`
 * moves the whole matcher into the regex branch, where `mcp__.*` covers every
 * server that exists or will exist. Measured on the verified predicate:
 *
 *     Write · Edit · NotebookEdit · Bash            -> match
 *     mcp__filesystem__write_file                   -> match
 *     Read · NotebookRead · Glob · Grep · WebFetch  -> no match
 *     TaskOutput · WriteSomething                  -> no match (anchored)
 *
 * A filesystem MCP server is today the commonest FOURTH way to write a file,
 * and the story is binding: a gate on one entrance is not a gate.
 *
 * THE COSTS, stated rather than discovered later:
 *
 *  - The whole alternation is ANCHORED, `^(...)$`, and that is load-bearing
 *    rather than tidy. Unanchored, the platform retries a regex against every
 *    ALIAS of the query, so `Bash` also matched `TaskOutput` — whose alias
 *    `BashOutputTool` contains it — and `Write` matched any `WriteSomething`.
 *    Measured both ways; anchoring costs nothing and removes both. `doctor
 *    --hooks` flags the unanchored form, and it was right to.
 *  - The guard still runs on READ-ONLY MCP tools: `mcp__.*` cannot tell a
 *    reader from a writer, because the name is all there is. That costs one
 *    process per call and scans strings that were never going to reach a file.
 *    Accepted: the alternative is enumerating servers we cannot know.
 *  - Coverage refusals were the live risk, so they were measured rather than
 *    argued: across 401 local transcripts, real MCP tool inputs reach depth 2
 *    and 4 strings at worst, against this guard's caps of 32 and 10 000. The
 *    refusal path does not fire on real MCP traffic.
 */
export const MCP_TOOL_PATTERN = 'mcp__.*';

/**
 * The exact matcher string `hooks.json` must carry. Exported so the
 * registration can be asserted against the code rather than kept in step by
 * somebody remembering — a matcher and the guard behind it drifting apart is
 * the failure this whole story is about.
 */
export const GUARD_MATCHER = `^(${[...GUARDED_TOOLS, MCP_TOOL_PATTERN].join('|')})$`;

/**
 * Input keys whose value is a PATH rather than file content.
 *
 * They get the disjoint identifier rule as well, because a tab or a newline is
 * ordinary text inside a file and a catastrophe in a name — one path prints as
 * two columns in every tool that lists it. `scanPath` is the existing answer
 * for that; this is a list of KEYS, not a second rule.
 */
const PATH_KEYS = Object.freeze(['file_path', 'notebook_path', 'path', 'filePath']);

/** How deep a tool_input may nest before this gate stops trusting its own walk. */
export const MAX_DEPTH = 32;

/** How many string values it will look at before it stops trusting the walk. */
export const MAX_STRINGS = 10000;

/** Findings named individually in a refusal before it stops repeating. */
const MAX_FINDINGS_SHOWN = 10;

/** Raised when the payload could not be walked to the bottom. */
export class CoverageFailure extends Error {}

// ------------------------------------------- escapes inside a shell command

/**
 * Named escapes worth decoding, and the ones deliberately left out.
 *
 * `\e`/`\E` mean one thing only: the ESC character. `\a` likewise. But `\b`,
 * `\f`, `\v` and `\r` are ALSO regular-expression syntax — `grep -E '\bword\b'`
 * is ordinary work, and refusing it would be the crying-wolf failure ADR-19
 * warns about, on a command that writes nothing at all. They are left out on
 * purpose and named in `ESCAPE_DECLARED_MISSES` rather than forgotten.
 *
 * `\n` and `\t` are absent for a different reason: they decode to LF and TAB,
 * which the invisibility rule calls legal text. They are not misses.
 */
const NAMED_ESCAPES = Object.freeze(
  Object.assign(Object.create(null), { e: 0x1b, E: 0x1b, a: 0x07 }),
);

/**
 * Escape notations a shell materializes into a real character.
 *
 * Order matters: the hex and Unicode forms are tried before the octal run, so
 * `\x1b` is not read as `\` + `x` + digits.
 */
const ESCAPE_RE = /\\(U[0-9a-fA-F]{1,8}|u[0-9a-fA-F]{1,4}|x[0-9a-fA-F]{1,2}|[0-7]{1,3}|[eEa])/g;

/**
 * WHAT THIS DENYLIST DOES NOT CATCH — the floor, not the ceiling.
 *
 * Stated in the same shape as the secrets gate's declared misses, and for the
 * same reason: a denylist whose gaps live only in someone's head is a false
 * guarantee. Every entry here is a way to put a forbidden code point into a
 * file through `Bash` that this guard will NOT stop.
 */
export const ESCAPE_DECLARED_MISSES = Object.freeze([
  'the character assembled at runtime, from a variable, a command substitution, ' +
    'base64, xxd, a file already on disk, or any program the command launches',
  'the named escapes \\b \\f \\v \\r, left out because they are also regular-expression ' +
    'syntax and refusing `grep -E "\\bword\\b"` would cost more than it buys ' +
    '(their hex and octal spellings ARE caught)',
  'a here-doc whose body is fed to an interpreter that decodes escapes itself',
  'anything a script writes once it is running — this guard reads the COMMAND, ' +
    'never the effect of running it',
]);

/**
 * Escape notations in `text` that decode to a forbidden code point.
 *
 * The membership question is still `invisibleProblem`'s, asked through the
 * same `scanText` the rest of this file uses — this function only performs the
 * DECODING that the shell would perform, and hands the result to the one
 * answer. `\n` and `\t` therefore pass here exactly as a raw LF or TAB does,
 * with no second opinion about what is legal.
 */
export function decodeShellEscapes(text) {
  const out = [];
  for (const match of String(text).matchAll(ESCAPE_RE)) {
    const body = match[1];
    let cp;
    if (body[0] === 'U' || body[0] === 'u' || body[0] === 'x') cp = Number.parseInt(body.slice(1), 16);
    else if (/^[0-7]+$/.test(body)) cp = Number.parseInt(body, 8);
    else cp = NAMED_ESCAPES[body];
    if (!Number.isInteger(cp) || cp > 0x10ffff) continue;
    // Surrogates are not scalar values and `String.fromCodePoint` throws on
    // them; a shell cannot produce one either. Skipping is correct, and doing
    // it here keeps the scan from crashing on `\ud800`.
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const problem = scanText(String.fromCodePoint(cp));
    if (problem.length > 0) {
      out.push({ notation: match[0], codePoint: cp, index: match.index, hit: problem[0] });
    }
  }
  return out;
}

/**
 * Every string in `value`, with the path that reaches it.
 *
 * Walks arrays and plain objects. A cycle is impossible in a JSON payload, but
 * the depth and count caps are enforced anyway and they REFUSE rather than
 * truncate: this function's answer is used to say "the input is clean", and a
 * walk that quietly stopped early would make that sentence false in exactly
 * the case someone constructed on purpose.
 */
export function collectStrings(value, { maxDepth = MAX_DEPTH, maxStrings = MAX_STRINGS } = {}) {
  const out = [];
  const walk = (node, path, depth) => {
    if (depth > maxDepth) {
      throw new CoverageFailure(`tool input nests deeper than ${maxDepth} levels at ${path || '(root)'}`);
    }
    // `>=`, not `>`: the check runs BEFORE the push, so `>` admitted one
    // string more than the cap it advertises. Safe direction, still wrong.
    if (out.length >= maxStrings) {
      throw new CoverageFailure(`tool input holds more than ${maxStrings} string values`);
    }
    if (typeof node === 'string') {
      out.push({ path, value: node });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    if (node !== null && typeof node === 'object') {
      // Own keys only: a payload carrying `__proto__` is an own property after
      // JSON.parse, and walking the prototype chain would scan Object.prototype.
      for (const key of Object.keys(node)) {
        walk(node[key], path === '' ? key : `${path}.${key}`, depth + 1);
      }
    }
    // numbers, booleans, null: nothing to scan, nothing to hide in.
  };
  walk(value, '', 0);
  return out;
}

/**
 * Keys whose value is a SHELL COMMAND, i.e. text a shell will interpret.
 *
 * The escape scan is confined to these, and the boundary is load-bearing
 * rather than cautious. In file CONTENT, `\x1b` is not a control character —
 * it is the escape NOTATION, which is precisely what this repository tells
 * people to write instead of the raw byte. Decoding escapes there would refuse
 * the remedy the refusal itself recommends, and would make the guard reject
 * most of its own source. In a shell command the same four characters become
 * a real ESC at execution time. Same text, opposite meaning, so the rule
 * cannot be the same.
 */
const SHELL_COMMAND_KEYS = Object.freeze(['command']);

/** True when this key names a shell command rather than file content. */
function isShellCommandKey(path, toolName) {
  const leaf = path.split('.').at(-1)?.replace(/\[\d+\]$/, '') ?? '';
  return SHELL_COMMAND_KEYS.includes(leaf) || (toolName === 'Bash' && leaf === '');
}

/** True when this key names a path, so the identifier rule applies too. */
function isPathKey(path) {
  const leaf = path.split('.').at(-1)?.replace(/\[\d+\]$/, '') ?? '';
  return PATH_KEYS.includes(leaf);
}

/**
 * Every forbidden codepoint in a tool input, with the field that carries it.
 *
 * Iterates CODEPOINTS, not UTF-16 units, because `scanText` does — and that is
 * the difference between catching the TAG block and not. U+E0001..U+E007F are
 * surrogate PAIRS, and neither half is invisible on its own, so a unit-wise
 * walk sees 0xDB40 and 0xDC01, finds nothing wrong with either, and reports
 * success over a payload that spells arbitrary ASCII in invisible characters.
 */
export function scanToolInput(toolInput, options = {}) {
  const { toolName = '', ...walkOptions } = options;
  const findings = [];
  for (const { path, value } of collectStrings(toolInput, walkOptions)) {
    const where = isPathKey(path) ? 'name' : 'content';
    const hits = where === 'name' ? scanPath(value) : scanText(value);
    for (const hit of hits) findings.push({ field: path, where, hit });
    // A shell command carries a SECOND way to reach a file: an escape the
    // shell expands at execution time. Measured live by review — the model
    // proposed this route by itself, in the same turn a Write was refused,
    // and it worked.
    if (!isShellCommandKey(path, toolName)) continue;
    for (const esc of decodeShellEscapes(value)) {
      findings.push({ field: path, where: 'shell-escape', hit: esc.hit, notation: esc.notation });
    }
  }
  return findings;
}

const CARRIAGE_RETURN = 0x0d;

/** The refusal text: what, where, and what to do instead. */
export function refusalFor(toolName, findings) {
  // "raw" is only true when the characters are already there; for an escape
  // the whole point is that they are not yet. A refusal that misdescribes what
  // it saw sends the reader looking for the wrong thing.
  const onlyEscapes = findings.every((f) => f.where === 'shell-escape');
  const lines = [
    `tyran write-guard: refusing this ${toolName} — it would ${onlyEscapes ? 'expand' : 'write'} ` +
      `${findings.length} ${onlyEscapes ? 'escape sequence(s) into invisible character(s)' : 'raw control or invisible character(s)'}` +
      `${onlyEscapes ? ' in a file' : ' into a file'}.`,
    '',
  ];
  for (const f of findings.slice(0, MAX_FINDINGS_SHOWN)) {
    if (f.where === 'shell-escape') {
      // Rendered here rather than through `formatFinding`, which knows three
      // sites and would have labelled this one "in the symlink TARGET".
      lines.push(
        `  ${f.field}: ${f.notation} would be expanded by the shell into ` +
          `${formatCodePoint(f.hit.codePoint)}${f.hit.name ? ' ' + f.hit.name : ''} — ${f.hit.what}`,
      );
      continue;
    }
    lines.push(`  ${formatFinding(f.field, f.hit, f.where)}`);
  }
  if (findings.length > MAX_FINDINGS_SHOWN) {
    lines.push(`  ... and ${findings.length - MAX_FINDINGS_SHOWN} more`);
  }
  lines.push('');
  if (onlyEscapes) {
    lines.push(
      'The command text is clean ASCII, but the SHELL would expand these notations into the real',
      'characters at execution time, and the file on disk would carry them.',
      '',
      'If you meant to write the notation itself, quote it so the shell cannot expand it',
      "(single quotes with printf %s, or a here-doc with a quoted delimiter).",
    );
  } else {
    lines.push(
      'These are RAW characters, not escape sequences. A writing or editing tool has almost certainly',
      'turned the TEXT of an escape into the character itself — it happened nine times in one session',
      'while this repository was being built, twice inside the code meant to prevent it.',
      '',
      'Write the escape notation instead, or build the character explicitly:',
      '    const NUL = String.fromCodePoint(0);',
    );
  }
  // The deterrent, and the answer to "should a refusal name other tools".
  //
  // It should not, and this one never did — the ROUTE was proposed by the model
  // itself, unprompted, in the same turn a Write was refused ("use Bash, which
  // would bypass this guard"). Measured, and it worked. Removing helpful text
  // would not have prevented that; the model reasoned about the tool surface,
  // not about this message.
  //
  // So the fix is not silence, which would only leave a refusal with no way
  // forward — the shape ADR-19 says produces someone looking for a way around.
  // It is to say plainly that the rule is not tool-specific, so the obvious
  // next idea is answered before it is tried. The remedy above stays, because
  // it produces the CORRECT artefact (escape notation in source) rather than
  // the same forbidden artefact through another door.
  lines.push(
    '',
    'This rule is not specific to one tool: the same check runs on Write, Edit, NotebookEdit, Bash',
    'and every MCP tool, and on a Bash command it also decodes escape sequences. Reaching for a',
    'different tool is not a way around it.',
  );
  if (findings.some((f) => f.hit.codePoint === CARRIAGE_RETURN)) {
    lines.push(
      '',
      'One of these is a CARRIAGE RETURN. If this file genuinely uses CRLF line endings, this gate',
      'and the repository scanner both treat CR as forbidden — normalize the file (`git config',
      'core.autocrlf`, or a .gitattributes `text=auto eol=lf` rule) rather than writing CR back in.',
    );
  }
  return lines.join('\n');
}

/**
 * The verdict for one hook invocation. Pure: no I/O, no clock, no process, so
 * the whole decision is testable without a runtime.
 */
export function judge(input, options = {}) {
  const toolName = field(input, 'tool_name');
  const toolInput = field(input, 'tool_input');
  // `tool_input` absent entirely is not "nothing to check" — it is an input
  // this gate does not recognise, arriving at a gate the matcher decided
  // applies. Passing would be a guess; the honest answer is that there is
  // nothing to scan only when the field is genuinely empty.
  if (toolInput === undefined || toolInput === null) return PASS;

  let findings;
  try {
    findings = scanToolInput(toolInput, { ...options, toolName: String(toolName ?? '') });
  } catch (err) {
    if (err instanceof CoverageFailure) {
      return {
        decision: 'deny',
        reason:
          `tyran write-guard: refusing this ${String(toolName)} because it could not scan the whole ` +
          `input (${err.message}). A partial scan that reports nothing is indistinguishable from a ` +
          'clean one, so this gate refuses rather than covering part of a payload. Split the write ' +
          'into smaller steps.',
      };
    }
    throw err;
  }
  if (findings.length === 0) return PASS;
  return { decision: 'deny', reason: refusalFor(String(toolName), findings) };
}

/** See journal.mjs — both sides canonicalized, or a symlinked path no-ops. */
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

if (isMainModule(import.meta.url)) {
  await main(() =>
    runGate({
      event: 'PreToolUse',
      deadlineMs: DEADLINE_MS,
      handler: ({ input }) => judge(input),
    }),
  );
}
