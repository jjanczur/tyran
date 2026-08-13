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
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MARKER_RELPATH,
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
  scheduleDecision,
  skipReason,
  watcherAlive,
  HEARTBEAT_FRESH_MS,
  weeklyDeferral,
} from '../../scripts/overnight.mjs';

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

function run(args, { cwd, env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
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

test('numeric flags refuse junk that would wake the watcher hours early', () => {
  const dir = repo();
  for (const bad of [['--chunk-ms', 'abc'], ['--chunk-ms', '-5'], ['--backoff-ms', '0']]) {
    const r = run(['--wait', '--dir', dir, ...bad]);
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.match(r.stderr, /needs a positive number/);
  }
});
