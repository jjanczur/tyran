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
 * Exit: 0 healthy (info findings allowed) · 1 findings (error or warning)
 *       · 2 usage / I/O error
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJournal, validateJournal, pairSpawns, tail } from './journal.mjs';
import {
  checkFile,
  inline,
  naturalCompare,
  renderProjections,
  PROGRESS_FILE,
  STATE_FILE,
} from './project.mjs';
import { classifyPath, normalizePath, validateFile, MANDATORY_KERNEL_PATHS } from './schema.mjs';

/** Severity order is also the report order. `info` never fails the check. */
export const SEVERITIES = Object.freeze(['error', 'warning', 'info']);

/** Default: an agent open this long without the journal moving on is stuck. */
export const DEFAULT_STALE_HOURS = 4;

const JOURNAL_FILE = 'journal.jsonl';

class UsageError extends Error {}
class IOError extends Error {}

// --------------------------------------------------------------- helpers

/**
 * POSIX single-quoting for the fix commands. journal.mjs has the identical
 * three lines but does not export them; a printed command that has to be
 * edited before it runs is a command an autonomous caller runs anyway.
 */
function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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

function finding(severity, code, where, message, fix = null) {
  return { severity, code, where, message, fix };
}

/** Explicit, total, stable ordering — determinism is a guarantee here. */
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

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hoursBetween(fromTs, toTs) {
  const from = Date.parse(fromTs);
  const to = Date.parse(toTs);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return (to - from) / 3_600_000;
}

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
 * quietly failing to cover `hooks/x.mjs`. This check closes it: the
 * rule's own wildcards are instantiated with segments of the PROTECTED
 * path, which means the rule matches the candidate by construction (`**`
 * absorbs separators, `*` gets a separator-free segment), so no second glob
 * matcher is needed and no false positive is possible from a mismatch.
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

  if (!existsSync(journalPath)) {
    findings.push(
      finding(
        'warning',
        'journal-missing',
        show(dir),
        `initiative directory with no ${JOURNAL_FILE} — nothing records what happened here`,
        `rm -r ${sq(dir)}   # or restore the journal from git`,
      ),
    );
    return { findings, events: 0 };
  }
  if (isDirectory(journalPath)) {
    findings.push(
      finding('error', 'journal-not-a-file', at, `${JOURNAL_FILE} is a directory, not a file`),
    );
    return { findings, events: 0 };
  }

  let read;
  try {
    read = readJournal(journalPath);
  } catch (err) {
    findings.push(
      finding('error', 'journal-unreadable', at, `cannot read the journal (${err.code ?? err.name}: ${err.message})`),
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
          'error',
          'check-failed',
          at,
          `the "${label}" check could not run on this journal (${err.name}: ${err.message}) — the file holds a ` +
            'shape the readers do not expect, which almost always means it was edited by hand',
          `node scripts/journal.mjs validate ${sq(journalPath)}`,
        ),
      );
    }
  };
  guard('journal integrity', () => journalIntegrity(journalPath, at, read));
  guard('one initiative per file', () => initiativeScope(journalPath, at, name, events));
  guard('open spawns', () => spawnFindings(journalPath, at, name, events, reference, staleHours));
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
        'warning',
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
      finding('error', 'journal-invalid', at, error, `node scripts/journal.mjs validate ${sq(journalPath)}`),
    );
  }
  if (read.truncatedTail) {
    findings.push(
      finding(
        'warning',
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
        'warning',
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
        'warning',
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
        'warning',
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
    findings.push(finding('warning', 'journal-warning', at, show(warning)));
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
        'error',
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
        'error',
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
        'warning',
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

function spawnFindings(journalPath, at, dirName, events, reference, staleHours) {
  const findings = [];
  const { open } = pairSpawns(events);
  for (const agent of sortedNames(open.keys())) {
    for (const spawn of open.get(agent)) {
      const age = reference === null ? null : hoursBetween(spawn.ts, reference);
      const where = `${show(spawn.data.ticket ?? 'no ticket')}, role ${show(spawn.data.role)}`;
      if (age !== null && age >= staleHours) {
        findings.push(
          finding(
            'warning',
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
            'info',
            'spawn-open',
            at,
            `agent "${show(agent)}" is still working (spawned ${show(spawn.ts)}). ${where}`,
          ),
        );
      }
    }
  }
  return findings;
}

const EXPIRY_KEYS = Object.freeze(['expires', 'expires_at', 'until']);

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
            'warning',
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
          'warning',
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
      finding('info', 'lease-open', at, `lease on "${show(lease.resource)}" held by "${show(holder)}"`),
    );
  }

  for (const m of mismatchedReleases) {
    findings.push(
      finding(
        'warning',
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
      finding('error', 'projection-failed', at, `cannot render projections from this journal (${err.name}: ${err.message})`),
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
        'warning',
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

  if (present.length === 0) {
    findings.push(
      finding(
        'info',
        'projection-missing',
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
          'warning',
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
        finding('error', 'projection-unreadable', show(path), `cannot read the projection (${err.code ?? err.name}: ${err.message})`),
      );
      continue;
    }
    if (result.ok) continue;
    findings.push(
      finding(
        'warning',
        'projection-drift',
        show(path),
        `out of sync with the journal: ${result.reason}. It is generated — edits here are lost, and a stale ` +
          'projection is what a human (or an agent reading STATE.md) will believe',
        regenerate,
      ),
    );
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
          'warning',
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
        finding('error', `${label}-unreadable`, show(dir), `cannot list the directory (${err.code ?? err.name}: ${err.message})`),
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
        finding('error', `${kind}-unreadable`, show(path), `cannot read the file (${err.code ?? err.name}: ${err.message})`),
      ],
      doc: null,
    };
  }
  for (const error of result.errors ?? []) {
    const kernelDowngrade = error.includes('falls under the protected path');
    findings.push(
      finding(
        'error',
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
        'warning',
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
        'warning',
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
export function runStateChecks({ dir = '.tyran', now = null, staleHours = DEFAULT_STALE_HOURS } = {}) {
  const root = resolve(dir);
  if (!existsSync(root)) {
    return summarize(dir, [finding('info', 'no-state-dir', show(dir), 'no Tyran state directory here — nothing to check')], [
      `${show(dir)}: absent`,
    ]);
  }
  if (!isDirectory(root)) throw new IOError(`not a directory: ${root}`);

  const repoRoot = dirname(root);
  const findings = [];
  const checked = [];

  const configPath = join(dir, 'config.yaml');
  if (existsSync(configPath)) {
    findings.push(...checkSchemaFile('config', configPath).findings);
    checked.push('config.yaml: checked');
  } else {
    findings.push(
      finding(
        'info',
        'config-missing',
        show(configPath),
        'no config.yaml — Tyran falls back to built-in defaults for this repo',
        `node scripts/schema.mjs validate config ${sq(configPath)}   # after /tyran:setup writes it`,
      ),
    );
    checked.push('config.yaml: absent');
  }

  const knowledge = yamlFilesIn(join(dir, 'knowledge'), 'knowledge');
  findings.push(...knowledge.findings);
  for (const file of knowledge.files) findings.push(...checkSchemaFile('knowledge', file).findings);
  checked.push(`knowledge/: ${knowledge.files.length} file(s)`);

  const policies = yamlFilesIn(join(dir, 'policies'), 'policies');
  findings.push(...policies.findings);
  for (const file of policies.files) findings.push(...policyFindings(file, repoRoot));
  if (policies.files.length === 0 && policies.findings.length === 0) {
    findings.push(
      finding(
        'info',
        'policy-missing',
        show(join(dir, 'policies')),
        'no autonomy policy — the self-improvement boundary (AUTO / GATED / KERNEL) is undefined for this repo',
        `mkdir -p ${sq(join(dir, 'policies'))} && cp templates/policies/autonomy.yaml ${sq(join(dir, 'policies', 'autonomy.yaml'))}`,
      ),
    );
  }
  checked.push(`policies/: ${policies.files.length} file(s)`);

  const stateDir = join(dir, 'state');
  const initiatives = [];
  if (existsSync(stateDir) && !isDirectory(stateDir)) {
    findings.push(finding('error', 'state-not-a-directory', show(stateDir), 'state/ exists but is not a directory'));
  } else if (isDirectory(stateDir)) {
    let names = [];
    try {
      names = readdirSync(stateDir);
    } catch (err) {
      findings.push(
        finding('error', 'state-unreadable', show(stateDir), `cannot list state/ (${err.code ?? err.name}: ${err.message})`),
      );
    }
    for (const name of sortedNames(names)) {
      const path = join(stateDir, name);
      if (!isDirectory(path)) {
        findings.push(
          finding(
            'warning',
            'state-stray-file',
            show(path),
            'stray entry in state/ — every child of state/ is an initiative directory',
          ),
        );
        continue;
      }
      const result = checkInitiative(stateDir, name, { now, staleHours });
      findings.push(...result.findings);
      initiatives.push(`${show(name)} (${result.events} event(s))`);
    }
  }
  checked.push(
    initiatives.length === 0 ? 'state/: no initiatives' : `state/: ${initiatives.join(', ')}`,
  );

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

export function renderText(result) {
  const lines = ['tyran doctor · state', `dir: ${result.dir}`];
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

const BOOLEAN_FLAGS = ['state', 'json'];
const VALUE_FLAGS = ['dir', 'now', 'stale-hours'];

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
  // --state is required rather than assumed: doctor grows --env and --config
  // in a later epic, and a bare `doctor.mjs` that silently means one of them
  // today would silently mean something else then.
  if (flags.state !== true) throw new UsageError();

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
  return { dir: flags.dir ?? '.tyran', json: flags.json === true, now, staleHours, dirGiven: flags.dir !== undefined };
}

function main() {
  try {
    const { dir, json, now, staleHours, dirGiven } = parseArgs(process.argv.slice(2));
    // An explicitly named directory that does not exist is a typo, and a
    // clean bill of health for a path nobody checked is the one output a
    // diagnostic tool must never produce. The DEFAULT `.tyran` being absent
    // is just a repo that has not run /tyran:setup yet.
    if (dirGiven && !existsSync(dir)) throw new IOError(`state directory not found: ${resolve(dir)}`);
    const result = runStateChecks({ dir, now, staleHours });
    process.stdout.write(json ? renderJson(result) : renderText(result));
    if (!result.ok) process.exit(1);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(
        'usage: doctor.mjs --state [--dir <.tyran>] [--json] [--now <iso>] [--stale-hours <n>]\n' +
          '       --state is the only mode today; it is required so that adding --env/--config later\n' +
          '       cannot change what a bare invocation means.',
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
