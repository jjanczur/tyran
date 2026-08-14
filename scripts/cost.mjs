#!/usr/bin/env node
/**
 * cost — what the work cost, in tokens the platform itself reported.
 *
 * Claude Code already writes every number this needs. Each assistant record in
 * a session transcript carries `message.usage` (input, cache write, cache read,
 * output) and `message.model`; each subagent gets its own transcript under
 * `<session>/subagents/` beside a `.meta.json` naming its agent type and the
 * description the conductor gave it. So this reads, it never instruments: no
 * hook, no probe, no new event type, and nothing to keep in sync.
 *
 * THREE PROPERTIES THIS FILE EXISTS TO HOLD.
 *
 * 1. Tokens are facts; money is an opinion. Only tokens are counted here.
 *    Money is derived at the very end from an operator-written rate card, and
 *    the card's NAME travels with every amount — two people quoting different
 *    cards get different money from one set of tokens, and a figure that
 *    cannot say which card produced it is not a measurement.
 *
 * 2. This is NOT a projection. Its inputs live in ~/.claude, are machine-local
 *    and differ per clone, so it is never byte-compared, never committed, and
 *    never enters `board.json` — the sidecar it writes joins the overnight
 *    runtime files that `.tyran/.gitignore` excludes. Putting spend into a
 *    committed, byte-checked artefact would make two people with the same
 *    journal disagree.
 *
 * 3. Gaps are reported, never zeroed. A model with no rate is `unpriced`, an
 *    agent whose ticket cannot be read is `unattributed`, a transcript that
 *    will not parse is `unreadable`, and the conductor's own spend — measured
 *    at roughly two thirds of a real session — is its own line rather than
 *    being spread across tickets or quietly dropped. An operator uses these
 *    numbers to decide where to spend the next agent; a total that is low by
 *    an unknown amount produces confident wrong routing, which is worse than
 *    no number at all.
 *
 * CLI:
 *   node cost.mjs [--dir <.tyran>] [--session <id>] [--json] [--projects <dir>]
 * Exit: 0 ok · 2 usage/IO
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './yaml-lite.mjs';
import { pricingOf, PRICING_RATE_KEYS } from './schema.mjs';
import { jsonEscapeInvisible } from './invisible.mjs';

export const COST_FILE = 'cost.json';
export const COST_SCHEMA = 1;

/** Read buffer for the chunked line reader. Transcripts reach tens of MB. */
const CHUNK_BYTES = 1 << 20;

/**
 * A single line longer than this is abandoned rather than accumulated. One
 * pathological record must not turn a reader into an out-of-memory crash on
 * the operator's machine; the line is counted as skipped and says so.
 */
const MAX_LINE_BYTES = 8 << 20;

/** Transcripts above this are refused loudly rather than read. */
const MAX_TRANSCRIPT_BYTES = 512 << 20;

/** The conductor's own transcript is one file; agents are the rest. */
export const CONDUCTOR = 'conductor';

/** A ticket id at the head of a Task description, which is how a subagent's
 * spend reaches a ticket without any change to the journal or the event set.
 * The conductor writes the id; a description that omits it lands the agent in
 * `unattributed`, visibly, rather than being guessed at. */
export const TICKET_IN_DESCRIPTION_RE = /^\s*\[?(T-\d+)\b/;

class UsageError extends Error {}

/** A fresh counter set. Kept flat so accumulation is a loop, not a schema. */
export function emptyCounters() {
  return { requests: 0, input: 0, cache_write: 0, cache_read: 0, output: 0 };
}

const COUNTER_KEYS = Object.freeze(['requests', 'input', 'cache_write', 'cache_read', 'output']);

/** b into a, in place. */
export function addCounters(a, b) {
  for (const key of COUNTER_KEYS) a[key] += b[key] ?? 0;
  return a;
}

/** Total tokens billed, whatever the rate. Requests are not tokens. */
export function tokensOf(counters) {
  return counters.input + counters.cache_write + counters.cache_read + counters.output;
}

/** Own-property read on a prototype-free view of foreign JSON. */
function field(obj, name) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, name)
    ? obj[name]
    : undefined;
}

function finiteCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * What one request cost, in dollars, or null when the model has no rate.
 * Null is not zero and callers must not treat it as zero — that distinction
 * is the whole of property 3 above.
 */
export function costOf(model, counters, models) {
  const rates = Object.prototype.hasOwnProperty.call(models, model) ? models[model] : undefined;
  if (rates === undefined) return null;
  let total = 0;
  for (const key of PRICING_RATE_KEYS) total += (counters[key] ?? 0) * rates[key];
  return total / 1e6;
}

/**
 * Sum a per-model table to dollars, counting only the models that have a rate.
 *
 * Null means "nothing here is priced at all" — a row that renders as an em
 * dash. It deliberately does NOT mean "one model is missing a rate": a real
 * rate card always misses something (`<synthetic>` appears in live data and
 * cannot be priced by anyone), and nulling the grand total over one absent
 * row would leave every amount on the page blank forever. Partial pricing is
 * therefore a partial sum, and `unpriced` names what was left out of it —
 * useful and honest, where an em dash would be honest and useless.
 */
export function costOfTable(byModel, models) {
  let total = 0;
  let priced = 0;
  for (const [model, counters] of Object.entries(byModel)) {
    const one = costOf(model, counters, models);
    if (one === null) continue;
    priced += 1;
    total += one;
  }
  return priced === 0 ? null : total;
}

/**
 * Every complete line of a file, as a string, without holding the file in
 * memory. Sync to match the rest of this codebase; chunked because a
 * transcript is routinely tens of megabytes and occasionally hundreds.
 */
export function forEachLine(path, onLine) {
  const size = statSync(path).size;
  if (size > MAX_TRANSCRIPT_BYTES) {
    throw new UsageError(`cost: transcript larger than ${MAX_TRANSCRIPT_BYTES} bytes: ${path}`);
  }
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let rest = '';
  let skipped = 0;
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK_BYTES, null);
      if (read === 0) break;
      rest += buffer.toString('utf8', 0, read);
      let at;
      while ((at = rest.indexOf('\n')) !== -1) {
        onLine(rest.slice(0, at));
        rest = rest.slice(at + 1);
      }
      if (rest.length > MAX_LINE_BYTES) {
        skipped += 1;
        rest = '';
      }
    }
    if (rest !== '') onLine(rest);
  } finally {
    closeSync(fd);
  }
  return skipped;
}

/**
 * One transcript folded to per-model counters.
 *
 * Deduplicated by `requestId`: the platform writes one record per content
 * block, and every record of a request repeats that request's CUMULATIVE
 * usage. Counting them all inflates every number in this file, so the first
 * record of each request wins and the rest are dropped.
 */
export function scanTranscript(path) {
  const byModel = Object.create(null);
  const seen = new Set();
  let malformed = 0;
  let firstTs = null;
  let lastTs = null;
  const skippedLines = forEachLine(path, (line) => {
    if (line === '' || line.charCodeAt(0) !== 123 /* { */) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformed += 1;
      return;
    }
    const ts = field(event, 'timestamp');
    if (typeof ts === 'string') {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }
    if (field(event, 'type') !== 'assistant') return;
    const message = field(event, 'message');
    const usage = field(message, 'usage');
    if (usage === null || typeof usage !== 'object') return;
    const key = field(event, 'requestId') ?? field(event, 'uuid');
    if (typeof key === 'string') {
      if (seen.has(key)) return;
      seen.add(key);
    }
    const model = typeof field(message, 'model') === 'string' ? field(message, 'model') : 'unknown';
    if (byModel[model] === undefined) byModel[model] = emptyCounters();
    const into = byModel[model];
    into.requests += 1;
    into.input += finiteCount(field(usage, 'input_tokens'));
    into.cache_write += finiteCount(field(usage, 'cache_creation_input_tokens'));
    into.cache_read += finiteCount(field(usage, 'cache_read_input_tokens'));
    into.output += finiteCount(field(usage, 'output_tokens'));
  });
  return { byModel, malformed, skippedLines, firstTs, lastTs };
}

/**
 * Where this repo's transcripts live.
 *
 * The directory name is the repo path with separators replaced by dashes —
 * a rule read off the filesystem, not out of documentation, so it is checked
 * and then verified rather than trusted: if the computed directory is absent,
 * every project directory is opened and matched on the `cwd` its records
 * carry. A guess about the platform that cannot be confirmed is exactly the
 * kind of assumption this project refuses to build a control on.
 */
export function transcriptDirFor(repoRoot, projectsRoot) {
  const direct = join(projectsRoot, resolve(repoRoot).split(sep).join('-'));
  if (existsSync(direct)) return direct;
  if (!existsSync(projectsRoot)) return null;
  const want = resolve(repoRoot);
  for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(projectsRoot, entry.name);
    let sessions;
    try {
      sessions = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const session of sessions) {
      let matched = false;
      try {
        forEachLine(join(dir, session), (line) => {
          if (matched || line === '' || line.charCodeAt(0) !== 123) return;
          try {
            if (field(JSON.parse(line), 'cwd') === want) matched = true;
          } catch {
            /* a malformed first line is not a reason to reject the directory */
          }
        });
      } catch {
        continue;
      }
      if (matched) return dir;
    }
  }
  return null;
}

/** Every transcript belonging to this repo: the sessions and their agents. */
export function listSources(transcriptDir, sessionFilter) {
  const out = [];
  let sessions;
  try {
    sessions = readdirSync(transcriptDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return out;
  }
  for (const file of sessions.sort()) {
    const id = basename(file, '.jsonl');
    if (sessionFilter && id !== sessionFilter) continue;
    out.push({ kind: CONDUCTOR, session: id, path: join(transcriptDir, file) });
    const agentDir = join(transcriptDir, id, 'subagents');
    let agents;
    try {
      agents = readdirSync(agentDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const agentFile of agents.sort()) {
      const agentId = basename(agentFile, '.jsonl');
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(join(agentDir, `${agentId}.meta.json`), 'utf8'));
      } catch {
        /* an agent with no meta is still spend; it just cannot be attributed */
      }
      const description = typeof field(meta, 'description') === 'string' ? field(meta, 'description') : '';
      const ticketMatch = TICKET_IN_DESCRIPTION_RE.exec(description);
      out.push({
        kind: 'agent',
        session: id,
        path: join(agentDir, agentFile),
        agent_id: agentId,
        agent_type: typeof field(meta, 'agentType') === 'string' ? field(meta, 'agentType') : 'unknown',
        ticket: ticketMatch === null ? null : ticketMatch[1],
      });
    }
  }
  return out;
}

/**
 * Scan every source, reusing the previous run's numbers for files whose size
 * and mtime are unchanged.
 *
 * This is the difference between a page that refreshes every thirty seconds
 * and a page that re-reads sixty megabytes every thirty seconds. A finished
 * agent's transcript never changes again, so in practice only the running
 * session's own file is ever re-read.
 */
export function scanAll(sources, cache) {
  const previous = new Map();
  for (const entry of cache?.sources ?? []) previous.set(entry.path, entry);
  const scanned = [];
  let unreadable = 0;
  let reused = 0;
  for (const source of sources) {
    let stat;
    try {
      stat = statSync(source.path);
    } catch {
      unreadable += 1;
      continue;
    }
    const before = previous.get(source.path);
    if (before && before.mtime_ms === stat.mtimeMs && before.size === stat.size && before.by_model) {
      reused += 1;
      scanned.push({ ...source, mtime_ms: stat.mtimeMs, size: stat.size, by_model: before.by_model, last_ts: before.last_ts ?? null });
      continue;
    }
    let result;
    try {
      result = scanTranscript(source.path);
    } catch {
      unreadable += 1;
      continue;
    }
    scanned.push({
      ...source,
      mtime_ms: stat.mtimeMs,
      size: stat.size,
      by_model: result.byModel,
      last_ts: result.lastTs,
    });
  }
  return { scanned, unreadable, reused };
}

function bucket(table, key) {
  if (table[key] === undefined) table[key] = { byModel: Object.create(null), counters: emptyCounters() };
  return table[key];
}

function intoBucket(target, model, counters) {
  if (target.byModel[model] === undefined) target.byModel[model] = emptyCounters();
  addCounters(target.byModel[model], counters);
  addCounters(target.counters, counters);
}

/** Sorted rows, biggest first, with a stable name tiebreak for byte-equal runs. */
function rows(table, nameKey, models) {
  return Object.entries(table)
    .map(([name, entry]) => ({
      [nameKey]: name,
      ...entry.counters,
      tokens: tokensOf(entry.counters),
      usd: costOfTable(entry.byModel, models),
    }))
    .sort((a, b) => b.tokens - a.tokens || String(a[nameKey]).localeCompare(String(b[nameKey])));
}

/**
 * The report, from scanned sources and a rate card. Pure — every input is an
 * argument, so the shape is testable without touching a filesystem.
 */
export function rollup(scanned, pricing, extra = {}) {
  const { models, rate_card: rateCard } = pricing;
  const totals = emptyCounters();
  const totalsByModel = Object.create(null);
  const conductor = { byModel: Object.create(null), counters: emptyCounters() };
  const byModel = Object.create(null);
  const byAgentType = Object.create(null);
  const byTicket = Object.create(null);
  const unpriced = new Set();
  let agentTranscripts = 0;
  let attributed = 0;
  let newestTs = null;

  for (const source of scanned) {
    if (source.kind === 'agent') agentTranscripts += 1;
    if (source.kind === 'agent' && source.ticket !== null) attributed += 1;
    if (typeof source.last_ts === 'string' && (newestTs === null || source.last_ts > newestTs)) {
      newestTs = source.last_ts;
    }
    for (const [model, counters] of Object.entries(source.by_model)) {
      addCounters(totals, counters);
      if (totalsByModel[model] === undefined) totalsByModel[model] = emptyCounters();
      addCounters(totalsByModel[model], counters);
      // Only a model that actually billed something is worth naming: the
      // platform emits `<synthetic>` records carrying zero tokens, and a
      // permanent warning about a model that cannot cost anything is noise
      // that teaches operators to ignore the line.
      if (!Object.prototype.hasOwnProperty.call(models, model) && tokensOf(counters) > 0) unpriced.add(model);
      intoBucket(bucket(byModel, model), model, counters);
      if (source.kind === CONDUCTOR) {
        intoBucket(conductor, model, counters);
        intoBucket(bucket(byAgentType, CONDUCTOR), model, counters);
        intoBucket(bucket(byTicket, CONDUCTOR), model, counters);
      } else {
        intoBucket(bucket(byAgentType, source.agent_type), model, counters);
        intoBucket(bucket(byTicket, source.ticket ?? 'unattributed'), model, counters);
      }
    }
  }

  const conductorUsd = costOfTable(conductor.byModel, models);
  const totalUsd = costOfTable(totalsByModel, models);
  return {
    schema: COST_SCHEMA,
    rate_card: rateCard,
    as_of: newestTs,
    totals: {
      ...totals,
      tokens: tokensOf(totals),
      usd: totalUsd,
      // The share an operator must see next to any per-ticket figure: the
      // conductor's own context is not attributable to a ticket, and omitting
      // it silently would present a fraction of the bill as the cost of the
      // work.
      //
      // Measured in TOKENS, never dollars, and not as a matter of taste: a
      // partial rate card prices only some models, so a dollar share is a
      // ratio over whichever subset happened to be priced. The same tree
      // reported 86% by tokens and 99% by dollars while one model lacked a
      // rate. Tokens are always complete, so the number never moves for a
      // reason that has nothing to do with the work.
      conductor_token_share:
        tokensOf(totals) > 0 ? Math.round((tokensOf(conductor.counters) / tokensOf(totals)) * 100) : 0,
      conductor_usd: conductorUsd,
    },
    composition: PRICING_RATE_KEYS.map((key) => ({
      kind: key,
      tokens: totals[key],
      usd: costOfTable(
        Object.fromEntries(
          Object.entries(totalsByModel).map(([model, counters]) => [
            model,
            { ...emptyCounters(), [key]: counters[key] },
          ])
        ),
        models
      ),
    })),
    by_model: rows(byModel, 'model', models),
    by_agent_type: rows(byAgentType, 'agent_type', models),
    by_ticket: rows(byTicket, 'ticket', models),
    unpriced: [...unpriced].sort(),
    coverage: {
      agent_transcripts: agentTranscripts,
      attributed,
      unattributed: agentTranscripts - attributed,
      unreadable: extra.unreadable ?? 0,
      reused_from_cache: extra.reused ?? 0,
    },
  };
}

/* ------------------------------- rendering ------------------------------- */

/** An amount that rounds to nothing still cost something; say so rather than
 * printing `$0.00`, which reads as free. */
const money = (usd) => (usd === null ? '—' : usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`);

function tokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} k`;
  return String(n);
}

function table(headers, body) {
  const widths = headers.map((h, i) => Math.max(h.length, ...body.map((r) => String(r[i]).length)));
  const line = (cells) =>
    '  ' + cells.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join('  ');
  return [line(headers), ...body.map(line)].join('\n');
}

/** The human report. */
export function renderReport(report) {
  const out = [];
  const card = report.rate_card === null ? 'no rate card — tokens only' : `rate card ${report.rate_card}`;
  out.push(`Spend — ${tokens(report.totals.tokens)} tokens, ${money(report.totals.usd)} (${card})`);
  out.push('');
  out.push(
    table(
      ['what', 'tokens', 'usd'],
      report.composition.map((c) => [c.kind.replace('_', ' '), tokens(c.tokens), money(c.usd)])
    )
  );
  for (const [title, key, rowsOf] of [
    ['By model', 'model', report.by_model],
    ['By agent type', 'agent_type', report.by_agent_type],
    ['By ticket', 'ticket', report.by_ticket],
  ]) {
    out.push('');
    out.push(title);
    out.push(
      table(
        [key.replace('_', ' '), 'requests', 'tokens', 'usd'],
        rowsOf.map((r) => [r[key], String(r.requests), tokens(r.tokens), money(r.usd)])
      )
    );
  }
  out.push('');
  const c = report.coverage;
  out.push(
    `Coverage: ${c.attributed} of ${c.agent_transcripts} agent transcripts carry a ticket; ` +
      `${c.unattributed} unattributed, ${c.unreadable} unreadable.`
  );
  out.push(
    `Conductor overhead: ${report.totals.conductor_token_share}% of tokens — not attributable to any ticket.`
  );
  if (report.unpriced.length > 0) {
    out.push(`Unpriced models (counted in tokens, absent from every amount): ${report.unpriced.join(', ')}`);
  }
  return out.join('\n') + '\n';
}

/** The sidecar bytes: invisibles escaped, never removed, exactly like board.json. */
export function costJson(report) {
  return jsonEscapeInvisible(JSON.stringify(report, null, 2)) + '\n';
}

/* ---------------------------------- CLI ---------------------------------- */

function loadPricing(tyranDir) {
  try {
    return pricingOf(parse(readFileSync(join(tyranDir, 'config.yaml'), 'utf8')));
  } catch {
    // A config that will not parse is doctor's problem to report, not this
    // reader's problem to refuse over: tokens are still worth counting.
    return { rate_card: null, models: Object.create(null) };
  }
}

function readCache(path) {
  try {
    const cached = JSON.parse(readFileSync(path, 'utf8'));
    return cached && cached.schema === COST_SCHEMA ? cached : null;
  } catch {
    return null;
  }
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Build the report for a repo. Exported so the board server reuses it. */
export function costReport({ tyranDir, projectsRoot, session = null, repoRoot = null } = {}) {
  const root = repoRoot ?? resolve(tyranDir, '..');
  const dir = transcriptDirFor(root, projectsRoot ?? join(homedir(), '.claude', 'projects'));
  const pricing = loadPricing(tyranDir);
  if (dir === null) {
    const empty = rollup([], pricing, {});
    empty.transcripts_found = false;
    return empty;
  }
  const cachePath = join(tyranDir, 'state', COST_FILE);
  const { scanned, unreadable, reused } = scanAll(listSources(dir, session), readCache(cachePath));
  const report = rollup(scanned, pricing, { unreadable, reused });
  report.transcripts_found = true;
  report.sources = scanned.map((s) => ({
    path: s.path,
    kind: s.kind,
    mtime_ms: s.mtime_ms,
    size: s.size,
    agent_type: s.agent_type ?? null,
    ticket: s.ticket ?? null,
    last_ts: s.last_ts ?? null,
    by_model: s.by_model,
  }));
  return report;
}

function parseArgs(argv) {
  const flags = { dir: '.tyran', session: null, projects: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--dir' || arg === '--session' || arg === '--projects') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      flags[arg.slice(2)] = value;
      i += 1;
    } else throw new UsageError(`unknown argument: ${arg}`);
  }
  return flags;
}

function main(argv) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    console.error(String(err.message ?? err));
    console.error('usage: cost.mjs [--dir <.tyran>] [--session <id>] [--projects <dir>] [--json]');
    return 2;
  }
  const tyranDir = resolve(flags.dir);
  if (!existsSync(tyranDir)) {
    console.error(`cost: no such directory: ${tyranDir}`);
    return 2;
  }
  const report = costReport({ tyranDir, projectsRoot: flags.projects, session: flags.session });
  if (report.transcripts_found === false) {
    console.error(
      'cost: no transcripts found for this repo under the Claude Code projects directory.\n' +
        'Spend is read from the transcripts the platform writes; nothing here estimates it.'
    );
    return 2;
  }
  if (flags.json) {
    const path = join(tyranDir, 'state', COST_FILE);
    writeAtomic(path, costJson(report));
    console.log(path);
  } else {
    process.stdout.write(renderReport(report));
  }
  return 0;
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

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
