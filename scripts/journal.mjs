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
 *   node journal.mjs open-spawns <file>            # agents with no report yet
 *   node journal.mjs close-spawn <file> <init> <agent> --reason R [--verdict V]
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
  'spawn',
  'report',
  'gate',
  'review',
  'merge',
  'decision',
  'lease.acquired',
  'lease.released',
  'checkpoint',
  'retro.entry',
  'error',
]);

/** Per-type required keys inside `data` (data may always carry extra keys). */
const DATA_REQUIRED = Object.freeze({
  'ticket.created': ['id'],
  spawn: ['agent', 'role'],
  report: ['agent', 'verdict'],
  gate: ['kind', 'result'],
  review: ['ticket', 'verdict', 'by'],
  merge: ['ticket', 'sha'],
  decision: ['id', 'text'],
  'lease.acquired': ['resource', 'holder'],
  'lease.released': ['resource', 'holder'],
  checkpoint: ['phase', 'next_steps'],
  'retro.entry': ['kind', 'target'],
  error: ['class'],
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
    errors.push(`ev "${q(event.ev)}" is not in the closed event set`);
  }
  if (typeof event.init !== 'string' || event.init.length === 0) {
    errors.push('init (initiative slug) must be a non-empty string');
  }
  if (typeof event.actor !== 'string' || event.actor.length === 0) {
    errors.push('actor must be a non-empty string');
  }
  if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) {
    errors.push('data must be a JSON object (may be empty)');
  } else if (DATA_REQUIRED[event.ev]) {
    for (const key of DATA_REQUIRED[event.ev]) {
      if (!(key in event.data)) errors.push(`data.${q(key)} is required for ev "${q(event.ev)}"`);
      else if (key === 'id' && typeof event.data.id !== 'string') {
        errors.push(`data.id must be a string for ev "${q(event.ev)}" (got ${typeof event.data.id})`);
      }
    }
  }
  return errors;
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
 * a report closes the OLDEST still-open spawn of that name (FIFO). This is
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
    if (e?.ev !== 'spawn' && e?.ev !== 'report') continue;
    const agent = e.data?.agent;
    const problem = agentNameProblem(agent);
    if (problem) {
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
      if (queue?.length) {
        const spawn = queue.shift();
        pairs.push({ spawn, report: e });
        if (queue.length === 0) open.delete(agent);
      } else orphanReports.push(e);
    }
  }
  return { open, orphanReports, badNames, pairs, unusable, ambiguous };
}

/** Agents whose `spawn` has no matching `report` yet — the "still working" set. */
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
  const errors = validateEvent(stamped);
  if (errors.length > 0) {
    throw new Error('invalid event: ' + errors.join('; '));
  }
  if (stamped.ev === 'spawn' || stamped.ev === 'report') {
    const problem = agentNameProblem(stamped.data.agent);
    if (problem) {
      throw new Error(
        `invalid event: data.agent ${problem} — it is the only correlator ` +
          `between spawn and report (got ${JSON.stringify(stamped.data.agent)})`,
      );
    }
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
  return { ok: errors.length === 0, errors, warnings, count: events.length, truncatedTail };
}

/**
 * Next free ID for a prefix, derived from the journal — never from memory.
 * Scans data.id fields shaped `<PREFIX>-<number>` and returns max+1.
 */
export function nextId(file, prefix) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(prefix)) {
    throw new Error(`invalid id prefix "${prefix}" — use letters/digits, starting with a letter`);
  }
  const { events } = readJournal(file);
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const e of events) {
    const m = typeof e.data?.id === 'string' && e.data.id.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
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
          '       journal.mjs close-spawn <file> <init> <agent> --reason R [--verdict V] [--actor A]',
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
