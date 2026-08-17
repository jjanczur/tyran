#!/usr/bin/env node
/**
 * journal — the append-only source of truth for a Tyran initiative.
 *
 * One line = one JSON event. Design rules (see docs/architecture.md):
 *  - append-only: a crash mid-write can at worst truncate the FINAL line,
 *    which readers detect and discard;
 *  - closed event set: unknown event types are rejected loudly;
 *  - IDs come from the journal, never from anyone's memory;
 *  - zero dependencies, plain Node >= 22.
 *
 * CLI:
 *   node journal.mjs append      <file> <ev> <init> [--actor A] [--data JSON]
 *   node journal.mjs query       <file> [--ev E] [--init I] [--ticket T] [--limit N]
 *   node journal.mjs validate    <file>
 *   node journal.mjs next-id     <file> <prefix>   # e.g. prefix D -> D-7
 *   node journal.mjs tail        <file>            # last checkpoint + open items
 *   node journal.mjs open-spawns <file>            # agents with no report or review yet
 *   node journal.mjs close-spawn <file> <init> <agent> --reason R [--verdict V]
 *   node journal.mjs ask         <file> <init> --question Q [--default D] [--ticket T]
 * Exit: 0 ok · 1 validation/finding error · 2 usage/IO error
 */
import {
  appendFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeInvisible, invisibleProblem, jsonEscapeInvisible, whitespaceProblem } from './invisible.mjs';

/** Closed set of event types. Extending it is a reviewed core change. */
export const EVENT_TYPES = Object.freeze([
  'init.created',
  'plan.accepted',
  'ticket.created',
  'ticket.status',
  'spawn',
  'report',
  'progress',
  'gate',
  'review',
  'merge',
  'decision',
  'finding',
  'lease.acquired',
  'lease.released',
  'checkpoint',
  'retro.entry',
  'error',
]);

/**
 * Event types whose `data.id` the CLI issues when the caller omits it, and the
 * prefix to issue it under. `ticket.created` is deliberately absent: a ticket
 * id comes from the plan, which numbers its own stories.
 */
export const ID_ISSUED_FOR = Object.freeze(Object.assign(Object.create(null), { decision: 'D', finding: 'F' }));

/** Per-type required keys inside `data` (data may always carry extra keys). */
export const DATA_REQUIRED = Object.freeze({
  'ticket.created': ['id'],
  'ticket.status': ['ticket', 'column'],
  spawn: ['agent', 'role'],
  report: ['agent', 'verdict'],
  progress: ['agent', 'state'],
  gate: ['kind', 'result'],
  review: ['ticket', 'verdict', 'by'],
  merge: ['ticket', 'sha'],
  decision: ['id', 'text'],
  finding: ['area', 'claim'],
  'lease.acquired': ['resource', 'holder'],
  'lease.released': ['resource', 'holder'],
  checkpoint: ['phase', 'next_steps'],
  'retro.entry': ['kind', 'target'],
  error: ['class'],
});

/**
 * Closed VALUE sets inside `data`, for the same reason the event set is
 * closed: an unknown value must be a loud rejection at append time, not a
 * surprise in a projection. Hard errors are safe here because both types are
 * new — no legacy journal can retroactively fail `validate`.
 *
 * `ticket.status.column` is deliberately NARROW: only the lanes no lifecycle
 * event can ever derive. Anything broader would be a second source of truth
 * against the derived board (`done` is what `merge` means; an override saying
 * so would let the two disagree).
 */
export const DATA_ENUMS = Object.freeze({
  progress: Object.freeze({ state: Object.freeze(['started', 'working', 'blocked', 'unblocked']) }),
  'ticket.status': Object.freeze({ column: Object.freeze(['blocked', 'waiting-operator', 'parked']) }),
});

/**
 * Free-text keys with a size ceiling, in codepoints. REJECTED at append,
 * never truncated — the journal does not silently shorten anything. Long
 * material belongs in NOTES.md with a reference here. `validateJournal`
 * reports historical oversizes as warnings only (no retroactive errors).
 */
export const CAPPED_DATA_KEYS = Object.freeze({
  detail: 2000,
  claim: 2000,
  proof: 2000,
  // The ask fields. They reach BOARD.md, board.html and the answer sheet, so
  // an uncapped one is a document-sized cell in three artefacts at once.
  question: 2000,
  recommendation: 2000,
  default: 2000,
  answer: 2000,
});

/**
 * A journal-derived value on its way into a HUMAN-READABLE MESSAGE.
 *
 * Messages built here travel further than this file: `validateJournal`'s
 * errors and warnings are rendered by `doctor.mjs` into a report an operator
 * reads. A 400-tree fuzz of doctor measured 137 leaks in its text output and
 * 118 in its JSON, and every one of them traced back to a message built RIGHT
 * HERE with a raw `ev` or agent name in it — not to doctor's own sanitizer.
 *
 * The module that BUILDS a message owns making it safe. Leaving it to each
 * consumer is caller discipline, which is the mechanism class this project
 * exists because it distrusts: one consumer forgets, and the forgetting is
 * invisible.
 */
const q = (value) => escapeInvisible(String(value));

/**
 * A `data` payload of the shape the envelope requires. Arrays are excluded on
 * purpose: they are objects to `typeof`, they accept string properties, and
 * anything that ADDS a key to one would turn a rejected event into a written
 * one of a shape the caller never wrote.
 */
const isDataObject = (data) => typeof data === 'object' && data !== null && !Array.isArray(data);

/** Validate a single event object. Returns [] when valid, else error strings. */
export function validateEvent(event) {
  const errors = [];
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return ['event must be a JSON object'];
  }
  if (typeof event.ts !== 'string' || Number.isNaN(Date.parse(event.ts))) {
    errors.push('ts must be an ISO-8601 timestamp string');
  }
  if (!EVENT_TYPES.includes(event.ev)) {
    // The set is CLOSED and was not printed, so the only way to recover was to
    // grep the plugin's own source — which is what a field run actually did.
    // A closed set that will not name its members is a riddle, not a contract.
    errors.push(`ev "${q(event.ev)}" is not in the closed event set — valid: ${EVENT_TYPES.join(', ')}`);
  }
  if (typeof event.init !== 'string' || event.init.length === 0) {
    errors.push('init (initiative slug) must be a non-empty string');
  }
  if (typeof event.actor !== 'string' || event.actor.length === 0) {
    errors.push('actor must be a non-empty string');
  }
  if (!isDataObject(event.data)) {
    errors.push('data must be a JSON object (may be empty)');
  } else if (DATA_REQUIRED[event.ev]) {
    for (const key of DATA_REQUIRED[event.ev]) {
      // Name the WHOLE contract, not just the key that happened to be checked
      // first. Discovering it by rejection cost a field run four round-trips,
      // one failed invocation each, because the agent recovering from the error
      // has no other source of truth — the table is not printed anywhere else.
      if (!(key in event.data)) {
        errors.push(
          `data.${q(key)} is required for ev "${q(event.ev)}" ` +
            `(this event requires: ${DATA_REQUIRED[event.ev].join(', ')})`,
        );
      } else if (key === 'id' && typeof event.data.id !== 'string') {
        errors.push(`data.id must be a string for ev "${q(event.ev)}" (got ${typeof event.data.id})`);
      }
    }
    const enums = DATA_ENUMS[event.ev];
    if (enums) {
      for (const [key, allowed] of Object.entries(enums)) {
        if (key in event.data && !allowed.includes(event.data[key])) {
          // Name the whole set, same as the closed event set above: the agent
          // recovering from this error has no other source of truth.
          errors.push(
            `data.${q(key)} "${q(event.data[key])}" is not valid for ev "${q(event.ev)}" — valid: ${allowed.join(', ')}`,
          );
        }
      }
    }
  }
  return errors;
}

/**
 * The oversize problem of one capped data key, or null. Codepoints, not
 * UTF-16 units, same as every other length rule in this repo.
 */
export function cappedKeyProblem(data) {
  if (data === null || typeof data !== 'object') return null;
  for (const [key, cap] of Object.entries(CAPPED_DATA_KEYS)) {
    const value = data[key];
    if (typeof value === 'string' && Array.from(value).length > cap) {
      return `data.${key} is ${Array.from(value).length} codepoints (cap ${cap}) — put the full text in NOTES.md and reference it here`;
    }
  }
  return null;
}

// -------------------------------------------------- spawn ↔ report pairing

/**
 * Agent names are identifiers, not prose: they address an agent at platform
 * level and they are the ONLY correlator between `spawn` and `report`
 * (ADR-18). A name that merely LOOKS like another one would silently defeat
 * the uniqueness guard, so non-canonical names are refused on write.
 * Case is deliberately significant — folding it here would make the guard
 * disagree with the exact-name addressing every consumer uses.
 *
 * The invisibility test is NOT spelled out here any more. It used to read
 * `\p{Cc}\p{Cf}`, which is a third spelling of a rule the CI scanner and the
 * projection sanitizer also carried — measured over the whole of Unicode, the
 * three disagreed on 456 codepoints. `\p{Cf}` in particular does not cover
 * Hangul fillers (U+3164, U+FFA0) or most of the TAG block, so a name could be
 * refused by the repo gate and accepted here. One question, one function
 * (ADR-19 correction 1 point 4, ADR-21).
 */
export function agentNameProblem(name) {
  if (typeof name !== 'string') return `must be a string (got ${typeof name})`;
  if (name.length === 0) return 'must not be empty';
  // Invisibility is checked BEFORE normalization on purpose. A few invisible
  // codepoints are also not NFC-stable, and reporting "must be Unicode
  // NFC-normalized" for a name carrying a zero-width joiner is a true sentence
  // that sends the reader to fix the wrong thing.
  for (const ch of name) {
    if (invisibleProblem(ch.codePointAt(0)) !== null) {
      return 'must not contain control or invisible formatting characters';
    }
  }
  if (name !== name.normalize('NFC')) return 'must be Unicode NFC-normalized';
  if (name !== name.trim()) return 'must not have leading/trailing whitespace';
  // TAB and LF are visible text, so they are not an answer to "is this
  // invisible" — but they wreck a name, which is printed in tables, shell
  // hints and projections. Separate, disjoint rule; see scripts/invisible.mjs.
  for (const ch of name) {
    if (whitespaceProblem(ch.codePointAt(0)) !== null) {
      return 'must not contain a tab or a newline';
    }
  }
  return null;
}

/**
 * Pair `spawn` events with `report` events by agent name, in file order:
 * a report closes the OLDEST still-open spawn of that name (FIFO), and a
 * `review` closes its reviewer the same way, correlated by `data.by` — but
 * only a spawn whose `role` is `reviewer`: `by` is a free string, and a
 * collision with a still-working implementer's name must not mark that
 * implementer reported with a verdict it never earned. This is
 * the one and only pairing rule — `append` enforces that it can never be
 * ambiguous (ADR-18: at most one open spawn per name), so consumers such as
 * the projection generator implement a guarantee, not a heuristic.
 *
 * Operates on the events a reader can actually see. Corrupt or truncated
 * lines are invisible here for exactly the same reason they are invisible to
 * every consumer, so writer and readers can never disagree about who is open.
 *
 * Returns, additively (ADR-21): `pairs` names WHICH report closed WHICH spawn,
 * and `unusable` carries the EVENTS whose agent name is not a usable
 * correlator. Both exist so that the projection generator can render this
 * function's answer instead of computing a second one of its own — which is
 * what it used to do, with a different rule, giving the operator two
 * contradictory pictures of who was still working.
 */
export function pairSpawns(events) {
  const open = new Map(); // agent -> spawn events, oldest first
  const orphanReports = [];
  const badNames = new Map(); // raw name (as JSON) -> problem
  const unusable = []; // the EVENTS behind badNames, so a consumer can show them
  const pairs = []; // {spawn, report}, in report order
  /**
   * Names that were EVER open more than once at the same time. Deliberately
   * not "names open more than once right now": by the time a report has closed
   * one of two simultaneous spawns, the final map holds a single entry and the
   * ambiguity is invisible — yet that report already had to choose between two
   * spawns, and the choice it made is the thing a reader must be told about.
   */
  const ambiguous = new Map(); // agent -> the largest number of spawns open at once
  for (const e of events) {
    if (e?.ev !== 'spawn' && e?.ev !== 'report' && e?.ev !== 'review') continue;
    // A reviewer never files a `report` about itself — its verdict IS its
    // completion. Measured in the field: reviewers spawned per iron rule 3
    // stayed "still working" in the session-start probe for days, because
    // only reports closed spawns. A review's correlator is `data.by`.
    const isReview = e.ev === 'review';
    const agent = isReview ? e.data?.by : e.data?.agent;
    const problem = agentNameProblem(agent);
    if (problem) {
      // A review is a verdict record first; an uncorrelatable `by` is not an
      // agent-lifecycle defect, so it stays out of the unusable set.
      if (isReview) continue;
      badNames.set(JSON.stringify(agent ?? null), problem);
      unusable.push({ event: e, problem });
      continue; // unusable as a correlator; validate() reports it
    }
    if (e.ev === 'spawn') {
      if (!open.has(agent)) open.set(agent, []);
      open.get(agent).push(e);
      const depth = open.get(agent).length;
      if (depth > 1 && depth > (ambiguous.get(agent) ?? 0)) ambiguous.set(agent, depth);
    } else {
      const queue = open.get(agent);
      const closable = queue?.length && (!isReview || queue[0].data?.role === 'reviewer');
      if (closable) {
        const spawn = queue.shift();
        pairs.push({ spawn, report: e });
        if (queue.length === 0) open.delete(agent);
      } else if (isReview) {
        // A review by a never-spawned (or already-closed) actor is ordinary —
        // a verdict does not require a lifecycle to close.
      } else if (e.data?.closed_by === 'close-spawn') {
        // Journals written before reviews closed spawns carry a close-spawn
        // report right after the review that now closes the same spawn:
        // redundant, not orphaned — flagging it would fail history retroactively.
      } else orphanReports.push(e);
    }
  }
  return { open, orphanReports, badNames, pairs, unusable, ambiguous };
}

/**
 * The one `checkpoint.phase` value that MEANS something to a reader.
 *
 * `phase` is otherwise free text — the field carries epic labels (`E2`),
 * lifecycle notes (`resumed`, `usage-limit-pause`) and whatever else a
 * conductor finds useful, and it stays that way. This single value is
 * reserved: it says the initiative is over, which is the one thing a
 * projection cannot infer from any other event. Nothing in `EVENT_TYPES`
 * closes an initiative, so before this an initiative could be wound up with
 * its spawns still open, and every consumer went on calling those agents
 * live for as long as the journal survived.
 *
 * Compared case-insensitively and trimmed, because it is written by hand.
 */
export const CLOSED_PHASE = 'closed';

/** Does this checkpoint's phase declare the initiative over? */
export function isClosingPhase(phase) {
  return typeof phase === 'string' && phase.trim().toLowerCase() === CLOSED_PHASE;
}

/**
 * How long an open spawn may stand, in JOURNAL time, before it is stale.
 *
 * Lives here rather than in either consumer because both `doctor.mjs` and
 * `project.mjs` have to answer the same question and neither may own it:
 * doctor imports the projection, so the projection cannot import doctor back.
 * It is the same reasoning `pairSpawns` above records — the projection used to
 * compute "who is still working" with a rule of its own, and the operator got
 * two contradictory pictures. Staleness was the half of that answer still
 * written twice: doctor said an agent had been abandoned while the board went
 * on calling it `running` forever.
 */
export const DEFAULT_STALE_HOURS = 4;

/** Hours between two ISO timestamps, or null if either is unparseable. */
export function hoursBetween(fromTs, toTs) {
  const from = Date.parse(fromTs);
  const to = Date.parse(toTs);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return (to - from) / 3_600_000;
}

/**
 * Is this open spawn stale, measured against the initiative's own movement?
 *
 * `reference` is the journal's latest timestamp, NOT the wall clock, and that
 * is the whole point: staleness here means "the initiative moved on without
 * it", which is a property of the recorded history and reads the same in six
 * months as it does now. A wall-clock rule would instead call every agent in
 * a finished initiative stale the moment you walked away from it.
 *
 * That also keeps `board.json` byte-exact under `--check`: the answer is
 * derived from event timestamps, so two clones of one journal agree. The
 * `age-fresh/warm/cold/dead` colours on the HTML page are a DIFFERENT
 * question — "how long since it last spoke, right now, in the reader's own
 * timezone" — computed client-side precisely because the artefact may not
 * read a clock. An agent can be `age-dead` (quiet for hours) without being
 * stale, and stale without being `age-dead`.
 *
 * Returns the age alongside the verdict so a caller that reports the number
 * does not recompute it — the same additive shape `pairSpawns` returns.
 */
export function spawnStaleness(spawnTs, reference, staleHours = DEFAULT_STALE_HOURS) {
  const ageHours = reference === null || reference === undefined ? null : hoursBetween(spawnTs, reference);
  return { ageHours, stale: ageHours !== null && ageHours >= staleHours, staleHours };
}

/** Agents whose `spawn` has no matching `report` or `review` yet — the "still working" set. */
export function openSpawns(file) {
  const { open } = pairSpawns(readJournal(file).events);
  return [...open.values()].flat().map((e) => ({
    agent: e.data.agent,
    since: e.ts,
    by: e.actor,
    role: e.data.role ?? null,
    ticket: e.data.ticket ?? null,
  }));
}

/**
 * POSIX single-quoting. Agent names and journal paths may legally contain
 * spaces and apostrophes; a hint that has to be edited before it runs is a
 * hint an autonomous caller will run anyway and then fight the fallout.
 */
function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The rejection message is the user interface of this guard — spell it out. */
function duplicateSpawnMessage(file, init, agent, previous) {
  const p = previous[0];
  const where = p.data.ticket ? ` on ticket ${p.data.ticket}` : '';
  const reportData = JSON.stringify({ agent, verdict: '<verdict>' });
  // A name starting with "-" would be eaten as a flag; put it after the
  // POSIX end-of-options separator, which means flags must come first.
  const closeCmd = agent.startsWith('-')
    ? `close-spawn ${sq(file)} --reason "<why>" ${sq(init)} -- ${sq(agent)}`
    : `close-spawn ${sq(file)} ${sq(init)} ${sq(agent)} --reason "<why>"`;
  return (
    `spawn rejected: agent "${agent}" already has an open spawn in this journal.\n` +
    `  previous spawn: ${p.ts} by ${p.actor}${where} (role: ${p.data.role ?? '?'})\n` +
    '  Two open spawns for one name would make spawn↔report pairing ambiguous\n' +
    '  (ADR-18), so the state is refused at write time rather than guessed later.\n' +
    '  Fix it with ONE of:\n' +
    '   - the agent finished: record its report\n' +
    `       node scripts/journal.mjs append ${sq(file)} report ${sq(init)} \\\n` +
    `         --data ${sq(reportData)}\n` +
    '   - the agent died without reporting: close it explicitly\n' +
    `       node scripts/journal.mjs ${closeCmd}\n` +
    '   - both agents are meant to run at once: give each a distinct name\n' +
    `       — "${agent}" can address only ONE live agent at a time.\n` +
    `  See what is open: node scripts/journal.mjs open-spawns ${sq(file)}`
  );
}

/**
 * Cross-process mutex via atomic mkdir. Steals locks older than 10s
 * (crashed holder); times out loudly after 5s of contention.
 *
 * Trade-off (review E2S1 note 3): a LIVE holder that keeps the lock >10s
 * can have it stolen, and its `finally` would then remove the new holder's
 * lock. Acceptable while the critical section is a single read+append
 * (milliseconds); if the section ever grows, switch to an owner-token file
 * inside the lock dir before extending it. A process suspended inside the
 * section (SIGSTOP, laptop sleep) breaks that assumption — known gap,
 * documented in docs/journal.md, fixed by the owner-token change, not here.
 *
 * The lock is keyed by the CANONICAL path, so two callers reaching one
 * journal through different symlinks share one lock. Hard links still alias
 * (same inode, different canonical paths) — that needs (dev, ino) keying.
 */
function lockDirFor(file) {
  const abs = resolve(file);
  try {
    return realpathSync(abs) + '.lock';
  } catch {
    // journal not created yet: canonicalize the directory it will live in
    try {
      return join(realpathSync(dirname(abs)), basename(abs)) + '.lock';
    } catch {
      return abs + '.lock';
    }
  }
}

function withLock(file, fn) {
  const lockDir = lockDirFor(file);
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lockDir, { recursive: false });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 10_000) {
          rmdirSync(lockDir);
          continue;
        }
      } catch {
        continue; // lock vanished between checks — retry immediately
      }
      if (Date.now() > deadline) {
        throw new Error(`journal lock timeout (held by a live writer?): ${lockDir}`);
      }
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
 * True when the file is empty/absent or its last byte is a newline. A crash
 * can leave a final line without one; appending straight onto it would FUSE
 * the truncated line with the new event, destroying the new event silently
 * (and, for spawns, hiding it from the uniqueness guard). Cheap on purpose:
 * one byte, so appends that need no full read stay O(1).
 */
function endsWithNewline(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
  try {
    const size = statSync(file).size;
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/**
 * The body of `append`, already holding the lock. `read()` memoizes the one
 * full read this call is allowed: the ts clamp and the spawn guard share it.
 * A caller that already read the journal under this same lock passes its
 * snapshot in, so no path reads the file twice.
 */
function appendUnderLock(file, event, preread = null) {
  let snapshot = preread;
  const read = () => (snapshot ??= readJournal(file));

  let ts = event.ts;
  if (ts == null) {
    ts = new Date().toISOString();
    const lastTs = read().events.at(-1)?.ts;
    if (lastTs && Date.parse(ts) < Date.parse(lastTs)) ts = lastTs;
  }
  const stamped = { ...event, ts };
  // An id the caller omitted is ISSUED, not demanded — and issued HERE, from
  // the same snapshot this write is about to extend. Issuing one is
  // read-compute-write, so anywhere outside the lock every concurrent writer
  // reads the same journal, computes the same "next" number, and then queues up
  // to write it: measured over seven runs, six concurrent `decision` appends
  // against one journal issued between 1 and 4 distinct ids for 6 events.
  // Nothing detects that later — history is append-only, so "see D-2" stays
  // ambiguous forever.
  //
  // `skills/run/SKILL.md` is emphatic that IDs never come from memory, because
  // after a compaction memory hands out the same number twice — and `append`
  // once REJECTED a missing `data.id`, leaving the conductor to remember a
  // separate `next-id` call. Measured in the field: 12 decision IDs
  // hand-assigned from memory in one initiative, which is the exact failure the
  // rule names, with nothing objecting. A rule in prose loses to a mechanism
  // that makes the mistake impossible.
  //
  // An explicit id still wins — but `"id":""` is not explicit: a conductor
  // recovering from next-id's usage error supplied exactly that, three times,
  // and the ledger kept three permanently blank ids nothing can reference.
  const issuePrefix = ID_ISSUED_FOR[stamped.ev];
  if (issuePrefix !== undefined && isDataObject(stamped.data) && (stamped.data.id === undefined || stamped.data.id === '')) {
    // a fresh object: the `data` the caller passed in stays the caller's
    stamped.data = { ...stamped.data, id: nextIdFrom(read().events, issuePrefix) };
  }
  const errors = validateEvent(stamped);
  if (errors.length > 0) {
    throw new Error('invalid event: ' + errors.join('; '));
  }
  if (stamped.ev === 'spawn' || stamped.ev === 'report' || stamped.ev === 'progress') {
    // `progress` joins the guard because data.agent is how a signal attaches
    // to the agent row in the fold — a non-canonical name would silently
    // fail to attach rather than error anywhere.
    const problem = agentNameProblem(stamped.data.agent);
    if (problem) {
      throw new Error(
        `invalid event: data.agent ${problem} — it is the only correlator ` +
          `between spawn and report (got ${JSON.stringify(stamped.data.agent)})`,
      );
    }
  }
  {
    const oversize = cappedKeyProblem(stamped.data);
    if (oversize) throw new Error(`invalid event: ${oversize}`);
  }
  if (stamped.ev === 'spawn') {
    // ADR-18: refuse a second OPEN spawn for one agent name. Same lock as the
    // write, same read as the clamp — a check outside the lock would let two
    // concurrent writers both pass it and both append.
    const previous = pairSpawns(read().events).open.get(stamped.data.agent);
    if (previous?.length) {
      throw new Error(duplicateSpawnMessage(file, stamped.init, stamped.data.agent, previous));
    }
  }
  const heal = endsWithNewline(file) ? '' : '\n';
  appendFileSync(file, heal + JSON.stringify(stamped) + '\n', 'utf8');
  return stamped;
}

/**
 * Append one event under a cross-process lock. Validates first; stamps ts
 * when absent, CLAMPED to be >= the journal's last timestamp — concurrent
 * writers therefore can never produce a ts regression (validateJournal
 * stays a hard error, and it holds by construction). An EXPLICIT ts is
 * written as given: the caller owns it and validate will flag regressions.
 *
 * `spawn` additionally must not duplicate an agent name that is still open
 * (ADR-18) — see `duplicateSpawnMessage` for how to get unstuck.
 *
 * Returns the event as written, including any `data.id` issued for it: the
 * CLI prints that, and it is the only place the issued id is reported.
 */
export function append(file, event) {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  return withLock(file, () => appendUnderLock(file, event));
}

/**
 * Close an orphaned spawn — the agent died, or was killed, without reporting.
 * This is NOT a bypass: it writes an ordinary `report` event through the
 * ordinary path, so the journal stays a plain, honest event log. It refuses
 * when there is nothing open to close, and it demands a reason, so a forced
 * closure is always attributable. Check + write share one lock, so two
 * simultaneous closures cannot both write a report for the same spawn.
 */
export function closeSpawn(file, { init, agent, actor = 'conductor', verdict = 'abandoned', reason }) {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('close-spawn requires a non-empty --reason (why was the spawn abandoned?)');
  }
  mkdirSync(dirname(resolve(file)), { recursive: true });
  return withLock(file, () => {
    const snapshot = readJournal(file);
    const { open } = pairSpawns(snapshot.events);
    const previous = open.get(agent);
    if (!previous?.length) {
      const others = [...open.keys()];
      throw new Error(
        `no open spawn for agent "${q(agent)}" in ${q(file)} — nothing to close.\n` +
          `  open spawns: ${others.length ? others.map(q).join(', ') : '(none)'}`,
      );
    }
    return appendUnderLock(
      file,
      { ev: 'report', init, actor, data: { agent, verdict, reason, closed_by: 'close-spawn' } },
      snapshot,
    );
  });
}

// ------------------------------------------------------- operator asks

/**
 * An ask is a `gate` whose `kind` IS its id. One kind, one question, forever.
 *
 * Anchored on purpose: `fold()` keys gates by kind with last-write-wins, so a
 * kind that merely CONTAINS `Q-<n>` (`usage-limit-Q-99`) must not raise the
 * next id — it would leave the true maximum free and the next ask would
 * overwrite an older question on that Map with nothing objecting.
 */
export const ASK_KIND_RE = /^Q-(\d+)$/;

/** Pure: the next free ask id over a journal's own gate kinds. */
export function nextAskKind(events) {
  let max = 0;
  for (const e of events) {
    if (e?.ev !== 'gate') continue;
    const m = ASK_KIND_RE.exec(String(e?.data?.kind ?? ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Q-${max + 1}`;
}

/**
 * Raise an operator ask: mint the id and append the gate under ONE lock.
 *
 * The id is NOT `data.id` and is not issued by `ID_ISSUED_FOR`: it is the gate
 * `kind`, so no new event type exists and the closed set stays as it is. Two
 * agents asking in the same millisecond get two ids because the read, the
 * mint and the write share this lock; minting outside it gives them one, and
 * the second question then replaces the first on the fold's kind-keyed Map —
 * silent loss, in an append-only file that can never be corrected.
 */
export function raiseAsk(file, { init, actor = 'conductor', question, recommendation = null, default: dflt = null, ticket = null }) {
  if (typeof question !== 'string' || question.trim().length === 0) {
    throw new Error('ask requires a non-empty --question (what is the operator being asked?)');
  }
  mkdirSync(dirname(resolve(file)), { recursive: true });
  return withLock(file, () => {
    const snapshot = readJournal(file);
    const data = { kind: nextAskKind(snapshot.events), result: 'WAITING_ON_OPERATOR' };
    if (ticket != null) data.ticket = ticket;
    data.question = question;
    if (recommendation != null) data.recommendation = recommendation;
    if (dflt != null) data.default = dflt;
    return appendUnderLock(file, { ev: 'gate', init, actor, data }, snapshot);
  });
}

/**
 * Read all events. A truncated (crash-interrupted) FINAL line is discarded
 * and reported via `truncatedTail`; a malformed line anywhere else is a
 * validation error, not silent data loss.
 */
export function readJournal(file) {
  if (!existsSync(file)) return { events: [], truncatedTail: false, badLines: [] };
  let raw = readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const events = [];
  const badLines = [];
  let truncatedTail = false;
  lines.forEach((line, i) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      if (i === lines.length - 1 && !raw.endsWith('\n')) truncatedTail = true;
      else badLines.push(i + 1);
    }
  });
  return { events, truncatedTail, badLines };
}

/** Filter events by ev / init / data.ticket (or data.id for ticket events). */
export function query(file, { ev, init, ticket, limit } = {}) {
  let { events } = readJournal(file);
  if (ev) events = events.filter((e) => e.ev === ev);
  if (init) events = events.filter((e) => e.init === init);
  if (ticket) {
    events = events.filter(
      (e) => e.data?.ticket === ticket || (e.ev === 'ticket.created' && e.data?.id === ticket),
    );
  }
  if (limit) events = events.slice(-limit);
  return events;
}

/**
 * Full-journal validation: per-event schema + non-decreasing timestamps.
 *
 * Spawn-pairing findings are WARNINGS, not errors: journals written before
 * the ADR-18 guard existed may legitimately contain duplicates, and the
 * append-only rule forbids rewriting history. They must not stay invisible
 * either — a projection built on such a file cannot be trusted.
 */
export function validateJournal(file) {
  const { events, truncatedTail, badLines } = readJournal(file);
  const errors = badLines.map((n) => `line ${n}: not valid JSON (mid-file corruption)`);
  let prevTs = null;
  events.forEach((e, i) => {
    for (const err of validateEvent(e)) errors.push(`event ${i + 1}: ${err}`);
    if (prevTs !== null && Date.parse(e.ts) < Date.parse(prevTs)) {
      errors.push(`event ${i + 1}: ts ${q(e.ts)} is earlier than previous ${q(prevTs)}`);
    }
    prevTs = e.ts;
  });
  const warnings = [];
  const { open, orphanReports, badNames } = pairSpawns(events);
  for (const [agent, spawns] of open) {
    if (spawns.length > 1) {
      warnings.push(
        `agent "${q(agent)}" has ${spawns.length} open spawns (since ${spawns
          .map((s) => q(s.ts))
          .join(', ')}) — written before the ADR-18 guard or edited by hand; ` +
          'spawn↔report pairing for this agent is ambiguous',
      );
    }
  }
  for (const r of orphanReports) {
    warnings.push(`report for agent "${q(r.data.agent)}" at ${q(r.ts)} closes no open spawn`);
  }
  for (const [raw, problem] of badNames) {
    warnings.push(`unusable data.agent ${q(raw)}: ${problem} — excluded from spawn↔report pairing`);
  }
  // Historical oversizes are warnings, never errors: the cap is enforced at
  // append time, and a hand-edited file must stay visible without turning a
  // whole journal's `validate` red retroactively.
  events.forEach((e, i) => {
    const oversize = cappedKeyProblem(e?.data);
    if (oversize) warnings.push(`event ${i + 1}: ${oversize}`);
  });
  return { ok: errors.length === 0, errors, warnings, count: events.length, truncatedTail };
}

/**
 * Next free ID for a prefix, over events already read. Separate from `nextId`
 * only so the locked append path can issue an id from the snapshot it is
 * holding: re-reading the file there would be a second full read on every
 * append, which a long journal pays for on every event.
 */
function nextIdFrom(events, prefix) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(prefix)) {
    throw new Error(`invalid id prefix "${prefix}" — use letters/digits, starting with a letter`);
  }
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const e of events) {
    const m = typeof e.data?.id === 'string' && e.data.id.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
}

/**
 * Next free ID for a prefix, derived from the journal — never from memory.
 * Scans data.id fields shaped `<PREFIX>-<number>` and returns max+1.
 *
 * A PREVIEW, not a reservation: nothing is written and no lock is held, so an
 * id read here and appended later collides with any writer that appended in
 * between. `append` issues ids under its own write lock; a caller that can
 * let it do so has no window at all.
 */
export function nextId(file, prefix) {
  return nextIdFrom(readJournal(file).events, prefix);
}

/** Latest checkpoint + still-open leases — the resume surface. */
export function tail(file) {
  const { events } = readJournal(file);
  const checkpoint = [...events].reverse().find((e) => e.ev === 'checkpoint') ?? null;
  const open = new Map();
  const mismatchedReleases = [];
  for (const e of events) {
    if (e.ev === 'lease.acquired') open.set(e.data.resource, e.data.holder);
    if (e.ev === 'lease.released') {
      // A release only counts when it comes from the current holder —
      // anything else is a protocol violation and must stay visible.
      if (open.get(e.data.resource) === e.data.holder) open.delete(e.data.resource);
      else mismatchedReleases.push({ resource: e.data.resource, by: e.data.holder, holder: open.get(e.data.resource) ?? null });
    }
  }
  return {
    checkpoint,
    openLeases: [...open.entries()].map(([resource, holder]) => ({ resource, holder })),
    mismatchedReleases,
  };
}

// ---------------------------------------------------------------- CLI

function parseFlags(args, allowed) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') {
      // POSIX end of options: the rest is positional, verbatim. Without it
      // an agent named "--reason" could be spawned but never closed.
      rest.push(...args.slice(i + 1));
      break;
    }
    if (args[i].startsWith('--')) {
      const name = args[i].slice(2);
      if (!allowed.includes(name)) throw new Error(`unknown flag --${name}`);
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`flag --${name} requires a value`);
      }
      flags[name] = value;
    } else rest.push(args[i]);
  }
  return { flags, rest };
}

const CMD_FLAGS = {
  append: ['actor', 'data'],
  query: ['ev', 'init', 'ticket', 'limit'],
  validate: [],
  'next-id': [],
  tail: [],
  'open-spawns': [],
  'close-spawn': ['actor', 'verdict', 'reason'],
  ask: ['actor', 'ticket', 'question', 'recommendation', 'default'],
};

/**
 * The ONE way this CLI writes a value to a terminal.
 *
 * `JSON.stringify` escapes C0 controls and stops there: bidi overrides, TAG
 * characters and zero-width marks come out RAW. Every subcommand here prints
 * journal content — `query`, `tail`, `validate`, `open-spawns`, `append`,
 * `close-spawn`, `next-id` — so each was a way for a foreign repository's text
 * to reach the operator's screen invisibly, exactly as it reached it through
 * project.mjs's warnings until a security review demonstrated that one.
 *
 * The escape notation is JSON's own, not `<U+202E>`, because this output is
 * MACHINE-READABLE and this repo parses it back. `JSON.parse` of the result is
 * deep-equal to the input, so safety costs no fidelity here — a test asserts
 * the round trip rather than trusting the claim.
 *
 * The round-trip guarantee is about the JSON subcommands, and `next-id` is not
 * one of them: it prints a bare identifier, so there is nothing to parse back.
 * It still goes through here rather than being the one sink that does not,
 * because "this one is safe by construction" is how a sink gets forgotten when
 * the construction changes. Its own safety is separately guaranteed: `nextId`
 * rejects any prefix outside `[A-Za-z][A-Za-z0-9]*` before it builds a value.
 */
function emit(value, indent) {
  return jsonEscapeInvisible(typeof value === 'string' ? value : JSON.stringify(value, null, indent));
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (!(cmd in CMD_FLAGS)) throw new UsageError();
    const { flags, rest } = parseFlags(args, CMD_FLAGS[cmd]);
    if (flags.limit !== undefined && !Number.isInteger(Number(flags.limit))) {
      throw new Error(`--limit must be an integer (got "${flags.limit}")`);
    }
    switch (cmd) {
      case 'append': {
        const [file, ev, init] = rest;
        if (!file || !ev || !init) throw new UsageError();
        const data = flags.data ? JSON.parse(flags.data) : {};
        // An omitted id is issued by `append`, inside its write lock, and comes
        // back on the event this prints — issuing one out here would be outside
        // that lock, which is where concurrent writers hand out one id twice.
        const written = append(file, { ev, init, actor: flags.actor ?? 'conductor', data });
        console.log(emit(written));
        return;
      }
      case 'query': {
        const [file] = rest;
        if (!file) throw new UsageError();
        for (const e of query(file, { ev: flags.ev, init: flags.init, ticket: flags.ticket, limit: flags.limit && Number(flags.limit) })) {
          console.log(emit(e));
        }
        return;
      }
      case 'validate': {
        const [file] = rest;
        if (!file) throw new UsageError();
        const result = validateJournal(file);
        console.log(emit(result, 2));
        if (!result.ok) process.exit(1);
        return;
      }
      case 'next-id': {
        const [file, prefix] = rest;
        if (!file || !prefix) throw new UsageError();
        console.log(emit(nextId(file, prefix)));
        return;
      }
      case 'tail': {
        const [file] = rest;
        if (!file) throw new UsageError();
        console.log(emit(tail(file), 2));
        return;
      }
      case 'open-spawns': {
        const [file] = rest;
        if (!file) throw new UsageError();
        console.log(emit(openSpawns(file), 2));
        return;
      }
      case 'ask': {
        const [file, init] = rest;
        if (!file || !init) throw new UsageError();
        // a missing --question gets raiseAsk's specific message, not a usage
        // dump: the flag is the whole content of the command.
        const written = raiseAsk(file, {
          init,
          actor: flags.actor ?? 'conductor',
          question: flags.question ?? '',
          recommendation: flags.recommendation ?? null,
          default: flags.default ?? null,
          ticket: flags.ticket ?? null,
        });
        console.log(emit(written));
        return;
      }
      case 'close-spawn': {
        const [file, init, agent] = rest;
        if (!file || !init || !agent) throw new UsageError();
        // a missing --reason gets closeSpawn's specific message, not a usage dump
        const written = closeSpawn(file, {
          init,
          agent,
          actor: flags.actor ?? 'conductor',
          verdict: flags.verdict ?? 'abandoned',
          reason: flags.reason ?? '',
        });
        console.log(emit(written));
        return;
      }
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(
        'usage: journal.mjs append <file> <ev> <init> [--actor A] [--data JSON]\n' +
          '       journal.mjs query <file> [--ev E] [--init I] [--ticket T] [--limit N]\n' +
          '       journal.mjs validate <file> · next-id <file> <prefix> · tail <file>\n' +
          '       journal.mjs open-spawns <file>\n' +
          '       journal.mjs close-spawn <file> <init> <agent> --reason R [--verdict V] [--actor A]\n' +
          '       journal.mjs ask <file> <init> --question Q [--recommendation R] [--default D] [--ticket T] [--actor A]\n' +
          '\n' +
          // The `--data` contract varies per event and lived only in a table no
          // command printed. A field run discovered it by rejection, one failed
          // invocation at a time.
          'events, and the `--data` keys each one requires:\n' +
          EVENT_TYPES.map((ev) => {
            const required = DATA_REQUIRED[ev];
            const issued = ID_ISSUED_FOR[ev] !== undefined ? '  (id is issued if omitted)' : '';
            return `  ${ev.padEnd(16)}${required === undefined ? '—' : required.join(', ')}${issued}`;
          }).join('\n'),
      );
      process.exit(2);
    }
    console.error(`journal: ${err.message}`);
    process.exit(1);
  }
}

class UsageError extends Error {}

/**
 * Canonical absolute path, falling back to the merely-resolved one when the
 * path cannot be canonicalized.
 *
 * The fallback is load-bearing, and NOT for `node --eval`: there argv[1] is
 * undefined and the caller returns before ever reaching this. It is for the
 * cases where argv[1] names something realpath cannot follow — the script
 * directory was renamed or deleted after launch, a parent component is an
 * unreadable directory (EACCES), or a launcher/shim rewrote argv[1] to a
 * logical name that was never a real file. Without the fallback the guard
 * throws ENOENT out of module scope and the tool dies at startup, which is a
 * different bug, not a fix.
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
 * every invocation through a symlinked path into a SILENT no-op under exit 0:
 * `main()` never ran, nothing was written, nothing said so. That is not
 * theoretical — `/tmp` and `/var` are symlinks on macOS, and plugin installs
 * routinely reach `scripts/` through one.
 */
function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  return canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(moduleUrl));
}

if (isMainModule(import.meta.url)) main();
