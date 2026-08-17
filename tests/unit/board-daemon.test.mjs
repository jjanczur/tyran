/**
 * Tests for the part of the board that can be STARTED by something other than
 * a person with a spare terminal.
 *
 * The properties that matter are all about telling three states apart on a
 * port — free, ours, someone else's — because collapsing any two of them
 * produces a failure that looks like success:
 *
 *   - reading "not a board" as "nothing is there" makes the daemon bind a
 *     port already in use (measured: the child died on EADDRINUSE and
 *     `--detach` burned its whole 5 s deadline before saying so);
 *   - reading ANOTHER repository's board as ours makes this repo's board
 *     never start, silently, since the check reports "already running";
 *   - trusting the recorded pid over the live probe makes `--stop` signal
 *     whatever inherited that pid.
 *
 * Every probe is injected, so none of this binds a port or spawns a process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PORT_SEARCH_SPAN,
  SERVER_RECORD_SCHEMA,
  findLiveServer,
  isPortFree,
  pickPort,
  probeHealth,
  readServerRecord,
  removeServerRecord,
  startDetached,
  stopServer,
  writeServerRecord,
} from '../../scripts/board-daemon.mjs';

function tyranDir() {
  const dir = mkdtempSync(join(tmpdir(), 'board-daemon-'));
  mkdirSync(join(dir, 'state'), { recursive: true });
  return dir;
}

/** A probe over a fixed port -> health-document map. */
const probeOver = (byPort) => async (port) => byPort[port] ?? null;

/** A response the http `get` callback would receive. */
function fakeResponse(statusCode, body) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.setEncoding = () => {};
  res.resume = () => {};
  queueMicrotask(() => {
    res.emit('data', body);
    res.emit('end');
  });
  return res;
}

function fakeGet(statusCode, body) {
  return (_opts, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.setTimeout = () => {};
    queueMicrotask(() => cb(fakeResponse(statusCode, body)));
    return req;
  };
}

// ---------------------------------------------------------------- probing

test('a 200 that is not a board reads as absent, not as a board', async () => {
  // The literal foreign-server case: an unrelated local process answered
  // /health.json with plain text. Mutant: parsing failures returning `{}`.
  assert.equal(await probeHealth(4220, { request: fakeGet(200, 'not a board\n') }), null);
});

test('a JSON body without the tyran_board marker reads as absent', async () => {
  // Some other tool's health endpoint is still JSON. Mutant: dropping the
  // marker check and believing any object.
  assert.equal(await probeHealth(4220, { request: fakeGet(200, '{"status":"ok"}') }), null);
});

test('a board that answers is returned whole', async () => {
  const doc = await probeHealth(4173, { request: fakeGet(200, '{"tyran_board":true,"dir":"/a/.tyran","pid":9}') });
  assert.equal(doc.dir, '/a/.tyran');
  assert.equal(doc.pid, 9);
});

test('a non-200 is absent even when the body is a valid board document', async () => {
  // Mutant: reading the body without looking at the status.
  assert.equal(await probeHealth(4173, { request: fakeGet(503, '{"tyran_board":true,"dir":"/a"}') }), null);
});

// ------------------------------------------------------------- pickPort

test('a port held by a program that is not a board is SKIPPED, not taken', async () => {
  // THE regression this file exists for. probeHealth says null for "nothing
  // there" and for "not a board" alike, so the free/foreign distinction can
  // only come from the TCP probe. Mutant: `if (health === null) return {port}`.
  const dir = tyranDir();
  const chosen = await pickPort(dir, 4220, {
    probe: async () => null, // nothing answers /health.json anywhere
    free: async (port) => port !== 4220, // ...but 4220 has a listener
  });
  assert.equal(chosen.port, 4221);
  assert.equal(chosen.reuse, false);
  rmSync(dir, { recursive: true, force: true });
});

test("another repository's board does not surrender its port", async () => {
  const dir = tyranDir();
  const chosen = await pickPort(dir, 4173, {
    probe: probeOver({ 4173: { tyran_board: true, dir: '/somewhere/else/.tyran' } }),
    free: async () => true,
  });
  assert.equal(chosen.port, 4174);
  rmSync(dir, { recursive: true, force: true });
});

test('our own board on the preferred port is reused rather than duplicated', async () => {
  const dir = tyranDir();
  const chosen = await pickPort(dir, 4173, {
    probe: probeOver({ 4173: { tyran_board: true, dir } }),
    free: async () => true,
  });
  assert.deepEqual(chosen, { port: 4173, reuse: true });
  rmSync(dir, { recursive: true, force: true });
});

test('a fully occupied span returns null rather than binding somewhere unpredictable', async () => {
  const dir = tyranDir();
  assert.equal(await pickPort(dir, 4173, { probe: async () => null, free: async () => false }), null);
  rmSync(dir, { recursive: true, force: true });
});

test('the search span is exactly PORT_SEARCH_SPAN ports wide', async () => {
  const dir = tyranDir();
  const tried = [];
  await pickPort(dir, 5000, {
    probe: async () => null,
    free: async (port) => { tried.push(port); return false; },
  });
  assert.equal(tried.length, PORT_SEARCH_SPAN);
  assert.equal(tried.at(-1), 5000 + PORT_SEARCH_SPAN - 1);
  rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------- findLiveServer

test('the recorded port is probed before the default span', async () => {
  // A board started on a fallback port must still be findable, or every
  // caller starts a second one next to it.
  const dir = tyranDir();
  writeServerRecord(dir, { pid: 1, port: 4211, url: 'http://127.0.0.1:4211/', write: true });
  const order = [];
  const live = await findLiveServer(dir, 4173, {
    probe: async (port) => { order.push(port); return port === 4211 ? { tyran_board: true, dir, pid: 1 } : null; },
  });
  assert.equal(order[0], 4211, 'the recorded port must be tried first');
  assert.equal(live.port, 4211);
  rmSync(dir, { recursive: true, force: true });
});

test('a board answering for a DIFFERENT directory is not this repo\'s board', async () => {
  // Without the dir check this returns a live server and the real one never
  // starts — the quiet failure named in the module comment.
  const dir = tyranDir();
  const live = await findLiveServer(dir, 4173, {
    probe: async () => ({ tyran_board: true, dir: '/other/.tyran', pid: 5 }),
  });
  assert.equal(live, null);
  rmSync(dir, { recursive: true, force: true });
});

// ----------------------------------------------------------- the record

test('a record with a stale schema reads as no record at all', async () => {
  const dir = tyranDir();
  writeFileSync(join(dir, 'state', 'board-server.json'), JSON.stringify({ schema: SERVER_RECORD_SCHEMA + 1, port: 9 }));
  assert.equal(readServerRecord(dir), null);
  rmSync(dir, { recursive: true, force: true });
});

test('a half-written record reads as no record at all', async () => {
  const dir = tyranDir();
  writeFileSync(join(dir, 'state', 'board-server.json'), '{"schema":1,"port":');
  assert.equal(readServerRecord(dir), null);
  rmSync(dir, { recursive: true, force: true });
});

test('the record round-trips and carries the schema', async () => {
  const dir = tyranDir();
  // The pid is this process's because removal is now ownership-checked, and a
  // real server is always removing its OWN record here.
  writeServerRecord(dir, { pid: process.pid, port: 4173, url: 'http://127.0.0.1:4173/', write: true });
  const back = readServerRecord(dir);
  assert.equal(back.schema, SERVER_RECORD_SCHEMA);
  assert.equal(back.pid, process.pid);
  removeServerRecord(dir);
  assert.equal(readServerRecord(dir), null);
  rmSync(dir, { recursive: true, force: true });
});

test('a board that FAILED to start does not delete the record of the one that is running', async () => {
  // MUTANT: drop the ownership check in removeServerRecord.
  //
  // Reproduced live before the fix. With a board already up on 4173, a second
  // `--serve` loses the bind, prints "port 4173 is already in use", and exits —
  // running the `clear` handler board.mjs registers on `process.exit`
  // unconditionally. That deleted the RUNNING board's record. Measured after:
  //
  //   $ curl 127.0.0.1:4173/health.json   -> {"tyran_board":true,...,"pid":61160}
  //   $ ls .tyran/state/                  -> (empty)
  //   $ board.mjs --stop                  -> "no board server is recorded"
  //
  // A server serving with nothing naming it: invisible to --status, unreachable
  // by --stop, killable only with lsof. That is the leak this module exists to
  // end, arriving through the cleanup path instead of the start path.
  const dir = tyranDir();
  writeServerRecord(dir, { pid: process.pid + 1, port: 4173, url: 'http://127.0.0.1:4173/', write: true });
  assert.equal(removeServerRecord(dir), false, 'a record naming another pid is not ours to remove');
  assert.equal(readServerRecord(dir).pid, process.pid + 1, 'the running board keeps its record');
  rmSync(dir, { recursive: true, force: true });
});

test('stopServer still clears a stale record it did not write', async () => {
  // The other side of the guard: `owner: null`. stopServer health-probes FIRST,
  // so by the time it unlinks it has established that nothing is answering (or
  // that what answers is not this directory's board). Without the exemption the
  // ownership check would strand exactly the stale records it exists to clear.
  const dir = tyranDir();
  writeServerRecord(dir, { pid: process.pid + 1, port: 4173, url: 'http://127.0.0.1:4173/', write: true });
  const result = await stopServer(dir, { probe: async () => null, kill: () => {} });
  assert.equal(result.stopped, false);
  assert.match(result.reason, /cleared the stale record/);
  assert.equal(readServerRecord(dir), null, 'the stale record is gone');
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ start/stop

test('a live board is reused and NOTHING is spawned', async () => {
  const dir = tyranDir();
  let spawned = 0;
  const result = await startDetached(dir, {
    port: 4173,
    probe: probeOver({ 4173: { tyran_board: true, dir, pid: 7 } }),
    spawn: () => { spawned += 1; return { unref() {}, on() {} }; },
  });
  assert.equal(spawned, 0, 'a second server must never be started next to a live one');
  assert.equal(result.reused, true);
  assert.equal(result.port, 4173);
  rmSync(dir, { recursive: true, force: true });
});

test('reuse reports whether the running board can WRITE, so inert flags can be named', async () => {
  // MUTANT: drop `write` from the reuse result. Start-time flags never reach a
  // server that is already up, and autostart made "already up" the ordinary
  // case — so `--detach --write` against a read-only board printed
  // "already serving", exit 0, and left Settings read-only with nothing on
  // screen explaining why. The Spend tab's own remedy (`--transcripts <dir>`)
  // failed the same way, which is worse: the product recommended it.
  const dir = tyranDir();
  const ro = await startDetached(dir, {
    port: 4173,
    probe: probeOver({ 4173: { tyran_board: true, dir, pid: 7, write: false } }),
    spawn: () => ({ unref() {}, on() {} }),
  });
  assert.equal(ro.reused, true);
  assert.equal(ro.write, false, 'a read-only board must be reported as read-only');

  const rw = await startDetached(dir, {
    port: 4173,
    probe: probeOver({ 4173: { tyran_board: true, dir, pid: 7, write: true } }),
    spawn: () => ({ unref() {}, on() {} }),
  });
  assert.equal(rw.write, true);
  rmSync(dir, { recursive: true, force: true });
});

test('a child that never answers is an ERROR, not a URL nobody can open', async () => {
  const dir = tyranDir();
  const result = await startDetached(dir, {
    port: 4173,
    probe: async () => null,
    free: async () => true,
    spawn: () => ({ pid: 111, unref() {}, on() {} }),
    deadlineMs: 300,
    sleep: async () => {},
  });
  assert.equal(result.started, false);
  assert.match(result.error, /did not answer/);
  rmSync(dir, { recursive: true, force: true });
});

test('stop clears a stale record and kills NOTHING', async () => {
  // The recycled-pid case. A record pointing at a port nothing answers on is
  // evidence the server is gone, never a licence to signal that number.
  const dir = tyranDir();
  writeServerRecord(dir, { pid: 999999, port: 4173, url: 'http://127.0.0.1:4173/', write: true });
  let killed = null;
  const result = await stopServer(dir, { probe: async () => null, kill: (pid) => { killed = pid; } });
  assert.equal(killed, null, 'no signal may be sent when nothing is answering');
  assert.equal(result.stopped, false);
  assert.equal(readServerRecord(dir), null, 'the stale record must be cleared');
  rmSync(dir, { recursive: true, force: true });
});

test("stop refuses to signal another repository's board", async () => {
  const dir = tyranDir();
  writeServerRecord(dir, { pid: 4242, port: 4173, url: 'http://127.0.0.1:4173/', write: true });
  let killed = null;
  const result = await stopServer(dir, {
    probe: async () => ({ tyran_board: true, dir: '/elsewhere/.tyran', pid: 4242 }),
    kill: (pid) => { killed = pid; },
  });
  assert.equal(killed, null);
  assert.equal(result.stopped, false);
  rmSync(dir, { recursive: true, force: true });
});

test('stop signals the pid the LIVE server reports, not the recorded one', async () => {
  // The record can be stale in the other direction too: a restarted board on
  // the same port has a new pid, and the live answer is the one to believe.
  const dir = tyranDir();
  writeServerRecord(dir, { pid: 1, port: 4173, url: 'http://127.0.0.1:4173/', write: true });
  let killed = null;
  const result = await stopServer(dir, {
    probe: async () => ({ tyran_board: true, dir, pid: 2 }),
    kill: (pid) => { killed = pid; },
  });
  assert.equal(killed, 2);
  assert.equal(result.stopped, true);
  rmSync(dir, { recursive: true, force: true });
});

// --------------------------------------------------------------- the wire

test('a closed port is free, and a listening one is not', async () => {
  // The one test that touches a real socket: everything above trusts an
  // injected `free`, so nothing else would notice if the TCP probe inverted.
  const { createServer } = await import('node:net');
  const server = createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  assert.equal(await isPortFree(port), false, 'a listening port is not free');
  await new Promise((r) => server.close(r));
  assert.equal(await isPortFree(port), true, 'a closed port is free');
});
