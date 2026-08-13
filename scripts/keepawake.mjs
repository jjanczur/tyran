/**
 * keepawake — hold the SYSTEM awake for as long as a Tyran watcher is waiting.
 *
 * The measured failure: a laptop whose screensaver starts at five minutes
 * suspends, the network goes with it, and the running session dies mid-task
 * with an API error. The overnight resume watcher is the worst case — its
 * whole job is to be asleep for hours waiting for a usage window to reset,
 * which is exactly the interval a machine chooses to suspend in.
 *
 * Three constraints shape every line here.
 *
 *  - **System sleep only, never the display.** `caffeinate -d` would also
 *    block the screen lock, and a machine left running overnight that never
 *    locks is a security regression. `-i` is idle sleep, `-s` is sleep while
 *    on AC power; the display and the lock stay exactly as the operator set
 *    them.
 *  - **A leak is worse than a no-op.** An inhibitor that outlives its reason
 *    keeps someone's laptop awake indefinitely. So: the child is `unref`'d
 *    (it can never hold this process open), it is released on every exit path
 *    including SIGINT/SIGTERM, and the release is idempotent. SIGKILL is the
 *    one signal nothing can catch — stated in docs/overnight.md rather than
 *    pretended away.
 *  - **Degrade silently, never refuse.** An unsupported platform, a missing
 *    binary or a failed spawn returns a no-op release. Keeping the machine
 *    awake is an optimization on the real work; it is never a precondition
 *    for it, and it must never be the reason a run fails to start.
 *
 * Nothing foreign ever reaches the child: the command is an argv ARRAY, never
 * a shell string, and `--why` is a module constant rather than an operator's,
 * a config's or a pause marker's words.
 */
import { spawn } from 'node:child_process';

/** Our own words, deliberately: the only free text the child ever sees. */
export const KEEP_AWAKE_REASON = 'Tyran is waiting for a usage-limit window to reset';

/**
 * systemd-inhibit holds its lock only while its COMMAND runs, so it needs one.
 * POSIX `sleep` takes an integer — GNU's `sleep infinity` is not portable to
 * every userland systemd ships on, and an inhibitor whose command exits at
 * once is a lock nobody is holding. 2^31-1 seconds is ~68 years.
 */
export const INHIBIT_SLEEP_SECONDS = '2147483647';

/**
 * Signals we release on. Each handler re-raises after releasing, so a caller's
 * `kill` still kills: overnight's `cancel` SIGTERMs the watcher and expects it
 * to die, and a handler that only cleaned up would make it unkillable.
 */
const RELEASE_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);

const NOOP_RELEASE = () => {};

/**
 * The inhibitor command for a platform, or `null` where no mechanism exists.
 * Pure — the platform matrix is decidable without spawning anything.
 */
export function inhibitorArgv(platform = process.platform) {
  // -i: no idle sleep. -s: no sleep while on AC power. NEVER -d: that is the
  // DISPLAY, and blocking it blocks the screen lock.
  if (platform === 'darwin') return ['caffeinate', '-i', '-s'];
  if (platform === 'linux') {
    return [
      'systemd-inhibit',
      '--what=idle:sleep',
      `--why=${KEEP_AWAKE_REASON}`,
      '--mode=block',
      'sleep',
      INHIBIT_SLEEP_SECONDS,
    ];
  }
  // Windows and everything else: no mechanism, and that is not an error.
  return null;
}

function note(onNote, message) {
  if (typeof onNote !== 'function') return;
  try {
    onNote(message);
  } catch {
    /* a note is a courtesy; its failure must not reach the caller */
  }
}

/**
 * Acquire the inhibitor and return the function that releases it.
 *
 * ALWAYS returns a function — off, unsupported, or failed all return a no-op,
 * so a caller's `finally` needs no null check and can never crash on the path
 * where the machine was already going to be fine.
 *
 * `argv` and `spawnFn` are injection points for tests only. Neither is
 * reachable from any CLI: nothing constructs them from a file, a flag or an
 * environment variable.
 */
export function keepAwake({ enabled = false, platform = process.platform, argv = null, spawnFn = spawn, onNote = null } = {}) {
  // Strict true: a knob that changes the operator's machine is never enabled
  // by a truthy string that drifted in from a parser.
  if (enabled !== true) return NOOP_RELEASE;

  const command = argv ?? inhibitorArgv(platform);
  if (command === null) {
    note(onNote, `keep-awake: no inhibitor on ${platform} — this machine may still sleep and take the run with it`);
    return NOOP_RELEASE;
  }
  note(
    onNote,
    `keep-awake: holding the system awake with ${command[0]} — the display and the screen lock are untouched`,
  );

  let child;
  try {
    child = spawnFn(command[0], command.slice(1), {
      // Never the caller's stdio: the watcher's log is a record, not a pipe.
      stdio: 'ignore',
      // The argv above is the whole command. No shell, ever.
      shell: false,
    });
  } catch {
    // Silent degrade: the work matters, the inhibitor does not.
    return NOOP_RELEASE;
  }

  // spawn reports a MISSING BINARY asynchronously, as an 'error' event. With
  // no listener that event is thrown and takes the watcher down — a machine
  // without caffeinate would lose the very run this exists to protect.
  if (typeof child?.on === 'function') child.on('error', () => {});
  // The inhibitor must never be the reason this process is still alive.
  if (typeof child?.unref === 'function') child.unref();

  const handlers = new Map();
  let released = false;
  const release = () => {
    if (released) return; // idempotent: killing twice is harmless, by construction
    released = true;
    for (const [event, fn] of handlers) process.removeListener(event, fn);
    handlers.clear();
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone, or never really there */
    }
  };

  for (const signal of RELEASE_SIGNALS) {
    const fn = () => {
      release();
      // release() removed this listener, so the default disposition is back:
      // re-raising kills us exactly as it would have without the handler.
      process.kill(process.pid, signal);
    };
    handlers.set(signal, fn);
    process.on(signal, fn);
  }
  const onExit = () => release();
  handlers.set('exit', onExit);
  process.on('exit', onExit);

  return release;
}

/**
 * Run `fn` with the machine held awake. The release is in a `finally`, so it
 * runs on the thrown path too — the path where a forgotten release would leave
 * a laptop awake with nothing left to explain why.
 */
export async function withKeepAwake(options, fn) {
  const release = keepAwake(options);
  try {
    return await fn();
  } finally {
    release();
  }
}
