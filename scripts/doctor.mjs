#!/usr/bin/env node
/**
 * doctor — consistency check for a Tyran state directory (`.tyran/`).
 *
 * It finds the inconsistencies a human will not see by reading files:
 * projections that drifted from their journal, agents the journal still
 * believes are working, leases nobody holds any more, journal damage,
 * policy rules that can never match a path, and configuration that no
 * longer validates.
 *
 * It NEVER repairs anything. Every finding carries a severity, a location
 * and a command you can paste to fix it — a diagnosis that leaves you
 * guessing is not a diagnosis.
 *
 * Design rules (same as the rest of the core):
 *  - zero dependencies, plain Node >= 22;
 *  - deterministic: the same state renders the same bytes, always. Nothing
 *    reads the wall clock — "now" defaults to each journal's own last event
 *    (override with --now);
 *  - one implementation per rule: spawn pairing comes from journal.mjs,
 *    projection freshness from project.mjs, path classification from
 *    schema.mjs. Doctor asks those modules, it never re-derives their
 *    answers (ADR-18).
 *
 * CLI:
 *   node doctor.mjs --state [--dir <.tyran>] [--json]
 *                           [--now <iso>] [--stale-hours <n>]
 *   node doctor.mjs --hooks [--plugin-root <dir>] [--json]
 * Exit: 0 healthy (info findings allowed) · 1 findings (error or warning)
 *       · 2 usage / I/O error
 *
 * The two modes answer different questions and are deliberately separate.
 * `--state` asks whether the RECORD of the work is consistent. `--hooks` asks
 * whether the gates that produce that record can fire at all — a question
 * with no answer inside the state directory, because a plugin whose hooks are
 * dead writes no state to be inconsistent with.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHooks, DEFAULT_PLUGIN_ROOT } from './hooks-check.mjs';
import {
  readJournal,
  validateJournal,
  pairSpawns,
  tail,
  hoursBetween,
  spawnStaleness,
  unreadDataKeys,
  DEFAULT_STALE_HOURS,
} from './journal.mjs';
import {
  boardOf,
  checkFile,
  fold,
  inline,
  naturalCompare,
  renderProjections,
  BOARD_FILE,
  BOARD_JSON_FILE,
  PROGRESS_FILE,
  STATE_FILE,
} from './project.mjs';
import { classifyPath, normalizePath, validateFile, knowledgeWarnings, MANDATORY_KERNEL_PATHS } from './schema.mjs';
import { auditEntries, loadEntries as loadKnowledgeEntries } from './knowledge.mjs';
import { readPlatformUsage } from './usage-source.mjs';
import { gitRunner } from './scan-repo.mjs';
import { parseMistakes, countSignatures, fenceState, KNOWLEDGE_THRESHOLD, MISTAKES_FILE, CLAUDE_MD_FILE } from './mistakes.mjs';

/** Severity order is also the report order. `info` never fails the check. */
export const SEVERITIES = Object.freeze(['error', 'warning', 'info']);

/**
 * Default: an agent open this long without the journal moving on is stuck.
 *
 * Re-exported, not redefined. The threshold and the comparison both live in
 * `journal.mjs` so the board renders doctor's answer instead of computing a
 * second one — `--stale-hours` still moves it for this report alone.
 */
export { DEFAULT_STALE_HOURS };

const JOURNAL_FILE = 'journal.jsonl';

class UsageError extends Error {}
class IOError extends Error {}

// --------------------------------------------------------------- helpers

/**
 * Shell-quote one argument of a fix command.
 *
 * Plain POSIX single-quoting for anything printable ASCII (journal.mjs has
 * the identical three lines but does not export them). Anything else falls
 * back to ANSI-C quoting, `$'...'`, with every other byte written `\xNN`.
 *
 * That fallback is not cosmetic. `data.agent` is guarded by
 * `agentNameProblem`, but `init` has NO such validator — `validateEvent`
 * only asks for a non-empty string — and neither do lease resource names.
 * A journal carrying `"init": "demo<ESC>[2K<ESC>[1A"` would otherwise put a
 * real erase-line + cursor-up sequence into a printed command and wipe the
 * finding above it: the diagnosis that flags the hostile value would be the
 * thing that hides it.
 *
 * `\xNN` rather than `\uHHHH` on purpose: `$'\u...'` needs bash >= 4.2 and
 * macOS still ships bash 3.2. Byte escapes work in bash 3.2, bash 5 and
 * zsh alike, and the command stays runnable and byte-exact — the value is
 * escaped, never replaced.
 */
const PRINTABLE_ASCII_ONLY = /^[ -~]*$/;

function sq(value) {
  const s = String(value);
  if (PRINTABLE_ASCII_ONLY.test(s)) return `'${s.replace(/'/g, `'\\''`)}'`;
  let out = '';
  for (const byte of Buffer.from(s, 'utf8')) {
    if (byte === 0x27) out += "\\'";
    else if (byte === 0x5c) out += '\\\\';
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
    else out += `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return `$'${out}'`;
}

/**
 * Every value that came out of a journal passes through project.inline():
 * in a plugin, `data` is written by agents processing someone else's repo,
 * so an agent name may carry an ANSI escape or a bidi override and would
 * otherwise rewrite the report a human is reading. Reusing project.mjs's
 * sanitizer rather than writing a second one is the ADR-18 rule applied to
 * a security control. Cost: exotic values are shown HTML-escaped.
 */
const show = inline;

/**
 * JSON for a `--data` argument, with every non-ASCII codepoint written as a
 * `\uXXXX` escape. This is an ESCAPER, not a sanitizer: `JSON.parse` gives
 * back the exact original value, so the printed command still does the right
 * thing — while a lease resource carrying a bidi override (lease `data` is
 * free-form and validated by nobody) can no longer rewrite the terminal line
 * it is printed on. `JSON.stringify` alone escapes C0 but passes bidi
 * through.
 */
function jsonArg(value) {
  return JSON.stringify(value).replace(/[^ -~]/g, (c) =>
    `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * Severity is a property of the finding CODE, declared once, here.
 *
 * It used to be a literal at each of the 40 call sites, which meant 40
 * independent places where an `error` could become an `info` and every test
 * would stay green — a clean bill of health for a state layer nobody
 * checked, which is the one output this tool must never produce. One table
 * is one mutation surface, and `tests/unit/doctor.test.mjs` pins it whole,
 * including the branches that are hard to reach at runtime.
 *
 * Prototype-free so a code called `constructor` cannot resolve to an
 * inherited member (the same reason yaml-lite does it — review E2S2-R2).
 */
export const SEVERITY_BY_CODE = Object.freeze(
  Object.assign(Object.create(null), {
    // journal
    'journal-missing': 'warning',
    'journal-unreadable': 'error',
    'journal-not-a-file': 'error',
    'journal-invalid': 'error',
    'journal-truncated': 'warning',
    'journal-warning': 'warning',
    'journal-lock-present': 'warning',
    'journal-init-mismatch': 'error',
    'journal-cross-init-pairing': 'error',
    'journal-mixed-initiatives': 'warning',
    'check-failed': 'error',
    // spawns
    'spawn-open': 'info',
    'spawn-stale': 'warning',
    'spawn-blocked': 'warning',
    'spawn-duplicate': 'warning',
    'spawn-orphan-report': 'warning',
    'agent-name-unusable': 'warning',
    // operator asks
    'ask-open': 'info',
    'ask-stale': 'warning',
    // leases
    'lease-open': 'info',
    'lease-orphan': 'warning',
    'lease-expired': 'warning',
    'lease-release-by-non-holder': 'warning',
    // worktrees
    'worktree-accumulating': 'warning',
    // projections
    'projection-drift': 'warning',
    'projection-absent': 'info',
    'projection-missing': 'warning',
    'projection-blocked': 'warning',
    'projection-failed': 'error',
    'projection-unreadable': 'error',
    'board-absent': 'info',
    // configuration
    'config-missing': 'info',
    'config-invalid': 'error',
    'config-unreadable': 'error',
    'knowledge-invalid': 'error',
    'knowledge-unreadable': 'error',
    'knowledge-not-a-directory': 'warning',
    'knowledge-entry-oversized': 'warning',
    // The AGGREGATE of the line above. `info`, not `warning`: nothing is
    // broken and a store outgrows the budget in the ordinary course of being
    // useful — but "1 of 31 entries reaches a brief" is the number that gets
    // acted on, and five per-entry notes never added up to it for anyone.
    'knowledge-store-unreachable': 'info',
    // Not `info`, which is what it was: with `.tyran/` on disk and no policy
    // under it the gate refuses every write in the repository. A severity that
    // does not fail the check reports a locked-out repo as a note.
    'tyran-dir-untracked': 'warning',
    'policy-missing': 'error',
    'policy-invalid': 'error',
    'policy-unreadable': 'error',
    'policies-unreadable': 'error',
    'policies-not-a-directory': 'warning',
    'policy-kernel-downgrade': 'error',
    'policy-rule-dead': 'warning',
    'policy-rule-overruled': 'warning',
    // layout
    'no-state-dir': 'info',
    'state-not-a-directory': 'error',
    'state-unreadable': 'error',
    'state-stray-file': 'warning',
    'state-legacy-initiatives-dir': 'warning',
    'lease-file-tracked': 'warning',
    // the ledger in git. `uncommitted` is INFO on purpose: every append
    // produces that state within seconds, and a warning that is on during
    // normal operation is a warning people learn to scroll past.
    'initiative-untracked': 'warning',
    'initiative-ignored': 'warning',
    'initiative-uncommitted': 'info',
    // the mistakes ledger. `mistakes-unreadable` is a WARNING, not the `error`
    // that `knowledge-unreadable` and `config-unreadable` carry: nothing
    // mechanical consumes MISTAKES.md at write time, so an unreadable one
    // degrades learning without stopping work, and exiting 1 on it would be a
    // false alarm about a repository that is fine. The other two are `info`
    // for the same reason `spawn-open` is: a warning would go red on every
    // healthy repo between a breakage and its next retro, and a check that is
    // red during normal operation is a check people learn to skip.
    'mistakes-unreadable': 'warning',
    'mistakes-repeat-unpromoted': 'info',
    // `info`, and it fires only where git proves the file NEVER existed —
    // a deletion is the documented opt-out and stays silent. See
    // `absentMistakes` for why the two need telling apart at all.
    'mistakes-file-missing': 'info',
    // Data keys nothing reads. The near miss is a WARNING because it is silent
    // data loss and a healthy journal has none; the plain count is `info`
    // because extra keys are what the envelope promises, and a warning per
    // improvised key would be red on every healthy repo.
    'journal-key-near-miss': 'warning',
    'journal-key-unread': 'info',
    'claude-md-fence-missing': 'info',
    // overnight mode
    'limit-pause-active': 'info',
    'limit-pause-stale': 'warning',
    'limit-resume-watcher-dead': 'warning',
    'limit-telemetry-missing': 'warning',
  }),
);

/**
 * The severity of a finding code, or a loud failure.
 *
 * Exported so the guard itself can be tested: not every code reaches
 * `SEVERITY_BY_CODE` as a literal — two families are built from a template
 * variable (`${kind}-invalid`, `${label}-not-a-directory`) and a static scan
 * of the source cannot see those. A typo there would otherwise produce a
 * finding with `severity: undefined`, which sorts and counts as nothing and
 * would quietly stop failing the check.
 */
export function severityFor(code) {
  const severity = SEVERITY_BY_CODE[code];
  if (severity === undefined) {
    throw new Error(`doctor bug: finding code "${code}" has no severity in SEVERITY_BY_CODE`);
  }
  return severity;
}

function finding(code, where, message, fix = null) {
  return { severity: severityFor(code), code, where, message, fix };
}

/**
 * Explicit, total, stable ordering — determinism is a guarantee here.
 *
 * The `a[1] - b[1]` tie-break is deliberately REDUNDANT: the findings are
 * index-decorated and `Array.prototype.sort` has been stable since ES2019,
 * so it can only ever agree with the order the checks produced (measured:
 * 200 000 randomized orderings over a corpus of naturalCompare ties, 0
 * differences — an equivalent mutant, not an untested branch). It stays
 * because the ordering is a documented guarantee and should not rest on a
 * reader remembering which engines sort stably.
 */
function sortFindings(findings) {
  const rank = (s) => SEVERITIES.indexOf(s);
  return findings
    .map((f, i) => [f, i])
    .sort((a, b) => {
      const bySeverity = rank(a[0].severity) - rank(b[0].severity);
      if (bySeverity !== 0) return bySeverity;
      const key = (f) => `${f.code} ${f.where} ${f.message}`;
      return naturalCompare(key(a[0]), key(b[0])) || a[1] - b[1];
    })
    .map(([f]) => f);
}

function sortedNames(names) {
  return [...names].sort((a, b) => naturalCompare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Node prefixes most fs errors with their own code, so the naive
 * `code: message` form prints "EACCES: EACCES: permission denied". The
 * errno is the actionable part of these findings; print it exactly once.
 */
function errText(err) {
  const code = err.code ?? err.name;
  const message = String(err.message ?? '');
  return message.startsWith(code + ':') ? message : code + ': ' + message;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// `hoursBetween` is imported from journal.mjs, next to the staleness rule it
// serves — see the note on `spawnStaleness` for why that rule cannot live here.

// -------------------------------------------------------- policy analysis

/**
 * A policy rule only ever meets paths that `classifyPath` has normalized:
 * repo-relative, POSIX separators, no `.`/`..` segments, no leading slash.
 * A glob whose own literal instantiation does not survive that
 * normalization can therefore never match anything, whatever it looks like.
 *
 * That is the whole detection method, and it is deliberately NOT a table of
 * possible repo paths (which would be unbounded and would only ever prove a
 * rule live, never dead). Instead each glob is instantiated into witness
 * paths — `**` becomes real segments, `*` becomes a segment — and the
 * witness is pushed through `normalizePath`. If normalization changes or
 * rejects EVERY witness, the literal parts of the glob contain exactly the
 * characters normalization removes (`./`, a leading `/`, a backslash, a
 * `..`), and those parts have to appear verbatim in any match. The rule is
 * dead. If one witness survives unchanged, the glob matches at least that
 * path and the rule is live; the check stays silent.
 *
 * Conservative on purpose: a false "dead" alarm on a live security rule
 * would be worse than the miss it is meant to prevent.
 */
export function witnessesFor(glob) {
  const shapes = [
    glob.replace(/\*\*/g, 'w1/w2').replace(/\*/g, 'w3'),
    glob.replace(/\*\*/g, 'w1').replace(/\*/g, 'w3'),
    glob.replace(/\*\*/g, 'w1/w2/w3').replace(/\*/g, 'w4'),
  ];
  return [...new Set(shapes)];
}

/** Would `classifyPath` ever see this witness in this shape? */
function reachable(witness, repoRoot) {
  const normalized = normalizePath(witness, repoRoot);
  return normalized !== null && normalized !== '' && normalized === witness;
}

const NO_RULES = Object.freeze({ rules: [], default: 'AUTO' });

/** True when a path is protected unconditionally, whatever the rules say. */
function isKernelPath(path) {
  return classifyPath(NO_RULES, path) === 'KERNEL';
}

/**
 * The glob the author most likely meant: strip a leading `/`, fold Windows
 * separators, drop `./` segments. Wildcards survive untouched.
 */
function suggestedGlob(glob, repoRoot) {
  const cleaned = String(glob).replace(/\\/g, '/').replace(/^\/+/, '');
  const normalized = normalizePath(cleaned, repoRoot);
  if (normalized === null || normalized === '' || normalized === glob) return null;
  return normalized;
}

/** Rules that can never match a path — see witnessesFor() for the method. */
export function deadRules(policy, repoRoot) {
  const out = [];
  for (const [index, rule] of (policy?.rules ?? []).entries()) {
    if (typeof rule?.path !== 'string' || rule.path.trim() === '') continue;
    if (witnessesFor(rule.path).some((w) => reachable(w, repoRoot))) continue;
    const suggestion = suggestedGlob(rule.path, repoRoot);
    out.push({
      index,
      path: rule.path,
      class: rule.class,
      suggestion,
      // A dead rule aimed INTO a protected namespace is the worst case: the
      // author believes they classified `hooks/**` and nothing is written
      // down anywhere that says they did not.
      aimedAtKernel:
        suggestion !== null &&
        witnessesFor(suggestion).some((w) => reachable(w, repoRoot) && isKernelPath(w)),
    });
  }
  return out;
}

/**
 * Rules that claim a path inside a protected kernel namespace and are
 * therefore silently ignored there: `classifyPath` returns KERNEL for those
 * paths BEFORE any rule is consulted.
 *
 * `validatePolicy` already rejects most spellings of this as an error, but
 * its heuristic instantiates the rule's wildcards with filler segments, so
 * a rule like "star-slash-x.mjs" slips through — it validates clean while
 * quietly failing to cover `hooks/x.mjs`. This check covers the WHOLE-
 * SEGMENT wildcard shapes: the rule's own wildcards are instantiated with
 * segments of the PROTECTED path, which means the rule matches the
 * candidate by construction (`**` absorbs separators, `*` gets a
 * separator-free segment), so no second glob matcher is needed and a false
 * positive is impossible.
 *
 * KNOWN GAP, measured, deliberately left open here: a wildcard INSIDE a
 * segment is not covered, because the substitution gives `*` the whole
 * segment. A rule spelled "h-star-slash-x.mjs" (wildcard inside the first
 * segment) validates clean AND reaches `hooks/x.mjs`, and doctor stays
 * silent about it — see docs/doctor.md. Closing that needs the
 * real matcher — `globMatches` in schema.mjs, which is private, and
 * exporting it is a change to a module this story may not touch (ADR-18
 * forbids the alternative, a second copy). Tracked, and written down in
 * docs/doctor.md under Known limits rather than papered over.
 */
export function overruledRules(policy, repoRoot) {
  const out = [];
  for (const [index, rule] of (policy?.rules ?? []).entries()) {
    if (typeof rule?.path !== 'string' || rule.path.trim() === '' || rule.class === 'KERNEL') continue;
    for (const protectedGlob of MANDATORY_KERNEL_PATHS) {
      const base = protectedGlob.replace(/\/?\*\*$/, '');
      const leaf = base.split('/').filter(Boolean).at(-1) ?? 'w';
      const candidates = [
        rule.path.replace(/\*\*/g, base).replace(/\*/g, leaf),
        rule.path.replace(/\*\*/g, `${base}/w`).replace(/\*/g, leaf),
        rule.path.replace(/\*\*/g, `w/${base}`).replace(/\*/g, leaf),
      ];
      const hit = candidates.find((c) => reachable(c, repoRoot) && isKernelPath(c));
      if (hit !== undefined) {
        out.push({ index, path: rule.path, class: rule.class, protectedGlob, example: hit });
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ state scan

/**
 * Findings for one initiative directory: `.tyran/state/<init>/`.
 * `now` is the reference clock; when null, the journal's own last event is
 * used, which keeps the output deterministic AND gives staleness a useful
 * meaning: an agent is stale when the initiative moved on without it.
 */
function checkInitiative(stateDir, name, { now, staleHours }) {
  const dir = join(stateDir, name);
  const journalPath = join(dir, JOURNAL_FILE);
  const at = show(journalPath);
  const findings = [];

  // `existsSync` answers false for ENOENT and for EACCES alike, so asking it
  // whether the journal is there conflates "there is no journal" with "this
  // process may not look". Those need opposite advice, and the wrong one is
  // destructive: an unreadable directory used to be reported as an empty
  // initiative together with a runnable `rm -r` that would have deleted an
  // intact journal. stat() and read the errno.
  let stat = null;
  try {
    stat = statSync(journalPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      findings.push(
        finding(
          'journal-missing',
          show(dir),
          `initiative directory with no ${JOURNAL_FILE} — nothing records what happened here`,
          // Deliberately NOT a removal: this branch is a diagnosis, and a
          // diagnosis that is allowed to be wrong must not hand out a
          // command that destroys the thing it failed to find.
          `ls -la ${sq(dir)}   # then restore journal.jsonl from git, or remove the directory by hand`,
        ),
      );
    } else {
      findings.push(
        finding(
          'journal-unreadable',
          at,
          `cannot stat the journal (${errText(err)}) — nothing about this initiative ` +
            'was checked, and nothing here says the journal is missing',
          `ls -la ${sq(dir)}`,
        ),
      );
    }
    return { findings, events: 0 };
  }
  if (stat.isDirectory()) {
    findings.push(
      finding('journal-not-a-file', at, `${JOURNAL_FILE} is a directory, not a file`),
    );
    return { findings, events: 0 };
  }

  let read;
  try {
    read = readJournal(journalPath);
  } catch (err) {
    findings.push(
      finding('journal-unreadable', at, `cannot read the journal (${errText(err)})`),
    );
    return { findings, events: 0 };
  }
  const events = read.events;
  const reference = now ?? events.at(-1)?.ts ?? null;

  // Each check is fenced off. A journal is a file a human can edit, so a
  // shape no reader anticipated (`"data": null` on a lease event throws
  // inside journal.tail(), measured) must cost one check, not the whole
  // report — a doctor that aborts on the first sick patient is worse than
  // no doctor.
  const guard = (label, fn) => {
    try {
      findings.push(...fn());
    } catch (err) {
      findings.push(
        finding(
          'check-failed',
          at,
          `the "${label}" check could not run on this journal (${errText(err)}) — the file holds a ` +
            'shape the readers do not expect, which almost always means it was edited by hand',
          `node scripts/journal.mjs validate ${sq(journalPath)}`,
        ),
      );
    }
  };
  guard('journal integrity', () => journalIntegrity(journalPath, at, read));
  guard('data keys nothing reads', () => unreadKeyFindings(at, events));
  guard('one initiative per file', () => initiativeScope(journalPath, at, name, events));
  guard('open spawns', () => spawnFindings(journalPath, at, name, events, reference, staleHours));
  guard('operator asks', () => askFindings(journalPath, at, read, reference));
  guard('leases', () => leaseFindings(journalPath, at, events, reference));
  guard('projections', () => projectionFindings(journalPath, dir, at, read));

  // A leftover lock directory means a writer either is inside its critical
  // section right now, or died in it. journal.mjs steals such a lock after
  // 10 s, so this never blocks — but per docs/journal.md the same window can
  // make an append write its event AND throw, so a retry may have doubled it.
  const lockDir = `${journalPath}.lock`;
  if (existsSync(lockDir)) {
    findings.push(
      finding(
        'journal-lock-present',
        show(lockDir),
        'a journal write lock is held — either a writer is running right now, or one died inside its critical section',
        `ls -ld ${sq(lockDir)}   # then, once no writer is running: rmdir ${sq(lockDir)}`,
      ),
    );
  }
  return { findings, events: events.length };
}

function journalIntegrity(journalPath, at, read) {
  const findings = [];
  const result = validateJournal(journalPath);

  for (const error of result.errors) {
    findings.push(
      // `show()` even though journal.mjs now escapes its own messages: the
      // sibling sweep below has always done it, and a fuzz of this file found
      // 137 leaks in exactly the one place that did not. Relying on the other
      // module's discipline is how the gap got here in the first place.
      finding('journal-invalid', at, show(error), `node scripts/journal.mjs validate ${sq(journalPath)}`),
    );
  }
  if (read.truncatedTail) {
    findings.push(
      finding(
        'journal-truncated',
        at,
        'the final line is truncated (a crash mid-write) — readers discard it, so that event is lost',
        `tail -c 400 ${sq(journalPath)}   # confirm the tail, then re-append the lost event`,
      ),
    );
  }

  // Spawn-pairing findings are RAISED from journal.mjs, never recomputed
  // (ADR-18). pairSpawns() gives the structured version so each one can get
  // its own code and its own fix; validateJournal()'s warnings are then
  // swept for anything those three shapes do not explain, so a warning class
  // added to journal.mjs later surfaces here instead of vanishing.
  const { open, orphanReports, badNames } = pairSpawns(read.events);
  for (const [agent, spawns] of open) {
    if (spawns.length < 2) continue;
    findings.push(
      finding(
        'spawn-duplicate',
        at,
        `agent "${show(agent)}" has ${spawns.length} open spawns (since ${spawns.map((s) => show(s.ts)).join(', ')}) — ` +
          'spawn/report pairing for this name is ambiguous; the journal was hand-edited or written before ADR-18',
        closeSpawnHint(journalPath, spawns[0].init, agent) +
          '   # once per surplus spawn, oldest first',
      ),
    );
  }
  for (const report of orphanReports) {
    findings.push(
      finding(
        'spawn-orphan-report',
        at,
        `report for agent "${show(report.data.agent)}" at ${show(report.ts)} closes no open spawn — ` +
          'its spawn event is missing, or an earlier report already closed it',
        `node scripts/journal.mjs query ${sq(journalPath)} --ev spawn`,
      ),
    );
  }
  for (const [raw, problem] of badNames) {
    findings.push(
      finding(
        'agent-name-unusable',
        at,
        `data.agent ${show(raw)}: ${problem} — those events are excluded from spawn/report pairing entirely`,
        `node scripts/journal.mjs validate ${sq(journalPath)}`,
      ),
    );
  }

  const explained = [
    /^agent ".*" has \d+ open spawns/s,
    /^report for agent /s,
    /^unusable data\.agent /s,
  ];
  for (const warning of result.warnings) {
    if (explained.some((shape) => shape.test(warning))) continue;
    findings.push(finding('journal-warning', at, show(warning)));
  }
  return findings;
}

/**
 * One initiative, one file (docs/journal.md). Nothing enforced that until
 * now, and `pairSpawns` does not look at `init` at all — so a `report` from
 * one initiative silently closes a `spawn` from another, and `validate`
 * stays clean. Detected by running the SAME pairing function twice: once
 * over the whole file, once per initiative. If the open sets disagree, a
 * report crossed a boundary.
 */
function initiativeScope(journalPath, at, dirName, events) {
  const findings = [];
  const inits = [];
  for (const e of events) {
    if (typeof e?.init === 'string' && e.init !== '' && !inits.includes(e.init)) inits.push(e.init);
  }
  const foreign = inits.filter((i) => i !== dirName);
  if (foreign.length > 0) {
    findings.push(
      finding(
        'journal-init-mismatch',
        at,
        `events carry initiative ${foreign.map((i) => `"${show(i)}"`).join(', ')} but this journal lives in ` +
          `state/${show(dirName)}/ — the directory name is the initiative slug`,
        `node scripts/journal.mjs query ${sq(journalPath)} --init ${sq(foreign[0])}`,
      ),
    );
  }
  if (inits.length <= 1) return findings;

  const signature = (map) =>
    sortedNames([...map.entries()].map(([agent, spawns]) => `${agent}:${spawns.length}`)).join(' ');
  const whole = signature(pairSpawns(events).open);
  const perInit = signature(
    new Map(
      inits.flatMap((init) => [...pairSpawns(events.filter((e) => e?.init === init)).open.entries()]),
    ),
  );
  if (whole !== perInit) {
    findings.push(
      finding(
        'journal-cross-init-pairing',
        at,
        `a report from one initiative closed a spawn from another: pairing over the whole file leaves ` +
          `[${show(whole) === '&mdash;' ? '' : show(whole)}] open, pairing per initiative leaves ` +
          `[${show(perInit) === '&mdash;' ? '' : show(perInit)}] — spawn/report pairing ignores "init", so who is ` +
          'still working cannot be answered from this file',
        `node scripts/journal.mjs open-spawns ${sq(journalPath)}   # then split the file: one initiative, one journal`,
      ),
    );
  } else {
    findings.push(
      finding(
        'journal-mixed-initiatives',
        at,
        `this journal mixes ${inits.length} initiatives (${inits.map((i) => show(i)).join(', ')}) — the contract is ` +
          'one initiative, one file; spawn/report pairing ignores "init" and will cross the boundary as soon as ' +
          'two initiatives share an agent name',
        `node scripts/journal.mjs query ${sq(journalPath)} --init ${sq(inits[0])}`,
      ),
    );
  }
  return findings;
}

/**
 * The agent name goes in RAW (only shell-quoted): every name that reaches an
 * open spawn has passed `agentNameProblem`, so it provably carries no
 * control, bidi or zero-width characters. Sanitizing it here would produce a
 * command that is safe and wrong — and a fix command that does not run is
 * the failure mode this project has already shipped once.
 *
 * A name may legally start with `-`; it then goes after the POSIX
 * end-of-options separator, which forces the flags to come first.
 */
function closeSpawnHint(journalPath, init, agent) {
  const slug = typeof init === 'string' && init !== '' ? init : '<initiative>';
  return String(agent).startsWith('-')
    ? `node scripts/journal.mjs close-spawn ${sq(journalPath)} --reason "<why>" ${sq(slug)} -- ${sq(agent)}`
    : `node scripts/journal.mjs close-spawn ${sq(journalPath)} ${sq(slug)} ${sq(agent)} --reason "<why>"`;
}

/**
 * Is the knowledge store actually READABLE, as a whole?
 *
 * Every failure returns [] rather than throwing: this is advisory, it runs
 * after the checks that decide whether the repo works at all, and a store
 * that cannot be listed is already reported by `yamlFilesIn` above.
 */
function knowledgeReachability(knowledgeDir) {
  let entries;
  try {
    if (!isDirectory(knowledgeDir)) return [];
    ({ entries } = loadKnowledgeEntries(knowledgeDir));
  } catch {
    return [];
  }
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const report = auditEntries(entries);
  // Silent while the store still fits: pressure that is being obeyed is not a
  // finding, and a check that is red on every healthy repo is one people skip.
  if (report.unreachable === 0) return [];
  const stuck = report.aloneTooBig;
  const detail =
    stuck.length === 0
      ? ''
      : ` ${stuck.length} of them cannot appear in ANY brief even alone (widest: ` +
        `${show(stuck[0].id)} at ${stuck[0].cost}), so no budget a caller passes will reach them.`;
  return [
    finding(
      'knowledge-store-unreachable',
      show(knowledgeDir),
      `${report.reachable} of ${report.entries} knowledge entries can reach one brief at the ` +
        `${report.budget}-codepoint budget; ${report.unreachable} cannot.${detail} The store is written ` +
        'by every retrospective and read through that budget, so what does not fit is not merely ' +
        'crowded — it reaches nobody',
      `node scripts/knowledge.mjs audit --dir ${sq(knowledgeDir)}   # the full list, widest first`,
    ),
  ];
}

/** How many unread keys are named before the rest are counted instead. */
const MAX_NAMED_KEYS = 12;

/**
 * Data keys nothing reads — the end of accept-then-ignore, minus the nagging.
 *
 * `append` accepts any key by design, and it must: `data may always carry
 * extra keys` is the envelope's promise, the evidence gate writes four of its
 * own, and turning it into a rule would fail every journal ever written. So
 * this is a REPORT, never a refusal, and it splits into two sentences because
 * the two situations are not the same failure.
 *
 * A NEAR MISS is the defect: `next_step` for `next_steps` is accepted,
 * ignored, and leaves the resume surface empty while the agent that wrote it
 * believes it recorded something. That is worth a warning each, because it is
 * silent data loss and a healthy journal has none.
 *
 * Everything else is the contract working. Measured on one real install: 130
 * distinct (event, key) pairs across 39 initiatives, nearly all of it
 * deliberate annotation. Those are COUNTED — never dropped, ADR-19 correction
 * 1 — at `info`, in one line, because a warning per improvised key would go
 * red on every healthy repo and a check that is red during normal operation is
 * a check people learn to skip.
 */
function unreadKeyFindings(at, events) {
  const { unread, nearMisses } = unreadDataKeys(events);
  const findings = nearMisses.map((m) =>
    finding(
      'journal-key-near-miss',
      at,
      `${m.count} ${show(m.ev)} event(s) carry \`${show(m.key)}\`, one edit from \`${show(m.meant)}\`, which is ` +
        'the key consumers actually read. A misspelled key is accepted, never read, and never reported — ' +
        'the writer believes it recorded something and nothing did',
      `node scripts/journal.mjs query ${sq(at)} --ev ${sq(m.ev)}   # then correct the writer; the journal is append-only, so past events keep the typo`,
    ),
  );
  // Named minus the near-misses: those already have a finding of their own,
  // and listing them twice would read as twice as many problems.
  const rest = [...unread.keys()].filter((id) => !nearMisses.some((m) => `${m.ev}.${m.key}` === id)).sort();
  if (rest.length > 0) {
    const shown = rest.slice(0, MAX_NAMED_KEYS).map((id) => `${id} x${unread.get(id)}`).join(', ');
    findings.push(
      finding(
        'journal-key-unread',
        at,
        `${rest.length} data key(s) that no consumer reads: ${show(shown)}` +
          (rest.length > MAX_NAMED_KEYS ? ` (+${rest.length - MAX_NAMED_KEYS} more)` : '') +
          '. Extra keys are legal and this is not a defect — it is what the envelope promises. Stated so ' +
          'that "recorded" and "recorded AND read" stay distinguishable',
      ),
    );
  }
  return findings;
}

/** How long a self-reported `blocked` may stand before it is a finding. */
export const DEFAULT_BLOCKED_HOURS = 1;

/** The latest `progress` signal per agent, from the raw events. */
function lastSignals(events) {
  const signals = new Map();
  for (const e of events) {
    if (e?.ev === 'progress' && typeof e?.data?.agent === 'string') {
      signals.set(e.data.agent, { state: e.data.state ?? null, detail: e.data.detail ?? null, ts: e.ts ?? null });
    }
  }
  return signals;
}

function spawnFindings(journalPath, at, dirName, events, reference, staleHours) {
  const findings = [];
  const { open } = pairSpawns(events);
  const signals = lastSignals(events);
  for (const agent of sortedNames(open.keys())) {
    for (const spawn of open.get(agent)) {
      // The shared rule, not a local one: the board reads the same predicate,
      // so an agent doctor calls abandoned can never still read `running`
      // there. `--stale-hours` moves the threshold for this report alone.
      const { ageHours: age, stale } = spawnStaleness(spawn.ts, reference, staleHours);
      const where = `${show(spawn.data.ticket ?? 'no ticket')}, role ${show(spawn.data.role)}`;
      // `lastSignals` is keyed by agent NAME, and ADR-18 permits a name to be
      // re-spawned once its previous spawn is closed — so the latest signal
      // under this name may belong to an incarnation that has already
      // reported, whose blockage the report cleared. Only a signal emitted
      // during THIS spawn describes the agent running now; a pair that cannot
      // be ordered (a hand-edited timestamp) is not evidence either.
      const latest = signals.get(agent) ?? null;
      const sinceSpawn = latest === null ? null : hoursBetween(spawn.ts, latest.ts);
      const signal = sinceSpawn !== null && sinceSpawn >= 0 ? latest : null;
      const blockedHours =
        signal?.state === 'blocked' && reference !== null ? hoursBetween(signal.ts, reference) : null;
      if (blockedHours !== null && blockedHours >= DEFAULT_BLOCKED_HOURS) {
        findings.push(
          finding(
            'spawn-blocked',
            at,
            `agent "${show(agent)}" reported itself BLOCKED ${blockedHours.toFixed(1)} h of journal time ago ` +
              `(${show(signal.detail ?? 'no detail')}) and nothing has cleared it. ${where}`,
            closeSpawnHint(journalPath, spawn.init ?? dirName, agent),
          ),
        );
      } else if (stale) {
        findings.push(
          finding(
            'spawn-stale',
            at,
            `agent "${show(agent)}" has been open for ${age.toFixed(1)} h of journal time (spawned ` +
              `${show(spawn.ts)}, journal now at ${show(reference)}; threshold ${staleHours} h) — the initiative ` +
              `moved on without it. ${where}`,
            closeSpawnHint(journalPath, spawn.init ?? dirName, agent),
          ),
        );
      } else {
        findings.push(
          finding(
            'spawn-open',
            at,
            `agent "${show(agent)}" is still working (spawned ${show(spawn.ts)})` +
              (signal ? ` — last signal ${show(signal.state)} at ${show(signal.ts)}` : '') +
              `. ${where}`,
          ),
        );
      }
    }
  }
  return findings;
}

/**
 * How long an operator ask may stand before it is a finding. A module
 * constant, not a config key: the threshold is measured in journal time and
 * nobody has yet needed a different one.
 */
export const DEFAULT_ASK_STALE_HOURS = 72;

/**
 * Questions waiting on a human. The queue is `boardOf`'s — the same one
 * BOARD.md prints and `answer.mjs` closes — so doctor cannot disagree with
 * the board about what is still open (ADR-18).
 *
 * Same reference clock as spawns: the journal's own last event unless `--now`
 * says otherwise, which is what the SessionStart probe passes it for.
 */
function askFindings(journalPath, at, read, reference) {
  const findings = [];
  const { asks } = boardOf(fold(read));
  // The trailer is a `#` comment, not a parenthetical: a fix string is pasted
  // into a shell verbatim, and `(…)` is a subshell whose parse fails before
  // anything runs — the operator gets a syntax error instead of the sheet.
  const answerHint =
    `node scripts/answer.mjs render --dir ${sq(dirname(dirname(dirname(resolve(journalPath)))))}` +
    '   # fill the answer: lines, then apply';
  for (const ask of [...asks].sort((a, b) => naturalCompare(String(a.kind), String(b.kind)))) {
    const question = ask.question == null ? '' : ` — "${show(ask.question)}"`;
    const waited = reference === null || ask.since == null ? null : hoursBetween(String(ask.since), reference);
    if (waited !== null && waited >= DEFAULT_ASK_STALE_HOURS) {
      findings.push(
        finding(
          'ask-stale',
          at,
          `${show(ask.kind)} has been waiting on the operator for ${waited.toFixed(1)} h of journal time ` +
            `(asked ${show(ask.since)}, journal now at ${show(reference)}; threshold ${DEFAULT_ASK_STALE_HOURS} h)` +
            question,
          answerHint,
        ),
      );
      continue;
    }
    findings.push(
      finding('ask-open', at, `${show(ask.kind)} is waiting on the operator (asked ${show(ask.since)})${question}`, answerHint),
    );
  }
  return findings;
}

/**
 * Every spelling an agent has actually used for a lease's expiry.
 *
 * `expiry` leads because it is what agents overwhelmingly write: measured
 * across every journal on a real machine, 33 `expiry` against 3 `expires`, so
 * this finding read 3 of 36 recorded expiries and `lease-expired` was
 * effectively dead. A denylist of spellings is a poor mechanism, but the
 * alternative — refusing the ones agents naturally reach for — trades a quiet
 * miss for a loud one over a field that is advisory anyway.
 */
const EXPIRY_KEYS = Object.freeze(['expiry', 'expires', 'expires_at', 'until']);

function leaseFindings(journalPath, at, events, reference) {
  const findings = [];
  // tail() owns the "who holds what" rule, including the one that a release
  // by a non-holder does not free anything. Doctor asks it; it does not
  // re-fold lease events.
  const { openLeases, mismatchedReleases } = tail(journalPath);
  const { open } = pairSpawns(events);
  const everSpawned = new Set();
  for (const e of events) {
    if (e?.ev === 'spawn' && typeof e.data?.agent === 'string') everSpawned.add(e.data.agent);
  }

  for (const lease of [...openLeases].sort((a, b) => naturalCompare(String(a.resource), String(b.resource)))) {
    const holder = lease.holder;
    const acquired = [...events]
      .reverse()
      .find(
        (e) => e?.ev === 'lease.acquired' && e.data?.resource === lease.resource && e.data?.holder === holder,
      );
    const expiry = acquired ? EXPIRY_KEYS.map((k) => acquired.data?.[k]).find((v) => v != null) : null;
    const releaseHint =
      `node scripts/journal.mjs append ${sq(journalPath)} lease.released ${sq(acquired?.init ?? '<initiative>')} ` +
      `--data ${sq(jsonArg({ resource: String(lease.resource), holder: String(holder ?? '') }))}`;

    if (expiry != null && reference !== null) {
      const overdue = hoursBetween(String(expiry), reference);
      if (overdue !== null && overdue > 0) {
        findings.push(
          finding(
            'lease-expired',
            at,
            `lease on "${show(lease.resource)}" held by "${show(holder)}" expired ${overdue.toFixed(1)} h ago ` +
              `(expiry ${show(expiry)}, journal now at ${show(reference)}) and was never released`,
            releaseHint,
          ),
        );
        continue;
      }
    }
    if (everSpawned.has(holder) && !open.has(holder)) {
      findings.push(
        finding(
          'lease-orphan',
          at,
          `lease on "${show(lease.resource)}" is still held by "${show(holder)}", but that agent already reported ` +
            'and is no longer working — the resource is blocked by nobody',
          releaseHint,
        ),
      );
      continue;
    }
    findings.push(
      finding('lease-open', at, `lease on "${show(lease.resource)}" held by "${show(holder)}"`),
    );
  }

  for (const m of mismatchedReleases) {
    findings.push(
      finding(
        'lease-release-by-non-holder',
        at,
        `"${show(m.by)}" released the lease on "${show(m.resource)}" but the holder is ${
          m.holder === null ? '(nobody)' : `"${show(m.holder)}"` } — the lease stays open`,
        `node scripts/journal.mjs tail ${sq(journalPath)}`,
      ),
    );
  }
  return findings;
}

/**
 * Projection freshness is checkFile()'s answer, byte for byte — doctor does
 * not have its own opinion about what "fresh" means. A missing pair is not
 * drift (nobody has generated them yet); a HALF-missing pair is, because
 * something generated one and failed on the other.
 */
function projectionFindings(journalPath, dir, at, read) {
  const findings = [];
  let files;
  let state;
  try {
    ({ files, state } = renderProjections(read));
  } catch (err) {
    findings.push(
      finding('projection-failed', at, `cannot render projections from this journal (${errText(err)})`),
    );
    return findings;
  }
  // project.mjs refuses to project a file with zero readable events and any
  // damage, and exits 2. Comparing against a projection nobody can generate
  // would report drift and hand out a fix command that cannot run — the one
  // thing a diagnostic must not do.
  if (state.total === 0 && (state.corruptLines + state.malformed > 0 || state.truncatedTail)) {
    findings.push(
      finding(
        'projection-blocked',
        show(dir),
        'projections cannot be generated: the journal has no readable events and is damaged, so project.mjs ' +
          'refuses it (exit 2). Repair the journal first — the errors above say where',
      ),
    );
    return findings;
  }
  const regenerate = `node scripts/project.mjs ${sq(journalPath)} --out-dir ${sq(dir)}`;
  const names = [STATE_FILE, PROGRESS_FILE];
  const present = names.filter((name) => existsSync(join(dir, name)));

  // Two different facts, so two different codes rather than one code whose
  // severity depends on where it was raised: NOTHING generated yet is a
  // repo that has not run the projector (info), while HALF a pair means a
  // run stopped part way (warning). One code, one severity — see
  // SEVERITY_BY_CODE.
  if (present.length === 0) {
    findings.push(
      finding(
        'projection-absent',
        show(dir),
        `no ${STATE_FILE} / ${PROGRESS_FILE} yet — the journal is the source of truth, but nobody can read it`,
        regenerate,
      ),
    );
    return findings;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (!present.includes(name)) {
      findings.push(
        finding(
          'projection-missing',
          show(path),
          `${name} is missing while ${present[0]} exists — a projection run stopped half way`,
          regenerate,
        ),
      );
      continue;
    }
    let result;
    try {
      result = checkFile(path, files[name]);
    } catch (err) {
      findings.push(
        finding('projection-unreadable', show(path), `cannot read the projection (${errText(err)})`),
      );
      continue;
    }
    if (result.ok) continue;
    findings.push(
      finding(
        'projection-drift',
        show(path),
        `out of sync with the journal: ${result.reason}. It is generated — edits here are lost, and a stale ` +
          'projection is what a human (or an agent reading STATE.md) will believe',
        regenerate,
      ),
    );
  }
  // The board pair rides the same projection contract, with its own absent
  // code: every install older than the board feature has neither file, and
  // that must stay info — a check that fails on upgrade day gets deleted.
  const boardNames = [BOARD_FILE, BOARD_JSON_FILE];
  const boardPresent = boardNames.filter((name) => existsSync(join(dir, name)));
  if (boardPresent.length === 0) {
    findings.push(
      finding(
        'board-absent',
        show(dir),
        `no ${BOARD_FILE} / ${BOARD_JSON_FILE} yet — regenerating the projections creates them`,
        regenerate,
      ),
    );
    return findings;
  }
  for (const name of boardNames) {
    const path = join(dir, name);
    if (!boardPresent.includes(name)) {
      findings.push(
        finding('projection-missing', show(path), `${name} is missing while ${boardPresent[0]} exists — a projection run stopped half way`, regenerate),
      );
      continue;
    }
    let result;
    try {
      result = checkFile(path, files[name]);
    } catch (err) {
      findings.push(finding('projection-unreadable', show(path), `cannot read the projection (${errText(err)})`));
      continue;
    }
    if (!result.ok) {
      findings.push(finding('projection-drift', show(path), `${name} does not match the journal (${result.reason})`, regenerate));
    }
  }
  return findings;
}

// ------------------------------------------------------ config / policies

/**
 * `{files, findings}`. A path that exists but is not a directory is
 * REPORTED, never skipped: silently checking nothing and then printing a
 * clean bill of health is the worst thing a diagnostic can do.
 */
function yamlFilesIn(dir, label) {
  if (existsSync(dir) && !isDirectory(dir)) {
    return {
      files: [],
      findings: [
        finding(
          `${label}-not-a-directory`,
          show(dir),
          `${label}/ exists but is not a directory — nothing in it was checked`,
        ),
      ],
    };
  }
  if (!isDirectory(dir)) return { files: [], findings: [] };
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    return {
      files: [],
      findings: [
        finding(`${label}-unreadable`, show(dir), `cannot list the directory (${errText(err)})`),
      ],
    };
  }
  return {
    files: sortedNames(names.filter((n) => n.endsWith('.yaml') || n.endsWith('.yml'))).map((n) => join(dir, n)),
    findings: [],
  };
}

/** Always `{findings, doc}`; `doc` is null unless the file fully validated. */
function checkSchemaFile(kind, path) {
  const findings = [];
  let result;
  try {
    result = validateFile(kind, path);
  } catch (err) {
    return {
      findings: [
        finding(`${kind}-unreadable`, show(path), `cannot read the file (${errText(err)})`),
      ],
      doc: null,
    };
  }
  for (const error of result.errors ?? []) {
    const kernelDowngrade = error.includes('falls under the protected path');
    findings.push(
      finding(
        kernelDowngrade ? 'policy-kernel-downgrade' : `${kind}-invalid`,
        show(path),
        kernelDowngrade
          ? `${error}. classifyPath() protects those paths BEFORE any rule is consulted, so this rule has no ` +
            'effect at all — it is either a mistake or an attempt to walk the boundary back'
          : error,
        `node scripts/schema.mjs validate ${kind} ${sq(path)}`,
      ),
    );
  }
  return { findings, doc: result.ok ? result.doc : null };
}

function policyFindings(path, repoRoot) {
  const { findings, doc } = checkSchemaFile('policy', path);
  // Rule analysis runs only on a policy that validates: findings derived
  // from a document the schema already rejected would be noise stacked on
  // top of the real problem, and every kernel-downgrade rule is reported by
  // validatePolicy already.
  if (doc === null) return findings;

  for (const dead of deadRules(doc, repoRoot)) {
    const parts = [
      `rules[${dead.index}] "${show(dead.path)}" (class ${show(dead.class)}) can never match any path: ` +
        'paths reaching the policy are normalized first (repo-relative, POSIX separators, no "." or ".." ' +
        'segments), and no normalized path has this shape.',
    ];
    if (dead.suggestion !== null) parts.push(`Did you mean "${show(dead.suggestion)}"?`);
    if (dead.aimedAtKernel) {
      parts.push(
        `Note: "${show(dead.suggestion)}" is a protected kernel path (${MANDATORY_KERNEL_PATHS.join(', ')}), ` +
          'so even the corrected rule could only tighten it, never lower it — but as written the rule protects ' +
          'nothing and nothing says so.',
      );
    }
    findings.push(
      finding(
        'policy-rule-dead',
        show(path),
        parts.join(' '),
        dead.suggestion === null
          ? `${sq(path)}: delete the rule, or rewrite its path as a repo-relative glob`
          : `${sq(path)}: replace the rule path with ${sq(dead.suggestion)}`,
      ),
    );
  }

  for (const overruled of overruledRules(doc, repoRoot)) {
    findings.push(
      finding(
        'policy-rule-overruled',
        show(path),
        `rules[${overruled.index}] "${show(overruled.path)}" (class ${show(overruled.class)}) also matches ` +
          `"${show(overruled.example)}", which lies under the protected path "${show(overruled.protectedGlob)}". ` +
          'Protected paths resolve to KERNEL before any rule is consulted, so the rule is ignored there — it ' +
          'covers less than it looks like it covers, and nothing says so at the point of use',
        `${sq(path)}: narrow the rule so it cannot reach ${sq(overruled.protectedGlob)}, or accept that those ` +
          'paths stay KERNEL',
      ),
    );
  }
  return findings;
}

// ------------------------------------------------------------------ scan

/**
 * Run every state check. Pure with respect to time: `now` is either given
 * or taken from each journal's last event, never from the clock.
 */
/**
 * Is `.tyran/` committed? The one Tyran failure that is completely silent.
 *
 * `git worktree add` carries TRACKED files only, and the policy gate is
 * deliberately silent in a repository with no `.tyran/` directory. Put those
 * two together and an uncommitted `.tyran/` means every worktree the conductor
 * creates runs with no autonomy class and no path classes — nothing fails,
 * nothing is refused, the boundary is simply absent in the one place the most
 * agents run. Measured on a real install: four worktrees, four ungated
 * implementers, and the operator had no way to see it.
 *
 * Returns null when git cannot answer. The distinction matters exactly as it
 * does in `detectPackageManager`: "this is not a git repository" is not
 * evidence that a file is untracked, and reporting it as such would fire on
 * every temp directory and every fresh `git init`.
 */
export function untrackedTyranDir(repoRoot, run, tyranDirName = '.tyran') {
  if (run(['rev-parse', '--is-inside-work-tree']).trim() !== 'true') return null;
  // `ls-files` over the directory: any tracked file under it means the tree
  // travels with a worktree, which is the property being checked. Asking about
  // config.yaml alone would pass a repo that committed only the policy.
  // The pathspec is parameterized the same way trackedLeaseFiles' is, so a
  // --dir naming anything but `.tyran` cannot make the two checks contradict
  // each other about what git tracks.
  return run(['ls-files', '--', tyranDirName]).trim() === '';
}

/**
 * Which initiative ledgers git has never seen, and which carry local changes.
 *
 * `untrackedTyranDir` above is all-or-nothing: one tracked file anywhere under
 * `.tyran/` and the whole directory reports healthy. That is the wrong
 * granularity for what iron rule 1 actually asks for. Measured on a real
 * install whose `.tyran/` had been tracked for weeks: one initiative directory
 * of six files — its plan, and the gate event recording two production
 * database migrations — had NEVER been committed, and a second was 33 events
 * behind its committed copy. The directory-level check passed on both.
 * `journal.mjs append` writes the working tree and nothing else, so an
 * initiative nobody committed is one `git clean -fd` from having never
 * happened.
 *
 * Three states, because the same loss needs three different sentences:
 *
 *   - `untracked` — git has never seen this ledger. Wrong at any moment.
 *   - `ignored` — a rule in some `.gitignore` covers it. The same loss, but
 *     `git add` on a path git is ignoring is a SILENT no-op, so the advice the
 *     untracked case gives would look like it worked and change nothing.
 *   - `uncommitted` — tracked, with local changes. What an initiative in
 *     flight looks like ten seconds after any append, so it is worth saying
 *     only at a merge boundary, and never worth failing a check over.
 *
 * Two git invocations for the whole tree rather than two per initiative: the
 * listings are read once and classified by path prefix in JS. A repo can hold
 * dozens of initiatives and this runs behind the SessionStart deadline. The
 * prefix is built in git's own output convention (repo-relative, forward
 * slashes) for the same reason `trackedLeaseFiles` filters in JS instead of
 * trusting pathspec globbing.
 *
 * No second `rev-parse`: the caller reaches this only when `untrackedTyranDir`
 * returned a boolean rather than null, which is already the answer to whether
 * git can answer.
 */
export function initiativeGitStates(run, tyranDirName, names) {
  const lines = (out) => out.split('\n').filter((line) => line !== '');
  const tracked = lines(run(['ls-files', '--', tyranDirName]));
  // `--ignored` costs nothing on a call being made anyway and is the whole
  // difference between "you forgot" and "a rule you wrote is hiding it".
  // Porcelain v1 is `XY<space>path`; git collapses a wholly untracked or
  // ignored DIRECTORY into a single entry, so a recorded path can be shorter
  // than the prefix as well as longer — hence the check in both directions.
  const status = lines(run(['status', '--porcelain', '--ignored', '--', tyranDirName]));
  const paths = (keep) => status.filter((l) => l.startsWith('!! ') === keep).map((l) => l.slice(3));
  const ignored = paths(true);
  const dirty = paths(false);
  const covers = (entries, prefix) =>
    entries.some((path) => path.startsWith(prefix) || prefix.startsWith(path));
  const states = new Map();
  for (const name of names) {
    const prefix = `${tyranDirName}/state/${name}/`;
    if (tracked.some((path) => path.startsWith(prefix))) {
      states.set(name, covers(dirty, prefix) ? 'uncommitted' : 'committed');
    } else {
      states.set(name, covers(ignored, prefix) ? 'ignored' : 'untracked');
    }
  }
  return states;
}

/** The finding for one non-`committed` ledger state, or null for `committed`. */
function ledgerFinding(state, path, name, gitPath) {
  if (state === 'untracked') {
    return finding(
      'initiative-untracked',
      show(path),
      'git has never seen this ledger — `journal.mjs append` writes the working tree and nothing ' +
        'else, so an initiative nobody committed is one `git clean -fd` from having never happened, ' +
        'and a worktree carries tracked files only, so the agents working in one never read it',
      `git add ${sq(gitPath)} && git commit -m ${sq(`chore(tyran): record the ${name} ledger`)}`,
    );
  }
  if (state === 'ignored') {
    return finding(
      'initiative-ignored',
      show(path),
      'a .gitignore rule covers this ledger, so nothing under it can be committed — the journal is ' +
        'the copy that is supposed to outlive the session, and this one exists on one machine only',
      `git check-ignore -v ${sq(`${gitPath}/journal.jsonl`)}   # the rule doing it; ` +
        '`git add` alone is a silent no-op on an ignored path',
    );
  }
  return finding(
    'initiative-uncommitted',
    show(path),
    'the ledger has uncommitted changes — ordinary mid-initiative, a gap at a merge boundary: ' +
      'rule 1 asks for the ledger to travel with the work, not to be committed once at the end',
    `git add ${sq(gitPath)} && git commit -m ${sq(`chore(tyran): ${name} ledger`)}`,
  );
}

/**
 * Lease files committed to git. A lease records who holds a worktree or a
 * heavy slot RIGHT NOW; committing one makes every parallel merge conflict on
 * state that was stale the moment it was written, and a checkout resurrects
 * it as a phantom holder. Filtered in JS rather than via a wildcard pathspec
 * — git's pathspec globbing is exactly the kind of subtlety this tool exists
 * to not depend on. Returns [] when git cannot answer: "not a git repository"
 * is not evidence that a lease is tracked.
 */
export function trackedLeaseFiles(run, tyranDirName = '.tyran') {
  const listing = run(['ls-files', '--', tyranDirName]);
  if (listing === '') return [];
  const lease = /\/(?:state|initiatives)\/[^/]+\/locks\//;
  return listing.split('\n').filter((line) => line !== '' && lease.test(line));
}

/**
 * The mistakes ledger at the repository root: is it readable, has a lesson
 * earned promotion, and can a promoted rule actually land?
 *
 * ABSENCE PRODUCES NO FINDING AT ALL. Deleting the file is the documented
 * opt-out, and a tool that nags about a file you deliberately removed is a
 * tool you disable. The `checked` line still records what was looked at, so
 * "nothing was said about it" and "it is not there" stay distinguishable.
 *
 * `parseMistakes` is imported rather than re-implemented: the entry shape is
 * owned by `mistakes.mjs`, the same discipline doctor already follows for
 * `validateKnowledge` and `pairSpawns` (ADR-18).
 */

/**
 * Absence, split into the two situations that look identical on disk.
 *
 * Deleting the file is the documented opt-out and it stays silent — a tool
 * that nags about a file you deliberately removed is a tool you disable, and
 * that argument has not changed. But an install created before this ledger
 * existed never made that choice: there is nothing to opt out of, nobody was
 * ever offered the file, and silence there is not respect for a decision, it
 * is a feature the operator has never heard of.
 *
 * Git is the only witness that can tell the two apart. A file with history is
 * one somebody had and removed; a file with no history in a repo git can read
 * never existed. When git cannot answer at all — no repository, no git on the
 * PATH — this says NOTHING, because a guess here would nag exactly the
 * operator who already opted out.
 *
 * `info`, never a warning: nothing is broken, and the check exists to make an
 * offer rather than to report a defect.
 */
function absentMistakes(repoRoot, path, run) {
  const checked = `${MISTAKES_FILE}: absent`;
  if (run === null) return { findings: [], checked };
  // The same probe `untrackedTyranDir` uses, for the same reason: `run`
  // returns '' for "git said nothing" and for "git is not here", and those
  // need opposite conclusions.
  if (run(['rev-parse', '--is-inside-work-tree']).trim() !== 'true') {
    return { findings: [], checked: `${checked} (no git here to say whether it ever existed)` };
  }
  const history = run(['log', '--max-count=1', '--format=%H', '--', MISTAKES_FILE]).trim();
  if (history !== '') {
    return { findings: [], checked: `${checked} — deleted deliberately, which IS the opt-out` };
  }
  return {
    findings: [
      finding(
        'mistakes-file-missing',
        show(path),
        `no ${MISTAKES_FILE}, and git has never seen one — this repository predates the incident ledger ` +
          'rather than having opted out of it. Nothing is broken; the ledger is what turns a mistake that ' +
          'happened three times into a rule that stops the fourth',
        `node scripts/scan-repo.mjs --dir ${sq(repoRoot)} --ensure-policy   # seeds it from the shipped template; deleting it again is the opt-out, and this will not put it back on its own`,
      ),
    ],
    checked: `${checked} — never existed`,
  };
}
/**
 * How many git worktrees this repository is carrying, and whether that has
 * become a problem nobody is looking at.
 *
 * Tyran's parallel model is a worktree per agent, and NOTHING removes one.
 * There is no removal path in any skill, agent or script; the journal has no
 * event that can even represent a worktree being destroyed; and doctor has
 * never enumerated them. Measured on one real machine: 26 in one repository,
 * 33 GB under another's `.worktrees/`, the oldest active for 68 days.
 *
 * REPORTS, never removes — and that restraint is the finding's whole design,
 * not doctor's general rule applied by rote. Most of those worktrees turned
 * out to hold work that never CONCLUDED rather than work that finished, so a
 * tool deleting "merged" ones would clear almost nothing while being able, on
 * a bad day, to delete something someone wanted. The operator gets the count,
 * the ages, and a command they can read before running.
 *
 * The threshold is deliberately generous: a handful of worktrees is the system
 * working as designed. This fires when they have stopped being cleaned up at
 * all, which is what the measured installs look like.
 */
export const WORKTREE_CEILING = 8;

export function worktreeFindings(repoRoot, run = null) {
  const checked = 'git worktrees';
  if (run === null) return { findings: [], checked: `${checked}: not checked (no git runner)` };
  if (run(['rev-parse', '--is-inside-work-tree']).trim() !== 'true') {
    return { findings: [], checked: `${checked}: no git here` };
  }
  const listing = run(['worktree', 'list', '--porcelain']);
  if (listing.trim() === '') return { findings: [], checked: `${checked}: none reported` };
  // One record per blank-line-separated block; the main checkout is one of
  // them and is never a leak, so it is counted and then subtracted.
  const blocks = listing.split(/\n\s*\n/).filter((b) => b.trim() !== '');
  const extra = Math.max(0, blocks.length - 1);
  const prunable = blocks.filter((b) => /^prunable /m.test(b)).length;
  if (extra <= WORKTREE_CEILING) {
    return { findings: [], checked: `${checked}: ${extra} beside the main checkout` };
  }
  return {
    findings: [
      finding(
        'worktree-accumulating',
        show(repoRoot),
        `${extra} git worktrees beside the main checkout` +
          (prunable > 0 ? `, ${prunable} of them already prunable` : '') +
          ' — Tyran creates one per parallel agent and removes none, so they accumulate silently. ' +
          'They cost disk, and a stale one has already cost a validation baseline: a lint run swept ' +
          'leftover worktrees and reported 32,243 phantom errors. Nothing here is deleted for you; ' +
          'read the list before removing anything, because an unmerged worktree may hold work that ' +
          'was never finished rather than work that was',
        `git -C ${sq(repoRoot)} worktree list   # then: git worktree remove <path>, after checking git -C <path> status`,
      ),
    ],
    checked: `${checked}: ${extra} beside the main checkout`,
  };
}

export function mistakesFindings(repoRoot, run = null) {
  const path = join(repoRoot, MISTAKES_FILE);
  if (!existsSync(path)) return absentMistakes(repoRoot, path, run);

  let parsed;
  try {
    parsed = parseMistakes(readFileSync(path, 'utf8'));
  } catch (err) {
    return {
      findings: [
        finding(
          'mistakes-unreadable',
          show(path),
          `the mistakes ledger could not be read or parsed (${errText(err)}) — nothing in it was counted`,
          `ls -la ${sq(path)}   # this file is prose, not a projection: open it and repair it by hand`,
        ),
      ],
      checked: `${MISTAKES_FILE}: UNREADABLE`,
    };
  }

  const findings = [];
  const rows = countSignatures(parsed.entries);
  for (const row of rows) {
    if (row.open < KNOWLEDGE_THRESHOLD) continue;
    findings.push(
      finding(
        'mistakes-repeat-unpromoted',
        show(path),
        `\`${show(row.signature)}\` has ${row.open} open entries (${show(row.dates.join(', '))}) — ` +
          'a failure that recurred this often is evidence a rule is missing, not a coincidence',
        `node scripts/mistakes.mjs repeats --file ${sq(path)} --threshold ${KNOWLEDGE_THRESHOLD}   # then /tyran:retro promotes them into .tyran/knowledge/`,
      ),
    );
  }

  // A law entry says a rule was earned; the fence is where such a rule lives.
  // Info in both directions: a repo whose law predates the fence is fine, and
  // a repo that has never promoted anything must never see this at all.
  const lawEntries = parsed.entries.filter((entry) => entry.statusKind === 'law').length;
  if (lawEntries > 0) {
    const claudePath = join(repoRoot, CLAUDE_MD_FILE);
    let state = { start: null, problem: null };
    let claudeExists = existsSync(claudePath);
    if (claudeExists) {
      try {
        state = fenceState(readFileSync(claudePath, 'utf8'));
      } catch {
        claudeExists = false;
      }
    }
    if (!claudeExists || state.problem !== null || state.start === null) {
      // The two branches fail differently, so they say different things: a
      // missing fence is written by the next promotion (writeRuleToFence
      // creates it), a malformed one refuses every promotion until it is
      // repaired by hand.
      const why = state.problem !== null
        ? `the tyran:rules fence is malformed (${show(state.problem)}) — ` +
          'the next promotion cannot land where an earned rule is supposed to live'
        : `${CLAUDE_MD_FILE} carries no tyran:rules fence — ` +
          'the earned rule is not in force in any session';
      findings.push(
        finding(
          'claude-md-fence-missing',
          show(claudePath),
          `${lawEntries} entr${lawEntries === 1 ? 'y' : 'ies'} in ${MISTAKES_FILE} ` +
            `claim${lawEntries === 1 ? 's' : ''} status \`law\`, and ${why}`,
          `node scripts/mistakes.mjs repeats --file ${sq(path)}   # see https://jjanczur.github.io/tyran/self-improvement/ for the fence`,
        ),
      );
    }
  }

  return {
    findings,
    checked: `${MISTAKES_FILE}: ${parsed.entries.length} entries, ${rows.length} signatures`,
  };
}

/** The repo-global overnight runtime files that legally live at state/ level. */
/** The cross-initiative board artefacts board.mjs writes at state/ level. */
export const CROSS_BOARD_FILES = Object.freeze(['BOARD.md', 'board.json', 'board.html']);

export const OVERNIGHT_RUNTIME_FILES = Object.freeze([
  'paused-until.json',
  'resume.json',
  'resume.log',
  'usage.json',
  // The spend cache. Machine-local like the rest of this list and for the same
  // reason: it is derived from transcripts under the operator's home
  // directory, so another clone reads different bytes from the same journal.
  'cost.json',
]);

/**
 * The ask queue's own two files at state/ level: the sheet the operator edits
 * and the session record the SessionStart probe writes. Repo-global by
 * nature — the sheet spans every initiative — so they cannot live inside one.
 */
export const ASK_QUEUE_FILES = Object.freeze(['ANSWERS.md', 'conductor.json']);

/**
 * Overnight-mode consistency: the pause marker, the resume watcher, and the
 * telemetry a configured gate depends on. Deterministic: staleness questions
 * are answered only against an explicit `now` (the SessionStart probe passes
 * one); without it a marker is reported as present, never as stale — doctor
 * never reads the wall clock.
 */
export function overnightFindings(dir, { now = null, configDoc = null, usageFallback = () => readPlatformUsage() } = {}) {
  const findings = [];
  const referenceMs = now !== null ? Date.parse(now) : null;
  const markerPath = join(dir, 'state', 'paused-until.json');
  const resumePath = join(dir, 'state', 'resume.json');
  const sidecarPath = join(dir, 'state', 'usage.json');

  const marker = readJsonIfSmall(markerPath);
  if (marker !== null) {
    const resumeAtMs = Date.parse(typeof marker.resume_at === 'string' ? marker.resume_at : '');
    const stale = referenceMs !== null && Number.isFinite(resumeAtMs) && resumeAtMs < referenceMs;
    if (stale) {
      findings.push(
        finding(
          'limit-pause-stale',
          show(markerPath),
          `the pause marker's resume time (${show(marker.resume_at)}) has PASSED and the marker is still ` +
            'here — the watcher died with the machine, or was never scheduled. Autonomous work stays ' +
            'wound down until this is resolved; the usage gate also self-clears it on the next tool call',
          `node scripts/overnight.mjs status --dir ${sq(dirname(resolve(dir)))}   # then schedule again, or let the gate self-clear`,
        ),
      );
    } else {
      findings.push(
        finding(
          'limit-pause-active',
          show(markerPath),
          `paused on the ${show(marker.window)} usage window until ${show(marker.resume_at)}` +
            (marker.long_wait === true ? ' — a LONG pause; the scheduler holds unless told otherwise' : ''),
        ),
      );
    }
  }

  // Outside the marker guard: the watcher unlinks the marker BEFORE spawning
  // the resume and never restores it, so a failed resume leaves resume.json
  // with no marker beside it.
  const resume = readJsonIfSmall(resumePath);
  if (resume !== null) {
    const waitingDead =
      resume.state === 'waiting' && !(Number.isInteger(resume.pid) && resume.pid > 0 && processAlive(resume.pid));
    if (waitingDead || resume.state === 'failed') {
      findings.push(
        finding(
          'limit-resume-watcher-dead',
          show(resumePath),
          waitingDead
            ? `resume.json says a watcher is waiting (pid ${show(String(resume.pid))}) but no such process is alive — a reboot kills detached watchers`
            : `the last scheduled resume FAILED (${show(resume.reason ?? 'see resume.log')})`,
          // `schedule` needs the pause marker, and a failed resume has already
          // consumed it — the fix must be executable in the state that fires.
          marker !== null
            ? `node scripts/overnight.mjs schedule --dir ${sq(dirname(resolve(dir)))}`
            : `resume the session by hand (claude --resume; .tyran/state/resume.log names the attempt), then node scripts/overnight.mjs cancel --dir ${sq(dirname(resolve(dir)))} to reset the watcher state`,
        ),
      );
    }
  }

  // A configured control that cannot see is the silent-absence class.
  //
  // The sidecar is no longer the only channel: the gate falls back to the
  // platform's own usage cache in `~/.claude.json`, which is why this finding
  // now asks whether ANY telemetry is reachable rather than whether the
  // statusline was installed. It used to fire on every install that had not
  // pasted a statusLine command — which, since the statusline was the only
  // writer and its payload is not always populated, was most of them, while
  // the real fault was usually that the platform was sending nothing.
  const limits = knowsLimits(configDoc);
  if (limits !== null && limits.mode !== 'off') {
    const sidecar = readJsonIfSmall(sidecarPath);
    const writtenMs = sidecar !== null ? Date.parse(typeof sidecar.written_at === 'string' ? sidecar.written_at : '') : NaN;
    const ancient = referenceMs !== null && Number.isFinite(writtenMs) && referenceMs - writtenMs > 24 * 3600 * 1000;
    const platform = usageFallback();
    if ((sidecar === null || ancient) && platform === null) {
      findings.push(
        finding(
          'limit-telemetry-missing',
          show(sidecarPath),
          `limits.mode is "${show(limits.mode)}" and NO usage telemetry is reachable — the sidecar is ` +
            `${sidecar === null ? 'absent' : 'over a day old'} and the platform's own cache in ~/.claude.json ` +
            'carries no window that is still running. The gate fails open without one, so the configured ' +
            'pause protects nothing. Usually this means the account is signed out, or the platform has not ' +
            'reported usage yet; see https://jjanczur.github.io/tyran/overnight/',
          `node scripts/statusline.mjs --sidecar-only   # optional: a statusline is fresher, but no longer required`,
        ),
      );
    }
  }
  return findings;
}

function readJsonIfSmall(path) {
  try {
    if (!existsSync(path) || statSync(path).size > 64 * 1024) return null;
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The limits block when the config carries a usable one, else null. */
function knowsLimits(configDoc) {
  if (configDoc === null || typeof configDoc !== 'object') return null;
  const limits = configDoc.limits;
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) return null;
  return typeof limits.mode === 'string' ? limits : null;
}

export function runStateChecks({
  dir = '.tyran',
  now = null,
  staleHours = DEFAULT_STALE_HOURS,
  run = null,
  usageFallback = () => readPlatformUsage(),
} = {}) {
  const root = resolve(dir);
  if (!existsSync(root)) {
    return summarize(dir, [finding('no-state-dir', show(dir), 'no Tyran state directory here — nothing to check')], [
      `${show(dir)}: absent`,
    ]);
  }
  if (!isDirectory(root)) throw new IOError(`not a directory: ${root}`);

  const repoRoot = dirname(root);
  const findings = [];
  const checked = [];

  const configPath = join(dir, 'config.yaml');
  let configDoc = null;
  if (existsSync(configPath)) {
    const configResult = checkSchemaFile('config', configPath);
    findings.push(...configResult.findings);
    configDoc = configResult.doc;
    checked.push('config.yaml: checked');
  } else {
    findings.push(
      finding(
        'config-missing',
        show(configPath),
        'no config.yaml — Tyran falls back to built-in defaults for this repo',
        `node scripts/schema.mjs validate config ${sq(configPath)}   # after /tyran:setup writes it`,
      ),
    );
    checked.push('config.yaml: absent');
  }

  const gitRun = run ?? gitRunner(repoRoot);
  const untracked = untrackedTyranDir(repoRoot, gitRun, basename(root));
  if (untracked === true) {
    findings.push(
      finding(
        'tyran-dir-untracked',
        show(dir),
        'nothing under .tyran/ is tracked by git — `git worktree add` carries tracked files only, and ' +
          'the policy gate is silent in a repo with no .tyran/, so every worktree runs with no autonomy ' +
          'class and no path classes. Nothing fails; the boundary is absent where the most agents run',
        `git add ${sq(dir)} && git commit -m 'chore: adopt Tyran'`,
      ),
    );
  }
  checked.push(`.tyran/ tracked by git: ${untracked === null ? 'unknown (not a git work tree)' : !untracked}`);

  const knowledge = yamlFilesIn(join(dir, 'knowledge'), 'knowledge');
  findings.push(...knowledge.findings);
  for (const file of knowledge.files) {
    const schemaResult = checkSchemaFile('knowledge', file);
    findings.push(...schemaResult.findings);
    // Advisory, on files that already validate: an oversized entry is legal,
    // it just crowds every budgeted brief it appears in.
    for (const warning of knowledgeWarnings(schemaResult.doc)) {
      findings.push(
        finding(
          'knowledge-entry-oversized',
          show(file),
          warning,
          `node scripts/knowledge.mjs brief '**' --dir ${sq(join(dir, 'knowledge'))}   # shows what a budgeted brief keeps`,
        ),
      );
    }
  }
  checked.push(`knowledge/: ${knowledge.files.length} file(s)`);
  // The AGGREGATE, which the per-entry warning above cannot show.
  //
  // `knowledge-entry-oversized` fires once per fat entry and each one reads as
  // a small, local untidiness. Measured on a real install it fired five times
  // while the true state was that `brief` returned ONE of thirty-one entries:
  // 104,178 codepoints of hard-won detail, reaching nobody. Five tidy-up notes
  // and "your knowledge store is 97% unread" are not the same message, and
  // only the second one gets acted on.
  findings.push(...knowledgeReachability(join(dir, 'knowledge')));

  const policies = yamlFilesIn(join(dir, 'policies'), 'policies');
  findings.push(...policies.findings);
  for (const file of policies.files) findings.push(...policyFindings(file, repoRoot));
  if (policies.files.length === 0 && policies.findings.length === 0) {
    findings.push(
      finding(
        'policy-missing',
        show(join(dir, 'policies')),
        'no autonomy policy, in a repo that HAS a .tyran/ directory — the policy gate fails closed on ' +
          'exactly this state, so every write in every session is refused until the file exists. It is not ' +
          'a missing nicety; the repository is unusable',
        `node scripts/scan-repo.mjs --dir ${sq(repoRoot)} --ensure-policy   # installs the shipped template; ` +
          'never overwrites a policy you wrote',
      ),
    );
  }
  checked.push(`policies/: ${policies.files.length} file(s)`);

  const stateDir = join(dir, 'state');
  const initiatives = [];
  if (existsSync(stateDir) && !isDirectory(stateDir)) {
    findings.push(finding('state-not-a-directory', show(stateDir), 'state/ exists but is not a directory'));
  } else if (isDirectory(stateDir)) {
    let names = [];
    try {
      names = readdirSync(stateDir);
    } catch (err) {
      findings.push(
        finding('state-unreadable', show(stateDir), `cannot list state/ (${errText(err)})`),
      );
    }
    // Only when `.tyran/` as a whole IS tracked. Under a wholly untracked
    // directory every initiative would repeat the finding above, each time
    // with narrower advice than the one that already covers it, and a check
    // that says the same thing N+1 times is a check people learn to skip.
    const gitStates =
      untracked === false
        ? initiativeGitStates(
            gitRun,
            basename(root),
            sortedNames(names).filter((name) => isDirectory(join(stateDir, name))),
          )
        : null;
    for (const name of sortedNames(names)) {
      const path = join(stateDir, name);
      if (!isDirectory(path)) {
        // Named exemption, not a silent skip: the overnight runtime files
        // live at the state/ level by design (repo-global, machine-local,
        // gitignored) and are checked by overnightFindings instead.
        if (OVERNIGHT_RUNTIME_FILES.includes(name)) continue;
        if (CROSS_BOARD_FILES.includes(name)) continue; // generated by board.mjs at this level, by design
        if (ASK_QUEUE_FILES.includes(name)) continue; // the sheet and the session record, by design
        findings.push(
          finding(
            'state-stray-file',
            show(path),
            'stray entry in state/ — every child of state/ is an initiative directory',
          ),
        );
        continue;
      }
      const result = checkInitiative(stateDir, name, { now, staleHours });
      findings.push(...result.findings);
      const ledger = gitStates?.get(name) ?? 'committed';
      if (ledger !== 'committed') {
        findings.push(ledgerFinding(ledger, path, name, `${basename(root)}/state/${name}`));
      }
      initiatives.push(`${show(name)} (${result.events} event(s))`);
    }
  }
  checked.push(
    initiatives.length === 0 ? 'state/: no initiatives' : `state/: ${initiatives.join(', ')}`,
  );

  const legacyDir = join(dir, 'initiatives');
  if (isDirectory(legacyDir)) {
    findings.push(
      finding(
        'state-legacy-initiatives-dir',
        show(legacyDir),
        'legacy layout — initiative files (PLAN.md, NOTES.md, RETRO.md, locks/) live under ' +
          'state/<initiative>/ since 0.1.9. Mechanical consumers read only state/, so anything ' +
          'kept here is invisible to the projections, the retrospective and the session summary',
        // Was "relocate the contents by hand, one initiative directory at a
        // time" — which is advice, not a remedy, on the one class of install
        // that by definition nobody has touched since 0.1.8. The script says
        // what it WOULD move until asked twice, never overwrites, and never
        // deletes anything it did not empty.
        `node scripts/migrate.mjs --dir ${sq(dir)}   # what it would move; add --apply to move it`,
      ),
    );
  }
  checked.push(`initiatives/ (legacy): ${isDirectory(legacyDir) ? 'PRESENT' : 'absent'}`);

  const mistakes = mistakesFindings(repoRoot, gitRun);
  findings.push(...mistakes.findings);
  checked.push(mistakes.checked);

  const worktrees = worktreeFindings(repoRoot, gitRun);
  findings.push(...worktrees.findings);
  checked.push(worktrees.checked);

  findings.push(...overnightFindings(dir, { now, configDoc, usageFallback }));
  checked.push('overnight: checked');

  const trackedLeases = trackedLeaseFiles(gitRun, basename(root));
  if (trackedLeases.length > 0) {
    findings.push(
      finding(
        'lease-file-tracked',
        show(trackedLeases[0]) + (trackedLeases.length > 1 ? ` (+${trackedLeases.length - 1} more)` : ''),
        `${trackedLeases.length} lease file(s) committed to git — a lease records who holds a resource ` +
          'RIGHT NOW, so a committed one conflicts on every parallel merge and resurrects as a phantom ' +
          'holder on every checkout',
        `git ls-files -- ${sq(basename(root))}   # list them; keep 'state/*/locks/' in .tyran/.gitignore and un-track the files by hand — see https://jjanczur.github.io/tyran/configuration/`,
      ),
    );
  }
  checked.push(`lease files tracked by git: ${trackedLeases.length}`);

  return summarize(dir, findings, checked);
}

function summarize(dir, findings, checked) {
  const sorted = sortFindings(findings);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of sorted) counts[f.severity]++;
  return {
    ok: counts.error === 0 && counts.warning === 0,
    dir: show(dir),
    checked,
    counts,
    findings: sorted,
  };
}

// --------------------------------------------------------------- renderers

/**
 * The hook-liveness check, in doctor's own result shape.
 *
 * `hooks-check.mjs` owns the finding CODES and their severities; doctor does
 * not merge them into `SEVERITY_BY_CODE`. Two tables, no merge, and a test
 * asserts the two never define the same code — which is stronger than merging,
 * because a merge would let a collision resolve silently in favour of whoever
 * wrote the key last.
 */
export function runHookChecks({ root = DEFAULT_PLUGIN_ROOT, env = process.env } = {}) {
  const result = checkHooks({ root, env });
  return {
    ok: result.ok,
    dir: result.root,
    platform: result.platform,
    checked: result.checked,
    counts: result.counts,
    findings: result.findings,
  };
}

export function renderText(result, mode = 'state') {
  const lines = [`tyran doctor · ${mode}`, `dir: ${result.dir}`];
  if (result.platform) lines.push(`platform modelled: ${result.platform} (re-measure after an upgrade)`);
  for (const line of result.checked) lines.push(`  ${line}`);
  lines.push('');

  if (result.findings.length === 0) {
    lines.push('no findings — state is consistent');
  } else {
    let current = null;
    for (const f of result.findings) {
      if (f.severity !== current) {
        if (current !== null) lines.push('');
        lines.push(`${f.severity.toUpperCase()} (${result.counts[f.severity]})`);
        current = f.severity;
      }
      lines.push(`  [${f.code}] ${f.where}`);
      lines.push(`    ${f.message}`);
      if (f.fix) {
        const fixLines = f.fix.split('\n');
        lines.push(`    fix: ${fixLines[0]}`);
        for (const extra of fixLines.slice(1)) lines.push(`         ${extra}`);
      }
    }
  }
  lines.push('');
  lines.push(
    `${result.counts.error} error(s) · ${result.counts.warning} warning(s) · ${result.counts.info} info · ` +
      (result.ok ? 'healthy' : 'action needed'),
  );
  return lines.join('\n') + '\n';
}

export function renderJson(result) {
  return JSON.stringify(result, null, 2) + '\n';
}

// --------------------------------------------------------------------- CLI

const BOOLEAN_FLAGS = ['state', 'hooks', 'json'];
const VALUE_FLAGS = ['dir', 'now', 'stale-hours', 'plugin-root'];

export function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}" — doctor takes flags only`);
    const name = arg.slice(2);
    // A repeated flag silently overriding itself is how a check ends up
    // reading the wrong directory — refuse instead of guessing.
    if (name in flags) throw new Error(`flag --${name} was given twice`);
    if (BOOLEAN_FLAGS.includes(name)) flags[name] = true;
    else if (VALUE_FLAGS.includes(name)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`flag --${name} requires a value`);
      flags[name] = value;
    } else throw new Error(`unknown flag --${name}`);
  }
  // A mode is required rather than assumed: doctor grows --env and --config
  // in a later epic, and a bare `doctor.mjs` that silently means one of them
  // today would silently mean something else then.
  if (flags.state !== true && flags.hooks !== true) throw new UsageError();

  let now = null;
  if (flags.now !== undefined) {
    if (Number.isNaN(Date.parse(flags.now))) throw new Error(`--now must be an ISO-8601 timestamp (got "${flags.now}")`);
    now = flags.now;
  }
  let staleHours = DEFAULT_STALE_HOURS;
  if (flags['stale-hours'] !== undefined) {
    staleHours = Number(flags['stale-hours']);
    if (!Number.isFinite(staleHours) || staleHours < 0) {
      throw new Error(`--stale-hours must be a non-negative number (got "${flags['stale-hours']}")`);
    }
  }
  return {
    dir: flags.dir ?? '.tyran',
    json: flags.json === true,
    now,
    staleHours,
    dirGiven: flags.dir !== undefined,
    state: flags.state === true,
    hooks: flags.hooks === true,
    pluginRoot: flags['plugin-root'] ?? DEFAULT_PLUGIN_ROOT,
  };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { dir, json, now, staleHours, dirGiven } = args;
    let allOk = true;
    // Both modes may be asked for at once. They are rendered as two reports
    // rather than one merged list: the counts of "is the record consistent"
    // and "can the gates fire" answer different questions, and adding them
    // together would let a healthy state dilute a dead gate.
    if (args.hooks) {
      const result = runHookChecks({ root: args.pluginRoot });
      process.stdout.write(json ? renderJson(result) : renderText(result, 'hooks'));
      allOk = allOk && result.ok;
    }
    if (args.state) {
      // An explicitly named directory that does not exist is a typo, and a
      // clean bill of health for a path nobody checked is the one output a
      // diagnostic tool must never produce. The DEFAULT `.tyran` being absent
      // is just a repo that has not run /tyran:setup yet.
      if (dirGiven && !existsSync(dir)) throw new IOError(`state directory not found: ${resolve(dir)}`);
      const result = runStateChecks({ dir, now, staleHours });
      process.stdout.write(json ? renderJson(result) : renderText(result));
      allOk = allOk && result.ok;
    }
    if (!allOk) process.exit(1);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(
        'usage: doctor.mjs --state [--dir <.tyran>] [--json] [--now <iso>] [--stale-hours <n>]\n' +
          '       doctor.mjs --hooks [--plugin-root <dir>] [--json]\n' +
          '\n' +
          '       A mode is REQUIRED: `--state` asks whether the record of the work is\n' +
          '       consistent, `--hooks` whether the gates can fire at all. They answer\n' +
          '       different questions, and a bare invocation would have to pick one\n' +
          '       silently. This text said `--state is the only mode today` long after\n' +
          '       `--hooks` shipped, which sent readers looking for a flag they had.',
      );
      process.exit(2);
    }
    console.error(`doctor: ${err.message}`);
    if (!(err instanceof IOError) && !(err instanceof Error && err.constructor === Error)) {
      console.error(err.stack);
    }
    process.exit(2);
  }
}

/**
 * Absolute, symlink-resolved path; falls back to the merely absolute form
 * when the path cannot be resolved (deleted file, permission denied), which
 * keeps the comparison below defined instead of throwing.
 */
function canonicalPath(path) {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * True when this module is the program's entry point.
 *
 * BOTH sides must be canonicalized. `import.meta.url` already names the real
 * file — Node resolves module specifiers through symlinks — while
 * `process.argv[1]` is whatever the caller typed. Comparing them raw turned
 * every invocation through a symlinked path into a SILENT no-op under exit
 * 0: `main()` never ran, nothing was printed, and nothing said so. For a
 * tool whose entire promise is "it never reports clean for something it
 * skipped", that is the worst possible failure. `/tmp` and `/var` are
 * symlinks on macOS and plugin installs routinely reach `scripts/` through
 * one, so it is not theoretical. Shared with journal.mjs, project.mjs and
 * scan-control-chars.mjs.
 */
function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  return canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(moduleUrl));
}

if (isMainModule(import.meta.url)) main();
