/**
 * board-daemon — the part of `board.mjs --serve` that lets it be STARTED by
 * something other than a human with a spare terminal.
 *
 * `--serve` blocks forever, which is correct for an operator who typed it and
 * fatal for everything else. Setup's "turn the dashboard on" step handed an
 * AGENT that command: the board came up, the agent's tool call then sat on it
 * until the platform's timeout, and setup's remaining steps — validate,
 * report, ask for the `.tyran/` commit — never ran. Measured: still listening
 * three seconds after spawn, with nothing to return to the caller.
 *
 * So this module owns starting a server the caller does not have to wait for,
 * and the harder half of that: knowing whether one is ALREADY running.
 *
 * THE LIVENESS CONTRACT, because a pid is the obvious answer and the wrong
 * one. `session-start.mjs` states the general case — a pid recorded by a
 * short-lived process is dead before anyone reads it, and once the OS recycles
 * the number it names a stranger. A board that trusted its own record would
 * therefore report "already running" about somebody else's process and never
 * start. Liveness here is an HTTP question instead:
 *
 *   1. GET `/health.json` on the port,
 *   2. and believe it only if it names THIS `.tyran` directory.
 *
 * Both halves are load-bearing. Without (1) a recycled pid is a false
 * positive; without (2) the board of a DIFFERENT repository — same program,
 * same route, same shape — answers and this one silently never starts, which
 * is the failure mode of every "is my dev server up" check that only probes a
 * port. The recorded pid is kept for exactly one job, `--stop`, where a stale
 * one costs a refusal rather than a wrong answer.
 *
 * Everything is best-effort by construction. A caller that cannot start a
 * board still has a working repository, so no function here throws on a
 * failure to reach the network, the filesystem or a child process.
 */
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { connect as netConnect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the running server records itself, relative to `.tyran`. */
export const SERVER_RECORD_FILE = 'board-server.json';
export const SERVER_RECORD_RELPATH = join('state', SERVER_RECORD_FILE);

/** Bumped when the record's shape changes; an older one reads as absent. */
export const SERVER_RECORD_SCHEMA = 1;

/** The route that answers the liveness question above. */
export const HEALTH_ROUTE = '/health.json';

/**
 * How many ports to try from the preferred one.
 *
 * One board per repository, and people work in several repositories at once,
 * so "the port is busy" is the ordinary case rather than an error. Ten is
 * enough for any plausible number of simultaneous repos and small enough that
 * an exhausted search is fast.
 */
export const PORT_SEARCH_SPAN = 10;

/**
 * A probe budget, not a timeout in the usual sense: this runs inside the
 * SessionStart hook, whose whole deadline is 4 s and which already spends
 * half of it on doctor. A loopback server either answers in single-digit
 * milliseconds or is not there.
 */
export const PROBE_TIMEOUT_MS = 400;

/** How long `--detach` waits for the child to answer before reporting. */
export const START_DEADLINE_MS = 5000;

const POLL_INTERVAL_MS = 100;

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD_SCRIPT = join(HERE, 'board.mjs');

export function serverRecordPath(dir) {
  return join(dir, SERVER_RECORD_RELPATH);
}

/**
 * The record, or null. Garbage, a wrong schema and an unreadable file are all
 * "no record" — this file is a convenience, and a caller that crashed on a
 * half-written one would be worse than the problem it solves.
 */
export function readServerRecord(dir) {
  try {
    const path = serverRecordPath(dir);
    if (!existsSync(path)) return null;
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
    if (doc.schema !== SERVER_RECORD_SCHEMA) return null;
    return doc;
  } catch {
    return null;
  }
}

/** Atomic, same rename dance as every other runtime file Tyran writes. */
export function writeServerRecord(dir, record) {
  try {
    const target = serverRecordPath(dir);
    mkdirSync(dirname(target), { recursive: true });
    const temp = join(dirname(target), `.board-server-${process.pid}.tmp`);
    writeFileSync(temp, `${JSON.stringify({ schema: SERVER_RECORD_SCHEMA, ...record }, null, 2)}\n`);
    renameSync(temp, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the record — but only if it is THIS process's to remove.
 *
 * `owner` is the pid the caller claims. It defaults to this process because
 * the ordinary caller is a server tidying up after itself, and the defect this
 * guards is precisely a caller tidying up after somebody else: `board.mjs`
 * registers its `clear` handler on `process.exit` unconditionally, so a
 * `--serve` that lost the port to EADDRINUSE still ran it on the way out and
 * deleted the record belonging to the healthy board that HELD the port. That
 * board went on serving with no record naming it — invisible to `--status`,
 * unreachable by `--stop`, and stoppable only with `lsof` and a kill. A leaked
 * server is the exact failure this module was written to end, so it may not be
 * reintroduced by the cleanup path.
 *
 * The guard lives here rather than at the call site on purpose. Ownership
 * enforced by whoever remembers to check is caller discipline, which this
 * repository rejects by name in `journal.mjs` and `doctor.mjs`.
 *
 * `owner: null` means "any", and `stopServer` is the one caller that has
 * earned it: it health-probes the port and confirms the board answering there
 * belongs to this directory before it signals or unlinks anything.
 */
export function removeServerRecord(dir, { owner = process.pid } = {}) {
  try {
    if (owner !== null) {
      const record = readServerRecord(dir);
      if (record !== null && record.pid !== owner) return false;
    }
    rmSync(serverRecordPath(dir), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * GET `/health.json` on one port. Resolves to the parsed document, or null for
 * every failure — closed port, wrong program, timeout, unparseable body.
 *
 * The body is capped: this asks an arbitrary local port a question, and the
 * thing that answers is not necessarily a board. A megabyte of response to a
 * health probe is not a health response, and reading it in full would let any
 * process on loopback decide how much memory this one spends.
 */
export function probeHealth(port, { timeoutMs = PROBE_TIMEOUT_MS, request = httpGet } = {}) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    let req;
    try {
      req = request(
        { host: '127.0.0.1', port, path: HEALTH_ROUTE, headers: { host: `127.0.0.1:${port}` } },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            done(null);
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
            if (body.length > 8192) {
              req.destroy();
              done(null);
            }
          });
          res.on('end', () => {
            try {
              const doc = JSON.parse(body);
              done(doc !== null && typeof doc === 'object' && doc.tyran_board === true ? doc : null);
            } catch {
              done(null);
            }
          });
          res.on('error', () => done(null));
        },
      );
    } catch {
      done(null);
      return;
    }
    req.on('error', () => done(null));
    req.setTimeout?.(timeoutMs, () => {
      req.destroy();
      done(null);
    });
  });
}

/** Two directories are the same board when they resolve to the same path. */
function sameDir(a, b) {
  try {
    return resolve(String(a)) === resolve(String(b));
  } catch {
    return false;
  }
}

/**
 * Is a board for THIS directory already answering — and on which port?
 *
 * The recorded port is tried first because it is nearly always right and one
 * probe is the whole cost. The span is then swept so that a server whose
 * record was lost (a `git clean`, a crash between listen and write) is still
 * found rather than duplicated.
 */
export async function findLiveServer(dir, preferredPort, { probe = probeHealth } = {}) {
  const record = readServerRecord(dir);
  const ports = [];
  if (record !== null && Number.isInteger(record.port)) ports.push(record.port);
  for (let i = 0; i < PORT_SEARCH_SPAN; i += 1) {
    const port = preferredPort + i;
    if (!ports.includes(port)) ports.push(port);
  }
  for (const port of ports) {
    const health = await probe(port);
    if (health !== null && sameDir(health.dir, dir)) return { port, health };
  }
  return null;
}

/**
 * Is anything at all listening on this port?
 *
 * A TCP connect, because the health probe CANNOT answer this. `probeHealth`
 * returns null for "nothing is there" and for "something is there and it is
 * not a board" alike, and a caller that reads that null as "free" will bind a
 * port already in use. Measured exactly that way: an unrelated local server
 * on the port answered `/health.json` with `not a board`, the health probe
 * reported null, the port was declared free, the child died on EADDRINUSE,
 * and `--detach` spent its whole 5 s deadline before reporting a failure that
 * was knowable in one millisecond.
 */
export function isPortFree(port, { timeoutMs = PROBE_TIMEOUT_MS, connect = netConnect } = {}) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    let socket;
    try {
      socket = connect({ host: '127.0.0.1', port });
    } catch {
      done(true); // could not even try to connect — treat as free and let bind decide
      return;
    }
    socket.setTimeout?.(timeoutMs);
    socket.on('connect', () => { socket.destroy(); done(false); });
    socket.on('timeout', () => { socket.destroy(); done(true); });
    socket.on('error', () => { socket.destroy?.(); done(true); }); // ECONNREFUSED — nothing there
  });
}

/**
 * The first port this board may take: one that is genuinely free, or one it
 * already owns. A port held by ANY other program — another repository's
 * board, or something with no opinion about Tyran at all — is skipped rather
 * than fought over.
 *
 * The order of the two probes is deliberate. Ownership is asked FIRST because
 * a board of ours answering is the case worth reusing, and only then is the
 * cheaper "is anything there" question used to tell free from foreign.
 *
 * Returns null when the whole span is occupied — a real condition to report,
 * not one to paper over by binding somewhere unpredictable.
 */
export async function pickPort(dir, preferred, { probe = probeHealth, free = isPortFree } = {}) {
  for (let i = 0; i < PORT_SEARCH_SPAN; i += 1) {
    const port = preferred + i;
    const health = await probe(port);
    if (health !== null && sameDir(health.dir, dir)) return { port, reuse: true };
    if (health !== null) continue; // a board, but not ours
    if (await free(port)) return { port, reuse: false };
  }
  return null;
}

/**
 * Start a server nobody has to wait for, and wait just long enough to be able
 * to say whether it worked.
 *
 * `detached` + `stdio: 'ignore'` + `unref()` is what actually severs it from
 * the caller: without all three the child keeps the parent's event loop or its
 * pipes alive and the caller blocks anyway — which is the bug this file
 * exists to fix, reintroduced one flag at a time.
 *
 * The CHILD writes the record, not this function, and that ordering is the
 * point: it writes from inside its own `listen` callback, so a record exists
 * only for a server that actually bound a port. A parent writing it first
 * would be recording an intention.
 */
export async function startDetached(
  dir,
  { port, write = true, open = false, transcripts = [], spawn = spawnProcess, probe = probeHealth, deadlineMs = START_DEADLINE_MS, sleep = defaultSleep } = {},
) {
  const existing = await findLiveServer(dir, port, { probe });
  if (existing !== null) {
    // `write` comes back with the reuse so the caller can tell the operator
    // when the flags on THIS command line did not apply. Start-time flags are
    // silently inert against a server that is already up, and autostart has
    // made "already up" the ordinary case rather than the unlucky one — so the
    // remedy printed on the Spend tab (`--transcripts <dir>`) reported success
    // and changed nothing for anyone whose board was already running.
    return {
      started: false,
      reused: true,
      port: existing.port,
      url: urlFor(existing.port),
      pid: existing.health.pid ?? null,
      write: existing.health.write === true,
    };
  }
  const chosen = await pickPort(dir, port, { probe });
  if (chosen === null) {
    return {
      started: false,
      reused: false,
      error:
        `ports ${port}-${port + PORT_SEARCH_SPAN - 1} are all in use by other programs — ` +
        'pass --port <n> to start somewhere else',
    };
  }
  const args = [BOARD_SCRIPT, '--dir', dir, '--serve', '--port', String(chosen.port)];
  if (write) args.push('--write');
  if (open) args.push('--open');
  for (const t of transcripts) args.push('--transcripts', t);
  let child;
  try {
    child = spawn(process.execPath, args, { stdio: 'ignore', detached: true });
    child.on?.('error', () => { /* reported by the health probe below, not by a throw */ });
    child.unref?.();
  } catch (err) {
    return { started: false, reused: false, error: `could not spawn the board: ${String(err?.message ?? err)}` };
  }
  // Poll rather than trust the spawn: a child that exits immediately (a bad
  // --dir, a port that raced) is indistinguishable from a healthy one at
  // spawn time, and reporting a URL nothing answers is worse than an error.
  const deadline = deadlineMs;
  for (let waited = 0; waited < deadline; waited += POLL_INTERVAL_MS) {
    await sleep(POLL_INTERVAL_MS);
    const health = await probe(chosen.port);
    if (health !== null && sameDir(health.dir, dir)) {
      return { started: true, reused: false, port: chosen.port, url: urlFor(chosen.port), pid: health.pid ?? child.pid ?? null };
    }
  }
  return { started: false, reused: false, error: `the board did not answer on port ${chosen.port} within ${deadline} ms` };
}

/**
 * Start one without waiting for it to ANSWER — for callers on a hook's budget.
 *
 * Everything the polling version buys (a URL known to answer, a real pid, an
 * error when the child died) is given up here on purpose: `SessionStart` has
 * a 4 s deadline it shares with doctor, and spending seconds of it confirming
 * a convenience would cost the user their session summary. The next session
 * finds the server through `findLiveServer` and reports it then.
 *
 * What is NOT given up is choosing a port that can actually be bound. Skipping
 * that would make the caller spawn a child onto an occupied port, where it
 * dies on EADDRINUSE with `stdio: 'ignore'` — no output, no exit code anyone
 * reads, and a board that never starts on EVERY session, silently, for as long
 * as the other program holds the port. Port selection costs two immediate
 * ECONNREFUSEDs in the normal case, which the budget can afford; being wrong
 * here costs the whole feature.
 *
 * Returns the chosen port, or null if nothing was started.
 */
export async function startDetachedNoWait(
  dir,
  { port, write = true, transcripts = [], spawn = spawnProcess, probe = probeHealth, free = isPortFree } = {},
) {
  const chosen = await pickPort(dir, port, { probe, free });
  if (chosen === null) return null;
  const args = [BOARD_SCRIPT, '--dir', dir, '--serve', '--port', String(chosen.port)];
  if (write) args.push('--write');
  for (const t of transcripts) args.push('--transcripts', t);
  try {
    const child = spawn(process.execPath, args, { stdio: 'ignore', detached: true });
    child.on?.('error', () => { /* nothing to report to; the next session probes */ });
    child.unref?.();
    return chosen.port;
  } catch {
    return null;
  }
}

/**
 * Stop the recorded server.
 *
 * The pid is only trusted this far because the cost of being wrong is bounded
 * and visible: the health probe runs FIRST, so a pid is signalled only when a
 * board for this directory is genuinely answering on the recorded port. That
 * closes the recycled-pid window to the case where a stranger inherited the
 * pid AND a real board answers AND the record is stale — at which point the
 * kill fails or hits the board, never an unrelated process by luck alone.
 */
export async function stopServer(dir, { probe = probeHealth, kill = process.kill.bind(process) } = {}) {
  const record = readServerRecord(dir);
  if (record === null) return { stopped: false, reason: 'no board server is recorded for this directory' };
  const health = await probe(record.port);
  if (health === null || !sameDir(health.dir, dir)) {
    // `owner: null` — see removeServerRecord. Clearing a record that names
    // another pid is this function's JOB, and it has proved the right to it:
    // either nothing answers, or what answers is not this directory's board.
    removeServerRecord(dir, { owner: null });
    return { stopped: false, reason: `nothing is answering on port ${record.port} — cleared the stale record` };
  }
  const pid = health.pid ?? record.pid;
  if (!Number.isInteger(pid)) return { stopped: false, reason: 'the running board did not report a pid' };
  try {
    kill(pid, 'SIGTERM');
  } catch (err) {
    return { stopped: false, reason: `could not signal pid ${pid}: ${String(err?.message ?? err)}` };
  }
  removeServerRecord(dir, { owner: null });
  return { stopped: true, pid, port: record.port };
}

export function urlFor(port) {
  return `http://127.0.0.1:${port}/`;
}

/**
 * NOT unref'd, and that is the whole function.
 *
 * An unref'd timer does not hold the event loop open, so `--detach` drained
 * its loop and exited between the spawn and the first poll — reporting
 * nothing at all about a server that then started fine half a second later.
 * The command looked instantaneous and successful and printed no URL.
 */
function defaultSleep(ms) {
  return new Promise((r) => { setTimeout(r, ms); });
}
