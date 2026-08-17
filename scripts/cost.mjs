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
 *                 [--transcripts <dir>]...
 * Exit: 0 ok · 2 usage/IO
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { parse } from './yaml-lite.mjs';
import { pricingOf, PRICING_RATE_KEYS } from './schema.mjs';
import { defaultRateCard, RATE_CARD_ID, planOfTier, PLAN_LABELS, SUBSCRIPTION_USD } from './pricing.mjs';
import { jsonEscapeInvisible } from './invisible.mjs';

export const COST_FILE = 'cost.json';

/**
 * The version of BOTH the served report and the per-source scan cache, which
 * share this file. Bump it whenever a field is added to a cached source —
 * `readCache` discards a cache whose schema differs, and that discard is the
 * only thing that makes an added field appear for transcripts that have not
 * changed since the last run.
 *
 * Measured when this was missed: `first_ts` was added, every unchanged
 * transcript kept its cached record with no such field, and the reported span
 * came back as ONE day instead of nineteen — a wrong number, not a missing
 * one, and it would have made a monthly comparison off by a factor of 19.
 *
 * 2: sources carry `first_ts`; counters split `cache_write` by TTL.
 */
export const COST_SCHEMA = 2;

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
  return { requests: 0, input: 0, cache_write: 0, cache_write_1h: 0, cache_read: 0, output: 0 };
}

const COUNTER_KEYS = Object.freeze(['requests', 'input', 'cache_write', 'cache_write_1h', 'cache_read', 'output']);

/** b into a, in place. */
export function addCounters(a, b) {
  for (const key of COUNTER_KEYS) a[key] += b[key] ?? 0;
  return a;
}

/**
 * Total tokens billed, whatever the rate. Requests are not tokens.
 *
 * `cache_write` and `cache_write_1h` are DISJOINT — the 5-minute and 1-hour
 * halves of what the API reports as one `cache_creation_input_tokens` figure.
 * Adding both is correct precisely because neither contains the other; if one
 * were ever made a total, this line would double-count every cached token, and
 * cache writes are the second-largest line in a real session. A test pins the
 * partition against the raw aggregate rather than trusting this comment.
 */
export function tokensOf(counters) {
  return counters.input + counters.cache_write + counters.cache_write_1h + counters.cache_read + counters.output;
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
 * Split one request's cache writes across the two rates they are billed at.
 *
 * `usage.cache_creation_input_tokens` is the TOTAL; `usage.cache_creation`
 * carries the same number split into `ephemeral_5m_input_tokens` and
 * `ephemeral_1h_input_tokens`. Reading both the total and the split would
 * double-count, so this reads the split when it is present and the total
 * otherwise — never both. Verified across 1168 consecutive live records: the
 * two ephemeral fields summed to the aggregate every time, zero exceptions.
 *
 * The distinction is worth the code: a 1-hour write costs 2x base input where
 * a 5-minute write costs 1.25x, so a session that caches for an hour — which
 * is what a long agent run does — is 60% under-billed by the flat reading.
 */
function addCacheWrites(into, usage) {
  const split = field(usage, 'cache_creation');
  if (split !== null && typeof split === 'object') {
    const fiveMin = finiteCount(field(split, 'ephemeral_5m_input_tokens'));
    const oneHour = finiteCount(field(split, 'ephemeral_1h_input_tokens'));
    if (fiveMin > 0 || oneHour > 0) {
      into.cache_write += fiveMin;
      into.cache_write_1h += oneHour;
      return;
    }
  }
  // No split, or a split that is all zeroes while the aggregate is not: fall
  // back to the total and attribute it to the 5-minute rate, which is the
  // platform default TTL and therefore the right guess when nobody said.
  into.cache_write += finiteCount(field(usage, 'cache_creation_input_tokens'));
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
  for (const key of PRICING_RATE_KEYS) total += (counters[key] ?? 0) * rateOf(rates, key);
  return total / 1e6;
}

/**
 * One rate from a table that may predate a rate key.
 *
 * `pricingOf` already defaults `cache_write_1h` to the 5-minute rate, but this
 * function is also handed tables built by hand — by tests, and by any caller
 * using the exported `rollup` directly. A missing rate multiplied into the sum
 * yields NaN, which propagates through every total and renders as an amount
 * that is not a number rather than as a visible gap. Repeating the fallback
 * here costs one line and removes that whole failure mode.
 */
function rateOf(rates, key) {
  const rate = rates[key];
  if (typeof rate === 'number' && Number.isFinite(rate)) return rate;
  return key === 'cache_write_1h' && typeof rates.cache_write === 'number' ? rates.cache_write : 0;
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
export function forEachLine(path, onLine, { maxBytes = Infinity } = {}) {
  const size = statSync(path).size;
  if (size > MAX_TRANSCRIPT_BYTES) {
    throw new UsageError(`cost: transcript larger than ${MAX_TRANSCRIPT_BYTES} bytes: ${path}`);
  }
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  // A StringDecoder rather than buffer.toString(): a multi-byte character
  // straddling a chunk boundary decodes to replacement characters otherwise,
  // and one of the things read out of these files is a repo path compared for
  // equality — a mangled non-ASCII path silently reports "no transcripts".
  const decoder = new StringDecoder('utf8');
  let rest = '';
  let skipped = 0;
  let readBytes = 0;
  // Set when an over-long record was abandoned: everything up to that
  // record's OWN terminating newline still has to be thrown away. Without
  // this, the tail of the discarded record is handed to the caller as if it
  // were a record of its own — and a tail that happens to parse is spend the
  // reader INVENTS. Measured: one 9 MB line ending in a well-formed fragment
  // billed 777 777 tokens against a model that never existed, with the gap
  // counters reading clean.
  let resync = false;
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK_BYTES, null);
      if (read === 0) break;
      readBytes += read;
      rest += decoder.write(buffer.subarray(0, read));
      if (resync) {
        const nl = rest.indexOf('\n');
        if (nl === -1) {
          rest = '';
          if (readBytes >= maxBytes) return skipped;
          continue;
        }
        rest = rest.slice(nl + 1);
        resync = false;
      }
      let at;
      let stop = false;
      while ((at = rest.indexOf('\n')) !== -1) {
        const line = rest.slice(0, at);
        rest = rest.slice(at + 1);
        // A callback that says it is done ends the read. Without this the
        // directory probe reads every candidate file to EOF after it has
        // already matched on line one — 83 ms on a 200 MB transcript, paid
        // per file, per request.
        if (onLine(line) === false) {
          stop = true;
          break;
        }
      }
      if (stop) return skipped;
      if (rest.length > MAX_LINE_BYTES) {
        skipped += 1;
        rest = '';
        resync = true;
      }
      if (readBytes >= maxBytes) return skipped;
    }
    rest += decoder.end();
    // A file ending mid-discard has no tail worth delivering.
    if (rest !== '' && !resync) onLine(rest);
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
    addCacheWrites(into, usage);
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
const dirCache = new Map();

/**
 * How far into a candidate transcript the fallback reads before giving up on
 * it. Every record carries `cwd`, so the answer is on line one.
 *
 * The bound is checked after a whole 1 MiB read, so in practice it stops a
 * miss at one chunk per candidate rather than at this number exactly — which
 * is the point: a miss costs a megabyte per file instead of a whole
 * transcript, across a project directory nobody has ever pruned.
 */
const PROBE_BYTES = 64 * 1024;

export function transcriptDirFor(repoRoot, projectsRoot) {
  const want = resolve(repoRoot);
  // Memoised for the life of the process, negative results included. The
  // board server re-renders per request and refreshes every 30 s; without
  // this, a repo whose slug does not match pays the full scan every time,
  // forever.
  const key = want + '::' + projectsRoot;
  if (dirCache.has(key)) return dirCache.get(key);
  const found = findTranscriptDir(want, projectsRoot);
  // A HIT is cached forever — a project directory does not move. A MISS is
  // not cached at all: the board is the page an operator leaves open
  // overnight, and it is routinely started in a repo whose first session has
  // not run yet. Remembering "no transcripts" for the life of that process
  // would keep the Spend section hidden after the transcripts appear, with
  // nothing on the page saying why.
  if (found !== null) dirCache.set(key, found);
  return found;
}

function findTranscriptDir(want, projectsRoot) {
  const direct = join(projectsRoot, want.split(sep).join('-'));
  if (existsSync(direct)) return direct;
  if (!existsSync(projectsRoot)) return null;
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
        forEachLine(
          join(dir, session),
          (line) => {
            if (line === '' || line.charCodeAt(0) !== 123) return true;
            try {
              if (field(JSON.parse(line), 'cwd') === want) {
                matched = true;
                return false; // stop reading this file
              }
            } catch {
              /* a malformed line is not a reason to reject the directory */
            }
            return true;
          },
          { maxBytes: PROBE_BYTES }
        );
      } catch {
        continue;
      }
      if (matched) return dir;
    }
  }
  return null;
}

/**
 * Where BOTH `transcriptDirFor` heuristics fail: a conductor session started
 * from a working directory OTHER than the repo it operates on — Claude Code
 * Desktop opened in a sibling folder, working the repo through absolute paths
 * and worktrees. The computed slug does not match (it is derived from the
 * conductor's own cwd, not the repo path), and the cwd probe does not match
 * either (every record in that transcript carries the CONDUCTOR's cwd, never
 * the repo's). Measured: a `claude` run once started inside the repo for the
 * trust dialog left a directory the direct lookup matched and stopped at,
 * while ~66 agent transcripts and 2 300 requests sat under the conductor's
 * real project dir with nothing on the board pointing at them.
 *
 * A leading `~` expanded to the home directory — the same narrow rule
 * `main_writable_paths` uses in `config.yaml`, so a transcript dir is written
 * the way an operator already writes every other out-of-repo path in this
 * file.
 */
function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * The parsed `.tyran/config.yaml`, or null when it is absent or will not
 * parse. Shared by every config-driven reader below (pricing, the transcript
 * override) so there is one place that opens and parses the file, not two
 * loaders that quietly drift apart.
 */
function loadConfigDoc(tyranDir) {
  try {
    return parse(readFileSync(join(tyranDir, 'config.yaml'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * `spend.transcript_dirs` out of an ALREADY-PARSED config doc — the middle
 * tier of the transcript-dir precedence (CLI `--transcripts` > this > the
 * derived-slug / cwd-probe fallback above). Operator-written, never
 * scanner-inferred, exactly like `pricing:` and `limits:`: a doc that carries
 * nothing here simply falls through to the fallback, same as an absent block.
 *
 * Takes the parsed doc rather than `tyranDir` so `costReport` can read
 * `config.yaml` once and hand the same doc to this and to `pricingOf` —
 * two readers opening and parsing the same file on every call was the
 * reviewed nit this signature exists to close.
 */
function spendTranscriptDirsOf(doc) {
  const spend = doc !== null && typeof doc === 'object' ? doc.spend : undefined;
  const list =
    spend !== null && typeof spend === 'object' && Array.isArray(spend.transcript_dirs)
      ? spend.transcript_dirs
      : [];
  return list.filter((d) => typeof d === 'string' && d.trim() !== '');
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
      scanned.push({
        ...source,
        mtime_ms: stat.mtimeMs,
        size: stat.size,
        by_model: before.by_model,
        last_ts: before.last_ts ?? null,
        first_ts: before.first_ts ?? null,
        // Carried through the cache too: a damaged transcript stays damaged,
        // and a gap that disappears on the second render is worse than one
        // that was never reported.
        malformed: before.malformed ?? 0,
        skipped_lines: before.skipped_lines ?? 0,
      });
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
      first_ts: result.firstTs,
      malformed: result.malformed,
      skipped_lines: result.skippedLines,
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
  // The shipped list prices, for exactly the model ids these transcripts
  // actually name, with any configured rate laid over the top. Computed here
  // rather than in `costReport` so every caller of `rollup` — including the
  // tests that hand it a literal scan — gets priced output without inventing
  // a rate card first.
  const { models, rate_card: rateCard } = effectiveRateCard(pricing, observedModels(scanned));
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
  let oldestTs = null;
  let malformed = 0;
  let skippedLines = 0;

  for (const source of scanned) {
    malformed += source.malformed ?? 0;
    skippedLines += source.skipped_lines ?? 0;
    if (source.kind === 'agent') agentTranscripts += 1;
    if (source.kind === 'agent' && source.ticket !== null) attributed += 1;
    // The OLDEST record, not just the newest. Without it the report cannot say
    // what period its total covers — and a total that does not name its period
    // cannot honestly be compared against a monthly subscription price.
    if (typeof source.first_ts === 'string' && (oldestTs === null || source.first_ts < oldestTs)) {
      oldestTs = source.first_ts;
    }
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
    // Null whenever the plan cannot be established, and the board renders
    // nothing at all in that case rather than a comparison against a guess.
    subscription: extra.subscription ?? null,
    as_of: newestTs,
    // The window these numbers actually describe. A subscription is billed
    // MONTHLY; a total summed over every transcript on the machine is not a
    // month of anything, and putting the two side by side without saying so
    // invites a comparison that is off by however long the operator has been
    // using the tool. Named, not implied.
    covers: spanOf(oldestTs, newestTs),
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
      // Records the reader saw and could not use. These were counted from the
      // first version and then dropped on the floor between the scanner and
      // the report — which made every failure mode of a half-written
      // transcript invisible, in the one feature whose stated property is
      // that gaps are reported rather than zeroed. A live conductor's own
      // file is appended to WHILE it is read, so a truncated tail is the
      // normal case, not an exotic one.
      malformed,
      skipped_lines: skippedLines,
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
      report.composition.map((c) => [compositionLabel(c.kind), tokens(c.tokens), money(c.usd)])
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
  if ((c.malformed ?? 0) > 0 || (c.skipped_lines ?? 0) > 0) {
    out.push(
      `Records this reader could not use: ${c.malformed ?? 0} unparseable, ${c.skipped_lines ?? 0} over the line cap. ` +
        'Their tokens are missing from every number above — a transcript being appended to while it is read ends in a partial record.'
    );
  }
  out.push(
    `Conductor overhead: ${report.totals.conductor_token_share}% of tokens — not attributable to any ticket.`
  );
  if (report.unpriced.length > 0) {
    out.push(`Unpriced models (counted in tokens, absent from every amount): ${report.unpriced.join(', ')}`);
  }
  if ((report.transcript_dirs_missing ?? []).length > 0) {
    const noun = report.transcript_dirs_missing.length === 1 ? 'directory' : 'directories';
    out.push(`Given transcript ${noun} not found: ${report.transcript_dirs_missing.join(', ')}`);
  }
  return out.join('\n') + '\n';
}

/** The sidecar bytes: invisibles escaped, never removed, exactly like board.json. */
export function costJson(report) {
  return jsonEscapeInvisible(JSON.stringify(report, null, 2)) + '\n';
}

/* ---------------------------------- CLI ---------------------------------- */

/**
 * The rate card out of an ALREADY-PARSED config doc — see `spendTranscriptDirsOf`
 * for why this takes a doc instead of `tyranDir` and reading the file itself.
 * A config that will not parse is doctor's problem to report, not this
 * reader's problem to refuse over: tokens are still worth counting.
 * `pricingOf(null)` already reads as "no pricing block" (see schema.mjs), so
 * an absent/unparseable doc needs no separate branch here.
 */
function pricingOfDoc(doc) {
  return pricingOf(doc ?? {});
}

/**
 * The configured rate card laid over the shipped one.
 *
 * Before this, `pricing:` was hand-authored or absent, and absent was the
 * normal case — a fresh install rendered every amount as an em dash, so the
 * Spend tab could say how many tokens and never how much. Nobody was going to
 * transcribe fourteen models × four rates into YAML, least of all the
 * non-technical operators this is now for.
 *
 * Precedence is one-directional and per MODEL, not all-or-nothing: an operator
 * who prices one model at a negotiated rate keeps the shipped numbers for the
 * rest, rather than losing every other amount as the price of overriding one.
 * The label follows whoever supplied the models — an amount computed from list
 * prices must not claim to come from someone's private card.
 */
/** Where Claude Code stores the account it is signed in as. */
export const CLAUDE_CONFIG_RELPATH = '.claude.json';

/**
 * The subscription this machine is signed in on, or null when it cannot be
 * established. Never throws — every figure on the Spend tab must survive an
 * absent, unreadable or reshaped config.
 *
 * WHY THIS IS WORTH READING AT ALL: the API-equivalent total is a number with
 * nothing to compare it against. A subscriber's marginal cost per token is
 * zero, so "this cost $1,379" is true of the API and false of their bank
 * account, and a dashboard that shows only the first number is inviting
 * exactly the wrong conclusion. The plan is what turns it into a comparison.
 *
 * ONLY the rate-limit tier is read. That file also holds the account uuid, the
 * email address and the organization id, and none of them are touched, copied
 * into the report, or logged — a spend tile is not a reason to move identity
 * around.
 */
export function subscriptionOf({ home = homedir(), readFile = readFileSync } = {}) {
  let tier = null;
  try {
    const doc = JSON.parse(readFile(join(home, CLAUDE_CONFIG_RELPATH), 'utf8'));
    const account = doc !== null && typeof doc === 'object' ? doc.oauthAccount : null;
    if (account !== null && typeof account === 'object') tier = account.organizationRateLimitTier ?? null;
  } catch {
    // Not signed in, no config, unreadable, or not JSON. All the same answer.
    return null;
  }
  const plan = planOfTier(tier);
  if (plan === null) return null;
  return { plan, label: PLAN_LABELS[plan], monthly_usd: SUBSCRIPTION_USD[plan] };
}

/**
 * A rate key as a person would read it.
 *
 * Not `key.replace('_', ' ')`: that replaces only the FIRST underscore, so
 * `cache_write_1h` renders as "cache write_1h" — visibly a variable name that
 * escaped. The two cache-write rows also have to be distinguishable at a
 * glance, since the whole reason they are separate is that one costs 60% more.
 */
export function compositionLabel(kind) {
  if (kind === 'cache_write') return 'cache write (5 min)';
  if (kind === 'cache_write_1h') return 'cache write (1 hour)';
  return kind.replace(/_/g, ' ');
}

/**
 * The period a report covers: `{ from, to, days }`, or null when there are no
 * timestamps to measure it from.
 *
 * `days` is inclusive of both ends and never below 1 — an hour of work is one
 * day of usage, not zero, and a zero would produce a division by zero the one
 * time someone normalises this to a monthly rate.
 */
export function spanOf(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { from, to, days: Math.max(1, Math.round((end - start) / 86_400_000)) };
}

/** Every model id these scanned transcripts name, in no particular order. */
function observedModels(scanned) {
  const ids = new Set();
  for (const source of scanned) {
    for (const id of Object.keys(source.by_model ?? {})) ids.add(id);
  }
  return ids;
}

export function effectiveRateCard(pricing, modelIds) {
  const shipped = defaultRateCard(modelIds);
  const models = Object.create(null);
  for (const [id, rates] of Object.entries(shipped)) models[id] = rates;
  let overridden = 0;
  for (const [id, rates] of Object.entries(pricing.models)) {
    if (Object.prototype.hasOwnProperty.call(models, id)) overridden += 1;
    models[id] = rates;
  }
  const configured = Object.keys(pricing.models).length > 0;
  return {
    models,
    // A config's own label wins whenever it named one. Otherwise: the shipped
    // id, marked when a config has partly overridden it, so a reader can tell
    // a pure list-price figure from a mixed one.
    rate_card: pricing.rate_card ?? (configured ? `${RATE_CARD_ID}+config` : RATE_CARD_ID),
    overridden,
  };
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
  // The temp name carries the pid: two writers sharing one fixed `.tmp` can
  // rename a half-written file over the real one, and the board server and a
  // hand-run CLI are exactly two writers.
  const tmp = path + '.' + String(process.pid) + '.tmp';
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * The scan-and-persist tail shared by every path through `costReport`: fold
 * `sources` against the on-disk cache, roll it up, attach the fields callers
 * read straight off the report, and write the sidecar. One function so the
 * caching contract — persisted here, not only in the `--json` branch, so the
 * served board benefits too — cannot drift between the derived-dir path and
 * the explicit-dirs path below.
 */
function finishReport({ sources, pricing, tyranDir, session, transcriptDirsUsed, transcriptDirsMissing }) {
  const cachePath = join(tyranDir, 'state', COST_FILE);
  const { scanned, unreadable, reused } = scanAll(sources, readCache(cachePath));
  const report = rollup(scanned, pricing, { unreadable, reused, subscription: subscriptionOf() });
  report.transcripts_found = true;
  report.transcript_dirs = transcriptDirsUsed;
  report.transcript_dirs_missing = transcriptDirsMissing;
  report.session = session;
  report.sources = scanned.map((s) => ({
    path: s.path,
    kind: s.kind,
    mtime_ms: s.mtime_ms,
    size: s.size,
    agent_type: s.agent_type ?? null,
    ticket: s.ticket ?? null,
    last_ts: s.last_ts ?? null,
    // This projection is a WHITELIST, so a field added to the scan and not
    // added here is computed, cached as absent, and read back as null on
    // every subsequent run — which is how the reported span came back as one
    // day instead of nineteen.
    first_ts: s.first_ts ?? null,
    malformed: s.malformed ?? 0,
    skipped_lines: s.skipped_lines ?? 0,
    by_model: s.by_model,
  }));
  // Persisting is the whole point of the cache, and it has to happen HERE
  // rather than only in the `--json` branch: the board server calls this per
  // request and refreshes every 30 s, so a cache only the CLI ever wrote left
  // the served page re-reading every transcript forever — measured at 1.15 s
  // per request, with `reused_from_cache` stuck at zero. A filtered run is
  // never persisted: it would poison the full report with a partial one.
  // `cache_written` is reported rather than swallowed. For the SERVED page a
  // failed write is only a slow report, but `--json`'s entire contract is
  // "the sidecar now exists, here is its path" — printing that path over a
  // file that was never written, and exiting 0, turns a permission error into
  // a downstream failure with a healthy-looking upstream.
  report.cache_written = false;
  if (session === null) {
    // Set BEFORE serialising, so the field is true of the file that ends up
    // on disk. Setting it afterwards left every persisted copy reading
    // `false` on a cache that had written perfectly well — a diagnostic that
    // lies to whoever opens the file.
    report.cache_written = true;
    try {
      writeAtomic(cachePath, costJson(report));
    } catch (err) {
      report.cache_written = false;
      report.cache_error = String(err?.message ?? err);
    }
  }
  return report;
}

/**
 * Build the report for a repo. Exported so the board server reuses it.
 *
 * `transcriptDirs` is the explicit override — the fix for a conductor that
 * ran from a working directory other than the repo it operates on (see the
 * comment above `expandHome`). Precedence, highest first: the `transcriptDirs`
 * this caller passed in (the CLI's repeatable `--transcripts`) · `.tyran/
 * config.yaml`'s `spend.transcript_dirs` · the derived-slug / cwd-probe
 * fallback `transcriptDirFor` already does. Reading the config tier HERE
 * rather than in every caller is what lets `board.mjs --serve` honour
 * `spend:` with no `--transcripts` flag at all — one precedence order, read
 * once, for both the CLI and the served page.
 *
 * A dir that does not exist is never silently dropped: it is reported in
 * `transcript_dirs_missing` on the returned report, and if EVERY given dir is
 * missing the report reads exactly like "no transcripts found" — gaps are
 * reported, never zeroed (property 3 above).
 */
export function costReport({ tyranDir, projectsRoot, session = null, repoRoot = null, transcriptDirs = [] } = {}) {
  const root = repoRoot ?? resolve(tyranDir, '..');
  // Read ONCE and handed to both readers below: `pricingOfDoc` and
  // `spendTranscriptDirsOf` used to each open and parse config.yaml
  // themselves, which meant every `costReport` call — including the ones
  // `board.mjs --serve` makes per request — read the same file twice.
  const configDoc = loadConfigDoc(tyranDir);
  const pricing = pricingOfDoc(configDoc);

  const given = transcriptDirs.length > 0 ? transcriptDirs : spendTranscriptDirsOf(configDoc);
  // De-duplicated: two spellings of the same directory (a repeated flag, or a
  // flag that repeats what the config already says) must not double-count
  // every transcript under it.
  const explicit = [...new Set(given.map((d) => resolve(expandHome(d))))];

  if (explicit.length > 0) {
    const present = explicit.filter((d) => existsSync(d));
    const missing = explicit.filter((d) => !existsSync(d));
    if (present.length === 0) {
      const empty = rollup([], pricing, { subscription: subscriptionOf() });
      empty.transcripts_found = false;
      empty.transcript_dirs = [];
      empty.transcript_dirs_missing = missing;
      return empty;
    }
    const sources = present.flatMap((dir) => listSources(dir, session));
    return finishReport({
      sources,
      pricing,
      tyranDir,
      session,
      transcriptDirsUsed: present,
      transcriptDirsMissing: missing,
    });
  }

  const dir = transcriptDirFor(root, projectsRoot ?? join(homedir(), '.claude', 'projects'));
  if (dir === null) {
    const empty = rollup([], pricing, { subscription: subscriptionOf() });
    empty.transcripts_found = false;
    empty.transcript_dirs = [];
    empty.transcript_dirs_missing = [];
    return empty;
  }
  return finishReport({
    sources: listSources(dir, session),
    pricing,
    tyranDir,
    session,
    transcriptDirsUsed: [dir],
    transcriptDirsMissing: [],
  });
}

function parseArgs(argv) {
  const flags = { dir: '.tyran', session: null, projects: null, json: false, transcripts: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--transcripts') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      // Repeatable: sources are the union over every directory given.
      flags.transcripts.push(value);
      i += 1;
    } else if (arg === '--dir' || arg === '--session' || arg === '--projects') {
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
    console.error(
      'usage: cost.mjs [--dir <.tyran>] [--session <id>] [--projects <dir>] ' +
        '[--transcripts <dir>]... [--json]'
    );
    return 2;
  }
  const tyranDir = resolve(flags.dir);
  if (!existsSync(tyranDir)) {
    console.error(`cost: no such directory: ${tyranDir}`);
    return 2;
  }
  const report = costReport({
    tyranDir,
    projectsRoot: flags.projects,
    session: flags.session,
    transcriptDirs: flags.transcripts,
  });
  if (report.transcripts_found === false) {
    // Two different gaps, two different sentences: a `--transcripts` (or
    // `spend.transcript_dirs`) dir that does not exist is an operator typo,
    // not the same "nothing to find" as the derived directory being absent.
    if ((report.transcript_dirs_missing ?? []).length > 0) {
      console.error(
        'cost: none of the given transcript directories exist:\n' +
          report.transcript_dirs_missing.map((d) => `  - ${d}`).join('\n')
      );
    } else {
      console.error(
        'cost: no transcripts found for this repo under the Claude Code projects directory.\n' +
          'Spend is read from the transcripts the platform writes; nothing here estimates it.'
      );
    }
    return 2;
  }
  if (flags.json) {
    // Refused rather than written: the sidecar is what the board reads, and a
    // one-session file carrying `totals: 0` would overwrite the full report
    // with a measurement that looks complete and is not.
    if (flags.session !== null) {
      console.error('cost: --session cannot be combined with --json — the sidecar must cover every session.');
      return 2;
    }
    if (report.cache_written !== true) {
      console.error(`cost: could not write the sidecar: ${report.cache_error ?? 'unknown error'}`);
      return 2;
    }
    console.log(join(tyranDir, 'state', COST_FILE));
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
