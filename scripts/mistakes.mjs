#!/usr/bin/env node
/**
 * mistakes — the repository's incident ledger, and the ONLY writer of the
 * `tyran:rules` fence in the host `CLAUDE.md`.
 *
 * `MISTAKES.md` answers one question no other Tyran store answers:
 * **recurrence**. A journal `finding` dies with its initiative; a knowledge
 * entry says what an agent should know before touching a path; this file says
 * what has gone WRONG here and how often. The count is the whole contribution,
 * which is why promotion never deletes an entry — deleting it would destroy
 * the evidence that earned the rule.
 *
 * It is an AUTHORED file, not a projection. `project.mjs --check` would report
 * a hand edit as drift and the next render would destroy it, and a human
 * correcting a wrong root cause is the single most valuable edit this file
 * will ever receive. The cost is stated rather than discovered: nothing checks
 * these entries against the journal byte for byte, so drift is auditable by a
 * human (every entry cites its initiative and its proof) but not enforced by a
 * gate. `docs/self-improvement.md` says so in those words.
 *
 * THE CLOCK. This is the one writer in the core that reads the wall clock: a
 * dated ledger of incidents is the artefact, and a date invented by a caller
 * is a date nobody can check. `--date` exists so tests are deterministic —
 * it is not an invitation to make the default deterministic later.
 *
 * THE FENCE. `promote --law` edits the operator's `CLAUDE.md` between
 * `<!-- tyran:rules start -->` and `<!-- tyran:rules end -->` and nowhere
 * else. That write is autonomous on purpose: a rule that has been paid for
 * five times, with an entry per occurrence, is evidence rather than opinion,
 * and the operator learns about it from the journal and the diff the same way
 * they learn about every other autonomous act. The boundary is not "agents may
 * not change the law" — it is "the law changes only through the mechanism that
 * requires evidence", which is why the shipped policy classes `CLAUDE.md`
 * GATED (a free-hand `Write` from a subagent is denied) while a `Bash` command
 * running THIS script passes.
 *
 * CLI:
 *   node mistakes.mjs add      --signature S --what W --cause C
 *                              --consequence Q --prevention P
 *                              [--file F] [--title T] [--initiative SLUG]
 *                              [--actor A] [--proof F-12] [--date YYYY-MM-DD]
 *   node mistakes.mjs repeats  [--file F] [--threshold 3] [--json]
 *   node mistakes.mjs promote  --signature S --status knowledge:<id>|wontfix [--file F]
 *   node mistakes.mjs promote  --signature S --law --rule TEXT [--file F]
 *                              [--claude-md PATH] [--dry-run]
 *                              [--journal PATH] [--init SLUG] [--actor A]
 * Exit: 0 ok · 1 nothing matched (no signature at the threshold; no entry
 *       changed; the signature has not earned law; the rule could not be put
 *       in force, so no status moved) · 2 usage / IO / a field that violates
 *       a cap
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeInvisible } from './invisible.mjs';
import { writeAtomic } from './project.mjs';
import { append as appendEvent, nextId } from './journal.mjs';
import { wantsHelp } from './cli-args.mjs';

/** The ledger's home. Repo ROOT, not `.tyran/`: a human, a reviewer on
 * GitHub and a session that has never heard of Tyran all have to find it. */
export const MISTAKES_FILE = 'MISTAKES.md';

/** The operator's prose, loaded into every session in the repository. */
export const CLAUDE_MD_FILE = 'CLAUDE.md';

/**
 * Per-field ceiling in codepoints, REJECTED and never truncated — the same
 * doctrine as the journal's `CAPPED_DATA_KEYS`. A silently shortened root
 * cause loses exactly the half that mattered. Long material belongs in
 * NOTES.md or a doc, with a pointer here.
 *
 * Measured against the INPUT, not the escaped output: `escapeInvisible` turns
 * one hostile codepoint into eight visible ones, and a cap counted after
 * escaping would reject a legal field for containing a character the author
 * cannot see.
 */
export const MISTAKE_FIELD_MAX = 1000;

/** Signatures are matched as literals, so the grammar has to be tight. */
export const SIGNATURE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SIGNATURE_MAX = 60;

/**
 * Titles are one line of a heading; longer than this and a reader skims past.
 *
 * The two paths differ on purpose and the difference is not a loophole: a
 * DERIVED title is cut with an ellipsis because nobody chose its length, while
 * an explicit `--title` is REJECTED over the cap — the same reject-never-
 * truncate doctrine as `MISTAKE_FIELD_MAX`, applied where an author is the one
 * who decided.
 */
export const TITLE_MAX = 100;

/**
 * Three open entries under one signature graduate the lesson into
 * `.tyran/knowledge/`; five open-or-promoted earn a line in `CLAUDE.md`.
 *
 * The GAP is the diagnostic, not an accident of taste: a signature that
 * reaches five has already been delivered in every handoff touching those
 * paths and broke anyway, which is the strongest argument for law there is.
 */
export const KNOWLEDGE_THRESHOLD = 3;
export const LAW_THRESHOLD = 5;

export const FENCE_START = '<!-- tyran:rules start -->';
export const FENCE_END = '<!-- tyran:rules end -->';

/**
 * Markers are matched as WHOLE LINES. An `includes` test would let a rule
 * whose text quotes the end marker truncate the fence, and the next promotion
 * would then write outside it — into the operator's own prose.
 */
const FENCE_START_RE = /^[ \t]*<!--[ \t]*tyran:rules[ \t]+start[ \t]*-->[ \t]*$/;
const FENCE_END_RE = /^[ \t]*<!--[ \t]*tyran:rules[ \t]+end[ \t]*-->[ \t]*$/;

/** The heading the fence is introduced by, wherever the fence is created. */
export const FENCE_HEADING = '## Rules earned by repeated failures';

/** Field label -> key, in the order an entry states them. */
const FIELDS = Object.freeze([
  ['what', 'What happened'],
  ['cause', 'Root cause'],
  ['consequence', 'Consequence'],
  ['prevention', 'Prevention'],
]);

const FIELD_LINE_RE = /^-\s+\*\*(What happened|Root cause|Consequence|Prevention):\*\*\s*(.*)$/;
const TRAILER_RE = /^-\s+\*\*Signature:\*\*\s*(.*)$/;
const HEADING_RE = /^## (.*)$/;
const CODE_FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

class UsageError extends Error {}
class IOError extends Error {}

// ------------------------------------------------------------------ text

/**
 * One untrusted value on its way into a file agents read.
 *
 * Escaped rather than stripped (ADR-19): a value made entirely of TAG
 * characters must not render identically to an empty one. Whitespace is a
 * separate normalization — a newline is perfectly visible and is folded, not
 * banned — and folding it is what makes a forged `## ` heading impossible:
 * every field is written as exactly one line.
 */
export function clean(value) {
  return escapeInvisible(String(value)).replace(/\s+/g, ' ').trim();
}

const cpLength = (s) => Array.from(String(s)).length;

function eolOf(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const total = (text.match(/\n/g) ?? []).length;
  return crlf * 2 > total ? '\r\n' : '\n';
}

/**
 * Split a document into lines while remembering how to put it back byte for
 * byte. Both facts are load-bearing when the file belongs to the operator: a
 * writer that normalizes CRLF to LF, or adds a final newline that was not
 * there, rewrites every line of a file it was asked to append one line to.
 */
function splitDoc(text) {
  const eol = eolOf(text);
  const finalNewline = text.endsWith('\n');
  const body = finalNewline ? text.slice(0, -1).replace(/\r$/, '') : text;
  const lines = body === '' && finalNewline === false ? [] : body.split(/\r?\n/);
  return { lines, eol, finalNewline };
}

function joinDoc({ lines, eol, finalNewline }) {
  return lines.join(eol) + (finalNewline ? eol : '');
}

// ---------------------------------------------------------------- parsing

/**
 * The lines of a document that are TEXT rather than a fenced code sample, and
 * the fence that was never closed.
 *
 * One answer, one place: `parseMistakes` must not count an example entry
 * pasted into a fenced block, and `fenceState` must not mistake a
 * `tyran:rules` marker inside an operator's ```markdown block — the shipped
 * documentation contains exactly that snippet — for the real fence. Same
 * blindness, so the same tracking.
 *
 * `danglingFence` is the line index of a fence nothing closed, or `null`.
 * Everything below such a line is invisible to both readers, and a ledger that
 * silently reads as smaller than it is undercounts the recurrence this file
 * exists to count — so the state is returned rather than absorbed.
 */
function scanOutsideCodeFences(lines) {
  const outside = [];
  let openedAt = null;
  let marker = null;
  for (const [index, line] of lines.entries()) {
    const fence = CODE_FENCE_RE.exec(line);
    if (fence) {
      if (openedAt === null) {
        openedAt = index;
        marker = fence[1][0];
      } else if (fence[1][0] === marker) {
        openedAt = null;
        marker = null;
      }
      continue;
    }
    if (openedAt !== null) continue;
    outside.push([index, line]);
  }
  return { outside, danglingFence: openedAt };
}

/**
 * Every entry of a `MISTAKES.md`, newest first, plus the counts of what could
 * not be classified.
 *
 * FENCE-AWARE, and that is not fussiness. The shipped header shows the entry
 * shape as an example; a parser blind to code fences would count a pasted
 * example as entry number one and the recurrence count would be wrong from
 * birth. Headings are also anchored at column 0 for the same reason — the
 * shipped template indents its example four spaces.
 *
 * Nothing is dropped silently. An entry with no signature, an entry whose
 * status is not in the grammar, and a code fence nobody closed — which hides
 * every entry below it — are all COUNTED and reported: a typo that removed an
 * entry from the count with no trace is the failure this file's whole value
 * rests on not having.
 */
export function parseMistakes(text) {
  const { lines } = splitDoc(String(text));
  const { outside, danglingFence } = scanOutsideCodeFences(lines);
  const headings = outside.filter(([, line]) => HEADING_RE.test(line)).map(([index]) => index);

  const entries = [];
  for (const [n, start] of headings.entries()) {
    const end = n + 1 < headings.length ? headings[n + 1] : lines.length;
    entries.push(parseEntry(lines, start, end));
  }
  return {
    entries,
    firstEntryLine: headings.length > 0 ? headings[0] : null,
    withoutSignature: entries.filter((e) => e.signature === null).length,
    unknownStatus: entries.filter((e) => e.statusKind === 'unknown').length,
    danglingFence,
  };
}

function parseEntry(lines, start, end) {
  const heading = HEADING_RE.exec(lines[start])[1].trim();
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(heading)?.[1] ?? null;
  const fields = Object.create(null);
  let signature = null;
  let initiative = null;
  let actor = null;
  let proof = null;
  let status = null;
  let trailerLine = null;
  for (let i = start + 1; i < end; i += 1) {
    const field = FIELD_LINE_RE.exec(lines[i]);
    if (field) {
      const key = FIELDS.find(([, label]) => label === field[1])[0];
      fields[key] = field[2].trim();
      continue;
    }
    const trailer = TRAILER_RE.exec(lines[i]);
    if (trailer && trailerLine === null) {
      trailerLine = i;
      const rest = trailer[1];
      signature = /^`([^`]*)`/.exec(rest)?.[1] ?? null;
      initiative = /\binitiative\s+`([^`]*)`/.exec(rest)?.[1] ?? null;
      actor = /\bactor\s+`([^`]*)`/.exec(rest)?.[1] ?? null;
      proof = /\bproof\s+`([^`]*)`/.exec(rest)?.[1] ?? null;
      status = /\bstatus\s+`([^`]*)`/.exec(rest)?.[1] ?? null;
    }
  }
  return {
    heading,
    date,
    headingLine: start,
    endLine: end,
    fields,
    signature,
    initiative,
    actor,
    proof,
    status,
    statusKind: statusKindOf(status),
    trailerLine,
  };
}

/** `open` · `knowledge:<id>` · `law` · `wontfix` — anything else is reported. */
export function statusKindOf(status) {
  if (status === null || status === undefined || status === '') return 'missing';
  if (status === 'open') return 'open';
  if (status === 'law') return 'law';
  if (status === 'wontfix') return 'wontfix';
  if (/^knowledge:\S+$/.test(status)) return 'knowledge';
  return 'unknown';
}

// --------------------------------------------------------------- rendering

/**
 * One entry, five bullets, every field on exactly ONE line.
 *
 * Cleaning here rather than only at the CLI boundary: this function is
 * exported, and a second caller that forgot would forge a heading out of a
 * field value — caller discipline is the mechanism class this repo distrusts.
 */
export function renderEntry(entry) {
  const {
    date,
    title,
    signature,
    initiative = '-',
    actor = '-',
    proof = '-',
    status = 'open',
  } = entry;
  const bullets = FIELDS.map(([key, label]) => `- **${label}:** ${clean(entry[key] ?? '')}`);
  return [
    `## ${clean(date)} — ${clean(title)}`,
    '',
    ...bullets,
    `- **Signature:** \`${clean(signature)}\` · initiative \`${clean(initiative)}\` · ` +
      `actor \`${clean(actor)}\` · proof \`${clean(proof)}\` · status \`${clean(status)}\``,
  ].join('\n');
}

/**
 * Insert a rendered entry NEWEST FIRST: immediately before the first entry
 * heading, or — when there is none yet — after the header, at end of file.
 *
 * The insertion point is a heading rather than a marker comment on purpose. A
 * human who deletes the hint comment, or reorders two entries, keeps a working
 * file; a parser anchored on a comment would silently start appending at the
 * wrong end of a file whose whole contract is "newest first".
 */
export function insertEntry(text, rendered) {
  const doc = splitDoc(String(text));
  const { firstEntryLine } = parseMistakes(text);
  const block = rendered.split('\n');
  if (firstEntryLine !== null) {
    doc.lines.splice(firstEntryLine, 0, ...block, '');
    return joinDoc(doc);
  }
  while (doc.lines.length > 0 && doc.lines.at(-1).trim() === '') doc.lines.pop();
  if (doc.lines.length > 0) doc.lines.push('');
  doc.lines.push(...block);
  // A file that had no final newline keeps not having one; a file that had one
  // keeps exactly one. Both halves are the operator's formatting, not ours.
  return joinDoc({ ...doc, finalNewline: doc.finalNewline || text === '' });
}

/**
 * Rewrite ONLY the `status` token of every matching entry's trailer.
 *
 * The trailer is edited in place, as text, rather than re-rendered from the
 * parsed parts: re-rendering would silently normalise — and on an entry a
 * human had annotated, LOSE — the initiative, actor and proof of exactly the
 * entries that mattered enough to be promoted.
 *
 * The replacement is a FUNCTION, never a template string: `knowledge:<id>`
 * admits `$&`, `` $` `` and `$'`, and String.replace would expand them into
 * the surrounding trailer — corruption outside the status token, which is the
 * one thing this function promises not to do.
 */
export function promoteStatus(text, signature, newStatus, fromKinds) {
  const doc = splitDoc(String(text));
  const { entries } = parseMistakes(text);
  let changed = 0;
  for (const entry of entries) {
    if (entry.signature !== signature || entry.trailerLine === null) continue;
    if (!fromKinds.includes(entry.statusKind)) continue;
    const line = doc.lines[entry.trailerLine];
    const rewritten = line.replace(/(status\s+`)([^`]*)(`)/, (_match, open, _old, close) => open + newStatus + close);
    if (rewritten === line) continue;
    doc.lines[entry.trailerLine] = rewritten;
    changed += 1;
  }
  return { text: joinDoc(doc), changed };
}

// ------------------------------------------------------------- the fence

/**
 * Where Tyran's region of a `CLAUDE.md` is, or what is wrong with it.
 *
 * Returns `{start, end, problem, indent}` with line indices. A malformed fence
 * is NEVER guessed at: this file belongs to the operator, and a writer that
 * picked the likeliest interpretation of a broken marker pair would edit prose
 * nobody asked it to touch.
 *
 * CODE-FENCE-AWARE, for the same reason `parseMistakes` is and with more force:
 * `docs/self-improvement.md` ships the marker pair inside a ```markdown block,
 * so an operator documenting the mechanism in their own CLAUDE.md would
 * otherwise have the rule written into their example — or, with a real fence
 * as well, be told forever that their fence has "2 start markers".
 *
 * `indent` is the start marker's own leading whitespace, so a fence nested
 * under a list item gets its rule at the list's indentation instead of a line
 * at column 0 that terminates the list early.
 */
export function fenceState(text) {
  const { lines } = splitDoc(String(text));
  const { outside } = scanOutsideCodeFences(lines);
  const starts = [];
  const ends = [];
  for (const [index, line] of outside) {
    if (FENCE_START_RE.test(line)) starts.push(index);
    else if (FENCE_END_RE.test(line)) ends.push(index);
  }
  const broken = (problem) => ({ start: null, end: null, problem, indent: '' });
  if (starts.length > 1) return broken(`${starts.length} start markers`);
  if (ends.length > 1) return broken(`${ends.length} end markers`);
  if (starts.length === 1 && ends.length === 0) return broken('a start marker with no end marker');
  if (ends.length === 1 && starts.length === 0) return broken('an end marker with no start marker');
  if (starts.length === 0) return broken(null);
  if (ends[0] < starts[0]) return broken('the end marker comes before the start marker');
  return { start: starts[0], end: ends[0], problem: null, indent: /^[ \t]*/.exec(lines[starts[0]])[0] };
}

/** The fence block, identical wherever it is created — one shape, one answer. */
function fenceBlock() {
  return [
    FENCE_HEADING,
    '',
    'Written by `mistakes.mjs promote --law` from `MISTAKES.md`, one line per',
    'failure that recurred often enough to be a rule. Only the region between',
    'the markers is machine-written; delete a line to reject its rule.',
    '',
    FENCE_START,
    FENCE_END,
  ];
}

/**
 * Add one rule line inside the fence, creating the fence when it is absent.
 *
 * Appended at the END of the region rather than the top: `MISTAKES.md` is
 * newest-first because a reader wants the recent incident, and a rule list is
 * read as law where a stable order costs a reader nothing and a reshuffled
 * diff costs them a review.
 *
 * Throws `UsageError` on a malformed fence — the caller turns that into exit 2
 * naming the problem, because the alternative is writing into prose whose
 * shape this function does not understand.
 */
export function writeRuleToFence(text, ruleLine) {
  const state = fenceState(text);
  if (state.problem !== null) {
    throw new UsageError(`the tyran:rules fence is malformed (${state.problem}) — repair it by hand; nothing was written`);
  }
  const doc = splitDoc(String(text));
  if (state.start === null) {
    // Appended once, at the end, with its heading. Existing prose is never
    // reflowed, reordered or rewritten — only added after.
    while (doc.lines.length > 0 && doc.lines.at(-1).trim() === '') doc.lines.pop();
    const block = fenceBlock();
    if (doc.lines.length > 0) doc.lines.push('');
    doc.lines.push(...block);
    doc.lines.splice(doc.lines.length - 1, 0, ruleLine);
    return joinDoc({ ...doc, finalNewline: doc.finalNewline || text === '' });
  }
  // The fence's own indentation, not column 0: an operator who nested the
  // markers under a list item gets a rule inside that list rather than a line
  // that ends it.
  doc.lines.splice(state.end, 0, state.indent + ruleLine);
  return joinDoc(doc);
}

/** The rule lines currently inside the fence (empty when there is no fence). */
export function fenceRules(text) {
  const state = fenceState(text);
  if (state.problem !== null || state.start === null) return [];
  const { lines } = splitDoc(String(text));
  return lines.slice(state.start + 1, state.end).filter((line) => line.trim() !== '');
}

/**
 * The one line a promotion writes: the rule, then the evidence that earned it.
 *
 * The evidence is not decoration. An operator who disagrees deletes the line,
 * and the only way to disagree well is to be able to read what it cost.
 */
export function ruleLineFor({ rule, signature, count, dates }) {
  const pointer = dates.length > 0 ? ` — ${MISTAKES_FILE} entries ${dates.join(', ')}` : '';
  return `- ${clean(rule)} (\`${clean(signature)}\`, ${count} occurrences${pointer})`;
}

/**
 * The evidence parenthetical `ruleLineFor` writes, anchored where it writes it.
 * Whitespace after it is tolerated; a rule's human text is not searched.
 */
const RULE_EVIDENCE_RE = /\(`([a-z0-9]+(?:-[a-z0-9]+)*)`, \d+ occurrences(?: — [^`)]*)?\)$/;

/**
 * The signature a rule line's MACHINE-WRITTEN evidence names, or `null`.
 *
 * Read from the tail rather than looked for anywhere in the line, because rule
 * text naming another signature in backticks is the normal case — signatures
 * are kebab-case slugs for repo concepts. A substring test let one such rule
 * block that signature's own rule forever while its entries were still flipped
 * to `law`: a trailer claiming law with no rule anywhere, which is the one
 * state nothing downstream detects.
 */
export function signatureOfRuleLine(line) {
  return RULE_EVIDENCE_RE.exec(String(line).trimEnd())?.[1] ?? null;
}

/** Whether the fence carries a rule whose evidence names this signature. */
export function fenceCarriesSignature(text, signature) {
  return fenceRules(text).some((line) => signatureOfRuleLine(line) === signature);
}

// ------------------------------------------------------------- validation

function checkField(name, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError(`--${name} is required and must not be empty`);
  }
  if (cpLength(value) > MISTAKE_FIELD_MAX) {
    throw new UsageError(
      `--${name} is ${cpLength(value)} codepoints, over the ${MISTAKE_FIELD_MAX} cap — ` +
        'shorten it or put the long material in NOTES.md and point at it here. It is NOT truncated',
    );
  }
  return value;
}

function checkSignature(value) {
  if (typeof value !== 'string' || !SIGNATURE_RE.test(value) || value.length > SIGNATURE_MAX) {
    throw new UsageError(
      `--signature ${JSON.stringify(escapeInvisible(String(value)))} is not a signature — ` +
        `lower-case words joined by single hyphens, at most ${SIGNATURE_MAX} characters`,
    );
  }
  return value;
}

/**
 * The trailer's own fields live inside backticks, so a backtick in one of them
 * would close its span early and hand the rest of the value to the parser as
 * structure. Rejected rather than escaped: these are identifiers, and an
 * identifier nobody can type back is not a useful one.
 */
function checkTrailerField(name, value) {
  if (value === undefined || value === null) return '-';
  const text = clean(value);
  if (text === '') return '-';
  if (text.includes('`')) throw new UsageError(`--${name} must not contain a backtick`);
  if (cpLength(value) > MISTAKE_FIELD_MAX) {
    throw new UsageError(`--${name} is over the ${MISTAKE_FIELD_MAX}-codepoint cap`);
  }
  return text;
}

function checkDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw new UsageError(`--date ${JSON.stringify(escapeInvisible(String(value)))} is not YYYY-MM-DD`);
  }
  return value;
}

/**
 * An explicit title: the field checks, then the heading's own ceiling.
 *
 * Measured against the INPUT for the same reason as `MISTAKE_FIELD_MAX` —
 * `escapeInvisible` turns one hostile codepoint into eight visible ones, and a
 * cap counted after escaping would reject a legal title over a character its
 * author cannot see.
 */
function checkTitle(value) {
  checkField('title', value);
  if (cpLength(value) > TITLE_MAX) {
    throw new UsageError(
      `--title is ${cpLength(value)} codepoints, over the ${TITLE_MAX} cap — ` +
        'a heading is one line. It is NOT truncated',
    );
  }
  return clean(value);
}

/** First sentence of `what`, cut at TITLE_MAX with an ellipsis. */
export function titleFrom(what) {
  const text = clean(what);
  const sentence = /^(.*?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  const cps = Array.from(sentence);
  return cps.length > TITLE_MAX ? cps.slice(0, TITLE_MAX - 1).join('') + '…' : sentence;
}

// ---------------------------------------------------------------- counting

/**
 * Per-signature recurrence.
 *
 * The knowledge threshold counts `open` ONLY — a promoted signature stops
 * counting toward its own re-promotion, which is double-promotion prevention
 * number one and is mechanical rather than a rule anybody has to remember.
 * The law threshold counts `open` PLUS already-promoted, because the argument
 * for law is precisely "it kept happening after the knowledge entry shipped".
 */
export function countSignatures(entries) {
  const bySignature = new Map();
  for (const entry of entries) {
    if (entry.signature === null || entry.signature === '') continue;
    let row = bySignature.get(entry.signature);
    if (row === undefined) {
      row = { signature: entry.signature, open: 0, knowledge: 0, law: 0, wontfix: 0, unknown: 0, missing: 0, dates: [] };
      bySignature.set(entry.signature, row);
    }
    row[entry.statusKind] += 1;
    if (entry.date !== null) row.dates.push(entry.date);
  }
  for (const row of bySignature.values()) {
    row.dates.sort();
    row.lawCount = row.open + row.knowledge;
  }
  return [...bySignature.values()].sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));
}

// --------------------------------------------------------------------- IO

function readMistakes(path) {
  if (!existsSync(path)) {
    throw new IOError(
      `no ${MISTAKES_FILE} at ${escapeInvisible(path)} — deleting the file is this feature's whole opt-out, ` +
        'so nothing here puts it back. `scan-repo.mjs --ensure-policy` seeds it again if you want one',
    );
  }
  return readText(path);
}

/**
 * Every read this CLI makes, with the failure named.
 *
 * An EISDIR or EACCES escaping as an uncaught exception is a stack trace and
 * exit 1 — the code this CLI's contract reserves for "nothing matched", which
 * an automated caller reads as "the signature has not earned law" and moves on
 * from. IO belongs on exit 2 with the path in the message.
 */
function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new IOError(`could not read ${escapeInvisible(path)}: ${error.message}`);
  }
}

/**
 * Every write this CLI makes, THROUGH a symlink rather than over it.
 *
 * `writeAtomic` renames a temp file onto the target, and a rename replaces a
 * symlink with a regular file: an operator whose `CLAUDE.md` links to a shared
 * or global instructions file would lose the link while the file they meant
 * never received the rule — silent on both halves. So the link is resolved and
 * the file it names is written, which is what every editor does with the same
 * path; refusing instead would make an ordinary monorepo layout unpromotable.
 * A link pointing nowhere is the one case that IS refused: there is no file to
 * write, and replacing the link would destroy the operator's only record of
 * where it pointed.
 */
function writeThroughLinks(path, text) {
  let target = path;
  let link = null;
  try {
    link = lstatSync(path).isSymbolicLink();
  } catch {
    link = false; // no such path yet: the write creates it
  }
  if (link) {
    try {
      target = realpathSync(path);
    } catch (error) {
      throw new IOError(
        `${escapeInvisible(path)} is a symlink to a path that does not exist (${error.message}) — ` +
          'repair the link; nothing was written',
      );
    }
  }
  try {
    writeAtomic(target, text);
  } catch (error) {
    throw new IOError(`could not write ${escapeInvisible(target)}: ${error.message}`);
  }
}

// ---------------------------------------------------------------- the CLI

const VALUE_FLAGS = [
  'file', 'signature', 'what', 'cause', 'consequence', 'prevention', 'title',
  'initiative', 'actor', 'proof', 'date', 'threshold', 'status', 'rule',
  'claude-md', 'journal', 'init',
];
const BOOLEAN_FLAGS = ['json', 'law', 'dry-run'];

const USAGE = [
  'usage:',
  '  mistakes.mjs add     --signature S --what W --cause C --consequence Q --prevention P',
  '                       [--file F] [--title T] [--initiative SLUG] [--actor A]',
  '                       [--proof F-12] [--date YYYY-MM-DD]',
  '  mistakes.mjs repeats [--file F] [--threshold N] [--json]',
  '  mistakes.mjs promote --signature S --status knowledge:<id>|wontfix [--file F]',
  '  mistakes.mjs promote --signature S --law --rule TEXT [--file F] [--claude-md PATH]',
  '                       [--dry-run] [--journal PATH] [--init SLUG] [--actor A]',
].join('\n');

function parseArgs(argv) {
  const flags = Object.create(null);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument ${JSON.stringify(escapeInvisible(arg))}`);
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.includes(name)) {
      flags[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(name)) throw new UsageError(`unknown flag --${escapeInvisible(name)}`);
    const value = argv[i + 1];
    if (value === undefined) throw new UsageError(`flag --${name} needs a value`);
    flags[name] = value;
    i += 1;
  }
  return flags;
}

function cmdAdd(flags) {
  const path = resolve(flags.file ?? MISTAKES_FILE);
  const signature = checkSignature(flags.signature);
  const entry = {
    date: checkDate(flags.date ?? new Date().toISOString().slice(0, 10)),
    signature,
    initiative: checkTrailerField('initiative', flags.initiative),
    actor: checkTrailerField('actor', flags.actor),
    proof: checkTrailerField('proof', flags.proof),
    status: 'open',
  };
  for (const [key] of FIELDS) entry[key] = checkField(key, flags[key]);
  entry.title = flags.title === undefined ? titleFrom(entry.what) : checkTitle(flags.title);

  const before = readMistakes(path);
  const after = insertEntry(before, renderEntry(entry));
  writeThroughLinks(path, after);
  console.error(`mistakes: added \`${signature}\` to ${escapeInvisible(path)} (${entry.date})`);
  return 0;
}

function cmdRepeats(flags) {
  const path = resolve(flags.file ?? MISTAKES_FILE);
  const threshold = Number(flags.threshold ?? KNOWLEDGE_THRESHOLD);
  if (!Number.isInteger(threshold) || threshold < 1) throw new UsageError('--threshold must be a positive integer');
  const parsed = parseMistakes(readMistakes(path));
  const rows = countSignatures(parsed.entries).filter(
    (row) => row.open >= threshold || row.lawCount >= LAW_THRESHOLD,
  );

  if (flags.json) {
    console.log(JSON.stringify(
      {
        threshold,
        law_threshold: LAW_THRESHOLD,
        entries: parsed.entries.length,
        without_signature: parsed.withoutSignature,
        unknown_status: parsed.unknownStatus,
        dangling_code_fence_line: parsed.danglingFence === null ? null : parsed.danglingFence + 1,
        signatures: rows.map((row) => ({ ...row, recommendation: recommendationFor(row, threshold) })),
      },
      null,
      2,
    ));
    return rows.length > 0 ? 0 : 1;
  }

  const width = Math.max(0, ...rows.map((row) => row.signature.length));
  for (const row of rows) {
    const counted = row.lawCount >= LAW_THRESHOLD
      ? `${row.lawCount} open+promoted (${row.dates.join(', ')})`
      : `${row.open} open (${row.dates.join(', ')})`;
    console.log(`${row.signature.padEnd(width)}  ${counted}  -> ${recommendationFor(row, threshold)}`);
  }
  // Omission is never silent: an entry nobody gave a signature, an entry whose
  // status was typo'd, and a code fence nobody closed are the three ways this
  // file quietly reads as smaller than it is.
  const notes = [`${rows.length} signature(s) at or above the threshold`, `${parsed.entries.length} entries scanned`];
  if (parsed.withoutSignature > 0) notes.push(`${parsed.withoutSignature} without a signature`);
  if (parsed.unknownStatus > 0) notes.push(`${parsed.unknownStatus} with an unrecognised status`);
  if (parsed.danglingFence !== null) notes.push(danglingFenceNote(parsed));
  console.log(notes.join('; '));
  return rows.length > 0 ? 0 : 1;
}

/** An unclosed ``` swallows every entry below it — said, never absorbed. */
function danglingFenceNote(parsed) {
  return `a code fence opened at line ${parsed.danglingFence + 1} is never closed, so every entry below it was NOT counted`;
}

function recommendationFor(row, threshold) {
  if (row.lawCount >= LAW_THRESHOLD) return 'promote to CLAUDE.md law (mistakes.mjs promote --law)';
  if (row.open >= threshold) return 'promote to .tyran/knowledge/';
  return 'below both thresholds';
}

function cmdPromote(flags) {
  const path = resolve(flags.file ?? MISTAKES_FILE);
  const signature = checkSignature(flags.signature);
  if (flags.law) return promoteLaw(flags, path, signature);

  if (flags.rule !== undefined) throw new UsageError('--rule belongs to --law; a status promotion writes no rule');
  const status = String(flags.status ?? '');
  if (status === 'law') {
    throw new UsageError(
      'status `law` is written by --law, which puts the rule in the CLAUDE.md fence in the same run — ' +
        'a trailer that says `law` while no rule exists is the one state nothing can detect',
    );
  }
  // `wontfix` is the demotion, so it must be able to reach an entry at ANY
  // status; `knowledge:<id>` promotes `open` only, which is what stops a
  // promoted signature being promoted again on every retro forever.
  let fromKinds;
  if (status === 'wontfix') fromKinds = ['open', 'knowledge', 'law', 'unknown', 'missing'];
  else if (/^knowledge:\S+$/.test(status)) fromKinds = ['open'];
  else throw new UsageError(`--status must be knowledge:<id> or wontfix (got ${JSON.stringify(escapeInvisible(status))})`);
  // The trailer writes the status inside a backtick span, so a backtick in the
  // id would close it early and hand the rest of the id to the parser as
  // structure — refused here for the same reason `checkTrailerField` refuses
  // it, rather than written and read back as something shorter.
  if (status.includes('`')) throw new UsageError('--status must not contain a backtick');

  const { text, changed } = promoteStatus(readMistakes(path), signature, status, fromKinds);
  if (changed === 0) {
    console.error(`mistakes: no entry with signature \`${signature}\` was eligible for status \`${status}\` — nothing written`);
    return 1;
  }
  writeThroughLinks(path, text);
  console.error(`mistakes: ${changed} entr${changed === 1 ? 'y' : 'ies'} moved to status \`${status}\``);
  return 0;
}

/**
 * The law step: the rule goes into the operator's CLAUDE.md fence, and the
 * entries that earned it move to `law`.
 *
 * ORDER MATTERS, and the crash window decides it. CLAUDE.md is written first:
 * if the process dies between the two writes the statuses are still eligible,
 * the fence already carries the line, and a re-run heals — it skips the
 * duplicate and flips the trailers. Written the other way round, a crash would
 * leave entries claiming `law` with no rule anywhere and no run able to
 * produce one.
 */
function promoteLaw(flags, path, signature) {
  const rule = checkField('rule', flags.rule);
  const claudePath = resolve(flags['claude-md'] ?? join(dirname(path), CLAUDE_MD_FILE));

  const parsed = parseMistakes(readMistakes(path));
  if (parsed.danglingFence !== null) console.error(`mistakes: ${danglingFenceNote(parsed)}`);
  const row = countSignatures(parsed.entries).find((r) => r.signature === signature);
  const count = row?.lawCount ?? 0;
  if (count === 0) {
    console.error(`mistakes: no entry with signature \`${signature}\` is eligible for law — nothing written`);
    return 1;
  }
  // The threshold is EVIDENCE, not opinion, and it has no override flag on
  // purpose: a switch that lowered it would make the guarantee a preference.
  if (count < LAW_THRESHOLD) {
    console.error(
      `mistakes: \`${signature}\` has ${count} open-or-promoted entr${count === 1 ? 'y' : 'ies'}, ` +
        `below the law threshold of ${LAW_THRESHOLD} — nothing written`,
    );
    return 1;
  }

  const claudeText = existsSync(claudePath) ? readText(claudePath) : '';
  const state = fenceState(claudeText);
  if (state.problem !== null) {
    throw new UsageError(
      `${escapeInvisible(claudePath)}: the tyran:rules fence is malformed (${state.problem}) — ` +
        'repair it by hand; nothing was written',
    );
  }
  const line = ruleLineFor({ rule, signature, count, dates: row.dates });
  // The signature this line's EVIDENCE names, never a substring of the rule's
  // prose: see `signatureOfRuleLine`.
  const already = fenceCarriesSignature(claudeText, signature);

  if (flags['dry-run']) {
    console.log(line);
    console.error(
      `mistakes: --dry-run — ${already ? 'the fence already carries this signature; ' : ''}` +
        `nothing was written to ${escapeInvisible(claudePath)} or ${escapeInvisible(path)}`,
    );
    return 0;
  }

  // The status flip and the rule line are ONE decision, checked before either
  // is made: entries that say `law` while the rule is in no fence — because an
  // unclosed code fence in the operator's document swallowed the block we would
  // append — is the one state nothing downstream detects, so it is refused
  // rather than produced.
  const nextClaudeText = already ? claudeText : writeRuleToFence(claudeText, line);
  if (!fenceCarriesSignature(nextClaudeText, signature)) {
    console.error(
      `mistakes: ${escapeInvisible(claudePath)} would carry no rule for \`${signature}\` after the write ` +
        '(an unclosed ``` code fence swallowing the tyran:rules block?) — nothing written, no status moved',
    );
    return 1;
  }

  if (!already) writeThroughLinks(claudePath, nextClaudeText);
  const { text, changed } = promoteStatus(readMistakes(path), signature, 'law', ['open', 'knowledge']);
  writeThroughLinks(path, text);
  console.error(
    already
      ? `mistakes: ${escapeInvisible(claudePath)} already carried \`${signature}\`; ${changed} entr${changed === 1 ? 'y' : 'ies'} moved to status \`law\``
      : `mistakes: wrote the rule into ${escapeInvisible(claudePath)} and moved ${changed} entr${changed === 1 ? 'y' : 'ies'} to status \`law\``,
  );
  journalDecision(flags, { signature, count, line, claudePath });
  return 0;
}

/**
 * The record of an autonomous act — not a request for permission.
 *
 * A failure here never fails the command. The irreversible half already
 * happened, a re-run exits 1 by design, and a non-zero exit would send a
 * caller into a retry that cannot succeed; so the remedy is printed as a
 * command the operator or the retro can paste, and the omission is loud.
 */
function journalDecision(flags, { signature, count, line, claudePath }) {
  if (flags.journal === undefined || flags.init === undefined) {
    console.error(
      'mistakes: no --journal/--init given, so this promotion is in no initiative\'s record — ' +
        'append a `decision` event by hand if this ran inside one',
    );
    return;
  }
  const file = resolve(flags.journal);
  try {
    appendEvent(file, {
      ev: 'decision',
      init: flags.init,
      actor: flags.actor ?? 'retro',
      data: {
        id: nextId(file, 'D'),
        text: `promoted a rule into ${CLAUDE_MD_FILE}: ${clean(line)}`,
        signature,
        occurrences: count,
        path: claudePath,
      },
    });
  } catch (error) {
    console.error(`mistakes: the promotion succeeded but the journal did NOT record it (${error.message})`);
    console.error(
      `mistakes: node scripts/journal.mjs append ${escapeInvisible(file)} decision ${escapeInvisible(String(flags.init))} ` +
        '--actor retro --data \'{"text":"promoted a rule into CLAUDE.md"}\'',
    );
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (wantsHelp(process.argv.slice(2))) {
    console.log(USAGE);
    return 0;
  }
  let code;
  try {
    const flags = parseArgs(rest);
    if (command === 'add') code = cmdAdd(flags);
    else if (command === 'repeats') code = cmdRepeats(flags);
    else if (command === 'promote') code = cmdPromote(flags);
    else throw new UsageError(command === undefined ? 'no subcommand' : `unknown subcommand ${JSON.stringify(escapeInvisible(command))}`);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`mistakes: ${error.message}`);
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    if (error instanceof IOError) {
      console.error(`mistakes: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  // exitCode, never process.exit(): exit() does not wait for stdout to drain,
  // and `repeats --json` into a pipe is exactly the consumer that would be
  // truncated at the moment its output matters.
  process.exitCode = code;
}

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
