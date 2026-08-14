#!/usr/bin/env node
/**
 * answer — the operator's sitting: one sheet of every open question, one fold
 * back into the journals.
 *
 * An ask is a `gate` whose `kind` IS its id (`Q-<n>`), raised by
 * `journal.mjs ask`. `render` writes every open one across every initiative
 * into `.tyran/state/ANSWERS.md`; the operator types under the `answer:`
 * lines; `apply` folds each answer back as a `decision` + a closing
 * `gate result: answered`, decision first, and re-renders the projections and
 * the board.
 *
 * Three properties this file exists to hold:
 *
 *  - **Every value written comes out of the JOURNAL, never out of the sheet.**
 *    The sheet is an inbox. A tampered one can change WHICH asks close and
 *    WHAT the operator said, and nothing else — it cannot forge a question, a
 *    default, a ticket or an id.
 *  - **Parsing is all-or-nothing.** One unreadable block and nothing at all is
 *    appended. A per-block skip would record eleven answers and silently drop
 *    the twelfth, and the operator would never learn which. This is why the
 *    heading DETECTOR is wider than the heading GRAMMAR: a heading that lost
 *    its space is a refusal with a line number, never context quietly
 *    appended to the previous answer.
 *  - **Decision before gate.** A crash between the two leaves a visible orphan
 *    decision, which is re-appliable; the reverse leaves a closed question
 *    whose answer was never written down, which is silent loss.
 *  - **One writer per ask.** The re-read that says "this ask is still open"
 *    and the two appends share ONE lock, so two `apply` runs on one sheet
 *    cannot both close the same question — an append-only ledger keeps both
 *    decisions forever.
 *
 * It discovers nothing of its own: initiatives come from `board.mjs`, appends
 * go through `journal.mjs`, re-rendering through `project.mjs` and
 * `board.mjs`, liveness and the resume argv from `overnight.mjs`.
 *
 * `ANSWERS.md` is GENERATED and then HAND-EDITED, so it is deliberately NOT in
 * the byte-exact `--check` set: byte-equality is not a property a file the
 * operator types into can have.
 *
 * CLI:
 *   node answer.mjs render [--dir <.tyran>] [--force]
 *   node answer.mjs apply  [--dir <.tyran>] [--dry-run] [--resume]
 * Exit: 0 ok · 1 nothing is waiting on you · 2 usage, IO, a sheet that did
 *       not parse, or a sheet with answers already typed into it
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readInitiativeBoards, renderAll } from './board.mjs';
import { append, ASK_KIND_RE, CAPPED_DATA_KEYS, readJournal } from './journal.mjs';
import { formatCodePoint, invisibleProblem } from './invisible.mjs';
import { resumeArgv, SESSION_ID_RE } from './overnight.mjs';
import { inlinePlain, naturalCompare, projectFile, WAITING_RE, writeAllAtomic, writeAtomic } from './project.mjs';

/** The sheet, and the session record `apply --resume` reads. Both under
 * `state/`, which is already the AUTO policy class on every install. */
export const ANSWERS_FILE = 'ANSWERS.md';
export const CONDUCTOR_FILE = 'conductor.json';

/** The answer's ceiling is the journal's, imported rather than restated: a
 * pre-flight that disagreed with `append` would refuse the 9th answer of a
 * sitting after writing the 8th. */
export const MAX_ANSWER = CAPPED_DATA_KEYS.answer;

/** Longest answer excerpt in the report line. */
const REPORT_EXCERPT = 60;

/** The heading's tail on an ask with nothing recorded to fall back to. Part of
 * the grammar, so `render` and `parseSheet` cannot spell it differently. */
const NO_DEFAULT_SUFFIX = ' · no default recorded';

/**
 * The GRAMMAR. `$1` is the ask id (the gate kind), `$2` is the initiative
 * directory — captured to the end of the line rather than to the first space,
 * so a directory named `pay ments` round-trips instead of rendering a sheet
 * `apply` can never accept. Trailing blanks are the editor's, not the
 * operator's.
 */
export const BLOCK_RE = new RegExp(`^## (Q-\\d+) · (.+?)(?:${NO_DEFAULT_SUFFIX})?[ \\t]*$`);

/**
 * The DETECTOR, deliberately wider than the grammar: every line the operator
 * could have MEANT as a heading. `##Q-2 · p`, `### Q-2 · p`, ` ## Q-2 · p` and
 * a tab-indented one are all typos an editor makes; matched here, each is a
 * refusal naming its line, and unmatched each would be ordinary context
 * appended to the PREVIOUS answer — one decision carrying two questions, the
 * second ask still open, exit 0.
 */
const HEADING_RE = /^(?:## |[ \t]*#{1,6}[ \t]*Q-\d)/;

/**
 * An ask's identity across initiatives. Ask ids are minted per journal, so
 * `Q-1` in `payments` and `Q-1` in `docs-site` are two different questions and
 * both must be answerable in one sitting.
 */
const keyOf = (init, kind) => `${init} :: ${kind}`;

const GENERATED_HEADER = `<!-- GENERATED by tyran scripts/answer.mjs — the \`answer:\` lines are the only thing you edit.
     When you are done:  node scripts/answer.mjs apply --dir .tyran

       blank    accept the recorded default, verbatim, as the decision
       -        leave it open; ask me again next time
       text     your answer, in your own words — everything down to the next \`## \` is it

     Questions with NO recorded default come first: those are the only ones where
     saying nothing has no safe outcome. The question, the default, the ticket and
     the id are read back out of the journal when you apply, so nothing you type
     can change what was asked. One line is structure rather than content: the
     \`## Q-<n> · <initiative>\` heading PICKS which question your answer closes —
     leave it alone, or your answer is filed against a different ask. -->
`;

class UsageError extends Error {}
class IOError extends Error {}

// ------------------------------------------------------------- discovery

/**
 * Every open ask, across every initiative, with the journal that owns it.
 *
 * The queue is `boardOf`'s, not a second derivation: an ask is an open gate
 * whose result matches the board's waiting rule, and this file must close
 * exactly what the board shows.
 */
export function openAsks(tyranDir) {
  const { initiatives, errors } = readInitiativeBoards(tyranDir);
  const asks = [];
  for (const { name, journal, board } of initiatives) {
    for (const ask of board.asks) asks.push({ ...ask, init: name, journal });
  }
  // `inits` is every initiative that EXISTS, not every one that still has a
  // question open: "payments has no open ask any more" and "there is no
  // payments" send the operator to opposite fixes, and the second sitting on
  // an already-applied sheet hits exactly that fork.
  return { asks: sortAsks(asks), inits: initiatives.map((i) => i.name), errors };
}

/**
 * No recorded default FIRST — those are the only questions where saying
 * nothing has no safe outcome. Then oldest first: a question that has stood
 * for four days is the one costing an initiative its progress. The last two
 * keys make the order total, so the sheet is stable across renders.
 */
export function sortAsks(asks) {
  return [...asks].sort(
    (a, b) =>
      Number(a.default != null) - Number(b.default != null) ||
      String(a.since ?? '').localeCompare(String(b.since ?? '')) ||
      naturalCompare(a.init, b.init) ||
      naturalCompare(a.kind, b.kind),
  );
}

// --------------------------------------------------------------- render

/**
 * Which open asks this sheet can carry, and why the rest cannot.
 *
 * Two shapes cannot round-trip through the grammar, and rendering either as a
 * block would be worse than not rendering it: parsing is all-or-nothing, so
 * ONE heading the parser refuses makes every other answer in the sitting
 * unappliable, and re-rendering reproduces it forever.
 *
 *  - A gate `kind` that is not `Q-<n>`. 0.1.9-0.1.14 raised the
 *    waiting-on-operator lane with kinds of the conductor's own choosing, and
 *    those journals are still on disk; `journal.mjs append` still accepts one.
 *  - An initiative whose directory name does not survive one line of Markdown
 *    (a newline or a tab in it, longer than the cell cap, invisibles). The
 *    heading is the SELECTOR, and a folded or truncated name selects nothing.
 *
 * Both are listed on the sheet, read-only, with the command that closes them.
 */
export function partitionAsks(asks) {
  const answerable = [];
  const unanswerable = [];
  for (const a of asks) {
    if (!ASK_KIND_RE.test(String(a.kind ?? ''))) {
      unanswerable.push({ ask: a, why: 'its gate kind is not `Q-<n>`, so no heading can select it' });
    } else if (inlinePlain(a.init) !== a.init || String(a.init).endsWith(NO_DEFAULT_SUFFIX)) {
      unanswerable.push({ ask: a, why: 'the initiative directory name does not survive one line of Markdown' });
    } else {
      answerable.push(a);
    }
  }
  return { answerable, unanswerable };
}

/**
 * The read-only list. ABOVE the blocks, because everything before the first
 * heading is context and nothing here can be swallowed into an answer; and
 * with no `#` on any line, because the heading detector would otherwise read
 * one of these as a block the grammar then refuses.
 */
function unanswerableNote(unanswerable) {
  if (unanswerable.length === 0) return '';
  const lines = [
    `\n> ${unanswerable.length} open ask(s) cannot be answered here — read-only, listed so the queue is honest.`,
    '> Close each from its own journal:  node scripts/journal.mjs append <journal> gate <initiative>',
    ">   --data '{\"kind\":\"<kind>\",\"result\":\"answered\",\"answer\":\"<what you decided>\"}'",
  ];
  for (const { ask, why } of unanswerable) {
    lines.push(`>   ${inlinePlain(ask.init)} · ${inlinePlain(ask.kind)} — ${why}`);
    lines.push(`>     journal:  ${inlinePlain(ask.journal ?? '(unknown)')}`);
    lines.push(`>     question: ${inlinePlain(ask.question ?? '(no question recorded)')}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The sheet. Every journal-derived value goes through `inlinePlain`, which is
 * the repo's one answer to "is this safe to show a human": it escapes
 * invisibles and folds the value onto ONE line. The folding is load-bearing
 * here and not merely cosmetic — a question carrying a newline plus
 * `## Q-99 · other` would otherwise open a second parseable block inside its
 * own sheet, and an agent would be writing the operator's ballot.
 *
 * Every journal-derived line carries a `- <field>: ` prefix for the same
 * reason: an unprefixed question that itself began `answer:` would hijack its
 * own block's answer line, and a blank answer — "take the recorded default" —
 * would reach the ledger as an operator decision in the question author's
 * words. Question text is agent-supplied, and the ledger is append-only.
 *
 * The initiative goes into the heading RAW, which is safe only because
 * `partitionAsks` has already dropped every name `inlinePlain` would alter:
 * the heading is the selector, so it must carry the directory's real name.
 */
export function renderSheet(asks) {
  const { answerable, unanswerable } = partitionAsks(asks);
  const parts = [
    GENERATED_HEADER,
    '\n',
    `# ${answerable.length} question${answerable.length === 1 ? '' : 's'} waiting on you\n`,
    unanswerableNote(unanswerable),
  ];
  for (const a of answerable) {
    parts.push(`\n## ${a.kind} · ${a.init}${a.default == null ? NO_DEFAULT_SUFFIX : ''}\n`);
    parts.push(`- question: ${inlinePlain(a.question ?? '(no question recorded)')}\n`);
    if (a.recommendation != null) parts.push(`- recommendation: ${inlinePlain(a.recommendation)}\n`);
    if (a.default != null) parts.push(`- default: ${inlinePlain(a.default)}\n`);
    if (a.ticket != null) parts.push(`- ticket: ${inlinePlain(a.ticket)}\n`);
    parts.push(`- since: ${inlinePlain(a.since)}\n`);
    parts.push('answer:\n');
  }
  return parts.join('');
}

// ---------------------------------------------------------------- parse

/** The sheet's lines, one trailing CR dropped. The file is GENERATED and then
 * hand-edited, so its line endings are the operator's editor's: a CRLF sheet
 * must not fail with a codepoint offset nobody can act on. */
const sheetLines = (text) => String(text).split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));

/**
 * The grammar, deliberately dumber than YAML: one heading regex, one
 * `answer:` line, everything else ignored.
 *
 * Returns `{ blocks, errors }`. A non-empty `errors` means NOTHING is
 * appended — the caller must not apply a subset. A line that LOOKS like a
 * heading (`HEADING_RE`) but does not parse (`BLOCK_RE`) is an error rather
 * than ignored context: a mistyped heading is exactly how a sitting would
 * half-apply, and the operator would have no way to see which answer went
 * missing.
 */
export function parseSheet(text) {
  const lines = sheetLines(text);
  const blocks = [];
  const errors = [];
  const seen = new Map();
  let current = null;

  const close = () => {
    if (current === null) return;
    if (current.answerLine === null) {
      errors.push(
        `line ${current.line}: block "${current.kind} · ${current.init}" has no \`answer:\` line — ` +
          'every block needs one, even when the answer is blank',
      );
    } else {
      blocks.push({
        kind: current.kind,
        init: current.init,
        line: current.line,
        answerLine: current.answerLine,
        answer: current.parts.join('\n').trim(),
      });
    }
    current = null;
  };

  lines.forEach((line, i) => {
    const number = i + 1;
    if (HEADING_RE.test(line)) {
      close();
      const m = BLOCK_RE.exec(line);
      if (m === null) {
        errors.push(
          `line ${number}: heading is not \`## Q-<n> · <initiative>\` — ` +
            'regenerate the sheet with: node scripts/answer.mjs render',
        );
        return;
      }
      const key = keyOf(m[2], m[1]);
      const first = seen.get(key);
      if (first !== undefined) {
        errors.push(`line ${number}: ${m[1]} · ${m[2]} appears twice (first at line ${first}) — which one is your answer?`);
        return;
      }
      seen.set(key, number);
      current = { kind: m[1], init: m[2], line: number, answerLine: null, parts: [] };
      return;
    }
    if (current === null) return; // everything before the first block is context
    if (current.answerLine === null) {
      if (/^answer:/.test(line)) {
        current.answerLine = number;
        current.parts.push(line.slice('answer:'.length));
      }
      return; // any other line inside a block is context
    }
    current.parts.push(line);
  });
  close();
  return { blocks, errors };
}

/**
 * What one answer means. `-` is the sentinel for "ask me again"; blank takes
 * the recorded default; blank with no default recorded leaves the question
 * open, because there is nothing to record.
 */
export function classify(answer, ask) {
  if (answer === '-') return { mode: 'open', why: 'you typed "-"' };
  if (answer === '') {
    if (ask.default == null) return { mode: 'open', why: 'blank, and no default is recorded' };
    return { mode: 'default', text: String(ask.default) };
  }
  return { mode: 'answered', text: answer };
}

/**
 * A RECORDED DEFAULT that `append` would refuse. A blank answer writes the
 * default verbatim, so the value this sitting appends is one the sheet never
 * carried: checking only what the operator typed lets a 2500-codepoint default
 * throw BETWEEN the decision and its gate, leaving an orphan decision, the
 * rest of the sheet unprocessed and the projections stale.
 *
 * Only the ceiling, not the invisibility rules `answerProblem` also applies:
 * the default is a JOURNAL value being echoed back verbatim, not sheet text.
 */
export function defaultProblem(text) {
  const cps = Array.from(text);
  return cps.length > MAX_ANSWER ? `is ${cps.length} codepoints (cap ${MAX_ANSWER})` : null;
}

/** An answer that `append` would refuse, checked BEFORE the first append so a
 * sitting cannot half-apply. LF is fine; bidi and zero-width are not. */
export function answerProblem(answer) {
  const cps = Array.from(answer);
  if (cps.length > MAX_ANSWER) {
    return `is ${cps.length} codepoints (cap ${MAX_ANSWER}) — shorten it, or put the long form in NOTES.md and reference it`;
  }
  let offset = 0;
  for (const ch of cps) {
    const cp = ch.codePointAt(0);
    const problem = invisibleProblem(cp);
    if (problem !== null) return `carries ${formatCodePoint(cp)} at codepoint offset ${offset} (${problem})`;
    offset += 1;
  }
  return null;
}

// ---------------------------------------------------------------- apply

/**
 * The two events one answered ask produces, in the order they must be
 * written. Pure, so the ordering guarantee is testable without a filesystem.
 *
 * `decision.text` carries the `Q-<n>: ` prefix because `STATE.md`'s decisions
 * table has no ask column — without the prefix the decision is unfindable
 * from the question. `answer_mode` records whether the operator typed it or
 * accepted the recorded default: a default accepted is still a decision.
 *
 * `ticket` comes from the ASK, which came from the journal. Nothing here may
 * come from the sheet.
 */
export function eventsFor(ask, verdict, decisionId = null) {
  const decision = {
    ev: 'decision',
    init: ask.init,
    actor: 'operator',
    data: {
      text: `${ask.kind}: ${verdict.mode === 'default' ? '(default accepted) ' : ''}${verdict.text}`,
      ask: ask.kind,
      ...(ask.ticket != null ? { ticket: String(ask.ticket) } : {}),
    },
  };
  const gate = {
    ev: 'gate',
    init: ask.init,
    actor: 'operator',
    data: {
      kind: ask.kind,
      result: 'answered',
      ...(ask.ticket != null ? { ticket: String(ask.ticket) } : {}),
      answer: verdict.text,
      answer_mode: verdict.mode === 'default' ? 'default' : 'operator',
      decision: decisionId,
      via: ANSWERS_FILE,
    },
  };
  return { decision, gate };
}

/** The sheet's blocks, matched against the journal's open asks. Every
 * mismatch is collected, so one run names every problem at once. */
function resolveBlocks(blocks, asks, initNames) {
  const index = new Map(asks.map((a) => [keyOf(a.init, a.kind), a]));
  const inits = new Set(initNames);
  const errors = [];
  const resolved = [];
  for (const block of blocks) {
    const ask = index.get(keyOf(block.init, block.kind));
    if (ask === undefined) {
      errors.push(
        inits.has(block.init)
          ? `line ${block.line}: ${block.kind} is not an open ask in "${inlinePlain(block.init)}" — it was answered ` +
            'or never existed. Re-render the sheet: node scripts/answer.mjs render'
          : `line ${block.line}: "${inlinePlain(block.init)}" is not an initiative with an open ask under .tyran/state/`,
      );
      continue;
    }
    // Classify FIRST: the value this run will write is the verdict's, and for
    // a blank answer that value is the recorded default, which the sheet does
    // not carry. Checking `block.answer` alone passes every blank.
    const verdict = classify(block.answer, ask);
    if (verdict.mode === 'answered') {
      const problem = answerProblem(verdict.text);
      if (problem !== null) {
        errors.push(`line ${block.answerLine}: the answer to ${block.kind} ${problem}`);
        continue;
      }
    } else if (verdict.mode === 'default') {
      const problem = defaultProblem(verdict.text);
      if (problem !== null) {
        errors.push(
          `line ${block.answerLine}: the recorded default for ${block.kind} ${problem} — ` +
            'a blank answer would write it verbatim, so type a shorter answer of your own instead',
        );
        continue;
      }
    }
    resolved.push({ ask, block, verdict });
  }
  return { resolved, errors };
}

/**
 * The sitting's own cross-process lock, one directory per journal.
 *
 * `append` locks per EVENT, which serializes bytes and nothing else: two
 * `apply` runs on one sheet each read the queue, each see the ask open, and
 * each write a decision and a closing gate — every question answered twice,
 * forever, in a file that cannot be corrected. This lock spans the re-read and
 * both appends, the shape `journal.mjs closeSpawn` already uses.
 *
 * A SEPARATE lock dir from `append`'s on purpose: taking that one here would
 * deadlock against the append it wraps.
 */
function withSittingLock(journal, fn) {
  const lockDir = `${canonicalPath(journal)}.answer.lock`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lockDir, { recursive: false });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        // A crashed run leaves the directory behind; 10s is far longer than a
        // sitting's two appends and far shorter than an operator's patience.
        if (Date.now() - statSync(lockDir).mtimeMs > 10_000) {
          rmdirSync(lockDir);
          continue;
        }
      } catch {
        continue; // the lock vanished between checks — retry immediately
      }
      if (Date.now() > deadline) throw new IOError(`another apply is holding ${lockDir}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lockDir);
  }
}

/**
 * Is this ask still open, according to the journal on disk RIGHT NOW?
 *
 * `fold` keys gates by kind with last-write-wins, so the LAST gate carrying
 * the kind is the one the board reads — the same rule, not a second one.
 * Called under `withSittingLock`: the value of this check is entirely in it
 * being inseparable from the append that follows.
 */
export function askState(journal, kind) {
  let last = null;
  for (const e of readJournal(journal).events) {
    if (e?.ev === 'gate' && String(e?.data?.kind ?? '') === kind) last = e;
  }
  if (last === null) return { open: false, why: 'no gate carrying it is in the journal any more' };
  if (WAITING_RE.test(String(last.data?.result ?? ''))) return { open: true };
  return {
    open: false,
    why: `another run closed it at ${inlinePlain(last.ts)} (result: ${inlinePlain(last.data?.result)})`,
  };
}

/**
 * Fold the sheet back into the journals. Appends nothing when anything at all
 * is wrong, and nothing at all when `dryRun` is set.
 *
 * The queue it matches against is the ANSWERABLE half of the board's: an ask
 * the grammar cannot round-trip is reported, never matched, so one legacy gate
 * cannot make every other initiative's answers unappliable.
 */
export function applySheet(tyranDir, sheetText, { dryRun = false } = {}) {
  const { asks, inits, errors: readErrors } = openAsks(tyranDir);
  const { answerable, unanswerable } = partitionAsks(asks);
  if (answerable.length === 0) {
    return { ok: false, empty: true, errors: [], results: [], unanswerable, readErrors };
  }
  const base = { results: [], open: answerable.length, unanswerable, readErrors };

  const parsed = parseSheet(sheetText);
  if (parsed.blocks.length === 0 && parsed.errors.length === 0) {
    return {
      ok: false,
      errors: ['no `## Q-<n> · <initiative>` block in the sheet — regenerate it: node scripts/answer.mjs render'],
      ...base,
    };
  }
  const matched = resolveBlocks(parsed.blocks, answerable, inits);
  const errors = [...parsed.errors, ...matched.errors];
  if (errors.length > 0) return { ok: false, errors, ...base };

  const results = [];
  const touched = new Map();
  for (const { ask, verdict } of matched.resolved) {
    if (verdict.mode === 'open' || dryRun) {
      results.push({ ask, verdict, decision: null });
      continue;
    }
    const outcome = sittingOutcome(ask, verdict);
    if (outcome.skipped !== undefined) {
      results.push({ ask, verdict, decision: null, skipped: outcome.skipped });
      continue;
    }
    touched.set(ask.init, ask.journal);
    results.push({ ask, verdict, decision: outcome.decision });
  }
  return { ok: true, errors: [], ...base, results, touched, dryRun };
}

/** One ask's two appends, or the reason nothing was written for it. A lock
 * this run could not take is reported like any other unwritten ask: the run
 * that holds it is writing the same sitting, and a thrown error here would
 * abandon the asks after this one without saying so. */
function sittingOutcome(ask, verdict) {
  try {
    return withSittingLock(ask.journal, () => {
      const state = askState(ask.journal, ask.kind);
      if (!state.open) return { skipped: state.why };
      // Decision FIRST, and its id is issued by `append` under the journal's own
      // write lock — computing one out here would be the race that lock closes.
      const written = append(ask.journal, eventsFor(ask, verdict).decision);
      const id = written.data.id;
      append(ask.journal, eventsFor(ask, verdict, id).gate);
      return { decision: id };
    });
  } catch (err) {
    if (!(err instanceof IOError)) throw err;
    return { skipped: err.message };
  }
}

/** Re-render every touched initiative AND the cross board. A board left stale
 * is a board that still shows a question that has been answered. */
export function reRender(tyranDir, touched) {
  const written = [];
  for (const [name, journal] of [...touched].sort((a, b) => naturalCompare(a[0], b[0]))) {
    const { files } = projectFile(journal);
    const dir = dirname(journal);
    writeAllAtomic(Object.entries(files).map(([file, content]) => [join(dir, file), content]));
    written.push({ dir, files: Object.keys(files), init: name });
  }
  const cross = renderAll(tyranDir);
  const stateDir = join(tyranDir, 'state');
  writeAllAtomic(Object.entries(cross.files).map(([file, content]) => [join(stateDir, file), content]));
  written.push({ dir: stateDir, files: Object.keys(cross.files), init: null });
  return written;
}

// ----------------------------------------------------------- the conductor

/** The session record the SessionStart probe writes. Garbage reads as absent. */
export function readConductor(tyranDir) {
  try {
    const path = join(tyranDir, 'state', CONDUCTOR_FILE);
    if (!existsSync(path) || statSync(path).size > 64 * 1024) return null;
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

/**
 * How long a recorded `started_at` still counts as "a session announced itself
 * here". `SessionStart` fires on startup, resume and compact, so a fresh stamp
 * is evidence one is around; a stale one is evidence of NOTHING, since a
 * conductor three days into an initiative has an old stamp.
 */
export const ANNOUNCED_FRESH_MS = 30 * 60 * 1000;

/**
 * What to say — and whether to spawn — about the session that will act on
 * these answers. Two conductors on one journal is a hazard this repo has
 * already paid for once.
 *
 * `conductor.json` carries NO liveness signal (see `recordConductor`): a hook
 * process can only observe its own pid, which is dead before anyone reads it
 * and later names a stranger. So this reads `started_at` in ONE direction —
 * recent enough, and no spawn, because a session announced itself and would
 * pick the answers up on its own. An old stamp licenses nothing by itself:
 * the only thing that authorizes a spawn is the operator typing `--resume`.
 * Absent evidence is UNKNOWN, never "it is dead".
 */
export function resumePlan(conductor, { resume = false, now = Date.now() } = {}) {
  const sessionId = typeof conductor?.session_id === 'string' ? conductor.session_id : null;
  if (sessionId === null || !SESSION_ID_RE.test(sessionId)) return { action: 'none' };
  const announced = Date.parse(String(conductor?.started_at ?? ''));
  if (Number.isFinite(announced) && now - announced >= 0 && now - announced <= ANNOUNCED_FRESH_MS) {
    return { action: 'announced', sessionId, since: String(conductor.started_at) };
  }
  return { action: resume ? 'spawn' : 'offer', sessionId };
}

// --------------------------------------------------------------- reporting

function excerpt(text) {
  const s = inlinePlain(text);
  const cps = Array.from(s);
  return cps.length > REPORT_EXCERPT ? cps.slice(0, REPORT_EXCERPT - 1).join('') + '…' : s;
}

export function reportLines(result) {
  const counts = { answered: 0, default: 0, open: 0, skipped: 0 };
  for (const r of result.results) counts[r.skipped === undefined ? r.verdict.mode : 'skipped'] += 1;
  const lines = [
    `answer: ${result.open} open · ${counts.answered} answered · ${counts.default} defaulted · ${counts.open} left open` +
      // Only when it happened: a counter that is 0 in every ordinary sitting
      // teaches the operator to stop reading the line.
      (counts.skipped > 0 ? ` · ${counts.skipped} already closed` : '') +
      (result.dryRun ? '  (--dry-run: nothing was appended)' : ''),
    '',
  ];
  const width = (pick) => Math.max(0, ...result.results.map((r) => inlinePlain(pick(r)).length));
  const kindWidth = width((r) => r.ask.kind);
  const initWidth = width((r) => r.ask.init);
  for (const r of result.results) {
    const mode = r.skipped === undefined ? r.verdict.mode : 'skipped';
    const verdict =
      mode === 'skipped' ? 'not written' : mode === 'open' ? 'left open  ' : mode === 'default' ? 'default    ' : 'answered   ';
    const tail =
      mode === 'skipped'
        ? `(${r.skipped})`
        : mode === 'open'
          ? `(${r.verdict.why})`
          : `"${excerpt(r.verdict.text)}"${r.decision === null ? '' : `   ${r.decision}`}`;
    lines.push(
      `  ${inlinePlain(r.ask.kind).padEnd(kindWidth)}  ${inlinePlain(r.ask.init).padEnd(initWidth)}  ${verdict}  ${tail}`,
    );
  }
  return lines;
}

function conductorLines(plan, answered) {
  if (plan.action === 'announced') {
    return [
      `a conductor session announced itself at ${inlinePlain(plan.since)} — nothing is spawned.`,
      '  If it is still running it will pick these up on its next loop. If it is not:',
      `  claude --resume ${plan.sessionId} "Answers landed for ${answered.join(', ')}"`,
    ];
  }
  if (plan.action === 'none') {
    return [
      'no conductor session id is recorded in .tyran/state/conductor.json.',
      '  Start one and it will read the answers out of the journal: /tyran',
    ];
  }
  return [
    'no conductor session has announced itself recently — conductor.json records no liveness signal,',
    '  so whether one is running is not knowable from here. To put the swarm back on it:',
    `  claude --resume ${plan.sessionId} "Answers landed for ${answered.join(', ')}"`,
    '  (or re-run apply with --resume and this command will do it)',
  ];
}

// ------------------------------------------------------------------- CLI

const BOOLEAN_FLAGS = ['dry-run', 'resume', 'force'];
const VALUE_FLAGS = ['dir'];

export function parseArgs(argv) {
  const flags = { dir: '.tyran' };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.includes(name)) flags[name] = true;
    else if (VALUE_FLAGS.includes(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`flag --${name} needs a value`);
      flags[name] = value;
      i += 1;
    } else throw new UsageError(`unknown flag --${name}`);
  }
  if (rest.length > 1) throw new UsageError(`unexpected extra argument "${rest[1]}"`);
  return { verb: rest[0] ?? null, flags };
}

const USAGE =
  'usage: answer.mjs render [--dir <.tyran>] [--force]\n' +
  '       answer.mjs apply  [--dir <.tyran>] [--dry-run] [--resume]';

/**
 * Answers already typed into the sheet on disk, for asks that are STILL OPEN.
 *
 * `render` overwrites the sheet, and doctor's fix string for every open ask
 * sends the operator to `render` — so re-rendering to see a new question would
 * silently destroy twenty minutes of typing. Answers for asks that are already
 * closed are not typing at risk: they are in the ledger.
 */
export function typedAnswers(text, openKeys) {
  const { blocks } = parseSheet(text);
  const typed = blocks
    .filter((b) => b.answer !== '' && openKeys.has(keyOf(b.init, b.kind)))
    .map((b) => `${b.kind} · ${inlinePlain(b.init)}`);
  if (typed.length > 0) return typed;
  // A sheet whose headings the operator broke parses into NO block at all —
  // the answers typed under them are still theirs, and which asks they belong
  // to is exactly what cannot be known here.
  if (blocks.length === 0 && sheetLines(text).some((l) => /^answer:[ \t]*\S/.test(l))) {
    return ['(an answer under a heading that does not parse)'];
  }
  return [];
}

function doRender(tyranDir, sheetPath, flags) {
  const { asks, errors } = openAsks(tyranDir);
  for (const e of errors) console.error(`answer: unreadable initiative ${inlinePlain(e.name)}: ${inlinePlain(e.error)}`);
  const { answerable, unanswerable } = partitionAsks(asks);
  for (const { ask, why } of unanswerable) {
    console.error(`answer: ${inlinePlain(ask.init)} · ${inlinePlain(ask.kind)} cannot be answered through the sheet — ${why}`);
  }
  if (answerable.length === 0) {
    console.error('answer: nothing is waiting on you');
    process.exit(1);
  }
  if (flags.force !== true && existsSync(sheetPath)) {
    const openKeys = new Set(answerable.map((a) => keyOf(a.init, a.kind)));
    const typed = typedAnswers(readFileSync(sheetPath, 'utf8'), openKeys);
    if (typed.length > 0) {
      console.error(`answer: ${sheetPath} already has ${typed.length} answer(s) typed into it: ${typed.join(', ')}`);
      console.error(`  apply them first: node scripts/answer.mjs apply --dir ${tyranDir}`);
      console.error('  or discard them and start the sitting again: add --force');
      process.exit(2);
    }
  }
  mkdirSync(dirname(sheetPath), { recursive: true });
  writeAtomic(sheetPath, renderSheet(asks));
  console.log(`answer: wrote ${sheetPath} — ${answerable.length} question(s) waiting on you`);
  console.log(`  fill the \`answer:\` lines, then: node scripts/answer.mjs apply --dir ${tyranDir}`);
  const noDefault = answerable.filter((a) => a.default == null).length;
  if (noDefault > 0) {
    console.log(`  ${noDefault} of them have no recorded default and come first — blank leaves those open.`);
  }
}

function doApply(tyranDir, sheetPath, flags) {
  if (!existsSync(sheetPath)) {
    throw new IOError(`no sheet at ${sheetPath} — write one first: node scripts/answer.mjs render --dir ${tyranDir}`);
  }
  const result = applySheet(tyranDir, readFileSync(sheetPath, 'utf8'), { dryRun: flags['dry-run'] === true });
  for (const e of result.readErrors ?? []) {
    console.error(`answer: unreadable initiative ${inlinePlain(e.name)}: ${inlinePlain(e.error)}`);
  }
  for (const { ask, why } of result.unanswerable ?? []) {
    console.error(`answer: ${inlinePlain(ask.init)} · ${inlinePlain(ask.kind)} cannot be answered through the sheet — ${why}`);
  }
  if (result.empty) {
    console.error('answer: nothing is waiting on you');
    process.exit(1);
  }
  if (!result.ok) {
    for (const e of result.errors) console.error(`answer: ${sheetPath}: ${e}`);
    console.error(
      `answer: nothing was appended — the sheet is applied whole or not at all (${result.errors.length} problem(s))`,
    );
    process.exit(2);
  }

  const lines = reportLines(result);
  // An ask another run closed while this one was parsing is not this run's to
  // announce: it wrote nothing for it.
  const closed = result.results.filter((r) => r.verdict.mode !== 'open' && r.skipped === undefined);
  const acted = !result.dryRun && closed.length > 0;
  if (acted) {
    lines.push('', 're-rendered');
    for (const { dir, files } of reRender(tyranDir, result.touched)) lines.push(`  ${dir}/{${files.join(',')}}`);
  }
  const plan = resumePlan(readConductor(tyranDir), { resume: flags.resume === true });
  const answered = closed.map((r) => r.ask.kind);
  if (acted) lines.push('', ...conductorLines(plan, answered));
  console.log(lines.join('\n'));

  if (acted && plan.action === 'spawn') {
    // Never through a shell: the argv is the whole command, and the session id
    // was shape-checked before it became one of its elements.
    const argv = resumeArgv(plan.sessionId, `Answers landed for ${answered.join(', ')} — read the journal tail and continue.`);
    const child = spawn(argv[0], argv.slice(1), {
      cwd: dirname(resolve(tyranDir)),
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.on('error', (err) => console.error(`answer: could not resume the session: ${err.message}`));
    child.unref();
    console.log(`answer: resumed session ${plan.sessionId} (pid ${child.pid ?? '?'})`);
  }
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`answer: ${err.message}`);
    console.error(USAGE);
    process.exit(2);
  }
  const tyranDir = resolve(parsed.flags.dir);
  const sheetPath = join(tyranDir, 'state', ANSWERS_FILE);
  try {
    if (!existsSync(tyranDir)) throw new IOError(`no such directory ${tyranDir}`);
    if (parsed.verb === 'render') return doRender(tyranDir, sheetPath, parsed.flags);
    if (parsed.verb === 'apply') return doApply(tyranDir, sheetPath, parsed.flags);
    // A verb-less invocation NEVER guesses. This command writes to the ledger,
    // and an invocation that sometimes writes and sometimes does not is what a
    // tired operator gets wrong at 23:00.
    console.error(USAGE);
    console.error(`answer: ${openAsks(tyranDir).asks.length} question(s) waiting on you — say \`render\` or \`apply\``);
    process.exit(2);
  } catch (err) {
    console.error(`answer: ${err.message}`);
    if (err instanceof UsageError) console.error(USAGE);
    process.exit(2);
  }
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

if (isMainModule(import.meta.url)) main();
