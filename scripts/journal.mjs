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
 *   node journal.mjs append   <file> <ev> <init> [--actor A] [--data JSON]
 *   node journal.mjs query    <file> [--ev E] [--init I] [--ticket T] [--limit N]
 *   node journal.mjs validate <file>
 *   node journal.mjs next-id  <file> <prefix>      # e.g. prefix D -> D-7
 *   node journal.mjs tail     <file>               # last checkpoint + open items
 * Exit: 0 ok · 1 validation/finding error · 2 usage/IO error
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync, rmdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    errors.push(`ev "${event.ev}" is not in the closed event set`);
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
      if (!(key in event.data)) errors.push(`data.${key} is required for ev "${event.ev}"`);
      else if (key === 'id' && typeof event.data.id !== 'string') {
        errors.push(`data.id must be a string for ev "${event.ev}" (got ${typeof event.data.id})`);
      }
    }
  }
  return errors;
}

/**
 * Cross-process mutex via atomic mkdir. Steals locks older than 10s
 * (crashed holder); times out loudly after 5s of contention.
 */
function withLock(file, fn) {
  const lockDir = resolve(file) + '.lock';
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
 * Append one event under a cross-process lock. Validates first; stamps ts
 * when absent, CLAMPED to be >= the journal's last timestamp — concurrent
 * writers therefore can never produce a ts regression (validateJournal
 * stays a hard error, and it holds by construction). An EXPLICIT ts is
 * written as given: the caller owns it and validate will flag regressions.
 */
export function append(file, event) {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  return withLock(file, () => {
    let ts = event.ts;
    if (ts == null) {
      ts = new Date().toISOString();
      const lastTs = readJournal(file).events.at(-1)?.ts;
      if (lastTs && Date.parse(ts) < Date.parse(lastTs)) ts = lastTs;
    }
    const stamped = { ...event, ts };
    const errors = validateEvent(stamped);
    if (errors.length > 0) {
      throw new Error('invalid event: ' + errors.join('; '));
    }
    appendFileSync(file, JSON.stringify(stamped) + '\n', 'utf8');
    return stamped;
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

/** Full-journal validation: per-event schema + non-decreasing timestamps. */
export function validateJournal(file) {
  const { events, truncatedTail, badLines } = readJournal(file);
  const errors = badLines.map((n) => `line ${n}: not valid JSON (mid-file corruption)`);
  let prevTs = null;
  events.forEach((e, i) => {
    for (const err of validateEvent(e)) errors.push(`event ${i + 1}: ${err}`);
    if (prevTs !== null && Date.parse(e.ts) < Date.parse(prevTs)) {
      errors.push(`event ${i + 1}: ts ${e.ts} is earlier than previous ${prevTs}`);
    }
    prevTs = e.ts;
  });
  return { ok: errors.length === 0, errors, count: events.length, truncatedTail };
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
    if (args[i].startsWith('--')) {
      const name = args[i].slice(2);
      if (!allowed.includes(name)) throw new Error(`unknown flag --${name}`);
      flags[name] = args[++i];
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
};

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
        console.log(JSON.stringify(written));
        return;
      }
      case 'query': {
        const [file] = rest;
        if (!file) throw new UsageError();
        for (const e of query(file, { ev: flags.ev, init: flags.init, ticket: flags.ticket, limit: flags.limit && Number(flags.limit) })) {
          console.log(JSON.stringify(e));
        }
        return;
      }
      case 'validate': {
        const [file] = rest;
        if (!file) throw new UsageError();
        const result = validateJournal(file);
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exit(1);
        return;
      }
      case 'next-id': {
        const [file, prefix] = rest;
        if (!file || !prefix) throw new UsageError();
        console.log(nextId(file, prefix));
        return;
      }
      case 'tail': {
        const [file] = rest;
        if (!file) throw new UsageError();
        console.log(JSON.stringify(tail(file), null, 2));
        return;
      }
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(
        'usage: journal.mjs append <file> <ev> <init> [--actor A] [--data JSON]\n' +
          '       journal.mjs query <file> [--ev E] [--init I] [--ticket T] [--limit N]\n' +
          '       journal.mjs validate <file> · next-id <file> <prefix> · tail <file>',
      );
      process.exit(2);
    }
    console.error(`journal: ${err.message}`);
    process.exit(1);
  }
}

class UsageError extends Error {}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
