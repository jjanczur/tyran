/**
 * A push that only DELETES remote refs publishes no objects, and the secrets
 * gate must not refuse it for the size of what it would publish.
 *
 * Reported from a real install: `git push -q origin --delete review/a
 * review/b` was refused with "this would publish 1370527212 bytes in 9130
 * object(s), past the 10485760 this gate can scan". The two names were read as
 * refspec SOURCES; neither resolved locally, so `pushRange` widened to `--all
 * --not --remotes=origin` - every unpushed commit on every local branch - for a
 * command that sends git no object at all. `git push origin :refs/heads/x`
 * took the same path, because its empty source is dropped and an empty list is
 * `pushRange`'s encoding of the wide range.
 *
 * The other direction is the one that must not regress: a line that deletes
 * one ref AND pushes another still scans what the other one publishes, in
 * either order, in one segment (`:old main`) or two (`... && git push ...`).
 * Two pushes in one line are scanned as the UNION of their refs; before this
 * file the second segment's refs replaced the first's, which let
 * `git push origin leaky && git push origin main` publish `leaky` unscanned.
 *
 * Real git, real gitleaks, real temporary repositories. Every secret-shaped
 * string is built at run time; nothing on disk here looks like a key.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PASS } from '../../hooks/scripts/hook-io.mjs';
import { MAX_PAYLOAD_BYTES, handle, planCommand } from '../../hooks/scripts/secrets-gate.mjs';

const HAVE_GITLEAKS = spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).error === undefined;
const NEEDS_SCANNER = HAVE_GITLEAKS
  ? false
  : 'gitleaks is not installed here; the planCommand tests below still cover the parser. ' +
    'CI installs it (see ci.yml) and fails on any skip.';

const temps = [];
function tempDir(prefix) {
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

/**
 * A repository with an `origin` holding `main` and `gone`, and one unpushed
 * local branch whose single file is `content`. The local `gone` is removed, as
 * it was in the reported case: the names being deleted did not exist locally.
 */
function repoWithUnpushedBranch(branch, content) {
  const bare = tempDir('tyran-del-origin-');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const dir = tempDir('tyran-del-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'gate@test.invalid');
  git(dir, 'config', 'user.name', 'gate');
  git(dir, 'remote', 'add', 'origin', bare);
  writeFileSync(join(dir, 'readme.txt'), 'published already\n');
  git(dir, 'add', 'readme.txt');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'push', '-q', 'origin', 'main', 'main:refs/heads/gone');
  git(dir, 'checkout', '-q', '-b', branch);
  writeFileSync(join(dir, 'payload.txt'), content);
  git(dir, 'add', 'payload.txt');
  git(dir, 'commit', '-q', '-m', 'unpushed');
  git(dir, 'checkout', '-q', 'main');
  return dir;
}

const bashInput = (command, cwd) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } });
const pushTargets = (command) => planCommand(command, '/repo').targets.filter((t) => t.scanPush === true);

// ---------------------------------------------------------------------------
// planCommand: which spellings publish nothing

test('plan: the reported command is a deletion and publishes nothing', () => {
  const [target] = pushTargets('git push -q origin --delete review/m2-sdt1-pre review/m2-shmeta-pre');
  assert.equal(target.pushDeletesOnly, true);
  // The policy gate still reads WHERE it lands, so the argv is kept.
  assert.deepEqual(target.pushArgv, ['-q', 'origin', '--delete', 'review/m2-sdt1-pre', 'review/m2-shmeta-pre']);
});

test('plan: every deletion spelling git accepts is recognised', () => {
  for (const command of [
    'git push origin --delete a',
    'git push --delete origin a b',
    'git push origin -d a',
    'git push -qd origin a',
    'git push origin --dele a',
    'git push origin :a',
    'git push origin :refs/heads/a :refs/tags/v1',
    'git push origin +:a',
    'git push --porcelain --dry-run origin :a',
    'git -C /elsewhere push origin --delete a',
  ]) {
    const targets = pushTargets(command);
    assert.equal(targets.length, 1, command);
    assert.equal(targets[0].pushDeletesOnly, true, command);
  }
});

test('plan: a push that may publish something is never read as a deletion', () => {
  for (const command of [
    'git push origin :', // the MATCHING refspec: pushes every branch both sides have
    'git push origin :gone main',
    'git push origin main :gone',
    'git push origin --delete', // no ref named: git errors, but nothing here says so
    'git push origin',
    'git push',
    'git push origin --delete --no-delete a',
    'git push --mirror --delete origin a',
    'git push --all origin :a',
    'git push --tags origin :a',
    'git push -o ci.skip origin --delete a', // a flag with a value: positions are unreadable
    'git push --push-option=x origin --delete a',
    'git push -fd origin a',
    'git push origin --delete "$BRANCH"',
    'git push origin :$BRANCH',
  ]) {
    for (const target of pushTargets(command)) {
      assert.notEqual(target.pushDeletesOnly, true, command);
    }
  }
});

test('plan: a deletion beside a real refspec still scans the real one', () => {
  const [target] = pushTargets('git push origin :gone main');
  assert.deepEqual(target.pushRefs, ['main']);
});

test('plan: a deletion in one segment does not hide a push in another, in either order', () => {
  for (const command of [
    'git push origin --delete gone && git push origin leaky',
    'git push origin leaky && git push origin --delete gone',
    'git push origin leaky; git push origin :gone',
  ]) {
    const [target] = pushTargets(command);
    assert.notEqual(target.pushDeletesOnly, true, command);
    assert.deepEqual(target.pushRefs, ['leaky'], command);
  }
});

test('plan: a gh publish after a deletion is scanned, not swallowed by it', () => {
  const [target] = pushTargets('git push origin --delete gone && gh pr create --title x');
  assert.notEqual(target.pushDeletesOnly, true);
  assert.deepEqual(target.pushRefs, ['HEAD']);
});

test('plan: two pushes in one line scan the union of their refs', () => {
  assert.deepEqual(pushTargets('git push origin leaky && git push origin main')[0].pushRefs, ['leaky', 'main']);
});

test('plan: a wide push stays wide when a narrow one follows', () => {
  // `pushRefs: []` is the wide range (`--all`); a later narrow push must not
  // upgrade it to a narrow one.
  for (const command of ['git push origin && git push origin main', 'git push origin main && git push origin']) {
    assert.deepEqual(pushTargets(command)[0].pushRefs, [], command);
  }
});

// ---------------------------------------------------------------------------
// the gate, end to end

test('gate: deleting remote refs is not refused for the size of unpushed work', { skip: NEEDS_SCANNER }, async () => {
  // The reported failure, at its real cause: another local branch carries more
  // than the gate can scan, and the deletion publishes none of it.
  const dir = repoWithUnpushedBranch('big', randomBytes(MAX_PAYLOAD_BYTES + 1024 * 1024).toString('base64'));
  for (const command of ['git push -q origin --delete gone', 'git push origin :refs/heads/gone']) {
    const verdict = await handle({ input: bashInput(command, dir), cwd: dir });
    assert.deepEqual(verdict, PASS, `${command}: ${JSON.stringify(verdict)}`);
  }
});

test('gate: the same repository still refuses a push of the big branch', { skip: NEEDS_SCANNER }, async () => {
  const dir = repoWithUnpushedBranch('big', randomBytes(MAX_PAYLOAD_BYTES + 1024 * 1024).toString('base64'));
  const verdict = await handle({ input: bashInput('git push origin :gone big', dir), cwd: dir });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /past the \d+ this gate can scan/);
});

test('gate: a deletion is not refused for a secret on a branch it does not publish', { skip: NEEDS_SCANNER }, async () => {
  const dir = repoWithUnpushedBranch('leaky', fakeSecret());
  const verdict = await handle({ input: bashInput('git push origin --delete gone', dir), cwd: dir });
  assert.deepEqual(verdict, PASS, JSON.stringify(verdict));
});

test('gate: a mixed push still finds the secret it would publish', { skip: NEEDS_SCANNER }, async () => {
  const dir = repoWithUnpushedBranch('leaky', fakeSecret());
  for (const command of [
    'git push origin :gone leaky',
    'git push origin --delete gone && git push origin leaky',
    'git push origin leaky && git push origin --delete gone',
    'git push origin leaky && git push origin main',
  ]) {
    const verdict = await handle({ input: bashInput(command, dir), cwd: dir });
    assert.equal(verdict.decision, 'deny', `${command}: ${JSON.stringify(verdict)}`);
    assert.match(verdict.reason, /secret-shaped finding/, command);
  }
});

test('gate: the command line of a deletion is still scanned', { skip: NEEDS_SCANNER }, async () => {
  const dir = repoWithUnpushedBranch('leaky', 'nothing here\n');
  const secret = randomBytes(24).toString('base64url');
  const command = `git push origin --delete gone && echo "api_key=${secret}"`;
  assert.equal(pushTargets(command)[0].pushDeletesOnly, true, 'the case under test is a deletion');
  const verdict = await handle({ input: bashInput(command, dir), cwd: dir });
  assert.equal(verdict.decision, 'deny', JSON.stringify(verdict));
  assert.equal(verdict.reason.includes(secret), false, 'the refusal must not quote the secret');
});
