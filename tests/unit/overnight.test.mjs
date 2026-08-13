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
  humanWait,
  nextSleepMs,
  notifyDesktop,
  pidAlive,
  resumeArgv,
  resumeTook,
  scheduleDecision,
  skipReason,
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
