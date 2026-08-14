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
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkHooks } from '../../scripts/hooks-check.mjs';
import { readJournal } from '../../scripts/journal.mjs';
import { SESSION_ID_RE } from '../../scripts/overnight.mjs';
import { fold, inlinePlain, progressLine } from '../../scripts/project.mjs';
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
 *
 * EVERY journal-derived value goes through `inlinePlain`. This text is
 * injected straight into the conductor's context — it is the LAST step of the
 * attack path ADR-19 describes (foreign repo -> subagent report -> journal ->
 * projection -> conductor), so it is the place where a raw byte costs the most.
 *
 * It did not do this until a security review measured it: 400 hostile trees
 * put 35 819 invisible codepoints into this function's output, 400 of 400
 * leaking, with "IGNORE PRIOR" reconstructable from the TAG characters. The
 * process was safe only because hook-io sanitizes one floor up — and that is
 * caller discipline, the mechanism class this project distrusts on principle
 * and rejects by name in journal.mjs and doctor.mjs. Worse than redundant
 * defence: there was ZERO here and ONE at the consumer, and no test at this
 * level held any of it.
 *
 * Sanitizing here also restores the budget below. `fitBudget` measured the
 * text BEFORE hook-io expanded it, so a hostile journal produced 9 880
 * characters of injected context against a 2 000-character budget — 4.9x over,
 * 120 characters under the platform's hard ceiling. Escaping first means the
 * length fitBudget sees is the length that ships.
 */
export function renderContext({ repoRoot, initiatives, doctor, hardware, nowIso, pause = null }) {
  if (initiatives.length === 0 && pause === null) return '';
  const lines = [
    '## Tyran state (injected by the session-start probe)',
    '',
    `Repo: ${inlinePlain(repoRoot)} · as of ${inlinePlain(nowIso)}`,
    `Machine: ${inlinePlain(hardware)}`,
  ];
  // The pause notice lives in the HEADER, before any `### ` section, because
  // fitBudget always keeps the preamble and drops sections from the end — a
  // paused session must never lose the one line that says why it is paused.
  if (pause !== null) lines.push(renderPauseNotice(pause, nowIso));
  lines.push('');

  for (const { name, state, error } of initiatives) {
    lines.push(`### Initiative \`${inlinePlain(name)}\``);
    if (state === null) {
      lines.push(`- journal unreadable: ${inlinePlain(error)}`);
      lines.push('');
      continue;
    }
    lines.push(`- ${progressLine(state)}`);
    if (state.checkpoint) {
      lines.push(
        `- Checkpoint: ${inlinePlain(state.checkpoint.phase ?? '(no phase)')} at ${inlinePlain(state.checkpoint.ts)} by ${inlinePlain(state.checkpoint.actor)}`,
      );
      const steps = Array.isArray(state.checkpoint.nextSteps) ? state.checkpoint.nextSteps : [];
      if (steps.length > 0) {
        lines.push(`- First ${Math.min(MAX_STEPS, steps.length)} step(s) on resume:`);
        steps.slice(0, MAX_STEPS).forEach((step, i) => lines.push(`  ${i + 1}. ${inlinePlain(step)}`));
      }
    } else {
      lines.push('- No checkpoint yet — this initiative has never been paused deliberately.');
    }

    const openGates = state.openGates ?? [];
    if (openGates.length > 0) {
      lines.push(`- Open gates (${openGates.length}):`);
      // The QUESTION, not only the gate's name: an ask is a gate whose kind is
      // its id, and `Q-7: WAITING_ON_OPERATOR` tells a resumed conductor that
      // it is waiting without telling it what it asked — which is a
      // re-litigation after every compaction.
      lines.push(
        ...rows(
          openGates,
          (g) =>
            `  - ${inlinePlain(g.kind)}: ${inlinePlain(g.result ?? 'open')}` +
            (g.question ? ` — ${inlinePlain(g.question)}` : '') +
            ` (${inlinePlain(g.ts)})`,
        ),
      );
    }

    const leases = [...(state.leases?.values() ?? [])];
    if (leases.length > 0) {
      lines.push(`- Open leases (${leases.length}) — do NOT touch these resources:`);
      lines.push(...rows(leases, (l) => `  - ${inlinePlain(l.resource)} held by ${inlinePlain(l.holder ?? '(unknown)')} since ${inlinePlain(l.ts)}`));
    }

    const working = (state.agents ?? []).filter((a) => a.status === 'running');
    if (working.length > 0) {
      lines.push(`- Agents the journal still believes are working (${working.length}):`);
      lines.push(
        ...rows(working, (a) => `  - ${inlinePlain(a.agent)} (${inlinePlain(a.role ?? 'no role')}) since ${inlinePlain(a.spawnTs ?? '?')}`),
      );
    }
    lines.push('');
  }

  if (doctor.available) {
    const c = doctor.counts ?? { error: 0, warning: 0, info: 0 };
    lines.push(`### Doctor: ${c.error} error(s) · ${c.warning} warning(s) · ${c.info} info`);
    const loud = (doctor.findings ?? []).filter((f) => f.severity !== 'info');
    lines.push(...rows(loud, (f) => `- [${inlinePlain(f.code)}] ${inlinePlain(f.where)}`));
    if (loud.length === 0) lines.push('- nothing above info level');
  } else {
    lines.push(`### Doctor did not run: ${inlinePlain(doctor.reason)}`);
    lines.push('- run `node scripts/doctor.mjs --state --now "$(date -u +%FT%TZ)"` by hand');
  }
  lines.push('');
  lines.push('Run `/tyran` to resume, or read `.tyran/state/<init>/STATE.md` in full.');
  return lines.join('\n');
}

/**
 * The plugin's own gates, checked at session start — the ONE thing this probe
 * says even in a repository that has no Tyran state at all.
 *
 * Silent when healthy, and that is the whole design. A note on every session
 * saying "your gates are fine" is noise that trains the reader to skip the
 * section, and this text has to be read on the one day it is not fine.
 *
 * It goes FIRST in the injected context on purpose: `fitBudget` drops whole
 * sections from the END, so anything placed after the initiative summaries
 * would be the first thing lost in exactly the repositories that have the
 * most state — and a warning that disappears when the report gets long is a
 * warning that is absent when it matters.
 *
 * This is DETECTION, not enforcement, and the text says so to the reader as
 * well as to us: `SessionStart` has no refusal channel (ADR-22), so the probe
 * cannot stop a session whose gates are dead. It can only make sure that the
 * person and the agent both know.
 */
export function renderHookWarning(result) {
  if (result === null) return '';
  const loud = result.findings.filter((f) => f.severity !== 'info');
  if (loud.length === 0) return '';
  const lines = [
    '### WARNING: this plugin has gates that cannot fire',
    '',
    `\`tyran doctor --hooks\` finds ${result.counts.error} error(s) and ${result.counts.warning} warning(s) ` +
      'in the hook registration. A hook whose file is missing, is not executable, or whose matcher can ' +
      'never match is not a weaker control — the platform fails OPEN, so the action it was meant to ' +
      'check simply proceeds, with nothing printed anywhere.',
    '',
  ];
  lines.push(...rows(loud, (f) => `- [${inlinePlain(f.code)}] ${inlinePlain(f.where)}`));
  lines.push('');
  lines.push('Run `node scripts/doctor.mjs --hooks` for the full reason and the fix for each one.');
  lines.push(
    'This probe can only REPORT it: SessionStart has no way to refuse, so nothing here stops a session ' +
      'whose gates are dead.',
  );
  lines.push('');
  return lines.join('\n');
}

/** Never let a broken check break a session — it is a probe (ADR-22). */
export function hookHealth({ check = checkHooks } = {}) {
  try {
    return check();
  } catch {
    return null;
  }
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

/**
 * One line about an active usage-limit pause — or a stale one, which is the
 * variant that actually needs a human. Everything through inlinePlain; only
 * marker fields the overnight tooling itself wrote are shown.
 */
export function renderPauseNotice(marker, nowIso) {
  const resumeAtMs = Date.parse(typeof marker.resume_at === 'string' ? marker.resume_at : '');
  const nowMs = Date.parse(nowIso);
  if (Number.isFinite(resumeAtMs) && Number.isFinite(nowMs) && resumeAtMs < nowMs) {
    return (
      `PAUSED-STALE: the usage-limit pause marker's resume time (${inlinePlain(marker.resume_at)}) has ` +
      'PASSED — run `node scripts/overnight.mjs status` and reschedule or clear it.'
    );
  }
  const window = marker.window === 'seven_day' ? 'weekly' : 'five-hour';
  return (
    `PAUSED on the ${window} usage limit until ${inlinePlain(marker.resume_at ?? 'the window resets')}` +
    (marker.long_wait === true ? ' — a LONG pause; the scheduler holds unless told otherwise' : '') +
    '. Operator takeover: `node scripts/overnight.mjs cancel --clear`.'
  );
}

/** Where the resumable session id is recorded, relative to `.tyran`. */
export const CONDUCTOR_RELPATH = join('state', 'conductor.json');

/**
 * Record this session so `answer.mjs apply --resume` can put the swarm back on
 * it. Until this existed a resumable session id was written ONLY by a
 * usage-limit pause or by the operator-installed statusline, so a repo with
 * neither had no way to be resumed at all.
 *
 * Best-effort, and inside its own try/catch: `SessionStart` has no way to
 * refuse anything (ADR-22), so a probe that threw here would cost the user
 * their session to report that a convenience file could not be written.
 * `.tyran/state/**` is the AUTO policy class already, so no policy moves.
 *
 * The id is shape-checked before it is written: it becomes an argument of a
 * `claude --resume` command, and the file is the only thing vouching for it.
 */
export function recordConductor(stateDir, input, { now = new Date(), cwd = null, pid = process.pid } = {}) {
  try {
    const sessionId = field(input, 'session_id');
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return false;
    const target = join(stateDir, CONDUCTOR_RELPATH);
    mkdirSync(dirname(target), { recursive: true });
    const doc = { session_id: sessionId, pid, started_at: now.toISOString(), cwd: cwd ?? dirname(stateDir) };
    const temp = join(dirname(target), `.conductor-${pid}.tmp`);
    writeFileSync(temp, JSON.stringify(doc, null, 2) + '\n');
    renameSync(temp, target);
    return true;
  } catch {
    return false; // a probe never fails a session over a courtesy file
  }
}

/** The pause marker, if one is active. Garbage reads as absent. */
export function readPauseMarker(stateDir) {
  try {
    const path = join(stateDir, 'state', 'paused-until.json');
    if (!existsSync(path)) return null;
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

export async function buildContext({ input, now = new Date(), env = process.env, health = hookHealth } = {}) {
  // Said even in a repository that has nothing to do with Tyran: the claim
  // being corrected is about the PLUGIN the user installed, not about this
  // project's state, and a user whose gates are dead needs to hear it in the
  // session where they are relying on them.
  const warning = renderHookWarning(health());
  const repoRoot = resolveRepoRoot(input, env);
  if (repoRoot === null) return fitBudget(warning);
  const stateDir = join(repoRoot, '.tyran');
  if (!existsSync(stateDir)) return fitBudget(warning); // not a Tyran repo — but a dead gate still counts
  recordConductor(stateDir, input, { now, cwd: repoRoot });
  const nowIso = now.toISOString();
  return fitBudget(
    warning +
    renderContext({
      repoRoot,
      initiatives: readInitiatives(stateDir),
      doctor: runDoctor(stateDir, nowIso),
      hardware: hardwareLine(),
      nowIso,
      pause: readPauseMarker(stateDir),
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
