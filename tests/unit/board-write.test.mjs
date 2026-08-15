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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
