#!/usr/bin/env node
/**
 * session-start — the probe that hands a resumed session its own state back.
 *
 * A conductor who reopens a repo two days later has no memory of it, and the
 * state that would tell them is spread across a journal, two projections, a
 * doctor run and a lock directory. This injects the two-kilobyte version:
 * where we are, what to do next, what is still open, and who is still
 * holding what.
 *
 * It is a PROBE, not a gate, and the distinction is enforced in the runtime
 * rather than in this comment: `SessionStart` has no way to refuse anything
 * (ADR-22), so nothing here may be a check. Every failure — no state, an
 * unreadable journal, a doctor that will not run — degrades to a shorter
 * message or to nothing at all, and the session starts anyway. Costing a
 * user their session to report that a summary was unavailable would be a
 * worse bug than the missing summary.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJournal } from '../../scripts/journal.mjs';
import { fold, progressLine } from '../../scripts/project.mjs';
import { field, main, runProbe } from './hook-io.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCTOR = resolve(HERE, '..', '..', 'scripts', 'doctor.mjs');

/**
 * This probe's own budget, deliberately far below the `timeout` its
 * hooks.json entry declares (ADR-22 point 2). A unit test reads both numbers
 * and refuses to let them cross; the relation is not maintained by anyone
 * remembering it.
 */
export const DEADLINE_MS = 4000;

/** Doctor gets the smaller half: it is one of several things that can hang. */
export const DOCTOR_TIMEOUT_MS = 2000;

/** Working target for the injection. The platform's hard ceiling is 10 000. */
export const CONTEXT_BUDGET = 2000;

/** Keep the summary skimmable; long lists are what makes context unread. */
const MAX_ROWS = 5;
const MAX_STEPS = 3;

/**
 * Which directory the host repo lives in.
 *
 * `cwd` comes from the platform, but it is still input: it is used to build
 * filesystem paths and a child-process argument, so it is checked for shape
 * (absolute, existing, a directory) instead of trusted. It never reaches a
 * shell — the doctor call below uses execFile with an argument vector, so
 * even a path full of shell metacharacters is inert.
 */
export function resolveRepoRoot(input, env = process.env, cwd = process.cwd()) {
  const candidates = [field(input, 'cwd'), env.CLAUDE_PROJECT_DIR, cwd];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '' || !isAbsolute(candidate)) continue;
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Cores and memory, so the conductor sizes its team to the machine it is on. */
export function hardwareLine() {
  const cores = cpus().length;
  const gib = Math.round(totalmem() / 1024 ** 3);
  // A rough ceiling, not a promise: heavy agents are memory-bound long
  // before they are core-bound, so both numbers are shown and the smaller
  // of the two derived limits wins.
  const ceiling = Math.max(1, Math.min(Math.floor(cores / 2), Math.floor(gib / 6)));
  return `${cores} cores · ${gib} GiB RAM · suggested parallel heavy agents: ${ceiling}`;
}

/**
 * Doctor's verdict for this repo.
 *
 * `--now` is passed on purpose and is load-bearing. Without it doctor takes
 * its reference clock from each journal's own last event, so an agent that
 * died three days ago is compared against the timestamp of its own spawn and
 * is never stale — the dead-agent check would exist and never fire. A unit
 * test pins the flag into the argument vector for exactly that reason.
 *
 * Exit 1 means "findings", which is the normal case, not an error.
 */
export function runDoctor(stateDir, nowIso, { exec = execFileSync } = {}) {
  const args = [DOCTOR, '--state', '--json', '--dir', stateDir, '--now', nowIso];
  let stdout;
  try {
    stdout = exec(process.execPath, args, {
      encoding: 'utf8',
      timeout: DOCTOR_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // status 1 is "doctor found something", and its report is on stdout.
    if (err && err.status === 1 && typeof err.stdout === 'string') stdout = err.stdout;
    else return { available: false, reason: err?.message ?? 'doctor did not run' };
  }
  try {
    const parsed = JSON.parse(stdout);
    return { available: true, counts: parsed.counts, findings: parsed.findings ?? [] };
  } catch (err) {
    return { available: false, reason: `doctor output was not JSON: ${err.message}` };
  }
}

/** Every initiative under `.tyran/state`, folded, worst failures swallowed. */
export function readInitiatives(stateDir) {
  const root = join(stateDir, 'state');
  let names;
  try {
    names = readdirSync(root).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const journal = join(root, name, 'journal.jsonl');
    try {
      if (!statSync(join(root, name)).isDirectory()) continue;
      const read = readJournal(journal);
      out.push({ name, state: fold(read), events: read.events.length });
    } catch (err) {
      out.push({ name, state: null, error: err.message });
    }
  }
  return out;
}

function rows(list, render) {
  const lines = list.slice(0, MAX_ROWS).map(render);
  if (list.length > MAX_ROWS) lines.push(`- ... and ${list.length - MAX_ROWS} more`);
  return lines;
}

/**
 * Render the summary. Pure, so the whole shape of the injected context is
 * testable without a filesystem, a clock or a child process.
 */
export function renderContext({ repoRoot, initiatives, doctor, hardware, nowIso }) {
  if (initiatives.length === 0) return '';
  const lines = [
    '## Tyran state (injected by the session-start probe)',
    '',
    `Repo: ${repoRoot} · as of ${nowIso}`,
    `Machine: ${hardware}`,
    '',
  ];

  for (const { name, state, error } of initiatives) {
    lines.push(`### Initiative \`${name}\``);
    if (state === null) {
      lines.push(`- journal unreadable: ${error}`);
      lines.push('');
      continue;
    }
    lines.push(`- ${progressLine(state)}`);
    if (state.checkpoint) {
      lines.push(
        `- Checkpoint: ${state.checkpoint.phase ?? '(no phase)'} at ${state.checkpoint.ts} by ${state.checkpoint.actor}`,
      );
      const steps = Array.isArray(state.checkpoint.nextSteps) ? state.checkpoint.nextSteps : [];
      if (steps.length > 0) {
        lines.push(`- First ${Math.min(MAX_STEPS, steps.length)} step(s) on resume:`);
        steps.slice(0, MAX_STEPS).forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));
      }
    } else {
      lines.push('- No checkpoint yet — this initiative has never been paused deliberately.');
    }

    const openGates = state.openGates ?? [];
    if (openGates.length > 0) {
      lines.push(`- Open gates (${openGates.length}):`);
      lines.push(...rows(openGates, (g) => `  - ${g.kind}: ${g.result ?? 'open'} (${g.ts})`));
    }

    const leases = [...(state.leases?.values() ?? [])];
    if (leases.length > 0) {
      lines.push(`- Open leases (${leases.length}) — do NOT touch these resources:`);
      lines.push(...rows(leases, (l) => `  - ${l.resource} held by ${l.holder ?? '(unknown)'} since ${l.ts}`));
    }

    const working = (state.agents ?? []).filter((a) => a.status === 'running');
    if (working.length > 0) {
      lines.push(`- Agents the journal still believes are working (${working.length}):`);
      lines.push(
        ...rows(working, (a) => `  - ${a.agent} (${a.role ?? 'no role'}) since ${a.spawnTs ?? '?'}`),
      );
    }
    lines.push('');
  }

  if (doctor.available) {
    const c = doctor.counts ?? { error: 0, warning: 0, info: 0 };
    lines.push(`### Doctor: ${c.error} error(s) · ${c.warning} warning(s) · ${c.info} info`);
    const loud = (doctor.findings ?? []).filter((f) => f.severity !== 'info');
    lines.push(...rows(loud, (f) => `- [${f.code}] ${f.where}`));
    if (loud.length === 0) lines.push('- nothing above info level');
  } else {
    lines.push(`### Doctor did not run: ${doctor.reason}`);
    lines.push('- run `node scripts/doctor.mjs --state --now "$(date -u +%FT%TZ)"` by hand');
  }
  lines.push('');
  lines.push('Run `/tyran` to resume, or read `.tyran/state/<init>/STATE.md` in full.');
  return lines.join('\n');
}

/**
 * Trim to the working budget on a SECTION boundary, keeping the header and
 * saying what was dropped. The runtime enforces the platform's hard 10 000
 * ceiling on top of this; this one exists so the injection stays short
 * enough to actually be read.
 */
export function fitBudget(text, budget = CONTEXT_BUDGET) {
  if (text.length <= budget) return text;
  const sections = text.split('\n### ');
  let out = sections[0];
  let kept = 0;
  for (const section of sections.slice(1)) {
    const candidate = `${out}\n### ${section}`;
    if (candidate.length > budget) break;
    out = candidate;
    kept++;
  }
  const dropped = sections.length - 1 - kept;
  return `${out}\n\n[tyran session-start: ${dropped} further section(s) omitted to stay inside the ${budget}-character working budget; read .tyran/state/ for the rest]`;
}

export async function buildContext({ input, now = new Date(), env = process.env } = {}) {
  const repoRoot = resolveRepoRoot(input, env);
  if (repoRoot === null) return '';
  const stateDir = join(repoRoot, '.tyran');
  if (!existsSync(stateDir)) return ''; // not a Tyran repo — say nothing at all
  const nowIso = now.toISOString();
  return fitBudget(
    renderContext({
      repoRoot,
      initiatives: readInitiatives(stateDir),
      doctor: runDoctor(stateDir, nowIso),
      hardware: hardwareLine(),
      nowIso,
    }),
  );
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
    runProbe({
      event: 'SessionStart',
      deadlineMs: DEADLINE_MS,
      handler: ({ input }) => buildContext({ input }),
    }),
  );
}
