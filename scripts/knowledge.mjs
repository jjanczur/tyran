#!/usr/bin/env node
/**
 * knowledge — the READER for `.tyran/knowledge/`.
 *
 * The knowledge store had a writer (the retrospective) and a schema, and no
 * reader: nothing put a learned fact in front of the agent about to need it,
 * so the loop was write-only and the file grew without pressure. Measured on
 * a real install: 137 KB, 31 entries, and the largest single entry 13 KB —
 * nothing that size can be pasted into a handoff, so in practice nothing was.
 *
 * `brief` closes the loop: select the entries whose `applies_to` globs
 * intersect the paths a story is about to touch (`ticket.created`'s
 * `files_predicted` is the intended source), rank by confidence, cut to a
 * character budget, and print a Markdown block ready to paste VERBATIM into a
 * handoff. Entry ids are part of the output on purpose — the agent's report
 * owes a verdict on them (helped / wrong / unused), which is what the
 * retrospective folds into the `used`/`helpful`/`outdated_reports` counters.
 *
 * The budget is the design, not a safety valve: it is the pressure that keeps
 * entries scoped. An entry with `applies_to: ['**']` and a page of prose
 * crowds out eight useful ones, VISIBLY — and the omission line names the
 * cost. Omission is never silent.
 *
 * Selection is symmetric on purpose: `applies_to` holds globs and the inputs
 * are often globs too (`files_predicted` may say `src/lib/**`), so an entry
 * matches when either side's glob matches the other side as a literal. One
 * line of generosity instead of a second glob engine.
 *
 * CLI:
 *   node knowledge.mjs brief [<path>...] [--dir .tyran/knowledge]
 *        [--kinds fact,convention,gotcha,command,decision]
 *        [--limit N] [--budget CHARS] [--json]
 * Exit: 0 briefed (including "no matches") · 1 invalid knowledge file · 2 usage/IO
 */
import { existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFile, globMatches, normalizePath, KNOWLEDGE_KINDS } from './schema.mjs';
import { escapeInvisible, jsonEscapeInvisible } from './invisible.mjs';

export const DEFAULT_DIR = join('.tyran', 'knowledge');
export const DEFAULT_BUDGET = 4000;

class UsageError extends Error {}

/** Untrusted YAML value on its way into a terminal or a handoff: one line, visible. */
function clean(value) {
  return escapeInvisible(String(value)).replace(/\s+/g, ' ').trim();
}

/** The knowledge files of a directory, sorted for determinism. */
export function knowledgeFiles(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * Load every entry of every knowledge file, or report the files that fail
 * validation. Returns `{entries, invalid}` where `invalid` is
 * `[{file, errors}]` — an invalid file is a LOUD result, never a silent skip:
 * a brief that quietly dropped a file would read as "nothing to know".
 */
export function loadEntries(dir) {
  const entries = [];
  const invalid = [];
  for (const file of knowledgeFiles(dir)) {
    const result = validateFile('knowledge', file);
    if (!result.ok) {
      invalid.push({ file, errors: result.errors });
      continue;
    }
    for (const entry of result.doc.entries) entries.push({ ...entry, file });
  }
  return { entries, invalid };
}

/** Does this entry apply to any of the given repo paths? */
export function entryMatches(entry, paths) {
  const globs = Array.isArray(entry.applies_to) ? entry.applies_to.filter((g) => typeof g === 'string') : [];
  if (globs.length === 0) return true; // no applies_to = repo-global by schema
  return globs.some((glob) => paths.some((path) => globMatches(glob, path) || globMatches(path, glob)));
}

/**
 * Select and rank: kind filter, path intersection, confidence descending with
 * file order breaking ties. No clock and no randomness — the same store and
 * the same paths produce the same brief, byte for byte.
 */
export function selectEntries(entries, { paths = [], kinds = null, limit = Infinity } = {}) {
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => kinds === null || kinds.includes(entry.kind))
    .filter(({ entry }) => (paths.length === 0 ? !Array.isArray(entry.applies_to) || entry.applies_to.length === 0 : entryMatches(entry, paths)))
    .sort((a, b) => (b.entry.confidence - a.entry.confidence) || (a.index - b.index))
    .map(({ entry }) => entry);
  const selected = ranked.slice(0, Math.max(0, limit));
  return { selected, matched: ranked.length, limited: ranked.length - selected.length };
}

function entryLine(entry) {
  const applies = Array.isArray(entry.applies_to) && entry.applies_to.length > 0
    ? ` _(applies to: ${entry.applies_to.map(clean).join(', ')})_`
    : '';
  return `- **[${clean(entry.id)}]** (${clean(entry.kind)}, ${entry.confidence}) ${clean(entry.text)}${applies}`;
}

/**
 * The paste-ready Markdown block. Entries are cut at `budget` characters;
 * anything cut — by budget or by `--limit` — is counted in an explicit
 * trailing line. `matched` is the pre-limit match count.
 */
export function renderBrief(selected, matched, { budget = DEFAULT_BUDGET, dir = DEFAULT_DIR, limited = 0 } = {}) {
  if (matched === 0) return `### Knowledge brief (${clean(dir)}) — no matching entries\n`;
  const lines = [];
  let used = 0;
  let kept = 0;
  for (const entry of selected) {
    const line = entryLine(entry);
    // Budget is charged in CODEPOINTS, the same unit knowledgeWarnings
    // measures entries in — an oversize warning that predicted a different
    // quantity than the budget spends would under-measure exactly the thing
    // it exists to predict.
    const cost = Array.from(line).length + 1;
    if (used + cost > budget && kept > 0) break;
    lines.push(line);
    used += cost;
    kept += 1;
  }
  const header = `### Knowledge brief (${clean(dir)}, ${kept} of ${matched} entr${matched === 1 ? 'y' : 'ies'})`;
  const byBudget = selected.length - kept;
  const parts = [];
  // Each cut names its own remedy — an omission line telling the reader to
  // raise a budget that did not do the cutting is a remedy that cannot work.
  if (limited > 0) parts.push(`${limited} by --limit`);
  if (byBudget > 0) parts.push(`${byBudget} by the ${budget}-codepoint budget`);
  const omitted = matched - kept;
  const tail = omitted > 0
    ? [`_${omitted} matching entr${omitted === 1 ? 'y' : 'ies'} omitted (${parts.join(', ')}) — ${limited > 0 ? 'raise --limit' : 'raise --budget'} or narrow the paths._`]
    : [];
  return [header, ...lines, ...tail].join('\n') + '\n';
}

/**
 * Which entries can never reach a handoff, and why.
 *
 * The budget is deliberately the pressure that keeps entries scoped, and the
 * omission line names the cost of every individual brief. What nothing did
 * was AGGREGATE that: measured on a real install, `brief '**'` returned **1
 * of 31 entries** and the other thirty were dropped by the 4000-codepoint
 * budget. Ninety kilobytes of measured detail — migration-number races,
 * TEST/PROD schema drift — accumulated for months and reached nobody.
 *
 * That is the opposite of the failure people expect. The store is not
 * expensive to read; it is unread, while growing without bound, and the
 * pressure the budget applies lands on nothing because no one is looking at
 * the total.
 *
 * So this reports the whole store against the budget at once. It is a
 * MEASUREMENT, never an edit: pruning needs judgement about which of two
 * overlapping entries is the true one, and a script that guessed would delete
 * exactly the hard-won detail this exists to protect.
 *
 * `alone` is the diagnostic that matters most: an entry that does not fit the
 * budget even as the ONLY entry can never appear in any brief, under any
 * paths, ever. It is not competing for space — it is unreachable.
 */
export function auditEntries(entries, { budget = DEFAULT_BUDGET } = {}) {
  const sized = entries.map((entry) => {
    const cost = Array.from(entryLine(entry)).length + 1;
    return { id: entry.id, kind: entry.kind, confidence: entry.confidence, cost, alone: cost > budget };
  });
  // Ranked the way `brief` ranks, so "would reach a brief" means what a brief
  // would actually do rather than what this function finds convenient.
  const ranked = [...sized].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  let used = 0;
  let reachable = 0;
  for (const entry of ranked) {
    if (used + entry.cost > budget && reachable > 0) break;
    used += entry.cost;
    reachable += 1;
  }
  const total = sized.reduce((sum, e) => sum + e.cost, 0);
  return {
    budget,
    entries: sized.length,
    // How many a single widest-possible brief could carry.
    reachable,
    unreachable: sized.length - reachable,
    // Entries too large to appear even alone — the ones pruning must address
    // first, because no budget any caller passes will rescue them.
    aloneTooBig: sized.filter((e) => e.alone).map((e) => ({ id: e.id, cost: e.cost })),
    totalCost: total,
    widest: sized.slice().sort((a, b) => b.cost - a.cost).slice(0, 5).map((e) => ({ id: e.id, cost: e.cost })),
  };
}

// ---------------------------------------------------------------- CLI

const VALUE_FLAGS = ['dir', 'kinds', 'limit', 'budget'];
const BOOLEAN_FLAGS = ['json'];

function parseArgs(argv) {
  const flags = { dir: DEFAULT_DIR, kinds: null, limit: Infinity, budget: DEFAULT_BUDGET, json: false };
  const paths = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      paths.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.includes(name)) {
      flags[name] = true;
    } else if (VALUE_FLAGS.includes(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`flag --${name} needs a value`);
      }
      flags[name] = value;
      i += 1;
    } else {
      throw new UsageError(`unknown flag --${name}`);
    }
  }
  if (flags.kinds !== null) {
    flags.kinds = String(flags.kinds).split(',').map((k) => k.trim()).filter((k) => k !== '');
    const bad = flags.kinds.filter((k) => !KNOWLEDGE_KINDS.includes(k));
    if (bad.length > 0) {
      throw new UsageError(`unknown kind(s) ${bad.join(', ')} — valid: ${KNOWLEDGE_KINDS.join(' | ')}`);
    }
  }
  for (const numeric of ['limit', 'budget']) {
    if (typeof flags[numeric] === 'string') {
      const n = Number(flags[numeric]);
      if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${numeric} must be a positive number`);
      flags[numeric] = n;
    }
  }
  return { flags, paths };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const usage =
    'usage: knowledge.mjs brief [<path>...] [--dir <knowledge-dir>] [--kinds k,k] [--limit N] [--budget CHARS] [--json]\n' +
    '       knowledge.mjs audit [--dir <knowledge-dir>] [--budget CHARS] [--json]';
  if (command !== 'brief' && command !== 'audit') {
    console.error(usage);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = parseArgs(rest);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`knowledge: ${error.message}`);
    console.error(usage);
    process.exit(2);
  }
  const { flags, paths } = parsed;
  const dir = resolve(flags.dir);
  if (!existsSync(dir)) {
    console.log(`### Knowledge brief — no knowledge directory at ${escapeInvisible(flags.dir)}\n`);
    process.exitCode = 0;
    return;
  }
  if (!statSync(dir).isDirectory()) {
    // Absence is a fact worth an explicit line; a FILE where a directory
    // belongs is a mistake, and exit 0 here would let an automated handoff
    // silently carry an empty brief that claims the store was consulted.
    console.error(`knowledge: --dir ${escapeInvisible(flags.dir)} is not a directory`);
    process.exitCode = 2;
    return;
  }

  const normalized = paths.map((p) => normalizePath(p) ?? p);
  const { entries, invalid } = loadEntries(dir);
  if (invalid.length > 0) {
    for (const { file, errors } of invalid) {
      console.error(`knowledge: INVALID ${escapeInvisible(file)}`);
      for (const e of errors) console.error(`  - ${escapeInvisible(String(e))}`);
    }
    console.error('knowledge: refusing to brief from a store that does not validate — a partial brief reads as a complete one');
    process.exitCode = 1;
    return;
  }

  if (command === 'audit') {
    const report = auditEntries(entries, { budget: flags.budget });
    if (flags.json) {
      console.log(jsonEscapeInvisible(JSON.stringify(report, null, 2)));
      process.exitCode = 0;
      return;
    }
    const out = [
      `knowledge audit (${escapeInvisible(flags.dir)})`,
      `  ${report.entries} entries, ${report.totalCost} codepoints total`,
      `  ${report.reachable} could reach one brief at the ${report.budget}-codepoint budget; ` +
        `${report.unreachable} could not`,
    ];
    if (report.aloneTooBig.length > 0) {
      const n = report.aloneTooBig.length;
      out.push(`  ${n} entr${n === 1 ? 'y' : 'ies'} cannot appear in ANY brief, even alone:`);
      for (const e of report.aloneTooBig) out.push(`    ${escapeInvisible(e.id)} — ${e.cost} codepoints`);
    }
    if (report.widest.length > 0) {
      out.push('  widest:');
      for (const e of report.widest) out.push(`    ${escapeInvisible(e.id)} — ${e.cost}`);
    }
    // A measurement, never an edit: which of two overlapping entries is the
    // true one is a judgement, and a script that guessed would delete the
    // hard-won detail this exists to protect.
    //
    // This line used to promise that `/tyran:retro` consolidates, writing a
    // new file for review. It does not, and never has: grep the skill and the
    // agent and there is no consolidation step in either. What the retro
    // really does to this store is COUNTER upkeep — folding each report's
    // brief verdicts in, retiring an entry the counters have written off, and
    // splitting one `doctor` calls oversized. Merging two overlapping entries
    // is nobody's job yet. Saying so is the point: a tool that names a
    // downstream step by name is the last place a reader will doubt it.
    out.push('  This reports; it never edits. Nothing merges overlapping entries yet — /tyran:retro');
    out.push('  keeps the counters, retires what stopped earning its keep, and splits what is oversized.');
    process.stdout.write(out.join('\n') + '\n');
    process.exitCode = 0;
    return;
  }

  const { selected, matched, limited } = selectEntries(entries, { paths: normalized, kinds: flags.kinds, limit: flags.limit });
  if (flags.json) {
    const payload = selected.map(({ id, kind, confidence, text, applies_to, file }) => ({
      id, kind, confidence, text, applies_to: applies_to ?? [], file,
    }));
    console.log(jsonEscapeInvisible(JSON.stringify(payload, null, 2)));
    process.exitCode = 0;
    return;
  }
  // exitCode, never process.exit(): exit() does not wait for stdout to
  // drain, and a large brief into a pipe would be TRUNCATED at the exact
  // moment it matters most (a big store, an automated consumer).
  process.stdout.write(renderBrief(selected, matched, { budget: flags.budget, dir: flags.dir, limited }));
  process.exitCode = 0;
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
