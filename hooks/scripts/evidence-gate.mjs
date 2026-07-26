#!/usr/bin/env node
/**
 * evidence-gate — the evidence contract stops being a request.
 *
 * In v1 the contract was a sentence in prose: "a report MUST contain raw
 * command output". An agent that had not read it, or had read it and moved
 * on, handed back "tests are green, everything works" and that went through.
 * This gate makes that specific ending mechanical: a `SubagentStop` with no
 * raw output in the report is REFUSED, and the refusal names what to add.
 *
 * ## The honest boundary, stated first because it is the important part
 *
 * **This gate blocks SILENCE, not FORGERY.** An agent that invents the text
 * "232 passed / 0 failed" walks straight through it. What the gate changes is
 * the price of a hollow report: it can no longer be produced by omission, it
 * has to be fabricated deliberately. That is a real difference and it is the
 * whole of the difference. Any wider claim in a README would be the same
 * defect this repository exists to remove, only printed on the box.
 *
 * ## What it costs on real work — measured, not assumed
 *
 * Calibrated against 128 real subagent final messages recovered from this
 * machine's Claude Code transcripts (the same string the platform hands this
 * hook as `last_assistant_message`), of which 55 came from the two enforced
 * roles:
 *
 *   tyran-implementer   32/33 carry evidence
 *   tyran-reviewer      21/22 carry evidence
 *   ------------------  ---------------------
 *   enforced total      53/55 (96%)
 *
 * Both misses were inspected by hand and neither is a report: one is a
 * fragment of a system prompt that leaked into a text block, the other is the
 * platform's "you've hit your weekly limit" notice. On the 53 messages that
 * are actually reports the criterion is 53/53.
 *
 * The exempt roles are the other half of the argument, and they are why role
 * scope is not decoration: tyran-scout carries evidence in 2/15 messages,
 * Explore in 1/20, general-purpose in 0/16. Enforcing on them would bounce
 * correct work eight times out of ten, and a gate that bounces correct work
 * is switched off within a week and then protects nothing.
 *
 * ## Why the criterion is a raw pattern and not a judgement
 *
 * Every signal below requires a NUMBER next to a keyword, because that is the
 * shape of machine output and it is not the shape of a summary. "All tests
 * pass" does not match. "12 passed" does. The line between them is the entire
 * point, and it has to be drawable by a regex or it is not enforceable.
 */
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { append } from '../../scripts/journal.mjs';
import { escapeInvisible } from '../../scripts/invisible.mjs';
import { PASS, field, main, runGate } from './hook-io.mjs';

/**
 * This gate's own budget, well under the `timeout` its hooks.json entry
 * declares (ADR-22 point 2); a test reads both numbers and refuses to let
 * them cross.
 *
 * It is deliberately larger than the session-start probe's 4 s, for one
 * measured reason: the journal's cross-process mutex waits up to 5 s for a
 * contended lock, and it waits SYNCHRONOUSLY (`Atomics.wait`). Nothing on
 * this thread runs during that wait, so the deadline timer cannot fire — the
 * third row of the deadline table in docs/hooks.md. The budget is therefore
 * sized to contain the worst case that the lock itself bounds, rather than to
 * be woken by a timer that cannot run.
 */
export const DEADLINE_MS = 8000;

/**
 * The largest journal this gate will touch, checked with `statSync` BEFORE
 * anything reads it.
 *
 * `journal.append` reads the whole file to clamp its timestamp, and an
 * unbounded synchronous read inside a gate is the one failure the runtime
 * cannot rescue: the platform kills the process and never reads the refusal
 * it had already written (ADR-22 correction 2). So the size check is not
 * caution, it is the only available mechanism.
 */
export const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;

/** Refuse to hunt through an absurd `.tyran/state`; that is not a repo we know. */
export const MAX_INITIATIVES = 64;

/** Code points of foreign text this gate is willing to copy into the journal. */
export const MAX_RECORDED_POINTS = 200;

/**
 * How much reason the `none-required` hatch has to carry. Short enough that a
 * real sentence always clears it, long enough that "x" does not.
 */
export const MIN_HATCH_REASON = 10;

// ---------------------------------------------------------------- criterion

/**
 * The evidence signals, as raw patterns.
 *
 * Each is anchored on a DIGIT adjacent to a keyword. That is the whole
 * criterion and it is deliberately wide rather than narrow: the failure mode
 * of a strict gate is a user who switches it off, and a gate that is off
 * protects nothing at all.
 */
export const SIGNALS = Object.freeze([
  // `EXIT=0`, `exit code 0`, `exit status 1`, `exit: 137`
  Object.freeze({ name: 'exit-code', re: /\bexit(?:[ _-]?(?:code|status))?\s*[:=]?\s*\d{1,3}\b/i }),
  // `12 passed`, `0 failed`, `3 skipped` — vitest, jest, pytest, playwright
  Object.freeze({ name: 'test-count', re: /\b\d+\s+(?:passed|failed|passing|failing|skipped|pending)\b/i }),
  // `# pass 343`, `# fail 0`, `# tests 343` — node --test's TAP summary
  Object.freeze({ name: 'tap-count', re: /^[\s#]*(?:pass|fail|tests|suites)\s+\d+\s*$/im }),
  // `ok 7 - name`, `not ok 3 - name` — TAP body
  Object.freeze({ name: 'tap-line', re: /^\s*(?:not )?ok\s+\d+\b/im }),
  // `Tests: 28`, `Suites: 4`, `assertions = 12`
  Object.freeze({ name: 'labelled-count', re: /\b(?:tests?|suites?|assertions?|checks?)\s*[:=]\s*\d+/i }),
  // `6 / 6 passed`, `18/20 passing`
  Object.freeze({ name: 'ratio', re: /\b\d+\s*\/\s*\d+\s+(?:passed|passing|ok|green)\b/i }),
  // an explicit block, but never the hatch — that is counted separately
  Object.freeze({ name: 'evidence-block', re: /^[\s>*-]*EVIDENCE\s*:(?!\s*none-required\b)\s*\S/im }),
]);

/** The declared escape hatch, and the reason it is obliged to carry. */
const HATCH_RE = /^[\s>*-]*EVIDENCE\s*:\s*none-required\b[ \t]*(.*)$/im;

/** Which signals `text` carries. Empty array means "no evidence". */
export function findEvidence(text) {
  const signals = [];
  for (const s of SIGNALS) if (s.re.test(text)) signals.push(s.name);
  return signals;
}

/**
 * The hatch, if the report declares it.
 *
 * `present` and `reason` are separate answers on purpose: a hatch with no
 * reason is a different situation from no hatch at all, and it gets a
 * different refusal, because "you forgot the why" and "you forgot the
 * evidence" are different mistakes and a gate that conflates them teaches the
 * wrong lesson.
 */
export function findHatch(text) {
  const m = HATCH_RE.exec(text);
  if (m === null) return { present: false, reason: null };
  const reason = m[1].trim();
  return { present: true, reason: reason.length >= MIN_HATCH_REASON ? reason : null };
}

// -------------------------------------------------------------- role scope

/**
 * Who the contract binds, keyed on `agent_type` — a field written by the
 * PLATFORM, never by the model.
 *
 * That distinction is the reason this table exists at all. A criterion
 * derived from the report's CONTENT can be defeated by the report's content:
 * if "I am only a scout" exempted an agent, every agent would write it. This
 * initiative measured that lesson three times before it wrote it down.
 *
 * Both spellings are listed. `tyran:implementer` is what a plugin agent is
 * called (namespace from `plugin.json`'s `name`, measured), `tyran-
 * implementer` is what the v1 project-level agents are called, and a repo
 * mid-migration has both. Exact strings, never a substring test: an
 * unanchored match on `implementer` would also bind an agent called
 * `evil-tyran-implementer-nope`.
 */
export const ROLE_SCOPE = Object.freeze(
  Object.assign(Object.create(null), {
    'tyran:implementer': 'enforce',
    'tyran:reviewer': 'enforce',
    'tyran-implementer': 'enforce',
    'tyran-reviewer': 'enforce',
    'tyran:scout': 'exempt',
    'tyran:retro': 'exempt',
    'tyran-scout': 'exempt',
    'tyran-retro': 'exempt',
  }),
);

/**
 * `enforce`, `exempt`, or `out-of-scope`.
 *
 * The third answer is not a weaker second one, and the difference is
 * load-bearing for ADR-19. An `exempt` agent is one of ours that the contract
 * deliberately releases — that is an exclusion, so it is counted in the
 * journal. An `out-of-scope` agent (`Explore`, `general-purpose`, another
 * plugin's agent, or the empty string the platform is documented to be able
 * to send) was never bound by this contract in the first place; recording an
 * exemption for it would bury the real exemptions in noise.
 *
 * The empty string matters more than it looks. Measured: when `agent_type` is
 * empty the platform SKIPS matcher filtering entirely and runs every hook
 * registered for the event. A gate that trusted its matcher would then be
 * enforcing the implementer contract on every agent in the system. This
 * function is why the matcher in hooks.json is deliberately a catch-all: the
 * decision lives here, where an empty type is a case rather than an accident.
 */
export function classifyAgent(agentType) {
  if (typeof agentType !== 'string' || agentType === '') return 'out-of-scope';
  return Object.hasOwn(ROLE_SCOPE, agentType) ? ROLE_SCOPE[agentType] : 'out-of-scope';
}

// ------------------------------------------------------------------ verdict

/**
 * Why a report was refused. Codes, not sentences, so that the SENTENCE is
 * chosen from a closed set at the edge — see `REFUSALS`.
 */
export const DENY = Object.freeze({
  NO_EVIDENCE: 'no-evidence',
  HATCH_WITHOUT_REASON: 'hatch-without-reason',
  HATCH_NOT_RECORDABLE: 'hatch-not-recordable',
  REPORT_NOT_A_STRING: 'report-not-a-string',
});

/**
 * The whole decision, as a pure function of the hook's input.
 *
 * Pure on purpose: the journal write and the refusal text are edges, and a
 * verdict that can be tested without a filesystem is a verdict that gets
 * tested for the cases that matter (an interrupted agent, an empty agent
 * type, a second bounce) rather than only for the easy one.
 */
export function assessReport(input) {
  // An interrupted agent has no report to judge.
  //
  // Measured: on the abort path `last_assistant_message` is ABSENT, not empty
  // (`permission_mode` is missing too). A gate that reads "absent" as "no
  // evidence" refuses an agent that cannot possibly comply, and the platform
  // hands it another turn — which it also cannot use. That is the loop the
  // fuse exists to survive, entered on purpose by our own code.
  const report = field(input, 'last_assistant_message');
  if (report === undefined || report === null) {
    return { outcome: 'exempt-interrupted', signals: [], reason: null };
  }
  if (typeof report !== 'string') {
    return { outcome: 'deny', signals: [], reason: null, code: DENY.REPORT_NOT_A_STRING };
  }

  // The declared hatch wins over incidental evidence, deliberately.
  //
  // If an agent says "there was nothing to run", that is the thing to count,
  // even when the prose happens to contain a number that looks like output.
  // The alternative silently reclassifies a declared exemption as a pass and
  // the count of "how often did someone use the hatch" stops being true.
  const hatch = findHatch(report);
  const signals = findEvidence(report);
  if (hatch.present && hatch.reason !== null) {
    return { outcome: 'exempt-hatch', signals, reason: hatch.reason };
  }
  if (signals.length > 0) return { outcome: 'pass', signals, reason: null };
  if (hatch.present) {
    return { outcome: 'deny', signals, reason: null, code: DENY.HATCH_WITHOUT_REASON };
  }
  return { outcome: 'deny', signals, reason: null, code: DENY.NO_EVIDENCE };
}

export function judge(input) {
  // 1. Scope first, so that an agent this contract never bound produces no
  //    verdict to record. Out-of-scope is not a quieter exemption: it is the
  //    absence of an obligation, and recording one `gate` event per Explore
  //    call would bury the exemptions that do mean something.
  const agentType = field(input, 'agent_type');
  const scope = classifyAgent(agentType);
  if (scope === 'out-of-scope') return { outcome: 'out-of-scope', role: null, signals: [], reason: null };

  const assessed =
    scope === 'exempt' ? { outcome: 'exempt-role', signals: [], reason: null } : assessReport(input);

  // 2. The anti-loop fuse. It overrides the verdict, and only the verdict.
  //
  // Measured: `stop_hook_active` is true from the SECOND SubagentStop for the
  // same agent onward, i.e. it is exactly "you already bounced this one".
  // This is what caps the gate's cost at one extra turn per agent. A gate that
  // can bounce forever is worse than no gate: the user kills the run, and then
  // removes the gate. It also covers cases we do not control — an agent
  // stopped by ANOTHER hook, or one that hit a rate limit and whose next
  // report will be identical to this one.
  //
  // The report is still ASSESSED, and the answer travels as `wouldBe`. The
  // first live run of this gate is why: the agent was refused, came back with
  // a correct `EVIDENCE: none-required`, and the journal recorded only "fuse"
  // — so a legitimate hatch use vanished from the count the hatch exists to
  // feed. Releasing an agent and forgetting what it did are two different
  // things, and only the first one is the fuse's job.
  if (field(input, 'stop_hook_active') === true) {
    return { ...assessed, outcome: 'fuse', role: agentType, wouldBe: assessed.outcome };
  }

  return { ...assessed, role: agentType };
}

// ------------------------------------------------------------------ journal

/**
 * Where this repo's initiative journal is, or why there is none.
 *
 * Every filesystem answer here is bounded before it is taken: the number of
 * initiative directories, and the size of the journal itself. See
 * `MAX_JOURNAL_BYTES` for why that is a mechanism rather than tidiness.
 */
export function locateJournal(repoRoot, { maxBytes = MAX_JOURNAL_BYTES } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot === '' || !isAbsolute(repoRoot)) {
    return { file: null, why: 'no-repo-root' };
  }
  const root = join(repoRoot, '.tyran', 'state');
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { file: null, why: 'no-state-dir' };
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (dirs.length === 0) return { file: null, why: 'no-initiative' };
  if (dirs.length > MAX_INITIATIVES) return { file: null, why: 'too-many-initiatives' };

  let best = null;
  let oversized = 0;
  for (const name of dirs) {
    const file = join(root, name, 'journal.jsonl');
    let mtimeMs;
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      if (st.size > maxBytes) {
        oversized++;
        continue;
      }
      mtimeMs = st.mtimeMs;
    } catch {
      // No journal yet: a fresh initiative directory is still a valid target,
      // ranked by the directory's own mtime. `append` creates the file.
      try {
        mtimeMs = statSync(join(root, name)).mtimeMs;
      } catch {
        continue;
      }
    }
    if (best === null || mtimeMs > best.mtimeMs) best = { file, init: name, mtimeMs };
  }
  if (best === null) {
    return { file: null, why: oversized > 0 ? 'journal-too-large' : 'no-initiative' };
  }
  // More than one candidate means this gate GUESSED which initiative the
  // agent belonged to. The guess is written into the event rather than
  // hidden, so a reader of the journal can see that the attribution is
  // inferred (ADR-19: an exclusion — or an assumption — is never silent).
  return { file: best.file, init: best.init, inferred: dirs.length > 1 ? dirs.length : 0 };
}

/**
 * Foreign text on its way into our own state file.
 *
 * Bounded and escaped AT THE SOURCE rather than at each reader. The journal's
 * CLI escapes on print and the projection generator escapes on render, so
 * removing this would leave every test green — which is exactly the shape
 * ADR-20 correction 1 calls "survived through redundancy of defence", i.e. a
 * guarantee resting on every future consumer remembering. The reason string
 * comes from an agent's report, which routinely quotes foreign repositories.
 *
 * EVERY sink of foreign text in this gate goes through here. Enumerated
 * rather than remembered, because the last time a hole in this repo was
 * patched, the identical hole two lines away survived:
 *
 *   data.reason      <- the hatch reason, written by the model
 *   data.agent_type  <- written by the platform, still not ours
 *   data.agent_id    <- ditto
 *   init             <- a DIRECTORY NAME off the filesystem, and the one that
 *                       was missed on the first pass: a directory called
 *                       `demo<U+202E>` would have put a raw bidi override into
 *                       every event this gate writes
 *
 * The remaining fields are this file's own constants (`kind`, `result`,
 * `would_be`, `code`, `signals`, `actor`) or an integer, and constants are not
 * a sink.
 */
export function forJournal(text) {
  return escapeInvisible([...String(text)].slice(0, MAX_RECORDED_POINTS).join(''));
}

/**
 * Record the verdict as a `gate` event.
 *
 * `gate` and not `report`, and this is a DELIBERATE correction to the story's
 * wording rather than an oversight. `report` is half of the spawn-report
 * pairing (ADR-18) and its only correlator is the agent NAME the conductor
 * chose when it spawned the agent. A hook knows `agent_id` (a platform UUID)
 * and `agent_type`; it does not know that name and cannot invent it. Writing
 * `report` here would therefore either produce an orphan report on every
 * subagent stop — a permanent warning in `journal validate` and in doctor —
 * or, on an accidental name collision, close a spawn the conductor was still
 * tracking. `gate` carries `{kind, result}`, which is exactly this event, and
 * it has no pairing semantics to corrupt.
 *
 * Returns true when the event was written. Callers act on that answer; see
 * `apply` for which exemptions require it and which do not.
 */
export function recordGate(journal, event, { write = append } = {}) {
  if (journal.file === null) return false;
  try {
    write(journal.file, event);
    return true;
  } catch {
    // An unwritable or corrupt journal is a state failure, not a verdict.
    // What it means for the verdict is decided in `apply`, once, where the
    // asymmetry can be read and argued.
    return false;
  }
}

// ------------------------------------------------------------------ refusal

/**
 * The refusal texts, in full, as a closed set.
 *
 * NOTHING from the report reaches them. Not a quoted line, not a length, not
 * the agent's own name for itself. A gate's denial is injected straight into
 * a model's context, and this initiative has already measured what happens
 * when a gate echoes its input: a rule NAME in a gate's output was enough to
 * plant an instruction. The runtime sanitizes on top of this; that is a
 * second layer, not this one's excuse.
 *
 * A second property, and a test pins it: none of these texts SATISFIES the
 * criterion. The examples are written with placeholders (`EXIT=<code>`,
 * `<N> passed`) which carry no digits, so an agent that pastes the refusal
 * back verbatim is refused again rather than let through by its own citation.
 */
export const REFUSALS = Object.freeze(
  Object.assign(Object.create(null), {
    [DENY.NO_EVIDENCE]:
      'REFUSED by the tyran evidence gate: this report carries no raw command output.\n' +
      '\n' +
      'The evidence contract is mechanical, not stylistic. "tests are green" is\n' +
      'not evidence; the unedited output of a command you actually ran is. Add at\n' +
      'least one line of it. Any ONE of these forms is enough:\n' +
      '\n' +
      '  exit code      EXIT=<code>        or  "exit code <code>", "exit status <code>"\n' +
      '  test counter   <N> passed         or  "<N> failed", "# pass <N>", "ok <N>"\n' +
      '  labelled count Tests: <N>         or  "Suites: <N>", "checks = <N>"\n' +
      '\n' +
      'If there was genuinely nothing to measure - a scouting pass, an analysis,\n' +
      'an answer to a question - say so on a line of its own, with a reason:\n' +
      '\n' +
      '  EVIDENCE: none-required <why there was nothing to run>\n' +
      '\n' +
      'That line is not a formality. Every use of it is recorded in the\n' +
      'initiative journal, so exemptions are counted rather than assumed.\n' +
      '\n' +
      'What this gate does NOT do: it cannot tell real output from invented\n' +
      'output. It blocks silence, not forgery.',
    [DENY.HATCH_WITHOUT_REASON]:
      'REFUSED by the tyran evidence gate: the "none-required" exemption was\n' +
      'claimed without a reason.\n' +
      '\n' +
      'The exemption is legitimate and it is recorded. What is recorded has to\n' +
      'say something, or the record answers no question later. Write it as:\n' +
      '\n' +
      '  EVIDENCE: none-required <why there was nothing to run>\n' +
      '\n' +
      'A phrase is enough - "read-only reconnaissance, no code changed" - but it\n' +
      'has to be a phrase, not a placeholder.\n' +
      '\n' +
      'If something WAS run, paste its raw output instead and drop the exemption.',
    [DENY.HATCH_NOT_RECORDABLE]:
      'REFUSED by the tyran evidence gate: the "none-required" exemption could\n' +
      'not be recorded, so it cannot be granted.\n' +
      '\n' +
      'This gate does not keep the exemption in its head - it writes it to the\n' +
      'initiative journal, and that write failed or had nowhere to go (no\n' +
      '.tyran/state/<initiative>/journal.jsonl under this repository, or the\n' +
      'journal is unwritable or larger than this gate will read).\n' +
      '\n' +
      'An exemption nobody can count is a silent exclusion, which is the exact\n' +
      'failure this project refuses to ship. Two ways forward:\n' +
      '\n' +
      '  - paste the raw output of something you ran, and drop the exemption; or\n' +
      '  - run inside a Tyran initiative, whose journal can hold the record.\n' +
      '\n' +
      'Exemptions the PLATFORM imposes - a scout role, an interrupted agent - are\n' +
      'never blocked this way. Only the one an agent claims for itself is.',
    [DENY.REPORT_NOT_A_STRING]:
      'REFUSED by the tyran evidence gate: the platform supplied a report field\n' +
      'that is not text, so there is nothing this gate can read.\n' +
      '\n' +
      'This is a platform or configuration fault rather than a fault in the\n' +
      'work. It is a refusal and not a pass because a check that cannot run must\n' +
      'never read as a check that succeeded. Re-running the agent is the usual\n' +
      'fix; if it recurs, the hook input shape has changed and hooks/scripts/\n' +
      'evidence-gate.mjs needs to be looked at.',
  }),
);

// -------------------------------------------------------------------- edges

/**
 * The repository this stop happened in.
 *
 * Deliberately its own small function rather than an import of the
 * session-start probe's `resolveRepoRoot`: pulling that in would drag the
 * projection generator (a thousand lines) into the startup of a hook that
 * runs on every subagent stop, to reuse eight lines of path validation. The
 * "one answer" rule (ADR-21) is about a RULE that two callers could answer
 * differently — the invisibility set, the pairing rule. "Is this string an
 * absolute path to a directory" is not that; it has one answer in the
 * standard library.
 */
export function resolveRepoRoot(input, env = process.env, cwd = process.cwd()) {
  for (const candidate of [field(input, 'cwd'), env.CLAUDE_PROJECT_DIR, cwd]) {
    if (typeof candidate !== 'string' || candidate === '' || !isAbsolute(candidate)) continue;
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * The verdict, its record, and the asymmetry between them.
 *
 * ## Does a broken journal block a correct report?
 *
 * The story asks for the argument, not the answer, so here it is. The two
 * failures are not symmetrical:
 *
 *  - refusing a report that HAS evidence because the bookkeeping failed costs
 *    the agent a turn for something it cannot fix and did not cause. The
 *    evidence is already in the transcript; the journal line is an audit
 *    convenience. Bouncing on it teaches users that the gate fires for
 *    reasons unrelated to their work, which is how a gate gets disabled.
 *  - granting an exemption that could not be recorded costs the SYSTEM its
 *    only trace of it. "How many times did someone opt out of the evidence
 *    contract in this initiative" is a question the journal is supposed to
 *    answer, and an unrecorded exemption makes the answer quietly wrong.
 *
 * So the record gates the exemption an AGENT CHOOSES for itself, and nothing
 * else. Role exemptions and interrupted agents are imposed by the platform,
 * cannot be claimed by writing a sentence, and pass whether or not the
 * journal accepted the note. The worst case for the one gated exemption is a
 * single extra turn, because the fuse releases the second stop.
 */
export function apply(input, { locate = locateJournal, record = recordGate } = {}) {
  const verdict = judge(input);
  const repoRoot = resolveRepoRoot(input);
  const journal = repoRoot === null ? { file: null, why: 'no-repo-root' } : locate(repoRoot);

  // No timestamp is supplied: `append` stamps it inside the lock and CLAMPS it
  // to the journal's last event. Hooks matched to one event run in PARALLEL
  // (ADR-22), so two gates stamping their own `new Date()` outside the lock
  // could write them out of order and turn a warning into a hard validation
  // error in a file nobody is allowed to rewrite.
  const written =
    verdict.outcome === 'out-of-scope'
      ? false
      : record(journal, {
          ev: 'gate',
          init: forJournal(journal.init ?? 'unknown'),
          actor: 'evidence-gate',
          data: {
            kind: 'evidence',
            result: verdict.outcome,
            agent_type: forJournal(field(input, 'agent_type') ?? ''),
            agent_id: forJournal(field(input, 'agent_id') ?? ''),
            signals: verdict.signals,
            ...(verdict.reason === null ? {} : { reason: forJournal(verdict.reason) }),
            ...(verdict.code === undefined ? {} : { code: verdict.code }),
            ...(verdict.wouldBe === undefined ? {} : { would_be: verdict.wouldBe }),
            ...(journal.inferred ? { initiative_inferred_from: journal.inferred } : {}),
          },
        });

  if (verdict.outcome === 'exempt-hatch' && !written) {
    return { decision: 'deny', reason: REFUSALS[DENY.HATCH_NOT_RECORDABLE] };
  }
  if (verdict.outcome === 'deny') return { decision: 'deny', reason: REFUSALS[verdict.code] };
  return PASS;
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
      event: 'SubagentStop',
      deadlineMs: DEADLINE_MS,
      handler: ({ input }) => apply(input),
    }),
  );
}
