import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runStateChecks, renderText, renderJson, parseArgs, deadRules, overruledRules, DEFAULT_STALE_HOURS } from '../../scripts/doctor.mjs';
import { append } from '../../scripts/journal.mjs';

const DOCTOR = fileURLToPath(new URL('../../scripts/doctor.mjs', import.meta.url));
const PROJECT = fileURLToPath(new URL('../../scripts/project.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const TEMPLATES = fileURLToPath(new URL('../../templates/', import.meta.url));

// --------------------------------------------------------------- fixtures

function repo() {
  return mkdtempSync(join(tmpdir(), 'tyran-doctor-'));
}

/** A `.tyran/` with the shipped templates — the state a healthy repo has. */
function scaffold(root, { config = true, knowledge = true, policy = true } = {}) {
  const dir = join(root, '.tyran');
  mkdirSync(dir, { recursive: true });
  if (config) writeFileSync(join(dir, 'config.yaml'), readFileSync(join(TEMPLATES, 'config.yaml')));
  if (knowledge) {
    mkdirSync(join(dir, 'knowledge'), { recursive: true });
    writeFileSync(join(dir, 'knowledge', 'repo.yaml'), readFileSync(join(TEMPLATES, 'knowledge.yaml')));
  }
  if (policy) {
    mkdirSync(join(dir, 'policies'), { recursive: true });
    writeFileSync(join(dir, 'policies', 'autonomy.yaml'), readFileSync(join(TEMPLATES, 'policies/autonomy.yaml')));
  }
  return dir;
}

function journalPathFor(tyranDir, init = 'demo') {
  const path = join(tyranDir, 'state', init, 'journal.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/** Write raw JSONL lines — this is how a hand-edited journal is simulated. */
function writeJournal(path, events) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n', 'utf8');
}

const ev = (ts, evName, data, { init = 'demo', actor = 'conductor' } = {}) => ({ ts, ev: evName, init, actor, data });

function regenerate(journal) {
  execFileSync(process.execPath, [PROJECT, journal], { encoding: 'utf8' });
}

function run(args, { cwd = REPO } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [DOCTOR, ...args], { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const codes = (result) => result.findings.map((f) => f.code);
const byCode = (result, code) => result.findings.filter((f) => f.code === code);

// ------------------------------------------------------------ no false alarms

test('a repo with no .tyran directory is healthy, not broken', () => {
  const root = repo();
  const result = runStateChecks({ dir: join(root, '.tyran') });
  assert.equal(result.ok, true);
  assert.deepEqual(codes(result), ['no-state-dir']);
  assert.equal(result.counts.error + result.counts.warning, 0);
});

test('a freshly scaffolded .tyran with no initiative yet is healthy', () => {
  const root = repo();
  const dir = scaffold(root);
  const result = runStateChecks({ dir });
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.deepEqual(codes(result), []);
});

test('an empty journal with fresh projections produces no findings', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeFileSync(journal, '', 'utf8');
  regenerate(journal);
  const result = runStateChecks({ dir });
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.deepEqual(codes(result), []);
});

test('a complete, consistent initiative produces no error and no warning', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'init.created', { title: 'Demo' }),
    ev('2026-07-26T09:01:00.000Z', 'ticket.created', { id: 'T-1' }),
    ev('2026-07-26T09:02:00.000Z', 'spawn', { agent: 'impl-1', role: 'implementer', ticket: 'T-1' }),
    ev('2026-07-26T09:30:00.000Z', 'report', { agent: 'impl-1', verdict: 'DONE', ticket: 'T-1' }),
    ev('2026-07-26T09:31:00.000Z', 'merge', { ticket: 'T-1', sha: 'abc1234' }),
  ]);
  regenerate(journal);
  const result = runStateChecks({ dir });
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.deepEqual(codes(result), []);
});

test('the shipped policy template produces no dead and no overruled rules', () => {
  const root = repo();
  const dir = scaffold(root);
  const result = runStateChecks({ dir });
  assert.deepEqual(byCode(result, 'policy-rule-dead'), []);
  assert.deepEqual(byCode(result, 'policy-rule-overruled'), []);
});

// ------------------------------------------------------------- projections

test('drifted projections are a warning that names the file and the fix', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'init.created', {})]);
  regenerate(journal);
  const statePath = join(dirname(journal), 'STATE.md');
  appendFileSync(statePath, 'hand-edited\n');

  const result = runStateChecks({ dir });
  const drift = byCode(result, 'projection-drift');
  assert.equal(drift.length, 1);
  assert.equal(drift[0].severity, 'warning');
  assert.match(drift[0].where, /STATE\.md$/);
  assert.match(drift[0].fix, /project\.mjs/);
  assert.equal(result.ok, false);
});

test('the printed regenerate command actually repairs the drift', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'init.created', {})]);
  regenerate(journal);
  appendFileSync(join(dirname(journal), 'STATE.md'), 'hand-edited\n');

  const fix = byCode(runStateChecks({ dir }), 'projection-drift')[0].fix;
  execSync(fix, { cwd: REPO, stdio: 'pipe' });
  assert.deepEqual(codes(runStateChecks({ dir })), []);
});

test('projections that were never generated are info, not drift', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'init.created', {})]);
  const result = runStateChecks({ dir });
  const missing = byCode(result, 'projection-missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].severity, 'info');
  assert.equal(result.ok, true);
  assert.deepEqual(byCode(result, 'projection-drift'), []);
});

test('a half-generated pair is a warning, because a run stopped part way', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'init.created', {})]);
  regenerate(journal);
  rmSync(join(dirname(journal), 'PROGRESS.md'));
  const result = runStateChecks({ dir });
  const missing = byCode(result, 'projection-missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].severity, 'warning');
  assert.match(missing[0].where, /PROGRESS\.md$/);
});

test('an unprojectable journal is not reported as drift with a command that would fail', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeFileSync(journal, 'this is not a journal', 'utf8'); // no newline -> truncated tail
  const result = runStateChecks({ dir });
  assert.deepEqual(byCode(result, 'projection-drift'), []);
  assert.equal(byCode(result, 'projection-blocked').length, 1);
  // The refusal doctor predicts is the one project.mjs actually gives.
  let projectExit = 0;
  try {
    execFileSync(process.execPath, [PROJECT, journal], { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    projectExit = err.status;
  }
  assert.equal(projectExit, 2);
});

// ------------------------------------------------------------ open spawns

test('an open spawn is info; the same spawn past the threshold is a warning', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'spawn', { agent: 'impl-1', role: 'implementer', ticket: 'T-1' }),
    ev('2026-07-26T09:10:00.000Z', 'checkpoint', { phase: 'build', next_steps: [] }),
  ]);
  regenerate(journal);

  const quiet = runStateChecks({ dir });
  assert.deepEqual(byCode(quiet, 'spawn-open').map((f) => f.severity), ['info']);
  assert.equal(quiet.ok, true);

  const late = runStateChecks({ dir, now: '2026-07-26T20:00:00.000Z' });
  const stale = byCode(late, 'spawn-stale');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].severity, 'warning');
  assert.match(stale[0].message, /11\.0 h/);
  assert.equal(late.ok, false);
});

test('staleness is measured in journal time, so a quiet journal never false-alarms', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  // The spawn IS the last event: no matter how much wall-clock time passes,
  // the initiative has not moved on without this agent.
  writeJournal(journal, [ev('2000-01-01T00:00:00.000Z', 'spawn', { agent: 'impl-1', role: 'implementer' })]);
  regenerate(journal);
  const result = runStateChecks({ dir });
  assert.deepEqual(byCode(result, 'spawn-stale'), []);
  assert.equal(byCode(result, 'spawn-open').length, 1);
});

test('--stale-hours moves the threshold', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'spawn', { agent: 'impl-1', role: 'implementer' }),
    ev('2026-07-26T11:00:00.000Z', 'checkpoint', { phase: 'build', next_steps: [] }),
  ]);
  regenerate(journal);
  assert.equal(byCode(runStateChecks({ dir }), 'spawn-stale').length, 0, `default is ${DEFAULT_STALE_HOURS} h`);
  assert.equal(byCode(runStateChecks({ dir, staleHours: 1 }), 'spawn-stale').length, 1);
});

test('two open spawns for one agent name are surfaced with a working fix command', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'spawn', { agent: 'impl-1', role: 'implementer' }),
    ev('2026-07-26T09:01:00.000Z', 'spawn', { agent: 'impl-1', role: 'implementer' }),
  ]);
  regenerate(journal);
  const result = runStateChecks({ dir });
  const dup = byCode(result, 'spawn-duplicate');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].severity, 'warning');
  assert.match(dup[0].message, /2 open spawns/);

  // The command must RUN, not merely look plausible.
  const command = dup[0].fix.split('\n')[0].replace('<why>', 'killed by turn limit');
  execSync(command, { cwd: REPO, stdio: 'pipe' });
  regenerate(journal);
  assert.deepEqual(byCode(runStateChecks({ dir }), 'spawn-duplicate'), []);
});

test('an agent name starting with a dash still gets a runnable close command', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'spawn', { agent: '--reason', role: 'implementer' }),
    ev('2026-07-26T09:01:00.000Z', 'spawn', { agent: '--reason', role: 'implementer' }),
  ]);
  const dup = byCode(runStateChecks({ dir }), 'spawn-duplicate')[0];
  const command = dup.fix.split('\n')[0].replace('<why>', 'died');
  execSync(command, { cwd: REPO, stdio: 'pipe' });
  assert.deepEqual(byCode(runStateChecks({ dir }), 'spawn-duplicate'), []);
});

test('an orphan report and an unusable agent name are raised from journal.mjs', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  const padded = `worker${String.fromCodePoint(0x200b)}`;
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'report', { agent: 'ghost', verdict: 'DONE' }),
    ev('2026-07-26T09:01:00.000Z', 'spawn', { agent: padded, role: 'implementer' }),
  ]);
  const result = runStateChecks({ dir });
  assert.equal(byCode(result, 'spawn-orphan-report').length, 1);
  assert.equal(byCode(result, 'agent-name-unusable').length, 1);
});

// ---------------------------------------------------------------- journal

test('corruption mid-file is an error; a truncated tail is only a warning', () => {
  const root = repo();
  const dir = scaffold(root);

  const mid = journalPathFor(dir, 'mid');
  writeJournal(mid, [ev('2026-07-26T09:00:00.000Z', 'init.created', {}), 'NOT JSON', ev('2026-07-26T09:02:00.000Z', 'checkpoint', { phase: 'x', next_steps: [] })]);
  const midResult = runStateChecks({ dir });
  const invalid = byCode(midResult, 'journal-invalid');
  assert.ok(invalid.some((f) => f.severity === 'error' && /line 2/.test(f.message)), JSON.stringify(invalid));

  const root2 = repo();
  const dir2 = scaffold(root2);
  const tailPath = journalPathFor(dir2, 'tail');
  writeFileSync(tailPath, JSON.stringify(ev('2026-07-26T09:00:00.000Z', 'init.created', {})) + '\n{"ts":"2026', 'utf8');
  const tailResult = runStateChecks({ dir: dir2 });
  assert.equal(byCode(tailResult, 'journal-truncated')[0].severity, 'warning');
  assert.deepEqual(byCode(tailResult, 'journal-invalid'), []);
});

test('an unknown event type is an error, not a silent skip', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'teleport', {})]);
  const result = runStateChecks({ dir });
  assert.ok(byCode(result, 'journal-invalid').some((f) => /closed event set/.test(f.message)));
  assert.equal(result.counts.error > 0, true);
});

test('a journal path that is a directory is an error, not a crash', () => {
  const root = repo();
  const dir = scaffold(root);
  mkdirSync(join(dir, 'state', 'demo', 'journal.jsonl'), { recursive: true });
  const result = runStateChecks({ dir });
  assert.deepEqual(codes(result), ['journal-not-a-file']);
});

test('an initiative directory with no journal is a warning', () => {
  const root = repo();
  const dir = scaffold(root);
  mkdirSync(join(dir, 'state', 'empty'), { recursive: true });
  const result = runStateChecks({ dir });
  assert.deepEqual(codes(result), ['journal-missing']);
  assert.equal(result.findings[0].severity, 'warning');
  assert.equal(result.ok, false, 'an initiative whose history vanished must not pass the check');
});

test('a stray file under state/ is reported instead of being skipped', () => {
  const root = repo();
  const dir = scaffold(root);
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(join(dir, 'state', 'notes.txt'), 'hi');
  assert.deepEqual(codes(runStateChecks({ dir })), ['state-stray-file']);
});

// -------------------------------------------------------- one init per file

test('events from a foreign initiative are an error naming the directory contract', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir, 'demo');
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'init.created', {}, { init: 'other' })]);
  const mismatch = byCode(runStateChecks({ dir }), 'journal-init-mismatch');
  assert.equal(mismatch.length, 1);
  assert.equal(mismatch[0].severity, 'error');
  assert.match(mismatch[0].message, /"other"/);
});

test('a report from one initiative closing another initiative’s spawn is an error', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir, 'demo');
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'spawn', { agent: 'impl-1', role: 'implementer' }, { init: 'demo' }),
    ev('2026-07-26T09:01:00.000Z', 'report', { agent: 'impl-1', verdict: 'DONE' }, { init: 'other' }),
  ]);
  const result = runStateChecks({ dir });
  const cross = byCode(result, 'journal-cross-init-pairing');
  assert.equal(cross.length, 1, JSON.stringify(codes(result)));
  assert.equal(cross[0].severity, 'error');
  // journal.mjs itself is perfectly happy with this file — that is the point
  const validate = run(['--state', '--dir', dir]);
  assert.equal(validate.code, 1);
});

test('two initiatives in one file without a crossed pairing is a warning', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir, 'demo');
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'spawn', { agent: 'impl-1', role: 'implementer' }, { init: 'demo' }),
    ev('2026-07-26T09:01:00.000Z', 'report', { agent: 'impl-1', verdict: 'DONE' }, { init: 'demo' }),
    ev('2026-07-26T09:02:00.000Z', 'checkpoint', { phase: 'x', next_steps: [] }, { init: 'other' }),
  ]);
  const result = runStateChecks({ dir });
  assert.equal(byCode(result, 'journal-mixed-initiatives').length, 1);
  assert.deepEqual(byCode(result, 'journal-cross-init-pairing'), []);
});

// ----------------------------------------------------------------- leases

test('a lease held by an agent that already reported is an orphan', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'spawn', { agent: 'impl-1', role: 'implementer' }),
    ev('2026-07-26T09:01:00.000Z', 'lease.acquired', { resource: 'worktree:a', holder: 'impl-1' }),
    ev('2026-07-26T09:30:00.000Z', 'report', { agent: 'impl-1', verdict: 'DONE' }),
  ]);
  regenerate(journal);
  const result = runStateChecks({ dir });
  const orphan = byCode(result, 'lease-orphan');
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0].severity, 'warning');
  assert.match(orphan[0].message, /worktree:a/);
  assert.match(orphan[0].fix, /lease\.released/);
});

test('a lease held by an agent that is still working is only info', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'spawn', { agent: 'impl-1', role: 'implementer' }),
    ev('2026-07-26T09:01:00.000Z', 'lease.acquired', { resource: 'worktree:a', holder: 'impl-1' }),
  ]);
  regenerate(journal);
  const result = runStateChecks({ dir });
  assert.deepEqual(byCode(result, 'lease-orphan'), []);
  assert.equal(byCode(result, 'lease-open')[0].severity, 'info');
});

test('an expired lease is a warning even when its holder is still working', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'spawn', { agent: 'impl-1', role: 'implementer' }),
    ev('2026-07-26T09:01:00.000Z', 'lease.acquired', { resource: 'worktree:a', holder: 'impl-1', expires: '2026-07-26T10:00:00.000Z' }),
    ev('2026-07-26T12:00:00.000Z', 'checkpoint', { phase: 'x', next_steps: [] }),
  ]);
  regenerate(journal);
  const expired = byCode(runStateChecks({ dir }), 'lease-expired');
  assert.equal(expired.length, 1);
  assert.equal(expired[0].severity, 'warning');
  assert.match(expired[0].message, /2\.0 h ago/);
});

test('a release by a non-holder is raised from journal.tail(), leaving the lease open', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'spawn', { agent: 'impl-1', role: 'implementer' }),
    ev('2026-07-26T09:01:00.000Z', 'lease.acquired', { resource: 'worktree:a', holder: 'impl-1' }),
    ev('2026-07-26T09:02:00.000Z', 'lease.released', { resource: 'worktree:a', holder: 'intruder' }),
  ]);
  regenerate(journal);
  const result = runStateChecks({ dir });
  assert.equal(byCode(result, 'lease-release-by-non-holder').length, 1);
  assert.equal(byCode(result, 'lease-open').length, 1);
});

test('a leftover journal lock directory is surfaced', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'init.created', {})]);
  regenerate(journal);
  mkdirSync(`${journal}.lock`);
  const lock = byCode(runStateChecks({ dir }), 'journal-lock-present');
  assert.equal(lock.length, 1);
  assert.equal(lock[0].severity, 'warning');
  assert.match(lock[0].fix, /rmdir/);
});

// ---------------------------------------------------------------- policies

test('rules that no normalized path can ever match are reported dead', () => {
  const repoRoot = '/repo';
  const cases = {
    '.': true,
    '..': true,
    './hooks/x': true,
    '/hooks/**': true,
    'hooks\\x': true,
    'a/./b': true,
    'foo/../bar': true,
    '*': false,
    '(hooks)/**': false,
    '*/policy-gate.mjs': false,
    'hooks/**': false,
    'src/**': false,
    '**': false,
    '.*': false,
  };
  const policy = { default: 'GATED', rules: Object.keys(cases).map((path) => ({ path, class: 'AUTO', reason: 'r' })) };
  const dead = new Set(deadRules(policy, repoRoot).map((d) => d.path));
  for (const [path, expected] of Object.entries(cases)) {
    assert.equal(dead.has(path), expected, `${JSON.stringify(path)} should be ${expected ? 'dead' : 'live'}`);
  }
});

test('a dead rule aimed at a kernel path says so and suggests the working glob', () => {
  const root = repo();
  const dir = scaffold(root, { policy: false });
  mkdirSync(join(dir, 'policies'), { recursive: true });
  writeFileSync(
    join(dir, 'policies', 'autonomy.yaml'),
    [
      'default: GATED',
      'rules:',
      '  - path: hooks/**',
      '    class: KERNEL',
      '    reason: the mechanism',
      '  - path: .tyran/policies/**',
      '    class: KERNEL',
      '    reason: the boundary',
      '  - path: ./hooks/scripts/**',
      '    class: GATED',
      '    reason: typo that protects nothing',
      '',
    ].join('\n'),
    'utf8',
  );
  const result = runStateChecks({ dir });
  // The schema itself is happy — that is exactly why doctor has to catch it.
  assert.deepEqual(byCode(result, 'policy-invalid'), []);
  const dead = byCode(result, 'policy-rule-dead');
  assert.equal(dead.length, 1);
  assert.equal(dead[0].severity, 'warning');
  assert.match(dead[0].message, /hooks\/scripts\/\*\*/);
  assert.match(dead[0].message, /protected kernel path/);
  assert.match(dead[0].fix, /hooks\/scripts\/\*\*/);
  assert.equal(result.ok, false);
});

test('a rule that quietly fails to cover a kernel path is reported overruled', () => {
  const policy = {
    default: 'GATED',
    rules: [
      { path: 'hooks/**', class: 'KERNEL', reason: 'r' },
      { path: '.tyran/policies/**', class: 'KERNEL', reason: 'r' },
      { path: '*/policy-gate.mjs', class: 'AUTO', reason: 'r' },
    ],
  };
  const overruled = overruledRules(policy, '/repo');
  assert.equal(overruled.length, 1);
  assert.equal(overruled[0].path, '*/policy-gate.mjs');
  assert.equal(overruled[0].example, 'hooks/policy-gate.mjs');
  // and the template must stay clean
  assert.deepEqual(overruledRules({ default: 'GATED', rules: [{ path: 'src/**', class: 'AUTO', reason: 'r' }] }, '/repo'), []);
});

test('a policy that downgrades a kernel path is an error that explains the no-op', () => {
  const root = repo();
  const dir = scaffold(root, { policy: false });
  mkdirSync(join(dir, 'policies'), { recursive: true });
  writeFileSync(
    join(dir, 'policies', 'autonomy.yaml'),
    [
      'default: GATED',
      'rules:',
      '  - path: hooks/**',
      '    class: KERNEL',
      '    reason: the mechanism',
      '  - path: .tyran/policies/**',
      '    class: KERNEL',
      '    reason: the boundary',
      '  - path: hooks/scripts/**',
      '    class: AUTO',
      '    reason: let the retro agent write hooks',
      '',
    ].join('\n'),
    'utf8',
  );
  const downgrade = byCode(runStateChecks({ dir }), 'policy-kernel-downgrade');
  assert.equal(downgrade.length, 1);
  assert.equal(downgrade[0].severity, 'error');
  assert.match(downgrade[0].message, /no effect at all/);
});

test('unparseable policy YAML is an error with a location, never a crash', () => {
  const root = repo();
  const dir = scaffold(root, { policy: false });
  mkdirSync(join(dir, 'policies'), { recursive: true });
  writeFileSync(join(dir, 'policies', 'autonomy.yaml'), 'default: GATED\nrules: &anchor\n  - path: x\n', 'utf8');
  const result = runStateChecks({ dir });
  const invalid = byCode(result, 'policy-invalid');
  assert.equal(invalid.length, 1);
  assert.match(invalid[0].message, /^YAML: line \d+/);
  // no rule analysis on a document the schema already rejected
  assert.deepEqual(byCode(result, 'policy-rule-dead'), []);
});

test('an invalid config is an error carrying the exact field path', () => {
  const root = repo();
  const dir = scaffold(root, { config: false });
  writeFileSync(join(dir, 'config.yaml'), 'profile: turbo\nautonomy: P9\n', 'utf8');
  const result = runStateChecks({ dir });
  const errors = byCode(result, 'config-invalid');
  assert.ok(errors.some((f) => f.message.startsWith('profile')));
  assert.ok(errors.every((f) => f.severity === 'error'));
  assert.match(errors[0].fix, /schema\.mjs validate config/);
});

test('an invalid knowledge entry is an error with its index', () => {
  const root = repo();
  const dir = scaffold(root, { knowledge: false });
  mkdirSync(join(dir, 'knowledge'), { recursive: true });
  writeFileSync(join(dir, 'knowledge', 'k.yaml'), 'entries:\n  - id: K-1\n    kind: fact\n    text: x\n    confidence: 7\n', 'utf8');
  const errors = byCode(runStateChecks({ dir }), 'knowledge-invalid');
  assert.ok(errors.some((f) => /entries\[0\]\.confidence/.test(f.message)));
});

test('a missing config.yaml is info, not an error', () => {
  const root = repo();
  const dir = scaffold(root, { config: false });
  const result = runStateChecks({ dir });
  assert.equal(byCode(result, 'config-missing')[0].severity, 'info');
  assert.equal(result.ok, true);
});

// -------------------------------------------------------- nothing is silent

test('knowledge/ or policies/ that is not a directory is reported, not skipped', () => {
  const root = repo();
  const dir = scaffold(root, { knowledge: false, policy: false });
  writeFileSync(join(dir, 'knowledge'), 'oops');
  writeFileSync(join(dir, 'policies'), 'oops');
  const result = runStateChecks({ dir });
  assert.equal(byCode(result, 'knowledge-not-a-directory').length, 1);
  assert.equal(byCode(result, 'policies-not-a-directory').length, 1);
  assert.equal(result.ok, false);
});

test('a repo with no autonomy policy is told the boundary is undefined', () => {
  const root = repo();
  const dir = scaffold(root, { policy: false });
  const missing = byCode(runStateChecks({ dir }), 'policy-missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].severity, 'info');
});

test('a config.yaml that is a directory is a finding, not an exception', () => {
  const root = repo();
  const dir = scaffold(root, { config: false });
  mkdirSync(join(dir, 'config.yaml'));
  const result = runStateChecks({ dir });
  assert.equal(byCode(result, 'config-invalid').length, 1);
  assert.match(byCode(result, 'config-invalid')[0].message, /^YAML: unparseable/);
});

test('a journal shape that throws inside a reader costs one check, not the report', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  // `"data": null` makes journal.tail() throw. Measured, not hypothetical.
  writeJournal(journal, [
    '{"ts":"2026-07-26T09:00:00.000Z","ev":"lease.acquired","init":"demo","actor":"c","data":null}',
  ]);
  const result = runStateChecks({ dir });
  const failed = byCode(result, 'check-failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].severity, 'error');
  assert.match(failed[0].message, /"leases" check/);
  // everything else still ran
  assert.ok(byCode(result, 'journal-invalid').length > 0, 'integrity check was skipped too');
  assert.ok(byCode(result, 'projection-missing').length > 0, 'projection check was skipped too');
  // and the CLI reports it instead of dying with a stack trace
  const cli = run(['--state', '--dir', dir]);
  assert.equal(cli.code, 1);
  assert.equal(cli.stderr, '');
  assert.match(cli.stdout, /\[check-failed\]/);
});

const rootUser = typeof process.getuid === 'function' && process.getuid() === 0;

test('an unreadable journal is an error naming the errno', { skip: rootUser }, () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'init.created', {})]);
  chmodSync(journal, 0o000);
  try {
    const result = runStateChecks({ dir });
    assert.deepEqual(codes(result), ['journal-unreadable']);
    assert.match(result.findings[0].message, /EACCES/);
  } finally {
    chmodSync(journal, 0o600);
  }
});

test('an unreadable projection is an error, never a silent "up to date"', { skip: rootUser }, () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'init.created', {})]);
  regenerate(journal);
  const statePath = join(dirname(journal), 'STATE.md');
  chmodSync(statePath, 0o000);
  try {
    const result = runStateChecks({ dir });
    assert.equal(byCode(result, 'projection-unreadable').length, 1);
    assert.equal(result.ok, false);
  } finally {
    chmodSync(statePath, 0o600);
  }
});

// ------------------------------------------------------------- determinism

test('two runs over the same state render identical bytes', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [
    ev('2020-01-01T09:00:00.000Z', 'spawn', { agent: 'b-agent', role: 'x' }),
    ev('2020-01-01T09:00:01.000Z', 'spawn', { agent: 'a-agent', role: 'x' }),
    ev('2020-01-01T09:00:02.000Z', 'lease.acquired', { resource: 'r-2', holder: 'a-agent' }),
    ev('2020-01-01T09:00:03.000Z', 'lease.acquired', { resource: 'r-10', holder: 'b-agent' }),
  ]);
  const a = renderText(runStateChecks({ dir }));
  assert.equal(a, renderText(runStateChecks({ dir })));
  assert.equal(renderJson(runStateChecks({ dir })), renderJson(runStateChecks({ dir })));
  // Nothing reads the wall clock: every date printed comes from the journal.
  const dates = [...a.matchAll(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g)].map((m) => m[0]);
  assert.ok(dates.length > 0);
  assert.ok(dates.every((d) => d.startsWith('2020-01-01T')), dates.join(', '));
});

test('findings are grouped by severity, whatever order the checks produced them in', () => {
  const root = repo();
  // config.yaml is checked FIRST, so its `info` is produced before every
  // journal finding. Without an explicit sort the report would open with an
  // info line and bury the errors underneath it.
  const dir = scaffold(root, { config: false });
  const journal = journalPathFor(dir);
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'teleport', {}),
    ev('2026-07-26T09:00:01.000Z', 'lease.acquired', { resource: 'r-10', holder: 'conductor' }),
    ev('2026-07-26T09:00:02.000Z', 'lease.acquired', { resource: 'r-2', holder: 'conductor' }),
  ]);
  regenerate(journal);
  const result = runStateChecks({ dir });
  const rank = { error: 0, warning: 1, info: 2 };
  const severities = result.findings.map((f) => f.severity);
  assert.ok(severities.includes('error') && severities.includes('info'), severities.join(', '));
  assert.deepEqual(severities, [...severities].sort((a, b) => rank[a] - rank[b]), severities.join(', '));
  assert.equal(severities[0], 'error');
  // and the text report opens with the errors, not with the first check that ran
  assert.match(renderText(result).split('\n\n')[1], /^ERROR /);
  // natural, not lexicographic, order inside a group
  const leases = byCode(result, 'lease-open').map((f) => f.message);
  assert.ok(leases[0].includes('r-2') && leases[1].includes('r-10'), leases.join(' | '));
});

// -------------------------------------------------------------- injection

test('journal values cannot inject escapes or bidi overrides into the report', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  const esc = String.fromCodePoint(0x1b);
  const rlo = String.fromCodePoint(0x202e);
  const nasty = `${esc}[31mred${rlo}gnp.txt`;
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'lease.acquired', { resource: nasty, holder: `holder${rlo}` }),
  ]);
  const text = renderText(runStateChecks({ dir }));
  assert.equal(text.includes(esc), false, 'ANSI escape reached the report');
  assert.equal(text.includes(rlo), false, 'bidi override reached the report');
  const json = renderJson(runStateChecks({ dir }));
  assert.equal(json.includes(rlo), false, 'bidi override reached the JSON output');
});

test('a shell-hostile agent name still yields a command that runs and closes it', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  // Legal under agentNameProblem (no control/format chars) but every one of
  // these is escaped by inline() — a sanitized fix command would be wrong.
  const agent = "impl|1 `id` $(id) [x] & 'q'";
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'spawn', { agent, role: 'x' }),
    ev('2026-07-26T09:00:01.000Z', 'spawn', { agent, role: 'x' }),
  ]);
  const dup = byCode(runStateChecks({ dir }), 'spawn-duplicate');
  assert.equal(dup.length, 1);
  execSync(dup[0].fix.replace('<why>', 'died'), { cwd: REPO, stdio: 'pipe' });
  assert.deepEqual(byCode(runStateChecks({ dir }), 'spawn-duplicate'), []);
  // the substitution really ran; nothing was executed as a subshell
  const written = readFileSync(journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.equal(written.data.agent, agent);
});

test('a lease fix command escapes a bidi-carrying resource instead of printing it', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  const rlo = String.fromCodePoint(0x202e);
  const resource = `worktree:${rlo}a`;
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'spawn', { agent: 'impl-1', role: 'x' }),
    ev('2026-07-26T09:00:01.000Z', 'lease.acquired', { resource, holder: 'impl-1' }),
    ev('2026-07-26T09:00:02.000Z', 'report', { agent: 'impl-1', verdict: 'DONE' }),
  ]);
  const orphan = byCode(runStateChecks({ dir }), 'lease-orphan')[0];
  assert.equal(orphan.fix.includes(rlo), false, 'raw bidi override in a printed command');
  assert.match(orphan.fix, /\\u202e/);
  // ...and the escape still round-trips to the exact resource
  const data = orphan.fix.slice(orphan.fix.indexOf("--data '") + 8, -1);
  assert.equal(JSON.parse(data).resource, resource);
});

// ------------------------------------------------------------------- CLI

test('exit codes: info-only is 0, a warning is 1, a usage mistake is 2', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'spawn', { agent: 'impl-1', role: 'x' })]);
  regenerate(journal);

  const infoOnly = run(['--state', '--dir', dir]);
  assert.equal(infoOnly.code, 0, infoOnly.stdout + infoOnly.stderr);
  assert.match(infoOnly.stdout, /\[spawn-open\]/);

  appendFileSync(join(dirname(journal), 'STATE.md'), 'x\n');
  assert.equal(run(['--state', '--dir', dir]).code, 1);

  assert.equal(run([]).code, 2);
  assert.equal(run(['--dir', dir]).code, 2, '--state is required');
  assert.equal(run(['--state', '--nope']).code, 2);
  assert.equal(run(['--state', '--dir', dir, '--dir', dir]).code, 2);
  assert.equal(run(['--state', 'extra']).code, 2);
  assert.equal(run(['--state', '--dir']).code, 2);
  assert.equal(run(['--state', '--now', 'yesterday']).code, 2);
  assert.equal(run(['--state', '--stale-hours', '-1']).code, 2);
  assert.equal(run(['--state', '--stale-hours', 'soon']).code, 2);
});

test('an explicitly named missing directory is an error; a missing default is not', () => {
  const missing = run(['--state', '--dir', join(repo(), 'nope')]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /state directory not found/);

  const fresh = run(['--state'], { cwd: repo() });
  assert.equal(fresh.code, 0);
  assert.match(fresh.stdout, /no Tyran state directory here/);
});

test('--json emits parseable JSON with the same verdict as the text report', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'teleport', {})]);
  const result = run(['--state', '--dir', dir, '--json']);
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.counts.error > 0);
  assert.ok(parsed.findings.every((f) => 'severity' in f && 'code' in f && 'where' in f && 'message' in f));
});

test('parseArgs defaults match the documented contract', () => {
  assert.deepEqual(parseArgs(['--state']), {
    dir: '.tyran',
    json: false,
    now: null,
    staleHours: DEFAULT_STALE_HOURS,
    dirGiven: false,
  });
  assert.equal(parseArgs(['--state', '--stale-hours', '0']).staleHours, 0);
  assert.equal(parseArgs(['--state', '--now', '2026-01-01T00:00:00.000Z']).now, '2026-01-01T00:00:00.000Z');
});

test('the text report is greppable: every finding shows code, place and fix', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'spawn', { agent: 'impl-1', role: 'x' }),
    ev('2026-07-26T09:00:01.000Z', 'spawn', { agent: 'impl-1', role: 'x' }),
  ]);
  const text = renderText(runStateChecks({ dir }));
  assert.match(text, /^WARNING \(\d+\)$/m);
  assert.match(text, /^ {2}\[spawn-duplicate\] .*journal\.jsonl$/m);
  assert.match(text, /^ {4}fix: node scripts\/journal\.mjs close-spawn /m);
  assert.match(text, /error\(s\) · \d+ warning\(s\) · \d+ info · action needed$/m);
});

// ------------------------------------------------------- writer interop

test('a journal written through append() reads clean', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  append(journal, { ev: 'init.created', init: 'demo', actor: 'conductor', data: {} });
  append(journal, { ev: 'spawn', init: 'demo', actor: 'conductor', data: { agent: 'impl-1', role: 'implementer' } });
  append(journal, { ev: 'report', init: 'demo', actor: 'impl-1', data: { agent: 'impl-1', verdict: 'DONE' } });
  regenerate(journal);
  const result = runStateChecks({ dir });
  assert.deepEqual(codes(result), [], JSON.stringify(result.findings, null, 2));
  assert.equal(result.ok, true);
});
