/**
 * The secrets gate scans each file under its own PATH when the repository
 * tracks a `.gitleaks.toml`, and a commit with a pathspec scans what that
 * commit contains (issue #105, points 1 and 3).
 *
 * Point 1. The gate piped every file into ONE `gitleaks stdin` buffer, so
 * every finding had `File: ""`. A `paths` allowlist in a tracked config could
 * then never match a real file, so a fixture under `__tests__/` was refused
 * whatever the allowlist said. With a tracked config the gate now writes the files it
 * determined into a temporary tree and runs `gitleaks dir` over it, and the
 * coverage arithmetic stays: every file written is accounted for in the
 * scanner's own trace as read or as skipped by the allowlist, and the bytes it
 * read are the bytes of the files it says it read.
 *
 * Point 3. A commit with a pathspec (`git commit -m x -- b.txt`) commits the
 * WORKING-TREE content of the named paths and nothing else that is staged.
 * The gate scanned the whole index instead: an unrelated staged key refused
 * the commit, and a key in an unstaged edit of the named path was published
 * unscanned.
 *
 * Real git, real gitleaks, real temporary repositories. Every secret-shaped
 * string is built at run time; nothing on disk here looks like a key.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PASS } from '../../hooks/scripts/hook-io.mjs';
import { handle, makeBudget, pathScanRounds, planCommand, scanTree } from '../../hooks/scripts/secrets-gate.mjs';

const HAVE_GITLEAKS = spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).error === undefined;
const NEEDS_SCANNER = HAVE_GITLEAKS
  ? false
  : 'gitleaks is not installed here; the planCommand tests below still cover the parser. ' +
    'CI installs it (see ci.yml) and fails on any skip.';

const temps = [];
function tempDir(prefix = 'tyran-paths-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of temps) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Assembled from fragments so the bytes on disk never spell a key header. */
function fakeSecret() {
  const label = 'RSA PRIVATE KEY';
  const body = `${randomBytes(48).toString('base64')}\n${randomBytes(48).toString('base64')}`;
  return `${'-----BEGIN '}${label}-----\n${body}\n${'-----END '}${label}-----\n`;
}

function put(dir, rel, content) {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

/** A repository with one commit; `config` (if any) is committed as `.gitleaks.toml`. */
function repo(config = null) {
  const dir = tempDir();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'gate@test.invalid');
  git(dir, 'config', 'user.name', 'gate');
  put(dir, 'readme.txt', 'hello\n');
  put(dir, 'b.txt', 'clean\n');
  if (config !== null) put(dir, '.gitleaks.toml', config);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

const OR_TESTS = `[extend]
useDefault = true

[allowlist]
description = "fixtures"
paths = ['''^__tests__/''']
`;

// The issue's AND case: the path AND the match, together.
const AND_TESTS = `[extend]
useDefault = true

[[allowlists]]
description = "fixtures"
condition = "AND"
paths = ['''^__tests__/''']
regexTarget = "match"
regexes = ['''PRIVATE KEY''']
`;

// A path regex that also matches the EMPTY string. The issue reports an OR
// allowlist that let a key under `src/` through; this shape is the obvious way
// for that to happen once every File is "". It did NOT reproduce on gitleaks
// 8.30.1 (the stdin scan refuses it too), so it is pinned as a guard: the path
// scan must not make it start passing.
const MATCHES_EMPTY = `[extend]
useDefault = true

[allowlist]
description = "fixtures, or nothing"
paths = ['''^(__tests__/.*)?$''']
`;

const bashInput = (command, cwd) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } });
const gate = (command, cwd) => handle({ input: bashInput(command, cwd), cwd });

// ------------------------------------------------- point 1: path allowlists

test('gate: a path allowlist in a tracked config lets a fixture under that path through', { skip: NEEDS_SCANNER }, async () => {
  for (const config of [OR_TESTS, AND_TESTS]) {
    const dir = repo(config);
    put(dir, '__tests__/fixture.pem', fakeSecret());
    git(dir, 'add', '__tests__/fixture.pem');
    const verdict = await gate('git commit -m x', dir);
    assert.deepEqual(verdict, PASS, `${config}\n${JSON.stringify(verdict)}`);
  }
});

test('gate: the same allowlist still refuses a key outside that path, and names it', { skip: NEEDS_SCANNER }, async () => {
  for (const config of [OR_TESTS, AND_TESTS]) {
    const dir = repo(config);
    put(dir, '__tests__/fixture.pem', fakeSecret());
    put(dir, 'src/server.pem', fakeSecret());
    git(dir, 'add', '-A');
    const verdict = await gate('git commit -m x', dir);
    assert.equal(verdict.decision, 'deny', config);
    assert.match(verdict.reason, /"src\/server\.pem":1 /, config);
    assert.doesNotMatch(verdict.reason, /__tests__/, config);
  }
});

test('gate: an allowlist regex that matches the empty string does not silence a file outside it', { skip: NEEDS_SCANNER }, async () => {
  const dir = repo(MATCHES_EMPTY);
  put(dir, 'src/server.pem', fakeSecret());
  git(dir, 'add', '-A');
  const verdict = await gate('git commit -m x', dir);
  assert.equal(verdict.decision, 'deny', JSON.stringify(verdict));
  assert.match(verdict.reason, /src\/server\.pem/);
});

test('gate: a file the path scan never reports is scanned over stdin, not dropped', { skip: NEEDS_SCANNER }, async () => {
  // Measured on gitleaks 8.30.1: `gitleaks dir` neither reads nor reports a
  // file under `node_modules/`; its trace does not name it at all. The
  // accounting must notice and send it to stdin, where it is refused.
  const dir = repo(OR_TESTS);
  put(dir, 'node_modules/pkg/key.pem', fakeSecret());
  git(dir, 'add', '-f', 'node_modules/pkg/key.pem');
  const verdict = await gate('git commit -m x', dir);
  assert.equal(verdict.decision, 'deny', JSON.stringify(verdict));
  assert.match(verdict.reason, /node_modules\/pkg\/key\.pem/);
});

test('gate: without a tracked config nothing changes - a fixture is refused as before', { skip: NEEDS_SCANNER }, async () => {
  const dir = repo();
  put(dir, '__tests__/fixture.pem', fakeSecret());
  git(dir, 'add', '-A');
  const verdict = await gate('git commit -m x', dir);
  assert.equal(verdict.decision, 'deny');
});

test('gate: a push range with two versions of one allowlisted fixture passes, of one source file refuses', { skip: NEEDS_SCANNER }, async () => {
  const bare = tempDir('tyran-paths-origin-');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const dir = repo(OR_TESTS);
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', 'origin', 'main');
  for (const n of [1, 2]) {
    put(dir, '__tests__/fixture.pem', fakeSecret());
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `fixture ${n}`);
  }
  assert.deepEqual(await gate('git push origin main', dir), PASS);
  for (const n of [1, 2]) {
    put(dir, 'src/server.pem', fakeSecret());
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `server ${n}`);
  }
  const verdict = await gate('git push origin main', dir);
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /src\/server\.pem/);
});

test('rounds: one path per round, case folded, and no file where a directory must go', () => {
  const chunk = (label) => ({ label, body: Buffer.from('x') });
  const { rounds, rest } = pathScanRounds([
    chunk('a/b.txt'),
    chunk('A/B.TXT'), // the same file on a case-insensitive disk
    chunk('a'), // a file where `a/` must be a directory
    chunk('c.txt'),
    chunk('../outside.txt'),
    chunk('/abs/path.txt'),
    chunk('sub/.gitleaksignore'), // never written where the scanner would read it as config
    chunk('.gitleaks.toml'),
    chunk('x/./y'),
    chunk(''),
  ]);
  assert.deepEqual(
    rounds.map((r) => r.map((c) => c.label)),
    [['a/b.txt', 'c.txt'], ['A/B.TXT'], ['a']],
  );
  assert.deepEqual(
    rest.map((c) => c.label),
    ['../outside.txt', '/abs/path.txt', 'sub/.gitleaksignore', '.gitleaks.toml', 'x/./y', ''],
  );
});

// The coverage rule of a path scan, against a scanner whose trace is scripted:
// every file written must be named as read or as skipped by the allowlist, and
// the bytes it reports must be the bytes of the files it read. Anything else
// returns null, and the caller scans those files over stdin instead.

function scriptedScanner(trace) {
  return async (bin, args) => {
    writeFileSync(args[args.indexOf('--report-path') + 1], '[]');
    return { spawned: true, timedOut: false, code: 0, stdout: '', stderr: trace };
  };
}
const chunks = [
  { label: 'src/a.txt', body: Buffer.from('aaaa') },
  { label: '__tests__/b.txt', body: Buffer.from('bb') },
];
const scan = (trace) =>
  scanTree(chunks, { runner: scriptedScanner(trace), budget: makeBudget(Date.now()), workDir: tempDir() });

test('scanTree: a scan whose trace accounts for every file and byte is trusted', async () => {
  const trace = [
    'DBG skipping file: global allowlist path=__tests__/b.txt',
    'TRC scanning path path=src/a.txt',
    'INF scanned ~4 bytes (4 bytes) in 1ms',
  ].join('\n');
  assert.deepEqual(await scan(trace), []);
});

test('scanTree: a file the trace does not name is not trusted', async () => {
  assert.equal(await scan('TRC scanning path path=src/a.txt\nINF scanned ~4 bytes (4 bytes) in 1ms'), null);
});

test('scanTree: a skip for any reason but the allowlist is not trusted', async () => {
  const trace = [
    'DBG skipping file: too large path=__tests__/b.txt',
    'TRC scanning path path=src/a.txt',
    'INF scanned ~4 bytes (4 bytes) in 1ms',
  ].join('\n');
  assert.equal(await scan(trace), null);
});

test('scanTree: a byte count that disagrees with the files read is not trusted', async () => {
  const trace = [
    'TRC scanning path path=__tests__/b.txt',
    'TRC scanning path path=src/a.txt',
    'INF scanned ~4 bytes (4 bytes) in 1ms',
  ].join('\n');
  assert.equal(await scan(trace), null);
});

test('scanTree: a path the gate never wrote is not trusted', async () => {
  const trace = [
    'DBG skipping file: global allowlist path=__tests__/b.txt',
    'TRC scanning path path=src/a.txt',
    'TRC scanning path path=elsewhere.txt',
    'INF scanned ~4 bytes (4 bytes) in 1ms',
  ].join('\n');
  assert.equal(await scan(trace), null);
});

// ------------------------------------------------- point 3: pathspec commits

test('plan: a commit with a pathspec records it, in --only mode by default', () => {
  const cases = [
    ['git commit -m x -- b.txt', ['b.txt'], 'only'],
    ['git commit -m "a message" b.txt c/d.txt', ['b.txt', 'c/d.txt'], 'only'],
    ['git commit -o -m x b.txt', ['b.txt'], 'only'],
    ['git commit --only -m x -- b.txt', ['b.txt'], 'only'],
    ['git commit -i -m x -- b.txt', ['b.txt'], 'include'],
    ['git commit --amend --no-edit -- b.txt', ['b.txt'], 'only'],
    ['git -c user.name="A B" commit -m x -- b.txt', ['b.txt'], 'only'],
    ['git commit -F - b.txt', ['b.txt'], 'only'],
    ['git commit --author="A B" --date=now -m x b.txt', ['b.txt'], 'only'],
  ];
  for (const [command, paths, mode] of cases) {
    const [target] = planCommand(command, '/repo').targets;
    assert.deepEqual(target.commitPaths, paths, command);
    assert.equal(target.commitMode, mode, command);
  }
});

test('plan: a commit whose pathspec cannot be read is planned exactly as before', () => {
  for (const command of [
    'git commit -m x', // no pathspec
    'git commit -m "add b.txt"', // the message is not a pathspec
    'git commit -m "fix; b.txt"', // a separator in the message: no narrowing
    'git commit -m x -- $F', // the shell would expand it
    "git commit -m x -- '*.txt'", // a glob is git's to expand, not narrowed here
    'git commit -a -m x -- b.txt', // git refuses -a with paths
    'git commit --pathspec-from-file=list -m x',
    'git commit -m x --frobnicate b.txt', // a flag this parser does not know
    'git commit -am x b.txt',
    // `<` and `>` are separators to the quote-blind split, so the segment
    // ends inside the quote; an open quote never narrows
    'git commit --author="A B <a@b>" -m x b.txt',
    'git commit -m x # b.txt', // a comment, not a pathspec
  ]) {
    const [target] = planCommand(command, '/repo').targets;
    assert.equal(target.commitPaths ?? null, null, command);
  }
});

test('gate: a pathspec commit is not refused for a key staged in another file', { skip: NEEDS_SCANNER }, async () => {
  const dir = repo();
  put(dir, 'a.txt', fakeSecret());
  git(dir, 'add', 'a.txt');
  put(dir, 'b.txt', 'clean, edited\n');
  for (const command of ['git commit -m x -- b.txt', 'git commit -m x b.txt', 'git commit -o -m x b.txt']) {
    const verdict = await gate(command, dir);
    assert.deepEqual(verdict, PASS, `${command}: ${JSON.stringify(verdict)}`);
  }
});

test('gate: a pathspec commit scans the WORKING-TREE content of the path it names', { skip: NEEDS_SCANNER }, async () => {
  const dir = repo();
  put(dir, 'b.txt', `clean\n${fakeSecret()}`);
  // not staged: `git commit -- b.txt` commits it anyway
  for (const command of ['git commit -m x -- b.txt', 'git commit -m x b.txt']) {
    const verdict = await gate(command, dir);
    assert.equal(verdict.decision, 'deny', command);
    assert.match(verdict.reason, /b\.txt/, command);
  }
});

test('gate: --include commits the index too, so a staged key elsewhere still refuses', { skip: NEEDS_SCANNER }, async () => {
  const dir = repo();
  put(dir, 'a.txt', fakeSecret());
  git(dir, 'add', 'a.txt');
  put(dir, 'b.txt', 'clean, edited\n');
  const verdict = await gate('git commit -i -m x -- b.txt', dir);
  assert.equal(verdict.decision, 'deny');
});

test('gate: a message that only LOOKS like a pathspec does not narrow the scan', { skip: NEEDS_SCANNER }, async () => {
  const dir = repo();
  put(dir, 'a.txt', fakeSecret());
  git(dir, 'add', 'a.txt');
  for (const command of ['git commit -m "update b.txt"', 'git commit -m "fix; b.txt"']) {
    assert.equal((await gate(command, dir)).decision, 'deny', command);
  }
});

test('gate: a pathspec commit in a repository with no commits yet is scanned, not narrowed', { skip: NEEDS_SCANNER }, async () => {
  const dir = tempDir();
  git(dir, 'init', '-q', '-b', 'main');
  put(dir, 'b.txt', fakeSecret());
  git(dir, 'add', 'b.txt');
  assert.equal((await gate('git commit -m x -- b.txt', dir)).decision, 'deny');
});

test('gate: words that only look like a pathspec do not narrow the scan', { skip: NEEDS_SCANNER }, async () => {
  // `#` starts a comment, so the shell commits the whole index; `fix the bug`
  // unquoted makes `the` and `bug` pathspecs git would refuse. Narrowing on
  // either would scan an empty diff while the index holds the key.
  const dir = repo();
  put(dir, 'a.txt', fakeSecret());
  git(dir, 'add', 'a.txt');
  for (const command of ['git commit -m x # note', 'git commit -m x -- nothere.txt', 'git commit -m fix the bug']) {
    assert.equal((await gate(command, dir)).decision, 'deny', command);
  }
});

test('gate: two commits in one line scan what BOTH commit', { skip: NEEDS_SCANNER }, async () => {
  // The target is one per repository, and the second commit's plan replaced
  // the first's: its pathspec narrowed the first commit's scan, and its
  // missing `-a` dropped the first commit's working tree.
  const staged = repo();
  put(staged, 'a.txt', fakeSecret());
  git(staged, 'add', 'a.txt');
  put(staged, 'b.txt', 'clean, edited\n');
  assert.equal((await gate('git commit -m a && git commit -m b -- b.txt', staged)).decision, 'deny');

  const unstaged = repo();
  put(unstaged, 'b.txt', `clean\n${fakeSecret()}`);
  for (const command of [
    'git commit -m a -- b.txt && git commit -m b -- readme.txt',
    'git commit -am a && git commit -m b',
    'git commit -m a && git commit -m b -- b.txt',
  ]) {
    assert.equal((await gate(command, unstaged)).decision, 'deny', command);
  }
});

test('gate: two `git add`s before a commit fold BOTH into the scan', { skip: NEEDS_SCANNER }, async () => {
  const dir = repo();
  put(dir, 'new.pem', fakeSecret());
  put(dir, 'other.txt', 'clean\n');
  const verdict = await gate('git add new.pem && git add other.txt && git commit -m x', dir);
  assert.equal(verdict.decision, 'deny', JSON.stringify(verdict));
});

// ------------------------------- found on the way: `git add` from a subdirectory

test('gate: `cd sub && git add new && git commit` reads the new file where the shell added it', { skip: NEEDS_SCANNER }, async () => {
  // The added path was joined to the repository ROOT, not to the directory the
  // `git add` ran in, so `sub/new.pem` was read as `new.pem`, did not exist,
  // and the commit published it unscanned.
  const dir = repo();
  put(dir, 'sub/new.pem', fakeSecret());
  const verdict = await gate(`cd ${join(dir, 'sub')} && git add new.pem && git commit -m x`, dir);
  assert.equal(verdict.decision, 'deny', JSON.stringify(verdict));
  assert.match(verdict.reason, /sub\/new\.pem/);
});
