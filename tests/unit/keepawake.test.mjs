/**
 * Tests for the system-sleep inhibitor.
 *
 * Two classes of guarantee, and they fail in opposite directions:
 *
 *  - the machine must actually stay awake (the platform matrix, the argv);
 *  - the inhibitor must never outlive its reason. A leaked `caffeinate` keeps
 *    someone's laptop awake indefinitely with nothing on screen to explain
 *    why, which is a worse outcome than the sleep it was preventing.
 *
 * So the release paths are tested harder than the acquire path, and the two
 * that cannot be proven in-process — that an unref'd child does not pin the
 * event loop, and that SIGTERM still kills a process that installed a handler
 * — are proven end to end with a real Node process and a stub inhibitor.
 * `caffeinate` itself is never invoked: a test that really suspended the
 * machine's sleep policy would be a test with a side effect on the operator.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { INHIBIT_SLEEP_SECONDS, KEEP_AWAKE_REASON, inhibitorArgv, keepAwake, withKeepAwake } from '../../scripts/keepawake.mjs';

const MODULE = fileURLToPath(new URL('../../scripts/keepawake.mjs', import.meta.url));

/** A child that records instead of existing. */
function fakeChild() {
  const child = {
    kills: [],
    unrefs: 0,
    listeners: [],
    kill(signal) {
      child.kills.push(signal);
      return true;
    },
    unref() {
      child.unrefs += 1;
    },
    on(event, fn) {
      child.listeners.push(event);
      return child;
    },
  };
  return child;
}

/** A spawn that records its call and never starts a process. */
function recordingSpawn() {
  const calls = [];
  const fn = (command, args, options) => {
    const child = fakeChild();
    calls.push({ command, args, options, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'tyran-keepawake-'));
}

/**
 * A stand-in inhibitor: writes its own pid, then `exec`s sleep so the pid in
 * the file IS the process a signal has to reach. Without the exec, a shell
 * waiting on a foreground child defers the signal and the test hangs.
 */
function stubInhibitor(dir) {
  const stub = join(dir, 'stub-inhibitor');
  writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' "$$" > "$1"\nexec sleep 600\n');
  chmodSync(stub, 0o755);
  return stub;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) await new Promise((tick) => setTimeout(tick, 25));
  return !alive(pid);
}

// ------------------------------------------------------------ the platform matrix

test('macOS blocks SYSTEM sleep and never the display — no -d, ever', () => {
  // M1: add '-d' (or swap -i/-s for it). The machine stays awake AND the
  // screen never locks — a security regression on the exact machine this
  // feature asks you to leave running unattended overnight. The absence is
  // asserted explicitly because a passing "-i and -s are present" test is
  // green with -d sitting right next to them.
  const argv = inhibitorArgv('darwin');
  assert.deepEqual(argv, ['caffeinate', '-i', '-s']);
  assert.ok(argv.includes('-i'), '-i is idle sleep');
  assert.ok(argv.includes('-s'), '-s is sleep on AC power');
  assert.ok(!argv.includes('-d'), '-d is the DISPLAY: it blocks the screen lock and must never appear');
  assert.ok(!argv.some((token) => token.includes('d')), 'no flag smuggles a d in a bundle like -ids');
});

test('Linux inhibits idle and sleep with our own reason and a command to hold the lock', () => {
  // M2: drop the trailing command. `systemd-inhibit` holds its lock only while
  // its COMMAND runs, so an inhibitor with nothing to run exits at once and
  // the machine sleeps while the log claims it is being held awake.
  assert.deepEqual(inhibitorArgv('linux'), [
    'systemd-inhibit',
    '--what=idle:sleep',
    `--why=${KEEP_AWAKE_REASON}`,
    '--mode=block',
    'sleep',
    INHIBIT_SLEEP_SECONDS,
  ]);
  // M3: make `--why` an option. The reason is the only free text the child
  // ever sees, and it is ours: there is no parameter for anything else to
  // reach it through.
  assert.equal(inhibitorArgv('linux').length, inhibitorArgv('linux', 'ignored-second-argument').length);
  assert.match(INHIBIT_SLEEP_SECONDS, /^\d+$/, 'POSIX sleep takes an integer; GNU `infinity` is not portable');
});

test('Linux keeps `sleep` in --what and `block` as the mode — the two the docs promise', () => {
  const argv = inhibitorArgv('linux');
  // M25: soften `--mode=block` to `delay`. A delay lock only postpones, by
  // InhibitDelayMaxSec, and then lets the machine suspend anyway — the watcher
  // is lost while the log says it is being held awake. `block` is also the
  // mode docs/overnight.md describes to the operator: it refuses their own
  // deliberate suspend, and only a privileged user can override it. Both
  // surfaces state that, so weakening it here makes the docs wrong too.
  assert.ok(argv.includes('--mode=block'), 'a delay lock expires and the machine sleeps regardless');
  // M26: drop `sleep` from --what and inhibit `idle` alone. Automatic suspend
  // goes through logind's Suspend(), which only a `sleep` lock stops, so an
  // idle-only lock would let the laptop suspend on its own timer — the exact
  // failure this module exists for — while looking correct in the log.
  const what = argv.find((token) => token.startsWith('--what='));
  assert.ok(what.split('=')[1].split(':').includes('sleep'), 'idle alone does not stop logind Suspend()');
});

test('a platform with no mechanism is a no-op release, never a crash', () => {
  // M4: throw (or return undefined) on an unsupported platform. Windows would
  // lose the watcher entirely, over a feature that is pure upside.
  assert.equal(inhibitorArgv('win32'), null);
  assert.equal(inhibitorArgv('aix'), null);
  const spawnFn = recordingSpawn();
  const notes = [];
  const release = keepAwake({ enabled: true, platform: 'win32', spawnFn, onNote: (m) => notes.push(m) });
  assert.equal(typeof release, 'function');
  assert.equal(spawnFn.calls.length, 0, 'nothing was spawned');
  assert.match(notes.join('\n'), /no inhibitor on win32/, 'the absence is said out loud, not hidden');
  release(); // must not throw
});

// ------------------------------------------------------------------ the knob

test('the knob off spawns nothing at all', () => {
  // M5: treat any truthy value as on. Every machine that installs Tyran starts
  // refusing to sleep without its owner having asked for anything.
  const spawnFn = recordingSpawn();
  for (const enabled of [false, undefined, 'true', 1, null]) {
    const release = keepAwake({ enabled, platform: 'darwin', spawnFn });
    assert.equal(typeof release, 'function', `enabled=${String(enabled)} still returns a release`);
    release();
  }
  assert.equal(spawnFn.calls.length, 0, 'only the boolean true may start a process');
});

test('the child is an argv ARRAY with no shell and no inherited stdio', () => {
  // M6: pass `{ shell: true }` or join the argv into a string. The reason's
  // spaces become word breaks, and anything that ever reached the argv would
  // reach a shell instead — the single worst failure available here.
  const spawnFn = recordingSpawn();
  keepAwake({ enabled: true, platform: 'darwin', spawnFn });
  assert.equal(spawnFn.calls.length, 1);
  const { command, args, options, child } = spawnFn.calls[0];
  assert.equal(command, 'caffeinate');
  assert.ok(Array.isArray(args), 'the arguments are an array, never a command line');
  assert.deepEqual(args, ['-i', '-s']);
  assert.notEqual(options.shell, true);
  // M7: 'inherit' here writes the inhibitor's noise into the watcher's log,
  // which is the file an operator reads to find out what the watcher did.
  assert.equal(options.stdio, 'ignore');
  assert.equal(child.unrefs, 1, 'the child is unref\'d at once');
  assert.ok(child.listeners.includes('error'), 'the async ENOENT is listened for');
});

// --------------------------------------------------------------- the release

test('release is idempotent — killing twice is harmless', () => {
  // M8: drop the `released` latch. The second kill lands on a pid the OS may
  // already have recycled, which is how an inhibitor release turns into
  // signalling an unrelated process.
  const spawnFn = recordingSpawn();
  const release = keepAwake({ enabled: true, platform: 'darwin', spawnFn });
  release();
  release();
  release();
  assert.deepEqual(spawnFn.calls[0].child.kills, ['SIGTERM'], 'exactly one kill, however many releases');
});

test('a spawn that throws degrades to a silent no-op release', () => {
  // M9: let the throw escape. A machine missing `caffeinate` loses the whole
  // overnight run over the optimization that was supposed to protect it.
  const release = keepAwake({
    enabled: true,
    platform: 'darwin',
    spawnFn: () => {
      throw new Error('EACCES');
    },
  });
  assert.equal(typeof release, 'function');
  release();
});

test('a missing binary is swallowed: spawn reports ENOENT asynchronously', async () => {
  // M10: drop the 'error' listener. Node throws an unhandled 'error' event a
  // tick later — from outside any try/catch the caller could have — and the
  // watcher dies minutes after a call that appeared to succeed. If the mutant
  // is present this whole test FILE crashes, which is the point.
  const release = keepAwake({ enabled: true, argv: ['/nonexistent/tyran-inhibitor-that-is-not-there'] });
  await new Promise((tick) => setTimeout(tick, 150));
  assert.equal(typeof release, 'function');
  release();
  release();
});

test('withKeepAwake releases on the THROWN path, not just the happy one', async () => {
  // M11: replace try/finally with a release after the call. An error inside
  // the wait leaves the inhibitor running with nothing left alive to stop it.
  const spawnFn = recordingSpawn();
  await assert.rejects(
    withKeepAwake({ enabled: true, platform: 'darwin', spawnFn }, async () => {
      throw new Error('the wait blew up');
    }),
    /the wait blew up/,
  );
  assert.deepEqual(spawnFn.calls[0].child.kills, ['SIGTERM'], 'the throw still released the inhibitor');

  const clean = recordingSpawn();
  const value = await withKeepAwake({ enabled: true, platform: 'darwin', spawnFn: clean }, async () => 'returned');
  assert.equal(value, 'returned');
  assert.deepEqual(clean.calls[0].child.kills, ['SIGTERM']);
});

// ------------------------------------------------------------------- end to end

test('a Node process holding an inhibitor still exits on its own, and takes it along', async () => {
  // M12: drop `unref()`. The process never exits — the watcher hangs forever
  // after its work is done, and so does anything that ever wraps a region in
  // this. A hang cannot be asserted from inside the hung process, so this runs
  // a real one with a timeout: the mutant turns the test red by ETIMEDOUT.
  const dir = tempDir();
  const stub = stubInhibitor(dir);
  const pidFile = join(dir, 'inhibitor.pid');
  const script = join(dir, 'holds.mjs');
  writeFileSync(
    script,
    `import { existsSync } from 'node:fs';\n` +
      `import { keepAwake } from ${JSON.stringify(MODULE)};\n` +
      `keepAwake({ enabled: true, argv: [${JSON.stringify(stub)}, ${JSON.stringify(pidFile)}] });\n` +
      `const deadline = Date.now() + 5000;\n` +
      `while (!existsSync(${JSON.stringify(pidFile)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));\n` +
      `process.stdout.write('acquired\\n');\n` +
      `// deliberately NOT released: exiting must be possible anyway.\n`,
  );

  const stdout = execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 15000 });
  assert.match(stdout, /acquired/);
  assert.ok(existsSync(pidFile), 'the stub inhibitor really started');
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  // M13: drop the 'exit' listener. The process exits and leaves the inhibitor
  // running — the leak this module exists to make impossible.
  assert.ok(await waitForDeath(pid), `the inhibitor (pid ${pid}) outlived the process that held it`);
});

test('SIGTERM releases the inhibitor AND still kills the process', async () => {
  // M14: handle the signal without re-raising it. `overnight.mjs cancel`
  // SIGTERMs the watcher and expects it to die; a handler that only cleans up
  // makes the watcher unkillable by the operator's own documented handle.
  const dir = tempDir();
  const stub = stubInhibitor(dir);
  const pidFile = join(dir, 'inhibitor.pid');
  const script = join(dir, 'waits.mjs');
  writeFileSync(
    script,
    `import { existsSync } from 'node:fs';\n` +
      `import { keepAwake } from ${JSON.stringify(MODULE)};\n` +
      `keepAwake({ enabled: true, argv: [${JSON.stringify(stub)}, ${JSON.stringify(pidFile)}] });\n` +
      `const deadline = Date.now() + 5000;\n` +
      `while (!existsSync(${JSON.stringify(pidFile)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));\n` +
      `process.stdout.write('ready\\n');\n` +
      `setInterval(() => {}, 1000);\n`,
  );

  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the holder never became ready')), 15000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(alive(pid), 'the stub inhibitor is running before the signal');
    child.kill('SIGTERM');
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SIGTERM did not kill the holder')), 15000)),
    ]);
    assert.equal(result.signal, 'SIGTERM', 'the process still dies from the signal it was sent');
    assert.ok(await waitForDeath(pid), `the inhibitor (pid ${pid}) survived the SIGTERM that killed its holder`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
