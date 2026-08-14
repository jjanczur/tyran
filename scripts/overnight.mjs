#!/usr/bin/env node
/**
 * overnight — schedule and run the usage-limit resume watcher.
 *
 * The usage gate winds a session down and writes a pause marker
 * (`.tyran/state/paused-until.json`); this tool is the marker's OTHER half:
 * `schedule` decides between WAITING and HOLDING, `--wait` is the detached
 * watcher that sleeps to the window reset and resumes the paused session,
 * `status` and `cancel` are the operator's handles.
 *
 * ## Wait vs hold — the operator's 2026-08-13 policy, mechanized
 *
 * The deciding variable is time-until-reset, already stamped on the marker by
 * the gate (`long_wait`, from `limits.wait_max_hours`):
 *  - short wait (the five-hour window's shape): spawn the watcher, notify the
 *    operator with the resume time, resume automatically;
 *  - long wait (the weekly window's shape): NOTIFY and, under the default
 *    `limits.long_wait: hold`, schedule NOTHING — a resume days out that
 *    nobody asked for reads as "working soon" when the truth is "parked".
 *    `--force-resume` (or `long_wait: resume` in config) opts into true
 *    multi-day autonomy, still with the loud notification.
 *
 * ## What the watcher defends against (measured platform facts)
 *
 *  - Machine sleep: chunked sleeps re-read the wall clock; an overslept
 *    laptop fires late, never never. Under `limits.keep_awake` it does not
 *    oversleep at all — the wait is wrapped in a system-sleep inhibitor
 *    (scripts/keepawake.mjs). Reboot still kills the watcher — the marker
 *    then goes stale, doctor reports it, and the gate self-heals it.
 *  - Blind resumed sessions: statuslines do not run under `claude -p`
 *    (measured 2.1.197), so a resumed session has NO fresh telemetry. The
 *    watcher BABYSITS: it waits for the child and, if the journal shows no
 *    movement — the classic sign the window was still exhausted — backs off
 *    and retries on a fixed ladder instead of dying with it.
 *  - Double resume: before spawning it checks the STOP brake, the marker
 *    still existing, and the journal (a closed usage-limit gate or a
 *    post-pause checkpoint means the conductor already came back).
 *  - The weekly wall behind the five-hour refill: at wake, fresh telemetry
 *    showing the seven-day window still over threshold reschedules to THAT
 *    reset (or holds, beyond wait_max) instead of burning the refill.
 *
 * Nothing read from the marker or sidecar ever reaches a shell: every child
 * is an argv array with shell:false, and the session id is shape-validated
 * before it becomes an argument. Notifications carry only our own words and
 * numbers.
 *
 * CLI:
 *   node overnight.mjs schedule [--dir <repo>] [--prompt <text>] [--cmd <exe>] [--force-resume]
 *   node overnight.mjs status   [--dir <repo>]
 *   node overnight.mjs cancel   [--dir <repo>] [--clear]
 *   node overnight.mjs --wait   [--dir <repo>]        # internal (the watcher)
 * Exit: 0 ok/held · 1 refused (no marker, already scheduled, STOP) · 2 usage/IO
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkStop } from './stop-check.mjs';
import { readJournal } from './journal.mjs';
import { GATE_PASS } from './project.mjs';
import { withKeepAwake } from './keepawake.mjs';
import { limitsOf } from './schema.mjs';
import { parse } from './yaml-lite.mjs';
import { escapeInvisible } from './invisible.mjs';

export const MARKER_RELPATH = join('.tyran', 'state', 'paused-until.json');
export const RESUME_STATE_RELPATH = join('.tyran', 'state', 'resume.json');
export const RESUME_LOG_RELPATH = join('.tyran', 'state', 'resume.log');
export const SIDECAR_RELPATH = join('.tyran', 'state', 'usage.json');

export const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
/** Short enough that an overslept machine fires soon after waking. */
export const MAX_SLEEP_CHUNK_MS = 15 * 60 * 1000;
/** Telemetry older than this is unknown; unknown means proceed. */
export const SIDECAR_FRESH_MS = 10 * 60 * 1000;
/** Babysitting ladder after a resume that visibly did not take. */
export const RESUME_BACKOFFS_MS = Object.freeze([5 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000]);
/** Hard ceiling on a single `claude -p` attempt before the babysitter reclaims it. */
export const RESUME_ATTEMPT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/**
 * The longest a live watcher can legitimately still be running past its
 * resume_at: every attempt on the ladder may consume the full per-attempt
 * timeout, plus the backoff sleeps between attempts. Derived from those
 * constants so a ladder change cannot leave this window stale.
 */
export const WATCHER_MAX_OVERRUN_MS =
  (RESUME_BACKOFFS_MS.length + 1) * RESUME_ATTEMPT_TIMEOUT_MS + RESUME_BACKOFFS_MS.reduce((a, b) => a + b, 0);

class UsageError extends Error {}

// ------------------------------------------------------------ pure helpers

export function nextSleepMs(nowMs, resumeAtMs, chunk = MAX_SLEEP_CHUNK_MS) {
  const remaining = resumeAtMs - nowMs;
  return remaining <= 0 ? 0 : Math.min(remaining, chunk);
}

/**
 * Should the watcher skip resuming, and why. Deterministic over its inputs:
 * the STOP brake, marker existence, and the journal's own record.
 */
export function skipReason({ stopped, markerExists, journalEvents, pausedAtIso }) {
  if (stopped) return 'stop-brake';
  if (!markerExists) return 'marker-gone';
  const pausedAt = Date.parse(pausedAtIso ?? '') || 0;
  let gateOpen = null;
  let laterCheckpoint = false;
  for (const e of journalEvents ?? []) {
    const ts = Date.parse(e?.ts ?? '') || 0;
    // Only this pause's gate events count: a gate closed before pausedAt
    // belongs to an earlier cycle and says nothing about the current one.
    if (e?.ev === 'gate' && e?.data?.kind === 'usage-limit' && ts > pausedAt) {
      // The pass set is project.mjs's, imported: a copy here would let the
      // watcher and the projection disagree about whether a gate is closed.
      gateOpen = !GATE_PASS.has(String(e?.data?.result ?? '').toLowerCase());
    }
    if (e?.ev === 'checkpoint' && ts > pausedAt && e?.data?.phase !== 'usage-limit-pause') laterCheckpoint = true;
  }
  if (gateOpen === false) return 'gate-already-closed';
  if (laterCheckpoint) return 'resumed-manually';
  return null;
}

/**
 * At wake time: does fresh telemetry say the WEEKLY window is still over
 * threshold, and if so when could work actually resume. Stale or absent
 * telemetry is unknown, and unknown means proceed — blocking a resume on
 * missing data would strand every run whose operator closed the laptop lid.
 */
export function weeklyDeferral(sidecar, nowMs, { weeklyPausePercent, marginMs, freshMs = SIDECAR_FRESH_MS }) {
  if (!sidecar || typeof sidecar !== 'object') return null;
  const writtenAt = Date.parse(typeof sidecar.written_at === 'string' ? sidecar.written_at : '');
  if (!Number.isFinite(writtenAt) || nowMs - writtenAt > freshMs) return null;
  const weekly = sidecar.seven_day;
  if (!weekly || typeof weekly.used_percentage !== 'number') return null;
  if (weekly.used_percentage < weeklyPausePercent) return null;
  if (typeof weekly.resets_at !== 'number') return null;
  return weekly.resets_at * 1000 + marginMs;
}

/** The resume argv. Nothing here ever passes through a shell. */
export function resumeArgv(sessionId, prompt, { cmd = 'claude', permissionMode = 'acceptEdits' } = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    throw new UsageError('the marker carries no usable session id — resume the session by hand');
  }
  return [cmd, '-p', '--resume', sessionId, '--permission-mode', permissionMode, prompt];
}

export function defaultPrompt(init) {
  const where = init ? `.tyran/state/${init}/STATE.md` : 'the newest .tyran/state/*/STATE.md';
  return (
    `Usage-limit pause is over. Read ${where} and the journal tail, then continue from the ` +
    `'usage-limit-pause' checkpoint. First close the open usage-limit gate: append a gate event, ` +
    `kind "usage-limit", result "passed".`
  );
}

/**
 * Did the resume TAKE? Journal movement, not the child's exit code: a session
 * that hit the still-exhausted window exits "cleanly" having appended nothing,
 * and that silence is exactly the failure the babysitter exists to catch.
 */
export function resumeTook({ eventsBefore, eventsAfter }) {
  return eventsAfter > eventsBefore;
}

export function humanWait(waitMs) {
  if (!Number.isFinite(waitMs) || waitMs <= 0) return 'now';
  const hours = Math.floor(waitMs / 3600000);
  if (hours >= 48) return `~${Math.round(hours / 24)} days`;
  const minutes = Math.round((waitMs % 3600000) / 60000);
  return hours > 0 ? `~${hours}h ${minutes}m` : `~${minutes}m`;
}

/**
 * What `schedule` should do, given the marker and an operator override.
 * Pure, so the hold-vs-watch policy is testable without a filesystem.
 */
export function scheduleDecision(marker, { forceResume = false } = {}) {
  if (marker.long_wait && marker.long_wait_policy !== 'resume' && !forceResume) {
    return { action: 'hold' };
  }
  return { action: 'watch' };
}

// --------------------------------------------------------------- plumbing

function readSmallJson(path) {
  try {
    if (!existsSync(path) || statSync(path).size > 64 * 1024) return null;
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

function writeStateFile(repo, doc) {
  const dir = join(repo, '.tyran', 'state');
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.resume-${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(doc, null, 2) + '\n');
  renameSync(temp, join(repo, RESUME_STATE_RELPATH));
}

function log(repo, message) {
  try {
    mkdirSync(join(repo, '.tyran', 'state'), { recursive: true });
    writeFileSync(join(repo, RESUME_LOG_RELPATH), `${new Date().toISOString()} ${message}\n`, { flag: 'a' });
  } catch {
    /* a log that cannot be written must not stop the watcher */
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A heartbeat older than this cannot be the live watcher's: it stamps every
 * loop iteration, and the sleep chunk is capped at MAX_SLEEP_CHUNK_MS. */
export const HEARTBEAT_FRESH_MS = 2 * MAX_SLEEP_CHUNK_MS;

/**
 * Whether resume.json's recorded watcher can still BE the watcher. A pid
 * check alone survives reboots: recycling can hand the number to an unrelated
 * process. The heartbeat is liveness the clock cannot fake — a recycled pid
 * never writes one, while a real watcher that overslept a day stamps it again
 * on its first iteration after the machine wakes. States from an older Tyran
 * carry no heartbeat; for those, past resume_at + WATCHER_MAX_OVERRUN_MS no
 * real watcher can still be running. Within those windows a recycled pid is
 * indistinguishable from ours — full process identity is not portable in
 * zero-dependency Node; this is the floor.
 */
export function watcherAlive(state, nowMs = Date.now()) {
  if (state?.state !== 'waiting' || !pidAlive(state?.pid)) return false;
  const heartbeatMs = Date.parse(typeof state.heartbeat_at === 'string' ? state.heartbeat_at : '');
  if (Number.isFinite(heartbeatMs)) return nowMs - heartbeatMs <= HEARTBEAT_FRESH_MS;
  const resumeAtMs = Date.parse(typeof state.resume_at === 'string' ? state.resume_at : '');
  return !(Number.isFinite(resumeAtMs) && nowMs > resumeAtMs + WATCHER_MAX_OVERRUN_MS);
}

/**
 * Best-effort desktop notification — macOS osascript, then notify-send.
 * Text is OUR OWN words and numbers only; nothing foreign is interpolated.
 * Every failure is silent: a notification is a courtesy, not a channel the
 * design depends on (the journal, the log and doctor are the record).
 */
export function notifyDesktop(title, body, { run = execFile } = {}) {
  const quiet = () => {};
  try {
    if (process.platform === 'darwin') {
      run('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], quiet);
    } else {
      run('notify-send', [title, body], quiet);
    }
  } catch {
    /* a notification is a courtesy; its absence is never a failure */
  }
}

function journalPathFor(repo, init) {
  return init ? join(repo, '.tyran', 'state', init, 'journal.jsonl') : null;
}

function journalEventCount(path) {
  if (path === null || !existsSync(path)) return null;
  try {
    return readJournal(path).events.length;
  } catch {
    return null;
  }
}

function readLimitsFile(repo) {
  try {
    return limitsOf(parse(readFileSync(join(repo, '.tyran', 'config.yaml'), 'utf8')));
  } catch {
    return limitsOf(null);
  }
}

/**
 * Run ONE resume attempt to completion without blocking the event loop.
 *
 * `spawnSync` is the shorter shape and must not be used: a sync child parks
 * the loop for the whole attempt — up to RESUME_ATTEMPT_TIMEOUT_MS, four
 * times over — and no JS signal handler can run while it is parked. Two
 * things depend on those handlers: `cancel`, the operator's documented
 * handle, SIGTERMs the watcher and expects it to die; and keepawake's release
 * runs from the same handler, so a sender that escalates to SIGKILL past its
 * grace period orphans the inhibitor. Both are measured, in overnight.test.
 *
 * Resolves, never rejects: a missing binary arrives asynchronously as an
 * 'error' event, and an unheard 'error' event is thrown from outside any
 * try/catch the caller could have. Its `status: null` reads as "did not
 * take", which is the babysitter's business, not an exception's.
 */
export function runResume(argv, { cwd, timeoutMs = RESUME_ATTEMPT_TIMEOUT_MS, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(argv[0], argv.slice(1), {
        cwd,
        // Never a pipe: the output was captured and discarded before, and a
        // buffered pipe would cap a long resume at maxBuffer instead.
        stdio: 'ignore',
        // The argv is the whole command. No shell, ever.
        shell: false,
      });
    } catch {
      resolve({ status: null, signal: null });
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* it finished between the timer firing and this line */
      }
    }, timeoutMs);
    child.on('error', () => finish({ status: null, signal: null }));
    child.on('exit', (status, signal) => finish({ status, signal }));
  });
}

// ------------------------------------------------------------ subcommands

function doSchedule(repo, flags) {
  const marker = readSmallJson(join(repo, MARKER_RELPATH));
  if (marker === null) {
    console.error('overnight: no pause marker at .tyran/state/paused-until.json — nothing to schedule');
    process.exit(1);
  }
  const state = readSmallJson(join(repo, RESUME_STATE_RELPATH));
  if (watcherAlive(state)) {
    console.error(`overnight: a watcher is already waiting (pid ${state.pid}, resumes ${state.resume_at}) — cancel it first`);
    process.exit(1);
  }

  const resumeAt = typeof marker.resume_at === 'string' ? marker.resume_at : null;
  const waitMs = resumeAt !== null ? Date.parse(resumeAt) - Date.now() : NaN;
  const windowName = marker.window === 'seven_day' ? 'weekly' : 'five-hour';

  if (scheduleDecision(marker, { forceResume: flags['force-resume'] === true }).action === 'hold') {
    writeStateFile(repo, {
      state: 'holding',
      window: marker.window ?? null,
      resume_at: resumeAt,
      held_at: new Date().toISOString(),
    });
    const body = `Paused on the ${windowName} usage limit; the window resets ${resumeAt ?? 'at an unknown time'} (${humanWait(waitMs)}). Holding — nothing resumes without you.`;
    notifyDesktop('Tyran: long pause', body);
    log(repo, `hold window=${marker.window} resume_at=${resumeAt}`);
    console.log(
      `overnight: LONG pause on the ${windowName} window — holding, per limits.long_wait.\n` +
        `  window resets: ${resumeAt ?? 'unknown'} (${humanWait(waitMs)})\n` +
        `  resume later:  node "${SELF}" schedule --force-resume   # spawns the watcher despite the hold\n` +
        `  or simply start a new session after the reset — the gate self-clears the marker.`,
    );
    return;
  }

  // The gate legally writes session_id: null (a pause with no live session).
  // A watcher spawned for such a marker has nothing it could ever resume.
  if (typeof marker.session_id !== 'string' || !SESSION_ID_RE.test(marker.session_id)) {
    console.error('overnight: the marker carries no usable session id — resume by hand');
    process.exit(1);
  }

  // A warning, never a refusal: the operator is about to leave a machine
  // waiting for hours, and whether it stays awake is their call to make with
  // the risk named. Only on the watch path — a hold waits for nothing.
  if (readLimitsFile(repo).keep_awake === true) {
    console.log('overnight: keep-awake is on — the system stays awake while the watcher waits (the display and the screen lock are untouched).');
  } else {
    console.error(
      'overnight: keep-awake is OFF — if this machine sleeps before the reset, the watcher sleeps with it and the ' +
        'resume fires late or never. Set limits.keep_awake: true in .tyran/config.yaml to hold the SYSTEM awake ' +
        'while it waits; the display and the screen lock are untouched.',
    );
  }

  const logFd = openSync(join(repo, RESUME_LOG_RELPATH), 'a');
  const watcherArgv = [
    SELF,
    '--wait',
    '--dir',
    repo,
    ...(typeof flags.prompt === 'string' ? ['--prompt', flags.prompt] : []),
    ...(typeof flags.cmd === 'string' ? ['--cmd', flags.cmd] : []),
    ...(typeof flags['chunk-ms'] === 'number' ? ['--chunk-ms', String(flags['chunk-ms'])] : []),
    ...(typeof flags['backoff-ms'] === 'number' ? ['--backoff-ms', String(flags['backoff-ms'])] : []),
  ];
  const child = spawn(process.execPath, watcherArgv, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  writeStateFile(repo, {
    state: 'waiting',
    pid: child.pid,
    window: marker.window ?? null,
    resume_at: resumeAt,
    session_id: marker.session_id,
    started_at: new Date().toISOString(),
  });
  const body = `Paused on the ${windowName} usage limit; resuming automatically ${resumeAt ?? 'after the reset'} (${humanWait(waitMs)}).`;
  notifyDesktop('Tyran: paused, resume scheduled', body);
  log(repo, `scheduled pid=${child.pid} window=${marker.window} resume_at=${resumeAt}`);
  console.log(`overnight: watcher pid ${child.pid} resumes this session at ${resumeAt ?? 'the reset'} (${humanWait(waitMs)})`);
}

async function doWait(repo, flags) {
  // Capped: the heartbeat's freshness window is derived from the maximum
  // chunk, so a longer custom sleep would make a live watcher look dead.
  const chunkMs = Math.min(typeof flags['chunk-ms'] === 'number' ? flags['chunk-ms'] : MAX_SLEEP_CHUNK_MS, MAX_SLEEP_CHUNK_MS);
  // --backoff-ms replaces every rung: the real ladder's first rung is minutes,
  // which puts the retry path beyond the reach of any test that keeps it real.
  const backoffs =
    typeof flags['backoff-ms'] === 'number' ? RESUME_BACKOFFS_MS.map(() => flags['backoff-ms']) : RESUME_BACKOFFS_MS;
  const prompt = typeof flags.prompt === 'string' ? flags.prompt : null;
  const cmd = typeof flags.cmd === 'string' ? flags.cmd : 'claude';

  // The whole point of this process is to be asleep for hours, and a laptop
  // that suspends during that window is the measured way an overnight run
  // dies. The wrap covers the resume too: the resumed `claude -p` IS the
  // overnight work, and a machine that suspends mid-session kills it.
  //
  // Opt-in, and released on every exit path including SIGTERM — which is what
  // `cancel` sends. That release runs from a JS signal handler, so NOTHING
  // inside this region may block the event loop: a sync child would defer the
  // handler for its whole runtime and make `cancel` a no-op meanwhile. Hence
  // runResume rather than spawnSync.
  return withKeepAwake(
    { enabled: readLimitsFile(repo).keep_awake === true, onNote: (message) => log(repo, message) },
    () => runWaitLoop(repo, { chunkMs, backoffs, prompt, cmd }),
  );
}

async function runWaitLoop(repo, { chunkMs, backoffs, prompt, cmd }) {
  for (;;) {
    const marker = readSmallJson(join(repo, MARKER_RELPATH));
    if (marker === null) {
      log(repo, 'skip: marker-gone');
      writeStateFile(repo, { state: 'skipped', reason: 'marker-gone', at: new Date().toISOString() });
      return;
    }
    const resumeAtMs = Date.parse(typeof marker.resume_at === 'string' ? marker.resume_at : '');
    if (!Number.isFinite(resumeAtMs)) {
      log(repo, 'skip: marker has no usable resume_at');
      writeStateFile(repo, { state: 'failed', reason: 'bad-marker', at: new Date().toISOString() });
      return;
    }
    const sleepMs = nextSleepMs(Date.now(), resumeAtMs, chunkMs);
    if (sleepMs > 0) {
      // The heartbeat is what lets schedule/cancel trust an alive pid: a
      // recycled pid never stamps one, and a watcher that overslept a day
      // stamps it again the instant the machine wakes.
      const state = readSmallJson(join(repo, RESUME_STATE_RELPATH)) ?? {};
      writeStateFile(repo, { ...state, state: 'waiting', pid: process.pid, resume_at: marker.resume_at ?? null, heartbeat_at: new Date().toISOString() });
      await new Promise((r) => setTimeout(r, sleepMs));
      continue;
    }

    // Reset time reached. Re-check the world before spawning anything.
    const init = typeof marker.init === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(marker.init) ? marker.init : null;
    const journalPath = journalPathFor(repo, init);
    let events = [];
    try {
      events = journalPath !== null && existsSync(journalPath) ? readJournal(journalPath).events : [];
    } catch {
      events = [];
    }
    const reason = skipReason({
      stopped: checkStop(repo).stopped,
      markerExists: true,
      journalEvents: events,
      pausedAtIso: marker.paused_at,
    });
    if (reason !== null) {
      log(repo, `skip: ${reason}`);
      writeStateFile(repo, { state: reason === 'stop-brake' ? 'aborted-stop' : 'skipped', reason, at: new Date().toISOString() });
      return;
    }

    const limits = readLimitsFile(repo);
    const deferral = weeklyDeferral(readSmallJson(join(repo, SIDECAR_RELPATH)), Date.now(), {
      weeklyPausePercent: limits.weekly_pause_at_percent,
      marginMs: limits.resume_margin_minutes * 60 * 1000,
    });
    if (deferral !== null && deferral > Date.now()) {
      const deferredIso = new Date(deferral).toISOString();
      const longAgain = deferral - Date.now() > limits.wait_max_hours * 3600 * 1000;
      if (longAgain && limits.long_wait !== 'resume') {
        log(repo, `hold-at-wake: weekly still over threshold, resets ${deferredIso}`);
        notifyDesktop('Tyran: still limited', `The weekly window is still exhausted; it resets ${deferredIso}. Holding — nothing resumes without you.`);
        writeStateFile(repo, { state: 'holding', reason: 'weekly-still-exhausted', resume_at: deferredIso, at: new Date().toISOString() });
        return;
      }
      log(repo, `weekly-deferral: rescheduling to ${deferredIso}`);
      writeFileSync(join(repo, MARKER_RELPATH), JSON.stringify({ ...marker, resume_at: deferredIso, window: 'seven_day' }, null, 2) + '\n');
      writeStateFile(repo, { state: 'waiting', pid: process.pid, resume_at: deferredIso, window: 'seven_day', started_at: new Date().toISOString() });
      continue;
    }

    // Build the argv BEFORE touching the marker: the gate legally writes
    // session_id: null, and a marker that cannot be resumed must survive on
    // disk so doctor's stale-pause warning has its evidence.
    let argv;
    try {
      argv = resumeArgv(marker.session_id, prompt ?? defaultPrompt(init), { cmd });
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      log(repo, 'failed: bad-session-id');
      writeStateFile(repo, { state: 'failed', reason: 'bad-session-id', at: new Date().toISOString() });
      notifyDesktop('Tyran: resume FAILED', 'The pause marker carries no usable session id — resume the session by hand.');
      return;
    }
    // Go. Clear the marker so the resumed session's gate starts clean.
    try {
      unlinkSync(join(repo, MARKER_RELPATH));
    } catch {
      /* best effort */
    }
    const eventsBefore = journalEventCount(journalPath);
    for (let attempt = 0; ; attempt++) {
      log(repo, `resuming attempt=${attempt + 1} argv=${argv[0]} session=${marker.session_id}`);
      writeStateFile(repo, { state: 'resuming', attempt: attempt + 1, at: new Date().toISOString() });
      notifyDesktop('Tyran: resuming', `The usage window has reset; resuming the paused session${init ? ` (${init})` : ''}.`);
      const child = await runResume(argv, { cwd: repo });
      const eventsAfter = journalEventCount(journalPath);
      const took =
        eventsBefore === null || eventsAfter === null
          ? child.status === 0
          : resumeTook({ eventsBefore, eventsAfter });
      log(repo, `claude exited status=${child.status} signal=${child.signal ?? 'none'} took=${took}`);
      if (took) {
        writeStateFile(repo, { state: 'done', at: new Date().toISOString() });
        return;
      }
      if (attempt >= backoffs.length) {
        writeStateFile(repo, { state: 'failed', reason: 'resume-did-not-take', exit: child.status, at: new Date().toISOString() });
        notifyDesktop('Tyran: resume FAILED', 'The scheduled resume did not take (no journal movement). See .tyran/state/resume.log.');
        return;
      }
      if (checkStop(repo).stopped) {
        log(repo, 'abort during backoff: stop-brake');
        writeStateFile(repo, { state: 'aborted-stop', at: new Date().toISOString() });
        return;
      }
      await new Promise((r) => setTimeout(r, backoffs[attempt]));
    }
  }
}

function doStatus(repo) {
  const marker = readSmallJson(join(repo, MARKER_RELPATH));
  const state = readSmallJson(join(repo, RESUME_STATE_RELPATH));
  if (marker === null && state === null) {
    console.log('overnight: no pause marker and no watcher state — nothing scheduled');
    return;
  }
  if (marker !== null) {
    const waitMs = Date.parse(marker.resume_at ?? '') - Date.now();
    console.log(
      `paused: window=${escapeInvisible(String(marker.window))} used=${marker.used_percentage}% ` +
        `resume_at=${escapeInvisible(String(marker.resume_at))} (${humanWait(waitMs)}) long_wait=${marker.long_wait}`,
    );
  } else {
    console.log('no active pause marker');
  }
  if (state !== null) {
    const alive = state.state === 'waiting' ? ` (pid ${state.pid} ${watcherAlive(state) ? 'alive' : 'DEAD'})` : '';
    console.log(`watcher: ${escapeInvisible(String(state.state))}${alive}`);
  }
}

function doCancel(repo, flags) {
  const state = readSmallJson(join(repo, RESUME_STATE_RELPATH));
  if (watcherAlive(state)) {
    try {
      process.kill(state.pid, 'SIGTERM');
      console.log(`overnight: watcher pid ${state.pid} cancelled`);
    } catch (err) {
      console.error(`overnight: could not signal pid ${state.pid} (${err.code ?? err.message})`);
    }
  } else {
    console.log('overnight: no live watcher to cancel');
  }
  writeStateFile(repo, { state: 'cancelled', at: new Date().toISOString() });
  if (flags.clear === true) {
    try {
      unlinkSync(join(repo, MARKER_RELPATH));
      console.log('overnight: pause marker cleared — the operator has taken over');
    } catch {
      console.log('overnight: no marker to clear');
    }
  }
}

// ------------------------------------------------------------------- CLI

const BOOLEAN_FLAGS = ['force-resume', 'clear', 'wait'];
const NUMERIC_FLAGS = ['chunk-ms', 'backoff-ms'];
const VALUE_FLAGS = ['dir', 'prompt', 'cmd', ...NUMERIC_FLAGS];

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.includes(name)) flags[name] = true;
    else if (VALUE_FLAGS.includes(name)) {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`flag --${name} needs a value`);
      if (NUMERIC_FLAGS.includes(name)) {
        // NaN or a non-positive number would make nextSleepMs fire the watcher
        // immediately — hours early — instead of failing here, loudly.
        const ms = Number(value);
        if (!Number.isFinite(ms) || ms <= 0) throw new UsageError(`flag --${name} needs a positive number of milliseconds`);
        flags[name] = ms;
      } else flags[name] = value;
      i += 1;
    } else throw new UsageError(`unknown flag --${name}`);
  }
  return { flags, positionals };
}

const SELF = fileURLToPath(import.meta.url);

async function main() {
  const usage = 'usage: overnight.mjs <schedule|status|cancel> [--dir <repo>] · schedule [--force-resume] [--prompt <t>] [--cmd <exe>] · cancel [--clear]';
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`overnight: ${err.message}`);
    console.error(usage);
    process.exit(2);
  }
  const { flags, positionals } = parsed;
  const repo = resolve(typeof flags.dir === 'string' ? flags.dir : process.cwd());
  const command = flags.wait === true ? '--wait' : positionals[0];
  if (command === 'schedule') return doSchedule(repo, flags);
  if (command === '--wait') return doWait(repo, flags);
  if (command === 'status') return doStatus(repo);
  if (command === 'cancel') return doCancel(repo, flags);
  console.error(usage);
  process.exit(2);
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

if (isMainModule(import.meta.url)) await main();
