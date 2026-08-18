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
 * `supersedes` is the retirement mechanism, and the reason a store that only
 * ever grows is not the only option. An entry named by any other entry's
 * `supersedes` is dropped from every brief — so a merge is an APPEND: write
 * the entry that says it better, name the ones it replaces, and touch nothing
 * else. The replaced entries keep their bytes, their provenance and the
 * counters they earned over months, which is what makes a bad merge cost one
 * `git rm` instead of a history. Nothing in this file decides WHICH entries
 * say the same thing; that is a judgement, and it stays the retro's.
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
import { validateFile, globMatches, normalizePath, supersededIds, KNOWLEDGE_KINDS } from './schema.mjs';
import { escapeInvisible, jsonEscapeInvisible } from './invisible.mjs';
import { wantsHelp } from './cli-args.mjs';

export const DEFAULT_DIR = join('.tyran', 'knowledge');
export const DEFAULT_BUDGET = 4000;

/**
 * How many deliveries an entry gets before "never reported helpful" is
 * evidence rather than absence of it.
 *
 * Deliberately NOT `mistakes.mjs`'s `KNOWLEDGE_THRESHOLD`, which is also 3:
 * that one counts occurrences of a failure before a rule is earned, this one
 * counts deliveries before silence is damning. Two numbers that happen to
 * agree are not one constant, and importing it would mean tuning either
 * changes the other.
 */
export const RETIREMENT_THRESHOLD = 3;

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
  // Ids are unique per FILE by the validator, which sees one document at a
  // time. Only this loop ever sees the whole store, so a `K-12` in two files
  // is a collision nothing else can catch — and `supersedes` names an id, so
  // an ambiguous one silently retires whichever entry the loop reached first.
  // Reported through `invalid` rather than a finding code of its own: both
  // callers already refuse loudly on that channel.
  const idOwner = new Map();
  for (const file of knowledgeFiles(dir)) {
    const result = validateFile('knowledge', file);
    if (!result.ok) {
      invalid.push({ file, errors: result.errors });
      continue;
    }
    const collisions = [];
    for (const entry of result.doc.entries) {
      const first = idOwner.get(entry.id);
      if (first === undefined) idOwner.set(entry.id, file);
      else collisions.push(`duplicate id "${entry.id}" — already defined in ${first}`);
      entries.push({ ...entry, file });
    }
    if (collisions.length > 0) invalid.push({ file, errors: collisions });
  }
  return { entries, invalid };
}

/**
 * The ids no brief may carry: every id named by any entry's `supersedes`.
 *
 * Computed over the WHOLE store, never over a filtered subset. Scoped to the
 * query instead, an entry retired by a narrowly-scoped superseder comes back
 * from the dead on any brief whose paths miss that superseder — the store
 * would then disagree with itself about what is retired, depending on what
 * was asked. One flat set also resolves chains for free: C→A and A→B hides
 * both A and B with no walk.
 */
export function supersededSet(entries) {
  const hidden = new Set();
  for (const entry of entries) {
    for (const id of supersededIds(entry)) hidden.add(id);
  }
  return hidden;
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
  const hidden = supersededSet(entries);
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    // Before the kind and path filters, and computed from the full store —
    // see `supersededSet`. This is what makes a merge non-destructive: the
    // retired entry keeps its bytes and its counters on disk and simply
    // stops being delivered.
    .filter(({ entry }) => !hidden.has(entry.id))
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
 *
 * Every budget figure here counts LIVE entries only. `entries` still counts
 * the whole store, because that is the number a reader can check against the
 * files on disk; `live`/`superseded` is the split. An audit that charged the
 * budget for entries no brief can deliver would under-report reachability
 * exactly as consolidation started to work.
 */
export function auditEntries(entries, { budget = DEFAULT_BUDGET } = {}) {
  const hidden = supersededSet(entries);
  const present = new Set(entries.map((e) => e.id));
  const sized = entries.map((entry) => {
    const cost = Array.from(entryLine(entry)).length + 1;
    return {
      id: entry.id,
      kind: entry.kind,
      confidence: entry.confidence,
      cost,
      alone: cost > budget,
      superseded: hidden.has(entry.id),
    };
  });
  // Every measurement against the budget is over LIVE entries only. Charging
  // the budget for entries no brief can deliver would report a reachability
  // that is fiction — and this number is the one `doctor --state` prints.
  const live = sized.filter((e) => !e.superseded);
  const retired = sized.filter((e) => e.superseded);
  // Ranked the way `brief` ranks, so "would reach a brief" means what a brief
  // would actually do rather than what this function finds convenient.
  const ranked = [...live].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  let used = 0;
  let reachable = 0;
  for (const entry of ranked) {
    if (used + entry.cost > budget && reachable > 0) break;
    used += entry.cost;
    reachable += 1;
  }
  const total = live.reduce((sum, e) => sum + e.cost, 0);
  // A `supersedes` naming an id nowhere in the store is the one mechanical
  // way this whole design fails: the typo means the intended retirement did
  // not happen, so the old entry keeps competing and the new one adds to the
  // total. Silent, and in the direction of growth.
  const dangling = [];
  for (const entry of entries) {
    for (const id of supersededIds(entry)) {
      if (!present.has(id)) dangling.push({ id: entry.id, missing: id });
    }
  }
  // A→B and B→A validates (neither supersedes itself) and hides BOTH, which
  // empties two entries out of every brief at once. Named here rather than
  // guarded in the selector.
  const mutual = [];
  for (const entry of entries) {
    for (const id of supersededIds(entry)) {
      const other = entries.find((e) => e.id === id);
      if (other && supersededIds(other).includes(entry.id) && entry.id < id) {
        mutual.push({ a: entry.id, b: id });
      }
    }
  }
  return {
    budget,
    // The whole store, so this still matches the file count on disk.
    entries: sized.length,
    live: live.length,
    superseded: retired.length,
    supersededCost: retired.reduce((sum, e) => sum + e.cost, 0),
    // How many a single widest-possible brief could carry.
    reachable,
    unreachable: live.length - reachable,
    // Entries too large to appear even alone — the ones pruning must address
    // first, because no budget any caller passes will rescue them.
    aloneTooBig: live.filter((e) => e.alone).map((e) => ({ id: e.id, cost: e.cost })),
    danglingSupersedes: dangling,
    mutualSupersedes: mutual,
    ...retirementReport(entries, entries.filter((e) => !hidden.has(e.id))),
    totalCost: total,
    widest: live.slice().sort((a, b) => b.cost - a.cost).slice(0, 5).map((e) => ({ id: e.id, cost: e.cost })),
  };
}

/**
 * Which live entries the COUNTERS have written off — the first thing that
 * ever reads `used`/`helpful`/`outdated_reports`.
 *
 * Three surfaces already tell an agent to retire entries on this evidence
 * (`agents/retro.md`, `skills/retro/SKILL.md`, and the audit's own trailing
 * line), and nothing computed it. Same defect class as the consolidation
 * promise corrected in 0.1.35, one field over.
 *
 * The degenerate case decides whether any of it means anything. The counters
 * are maintained only by a model hand-editing YAML at retro close; if that
 * fold is not happening every entry reads `helpful: 0` and the rule below
 * would flag the entire store — confidently, and on no evidence at all. So a
 * store with no counter evidence reports THAT and flags nothing: it is the
 * more useful finding, and it is the true one.
 */
export function retirementReport(all, live, { threshold = RETIREMENT_THRESHOLD } = {}) {
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  // Evidence is asked of the WHOLE store, candidates only of the live part.
  // Scoped to live alone, consolidating a counter-bearing entry away would
  // flip this to "the fold is not happening" — a strong claim, and false:
  // the fold plainly did happen, the entry it happened to is just retired
  // now. The question this answers is whether the repo folds at all.
  const hasEvidence = all.some(
    (e) => n(e.used) > 0 || n(e.helpful) > 0 || n(e.outdated_reports) > 0,
  );
  if (!hasEvidence) return { counterEvidence: false, retirementCandidates: [] };
  const candidates = [];
  for (const entry of live) {
    const used = n(entry.used);
    const helpful = n(entry.helpful);
    const wrong = n(entry.outdated_reports);
    // Reported wrong more often than it helped: the strongest evidence there
    // is, and the remedy may be to correct it rather than retire it.
    if (wrong > helpful) {
      candidates.push({ id: entry.id, reason: 'reported-wrong', used, helpful, outdated_reports: wrong });
      continue;
    }
    // Delivered enough times to have had its chance, and never once helped.
    // The threshold is the whole point: `used: 1, helpful: 0` is an entry
    // nobody has had the opportunity to find useful, which is not evidence
    // of anything.
    if (used >= threshold && helpful === 0) {
      candidates.push({ id: entry.id, reason: 'never-helpful', used, helpful, outdated_reports: wrong });
    }
  }
  return { counterEvidence: true, retirementCandidates: candidates };
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
  if (wantsHelp(process.argv.slice(2))) {
    console.log(usage);
    return;
  }
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
      `  ${report.entries} entries on disk, ${report.live} live, ${report.totalCost} codepoints total`,
      `  ${report.reachable} could reach one brief at the ${report.budget}-codepoint budget; ` +
        `${report.unreachable} could not`,
    ];
    if (report.superseded > 0) {
      // The whole prune feature, as a line of output. Once an entry is
      // invisible to briefs, deleting it has provably zero behavioural
      // effect — so a prune SUBCOMMAND would be building the destructive
      // operation this design exists to avoid, to save one `git rm`.
      out.push(
        `  ${report.superseded} superseded (${report.supersededCost} codepoints) — retired from every ` +
          'brief, still on disk with their counters; delete them whenever you like',
      );
    }
    if (report.danglingSupersedes.length > 0) {
      out.push('  supersedes naming an id that is not in this store — the retirement did NOT happen:');
      for (const d of report.danglingSupersedes) {
        out.push(`    ${escapeInvisible(d.id)} -> ${escapeInvisible(d.missing)}`);
      }
    }
    if (report.mutualSupersedes.length > 0) {
      out.push('  mutually superseding pairs — BOTH are hidden from every brief:');
      for (const m of report.mutualSupersedes) {
        out.push(`    ${escapeInvisible(m.a)} <-> ${escapeInvisible(m.b)}`);
      }
    }
    if (!report.counterEvidence) {
      out.push(
        '  no entry carries counter evidence — the fold at retro close is not happening,',
      );
      out.push(
        '  so nothing here can be retired on evidence yet (see skills/retro/SKILL.md)',
      );
    } else if (report.retirementCandidates.length > 0) {
      out.push('  retirement candidates, on the counters rather than on taste:');
      for (const c of report.retirementCandidates) {
        const why = c.reason === 'reported-wrong'
          ? `reported wrong ${c.outdated_reports}x against ${c.helpful} helpful`
          : `delivered ${c.used}x, never once reported helpful`;
        out.push(`    ${escapeInvisible(c.id)} — ${why}`);
      }
    }
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
    // hard-won detail this exists to protect. That has not changed — nothing
    // below scores similarity or picks a winner.
    //
    // What HAS changed is that the merge now has a mechanism to be performed
    // WITH. These lines named a consolidation step that did not exist until
    // 0.1.35 corrected them; they may name one again only because
    // `selectEntries` genuinely suppresses a superseded id, which the guard
    // test in tests/unit/knowledge.test.mjs now checks by running a brief
    // rather than by grepping for an export name.
    //
    // The shape is what makes it safe to state plainly: consolidation APPENDS
    // an entry naming the ones it replaces. No existing file is edited, the
    // retired entries keep their counters, and the undo is deleting one file.
    out.push('  This reports; it never edits. Consolidation is a /tyran:retro judgement, performed by');
    out.push('  APPENDING an entry whose supersedes: names the ones it replaces — the originals keep');
    out.push('  their bytes and counters, and deleting that one file brings them all back.');
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
