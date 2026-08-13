#!/usr/bin/env node
/**
 * usage-gate — pause autonomous work BEFORE the subscription window is gone.
 *
 * The platform's own behaviour at the limit is abrupt: API calls start
 * failing mid-flight, agents die between a write and its commit, and the
 * session survives only by luck of where it was standing. Measured twice on
 * 2026-08-13 while this gate was being designed: a four-agent review fleet
 * killed first by the five-hour window and then by the weekly one. This gate
 * converts that cliff into a wind-down: near the threshold it refuses
 * everything EXCEPT the closed set of actions needed to checkpoint state and
 * schedule a resume, and its refusal text IS the wind-down checklist.
 *
 * ## Where the numbers come from (and where they cannot)
 *
 * Measured on Claude Code 2.1.197 (hooks/HOOK-CONTRACT-MEASURED.md): the
 * PreToolUse stdin payload does NOT carry rate-limit telemetry. The only
 * programmatic source is the statusline JSON, which a plugin cannot install —
 * so the operator registers `scripts/statusline.mjs` (setup prints the
 * snippet), and that helper tees the platform's `rate_limits` into
 * `.tyran/state/usage.json`. This gate reads that sidecar and NOTHING else:
 * no transcript parsing, no estimation. A sidecar older than
 * `SIDECAR_FRESH_MS` is unknown, and unknown FAILS OPEN — a repo that never
 * installed the statusline must never see a false pause (doctor reports the
 * missing telemetry instead).
 *
 * ## Two windows, one policy knob (operator-decided 2026-08-13)
 *
 * The deciding variable is TIME UNTIL RESET, not which window tripped:
 *  - reset within `wait_max_hours` (default 5) — the five-hour window's shape
 *    — wind down and schedule the resume; the operator is told when.
 *  - reset beyond it — the weekly window's shape — this is a LONG pause:
 *    wind down, NOTIFY, and by default HOLD (`long_wait: hold`). Nobody
 *    should read "resuming soon" when the truth is days; silent multi-day
 *    waits are the expectation failure this knob exists to prevent.
 * The gate stamps the marker with everything the scheduler needs to act on
 * that policy; `overnight.mjs schedule` is where hold-vs-resume happens.
 *
 * ## Who it binds
 *
 * Subagents and the UNSUPERVISED main loop only. A supervised operator
 * (permission_mode default/plan) is never bound: the statusline is already
 * telling them the same number, and pausing a human's own interactive work
 * is how a control gets uninstalled. The known `permission_mode` limit is
 * inherited from policy-gate and stated there.
 *
 * ## Failure directions, chosen on purpose
 *
 * No `.tyran/` → silent pass. Config absent/malformed or `mode: off` → pass
 * (this is a budget nicety, not a boundary; a broken config must not stop
 * work — doctor already reports config-invalid). No/stale telemetry → pass.
 * Marker present and expired → self-heals (unlinked) even when the watcher
 * died with the machine. The one sticky direction: an ACTIVE marker binds
 * without re-reading telemetry, so a paused session cannot un-pause itself
 * by out-waiting the sidecar's staleness window.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { limitsOf } from '../../scripts/schema.mjs';
import { parse } from '../../scripts/yaml-lite.mjs';
import { forJournal, locateJournal } from './evidence-gate.mjs';
import { resolveRepoRoot } from './session-start.mjs';
import { isUnsupervised, actorOf, stripMessageArguments, MESSAGE_ARGUMENT_RE } from './policy-gate.mjs';
import { splitSegments, tokensOf } from './secrets-gate.mjs';
import { PASS, field, main, runGate } from './hook-io.mjs';

/** Own budget, below the 8 s hooks.json timeout. All I/O here is small local
 * files; the margin absorbs a cold filesystem, not real work. */
export const DEADLINE_MS = 4000;

export const MARKER_RELPATH = join('.tyran', 'state', 'paused-until.json');
export const SIDECAR_RELPATH = join('.tyran', 'state', 'usage.json');

/** Telemetry older than this is unknown, and unknown fails open. */
export const SIDECAR_FRESH_MS = 10 * 60 * 1000;

const MAX_SMALL_FILE_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Scripts a wind-down may run (argv: node <script> ...), by basename. */
export const WIND_DOWN_SCRIPTS = Object.freeze([
  'journal.mjs',
  'project.mjs',
  'overnight.mjs',
  'stop-check.mjs',
]);

/** Git subcommands a wind-down may run. Push is absent on purpose: local
 * durability is the goal; the resumed session pushes, and the policy gate
 * governs push reach anyway. */
export const WIND_DOWN_GIT = Object.freeze(['status', 'add', 'commit', 'diff', 'log']);

const READ_ONLY_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'NotebookRead', 'TaskOutput']);
const WRITE_TOOLS = Object.freeze(['Write', 'Edit', 'NotebookEdit']);

// ------------------------------------------------------------ small readers

function readSmallJson(path, cap = MAX_SMALL_FILE_BYTES) {
  try {
    if (!existsSync(path) || statSync(path).size > cap) return null;
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

/** The limits block for this repo, defaults applied; null = feature off. */
export function readLimits(repoRoot) {
  const configPath = join(repoRoot, '.tyran', 'config.yaml');
  try {
    if (!existsSync(configPath) || statSync(configPath).size > MAX_CONFIG_BYTES) return null;
    const limits = limitsOf(parse(readFileSync(configPath, 'utf8')));
    return limits.mode === 'off' ? null : limits;
  } catch {
    // A config this gate cannot read is doctor's finding, not a reason to
    // stop the repo's work.
    return null;
  }
}

/** The sidecar, or null when absent/stale/garbage. `nowMs` injected. */
export function readSidecar(repoRoot, nowMs, freshMs = SIDECAR_FRESH_MS) {
  const doc = readSmallJson(join(repoRoot, SIDECAR_RELPATH));
  if (doc === null) return null;
  const writtenAt = Date.parse(typeof doc.written_at === 'string' ? doc.written_at : '');
  if (!Number.isFinite(writtenAt) || nowMs - writtenAt > freshMs) return null;
  return doc;
}

function windowOf(doc, key) {
  const node = doc?.[key];
  if (node === null || typeof node !== 'object') return null;
  const used = typeof node.used_percentage === 'number' && Number.isFinite(node.used_percentage) ? node.used_percentage : null;
  const resets = typeof node.resets_at === 'number' && Number.isFinite(node.resets_at) ? node.resets_at : null;
  return used === null ? null : { used_percentage: used, resets_at: resets };
}

/**
 * Which window trips the thresholds, if any. When both trip, the WEEKLY one
 * governs: its reset is the binding constraint — waiting out the five-hour
 * refill just hits the weekly wall again.
 */
export function trippedWindow(sidecar, limits) {
  const weekly = windowOf(sidecar, 'seven_day');
  if (weekly !== null && weekly.used_percentage >= limits.weekly_pause_at_percent) {
    return { window: 'seven_day', ...weekly };
  }
  const fiveHour = windowOf(sidecar, 'five_hour');
  if (fiveHour !== null && fiveHour.used_percentage >= limits.pause_at_percent) {
    return { window: 'five_hour', ...fiveHour };
  }
  return null;
}

// ------------------------------------------------------------------ marker

export function markerOf(tripped, limits, nowMs, sessionId, init) {
  const resetsMs = tripped.resets_at !== null ? tripped.resets_at * 1000 : null;
  // No resets_at from the platform: the window is known-exhausted but the
  // reset time is unknown. A null resume_at would be a marker nothing can
  // self-heal — a permanent false pause — so bound it at wait_max_hours from
  // now instead: the pause still protects the remainder, and the marker
  // expires on its own even if every watcher dies.
  const resumeAtMs =
    resetsMs !== null ? resetsMs + limits.resume_margin_minutes * 60 * 1000 : nowMs + limits.wait_max_hours * 3600 * 1000;
  const waitMs = resumeAtMs - nowMs;
  const longWait = waitMs > limits.wait_max_hours * 3600 * 1000;
  return {
    paused_at: new Date(nowMs).toISOString(),
    window: tripped.window,
    used_percentage: tripped.used_percentage,
    resets_at: tripped.resets_at,
    resume_at: new Date(resumeAtMs).toISOString(),
    long_wait: longWait,
    // What the scheduler should DO about a long wait — copied from config at
    // pause time so the decision is auditable next to its inputs.
    long_wait_policy: limits.long_wait,
    session_id: typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) ? sessionId : null,
    init: init ?? null,
    source: 'sidecar',
  };
}

export function writeMarker(repoRoot, marker) {
  const dir = join(repoRoot, '.tyran', 'state');
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.paused-${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(marker, null, 2) + '\n');
  renameSync(temp, join(repoRoot, MARKER_RELPATH));
}

/** No marker shape is immortal: one without a parseable resume_at (hand-made
 * or from an older Tyran) expires this long after paused_at. */
export const MARKER_MAX_AGE_MS = 24 * 3600 * 1000;

/** An active marker, or null. Expired markers self-heal (best-effort unlink):
 * the watcher may have died with the machine, and a pause that outlives its
 * own resume time is a stall, not a protection. */
export function readMarker(repoRoot, nowMs, { unlink = unlinkSync } = {}) {
  const path = join(repoRoot, MARKER_RELPATH);
  const doc = readSmallJson(path);
  if (doc === null) return null;
  const resumeAt = Date.parse(typeof doc.resume_at === 'string' ? doc.resume_at : '');
  const pausedAt = Date.parse(typeof doc.paused_at === 'string' ? doc.paused_at : '');
  const expired = Number.isFinite(resumeAt)
    ? nowMs >= resumeAt
    : !Number.isFinite(pausedAt) || nowMs >= pausedAt + MARKER_MAX_AGE_MS;
  if (expired) {
    try {
      unlink(path);
    } catch {
      /* the next reader tries again */
    }
    return null;
  }
  return doc;
}

// --------------------------------------------------------------- allowlist

/** Is this repo-root-relative-or-absolute path under `.tyran/state/`?
 * Backslashes are separators only on Windows; on POSIX `.tyran\state\x` is a
 * literal FILENAME the Write tool would create at the repo root, so rewriting
 * it here would allow a write that lands outside the state dir. */
function underState(repoRoot, rawPath) {
  if (typeof rawPath !== 'string' || rawPath === '') return false;
  const normalized = process.platform === 'win32' ? rawPath.replace(/\\/g, '/') : rawPath;
  const abs = resolve(repoRoot, normalized);
  const stateDir = join(resolve(repoRoot), '.tyran', 'state');
  return abs === stateDir || abs.startsWith(stateDir + sep);
}

/**
 * In an ALLOWLIST context the message-argument strip must not blind the
 * check: the real shell still expands `$( )` and backticks inside a
 * double-quoted or bare `--data`/`-m` value, so a substitution smuggled there
 * would run while the lexer sees only the allowed carrier command.
 * Single-quoted values are shell-inert and stay allowed — the wind-down
 * checklist's own appends use them. Same bounded shape as the strip itself
 * (MESSAGE_ARGUMENT_RE), not a second parser.
 */
function messageArgumentsInert(command) {
  for (const match of String(command).matchAll(MESSAGE_ARGUMENT_RE)) {
    const value = match[4];
    if (value.startsWith("'")) continue;
    if (value.includes('$') || value.includes('`')) return false;
  }
  return true;
}

/** `git add` flags that sweep the whole tree — the refusal promises explicit
 * paths, so the gate enforces exactly that. */
const GIT_ADD_SWEEPERS = Object.freeze(['-A', '--all', '-u', '--update', '.']);

function bashAllowed(command, repoRoot) {
  if (!messageArgumentsInert(command)) return false;
  let segments;
  try {
    // Message arguments are DATA, not program: a journal append's --data blob
    // carries JSON whose braces the shared lexer treats as segment
    // separators. Same strip, same reason, as policy-gate's commandTokens.
    segments = splitSegments(stripMessageArguments(String(command)));
  } catch {
    return false;
  }
  if (segments.length === 0) return false;
  for (const segment of segments) {
    let tokens;
    try {
      tokens = tokensOf(segment);
    } catch {
      return false;
    }
    const argv = tokens.filter((t) => typeof t === 'string' && t !== '');
    if (argv.length === 0) return false;
    const program = basename(argv[0]);
    if (program === 'node') {
      // node <script> …: the script decides. Basename on purpose — both the
      // ${CLAUDE_PLUGIN_ROOT} expansion and an absolute path must pass, and
      // the declared floor (commands, never effects) is stated in the
      // refusal: a path assembled at runtime is invisible to this check.
      if (argv.length < 2 || !WIND_DOWN_SCRIPTS.includes(basename(argv[1]))) return false;
      // Wind-down Writes may land under .tyran/state/**, so a script THERE
      // with an allowed basename would close the loop on arbitrary code:
      // Write .tyran/state/journal.mjs, then run it. Scripts under the
      // adopted repo's .tyran/ are never the plugin's own.
      const scriptAbs = resolve(repoRoot, argv[1]);
      const tyranDir = join(resolve(repoRoot), '.tyran');
      if (scriptAbs === tyranDir || scriptAbs.startsWith(tyranDir + sep)) return false;
      continue;
    }
    if (program === 'git') {
      const sub = argv.find((t, i) => i > 0 && !t.startsWith('-'));
      if (!WIND_DOWN_GIT.includes(sub)) return false;
      // `--output` turns read-only log/diff into a file write anywhere on
      // disk; `git add -A`/`.` sweeps the whole tree into the pause commit.
      if (argv.some((t, i) => i > 0 && t.startsWith('--output'))) return false;
      if (sub === 'add' && argv.some((t, i) => i > 0 && GIT_ADD_SWEEPERS.includes(t))) return false;
      continue;
    }
    return false;
  }
  return true;
}

/** May this tool call proceed during wind-down? Pure given its inputs. */
export function allowedDuringWindDown(toolName, toolInput, repoRoot) {
  if (READ_ONLY_TOOLS.includes(toolName)) return true;
  if (WRITE_TOOLS.includes(toolName)) {
    const path = field(toolInput, 'file_path') ?? field(toolInput, 'notebook_path') ?? field(toolInput, 'path');
    return underState(repoRoot, path);
  }
  if (toolName === 'Bash') return bashAllowed(field(toolInput, 'command'), repoRoot);
  return false;
}

// ----------------------------------------------------------------- refusal

function humanWait(waitMs) {
  if (waitMs === null || !Number.isFinite(waitMs) || waitMs <= 0) return 'unknown';
  const hours = Math.floor(waitMs / 3600000);
  const minutes = Math.round((waitMs % 3600000) / 60000);
  if (hours >= 48) return `~${Math.round(hours / 24)} days`;
  return hours > 0 ? `~${hours}h ${minutes}m` : `~${minutes}m`;
}

const WINDOW_NAMES = Object.freeze({ five_hour: 'five-hour', seven_day: 'SEVEN-DAY' });

/**
 * The plugin's scripts directory, absolute. The checklist prints ABSOLUTE
 * paths on purpose: the shared shell lexer treats `{`/`}` as segment
 * separators, so a `${CLAUDE_PLUGIN_ROOT}` spelling can never satisfy the
 * per-segment allowlist — the refusal must hand out commands the allowlist
 * itself will pass.
 */
export const PLUGIN_SCRIPTS_DIR = resolve(fileURLToPath(new URL('../../scripts/', import.meta.url)));

export function buildRefusal(marker, { subagent = false, waitMaxHours, scriptsDir = PLUGIN_SCRIPTS_DIR }) {
  const windowName = WINDOW_NAMES[marker.window] ?? String(marker.window ?? 'usage');
  const resumeAt = typeof marker.resume_at === 'string' ? marker.resume_at : 'unknown';
  const waitMs = typeof marker.resume_at === 'string' ? Date.parse(marker.resume_at) - Date.parse(marker.paused_at ?? marker.resume_at) : null;
  const used = typeof marker.used_percentage === 'number' ? marker.used_percentage.toFixed(1) : '?';

  const head = marker.long_wait
    ? `tyran usage-gate: ${used}% of the ${windowName} window is used and it resets at ${resumeAt} — ` +
      `${humanWait(waitMs)} away, beyond wait_max_hours=${waitMaxHours}. This is a LONG pause: after the ` +
      `wind-down, the scheduler will ${marker.long_wait_policy === 'resume' ? 'schedule the resume AND notify the operator of the long wait' : 'NOTIFY the operator and HOLD (limits.long_wait: hold) — nothing resumes without them'}.`
    : `tyran usage-gate: ${used}% of the ${windowName} window is used (resets ${resumeAt}, ${humanWait(waitMs)}). ` +
      `Pausing instead of burning the remainder; the scheduler resumes this session after the reset.`;

  if (subagent) {
    return (
      `${head}\n` +
      `Report what you have NOW, honestly marked as interrupted. If the story is unfinished, the legitimate ` +
      `evidence hatch is:\nEVIDENCE: none-required — usage-limit pause interrupted this story`
    );
  }

  const sid = marker.session_id ?? '<session-id>';
  return (
    `${head}\n` +
    `Allowed until then: reads; writes under .tyran/state/**; node runs of the journal/project/overnight/` +
    `stop-check scripts (absolute paths as printed below — the allowlist reads commands, never effects, and ` +
    `cannot read a \${VAR} spelling); git status/add/commit/diff/log (explicit paths, never -A; push is ` +
    `denied — the resumed session pushes).\n` +
    `Wind down IN THIS ORDER, then stop:\n` +
    ` 1. node "${scriptsDir}/journal.mjs" append <journal> checkpoint <init> --actor conductor ` +
    `--data '{"phase":"usage-limit-pause","next_steps":["re-read STATE.md","close the usage-limit gate with result passed","check open leases and spawns","continue from this checkpoint"]}'\n` +
    ` 2. node "${scriptsDir}/journal.mjs" append <journal> gate <init> --actor conductor ` +
    `--data '{"kind":"usage-limit","result":"WAITING_ON_RESET","window":"${marker.window}","resume_at":"${resumeAt}","used_percentage":${JSON.stringify(marker.used_percentage ?? null)},"session_id":"${sid}"}'\n` +
    ` 3. node "${scriptsDir}/project.mjs" <journal> --out-dir <dir>\n` +
    ` 4. git add <explicit .tyran/state paths> && git commit\n` +
    ` 5. node "${scriptsDir}/overnight.mjs" schedule\n` +
    ` 6. Stop. If the Stop gate asks for a retrospective, record a retro.entry ` +
    `(--data '{"kind":"skipped","target":"<init>","reason":"usage-limit pause"}' — target is required).\n` +
    `The pause marker is .tyran/state/paused-until.json; an operator takes over with ` +
    `node "${scriptsDir}/overnight.mjs" cancel.`
  );
}

// ------------------------------------------------------------------ decide

/** The verdict. Everything injected so the whole decision is testable. */
export function decide(
  input,
  {
    now = () => Date.now(),
    locate = locateJournal,
    readLimitsFn = readLimits,
    readSidecarFn = readSidecar,
    readMarkerFn = readMarker,
    writeMarkerFn = writeMarker,
  } = {},
) {
  const repoRoot = resolveRepoRoot(input);
  if (repoRoot === null || !existsSync(join(repoRoot, '.tyran'))) return PASS;

  const limits = readLimitsFn(repoRoot);
  if (limits === null) return PASS;

  const nowMs = now();
  let marker = readMarkerFn(repoRoot, nowMs);

  if (marker === null) {
    const sidecar = readSidecarFn(repoRoot, nowMs);
    if (sidecar === null) return PASS; // no telemetry = unknown = open
    const tripped = trippedWindow(sidecar, limits);
    if (tripped === null) return PASS;
    if (limits.mode === 'warn') return PASS; // surfacing is doctor's job
    if (!isUnsupervised(input)) return PASS; // never bind the operator
    const journal = locate(repoRoot);
    marker = markerOf(tripped, limits, nowMs, field(input, 'session_id'), journal.init ? forJournal(journal.init) : null);
    try {
      writeMarkerFn(repoRoot, marker);
    } catch {
      // A marker that cannot be written is a pause that cannot be durable —
      // still refuse this call (the refusal text works without the file),
      // and the next call retries the write.
    }
  } else if (!isUnsupervised(input)) {
    // Marker active, but a supervised operator is at the keyboard: their own
    // interactive work is never bound. The marker stays for the autonomous
    // path; `overnight.mjs cancel` clears it deliberately.
    return PASS;
  }

  if (allowedDuringWindDown(field(input, 'tool_name'), field(input, 'tool_input'), repoRoot)) return PASS;

  return {
    decision: 'deny',
    reason: buildRefusal(marker, {
      subagent: actorOf(input) === 'subagent',
      waitMaxHours: limits.wait_max_hours,
    }),
  };
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

if (isMainModule(import.meta.url)) {
  await main(() =>
    runGate({
      event: 'PreToolUse',
      deadlineMs: DEADLINE_MS,
      handler: ({ input }) => decide(input),
    }),
  );
}
