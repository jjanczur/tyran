/**
 * stop-check — the operator's brake.
 *
 * The interesting cases are all about the DIRECTION this thing fails in.
 * Every other reading in this codebase fails open so a broken gate cannot
 * block ordinary work. This one must fail CLOSED, because a brake that
 * releases itself when damaged is not a brake — and "damaged" here includes
 * the shapes an agent could produce while trying to get past it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkStop, STOP_PATH } from '../../scripts/stop-check.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/stop-check.mjs', import.meta.url));

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-stop-'));
  mkdirSync(join(dir, '.tyran'));
  return dir;
}

function stop(dir, content) {
  writeFileSync(join(dir, STOP_PATH), content);
}

test('no STOP file means clear', () => {
  const { stopped, reason } = checkStop(repo());
  assert.equal(stopped, false);
  assert.equal(reason, null);
});

test('a STOP file stops, and the first line comes back as the reason', () => {
  const dir = repo();
  stop(dir, 'wrong branch, hold everything\nmore detail below\n');
  const { stopped, reason } = checkStop(dir);
  assert.equal(stopped, true);
  assert.equal(reason, 'wrong branch, hold everything');
});

test('an EMPTY STOP file still stops', () => {
  // `touch .tyran/STOP` is the fastest way an operator can hit the brake,
  // and it is exactly the case a "read the reason" implementation gets wrong.
  const dir = repo();
  stop(dir, '');
  const { stopped, reason } = checkStop(dir);
  assert.equal(stopped, true);
  assert.match(reason, /no reason given/);
});

test('a whitespace-only STOP file still stops', () => {
  const dir = repo();
  stop(dir, '   \n\n');
  assert.equal(checkStop(dir).stopped, true);
});

test('a STOP that is a DIRECTORY stops rather than crashing', () => {
  const dir = repo();
  mkdirSync(join(dir, STOP_PATH));
  const { stopped, reason } = checkStop(dir);
  assert.equal(stopped, true, 'an unreadable brake must engage, not disappear');
  assert.match(reason, /directory/);
});

test('an UNREADABLE STOP file stops — it fails closed', () => {
  const dir = repo();
  stop(dir, 'halt');
  chmodSync(join(dir, STOP_PATH), 0o000);
  const { stopped, reason } = checkStop(dir);
  chmodSync(join(dir, STOP_PATH), 0o644);
  if (process.getuid && process.getuid() === 0) return; // root reads anything
  assert.equal(stopped, true, 'a permission error must not read as "no stop"');
  assert.match(reason, /could not be read/);
});

test('a huge STOP file is truncated rather than read whole', () => {
  const dir = repo();
  stop(dir, `${'x'.repeat(500_000)}\nsecond line`);
  const { reason } = checkStop(dir);
  assert.ok(reason.length <= 2000, `reason was ${reason.length} chars`);
});

test('control characters in the reason are escaped before they reach a terminal', () => {
  const dir = repo();
  // Built from a codepoint, never written as a raw character (ADR-19).
  stop(dir, `halt${String.fromCharCode(0x1b)}[2Jnow`);
  const result = execCli(dir);
  assert.equal(result.status, 1);
  // The needle is BUILT from a codepoint. Writing it as a literal is how a raw
  // ESC ended up in this very file once, which the scanner then caught.
  const clearScreen = String.fromCharCode(0x1b) + "[2J";
  assert.ok(
    !result.stderr.includes(clearScreen),
    "a STOP reason must not be able to clear the operator terminal",
  );
});

test('CLI exits 0 when clear and 1 when stopped', () => {
  const dir = repo();
  const clear = execCli(dir);
  assert.equal(clear.status, 0);
  assert.match(clear.stdout, /clear/);

  stop(dir, 'operator hit the brake');
  const stopped = execCli(dir);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /STOPPED/);
  assert.match(stopped.stderr, /operator hit the brake/);
});

test('--dir checks the repo it was given, not the working directory', () => {
  const target = repo();
  const elsewhere = repo();
  stop(target, 'stop the target');
  const result = execCli(elsewhere, ['--dir', target]);
  assert.equal(result.status, 1, 'the brake must follow --dir, or a worktree run checks the wrong repo');
});

function execCli(cwd, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}
