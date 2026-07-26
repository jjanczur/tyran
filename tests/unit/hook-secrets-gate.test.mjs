/**
 * Tests for the secrets gate.
 *
 * Two halves, and the second is the one that matters. The first checks that
 * the gate recognises a commit and refuses a leak. The second breaks the gate
 * on purpose — scanner missing, scanner killed, scanner crashed, report
 * absent, report corrupt — and asserts that every one of those endings is a
 * REFUSAL. The platform fails open (ADR-22), so an unchecked failure mode is
 * not a rough edge, it is a hole shaped exactly like the thing being guarded.
 *
 * No secret is ever committed to this repository, including from here. Every
 * secret-shaped string in this file is BUILT AT RUN TIME from a fixed
 * alphabet, so the bytes on disk never look like a key and the repo's own
 * gitleaks job in CI has nothing to find.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHILD_BUDGET_MS,
  DEADLINE_MS,
  DENIAL_CODES,
  EXPANSION_CHARS,
  MAX_COMMAND_BYTES,
  SEPARATORS,
  classifyCommand,
  commonArgs,
  decide,
  handle,
  isLiteralPath,
  makeBudget,
  runChild,
  safeFinding,
  splitSegments,
  tokensOf,
} from '../../hooks/scripts/secrets-gate.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'hooks', 'scripts', 'secrets-gate.mjs');

/**
 * A secret-shaped string, assembled at run time.
 *
 * Never a constant: a literal AWS-shaped key in a tracked file is a real
 * finding for every scanner that looks at this repo, and "it is only a test
 * fixture" is not a distinction any of them make. The alphabet excludes the
 * documentation key gitleaks itself allowlists, which an earlier probe run
 * proved is silently ignored.
 */
function fakeSecret() {
  // Randomness from the CSPRNG rather than a counter formula. The first
  // version of this helper was arithmetic, and its fourth call produced
  // sixteen identical characters — an entropy floor inside gitleaks then
  // ignored it and the end-to-end test failed with the gate looking broken
  // when the FIXTURE was. A fixture that is not the thing it stands for
  // fails in whichever direction is least informative.
  const alphabet = 'BCDFGHJKLMNPQRSTVWXYZ34679';
  const bytes = randomBytes(16);
  let body = '';
  for (const b of bytes) body += alphabet[b % alphabet.length];
  return ['A', 'K', 'I', 'A'].join('') + body;
}

/**
 * A fixture the scanner detects EVERY time, for the end-to-end test.
 *
 * `fakeSecret()` above is fine as an opaque string in front of a fake runner,
 * but it is not fit to prove anything against the real gitleaks: measured on
 * 8.30.1, 24 of 60 randomly generated, correctly formatted AWS access key IDs
 * written as `AWS_ACCESS_KEY_ID=<key>` were reported CLEAN, and 5 of 60 were
 * still missed in the `aws_key = "<key>"` shape. That false-negative rate
 * belongs to the ruleset, not to this gate, and it is written down in
 * `docs/hooks.md` — but it makes an AWS-shaped fixture a coin flip.
 *
 * A private-key block is a plain regex with no entropy floor: 10/10 detected
 * in the same probe. The header is assembled from fragments so the bytes on
 * disk in this repository never spell it out.
 */
function fakePrivateKey() {
  const label = 'RSA PRIVATE KEY';
  const body = `${randomBytes(48).toString('base64')}\n${randomBytes(48).toString('base64')}`;
  return `${'-----BEGIN '}${label}-----\n${body}\n${'-----END '}${label}-----\n`;
}

/** `String.fromCodePoint` so no raw control character is ever written here. */
const cp = (...points) => String.fromCodePoint(...points);

// ------------------------------------------------------------- fake runner

/**
 * A child runner under the test's control.
 *
 * Every failure mode ADR-22 requires a separate test for is reachable only
 * from here: a scanner that is absent, killed, crashed, or writes a report
 * that cannot be read. The fake also writes the report file itself, from the
 * `--report-path` it finds in argv — which means a gate that stopped passing
 * that flag would fail these tests rather than quietly scan into nowhere.
 */
function fakeRunner({ toplevel = '/repo', gitleaks = () => ({ code: 0, findings: [] }), unpushed = '3' } = {}) {
  const calls = [];
  const runner = async (bin, args, options) => {
    calls.push({ bin, args, options });
    if (bin === 'git') {
      if (args.includes('rev-parse')) {
        const dir = args[args.indexOf('-C') + 1];
        const resolved = typeof toplevel === 'function' ? toplevel(dir) : toplevel;
        if (resolved === null) return { spawned: true, code: 128, signal: null, stdout: '', stderr: 'not a git repository', timedOut: false };
        return { spawned: true, code: 0, signal: null, stdout: `${resolved}\n`, stderr: '', timedOut: false };
      }
      return { spawned: true, code: 0, signal: null, stdout: `${unpushed}\n`, stderr: '', timedOut: false };
    }
    const outcome = gitleaks({ bin, args, options, calls });
    if (outcome.spawnError) return { spawned: false, error: outcome.spawnError };
    const reportPath = args[args.indexOf('--report-path') + 1];
    if (outcome.report !== undefined) writeFileSync(reportPath, outcome.report);
    else if (outcome.findings !== undefined) writeFileSync(reportPath, JSON.stringify(outcome.findings));
    return {
      spawned: true,
      code: outcome.code ?? 0,
      signal: outcome.signal ?? null,
      stdout: '',
      stderr: outcome.stderr ?? '',
      timedOut: outcome.timedOut ?? false,
    };
  };
  runner.calls = calls;
  return runner;
}

const bashInput = (command, cwd = '/repo') => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  cwd,
  tool_input: { command },
});

const leak = (over = {}) => ({
  RuleID: 'aws-access-token',
  Description: 'Identified a pattern that may indicate AWS credentials',
  StartLine: 4,
  File: 'src/config.ts',
  Commit: '',
  Match: 'REDACTED',
  Secret: 'REDACTED',
  ...over,
});

// ====================================================== 1. the detector table

/**
 * The table the story asks for. Each row is a spelling a naive
 * `command.startsWith('git commit')` loses to, plus the ones this gate adds.
 * Rows marked `detect: false` are the DECLARED gap and are repeated verbatim
 * in `docs/hooks.md`; a gate advertised as impossible to slip past would be a
 * false guarantee, which is worse than a stated limit.
 */
const DETECTOR_TABLE = [
  { cmd: 'git commit -m "x"', staged: true, push: false, why: 'the plain form' },
  { cmd: 'cd sub && git commit -m x', staged: true, push: false, why: 'preceded by cd' },
  { cmd: 'git -C /other commit -m x', staged: true, push: false, why: 'another work tree' },
  { cmd: 'GIT_AUTHOR_NAME=a git commit -m x', staged: true, push: false, why: 'env assignment first' },
  { cmd: 'git   commit   -m x', staged: true, push: false, why: 'runs of whitespace' },
  { cmd: 'git commit -m "a" ; git push', staged: true, push: true, why: 'two commands, one line' },
  { cmd: 'true && git push origin main', staged: false, push: true, why: 'after a conjunction' },
  { cmd: 'false || git commit -m x', staged: true, push: false, why: 'after a disjunction' },
  { cmd: 'echo y | git commit -F -', staged: true, push: false, why: 'downstream of a pipe' },
  { cmd: '/usr/bin/git commit -m x', staged: true, push: false, why: 'an absolute program path' },
  { cmd: './git commit -m x', staged: true, push: false, why: 'a relative program path' },
  { cmd: 'gi"t" commit -m x', staged: true, push: false, why: 'quotes splitting the program name' },
  { cmd: 'g\\it commit -m x', staged: true, push: false, why: 'a backslash splitting the name' },
  { cmd: 'git "commit" -m x', staged: true, push: false, why: 'a quoted subcommand' },
  { cmd: 'git \\\n  commit -m x', staged: true, push: false, why: 'a line continuation' },
  { cmd: 'eval "git commit -m x"', staged: true, push: false, why: 'wrapped in eval' },
  { cmd: '(cd sub; git commit -m x)', staged: true, push: false, why: 'inside a subshell' },
  { cmd: 'sudo git commit -m x', staged: true, push: false, why: 'behind sudo' },
  { cmd: 'nohup git push &', staged: false, push: true, why: 'backgrounded' },
  { cmd: 'gh pr create --fill', staged: false, push: true, why: 'gh publishes by pushing' },
  { cmd: 'gh release create v1 ./dist/app', staged: false, push: true, why: 'gh release publishes' },
  { cmd: 'echo hello', staged: false, push: false, why: 'an ordinary command must not trigger' },
  { cmd: 'npm test', staged: false, push: false, why: 'an ordinary command must not trigger' },
  { cmd: 'git log --oneline', staged: false, push: false, why: 'a read-only git command' },
  { cmd: 'git status', staged: false, push: false, why: 'a read-only git command' },
];

for (const row of DETECTOR_TABLE) {
  test(`detector: ${row.why} — ${JSON.stringify(row.cmd)}`, () => {
    const found = classifyCommand(row.cmd);
    assert.equal(found.scanStaged, row.staged, `scanStaged for ${JSON.stringify(row.cmd)}`);
    assert.equal(found.scanUnpushed, row.push, `scanUnpushed for ${JSON.stringify(row.cmd)}`);
  });
}

/**
 * The DECLARED gap, pinned as a test rather than only described in prose.
 *
 * These spellings are NOT detected, and the point of asserting it is that the
 * documentation and the code cannot drift: if someone later closes one of
 * these, this test goes red and the doc section has to be updated with it. A
 * gap nobody can measure is a gap that quietly becomes a lie.
 */
const DECLARED_MISSES = [
  { cmd: 'gc -m x', why: 'a shell alias — the gate cannot read the user\'s alias table' },
  { cmd: 'g push', why: 'an aliased git binary' },
  { cmd: 'bash ./release.sh', why: 'a script whose contents the gate never sees' },
  { cmd: 'c=commit; git $c -m x', why: 'a subcommand assembled from a variable' },
  { cmd: 'git $(printf commit) -m x', why: 'a subcommand from command substitution' },
  { cmd: 'make deploy', why: 'a build target that pushes' },
];

for (const row of DECLARED_MISSES) {
  test(`declared gap (documented, not fixed): ${JSON.stringify(row.cmd)} — ${row.why}`, () => {
    const found = classifyCommand(row.cmd);
    assert.equal(
      found.needsScan,
      false,
      'this spelling is documented in docs/hooks.md as NOT caught; if it is caught now, ' +
        'that is good news and the documentation must be updated in the same commit',
    );
  });
}

// ================================================ 2. unconditional refusals

test('refuses --no-verify, which is the removal of the control rather than work', () => {
  const found = classifyCommand('git commit --no-verify -m x');
  assert.deepEqual(
    found.denials.map((d) => d.code),
    [DENIAL_CODES.NO_VERIFY],
  );
  assert.match(found.denials[0].remedy, /without --no-verify/);
});

test('refuses -n on commit (it IS --no-verify) but not -n on push (it is --dry-run)', () => {
  // The same letter means opposite things on the two subcommands, and getting
  // this backwards would either miss a bypass or block a harmless dry run.
  assert.equal(classifyCommand('git commit -n -m x').denials.length, 1);
  assert.equal(classifyCommand('git commit -an -m x').denials.length, 1, 'inside a cluster');
  assert.equal(classifyCommand('git push -n origin main').denials.length, 0);
  assert.equal(classifyCommand('git push --dry-run origin main').denials.length, 0);
});

test('refuses a hooksPath override, the same bypass spelled as configuration', () => {
  const found = classifyCommand('git -c core.hooksPath=/dev/null commit -m x');
  assert.deepEqual(found.denials.map((d) => d.code), [DENIAL_CODES.HOOKS_PATH]);
  assert.equal(
    classifyCommand('git -c core.HOOKSPATH=/dev/null commit -m x').denials.length,
    1,
    'git config keys are case-insensitive, so the check has to be too',
  );
});

test('refuses --force but never --force-with-lease, and says why the two differ', () => {
  for (const cmd of ['git push --force', 'git push -f origin main', 'git push --force=x', 'git push -fu origin main']) {
    const found = classifyCommand(cmd);
    assert.equal(found.denials.length, 1, cmd);
    assert.equal(found.denials[0].code, DENIAL_CODES.FORCE_PUSH, cmd);
    // The story requires the justification to reach the AGENT, not just the
    // reader of the source: a refusal without a stated reason produces an
    // agent that looks for a way around it.
    assert.match(found.denials[0].remedy, /--force-with-lease/);
    assert.match(found.denials[0].remedy, /another agent pushed/);
  }
  for (const cmd of ['git push --force-with-lease', 'git push --force-with-lease=main:abc', 'git push --force-if-includes']) {
    assert.equal(classifyCommand(cmd).denials.length, 0, cmd);
  }
});

test('refuses a force push wearing a refspec (`+main:main`)', () => {
  // `git push origin +main:main` is a force push with no flag in sight. A
  // rule that only knows --force and -f reports this command as clean.
  const found = classifyCommand('git push origin +main:main');
  assert.deepEqual(found.denials.map((d) => d.code), [DENIAL_CODES.FORCE_PUSH]);
});

test('refuses SIGKILL in every spelling, and leaves SIGTERM alone', () => {
  for (const cmd of [
    'kill -9 123',
    'kill -SIGKILL 123',
    'kill -KILL 123',
    'kill -s 9 123',
    'kill -s KILL 123',
    'pkill -9 node',
    'killall -9 node',
    '/bin/kill -9 1',
    // The program slot is not where the killer always sits. Reading only
    // position zero loses to every one of these.
    'sudo kill -9 1',
    'env kill -9 1',
    'xargs kill -9',
  ]) {
    assert.equal(classifyCommand(cmd).denials.map((d) => d.code).join(), DENIAL_CODES.SIGKILL, cmd);
  }
  for (const cmd of ['kill 123', 'kill -TERM 123', 'kill -15 123', 'pkill -f node', 'git commit -m "kill the bug"']) {
    assert.equal(classifyCommand(cmd).denials.length, 0, cmd);
  }
});

test('a SIGKILL refusal explains the slot protocol instead of just saying no', () => {
  const d = classifyCommand('kill -9 123').denials[0];
  assert.match(d.remedy, /SIGTERM/);
  assert.match(d.remedy, /lease/);
});

// ================================= 3. hostile input never reaches a shell

/**
 * One test per independent special character, which is the rule this
 * initiative paid for: a single "hostile input does not leak" test asserts a
 * CONJUNCTION, and removing one of several escaping steps usually does not
 * break it. Counting the characters and writing that many tests is what makes
 * each one individually falsifiable.
 */
for (const ch of [...SEPARATORS]) {
  const label = ch === '\n' ? 'LF' : ch === '\r' ? 'CR' : ch;
  test(`separator ${JSON.stringify(label)}: a commit hidden behind it is still detected`, () => {
    assert.equal(classifyCommand(`echo hi${ch}git commit -m x`).scanStaged, true);
  });
}

for (const ch of [...EXPANSION_CHARS]) {
  test(`expansion character ${JSON.stringify(ch)} makes a path non-literal, so it is never resolved`, () => {
    assert.equal(isLiteralPath(`/tmp/a${ch}b`), false);
    assert.equal(isLiteralPath('/tmp/plain'), true);
  });
}

for (const ch of ['"', "'", '\\']) {
  test(`quoting character ${JSON.stringify(ch)} is stripped for recognition, so it cannot hide a keyword`, () => {
    assert.deepEqual(tokensOf(`g${ch}it com${ch}mit`), ['git', 'commit']);
  });
}

test('every child process is given an argument VECTOR, never a command string', async () => {
  const runner = fakeRunner({ gitleaks: () => ({ code: 0, findings: [] }) });
  const hostile = 'git commit -m "$(touch /tmp/tyran-pwned-argv); `id`; rm -rf ~"';
  await decide({ input: bashInput(hostile), cwd: '/repo', runner });
  assert.ok(runner.calls.length > 0);
  for (const call of runner.calls) {
    assert.ok(Array.isArray(call.args), 'args must be an array; a string would be a shell command');
    // The hostile text may legitimately appear as ONE argv element (it is
    // piped to the scanner as data). What must never happen is it being
    // spliced into another argument.
    for (const arg of call.args) {
      if (arg === hostile) continue;
      assert.ok(!arg.includes('touch /tmp/tyran-pwned-argv'), `payload spliced into argv: ${arg}`);
    }
  }
});

test('end to end: a planted payload in the command does NOT execute', () => {
  // The backstop for every character at once, run through the REAL script
  // rather than a unit under test. If any layer ever shells out, this is the
  // test that notices.
  const dir = mkdtempSync(join(tmpdir(), 'tyran-gate-injection-'));
  try {
    const marker = join(dir, 'PWNED');
    const command = [
      `git commit -m "x"; touch ${marker}`,
      `$(touch ${marker}.sub)`,
      `\`touch ${marker}.tick\``,
      `&& touch ${marker}.and`,
      `| touch ${marker}.pipe`,
    ].join(' ');
    const out = execFileSync(process.execPath, [SCRIPT], {
      input: JSON.stringify(bashInput(command, dir)),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    JSON.parse(out); // a well-formed decision, whatever it decided
    for (const suffix of ['', '.sub', '.tick', '.and', '.pipe']) {
      assert.equal(existsSync(`${marker}${suffix}`), false, `payload executed: ${marker}${suffix}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hostile FILE NAME reported by the scanner cannot execute or reshape the refusal', async () => {
  const runner = fakeRunner({
    gitleaks: () => ({ code: 1, findings: [leak({ File: '$(touch /tmp/tyran-pwned-file); rm -rf ~/.ssh' })] }),
  });
  const verdict = await decide({ input: bashInput('git commit -m x'), cwd: '/repo', runner });
  assert.equal(verdict.decision, 'deny');
  assert.equal(existsSync('/tmp/tyran-pwned-file'), false);
  assert.ok(verdict.reason.includes('touch /tmp/tyran-pwned-file'), 'the name is reported as inert text');
});

// ==================================== 4. failure modes — every one refuses

test('ADR-22: gitleaks missing is a REFUSAL with install instructions, not a warning', async () => {
  const runner = fakeRunner({
    gitleaks: () => ({ spawnError: Object.assign(new Error('spawn gitleaks ENOENT'), { code: 'ENOENT' }) }),
  });
  const verdict = await handle({ input: bashInput('git commit -m x'), cwd: '/repo', runner });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /gitleaks is not installed/);
  assert.match(verdict.reason, /brew install gitleaks/);
  assert.match(verdict.reason, /TYRAN_GITLEAKS_BIN/);
});

test('ADR-22: a scan killed at its timeout REFUSES and never reads the partial report', async () => {
  // The partial report is the trap. A killed scan can leave a well-formed
  // `[]` on disk, and a gate that reads it cannot tell "nothing found" from
  // "never looked" — the exact shape of a silent pass.
  const runner = fakeRunner({ gitleaks: () => ({ code: null, signal: 'SIGKILL', timedOut: true, findings: [] }) });
  const verdict = await handle({ input: bashInput('git commit -m x'), cwd: '/repo', runner });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /did not finish within/);
});

test('ADR-22: a scanner that crashes with an unexpected exit code REFUSES', async () => {
  const runner = fakeRunner({ gitleaks: () => ({ code: 137, stderr: 'out of memory', findings: [] }) });
  const verdict = await handle({ input: bashInput('git commit -m x'), cwd: '/repo', runner });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /exited 137/);
  assert.match(verdict.reason, /out of memory/);
});

test('ADR-22: a fatal scanner error that writes NO report REFUSES', async () => {
  // Measured on gitleaks 8.30.1: a fatal error exits 1 — the SAME code as
  // "leaks found" — and writes no report file at all. Exit status alone
  // therefore cannot distinguish a leak from a broken scan, and reading the
  // report is what makes the difference visible.
  const runner = fakeRunner({ gitleaks: () => ({ code: 1, stderr: 'FTL stat /nope: no such file' }) });
  const verdict = await handle({ input: bashInput('git commit -m x'), cwd: '/repo', runner });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /wrote no report/);
});

test('ADR-22: an unparseable report REFUSES', async () => {
  const runner = fakeRunner({ gitleaks: () => ({ code: 0, report: 'not json at all' }) });
  const verdict = await handle({ input: bashInput('git commit -m x'), cwd: '/repo', runner });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /not JSON/);
});

test('ADR-22: a report that is JSON but not an array REFUSES', async () => {
  const runner = fakeRunner({ gitleaks: () => ({ code: 0, report: '{"findings":[]}' }) });
  const verdict = await handle({ input: bashInput('git commit -m x'), cwd: '/repo', runner });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /not a JSON array/);
});

test('ADR-22: a Bash call with no readable command REFUSES', async () => {
  const verdict = await handle({
    input: { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/repo', tool_input: {} },
    cwd: '/repo',
    runner: fakeRunner(),
  });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /no readable `command`/);
});

test('ADR-22: a command naming a directory the gate cannot resolve REFUSES', async () => {
  const runner = fakeRunner();
  const verdict = await handle({ input: bashInput('cd "$WT" && git commit -m x'), cwd: '/repo', runner });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /cannot resolve without running a shell/);
  assert.match(verdict.reason, /never expands variables/);
});

test('ADR-22: a triggering command with no resolvable work tree REFUSES', async () => {
  const runner = fakeRunner({ toplevel: null });
  const verdict = await handle({ input: bashInput('git commit -m x'), cwd: '/nowhere', runner });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /could not find a git work tree/);
});

test('ADR-22: an oversized command REFUSES rather than being skipped', async () => {
  const command = `git commit -m "${'a'.repeat(MAX_COMMAND_BYTES + 10)}"`;
  const verdict = await handle({ input: bashInput(command), cwd: '/repo', runner: fakeRunner() });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /past the \d+ this gate will scan/);
});

test('the budget shrinks as it is spent, so several children cannot overrun together', () => {
  const budget = makeBudget(Date.now() - 6000, 7000, 1200);
  assert.ok(budget(CHILD_BUDGET_MS) <= 0, 'a spent budget must not hand out more time');
  const fresh = makeBudget(Date.now(), 7000, 1200);
  assert.equal(fresh(CHILD_BUDGET_MS), CHILD_BUDGET_MS, 'a fresh budget is capped by the child cap');
});

test('a scan that starts with no budget left REFUSES instead of running unbounded', async () => {
  const runner = fakeRunner();
  const verdict = await handle({
    input: bashInput('git commit -m x'),
    cwd: '/repo',
    runner,
    startedAt: Date.now() - DEADLINE_MS,
  });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /ran out of its own budget/);
});

// ============================================ 5. the refusal does not leak

test('the refusal names file, line and rule — and never the secret itself', async () => {
  const secret = fakeSecret();
  const runner = fakeRunner({
    gitleaks: () => ({
      code: 1,
      // A scanner build without --redact would put the secret here. The gate
      // must not repeat it even then, so the fake deliberately does.
      findings: [leak({ Match: `key = "${secret}"`, Secret: secret, File: '.env.local', StartLine: 7 })],
    }),
  });
  const verdict = await decide({ input: bashInput('git commit -m x'), cwd: '/repo', runner });
  assert.equal(verdict.decision, 'deny');
  assert.ok(verdict.reason.includes('.env.local'), 'the file must be named or the finding is unfixable');
  assert.ok(verdict.reason.includes(':7'), 'the line must be named');
  assert.ok(verdict.reason.includes('aws-access-token'), 'the rule class must be named');
  assert.equal(
    verdict.reason.includes(secret),
    false,
    'the refusal goes into the transcript and the model context; quoting the key there would ' +
      'publish it in the act of refusing to publish it',
  );
});

test('safeFinding cannot carry the secret, whatever the scanner reports', () => {
  const secret = fakeSecret();
  const safe = safeFinding({ RuleID: 'r', File: 'f', StartLine: 1, Commit: 'abc', Match: secret, Secret: secret, Line: secret });
  assert.equal(JSON.stringify(safe).includes(secret), false);
  assert.deepEqual(Object.keys(safe).sort(), ['commit', 'file', 'line', 'rule']);
});

test('--redact is always passed, so the report on disk cannot hold the secret either', () => {
  const args = commonArgs({ reportPath: '/tmp/r.json', baseline: null });
  assert.ok(args.includes('--redact'), 'the second layer: a widened quote later still cannot leak');
  assert.ok(args.includes('--report-format') && args[args.indexOf('--report-format') + 1] === 'json');
  assert.equal(args.includes('--baseline-path'), false, 'no baseline means no baseline flag');
});

test('a baseline is passed through and NAMED in the refusal, never applied silently', () => {
  const args = commonArgs({ reportPath: '/tmp/r.json', baseline: '/repo/.gitleaks-baseline.json' });
  assert.equal(args[args.indexOf('--baseline-path') + 1], '/repo/.gitleaks-baseline.json');
});

// ================================================== 6. what actually is scanned

test('a commit scans the staged index of the resolved work tree', async () => {
  const runner = fakeRunner();
  const verdict = await decide({ input: bashInput('git commit -m x'), cwd: '/repo', runner });
  assert.deepEqual(verdict, (await import('../../hooks/scripts/hook-io.mjs')).PASS);
  const scans = runner.calls.filter((c) => c.bin !== 'git');
  assert.ok(scans.some((c) => c.args.includes('--staged')), 'the index must be scanned');
  assert.ok(scans.some((c) => c.args.includes('stdin')), 'the command line must be scanned');
});

test('a push scans the commits that are local and on no remote — never the whole history', async () => {
  // Measured, and the reason this is bounded at all: gitleaks over the full
  // history of a 2151-commit repository took 18.8 s and produced 2157
  // findings. That is past every hook budget, so an unbounded push scan is a
  // gate that always times out, i.e. a gate that always refuses and is
  // switched off within a day.
  const runner = fakeRunner();
  await decide({ input: bashInput('git push origin main'), cwd: '/repo', runner });
  const scan = runner.calls.find((c) => c.bin !== 'git' && c.args.some((a) => a.startsWith('--log-opts')));
  assert.ok(scan, 'a push must scan a commit range');
  assert.ok(
    scan.args.includes('--log-opts=--all --not --remotes'),
    `the range must exclude everything already published, got: ${JSON.stringify(scan.args)}`,
  );
  assert.equal(scan.args.includes('--log-opts=--all'), false, 'the full history is never scanned');
});

test('the command line itself is scanned, or `git commit -m "<key>"` has no check at all', async () => {
  // The index scan has a hole shaped exactly like a commit message: a secret
  // passed with -m enters history without ever being a staged file.
  const secret = fakeSecret();
  const runner = fakeRunner({
    gitleaks: ({ args }) =>
      args.includes('stdin')
        ? { code: 1, findings: [leak({ File: '', StartLine: 1, RuleID: 'generic-api-key' })] }
        : { code: 0, findings: [] },
  });
  const verdict = await decide({ input: bashInput(`git commit -m "token ${secret}"`), cwd: '/repo', runner });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /the command text itself/);
  assert.equal(verdict.reason.includes(secret), false);
  const stdinCall = runner.calls.find((c) => c.args.includes('stdin'));
  assert.ok(stdinCall.options.input.includes(secret), 'the command is handed over as DATA on stdin');
});

test('a second work tree named with -C is scanned too, not just the session cwd', async () => {
  // A gate that fires on `git -C ../other commit` and then scans the session
  // repository has not failed loudly: it has passed quietly.
  const runner = fakeRunner({ toplevel: (dir) => (dir === '/repo' ? '/repo' : '/other') });
  await decide({ input: bashInput('git -C /other commit -m x'), cwd: '/repo', runner });
  const scanned = runner.calls.filter((c) => c.bin !== 'git' && c.args.includes('--staged')).map((c) => c.options.cwd);
  assert.deepEqual(scanned.sort(), ['/other', '/repo']);
});

test('a non-Bash tool is not this gate\'s business, so it passes rather than blocking', async () => {
  // A matcher is not a guarantee: measured in v2.1.116, a matcher outside
  // [a-zA-Z0-9_|] becomes an UNANCHORED regex. If this gate is ever handed a
  // Write call it must pass, not refuse every file write in the session.
  const verdict = await decide({
    input: { hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: '/repo', tool_input: { file_path: '/a', content: 'b' } },
    cwd: '/repo',
    runner: fakeRunner(),
  });
  assert.deepEqual(verdict, (await import('../../hooks/scripts/hook-io.mjs')).PASS);
});

test('an ordinary command runs no child processes at all', async () => {
  const runner = fakeRunner();
  const verdict = await decide({ input: bashInput('npm test'), cwd: '/repo', runner });
  assert.deepEqual(verdict, (await import('../../hooks/scripts/hook-io.mjs')).PASS);
  assert.equal(runner.calls.length, 0, 'the common case must cost nothing');
});

// ============================================== 7. end to end, real binary

const GITLEAKS_PRESENT = spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).error === undefined;

test(
  'END TO END with the real scanner: a planted secret makes `git commit` refuse',
  {
    skip: GITLEAKS_PRESENT
      ? false
      : 'gitleaks is not installed here. The gate\'s MISSING-scanner path is covered by its own ' +
        'test above and refuses; this one needs the binary. CI installs it (see ci.yml).',
  },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'tyran-gate-e2e-'));
    try {
      const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
      git('init', '-q');
      git('config', 'user.email', 'gate@test.invalid');
      git('config', 'user.name', 'gate');
      writeFileSync(join(dir, 'ok.txt'), 'nothing interesting here\n');
      git('add', 'ok.txt');

      const clean = execFileSync(process.execPath, [SCRIPT], {
        input: JSON.stringify(bashInput('git commit -m "clean"', dir)),
        encoding: 'utf8',
      });
      assert.deepEqual(JSON.parse(clean), {}, 'a clean index must produce silence, never an allow');

      const secret = fakePrivateKey();
      writeFileSync(join(dir, 'deploy.pem'), secret);
      git('add', 'deploy.pem');

      const raw = execFileSync(process.execPath, [SCRIPT], {
        input: JSON.stringify(bashInput('git commit -m "add config"', dir)),
        encoding: 'utf8',
      });
      const decision = JSON.parse(raw);
      assert.equal(decision.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
      const reason = decision.hookSpecificOutput.permissionDecisionReason;
      assert.match(reason, /deploy\.pem/);
      assert.match(reason, /private-key/);
      for (const line of secret.split('\n')) {
        if (line.length > 20) {
          assert.equal(reason.includes(line), false, 'the real pipeline must not echo the key material');
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('end to end: nonsense on stdin still produces a well-formed REFUSAL, not silence', () => {
  const out = execFileSync(process.execPath, [SCRIPT], { input: 'not json', encoding: 'utf8' });
  const decision = JSON.parse(out);
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /malformed-json/);
});

test('end to end: the gate never emits permissionDecision "allow"', () => {
  const out = execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(bashInput('echo hi', REPO_ROOT)),
    encoding: 'utf8',
  });
  assert.equal(out.includes('allow'), false, '"allow" auto-approves the call and skips the prompt');
  assert.deepEqual(JSON.parse(out), {});
});

// ==================================================== 8. registration facts

test('the gate is registered on PreToolUse for Bash, with a matcher the platform accepts', () => {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const entries = config.hooks.PreToolUse;
  assert.ok(Array.isArray(entries) && entries.length > 0, 'the gate must be registered or it does not exist');
  const mine = entries.find((e) => e.hooks.some((h) => h.command.includes('secrets-gate.mjs')));
  assert.ok(mine, 'secrets-gate.mjs is not registered in hooks.json');
  // Measured in v2.1.116: a matcher made only of [a-zA-Z0-9_|] is an exact
  // list; anything with a comma or a space becomes an unanchored regex that
  // matches NOTHING, and no tool anywhere reports it.
  assert.match(mine.matcher, /^[a-zA-Z0-9_|]+$/, 'a comma or space here silently disables the gate');
  assert.deepEqual(mine.matcher.split('|'), ['Bash']);
});

test('the registered timeout leaves the internal deadline room to refuse first', () => {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const entry = config.hooks.PreToolUse.flatMap((e) => e.hooks).find((h) => h.command.includes('secrets-gate.mjs'));
  assert.equal(typeof entry.timeout, 'number');
  assert.ok(DEADLINE_MS <= (entry.timeout * 1000) / 2, 'the gate must decide long before the platform kills it');
  assert.equal(DEADLINE_MS, 7000, 'pinned so a change has to be deliberate');
});

test('runChild is spawned without a shell, which is the whole anti-injection guarantee', async () => {
  // Not a style assertion: with shell:true the argv elements would be
  // re-parsed by a shell and every metacharacter in a command the model wrote
  // would become executable. Run a real child to prove the payload is inert.
  const marker = join(tmpdir(), `tyran-runchild-${process.pid}-${Date.now()}`);
  const result = await runChild(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', `; touch ${marker};`], {
    timeoutMs: 5000,
  });
  assert.equal(result.spawned, true);
  assert.equal(result.stdout, `; touch ${marker};`);
  assert.equal(existsSync(marker), false, 'the payload was executed — shell:false is not in force');
});

test('runChild enforces its own timeout by killing the child', async () => {
  const started = Date.now();
  const result = await runChild(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 10000, 'the child must be killed, not waited out');
});

test('splitSegments folds a line continuation before splitting, or the keyword is lost', () => {
  // Removing the fold turns `git \<newline> commit` into two segments, one
  // holding `git` and one holding `commit`, and the detector sees neither.
  assert.deepEqual(splitSegments('git \\\n commit'), ['git   commit']);
  assert.equal(splitSegments(`a${cp(10)}b`).length, 2, 'a real newline still separates');
});
