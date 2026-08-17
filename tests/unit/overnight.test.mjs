/**
 * Tests for the overnight scheduler/watcher.
 *
 * The pure helpers carry the policy (hold vs watch, skip conditions, weekly
 * deferral, journal-movement success), so they are tested exhaustively; the
 * end-to-end smoke proves the detached plumbing with a stub `claude` and a
 * resume time already in the past.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MARKER_RELPATH,
  RESUME_LOG_RELPATH,
  RESUME_STATE_RELPATH,
  RESUME_BACKOFFS_MS,
  SIDECAR_RELPATH,
  WATCHER_MAX_OVERRUN_MS,
  humanWait,
  nextSleepMs,
  notifyDesktop,
  pidAlive,
  resumeArgv,
  resumeTook,
  runResume,
  scheduleDecision,
  skipReason,
  watcherAlive,
  HEARTBEAT_FRESH_MS,
  weeklyDeferral,
} from '../../scripts/overnight.mjs';
// The platform matrix has one home; this test asks it whether to expect an
// inhibitor process at all, rather than spelling the platforms out again.
import { inhibitorArgv } from '../../scripts/keepawake.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/overnight.mjs', import.meta.url));
const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const SESSION = 'f9271c9c-e951-47be-af1f-a5742c6df046';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-overnight-'));
  mkdirSync(join(dir, '.tyran', 'state', 'demo'), { recursive: true });
  return dir;
}

const marker = (over = {}) => ({
  paused_at: new Date(NOW).toISOString(),
  window: 'five_hour',
  used_percentage: 98,
  resume_at: new Date(NOW + 3600e3).toISOString(),
  long_wait: false,
  long_wait_policy: 'hold',
  session_id: SESSION,
  init: 'demo',
  ...over,
});

async function waitForDeath(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) && Date.now() < deadline) await new Promise((tick) => setTimeout(tick, 25));
  return !pidAlive(pid);
}

async function waitForFile(path, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await new Promise((tick) => setTimeout(tick, 25));
  return existsSync(path);
}

/** Kill a pid recorded by a stub, if it is still around. Cleanup only. */
function reap(pidFile) {
  if (!existsSync(pidFile)) return;
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL');
  } catch {
    /* already gone */
  }
}

// spawnSync, not execFileSync: the latter discards stderr on the SUCCESS path,
// and the keep-awake warning is stderr on a command that exits 0.
function run(args, { cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd,
    // HOME first, so a caller can still override it: the overnight scheduler
    // reads usage telemetry, which now falls back to `~/.claude.json`, and a
    // test that read the developer's real account would pass or fail by
    // accident of how much they had used that day.
    env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'tyran-nohome-')), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// -------------------------------------------------------------- the policy

test('scheduleDecision: hold on a long wait by default; resume policy or --force-resume overrides', () => {
  assert.equal(scheduleDecision(marker({ long_wait: true })).action, 'hold');
  assert.equal(scheduleDecision(marker({ long_wait: true, long_wait_policy: 'resume' })).action, 'watch');
  assert.equal(scheduleDecision(marker({ long_wait: true }), { forceResume: true }).action, 'watch');
  assert.equal(scheduleDecision(marker()).action, 'watch', 'a short wait always watches');
});

test('skipReason: STOP outranks everything; a closed gate or later checkpoint means someone was here', () => {
  const paused = new Date(NOW).toISOString();
  const gate = (result) => ({ ts: new Date(NOW + 60e3).toISOString(), ev: 'gate', data: { kind: 'usage-limit', result } });
  const checkpoint = (phase, atMs) => ({ ts: new Date(atMs).toISOString(), ev: 'checkpoint', data: { phase } });

  assert.equal(skipReason({ stopped: true, markerExists: true, journalEvents: [], pausedAtIso: paused }), 'stop-brake');
  assert.equal(skipReason({ stopped: false, markerExists: false, journalEvents: [], pausedAtIso: paused }), 'marker-gone');
  assert.equal(skipReason({ stopped: false, markerExists: true, journalEvents: [gate('passed')], pausedAtIso: paused }), 'gate-already-closed');
  assert.equal(
    skipReason({ stopped: false, markerExists: true, journalEvents: [checkpoint('back-to-work', NOW + 120e3)], pausedAtIso: paused }),
    'resumed-manually',
  );
  // the pause's own checkpoint does not count as a manual resume
  assert.equal(
    skipReason({ stopped: false, markerExists: true, journalEvents: [checkpoint('usage-limit-pause', NOW + 30e3), gate('WAITING_ON_RESET')], pausedAtIso: paused }),
    null,
  );
});

test('skipReason: only THIS pause cycle\'s gate events count', () => {
  const paused = new Date(NOW).toISOString();
  const gateAt = (atMs, result) => ({ ts: new Date(atMs).toISOString(), ev: 'gate', data: { kind: 'usage-limit', result } });

  // a gate closed three days before this pause belongs to an earlier cycle
  assert.equal(
    skipReason({ stopped: false, markerExists: true, journalEvents: [gateAt(NOW - 3 * 24 * 3600e3, 'passed')], pausedAtIso: paused }),
    null,
  );
  assert.equal(
    skipReason({ stopped: false, markerExists: true, journalEvents: [gateAt(NOW + 60e3, 'passed')], pausedAtIso: paused }),
    'gate-already-closed',
  );
  assert.equal(
    skipReason({ stopped: false, markerExists: true, journalEvents: [gateAt(NOW + 60e3, 'WAITING_ON_RESET')], pausedAtIso: paused }),
    null,
  );
});

test('weeklyDeferral: fresh over-threshold telemetry defers to the weekly reset; stale or clean does not', () => {
  const opts = { weeklyPausePercent: 97, marginMs: 5 * 60e3 };
  const fresh = {
    written_at: new Date(NOW - 60e3).toISOString(),
    seven_day: { used_percentage: 99, resets_at: Math.floor((NOW + 48 * 3600e3) / 1000) },
  };
  assert.equal(weeklyDeferral(fresh, NOW, opts), NOW + 48 * 3600e3 + 5 * 60e3);
  const stale = { ...fresh, written_at: new Date(NOW - 3 * 3600e3).toISOString() };
  assert.equal(weeklyDeferral(stale, NOW, opts), null, 'stale telemetry is unknown, and unknown proceeds');
  const clean = { ...fresh, seven_day: { used_percentage: 40, resets_at: 1 } };
  assert.equal(weeklyDeferral(clean, NOW, opts), null);
  assert.equal(weeklyDeferral(null, NOW, opts), null);
  // the threshold is inclusive: AT the pause percent the window is exhausted
  const atThreshold = { ...fresh, seven_day: { ...fresh.seven_day, used_percentage: 97 } };
  assert.equal(weeklyDeferral(atThreshold, NOW, opts), NOW + 48 * 3600e3 + 5 * 60e3);
  const justBelow = { ...fresh, seven_day: { ...fresh.seven_day, used_percentage: 96.9 } };
  assert.equal(weeklyDeferral(justBelow, NOW, opts), null);
});

test('resumeArgv shape-validates the session id and never builds a shell string', () => {
  const argv = resumeArgv(SESSION, 'continue');
  assert.deepEqual(argv, ['claude', '-p', '--resume', SESSION, '--permission-mode', 'acceptEdits', 'continue']);
  assert.throws(() => resumeArgv('nope;rm -rf /', 'x'), /session id/);
  assert.throws(() => resumeArgv(null, 'x'), /session id/);
});

test('resumeTook is journal movement, not exit codes; sleep math clamps to the chunk', () => {
  assert.equal(resumeTook({ eventsBefore: 5, eventsAfter: 6 }), true);
  assert.equal(resumeTook({ eventsBefore: 5, eventsAfter: 5 }), false);
  assert.equal(nextSleepMs(NOW, NOW + 3600e3, 15 * 60e3), 15 * 60e3);
  assert.equal(nextSleepMs(NOW, NOW + 60e3, 15 * 60e3), 60e3);
  assert.equal(nextSleepMs(NOW, NOW - 1, 15 * 60e3), 0);
  assert.equal(RESUME_BACKOFFS_MS.length, 3, 'the ladder is finite on purpose');
});

test('humanWait names days beyond 48h, so a long pause reads as long', () => {
  assert.equal(humanWait(3 * 24 * 3600e3), '~3 days');
  assert.match(humanWait(90 * 60e3), /1h 30m/);
  assert.equal(humanWait(-5), 'now');
});

test('notifyDesktop passes argv arrays and swallows every failure', () => {
  const calls = [];
  notifyDesktop('T', 'body with "quotes"', { run: (cmd, args) => calls.push([cmd, args]) });
  assert.equal(calls.length, 1);
  assert.ok(Array.isArray(calls[0][1]));
  // a runner that throws must not escape
  notifyDesktop('T', 'b', { run: () => { throw new Error('no notifier'); } });
});

test('pidAlive: our own pid is alive, junk is not', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive('nope'), false);
});

test('watcherAlive distrusts an alive pid past the babysit overrun window', () => {
  // process.pid plays the recycled pid: alive, but not the watcher
  const waiting = { state: 'waiting', pid: process.pid, resume_at: new Date(NOW).toISOString() };
  assert.equal(watcherAlive(waiting, NOW + 60e3), true, 'within the window a live pid is trusted');
  assert.equal(watcherAlive(waiting, NOW + WATCHER_MAX_OVERRUN_MS + 1), false, 'past the window even a live pid is not ours');
  assert.equal(watcherAlive({ ...waiting, state: 'done' }, NOW + 60e3), false);
  assert.equal(watcherAlive({ ...waiting, pid: 99999999 }, NOW + 60e3), false);
  assert.equal(watcherAlive(null, NOW), false);
});

test('a fresh heartbeat outranks the overrun clock — an overslept REAL watcher is never disowned', () => {
  // The watcher stamps heartbeat_at every loop iteration; a recycled pid
  // (which never writes one) goes stale within a chunk instead of surviving
  // to resume_at + overrun.
  const overslept = {
    state: 'waiting',
    pid: process.pid,
    resume_at: new Date(NOW - WATCHER_MAX_OVERRUN_MS - 3600e3).toISOString(),
    heartbeat_at: new Date(NOW - 1000).toISOString(),
  };
  assert.equal(watcherAlive(overslept, NOW), true, 'a live pid with a fresh heartbeat IS the watcher, however late');
  const stale = { ...overslept, resume_at: new Date(NOW + 3600e3).toISOString(), heartbeat_at: new Date(NOW - HEARTBEAT_FRESH_MS - 1000).toISOString() };
  assert.equal(watcherAlive(stale, NOW), false, 'a stale heartbeat means reboot/recycling — dead even before resume_at');
});

// ------------------------------------------------------------------ wiring

test('schedule refuses without a marker; holds on a long wait with instructions', () => {
  const dir = repo();
  const none = run(['schedule', '--dir', dir]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no pause marker/);

  writeFileSync(join(dir, MARKER_RELPATH), JSON.stringify(marker({ long_wait: true, resume_at: new Date(Date.now() + 50 * 3600e3).toISOString() })));
  const held = run(['schedule', '--dir', dir]);
  assert.equal(held.code, 0);
  assert.match(held.stdout, /LONG pause/);
  assert.match(held.stdout, /--force-resume/);
  const state = JSON.parse(readFileSync(join(dir, RESUME_STATE_RELPATH), 'utf8'));
  assert.equal(state.state, 'holding');
});

test('end to end: a past resume_at resumes via the stub claude and reports done', () => {
  const dir = repo();
  // a stub `claude` that appends a journal event, so resumeTook sees movement
  const journal = join(dir, '.tyran', 'state', 'demo', 'journal.jsonl');
  writeFileSync(journal, JSON.stringify({ ts: new Date(NOW).toISOString(), ev: 'init.created', init: 'demo', actor: 'conductor', data: {} }) + '\n');
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, 'claude');
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' '{"ts":"${new Date(NOW + 1000).toISOString()}","ev":"checkpoint","init":"demo","actor":"conductor","data":{"phase":"resumed","next_steps":["x"]}}' >> "${journal}"\n`,
  );
  chmodSync(stub, 0o755);

  writeFileSync(join(dir, MARKER_RELPATH), JSON.stringify(marker({ resume_at: new Date(Date.now() - 1000).toISOString() })));
  const r = run(['--wait', '--dir', dir, '--cmd', stub, '--chunk-ms', '50']);
  assert.equal(r.code, 0, r.stderr);
  const state = JSON.parse(readFileSync(join(dir, RESUME_STATE_RELPATH), 'utf8'));
  assert.equal(state.state, 'done', JSON.stringify(state));
  assert.equal(existsSync(join(dir, MARKER_RELPATH)), false, 'the marker is cleared before the resume');
});

test('the watcher aborts on the STOP brake instead of resuming', () => {
  const dir = repo();
  writeFileSync(join(dir, '.tyran', 'STOP'), 'operator said stop\n');
  writeFileSync(join(dir, MARKER_RELPATH), JSON.stringify(marker({ resume_at: new Date(Date.now() - 1000).toISOString() })));
  const r = run(['--wait', '--dir', dir, '--cmd', '/does/not/matter', '--chunk-ms', '50']);
  assert.equal(r.code, 0);
  const state = JSON.parse(readFileSync(join(dir, RESUME_STATE_RELPATH), 'utf8'));
  assert.equal(state.state, 'aborted-stop');
  assert.ok(existsSync(join(dir, MARKER_RELPATH)), 'STOP preserves the marker for the operator');
});

test('cancel --clear kills nothing when nothing runs, and clears the marker', () => {
  const dir = repo();
  writeFileSync(join(dir, MARKER_RELPATH), JSON.stringify(marker()));
  const r = run(['cancel', '--dir', dir, '--clear']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /taken over/);
  assert.equal(existsSync(join(dir, MARKER_RELPATH)), false);
});

test('status is honest about a dead watcher pid', () => {
  const dir = repo();
  writeFileSync(join(dir, MARKER_RELPATH), JSON.stringify(marker()));
  writeFileSync(join(dir, RESUME_STATE_RELPATH), JSON.stringify({ state: 'waiting', pid: 99999999, resume_at: marker().resume_at }));
  const r = run(['status', '--dir', dir]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /DEAD/);
});

test('schedule refuses a marker whose session id is unusable, before spawning anything', () => {
  const dir = repo();
  writeFileSync(join(dir, MARKER_RELPATH), JSON.stringify(marker({ session_id: null })));
  const r = run(['schedule', '--dir', dir]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no usable session id/);
  assert.equal(existsSync(join(dir, RESUME_STATE_RELPATH)), false, 'no waiting state was written');
});

test('the watcher fails visibly on a session_id-null marker and leaves the marker for doctor', () => {
  const dir = repo();
  writeFileSync(join(dir, MARKER_RELPATH), JSON.stringify(marker({ session_id: null, resume_at: new Date(Date.now() - 1000).toISOString() })));
  const r = run(['--wait', '--dir', dir, '--chunk-ms', '50']);
  assert.equal(r.code, 0, r.stderr);
  const state = JSON.parse(readFileSync(join(dir, RESUME_STATE_RELPATH), 'utf8'));
  assert.equal(state.state, 'failed', JSON.stringify(state));
  assert.equal(state.reason, 'bad-session-id');
  assert.ok(existsSync(join(dir, MARKER_RELPATH)), 'the marker survives, so the stale-pause warning can fire');
});

test('the babysit ladder exhausts every rung, then fails, when the journal never moves', () => {
  const dir = repo();
  const journal = join(dir, '.tyran', 'state', 'demo', 'journal.jsonl');
  writeFileSync(journal, JSON.stringify({ ts: new Date(NOW).toISOString(), ev: 'init.created', init: 'demo', actor: 'conductor', data: {} }) + '\n');
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  // a stub that exits 0 but appends NOTHING to the journal — the silent failure
  const calls = join(bin, 'calls.txt');
  const stub = join(bin, 'claude');
  writeFileSync(stub, `#!/bin/sh\nprintf 'call\\n' >> "${calls}"\n`);
  chmodSync(stub, 0o755);

  writeFileSync(join(dir, MARKER_RELPATH), JSON.stringify(marker({ resume_at: new Date(Date.now() - 1000).toISOString() })));
  const r = run(['--wait', '--dir', dir, '--cmd', stub, '--chunk-ms', '50', '--backoff-ms', '10']);
  assert.equal(r.code, 0, r.stderr);
  const state = JSON.parse(readFileSync(join(dir, RESUME_STATE_RELPATH), 'utf8'));
  assert.equal(state.state, 'failed', JSON.stringify(state));
  assert.equal(state.reason, 'resume-did-not-take');
  const invocations = readFileSync(calls, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(invocations, RESUME_BACKOFFS_MS.length + 1, 'the first attempt plus one retry per rung');
});

test('schedule forwards --prompt and --cmd to the watcher it spawns', async () => {
  const dir = repo();
  const journal = join(dir, '.tyran', 'state', 'demo', 'journal.jsonl');
  writeFileSync(journal, JSON.stringify({ ts: new Date(NOW).toISOString(), ev: 'init.created', init: 'demo', actor: 'conductor', data: {} }) + '\n');
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  // records its argv, then appends a journal event so the watcher exits 'done'
  const argvFile = join(bin, 'argv.txt');
  const stub = join(bin, 'claude');
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> "${argvFile}"\n` +
      `printf '%s\\n' '{"ts":"${new Date(NOW + 1000).toISOString()}","ev":"checkpoint","init":"demo","actor":"conductor","data":{"phase":"resumed","next_steps":["x"]}}' >> "${journal}"\n`,
  );
  chmodSync(stub, 0o755);

  writeFileSync(join(dir, MARKER_RELPATH), JSON.stringify(marker({ resume_at: new Date(Date.now() + 2000).toISOString() })));
  const r = run(['schedule', '--dir', dir, '--cmd', stub, '--prompt', 'SENTINEL-PROMPT', '--chunk-ms', '100', '--backoff-ms', '10']);
  assert.equal(r.code, 0, r.stderr);
  const state = JSON.parse(readFileSync(join(dir, RESUME_STATE_RELPATH), 'utf8'));
  assert.equal(state.state, 'waiting', JSON.stringify(state));
  assert.ok(pidAlive(state.pid), 'the watcher is running');
  try {
    const deadline = Date.now() + 15000;
    while (!existsSync(argvFile) && Date.now() < deadline) await new Promise((tick) => setTimeout(tick, 100));
    assert.ok(existsSync(argvFile), 'the watcher invoked the stub');
    assert.match(readFileSync(argvFile, 'utf8'), /SENTINEL-PROMPT/);
  } finally {
    if (pidAlive(state.pid)) {
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch {
        /* it finished on its own */
      }
    }
  }
});

test('at wake, fresh telemetry over the weekly threshold holds instead of burning the refill', () => {
  const dir = repo();
  writeFileSync(join(dir, '.tyran', 'config.yaml'), 'limits:\n  mode: pause\n  weekly_pause_at_percent: 60\n  pause_at_percent: 97\n');
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const calls = join(bin, 'calls.txt');
  const stub = join(bin, 'claude');
  writeFileSync(stub, `#!/bin/sh\nprintf 'call\\n' >> "${calls}"\n`);
  chmodSync(stub, 0o755);

  const resetsAt = Math.floor((Date.now() + 3 * 24 * 3600e3) / 1000);
  writeFileSync(
    join(dir, SIDECAR_RELPATH),
    JSON.stringify({
      written_at: new Date().toISOString(),
      seven_day: { used_percentage: 70, resets_at: resetsAt },
      five_hour: { used_percentage: 5 },
    }),
  );
  writeFileSync(join(dir, MARKER_RELPATH), JSON.stringify(marker({ resume_at: new Date(Date.now() - 1000).toISOString() })));
  const r = run(['--wait', '--dir', dir, '--cmd', stub, '--chunk-ms', '50']);
  assert.equal(r.code, 0, r.stderr);
  const state = JSON.parse(readFileSync(join(dir, RESUME_STATE_RELPATH), 'utf8'));
  assert.equal(state.state, 'holding', JSON.stringify(state));
  assert.equal(state.reason, 'weekly-still-exhausted');
  // resets_at is epoch SECONDS; the margin is the default 5 resume_margin_minutes
  assert.equal(state.resume_at, new Date(resetsAt * 1000 + 5 * 60 * 1000).toISOString());
  assert.equal(existsSync(calls), false, 'no resume attempt was made');
});

// ------------------------------------------------------------- keep-awake

/**
 * A watcher that sleeps for hours is defeated by a laptop that does the same.
 * The knob is off by default, so the only thing standing between an operator
 * and a silently lost night is the warning below — which is why it is a
 * warning and never a refusal: it is their machine and their call.
 */

test('schedule WARNS when keep-awake is off, naming the risk and the key — and still schedules', () => {
  // M15: drop the warning. The operator schedules an overnight wait on a
  // machine whose screensaver starts in five minutes, learns nothing, and
  // finds the work unfinished in the morning with an API error in the log.
  const dir = repo();
  writeFileSync(join(dir, MARKER_RELPATH), JSON.stringify(marker({ resume_at: new Date(Date.now() + 3600e3).toISOString() })));
  const r = run(['schedule', '--dir', dir]);
  const state = JSON.parse(readFileSync(join(dir, RESUME_STATE_RELPATH), 'utf8'));
  try {
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /keep-awake is OFF/);
    assert.match(r.stderr, /sleeps.+watcher sleeps with it/s, 'the warning names the risk, not just the setting');
    assert.match(r.stderr, /limits\.keep_awake: true in \.tyran\/config\.yaml/, 'and the exact key that fixes it');
    // M16: turn it into a refusal. A tool that will not do the work until the
    // machine is configured its way is a tool that gets worked around.
    assert.equal(state.state, 'waiting', 'a warning, never a refusal — the watcher was scheduled anyway');
  } finally {
    if (pidAlive(state?.pid)) {
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch {
        /* it finished on its own */
      }
    }
  }
});

test('with the knob on, schedule says so instead of warning', () => {
  // M17: print the warning unconditionally. A warning that fires when the
  // thing it warns about is already handled is a warning people stop reading.
  const dir = repo();
  writeFileSync(join(dir, '.tyran', 'config.yaml'), 'limits:\n  mode: pause\n  keep_awake: true\n');
  writeFileSync(join(dir, MARKER_RELPATH), JSON.stringify(marker({ resume_at: new Date(Date.now() + 3600e3).toISOString() })));
  const r = run(['schedule', '--dir', dir]);
  const state = JSON.parse(readFileSync(join(dir, RESUME_STATE_RELPATH), 'utf8'));
  try {
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /keep-awake is OFF/);
    assert.match(r.stdout, /keep-awake is on/);
    assert.match(r.stdout, /screen lock are untouched/, 'the security trade is stated where it is made');
  } finally {
    if (pidAlive(state?.pid)) {
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch {
        /* it finished on its own */
      }
    }
  }
});

test('the watcher wraps its OWN wait in the inhibitor when the knob is on', () => {
  // M18: leave the knob wired to nothing but the schedule message. `schedule`
  // reports that the machine will stay awake while the watcher acquires
  // nothing — a feature that ships, reads as working, and does not work. The
  // note is written before the spawn, so this holds on every platform,
  // including the ones with no inhibitor at all.
  const dir = repo();
  writeFileSync(join(dir, '.tyran', 'config.yaml'), 'limits:\n  mode: pause\n  keep_awake: true\n');
  const journal = join(dir, '.tyran', 'state', 'demo', 'journal.jsonl');
  writeFileSync(journal, JSON.stringify({ ts: new Date(NOW).toISOString(), ev: 'init.created', init: 'demo', actor: 'conductor', data: {} }) + '\n');
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, 'claude');
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' '{"ts":"${new Date(NOW + 1000).toISOString()}","ev":"checkpoint","init":"demo","actor":"conductor","data":{"phase":"resumed","next_steps":["x"]}}' >> "${journal}"\n`,
  );
  chmodSync(stub, 0o755);

  writeFileSync(join(dir, MARKER_RELPATH), JSON.stringify(marker({ resume_at: new Date(Date.now() - 1000).toISOString() })));
  const r = run(['--wait', '--dir', dir, '--cmd', stub, '--chunk-ms', '50']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, RESUME_STATE_RELPATH), 'utf8')).state, 'done');
  assert.match(readFileSync(join(dir, RESUME_LOG_RELPATH), 'utf8'), /keep-awake: (holding the system awake|no inhibitor)/);
});

test('with the knob off the watcher acquires nothing — the default changes no machine', () => {
  // M19: default the knob on. Every repo that adopts Tyran starts refusing to
  // let its owner's laptop sleep, without anyone having asked for it.
  const dir = repo();
  writeFileSync(join(dir, MARKER_RELPATH), JSON.stringify(marker({ session_id: null, resume_at: new Date(Date.now() - 1000).toISOString() })));
  const r = run(['--wait', '--dir', dir, '--chunk-ms', '50']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(readFileSync(join(dir, RESUME_LOG_RELPATH), 'utf8'), /keep-awake/);
});

test('SIGTERM still kills the watcher DURING a resume attempt, and takes the inhibitor with it', async () => {
  // M20: run the attempt with `spawnSync`. The keep-awake wrap installs JS
  // signal handlers, and a sync child parks the event loop for the attempt's
  // whole life, so none of them can run. Measured on the mutant:
  // a SIGTERM that kills the watcher in 4ms with the knob off was swallowed for
  // the stub's full 25s with it on — and in production one attempt is capped at
  // RESUME_ATTEMPT_TIMEOUT_MS (6h), up to four of them. `cancel` is the
  // operator's documented handle for exactly this, and it would do nothing.
  const dir = repo();
  writeFileSync(join(dir, '.tyran', 'config.yaml'), 'limits:\n  mode: pause\n  keep_awake: true\n');
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const inhibitorPidFile = join(dir, 'inhibitor.pid');
  const claudePidFile = join(dir, 'claude.pid');
  // Stubs under the REAL names, first on PATH: keepawake resolves `caffeinate`
  // / `systemd-inhibit` through PATH, and neither real one may ever run — a
  // test that changed the operator's sleep policy is a test with a side effect
  // on their machine. Each execs, so the pid in the file is the signal's target.
  for (const name of ['caffeinate', 'systemd-inhibit']) {
    const stub = join(bin, name);
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$$" > ${JSON.stringify(inhibitorPidFile)}\nexec sleep 600\n`);
    chmodSync(stub, 0o755);
  }
  // A resume that far outlives the signal: the SIGTERM must not wait for it.
  const stub = join(bin, 'claude');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$$" > ${JSON.stringify(claudePidFile)}\nexec sleep 30\n`);
  chmodSync(stub, 0o755);
  writeFileSync(join(dir, MARKER_RELPATH), JSON.stringify(marker({ resume_at: new Date(Date.now() - 1000).toISOString() })));

  const watcher = spawn(process.execPath, [SCRIPT, '--wait', '--dir', dir, '--cmd', stub, '--chunk-ms', '50'], {
    stdio: 'ignore',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const exited = new Promise((res) => watcher.on('exit', (code, signal) => res({ code, signal })));
  try {
    assert.ok(await waitForFile(claudePidFile), 'the stub resume started');
    if (inhibitorArgv() !== null) assert.ok(await waitForFile(inhibitorPidFile, 5000), 'the inhibitor is held');
    watcher.kill('SIGTERM');
    const result = await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('the watcher outlived a SIGTERM sent during its resume attempt')), 10000),
      ),
    ]);
    assert.equal(result.signal, 'SIGTERM', "the watcher dies from the operator's own signal, mid-attempt");
    // M21: release without re-raising, or hold the inhibitor past the handler.
    // A sender that escalates after a grace period — systemd shutdown, macOS
    // logout, `pkill` then a hard kill — reaches SIGKILL before anything runs,
    // and the inhibitor is left holding the machine awake with nothing alive to
    // explain why. That leak is the worst outcome this module has.
    if (inhibitorArgv() !== null) {
      const inhibitor = Number(readFileSync(inhibitorPidFile, 'utf8').trim());
      assert.ok(await waitForDeath(inhibitor), `the inhibitor (pid ${inhibitor}) outlived the watcher that held it`);
    }
  } finally {
    reap(inhibitorPidFile);
    reap(claudePidFile);
    if (watcher.exitCode === null && watcher.signalCode === null) watcher.kill('SIGKILL');
  }
});

test('runResume reclaims a hung attempt at the timeout, and survives a missing binary', async () => {
  // M22: drop the timer. The per-attempt ceiling is hand-rolled here rather
  // than free from spawnSync's `timeout`, and without it a `claude -p` that
  // hangs pins the babysitter on its first rung forever instead of failing.
  const dir = repo();
  const startedAt = Date.now();
  const hung = await runResume(['/bin/sh', '-c', 'exec sleep 30'], { cwd: dir, timeoutMs: 300 });
  assert.equal(hung.signal, 'SIGTERM', 'the attempt was reclaimed, not waited out');
  assert.ok(Date.now() - startedAt < 15000, 'and reclaimed on the timeout, not at the child\'s own pace');
  // M23: drop the 'error' listener. A missing `claude` arrives as an async
  // 'error' event, and an unheard one is thrown from outside any try/catch the
  // watcher could have — measured: it takes the process down where one failed
  // attempt should only have cost one rung of the ladder. With the mutant this
  // whole test FILE dies rather than failing an assertion, which is the point.
  assert.deepEqual(await runResume(['/nonexistent/tyran-claude-that-is-not-there'], { cwd: dir }), {
    status: null,
    signal: null,
  });
  // M24: report a fixed status. With no journal to compare, `took` IS the exit
  // code — a hardcoded null would fail every resume on such a repo, and a
  // hardcoded 0 would call every failed one a success.
  assert.deepEqual(await runResume(['/bin/sh', '-c', 'exit 0'], { cwd: dir }), { status: 0, signal: null });
  assert.deepEqual(await runResume(['/bin/sh', '-c', 'exit 3'], { cwd: dir }), { status: 3, signal: null });
});

test('numeric flags refuse junk that would wake the watcher hours early', () => {
  const dir = repo();
  for (const bad of [['--chunk-ms', 'abc'], ['--chunk-ms', '-5'], ['--backoff-ms', '0']]) {
    const r = run(['--wait', '--dir', dir, ...bad]);
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.match(r.stderr, /needs a positive number/);
  }
});
