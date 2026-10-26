/**
 * The secrets gate must recognise `git commit` / `git push` through a QUOTED
 * value that carries a space (PV3-TYRAN-SECRETS-GATE-PARSER).
 *
 * Measured on 0.1.48 by invoking the hook by hand with two real findings
 * staged: `git commit -m x` and `git -c user.name=JJ commit -m x` were refused,
 * while `git -c user.name="Jacek Janczura" commit -m x`,
 * `git -c 'user.name=Jacek Janczura' commit -m x` and
 * `GIT_AUTHOR_NAME='Jacek Janczura' git commit -m x` PASSED UNSCANNED.
 *
 * Mechanism: `tokensOf` splits a segment on whitespace before it drops the
 * quote characters, so `user.name="Jacek Janczura"` becomes two words. The
 * subcommand resolver skips `-c` plus ONE value and reads `Janczura` as the
 * verb. In the env-prefix spelling the program slot becomes `Janczura` and the
 * resolver, which always starts at index 1, reads `git` as the verb. Either
 * way no target is noted, `needsScan` is false and `decide` returns PASS
 * before any scan: this gate's one irreversible failure, from a spelling.
 *
 * The same mechanism blinds `git push` (and the policy gate's deployment
 * check, which reads the same `planCommand`) and the `-n` / `--force`
 * denials, which are only asked once the verb is known.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DENIAL_CODES, planCommand } from '../../hooks/scripts/secrets-gate.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'hooks', 'scripts', 'secrets-gate.mjs');
const HAVE_GITLEAKS = spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).error === undefined;
const NEEDS_SCANNER = HAVE_GITLEAKS
  ? false
  : 'gitleaks is not installed here; the planCommand tests below still cover the parser. ' +
    'CI installs it (see ci.yml) and fails on any skip.';

/** Same fixture as hook-secrets-gate.test.mjs: detected every time, never spelled out on disk. */
function fakeSecret() {
  const label = 'RSA PRIVATE KEY';
  const body = `${randomBytes(48).toString('base64')}\n${randomBytes(48).toString('base64')}`;
  return `${'-----BEGIN '}${label}-----\n${body}\n${'-----END '}${label}-----\n`;
}

const temps = [];
function tempDir(prefix = 'tyran-quote-') {
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
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A repository with a private key STAGED, so any scan of the commit refuses. */
function repoWithStagedSecret(dir = tempDir()) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'gate@test.invalid');
  git(dir, 'config', 'user.name', 'gate');
  writeFileSync(join(dir, 'server.pem'), fakeSecret());
  git(dir, 'add', 'server.pem');
  return dir;
}

function runGateScript(command, cwd) {
  const out = execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

const verdictOf = (decision) =>
  Object.keys(decision).length === 0 ? 'pass' : (decision.hookSpecificOutput?.permissionDecision ?? 'unknown');

const commitTargets = (plan) => plan.targets.filter((t) => t.scanCommit === true);
const pushTargets = (plan) => plan.targets.filter((t) => t.scanPush === true);

/** Every spelling here is a real commit that the shell runs as `git commit`. */
const QUOTED_COMMITS = [
  // the three measured bypasses
  'git -c user.name="Jacek Janczura" commit -m x',
  "git -c 'user.name=Jacek Janczura' commit -m x",
  "GIT_AUTHOR_NAME='Jacek Janczura' git commit -m x",
  // the other identity variables
  'GIT_AUTHOR_NAME="Jacek Janczura" GIT_AUTHOR_EMAIL="j@x.invalid" git commit -m x',
  'GIT_COMMITTER_NAME="Jacek Janczura" git commit -m x',
  'GIT_COMMITTER_NAME="A B" GIT_COMMITTER_EMAIL=c@x.invalid GIT_AUTHOR_NAME="A B" git commit -m x',
  // several quoted options, mixed quoting, an escaped space
  'git -c user.name="Jacek Janczura" -c user.email="j@x.invalid" commit -m "a message"',
  'git -c user.name=Jacek\\ Janczura commit -m x',
  'git -c user.name="Jacek \\"JJ\\" Janczura" commit -m x',
  // the `env` wrapper, quoted AND unquoted (the unquoted one bypassed too)
  'env X="a b" git commit -m x',
  'env X=a git commit -m x',
  'env -u HOME GIT_AUTHOR_NAME="a b" git commit -m x',
  // a quoted space in a VALUE flag other than -c
  'git --namespace="a b" commit -m x',
];

for (const command of QUOTED_COMMITS) {
  test(`plan: a quoted value with a space does not hide the commit: ${command}`, () => {
    const plan = planCommand(command, '/repo');
    assert.equal(plan.needsScan, true, 'no scan was planned, so the gate would PASS unscanned');
    assert.deepEqual(
      commitTargets(plan).map((t) => t.dir),
      ['/repo'],
    );
  });
}

test('plan: `git -C <dir> -c a="b c" commit` scans the -C directory', () => {
  const plan = planCommand('git -C /elsewhere/repo -c a="b c" commit -m x', '/repo');
  assert.deepEqual(
    commitTargets(plan).map((t) => t.dir),
    ['/elsewhere/repo'],
  );
});

test('plan: `git -C "<dir with a space>" commit` scans that directory, not its first word', () => {
  const plan = planCommand('git -C "/tmp/with space/repo" commit -m x', '/repo');
  assert.deepEqual(
    commitTargets(plan).map((t) => t.dir),
    ['/tmp/with space/repo'],
  );
});

test('plan: `cd x && GIT_AUTHOR_NAME="a b" git commit` scans x', () => {
  const plan = planCommand('cd /x && GIT_AUTHOR_NAME="a b" git commit -m y', '/repo');
  assert.deepEqual(
    commitTargets(plan).map((t) => t.dir),
    ['/x'],
  );
});

test('plan: a heredoc message after a quoted identity is still a commit', () => {
  for (const command of [
    "GIT_AUTHOR_NAME=\"a b\" git commit -F - <<'EOF'\nsubject; it's done, git push later\nEOF",
    'git -c user.name="Jacek Janczura" commit -m "$(cat <<\'EOF\'\nbody; with a quote\'s apostrophe\nEOF\n)"',
  ]) {
    const plan = planCommand(command, '/repo');
    assert.deepEqual(
      commitTargets(plan).map((t) => t.dir),
      ['/repo'],
      command,
    );
  }
});

test('plan: `git add X && git -c a="b c" commit` folds the add into the scan', () => {
  const plan = planCommand('git -c a="b c" add server.pem && git -c a="b c" commit -m x', '/repo');
  const [target] = commitTargets(plan);
  assert.equal(target.includeWorktree, true);
  assert.deepEqual(target.includePaths, ['server.pem']);
});

test('plan: a quoted value does not hide a PUSH, and its remote and refs are read', () => {
  const plan = planCommand('git -c user.name="Jacek Janczura" push origin main', '/repo');
  const [target] = pushTargets(plan);
  assert.ok(target, 'no push planned: the push would be published unscanned');
  assert.equal(target.pushRemote, 'origin');
  assert.deepEqual(target.pushRefs, ['main']);
  // The policy gate decides WHERE a push lands from this argv.
  assert.deepEqual(target.pushArgv, ['origin', 'main']);
});

test('plan: an env-prefixed push with a quoted value is a push', () => {
  const plan = planCommand('GIT_SSH_COMMAND="ssh -i k" git push origin HEAD:refs/heads/x', '/repo');
  const [target] = pushTargets(plan);
  assert.ok(target);
  assert.deepEqual(target.pushRefs, ['HEAD']);
});

test('plan: the -n and --force denials still fire behind a quoted value', () => {
  const codes = (command) => planCommand(command, '/repo').denials.map((d) => d.code);
  assert.ok(codes('git -c user.name="J J" commit -n -m x').includes(DENIAL_CODES.NO_VERIFY));
  assert.ok(codes('git -c user.name="J J" commit "--no-verify" -m x').includes(DENIAL_CODES.NO_VERIFY));
  assert.ok(codes('git -c user.name="J J" push --force origin main').includes(DENIAL_CODES.FORCE_PUSH));
  assert.ok(codes('git -c "core.hooksPath=/x y" commit -m x').includes(DENIAL_CODES.HOOKS_PATH));
});

test('plan: a SEPARATOR inside a quoted value fails closed instead of passing', () => {
  // `splitSegments` is quote-blind on purpose (see SEPARATORS), so this splits
  // into `git -c user.name="A` and ` B" commit -m x`: one segment has git and no
  // verb, the other has the verb and no git. Neither reading can see the
  // commit, so the plan must refuse rather than pass.
  for (const command of [
    'git -c user.name="A; B" commit -m x',
    "git -c 'user.name=A & B' commit -m x",
    'git -c user.name="A (B)" push origin main',
  ]) {
    const plan = planCommand(command, '/repo');
    assert.equal(plan.needsScan, true, command);
    assert.ok(plan.unmodellable.length > 0, `should refuse: ${command}`);
  }
});

// ------------------------------------------------ no new false refusals

test('plan: commands that commit nothing still plan nothing', () => {
  for (const command of [
    'git log -c',
    'git log -c --stat -- a.txt',
    'git config user.name "a b"',
    'git config --global user.name "Jacek Janczura"',
    'echo "git commit"',
    "echo 'git -c a=\"b c\" commit -m x'",
    'git -c core.pager="less -R" log --oneline',
    'git log --format="%h; %s commit"',
    'GIT_PAGER="less -R" git log',
    'printf "%s\\n" "git push origin main"',
  ]) {
    const plan = planCommand(command, '/repo');
    assert.equal(plan.needsScan, false, command);
    assert.deepEqual(plan.unmodellable, [], command);
    assert.deepEqual(plan.denials, [], command);
  }
});

test('plan: a separator inside a commit MESSAGE is not an unreadable verb', () => {
  for (const command of [
    'git commit -m "fix; refactor"',
    'git -c user.name="J J" commit -m "fix (scope): a & b"',
    "git commit -m \"it's the source of truth\" ; git push origin main",
  ]) {
    const plan = planCommand(command, '/repo');
    assert.equal(plan.needsScan, true, command);
    assert.deepEqual(plan.unmodellable, [], command);
  }
});

// ----------------------------------------------- end to end, real scanner

const E2E_COMMITS = [
  'git -c user.name="Jacek Janczura" commit -m x',
  "git -c 'user.name=Jacek Janczura' commit -m x",
  "GIT_AUTHOR_NAME='Jacek Janczura' git commit -m x",
  'GIT_COMMITTER_NAME="Jacek Janczura" GIT_COMMITTER_EMAIL="j@x.invalid" git commit -m x',
  'env X="a b" git commit -m x',
  'env X=a git commit -m x',
  "GIT_AUTHOR_NAME=\"a b\" git commit -F - <<'EOF'\nsubject; it's done\nEOF",
  'git -c user.name="A; B" commit -m x',
];

for (const command of E2E_COMMITS) {
  test(`gate: refuses a staged key behind: ${command.split('\n')[0]}`, { skip: NEEDS_SCANNER }, () => {
    const dir = repoWithStagedSecret();
    assert.equal(verdictOf(runGateScript(command, dir)), 'deny');
  });
}

test('gate: `git -C "<dir with a space>" -c a="b c" commit` scans that repository', { skip: NEEDS_SCANNER }, () => {
  const dir = repoWithStagedSecret(join(tempDir(), 'with space', 'repo'));
  const elsewhere = tempDir();
  assert.equal(verdictOf(runGateScript(`git -C "${dir}" -c a="b c" commit -m x`, elsewhere)), 'deny');
});

test('gate: `cd <repo> && GIT_AUTHOR_NAME="a b" git commit` scans that repository', { skip: NEEDS_SCANNER }, () => {
  const dir = repoWithStagedSecret();
  const elsewhere = tempDir();
  assert.equal(verdictOf(runGateScript(`cd ${dir} && GIT_AUTHOR_NAME="a b" git commit -m x`, elsewhere)), 'deny');
});

test('gate: the unquoted controls still refuse, as they did before', { skip: NEEDS_SCANNER }, () => {
  const dir = repoWithStagedSecret();
  for (const command of ['git commit -m x', 'git -c user.name=JJ commit -m x']) {
    assert.equal(verdictOf(runGateScript(command, dir)), 'deny', command);
  }
});

test('gate: a read-only command with a quoted value still passes beside a staged key', { skip: NEEDS_SCANNER }, () => {
  const dir = repoWithStagedSecret();
  for (const command of ['git log -c', 'git config user.name "a b"', 'echo "git commit"']) {
    assert.equal(verdictOf(runGateScript(command, dir)), 'pass', command);
  }
});
