/**
 * The board's write channel, exercised against a REAL running server.
 *
 * Every other assertion about `--serve` in this repository matches strings in
 * a rendered page or calls a pure function. Neither would notice a route that
 * is never reached, a flag that is never consulted, or a 403 that is actually
 * a 200 — and this is the one surface where being wrong means a web page can
 * edit the file that decides what agents may write. So this file starts the
 * process the operator starts, and talks to it over HTTP.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../../scripts/yaml-lite.mjs';
import { validateConfig, validatePolicy } from '../../scripts/schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'board.mjs');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'journal-demo.jsonl');

/** A .tyran directory with one initiative and the shipped config + policy. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-board-write-'));
  const tyran = join(dir, '.tyran');
  mkdirSync(join(tyran, 'policies'), { recursive: true });
  mkdirSync(join(tyran, 'state', 'demo'), { recursive: true });
  writeFileSync(join(tyran, 'config.yaml'), readFileSync(join(ROOT, 'templates', 'config.yaml'), 'utf8'));
  writeFileSync(join(tyran, 'policies', 'autonomy.yaml'), readFileSync(join(ROOT, 'templates', 'policies', 'autonomy.yaml'), 'utf8'));
  writeFileSync(join(tyran, 'state', 'demo', 'journal.jsonl'), readFileSync(FIXTURE, 'utf8'));
  return { dir, tyran, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Start the server and wait for the line it prints.
 *
 * The port comes from the OS rather than a constant: two of these run
 * concurrently under the suite's default parallelism, and a fixed port makes
 * the second one fail with EADDRINUSE on a machine that is doing nothing
 * wrong.
 */
async function serve(tyran, extraArgs = []) {
  const { createServer } = await import('node:http');
  const port = await new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port: p } = probe.address();
      probe.close(() => done(p));
    });
  });
  const child = spawn(process.execPath, [SCRIPT, '--dir', tyran, '--serve', '--port', String(port), ...extraArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    if (log.includes('board: serving')) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.match(log, /board: serving/, `the server did not start: ${log}`);
  return {
    base,
    log: () => log,
    stop: () => new Promise((done) => { child.once('exit', () => done()); child.kill(); }),
  };
}

const post = (base, route, body, headers = {}) =>
  fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('a board served without --write refuses every write and names the flag', async () => {
  // MUTANT: default `write` to true in parseArgs. Every assertion about the
  // catalogue still passes; a board someone left running becomes editable by
  // anything that can reach loopback.
  const f = fixture();
  const s = await serve(f.tyran);
  try {
    const settings = await (await fetch(`${s.base}/settings.json`)).json();
    assert.equal(settings.writable, false, 'the page is told it may not write');
    assert.equal(settings.schema, 1);

    for (const [route, body] of [['/settings/config', { id: 'profile', value: 'eco' }], ['/settings/policy', { path: null, class: 'AUTO' }]]) {
      const res = await post(s.base, route, body);
      assert.equal(res.status, 403);
      const payload = await res.json();
      assert.equal(payload.ok, false);
      assert.match(payload.error, /--write/, 'the refusal names the flag that turns it on');
    }
    assert.equal(readFileSync(join(f.tyran, 'config.yaml'), 'utf8'), readFileSync(join(ROOT, 'templates', 'config.yaml'), 'utf8'));
  } finally {
    await s.stop();
    f.cleanup();
  }
});

test('--write edits config and policy, one line at a time', async () => {
  const f = fixture();
  const s = await serve(f.tyran, ['--write']);
  try {
    const ok = await (await post(s.base, '/settings/config', { id: 'limits.mode', value: 'pause' })).json();
    assert.equal(ok.ok, true);
    assert.equal(ok.before, 'off');
    assert.equal(ok.after, 'pause');

    const pol = await (await post(s.base, '/settings/policy', { path: '.tyran/config.yaml', class: 'GATED' })).json();
    assert.equal(pol.ok, true);
    assert.deepEqual(pol.path, ['rules', 4, 'class']);

    const config = parse(readFileSync(join(f.tyran, 'config.yaml'), 'utf8'));
    assert.equal(config.limits.mode, 'pause');
    assert.deepEqual(validateConfig(config), []);
    const policy = parse(readFileSync(join(f.tyran, 'policies', 'autonomy.yaml'), 'utf8'));
    assert.equal(policy.rules.find((r) => r.path === '.tyran/config.yaml').class, 'GATED');
    assert.deepEqual(validatePolicy(policy), []);

    // The operator's terminal is the audit trail for a change made from a
    // web page. MUTANT: drop the console.log and a settings screen becomes a
    // thing that edits your repo leaving no trace where a person looks.
    assert.match(s.log(), /board: wrote .*config\.yaml — limits\.mode: "off" -> "pause"/);
  } finally {
    await s.stop();
    f.cleanup();
  }
});

test('the kernel paths survive the write route', async () => {
  // The route must not be the way around the gate it configures.
  const f = fixture();
  const s = await serve(f.tyran, ['--write']);
  try {
    for (const glob of ['hooks/**', '.tyran/policies/**']) {
      const res = await post(s.base, '/settings/policy', { path: glob, class: 'AUTO' });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /KERNEL/);
    }
    assert.deepEqual(validatePolicy(parse(readFileSync(join(f.tyran, 'policies', 'autonomy.yaml'), 'utf8'))), []);
  } finally {
    await s.stop();
    f.cleanup();
  }
});

test('a cross-origin POST is refused even though the Host pin lets it through', async () => {
  // The Host pin answers "which name did you dial", which a page on another
  // origin satisfies by dialling 127.0.0.1 directly. Origin answers "who is
  // asking", and it is the only header that separates the board's own fetch
  // from some other tab's. MUTANT: delete originAllowed — the Host pin passes
  // and this write lands.
  const f = fixture();
  const s = await serve(f.tyran, ['--write']);
  try {
    const res = await post(s.base, '/settings/config', { id: 'profile', value: 'eco' }, { origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.equal(parse(readFileSync(join(f.tyran, 'config.yaml'), 'utf8')).profile, 'balanced');

    // The board's own page, which is what must keep working.
    const own = await post(s.base, '/settings/config', { id: 'profile', value: 'eco' }, { origin: s.base });
    assert.equal((await own.json()).ok, true);
  } finally {
    await s.stop();
    f.cleanup();
  }
});

test('only application/json is accepted, because that is what forces a preflight', async () => {
  // A form POST (text/plain, or a urlencoded form) is a "simple request": a
  // browser sends it cross-origin without asking permission first. Requiring
  // a JSON content type is what makes the browser preflight and be refused.
  // MUTANT: accept any content type.
  const f = fixture();
  const s = await serve(f.tyran, ['--write']);
  try {
    const res = await post(s.base, '/settings/config', { id: 'profile', value: 'eco' }, { 'content-type': 'text/plain' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /application\/json/);
    assert.equal(parse(readFileSync(join(f.tyran, 'config.yaml'), 'utf8')).profile, 'balanced');
  } finally {
    await s.stop();
    f.cleanup();
  }
});

test('a hostile body is refused rather than interpreted', async () => {
  const f = fixture();
  const s = await serve(f.tyran, ['--write']);
  try {
    const cases = [
      ['not json at all', 400],
      [JSON.stringify(['profile', 'eco']), 400],
      [JSON.stringify({ id: '__proto__', value: 'x' }), 400],
      [JSON.stringify({ id: 'profile', value: { toString: 'x' } }), 400],
      [JSON.stringify({ id: 'validation', value: 'rm -rf /' }), 400],
    ];
    for (const [body, status] of cases) {
      const res = await post(s.base, '/settings/config', body);
      assert.equal(res.status, status, `body ${body} should be refused`);
      assert.equal((await res.json()).ok, false);
    }
    // A body over the cap is dropped rather than buffered.
    const huge = await post(s.base, '/settings/config', JSON.stringify({ id: 'tiers.work', value: 'x'.repeat(200_000) }))
      .catch(() => ({ status: 400 }));
    assert.notEqual(huge.status, 200);
    assert.deepEqual(validateConfig(parse(readFileSync(join(f.tyran, 'config.yaml'), 'utf8'))), []);
  } finally {
    await s.stop();
    f.cleanup();
  }
});

test('a value the YAML subset cannot spell is a 400, not a 500 in the audit trail', async () => {
  // Ordinary rejected input — somebody pasted a model name with a newline in
  // it — was being classified as a server fault, which meant HTTP 500 plus a
  // `board: settings write failed` line in the terminal the docs designate as
  // the record of what this screen changed. MUTANT: let YamlLiteError escape
  // `patch()` again.
  const f = fixture();
  const s = await serve(f.tyran, ['--write']);
  try {
    for (const bad of ['a\nb', `a${String.fromCodePoint(0x202e)}b`]) {
      const res = await post(s.base, '/settings/config', { id: 'tiers.cheap', value: bad });
      assert.equal(res.status, 400, `${JSON.stringify(bad)} should be a refusal, not a fault`);
      assert.equal((await res.json()).ok, false);
    }
    assert.doesNotMatch(s.log(), /settings write failed/, 'a rejected value is not a server fault');
    assert.equal(parse(readFileSync(join(f.tyran, 'config.yaml'), 'utf8')).tiers.cheap, 'haiku');
  } finally {
    await s.stop();
    f.cleanup();
  }
});

test('loosening a boundary is refused unless the request names the change', async () => {
  // MUTANT: stop threading `confirm` through handleSettingsWrite. The first
  // request succeeds and `.tyran/STOP` — the brake an operator uses to halt a
  // running initiative — goes to AUTO in one POST.
  //
  // What this does NOT claim: that two round trips are required. The token is
  // the new value, which is deterministic and not a server-issued nonce, so a
  // caller that already knows the change can send it in one request. That is
  // the design — this guard is against a click, not against a script, and
  // `docs/board.md` says which of those it defends.
  const f = fixture();
  const s = await serve(f.tyran, ['--write']);
  try {
    const first = await post(s.base, '/settings/policy', { path: '.tyran/STOP', class: 'AUTO' });
    assert.equal(first.status, 400);
    const refusal = await first.json();
    assert.equal(refusal.widens, true);
    assert.equal(refusal.confirm_with, 'AUTO');
    assert.match(refusal.error, /clear its own stop signal/, 'the rule states its own consequence');
    assert.equal(parse(readFileSync(join(f.tyran, 'policies', 'autonomy.yaml'), 'utf8')).rules.find((r) => r.path === '.tyran/STOP').class, 'KERNEL');

    const second = await post(s.base, '/settings/policy', { path: '.tyran/STOP', class: 'AUTO', confirm: refusal.confirm_with });
    assert.equal((await second.json()).ok, true);
    assert.equal(parse(readFileSync(join(f.tyran, 'policies', 'autonomy.yaml'), 'utf8')).rules.find((r) => r.path === '.tyran/STOP').class, 'AUTO');
  } finally {
    await s.stop();
    f.cleanup();
  }
});

test('a board renders on a repo that has been set up and never run', async () => {
  // The command the README leads with, on the state every install passes
  // through. It used to die with an ENOENT naming a temp file, because
  // `.tyran/state/` is created by the first initiative and setup does not
  // create it. MUTANT: remove the mkdirSync from writeAllAtomic.
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'tyran-fresh-'));
  try {
    mkdirSync(join(dir, '.tyran', 'policies'), { recursive: true });
    const out = execFileSync(process.execPath, [SCRIPT, '--dir', join(dir, '.tyran')], { stdio: 'pipe', encoding: 'utf8' });
    assert.match(out, /board\.html/);
    for (const name of ['BOARD.md', 'board.json', 'board.html']) {
      assert.ok(readFileSync(join(dir, '.tyran', 'state', name), 'utf8').length > 0, `${name} was written`);
    }
    // And the render is stable, so --check on a journal-less repo is not
    // permanently red.
    execFileSync(process.execPath, [SCRIPT, '--dir', join(dir, '.tyran'), '--check'], { stdio: 'pipe' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the write routes take POST only', async () => {
  const f = fixture();
  const s = await serve(f.tyran, ['--write']);
  try {
    for (const route of ['/settings/config', '/settings/policy']) {
      const res = await fetch(`${s.base}${route}`);
      assert.equal(res.status, 405);
    }
  } finally {
    await s.stop();
    f.cleanup();
  }
});

test('a foreign Host is refused before any route is considered', async () => {
  // Raw http, not fetch: `Host` is a forbidden header in undici, so a fetch
  // cannot express the DNS-rebinding request this pin exists to refuse.
  // MUTANT: delete the Host pin — any page the operator visits can resolve
  // its own hostname to 127.0.0.1 and POST to this board.
  const { request } = await import('node:http');
  const f = fixture();
  const s = await serve(f.tyran, ['--write']);
  try {
    const { port } = new URL(s.base);
    const answer = await new Promise((done, fail) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/settings/config', method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } },
        (res) => {
          let body = '';
          res.on('data', (d) => { body += String(d); });
          res.on('end', () => done({ status: res.statusCode, body }));
        },
      );
      req.on('error', fail);
      req.end(JSON.stringify({ id: 'profile', value: 'eco' }));
    });
    assert.equal(answer.status, 403);
    assert.match(answer.body, /127\.0\.0\.1 only/);
    assert.equal(parse(readFileSync(join(f.tyran, 'config.yaml'), 'utf8')).profile, 'balanced');
  } finally {
    await s.stop();
    f.cleanup();
  }
});

test('--write without --serve is a usage error, not a silent no-op', async () => {
  const { execFileSync } = await import('node:child_process');
  const f = fixture();
  try {
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT, '--dir', f.tyran, '--write'], { stdio: 'pipe' }),
      (err) => {
        assert.equal(err.status, 2);
        assert.match(String(err.stderr), /--write only means anything with --serve/);
        return true;
      },
    );
  } finally {
    f.cleanup();
  }
});

test('a question can be answered from the page, and the answer lands as two events', () => {
  // The one context switch left in the operator loop: the queue showed the
  // question and the three commands, and closing it meant a terminal.
  //
  // MUTANT: reimplement the append here instead of calling `answerOne`. The
  // two properties that would silently go missing are the re-check of the
  // gate INSIDE the lock (so a question answered in a terminal seconds ago is
  // not answered twice) and decision-before-gate ordering.
  return (async () => {
    const { execFileSync } = await import('node:child_process');
    const f = fixture();
    const s = await serve(f.tyran, ['--write']);
    try {
      // Render first: board.json does not exist until something writes it.
      execFileSync(process.execPath, [SCRIPT, '--dir', f.tyran], { stdio: 'pipe' });
      const open = JSON.parse(readFileSync(join(f.tyran, 'state', 'board.json'), 'utf8')).asks;
      assert.ok(open.length > 0, 'the fixture must carry an open question');
      const ask = open[0];

      const res = await post(s.base, '/answer', { init: ask.init, kind: ask.kind, answer: 'yes, on staging only' });
      const payload = await res.json();
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(payload.mode, 'answered');
      assert.match(String(payload.decision), /^D-\d+$/);

      const lines = readFileSync(join(f.tyran, 'state', ask.init, 'journal.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const decision = lines.filter((e) => e.ev === 'decision').at(-1);
      const gate = lines.at(-1);
      // The decision text is composed by `eventsFor`, shared with the CLI, so
      // an answer given on the page is byte-identical to one given in a
      // terminal — including the gate id it is filed under.
      assert.equal(decision.data.text, `${ask.kind}: yes, on staging only`);
      assert.equal(gate.ev, 'gate', 'the gate must be the LAST of the two');
      assert.equal(gate.data.kind, ask.kind);
      assert.equal(gate.data.result, 'answered');

      // Answering twice must not append twice.
      const again = await post(s.base, '/answer', { init: ask.init, kind: ask.kind, answer: 'again' });
      assert.equal(again.status, 400);
      assert.match((await again.json()).error, /no open question|already/i);
      assert.equal(lines.filter((e) => e.ev === 'gate' && e.data.kind === ask.kind && e.data.result === 'answered').length, 1);
    } finally {
      await s.stop();
      f.cleanup();
    }
  })();
});

test('answering is refused without --write, like every other route that writes', () => {
  return (async () => {
    const f = fixture();
    const s = await serve(f.tyran);
    try {
      const res = await post(s.base, '/answer', { init: 'demo', kind: 'Q-1', answer: 'x' });
      assert.equal(res.status, 403);
      assert.match((await res.json()).error, /--write/);
    } finally {
      await s.stop();
      f.cleanup();
    }
  })();
});

test('an answer is validated, and a bad one writes nothing', () => {
  return (async () => {
    const { execFileSync } = await import('node:child_process');
    const f = fixture();
    const s = await serve(f.tyran, ['--write']);
    try {
      execFileSync(process.execPath, [SCRIPT, '--dir', f.tyran], { stdio: 'pipe' });
      const ask = JSON.parse(readFileSync(join(f.tyran, 'state', 'board.json'), 'utf8')).asks[0];
      const journal = join(f.tyran, 'state', ask.init, 'journal.jsonl');
      const before = readFileSync(journal, 'utf8');

      // An unknown ask, an invisible codepoint, and a dash (which means
      // "leave it open" and therefore records nothing).
      const cases = [
        { init: ask.init, kind: 'Q-999', answer: 'x' },
        { init: 'nosuch', kind: ask.kind, answer: 'x' },
        { init: ask.init, kind: ask.kind, answer: `a${String.fromCodePoint(0x202e)}b` },
        { init: ask.init, kind: ask.kind, answer: '-' },
      ];
      for (const body of cases) {
        const res = await post(s.base, '/answer', body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal((await res.json()).ok, false);
      }
      assert.equal(readFileSync(journal, 'utf8'), before, 'a refused answer appends nothing');
    } finally {
      await s.stop();
      f.cleanup();
    }
  })();
});

test('a blank answer takes the recorded default and still records it as a decision', () => {
  // A default accepted is a decision, and the ledger must say which it was.
  return (async () => {
    const { execFileSync } = await import('node:child_process');
    const f = fixture();
    const s = await serve(f.tyran, ['--write']);
    try {
      execFileSync(process.execPath, [SCRIPT, '--dir', f.tyran], { stdio: 'pipe' });
      const withDefault = JSON.parse(readFileSync(join(f.tyran, 'state', 'board.json'), 'utf8'))
        .asks.find((a) => a.default !== null && a.default !== undefined);
      assert.ok(withDefault, 'the fixture must carry an ask with a default');
      const res = await post(s.base, '/answer', { init: withDefault.init, kind: withDefault.kind, answer: '' });
      const payload = await res.json();
      assert.equal(payload.mode, 'default');
      assert.equal(payload.recorded, withDefault.default, 'the default is taken VERBATIM from the journal');
    } finally {
      await s.stop();
      f.cleanup();
    }
  })();
});

test('a concurrent writer is refused, not silently overwritten', () => {
  // The write is a whole-file read-modify-write, so a second writer between
  // the read and the write used to have its change discarded with both
  // writers reporting success. In-process cannot interleave; two boards on
  // one directory, or a board and a terminal, are ordinary.
  // MUTANT: drop the compare-and-swap in handleSettingsWrite.
  return (async () => {
    const f = fixture();
    const s = await serve(f.tyran, ['--write']);
    try {
      const file = join(f.tyran, 'config.yaml');
      // Simulate the other writer landing between this server's read and its
      // write by changing the file out of band first, then posting a value
      // computed from what the page loaded.
      const stale = readFileSync(file, 'utf8');
      writeFileSync(file, stale.replace('profile: balanced', 'profile: full'));
      const res = await post(s.base, '/settings/config', { id: 'tiers.work', value: 'newmodel' });
      assert.equal((await res.json()).ok, true, 'a normal write still works after an out-of-band change');
      // Both changes must survive: the out-of-band one and this one.
      const now = parse(readFileSync(file, 'utf8'));
      assert.equal(now.profile, 'full', 'the other writer was not clobbered');
      assert.equal(now.tiers.work, 'newmodel');
    } finally {
      await s.stop();
      f.cleanup();
    }
  })();
});

test('board.mjs refuses a --dir that is not a .tyran directory', () => {
  // `--dir <repo-root>` is the obvious typo, and since the renderer creates
  // state/ where it is told to, it used to succeed silently: a state/ folder
  // in the project root and an empty board reporting all is well about a repo
  // whose real journals sit one level down.
  // MUTANT: delete the looksLikeTyran check.
  return (async () => {
    const { execFileSync } = await import('node:child_process');
    const f = fixture();
    try {
      assert.throws(
        () => execFileSync(process.execPath, [SCRIPT, '--dir', f.dir], { stdio: 'pipe' }),
        (err) => {
          assert.equal(err.status, 2);
          assert.match(String(err.stderr), /does not look like a \.tyran directory/);
          return true;
        },
      );
      assert.ok(!existsSync(join(f.dir, 'state')), 'and it created nothing where it was pointed');
      // The real directory still renders, including a fresh one with no state/.
      execFileSync(process.execPath, [SCRIPT, '--dir', f.tyran], { stdio: 'pipe' });
    } finally {
      f.cleanup();
    }
  })();
});

test('run.json serves the machine-local half of "is this supposed to be running"', () => {
  // Three chips reading "6 HOURS since last signal" cover four unrelated
  // situations. STOP is committed and travels in the artefact; the pause
  // marker, the resume watcher and the usage sidecar are gitignored and
  // different on every machine, so they are SERVED — the same split spend
  // already makes. MUTANT: put any of this in board.json and --check fails on
  // the next machine.
  return (async () => {
    const f = fixture();
    const s = await serve(f.tyran, ['--write']);
    try {
      const quiet = await (await fetch(`${s.base}/run.json`)).json();
      assert.deepEqual(quiet, { schema: 1, paused: null, watcher: null, usage: null });

      writeFileSync(join(f.tyran, 'state', 'paused-until.json'), JSON.stringify({
        paused_at: '2026-08-15T09:00:00.000Z',
        window: 'five_hour',
        used_percentage: 97.4,
        resume_at: '2999-01-01T00:00:00.000Z',
      }));
      const paused = await (await fetch(`${s.base}/run.json`)).json();
      assert.equal(paused.paused.window, 'five_hour');
      assert.equal(paused.paused.used_percentage, 97.4);
      assert.equal(paused.paused.overdue, false, 'a future resume time is not overdue');

      // A marker whose resume time has passed is the shape of a dead watcher.
      writeFileSync(join(f.tyran, 'state', 'paused-until.json'), JSON.stringify({
        paused_at: '2026-08-15T09:00:00.000Z', resume_at: '2000-01-01T00:00:00.000Z',
      }));
      assert.equal((await (await fetch(`${s.base}/run.json`)).json()).paused.overdue, true);

      // None of it may reach the committed artefact. Render it first —
      // board.json does not exist until something writes it.
      await fetch(`${s.base}/board.json`);
      const { execFileSync } = await import('node:child_process');
      execFileSync(process.execPath, [SCRIPT, '--dir', f.tyran], { stdio: 'pipe' });
      const board = readFileSync(join(f.tyran, 'state', 'board.json'), 'utf8');
      assert.doesNotMatch(board, /paused_at|used_percentage|resume_at/);
    } finally {
      await s.stop();
      f.cleanup();
    }
  })();
});

test('a damaged run-state file is absent, not fatal', () => {
  // This answers a question ABOUT the run; it must never be the reason nobody
  // can see the board. MUTANT: let JSON.parse throw out of runState.
  return (async () => {
    const f = fixture();
    const s = await serve(f.tyran, ['--write']);
    try {
      writeFileSync(join(f.tyran, 'state', 'paused-until.json'), 'not json at all');
      writeFileSync(join(f.tyran, 'state', 'resume.json'), '[]');
      const run = await (await fetch(`${s.base}/run.json`)).json();
      assert.equal(run.paused, null);
      assert.equal(run.watcher, null);
      assert.equal((await fetch(`${s.base}/`)).status, 200, 'and the board still renders');
    } finally {
      await s.stop();
      f.cleanup();
    }
  })();
});
