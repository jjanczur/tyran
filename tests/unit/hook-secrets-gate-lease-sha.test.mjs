/**
 * The secrets gate must not refuse `git push --force-with-lease=<ref>:<sha>`
 * because the sha looks like a key (PV3-TYRAN-SECRETS-GATE-LEASE-SHA).
 *
 * Measured with gitleaks 8.30.1 on the command text the gate scans:
 * `--force-with-lease=pv3/push-secrets-scan-merge:<sha>` is one
 * `generic-api-key` finding when the ref carries a keyword (`secret`, `token`,
 * `api`, `key`, `auth`...) and the sha's Shannon entropy is above ~3.5, which
 * is true for 1908 of 2000 recent commit ids. `pv3/cron-g2b`, `main`, and a
 * low-entropy sha scan clean. The sha is an object name, not a credential.
 *
 * The fix hides the expected value ONLY when it names an object in the
 * repository the push targets. These tests run the real gate, the real git
 * and the real gitleaks; nothing about the scanner is faked except the one
 * "git could not answer" case, which wraps the real runner.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PASS } from '../../hooks/scripts/hook-io.mjs';
import { handle, planCommand, runChild } from '../../hooks/scripts/secrets-gate.mjs';

const HAVE_GITLEAKS = spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).error === undefined;
const NEEDS_SCANNER = HAVE_GITLEAKS
  ? false
  : 'gitleaks is not installed here; the planCommand tests below still cover the parser. ' +
    'CI installs it (see ci.yml) and fails on any skip.';

const KEYWORD_REF = 'pv3/api-token-fix';
const PLAIN_REF = 'pv3/cron-g2b';

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

function entropy(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** A repo with an `origin`, whose HEAD id has the entropy that trips gitleaks. */
function repoWithHighEntropyHead() {
  const bare = tempDir('tyran-lease-origin-');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const dir = tempDir('tyran-lease-repo-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'gate@test.invalid');
  git(dir, 'config', 'user.name', 'gate');
  git(dir, 'remote', 'add', 'origin', bare);
  for (let n = 0; n < 200; n++) {
    writeFileSync(join(dir, 'f.txt'), `v${n}\n`);
    git(dir, 'add', 'f.txt');
    git(dir, 'commit', '-q', '-m', `c${n}`);
    const sha = git(dir, 'rev-parse', 'HEAD');
    if (entropy(sha) > 3.6) return { dir, sha };
  }
  throw new Error('no commit id with entropy above 3.6 in 200 tries');
}

/** 40 lowercase hex characters that are no object anywhere, with entropy above 3.6. */
function highEntropyNonObject() {
  for (;;) {
    const hex = randomBytes(20).toString('hex');
    if (entropy(hex) > 3.6) return hex;
  }
}

const bashInput = (command, cwd) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } });
const lease = (ref, sha) => `--force-with-lease=${ref}:${sha}`;
const deniedByRule = (verdict, rule) =>
  verdict.decision === 'deny' && verdict.reason.includes(`rule \`${rule}\``);

const { dir: REPO, sha: SHA } = repoWithHighEntropyHead();

// ---------------------------------------------------------------------------
// planCommand: what is recorded, and what is not

test('plan: a lease with a full object name is recorded with the repo the segment targets', () => {
  const plan = planCommand(`git push ${lease(KEYWORD_REF, SHA)} origin ${KEYWORD_REF}`, '/repo');
  assert.deepEqual(plan.leaseExpects, [{ dir: '/repo', spelled: lease(KEYWORD_REF, SHA), sha: SHA }]);
});

test('plan: -C moves the repo the lease is checked against', () => {
  const plan = planCommand(`git -C /elsewhere push ${lease(KEYWORD_REF, SHA)} origin ${KEYWORD_REF}`, '/repo');
  assert.equal(plan.leaseExpects[0].dir, '/elsewhere');
});

test('plan: only the exact expected-value slot is recorded', () => {
  for (const spelling of [
    `--force-with-lease=${KEYWORD_REF}`, // no expected value
    `--force-with-lease=${KEYWORD_REF}:${SHA.slice(0, 12)}`, // abbreviation
    `--force-with-lease=${KEYWORD_REF}:${SHA.toUpperCase()}`, // not lowercase
    `--force-with-lease=${KEYWORD_REF}:${SHA}0`, // 41 characters
    `--force-with-lease=${KEYWORD_REF}:HEAD`,
    `--force-if-includes=${KEYWORD_REF}:${SHA}`,
  ]) {
    const plan = planCommand(`git push ${spelling} origin x`, '/repo');
    assert.deepEqual(plan.leaseExpects, [], spelling);
  }
});

test('plan: a lease on a command that is not a git push records nothing', () => {
  for (const command of [
    `echo ${lease(KEYWORD_REF, SHA)}`,
    `git commit -m "${lease(KEYWORD_REF, SHA)}"`,
    `git reset --hard ${SHA}`,
  ]) {
    assert.deepEqual(planCommand(command, '/repo').leaseExpects, [], command);
  }
});

// ---------------------------------------------------------------------------
// the gate, end to end

test('gate: a keyword ref with the sha of a real commit is not refused', { skip: NEEDS_SCANNER }, async () => {
  const verdict = await handle({ input: bashInput(`git push ${lease(KEYWORD_REF, SHA)} origin ${KEYWORD_REF}`, REPO), cwd: REPO });
  assert.deepEqual(verdict, PASS, JSON.stringify(verdict));
});

test('gate: a 40-hex that is no object is still scanned and refused', { skip: NEEDS_SCANNER }, async () => {
  const fake = highEntropyNonObject();
  const verdict = await handle({ input: bashInput(`git push ${lease(KEYWORD_REF, fake)} origin ${KEYWORD_REF}`, REPO), cwd: REPO });
  assert.ok(deniedByRule(verdict, 'generic-api-key'), JSON.stringify(verdict));
});

test('gate: an object in ANOTHER repository does not unlock the value', { skip: NEEDS_SCANNER }, async () => {
  const other = tempDir('tyran-lease-other-');
  git(other, 'init', '-q');
  const command = `git -C ${other} push ${lease(KEYWORD_REF, SHA)} origin ${KEYWORD_REF}`;
  const verdict = await handle({ input: bashInput(command, REPO), cwd: REPO });
  assert.ok(deniedByRule(verdict, 'generic-api-key'), JSON.stringify(verdict));
});

test('gate: a real secret elsewhere in the same command is still refused', { skip: NEEDS_SCANNER }, async () => {
  const secret = randomBytes(24).toString('base64url');
  const command = `git push ${lease(KEYWORD_REF, SHA)} -o "api_key=${secret}" origin ${KEYWORD_REF}`;
  const verdict = await handle({ input: bashInput(command, REPO), cwd: REPO });
  assert.ok(deniedByRule(verdict, 'generic-api-key'), JSON.stringify(verdict));
  assert.equal(verdict.reason.includes(secret), false, 'the refusal must not quote the secret');
});

test('gate: a hex secret beside the lease is not hidden with it', { skip: NEEDS_SCANNER }, async () => {
  const fake = highEntropyNonObject();
  const command = `git push ${lease(KEYWORD_REF, SHA)} -o "api_key=${fake}" origin ${KEYWORD_REF}`;
  const verdict = await handle({ input: bashInput(command, REPO), cwd: REPO });
  assert.ok(deniedByRule(verdict, 'generic-api-key'), JSON.stringify(verdict));
});

test('gate: the same flag text in a command that is not a push is scanned as before', { skip: NEEDS_SCANNER }, async () => {
  const command = `git commit --allow-empty -m "${lease(KEYWORD_REF, SHA)}"`;
  const verdict = await handle({ input: bashInput(command, REPO), cwd: REPO });
  assert.ok(deniedByRule(verdict, 'generic-api-key'), JSON.stringify(verdict));
});

test('gate: when git cannot answer, the value is scanned (fails toward refusing)', { skip: NEEDS_SCANNER }, async () => {
  for (const answer of [{ spawned: true, timedOut: true, code: null }, { spawned: false, error: { code: 'ENOENT' } }]) {
    const runner = (bin, args, options) =>
      bin === 'git' && args.includes('cat-file') && args.includes('-e') ? Promise.resolve({ stdout: '', stderr: '', ...answer }) : runChild(bin, args, options);
    const verdict = await handle({ input: bashInput(`git push ${lease(KEYWORD_REF, SHA)} origin ${KEYWORD_REF}`, REPO), cwd: REPO, runner });
    assert.ok(deniedByRule(verdict, 'generic-api-key'), JSON.stringify(verdict));
  }
});

test('gate: a ref without a keyword was never refused, and still is not', { skip: NEEDS_SCANNER }, async () => {
  const verdict = await handle({ input: bashInput(`git push ${lease(PLAIN_REF, SHA)} origin ${PLAIN_REF}`, REPO), cwd: REPO });
  assert.deepEqual(verdict, PASS, JSON.stringify(verdict));
});

test('gate: asking about a lease value never fetches it from a promisor remote', { skip: NEEDS_SCANNER }, async () => {
  // In a partial clone, `cat-file -e <missing>^{object}` lazily FETCHES the
  // object, which sends the suspected secret to the remote as `want <hex>`.
  // Measured on review: 4 such packet lines through the gate without the
  // guard, 0 with it. A git that lacks `--no-lazy-fetch` exits 129 and the
  // value stays scanned, so this test holds on any git version.
  const origin = tempDir('tyran-lease-promisor-origin-');
  git(origin, 'init', '-q');
  git(origin, 'config', 'user.email', 'gate@test.invalid');
  git(origin, 'config', 'user.name', 'gate');
  writeFileSync(join(origin, 'f.txt'), 'blob\n');
  git(origin, 'add', 'f.txt');
  git(origin, 'commit', '-q', '-m', 'c');
  git(origin, 'config', 'uploadpack.allowFilter', 'true');
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const clone = join(tempDir('tyran-lease-promisor-'), 'clone');
  execFileSync('git', ['clone', '-q', '--filter=blob:none', `file://${origin}`, clone], { stdio: 'ignore' });
  assert.equal(git(clone, 'config', 'remote.origin.promisor'), 'true', 'premise: a partial clone');

  const fake = highEntropyNonObject();
  const trace = join(tempDir('tyran-lease-trace-'), 'packets.txt');
  const before = process.env.GIT_TRACE_PACKET;
  process.env.GIT_TRACE_PACKET = trace;
  let verdict;
  try {
    verdict = await handle({ input: bashInput(`git push ${lease(KEYWORD_REF, fake)} origin HEAD`, clone), cwd: clone });
  } finally {
    if (before === undefined) delete process.env.GIT_TRACE_PACKET;
    else process.env.GIT_TRACE_PACKET = before;
  }
  assert.ok(deniedByRule(verdict, 'generic-api-key'), JSON.stringify(verdict));
  let packets = '';
  try {
    packets = readFileSync(trace, 'utf8');
  } catch {
    /* no packet at all was traced */
  }
  assert.equal(packets.includes(`want ${fake}`), false, 'the suspected value went out on the wire');
});
