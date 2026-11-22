/**
 * A file the commit's own command line writes or names as a directory is
 * scanned, or the commit is refused (issue #105, point 2).
 *
 * The gate runs BEFORE the command. `cat src > f && git add f && git commit`
 * therefore reached it while `f` did not exist yet: the read came back empty
 * and the commit published whatever the first segment wrote, unscanned. The
 * same happened to an existing file overwritten by a redirection before a
 * `git commit -a`, and to the untracked files under a directory handed to
 * `git add` (`git add src/ && git commit`), which the gate read as one empty
 * "file".
 *
 * The content a command writes cannot be known before it runs, so a file in
 * the commit's reach that the same line writes first is REFUSED, with the
 * remedy that works: write in one command, commit in the next. A file the
 * line writes but the commit does not take (an untracked log beside `-a`, an
 * ignored file beside `-A`, anything outside the repository, or a write AFTER
 * the commit) is not a reason to refuse, because refusing those is the false
 * alarm this gate keeps being uninstalled over.
 *
 * Real git, real gitleaks, real temporary repositories. Every secret-shaped
 * string is built at run time, and it is kept OUT of the command text, which
 * the gate scans on its own: the key lives in a file outside the repository.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PASS } from '../../hooks/scripts/hook-io.mjs';
import { handle, planCommand } from '../../hooks/scripts/secrets-gate.mjs';

const HAVE_GITLEAKS = spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).error === undefined;
const NEEDS_SCANNER = HAVE_GITLEAKS
  ? false
  : 'gitleaks is not installed here; the planCommand tests below still cover the parser. ' +
    'CI installs it (see ci.yml) and fails on any skip.';

const temps = [];
function tempDir(prefix = 'tyran-same-') {
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

/** A repository with one commit, and a key in a file OUTSIDE it. */
function setup() {
  const dir = tempDir();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'gate@test.invalid');
  git(dir, 'config', 'user.name', 'gate');
  put(dir, 'readme.txt', 'hello\n');
  put(dir, 'b.txt', 'clean\n');
  put(dir, '.gitignore', 'ignored/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const src = join(tempDir('tyran-same-src-'), 'key.txt');
  writeFileSync(src, fakeSecret());
  return { dir, src };
}

const bashInput = (command, cwd) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } });
const gate = (command, cwd) => handle({ input: bashInput(command, cwd), cwd });

// ------------------------------------------------------------------ the plan

test('plan: a redirection and a tee before a commit are recorded as written paths', () => {
  const plan = planCommand('cat k > a.pem && printf x >> sub/b.txt && echo y | tee -a c.txt d.txt && git add -A && git commit -m x', '/repo');
  assert.deepEqual(plan.targets[0].writtenBefore, ['/repo/a.pem', '/repo/sub/b.txt', '/repo/c.txt', '/repo/d.txt']);
});

test('plan: a descriptor duplication and a write after the commit are not written paths', () => {
  const plan = planCommand('git commit -am x 2>&1 > /dev/null; git log > log.txt', '/repo');
  assert.deepEqual(plan.targets[0].writtenBefore ?? [], []);
  assert.deepEqual(planCommand('echo a >&2 && git commit -am x', '/repo').targets[0].writtenBefore ?? [], []);
});

test('plan: a write is resolved where the shell was when it ran', () => {
  const plan = planCommand('cd sub && cat k > new.pem && cd .. && git add -A && git commit -m x', '/repo');
  assert.deepEqual(plan.targets[0].writtenBefore, ['/repo/sub/new.pem']);
});

// ------------------------------------------- the reproduction: point 2 itself

test('gate: a file created by the same command that adds and commits it is refused', { skip: NEEDS_SCANNER }, async () => {
  const { dir, src } = setup();
  for (const command of [
    `cat ${src} > new.pem && git add new.pem && git commit -m x`,
    `cat ${src} > new.pem && git add -A && git commit -m x`,
    `cat ${src} | tee new.pem && git add . && git commit -m x`,
    `mkdir -p src && cat ${src} > src/new.pem && git add src/ && git commit -m x`,
  ]) {
    const verdict = await gate(command, dir);
    assert.equal(verdict.decision, 'deny', `${command}: ${JSON.stringify(verdict)}`);
    assert.match(verdict.reason, /written by this same command/, command);
  }
});

test('gate: an existing tracked file overwritten before `git commit -a` is refused', { skip: NEEDS_SCANNER }, async () => {
  const { dir, src } = setup();
  const verdict = await gate(`cat ${src} > b.txt && git commit -am x`, dir);
  assert.equal(verdict.decision, 'deny', JSON.stringify(verdict));
  assert.match(verdict.reason, /b\.txt/);
});

test('gate: a file another program creates before `git add` names it is refused, not read as empty', { skip: NEEDS_SCANNER }, async () => {
  // No redirection to see: `cp` writes it. The file does not exist when the
  // gate runs and git does not track it, so the commit can only contain what
  // the line creates.
  const { dir, src } = setup();
  const verdict = await gate(`cp ${src} new.pem && git add new.pem && git commit -m x`, dir);
  assert.equal(verdict.decision, 'deny', JSON.stringify(verdict));
  assert.match(verdict.reason, /new\.pem/);
});

test('gate: `git add dir/` scans the untracked files under that directory', { skip: NEEDS_SCANNER }, async () => {
  const { dir } = setup();
  put(dir, 'src/deep/new.pem', fakeSecret());
  const verdict = await gate('git add src/ && git commit -m x', dir);
  assert.equal(verdict.decision, 'deny', JSON.stringify(verdict));
  assert.match(verdict.reason, /src\/deep\/new\.pem/);
});

// ----------------------------------------------- what must NOT start refusing

test('gate: writes the commit does not take are no reason to refuse', { skip: NEEDS_SCANNER }, async () => {
  const { dir } = setup();
  put(dir, 'b.txt', 'clean, edited\n');
  for (const command of [
    'npm test > out.log && git commit -am x', // untracked, and -a takes tracked files only
    'echo done > /dev/null && git add b.txt && git commit -m x',
    `echo note > ${join(tempDir(), 'n.txt')} && git add -A && git commit -m x`, // outside the repository
    'echo cache > ignored/c.txt && git add -A && git commit -m x', // ignored
    'git commit -am x 2>&1 | tee commit.log', // written while and after the commit runs
    'echo a >&2 && git commit -am x',
  ]) {
    const verdict = await gate(command, dir);
    assert.deepEqual(verdict, PASS, `${command}: ${JSON.stringify(verdict)}`);
  }
});

test('gate: a tracked file removed and then staged is a deletion, not a refusal', { skip: NEEDS_SCANNER }, async () => {
  const { dir } = setup();
  const verdict = await gate('rm b.txt && git add b.txt && git commit -m x', dir);
  assert.deepEqual(verdict, PASS, JSON.stringify(verdict));
});

test('gate: `git add dir/` with only clean files under it passes', { skip: NEEDS_SCANNER }, async () => {
  const { dir } = setup();
  put(dir, 'src/a.txt', 'clean\n');
  put(dir, 'src/deep/b.txt', 'also clean\n');
  const verdict = await gate('git add src/ && git commit -m x', dir);
  assert.deepEqual(verdict, PASS, JSON.stringify(verdict));
});
