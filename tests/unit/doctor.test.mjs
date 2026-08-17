import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  appendFileSync,
  chmodSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  runStateChecks,
  renderText,
  renderJson,
  parseArgs,
  deadRules,
  overruledRules,
  SEVERITIES,
  SEVERITY_BY_CODE,
  severityFor,
  DEFAULT_STALE_HOURS,
  runHookChecks,
  mistakesFindings,
} from '../../scripts/doctor.mjs';
import {
  DEFAULT_PLUGIN_ROOT,
  HOOK_SEVERITY_BY_CODE,
  hookSeverityFor,
} from '../../scripts/hooks-check.mjs';
import { append } from '../../scripts/journal.mjs';
import { gitRunner } from '../../scripts/scan-repo.mjs';

const DOCTOR = fileURLToPath(new URL('../../scripts/doctor.mjs', import.meta.url));
const PROJECT = fileURLToPath(new URL('../../scripts/project.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const TEMPLATES = fileURLToPath(new URL('../../templates/', import.meta.url));

const rootUser = typeof process.getuid === 'function' && process.getuid() === 0;

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
  const absent = byCode(result, 'projection-absent');
  assert.equal(absent.length, 1);
  assert.equal(absent[0].severity, 'info');
  assert.equal(result.ok, true);
  assert.deepEqual(byCode(result, 'projection-drift'), []);
  assert.deepEqual(byCode(result, 'projection-missing'), []);
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
  assert.equal(byCode(result, 'projection-blocked')[0].severity, 'warning');
  assert.equal(result.ok, false);
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

test('an open ask is info; past 72 h of journal time it is a warning; answered it is silent', () => {
  // MUTANT 1: flip the comparison in askFindings. Every open question then
  // reports as stale on the day it is asked, and a warning that is red during
  // normal operation is a warning people learn to skip.
  // MUTANT 2: drop the GATE_PASS filter (state.openGates). An ANSWERED
  // question then keeps reporting forever, so doctor and the board — two
  // artefacts doctor itself produces — disagree about what is still open.
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  const asked = ev('2026-08-09T11:02:13.000Z', 'gate', {
    kind: 'Q-7',
    result: 'WAITING_ON_OPERATOR',
    ticket: 'T-10',
    question: 'Flat fee or per-seat on the team plan?',
  });
  writeJournal(journal, [asked, ev('2026-08-09T12:00:00.000Z', 'checkpoint', { phase: 'build', next_steps: [] })]);
  regenerate(journal);

  const fresh = runStateChecks({ dir });
  const open = byCode(fresh, 'ask-open');
  assert.equal(open.length, 1);
  assert.equal(open[0].severity, 'info');
  assert.match(open[0].message, /Q-7 is waiting on the operator .*Flat fee or per-seat/);
  assert.equal(fresh.ok, true, 'a question waiting on a human is not a broken repo');

  const late = runStateChecks({ dir, now: '2026-08-13T11:20:44.000Z' });
  const stale = byCode(late, 'ask-stale');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].severity, 'warning');
  assert.match(stale[0].message, /96\.3 h of journal time/);
  assert.match(stale[0].message, /threshold 72 h/);
  assert.match(stale[0].fix, /answer\.mjs render/);
  assert.equal(late.ok, false);
  // one hour short of the threshold is still info
  assert.deepEqual(byCode(runStateChecks({ dir, now: '2026-08-12T10:02:13.000Z' }), 'ask-stale'), []);

  writeJournal(journal, [
    asked,
    ev('2026-08-09T12:00:00.000Z', 'checkpoint', { phase: 'build', next_steps: [] }),
    ev('2026-08-13T21:04:11.000Z', 'gate', { kind: 'Q-7', result: 'answered', answer: 'per-seat', decision: 'D-1' }),
  ]);
  regenerate(journal);
  const answered = runStateChecks({ dir, now: '2026-09-01T00:00:00.000Z' });
  assert.deepEqual(byCode(answered, 'ask-open'), []);
  assert.deepEqual(byCode(answered, 'ask-stale'), []);
});

test('both ask fixes parse in the shell the operator pastes them into', () => {
  // MUTANT: end the fix with a bare `   (fill the answer: lines, then apply)`.
  // The parenthesis opens a subshell and the line fails to PARSE, so nothing
  // runs at all — measured: /bin/sh and bash exit 2 with "syntax error near
  // unexpected token `('", zsh exits 1. These are the two findings an
  // operator meets most often, and doctor's contract is that every finding
  // carries a command you can paste.
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [
    ev('2026-08-09T11:02:13.000Z', 'gate', { kind: 'Q-7', result: 'WAITING_ON_OPERATOR', question: 'Flat fee?' }),
  ]);
  regenerate(journal);
  const fixes = [
    byCode(runStateChecks({ dir }), 'ask-open')[0],
    byCode(runStateChecks({ dir, now: '2026-08-13T11:20:44.000Z' }), 'ask-stale')[0],
  ];
  for (const found of fixes) {
    assert.ok(found, 'the finding must fire before its fix can be checked');
    // -n parses without executing: a render here would write a real sheet.
    execFileSync('/bin/sh', ['-n', '-c', found.fix], { stdio: 'pipe' });
  }
});

test('the sheet and the session record are not stray files under state/', () => {
  // MUTANT: drop the ASK_QUEUE_FILES exemption. Doctor then reports the two
  // files its own fix command tells the operator to create, and `--state`
  // exits 1 on a repo whose only sin is having a question open.
  const root = repo();
  const dir = scaffold(root);
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(join(dir, 'state', 'ANSWERS.md'), '# 0 questions waiting on you\n');
  writeFileSync(
    join(dir, 'state', 'conductor.json'),
    '{"session_id":"aaaaaaaaaa","started_at":"2026-08-09T11:02:13.000Z","cwd":"/repo"}\n',
  );
  const result = runStateChecks({ dir });
  assert.deepEqual(byCode(result, 'state-stray-file'), []);
  assert.equal(result.ok, true);
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
  assert.equal(byCode(result, 'spawn-orphan-report')[0].severity, 'warning');
  assert.equal(byCode(result, 'agent-name-unusable')[0].severity, 'warning');
  assert.equal(byCode(result, 'spawn-orphan-report').length, 1);
  assert.equal(byCode(result, 'agent-name-unusable').length, 1);
  assert.equal(result.ok, false);
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
  assert.equal(result.findings[0].severity, 'error');
  assert.equal(result.ok, false);
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
  const result = runStateChecks({ dir });
  assert.deepEqual(codes(result), ['state-stray-file']);
  assert.equal(result.findings[0].severity, 'warning');
  assert.equal(result.ok, false);
});

// ------------------------------------------------------------ legacy layout

test('a legacy .tyran/initiatives/ directory is a warning with a non-destructive fix', () => {
  const root = repo();
  const dir = scaffold(root);
  mkdirSync(join(dir, 'initiatives', 'old-slug', 'locks'), { recursive: true });
  const result = runStateChecks({ dir });
  const found = byCode(result, 'state-legacy-initiatives-dir');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warning');
  assert.match(found[0].message, /state\/<initiative>\//);
  assert.doesNotMatch(found[0].fix ?? '', /\brm\b|\bmv\b|>\s*\S/);
  assert.equal(result.ok, false);
});

test('no legacy directory, no legacy finding', () => {
  const root = repo();
  const dir = scaffold(root);
  assert.deepEqual(byCode(runStateChecks({ dir }), 'state-legacy-initiatives-dir'), []);
});

test('lease files committed to git are a warning naming the first file and the count', () => {
  const root = repo();
  const dir = scaffold(root);
  // Keyed on the FULL argv, so the pathspec is pinned: a regression that
  // drops `-- .tyran` (or hard-codes the name) asks a question this stub
  // does not answer and gets '', which fails the assertion below.
  const answers = {
    'rev-parse --is-inside-work-tree': 'true\n',
    'ls-files -- .tyran': [
      '.tyran/config.yaml',
      '.tyran/state/demo/journal.jsonl',
      '.tyran/state/demo/locks/worktree-a.lease',
      '.tyran/initiatives/legacy/locks/slot-1.lease',
    ].join('\n') + '\n',
  };
  const gitStub = (args) => answers[args.join(' ')] ?? '';
  const result = runStateChecks({ dir, run: gitStub });
  const found = byCode(result, 'lease-file-tracked');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warning');
  assert.match(found[0].where, /worktree-a\.lease/);
  assert.match(found[0].where, /\+1 more/);
  assert.match(found[0].message, /2 lease file\(s\)/);
  assert.doesNotMatch(found[0].fix ?? '', /\brm\b|\bmv\b|>\s*\S/);
});

test('lease files on disk but not in git are finding-free — the canonical location is legal', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'init.created', {})]);
  regenerate(journal);
  mkdirSync(join(dir, 'state', 'demo', 'locks'), { recursive: true });
  writeFileSync(join(dir, 'state', 'demo', 'locks', 'worktree-a.lease'), 'holder: impl-1\n');
  // Git ANSWERS here — tracked config and journal, but not the on-disk lease.
  // Without an answering stub the mkdtemp fixture is not a git repo, gitRunner
  // returns '' for everything, and the 'not in git' leg is satisfied
  // vacuously by a runner that could never say otherwise.
  const answers = {
    'rev-parse --is-inside-work-tree': 'true\n',
    'ls-files -- .tyran': '.tyran/config.yaml\n.tyran/state/demo/journal.jsonl\n',
  };
  const result = runStateChecks({ dir, run: (args) => answers[args.join(' ')] ?? '' });
  assert.deepEqual(byCode(result, 'lease-file-tracked'), []);
  assert.deepEqual(byCode(result, 'state-stray-file'), [], 'locks/ under an initiative is not a stray');
});

test('a custom-named state dir keeps both git checks asking about THAT name', () => {
  const root = repo();
  const dir = join(root, 'my-tyran');
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), readFileSync(join(TEMPLATES, 'config.yaml')));
  const asked = [];
  const gitStub = (args) => {
    asked.push(args.join(' '));
    if (args[0] === 'rev-parse') return 'true\n';
    return 'my-tyran/config.yaml\n';
  };
  runStateChecks({ dir, run: gitStub });
  const lsCalls = asked.filter((a) => a.startsWith('ls-files'));
  assert.ok(lsCalls.length >= 2, `expected both checks to ask git, saw: ${asked.join(' | ')}`);
  for (const call of lsCalls) {
    assert.equal(call, 'ls-files -- my-tyran', 'a check hard-coded .tyran instead of the actual dir name');
  }
});

// ------------------------------------------------------- progress signals

test('an agent blocked past the threshold is a warning; a moving agent is not', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'init.created', {}),
    ev('2026-07-26T09:01:00.000Z', 'spawn', { agent: 'impl-1', role: 'implementer' }),
    ev('2026-07-26T09:02:00.000Z', 'progress', { agent: 'impl-1', state: 'blocked', detail: 'lease held' }),
  ]);
  regenerate(journal);
  const blocked = runStateChecks({ dir, now: '2026-07-26T10:30:00.000Z' });
  const found = byCode(blocked, 'spawn-blocked');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /lease held/);
  assert.deepEqual(byCode(blocked, 'spawn-open'), [], 'blocked outranks the plain open row');

  // an unblocked signal clears it back to spawn-open
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'init.created', {}),
    ev('2026-07-26T09:01:00.000Z', 'spawn', { agent: 'impl-1', role: 'implementer' }),
    ev('2026-07-26T09:02:00.000Z', 'progress', { agent: 'impl-1', state: 'blocked', detail: 'lease held' }),
    ev('2026-07-26T09:40:00.000Z', 'progress', { agent: 'impl-1', state: 'unblocked' }),
  ]);
  regenerate(journal);
  const moving = runStateChecks({ dir, now: '2026-07-26T10:30:00.000Z' });
  assert.deepEqual(byCode(moving, 'spawn-blocked'), []);
  assert.equal(byCode(moving, 'spawn-open').length, 1);
  assert.match(byCode(moving, 'spawn-open')[0].message, /last signal/);
});

test('a blocked agent that is ALSO stale reports blocked, not stale', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'spawn', { agent: 'impl-1', role: 'implementer' }),
    ev('2026-07-26T09:02:00.000Z', 'progress', { agent: 'impl-1', state: 'blocked', detail: 'registry 503' }),
  ]);
  regenerate(journal);
  // The operationally important case — blocked all night — trips BOTH clocks:
  // 15 h open (threshold 4) and 15 h blocked (threshold 1). Only one row may
  // survive, and it must be the one carrying the reason the agent is stuck.
  const overnight = runStateChecks({ dir, now: '2026-07-27T00:00:00.000Z' });
  assert.equal(byCode(overnight, 'spawn-blocked').length, 1);
  assert.match(byCode(overnight, 'spawn-blocked')[0].message, /registry 503/);
  assert.deepEqual(byCode(overnight, 'spawn-stale'), [], 'blocked outranks stale, not only the plain open row');
});

test('a signal from a closed incarnation does not follow the name onto the next spawn', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  // ADR-18 permits a name to be re-spawned once its previous spawn is closed,
  // and `close-spawn` recovery writes exactly this report. The report cleared
  // the blockage — the fold says so — so the fresh spawn is a plain open row.
  writeJournal(journal, [
    ev('2026-07-26T00:10:00.000Z', 'spawn', { agent: 'impl-1', role: 'implementer', ticket: 'T-1' }),
    ev('2026-07-26T00:20:00.000Z', 'progress', { agent: 'impl-1', state: 'blocked', detail: 'waiting on lease' }),
    ev('2026-07-26T00:30:00.000Z', 'report', { agent: 'impl-1', verdict: 'done' }),
    ev('2026-07-26T02:00:00.000Z', 'spawn', { agent: 'impl-1', role: 'implementer', ticket: 'T-2' }),
    ev('2026-07-26T02:05:00.000Z', 'checkpoint', { phase: 'build', next_steps: [] }),
  ]);
  regenerate(journal);
  const result = runStateChecks({ dir });
  assert.deepEqual(byCode(result, 'spawn-blocked'), [], 'the blockage died with the incarnation that reported it');
  const open = byCode(result, 'spawn-open');
  assert.equal(open.length, 1);
  assert.match(open[0].message, /T-2/);
  assert.doesNotMatch(open[0].message, /last signal/, 'this spawn has signalled nothing yet');
});

// ---------------------------------------------------------- overnight mode

const PAUSE_MARKER = (over = {}) => ({
  paused_at: '2026-08-13T12:00:00.000Z',
  window: 'five_hour',
  used_percentage: 98,
  resume_at: '2026-08-13T14:00:00.000Z',
  long_wait: false,
  ...over,
});

test('an active pause marker is info; a marker past its resume time is a warning', () => {
  const root = repo();
  const dir = scaffold(root);
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(join(dir, 'state', 'paused-until.json'), JSON.stringify(PAUSE_MARKER()));
  const active = runStateChecks({ dir, now: '2026-08-13T13:00:00.000Z' });
  assert.equal(byCode(active, 'limit-pause-active').length, 1);
  assert.deepEqual(byCode(active, 'limit-pause-stale'), []);

  const stale = runStateChecks({ dir, now: '2026-08-13T15:00:00.000Z' });
  assert.equal(byCode(stale, 'limit-pause-stale').length, 1);
  assert.equal(stale.ok, false);
  assert.doesNotMatch(byCode(stale, 'limit-pause-stale')[0].fix ?? '', /\brm\b|\bmv\b|>\s*\S/);
});

test('without an explicit --now a marker is reported present, never stale — no wall clock', () => {
  const root = repo();
  const dir = scaffold(root);
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(join(dir, 'state', 'paused-until.json'), JSON.stringify(PAUSE_MARKER({ resume_at: '1999-01-01T00:00:00.000Z' })));
  const result = runStateChecks({ dir });
  assert.equal(byCode(result, 'limit-pause-active').length, 1);
  assert.deepEqual(byCode(result, 'limit-pause-stale'), []);
});

test('a dead waiting watcher and a failed resume are both warnings', () => {
  const root = repo();
  const dir = scaffold(root);
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(join(dir, 'state', 'paused-until.json'), JSON.stringify(PAUSE_MARKER()));
  writeFileSync(join(dir, 'state', 'resume.json'), JSON.stringify({ state: 'waiting', pid: 99999999 }));
  const dead = runStateChecks({ dir, now: '2026-08-13T13:00:00.000Z' });
  assert.equal(byCode(dead, 'limit-resume-watcher-dead').length, 1);

  // The watcher unlinks the marker before spawning the resume, so the real
  // failed-resume disk state has NO marker — the check must not hide behind one.
  rmSync(join(dir, 'state', 'paused-until.json'));
  writeFileSync(join(dir, 'state', 'resume.json'), JSON.stringify({ state: 'failed', reason: 'resume-did-not-take' }));
  const failed = runStateChecks({ dir, now: '2026-08-13T13:00:00.000Z' });
  assert.equal(byCode(failed, 'limit-resume-watcher-dead').length, 1);
  assert.deepEqual(byCode(failed, 'limit-pause-active'), []);
  assert.deepEqual(byCode(failed, 'limit-pause-stale'), []);
  // `schedule` refuses without a marker, and the failed resume consumed it —
  // a fix command must be executable in the exact state that fires it.
  const fix = byCode(failed, 'limit-resume-watcher-dead')[0].fix;
  assert.doesNotMatch(fix, /overnight\.mjs['"]? schedule/, 'the no-marker fix must not point at schedule');
  assert.match(fix, /claude --resume/, 'the no-marker fix names the hand-resume path');
});

test('limits configured with no telemetry is a warning; mode off or no limits is silent', () => {
  const root = repo();
  const dir = scaffold(root, { config: false });
  mkdirSync(join(dir, 'state'), { recursive: true });
  const config = (mode) =>
    `profile: balanced\nautonomy: P1\ntiers:\n  cheap: a\n  work: b\n  deep: c\n  top: d\nlimits:\n  mode: '${mode}'\n`;
  writeFileSync(join(dir, 'config.yaml'), config('pause'));
  const missing = runStateChecks({ dir, now: '2026-08-13T13:00:00.000Z' });
  assert.equal(byCode(missing, 'limit-telemetry-missing').length, 1);

  // fresh telemetry silences it
  writeFileSync(
    join(dir, 'state', 'usage.json'),
    JSON.stringify({ written_at: '2026-08-13T12:59:00.000Z', five_hour: { used_percentage: 10 } }),
  );
  assert.deepEqual(byCode(runStateChecks({ dir, now: '2026-08-13T13:00:00.000Z' }), 'limit-telemetry-missing'), []);

  // a sidecar over a day old is as blind as an absent one (25h before --now)
  writeFileSync(
    join(dir, 'state', 'usage.json'),
    JSON.stringify({ written_at: '2026-08-12T12:00:00.000Z', five_hour: { used_percentage: 10 } }),
  );
  assert.equal(byCode(runStateChecks({ dir, now: '2026-08-13T13:00:00.000Z' }), 'limit-telemetry-missing').length, 1);

  writeFileSync(join(dir, 'config.yaml'), config('off'));
  writeFileSync(join(dir, 'state', 'usage.json'), '');
  assert.deepEqual(byCode(runStateChecks({ dir, now: '2026-08-13T13:00:00.000Z' }), 'limit-telemetry-missing'), []);

  // no limits block at all: nothing is configured, so nothing can be blind
  writeFileSync(
    join(dir, 'config.yaml'),
    'profile: balanced\nautonomy: P1\ntiers:\n  cheap: a\n  work: b\n  deep: c\n  top: d\n',
  );
  const noLimits = runStateChecks({ dir, now: '2026-08-13T13:00:00.000Z' });
  assert.deepEqual(noLimits.findings.filter((f) => f.code.startsWith('limit-')), []);
});

test('an oversized knowledge entry is a warning on a file that still validates', () => {
  const root = repo();
  const dir = scaffold(root, { knowledge: false });
  mkdirSync(join(dir, 'knowledge'), { recursive: true });
  const big = 'x'.repeat(4001);
  writeFileSync(
    join(dir, 'knowledge', 'big.yaml'),
    `entries:\n  - id: K-1\n    kind: fact\n    text: '${big}'\n    confidence: 0.5\n` +
      `    provenance:\n      - source: 'test'\n        reference: 'test'\n`,
  );
  const result = runStateChecks({ dir });
  assert.deepEqual(byCode(result, 'knowledge-invalid'), [], 'oversize is advisory, not a schema error');
  const oversized = byCode(result, 'knowledge-entry-oversized');
  assert.equal(oversized.length, 1);
  assert.equal(oversized[0].severity, 'warning');
  assert.match(oversized[0].message, /K-1/);
  assert.match(oversized[0].message, /4001/);
  assert.doesNotMatch(oversized[0].fix ?? '', /\brm\b|\bmv\b|>\s*\S/);
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
  const mixed = byCode(result, 'journal-mixed-initiatives');
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].severity, 'warning');
  assert.equal(result.ok, false);
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
  assert.equal(byCode(result, 'lease-release-by-non-holder')[0].severity, 'warning');
  assert.equal(byCode(result, 'lease-open').length, 1);
  assert.equal(result.ok, false);
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

// --- the silent one -------------------------------------------------------
//
// `git worktree add` carries tracked files only, and the policy gate is silent
// in a repo with no `.tyran/`. An uncommitted `.tyran/` therefore means every
// worktree runs ungated — nothing fails, nothing is refused. Measured on a
// real install: four worktrees, four implementers with no autonomy class.

const fakeGit = (map) => (args) => map[args.join(' ')] ?? '';
const IN_TREE = 'rev-parse --is-inside-work-tree';

test('an untracked .tyran/ is a warning, because worktrees will be ungated', () => {
  const root = repo();
  const dir = scaffold(root);
  const run = fakeGit({ [IN_TREE]: 'true\n', 'ls-files -- .tyran': '' });
  const found = byCode(runStateChecks({ dir, run }), 'tyran-dir-untracked');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warning');
  assert.match(found[0].fix, /git add/);
});

test('a committed .tyran/ produces no finding', () => {
  const root = repo();
  const dir = scaffold(root);
  const run = fakeGit({ [IN_TREE]: 'true\n', 'ls-files -- .tyran': '.tyran/config.yaml\n' });
  assert.deepEqual(byCode(runStateChecks({ dir, run }), 'tyran-dir-untracked'), []);
});

test('outside a git work tree the question has NO answer, and none is invented', () => {
  // The same discipline as detectPackageManager: "git could not tell us" is
  // not evidence of anything. Without this the check fires on every temp
  // directory and every fresh `git init`, and a warning that is always on is
  // a warning nobody reads.
  const root = repo();
  const dir = scaffold(root);
  assert.deepEqual(byCode(runStateChecks({ dir, run: fakeGit({}) }), 'tyran-dir-untracked'), []);
});

// --- the quieter one ------------------------------------------------------
//
// `.tyran/` being tracked as a whole says nothing about ONE initiative inside
// it. Measured on a real install: a `.tyran/` tracked for weeks, and inside it
// an initiative directory of six files — its plan and the gate event recording
// two production database migrations — that git had never seen, while the
// directory-level check above reported healthy.

const TRACKED = { [IN_TREE]: 'true\n', 'ls-files -- .tyran': '.tyran/config.yaml\n' };
const LEDGER = '.tyran/state/demo/journal.jsonl';
const STATUS = 'status --porcelain --ignored -- .tyran';

/** A tracked `.tyran/` whose `demo` ledger is in whatever state `over` says. */
function ledgerGit(over) {
  return fakeGit({ ...TRACKED, 'ls-files -- .tyran': `.tyran/config.yaml\n${LEDGER}\n`, ...over });
}

test('an initiative whose ledger git has never seen is a warning that fails the check', () => {
  // Mutant: drop the per-initiative branch and keep only untrackedTyranDir —
  // this repo has a tracked .tyran/, so the directory check says healthy and
  // the initiative that is one `git clean -fd` from gone reports nothing.
  const root = repo();
  const dir = scaffold(root);
  writeFileSync(journalPathFor(dir), '');
  const result = runStateChecks({ dir, run: fakeGit(TRACKED) });
  const found = byCode(result, 'initiative-untracked');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warning');
  assert.match(found[0].fix, /git add '\.tyran\/state\/demo'/);
  assert.doesNotMatch(found[0].fix, /\brm\b|\bmv\b|>\s*\S/);
  assert.equal(result.ok, false);
});

test('a ledger hidden by a .gitignore rule is NOT told to run a command that does nothing', () => {
  // `git add` on an ignored path exits 0 and stages nothing, so the untracked
  // fix would read as success and change nothing.
  // Mutant: collapse `ignored` into `untracked` and print the same `git add`.
  const root = repo();
  const dir = scaffold(root);
  writeFileSync(journalPathFor(dir), '');
  const run = fakeGit({ ...TRACKED, [STATUS]: '!! .tyran/state/\n' });
  const found = byCode(runStateChecks({ dir, run }), 'initiative-ignored');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warning');
  assert.match(found[0].fix, /git check-ignore -v/);
  assert.doesNotMatch(found[0].fix.split('#')[0], /git add/); // the command, not the note about it
  assert.deepEqual(byCode(runStateChecks({ dir, run }), 'initiative-untracked'), []);
});

test('a tracked, clean ledger produces no finding of any of the three kinds', () => {
  const root = repo();
  const dir = scaffold(root);
  writeFileSync(journalPathFor(dir), '');
  const result = runStateChecks({ dir, run: ledgerGit({ [STATUS]: '' }) });
  for (const code of ['initiative-untracked', 'initiative-ignored', 'initiative-uncommitted']) {
    assert.deepEqual(byCode(result, code), []);
  }
});

test('uncommitted ledger changes are INFO — that is what an initiative in flight looks like', () => {
  // Mutant: raise it to `warning`. Every `journal.mjs append` produces this
  // state within seconds, so the check would then be red during normal
  // operation, which is how a check stops being read.
  const root = repo();
  const dir = scaffold(root);
  writeFileSync(journalPathFor(dir), '');
  const result = runStateChecks({ dir, run: ledgerGit({ [STATUS]: ` M ${LEDGER}\n` }) });
  const found = byCode(result, 'initiative-uncommitted');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'info');
  assert.equal(result.ok, true);
});

test('an untracked child of a tracked ledger directory reports as uncommitted, not committed', () => {
  // git collapses a wholly untracked directory into ONE entry ending in `/`.
  // Mutant: compare the recorded path for equality with the prefix instead of
  // by prefix, and a plan nobody committed reads as a clean initiative.
  const root = repo();
  const dir = scaffold(root);
  writeFileSync(journalPathFor(dir), '');
  const run = ledgerGit({ [STATUS]: '?? .tyran/state/demo/PLAN.md\n' });
  assert.equal(byCode(runStateChecks({ dir, run }), 'initiative-uncommitted').length, 1);
});

test('a wholly untracked .tyran/ says so ONCE, not once per initiative', () => {
  // Mutant: drop the `untracked === false` guard. The repo then reports the
  // same defect N+1 times, and each per-initiative line gives narrower advice
  // than the directory line it repeats.
  const root = repo();
  const dir = scaffold(root);
  writeFileSync(journalPathFor(dir, 'one'), '');
  writeFileSync(journalPathFor(dir, 'two'), '');
  const run = fakeGit({ [IN_TREE]: 'true\n', 'ls-files -- .tyran': '' });
  const result = runStateChecks({ dir, run });
  assert.equal(byCode(result, 'tyran-dir-untracked').length, 1);
  assert.deepEqual(byCode(result, 'initiative-untracked'), []);
});

test('outside a git work tree no ledger question is answered either', () => {
  const root = repo();
  const dir = scaffold(root);
  writeFileSync(journalPathFor(dir), '');
  const result = runStateChecks({ dir, run: fakeGit({}) });
  for (const code of ['initiative-untracked', 'initiative-ignored', 'initiative-uncommitted']) {
    assert.deepEqual(byCode(result, code), []);
  }
});

test('the ledger check costs a fixed number of git calls, not two per initiative', () => {
  // Mutant: ask git per initiative. It passes every behavioural test above and
  // turns a 40-initiative repo into 80 subprocesses inside the SessionStart
  // deadline, which is the kind of regression only a counter catches.
  const root = repo();
  const dir = scaffold(root);
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) writeFileSync(journalPathFor(dir, name), '');
  const calls = [];
  const counting = (args) => {
    calls.push(args.join(' '));
    return { [IN_TREE]: 'true\n', 'ls-files -- .tyran': '.tyran/config.yaml\n' }[args.join(' ')] ?? '';
  };
  runStateChecks({ dir, run: counting });
  assert.equal(calls.filter((c) => c === STATUS).length, 1);
  // untrackedTyranDir, this check, trackedLeaseFiles — three, and three
  // whether the repo holds one initiative or forty.
  assert.equal(calls.filter((c) => c === 'ls-files -- .tyran').length, 3);
});

test('a repo with no autonomy policy is told its writes are all refused', () => {
  // `error`, not `info`. The policy gate fails closed on this exact state, so
  // a `.tyran/` with no policy under it is a repository where every tool call
  // that writes anything is denied — and the remedy has to be a command that
  // does not itself name the protected path, or it is refused too.
  const root = repo();
  const dir = scaffold(root, { policy: false });
  const missing = byCode(runStateChecks({ dir }), 'policy-missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].severity, 'error');
  assert.match(missing[0].fix, /--ensure-policy/);
  assert.ok(!/\bcp\b/.test(missing[0].fix), 'a cp naming the policy path is refused by the gate itself');
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
  assert.ok(byCode(result, 'projection-absent').length > 0, 'projection check was skipped too');
  // and the CLI reports it instead of dying with a stack trace
  const cli = run(['--state', '--dir', dir]);
  assert.equal(cli.code, 1);
  assert.equal(cli.stderr, '');
  assert.match(cli.stdout, /\[check-failed\]/);
});

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

test('the scanned-initiative list is ordered by doctor, not by the filesystem', () => {
  const root = repo();
  const dir = scaffold(root);
  // Created in an order that is neither natural nor lexicographic, and named
  // so that natural order (i-2 < i-10) disagrees with lexicographic order
  // (i-10 < i-2). readdirSync order is a filesystem detail; the report is not
  // allowed to inherit it.
  for (const name of ['i-10', 'i-2', 'i-20', 'i-1']) {
    const journal = journalPathFor(dir, name);
    writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'init.created', {}, { init: name })]);
    regenerate(journal);
  }
  const line = runStateChecks({ dir }).checked.find((l) => l.startsWith('state/:'));
  assert.equal(line, 'state/: i-1 (1 event(s)), i-2 (1 event(s)), i-10 (1 event(s)), i-20 (1 event(s))');
  // same bytes on a second run, and the CLI agrees with the module
  assert.equal(renderText(runStateChecks({ dir })), renderText(runStateChecks({ dir })));
  assert.ok(run(['--state', '--dir', dir]).stdout.includes(line));
});

test('findings whose sort keys compare equal keep the order they were produced in', () => {
  const root = repo();
  const dir = scaffold(root);
  // naturalCompare treats "x-01" and "x-1" as equal (both parse to 1), so
  // these two findings tie on every component of the sort key. Without an
  // explicit tie-break the surviving order is whatever the sort happens to
  // do; with one it is the order the checks produced, which is the scan
  // order — deterministic by construction.
  for (const name of ['x-01', 'x-1']) mkdirSync(join(dir, 'state', name), { recursive: true });
  const first = runStateChecks({ dir }).findings.map((f) => f.where);
  const second = runStateChecks({ dir }).findings.map((f) => f.where);
  assert.equal(first.length, 2);
  assert.deepEqual(first, second);
  assert.deepEqual(first, [join(dir, 'state', 'x-01'), join(dir, 'state', 'x-1')]);
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

test('a hostile init reaches neither the text report nor a printed command raw', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir, 'demo');
  const esc = String.fromCodePoint(0x1b);
  const rlo = String.fromCodePoint(0x202e);
  // erase-line + cursor-up: printed raw, this wipes the finding above it.
  const init = `demo${esc}[2K${esc}[1A${rlo}`;
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'spawn', { agent: 'impl-1', role: 'x' }, { init }),
    ev('2026-07-26T09:00:01.000Z', 'lease.acquired', { resource: 'w', holder: 'impl-1' }, { init }),
    ev('2026-07-26T09:00:02.000Z', 'report', { agent: 'impl-1', verdict: 'DONE' }, { init }),
  ]);
  const result = runStateChecks({ dir });
  assert.ok(byCode(result, 'journal-init-mismatch').length > 0, 'the hostile init was not even flagged');

  const text = renderText(result);
  assert.equal(text.includes(esc), false, 'ANSI escape reached the text report');
  assert.equal(text.includes(rlo), false, 'bidi override reached the text report');
  const json = renderJson(result);
  assert.equal(json.includes(esc), false, 'ANSI escape reached the JSON output');
  assert.equal(json.includes(rlo), false, 'bidi override reached the JSON output');

  // Every fix line, not just the message, and the CLI's real bytes too.
  for (const f of result.findings) {
    if (!f.fix) continue;
    assert.equal(f.fix.includes(esc), false, `raw escape in fix of ${f.code}`);
    assert.equal(f.fix.includes(rlo), false, `raw bidi in fix of ${f.code}`);
  }
  const cli = run(['--state', '--dir', dir]);
  assert.equal(cli.stdout.includes(esc), false, 'ANSI escape reached stdout');
  assert.equal(cli.stdout.includes(rlo), false, 'bidi override reached stdout');
});

/** The `--init <arg>` token of a fix command, exactly as it was printed. */
function initArgOf(fix) {
  const at = fix.indexOf('--init ');
  assert.notEqual(at, -1, fix);
  return fix.slice(at + '--init '.length).split('\n')[0].trim();
}

/** Feed a printed argument back through a real shell, byte for byte. */
function shellExpand(arg) {
  // bash explicitly: $'...' is a bash/zsh construct, and /bin/sh is dash on
  // the CI runner. The printed commands are documented as bash/zsh.
  return execSync(`printf '%s' ${arg}`, { encoding: 'utf8', shell: '/bin/bash' });
}

test('ANSI-C quoting keeps a hostile value byte-exact and runnable', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir, 'demo');
  const init = `demo${String.fromCodePoint(0x1b)}[2K`;
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'init.created', {}, { init })]);
  const fix = byCode(runStateChecks({ dir }), 'journal-init-mismatch')[0].fix;
  assert.match(fix, /\$'demo\\x1b\[2K'/);
  assert.equal(shellExpand(initArgOf(fix)), init);
});

test('a quote inside an ANSI-C quoted value cannot close it and run commands', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir, 'demo');
  const sentinel = join(root, 'PWNED');
  // The non-printable byte forces the ANSI-C branch; the apostrophe is the
  // payload. Escape the quote wrongly and everything after it is a command
  // list, executed by whoever pasted the "fix".
  const init = `demo${String.fromCodePoint(0x202e)}'; touch ${sentinel}; :'`;
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'init.created', {}, { init })]);
  const fix = byCode(runStateChecks({ dir }), 'journal-init-mismatch')[0].fix;
  assert.match(fix, /\$'/, 'the payload did not reach the ANSI-C branch at all');

  const expanded = shellExpand(initArgOf(fix));
  assert.equal(existsSync(sentinel), false, 'the printed fix command executed injected commands');
  assert.equal(expanded, init, 'the value did not survive the round trip byte for byte');
});

test('a backslash inside an ANSI-C quoted value cannot escape the closing quote', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir, 'demo');
  // A trailing backslash left unescaped turns the closing quote into a
  // literal, so the command runs off the end: "unexpected EOF".
  const init = `demo${String.fromCodePoint(0x202e)}\\`;
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'init.created', {}, { init })]);
  const fix = byCode(runStateChecks({ dir }), 'journal-init-mismatch')[0].fix;
  assert.match(fix, /\$'/);
  assert.equal(shellExpand(initArgOf(fix)), init);
});

test('the whole printed fix command runs, with a hostile init, and does nothing extra', () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir, 'demo');
  const sentinel = join(root, 'PWNED-E2E');
  const init = `demo${String.fromCodePoint(0x202e)}'; touch ${sentinel}; :'`;
  writeJournal(journal, [
    ev('2026-07-26T09:00:00.000Z', 'init.created', {}, { init }),
    ev('2026-07-26T09:00:01.000Z', 'checkpoint', { phase: 'x', next_steps: [] }, { init }),
  ]);
  const fix = byCode(runStateChecks({ dir }), 'journal-init-mismatch')[0].fix;
  // Not a fragment: the real command, in the repo, as a human would paste it.
  const out = execSync(fix, { cwd: REPO, encoding: 'utf8', shell: '/bin/bash' });
  assert.equal(existsSync(sentinel), false, 'the fix command executed injected commands');
  assert.equal(out.trim().split('\n').length, 2, `query returned the wrong rows:\n${out}`);
  for (const line of out.trim().split('\n')) assert.equal(JSON.parse(line).init, init);
});

test('the self-run guard survives an argv[1] that cannot be canonicalized', () => {
  // canonicalPath() calls realpathSync, which THROWS on a path that cannot be
  // followed. Without the fallback that throw escapes from module scope and
  // doctor dies on import — and doctor is meant to be imported by the future
  // SessionStart hook, not only run as a CLI. Reached when argv[1] stops
  // resolving: the script directory renamed or removed after launch, a parent
  // component made unreadable, or a launcher rewriting argv[1] to a logical
  // name. Mirrors the same pin in tests/unit/journal.test.mjs.
  const base = mkdtempSync(join(tmpdir(), 'tyran-doctor-argv-'));
  const harness = join(base, 'harness.mjs');
  writeFileSync(
    harness,
    "process.argv[1] = '/nonexistent-dir-" +
      "e2s4/entry.mjs';\n" +
      `const m = await import(${JSON.stringify(DOCTOR)});\n` +
      "console.log('SURVIVED', typeof m.runStateChecks);\n",
  );
  const r = execFileSync(process.execPath, [harness], { encoding: 'utf8' });
  // Imported cleanly, and correctly declined to run main() for a foreign
  // entry point: no usage text, no exception, module still usable.
  assert.equal(r.trim(), 'SURVIVED function');
});

test('CLI: invoked through a symlinked path, doctor still does its work', () => {
  // The self-run guard used to compare resolve(argv[1]) — which keeps
  // symlinks — with import.meta.url, which Node has already canonicalized.
  // Reaching the script through a link therefore made main() never run: no
  // output, EXIT 0. For a tool whose one promise is "never reports clean for
  // something it skipped", a silent success is the worst possible failure —
  // and /tmp and /var are symlinks on macOS.
  const base = mkdtempSync(join(tmpdir(), 'tyran-doctor-symlink-'));
  const linked = join(base, 'linked-scripts');
  symlinkSync(fileURLToPath(new URL('../../scripts/', import.meta.url)).replace(/\/$/, ''), linked);

  const dir = scaffold(base);
  const journal = journalPathFor(dir);
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'teleport', {})]);

  const direct = run(['--state', '--dir', dir]);
  let linkedRun;
  try {
    execFileSync(process.execPath, [join(linked, 'doctor.mjs'), '--state', '--dir', dir], {
      encoding: 'utf8',
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    linkedRun = { code: 0, stdout: '' };
  } catch (err) {
    linkedRun = { code: err.status, stdout: err.stdout ?? '' };
  }
  assert.notEqual(linkedRun.stdout, '', 'the CLI produced no output at all through the symlink');
  assert.equal(linkedRun.code, 1, 'a state with an error exited 0 through the symlink');
  assert.equal(linkedRun.stdout, direct.stdout, 'the symlinked run disagreed with the direct one');
});

test('an unreadable initiative directory is not diagnosed as an empty one', { skip: rootUser }, () => {
  const root = repo();
  const dir = scaffold(root);
  const journal = journalPathFor(dir);
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'init.created', {})]);
  const initiativeDir = dirname(journal);
  chmodSync(initiativeDir, 0o000);
  try {
    const result = runStateChecks({ dir });
    assert.deepEqual(codes(result), ['journal-unreadable']);
    assert.equal(result.findings[0].severity, 'error');
    assert.match(result.findings[0].message, /EACCES/);
    assert.deepEqual(byCode(result, 'journal-missing'), [], 'EACCES was mistaken for a missing journal');
    // and no finding on this state may propose destroying it
    for (const f of result.findings) assert.doesNotMatch(f.fix ?? '', /\brm\b/);
  } finally {
    chmodSync(initiativeDir, 0o755);
  }
  // the journal was intact all along
  assert.match(readFileSync(journal, 'utf8'), /init\.created/);
});

test('no finding anywhere proposes a destructive command', () => {
  const root = repo();
  const dir = scaffold(root);
  mkdirSync(join(dir, 'state', 'empty'), { recursive: true });
  const journal = journalPathFor(dir, 'demo');
  writeJournal(journal, [ev('2026-07-26T09:00:00.000Z', 'teleport', {})]);
  for (const f of runStateChecks({ dir }).findings) {
    assert.doesNotMatch(f.fix ?? '', /\brm\b|\bmv\b|>\s*\S/, `${f.code} hands out a destructive command`);
  }
});

// ------------------------------------------------------------ severity pins

// Every code, pinned literally. A severity is a promise about the exit code,
// and each of these was once a per-call-site literal that could be flipped
// with all 54 tests still green.
const EXPECTED_SEVERITY = {
  'journal-missing': 'warning',
  'journal-unreadable': 'error',
  'journal-not-a-file': 'error',
  'journal-invalid': 'error',
  'journal-truncated': 'warning',
  'journal-warning': 'warning',
  'journal-lock-present': 'warning',
  'journal-init-mismatch': 'error',
  'journal-cross-init-pairing': 'error',
  'journal-mixed-initiatives': 'warning',
  'check-failed': 'error',
  'spawn-open': 'info',
  'spawn-stale': 'warning',
  'spawn-blocked': 'warning',
  'spawn-duplicate': 'warning',
  'spawn-orphan-report': 'warning',
  'agent-name-unusable': 'warning',
  'ask-open': 'info',
  'ask-stale': 'warning',
  'lease-open': 'info',
  'lease-orphan': 'warning',
  'lease-expired': 'warning',
  'lease-release-by-non-holder': 'warning',
  'projection-drift': 'warning',
  'projection-absent': 'info',
  'projection-missing': 'warning',
  'projection-blocked': 'warning',
  'projection-failed': 'error',
  'projection-unreadable': 'error',
  'board-absent': 'info',
  'config-missing': 'info',
  'config-invalid': 'error',
  'config-unreadable': 'error',
  'knowledge-invalid': 'error',
  'knowledge-unreadable': 'error',
  'knowledge-not-a-directory': 'warning',
  'knowledge-entry-oversized': 'warning',
  'tyran-dir-untracked': 'warning',
  'policy-missing': 'error',
  'policy-invalid': 'error',
  'policy-unreadable': 'error',
  'policies-unreadable': 'error',
  'policies-not-a-directory': 'warning',
  'policy-kernel-downgrade': 'error',
  'policy-rule-dead': 'warning',
  'policy-rule-overruled': 'warning',
  'no-state-dir': 'info',
  'state-not-a-directory': 'error',
  'state-unreadable': 'error',
  'state-stray-file': 'warning',
  'state-legacy-initiatives-dir': 'warning',
  'lease-file-tracked': 'warning',
  'initiative-untracked': 'warning',
  'initiative-ignored': 'warning',
  'initiative-uncommitted': 'info',
  'limit-pause-active': 'info',
  'limit-pause-stale': 'warning',
  'limit-resume-watcher-dead': 'warning',
  'limit-telemetry-missing': 'warning',
  'mistakes-unreadable': 'warning',
  'mistakes-repeat-unpromoted': 'info',
  'mistakes-file-missing': 'info',
  'claude-md-fence-missing': 'info',
};

test('every finding code has exactly one pinned severity', () => {
  assert.deepEqual({ ...SEVERITY_BY_CODE }, EXPECTED_SEVERITY);
  for (const severity of Object.values(SEVERITY_BY_CODE)) {
    assert.ok(SEVERITIES.includes(severity), severity);
  }
});

test('every code the source can emit is registered, and documented', () => {
  const source = readFileSync(fileURLToPath(new URL('../../scripts/doctor.mjs', import.meta.url)), 'utf8');
  const literal = [...source.matchAll(/finding\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.ok(literal.length > 20, `only ${literal.length} literal codes found — did the call shape change?`);
  for (const code of new Set(literal)) {
    assert.ok(code in SEVERITY_BY_CODE, `finding('${code}') is emitted but not registered`);
  }
  // the two families built from a template variable
  for (const kind of ['config', 'knowledge', 'policy']) {
    assert.ok(`${kind}-invalid` in SEVERITY_BY_CODE);
    assert.ok(`${kind}-unreadable` in SEVERITY_BY_CODE);
  }
  for (const label of ['knowledge', 'policies']) {
    assert.ok(`${label}-not-a-directory` in SEVERITY_BY_CODE);
    assert.ok(`${label}-unreadable` in SEVERITY_BY_CODE);
  }
  const docs = readFileSync(fileURLToPath(new URL('../../docs/doctor.md', import.meta.url)), 'utf8');
  for (const code of Object.keys(SEVERITY_BY_CODE)) {
    assert.ok(docs.includes(`\`${code}\``), `${code} is not in the docs/doctor.md table`);
  }
});

test('an unregistered code is a loud bug, not a finding with no severity', () => {
  // Two code families are built from a template variable, so the static scan
  // above cannot see them: a typo there would yield severity `undefined`,
  // which counts as nothing and silently stops failing the check.
  assert.throws(() => severityFor('not-a-real-code'), /no severity in SEVERITY_BY_CODE/);
  assert.throws(() => severityFor('policies-invalid'), /no severity/, 'a plausible typo must still throw');
  assert.throws(() => severityFor(''), /no severity/);
  assert.throws(() => severityFor(undefined), /no severity/);
  // A code called `constructor` must be data, not an inherited member.
  assert.equal(Object.getPrototypeOf(SEVERITY_BY_CODE), null);
  assert.throws(() => severityFor('constructor'), /no severity/);
  assert.throws(() => severityFor('__proto__'), /no severity/);
  // and the registered ones do not throw
  for (const code of Object.keys(SEVERITY_BY_CODE)) {
    assert.ok(SEVERITIES.includes(severityFor(code)), code);
  }
});

test('the docs table is the same map as SEVERITY_BY_CODE, in both directions', () => {
  const docs = readFileSync(fileURLToPath(new URL('../../docs/doctor.md', import.meta.url)), 'utf8');
  // Parse the severity table properly. Checking `docs.includes('`code`')` was
  // not coupling: the token also occurs in the Known limits prose, so a row
  // could carry the wrong severity — or be deleted outright — and the test
  // stayed green. This is the only place a human reads to learn whether a
  // finding will cost them exit 0 or exit 1.
  const documented = new Map();
  for (const line of docs.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1);
    if (cells.length !== 3) continue;
    const severity = cells[1].trim();
    if (!SEVERITIES.includes(severity)) continue;
    const codesInRow = [...cells[0].matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]);
    assert.ok(codesInRow.length > 0, `severity row with no code: ${line}`);
    for (const code of codesInRow) {
      assert.equal(documented.has(code), false, `${code} is documented twice`);
      documented.set(code, severity);
    }
  }
  assert.equal(documented.size > 40, true, `only ${documented.size} rows parsed — did the table shape change?`);
  // both directions: a wrong severity, a missing row and a stale row all fail
  assert.deepEqual(
    Object.fromEntries([...documented].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    Object.fromEntries(Object.entries(SEVERITY_BY_CODE).sort((a, b) => (a[0] < b[0] ? -1 : 1))),
  );
});

test('state/ that is not a directory is an error, and fails the check alone', () => {
  const root = repo();
  const dir = scaffold(root);
  writeFileSync(join(dir, 'state'), 'not a directory');
  const result = runStateChecks({ dir });
  const found = byCode(result, 'state-not-a-directory');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.equal(result.ok, false);
  assert.equal(run(['--state', '--dir', dir]).code, 1);
});

test('policy-rule-overruled reaches the report as a warning that fails the check', () => {
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
      "  - path: '*/policy-gate.mjs'",
      '    class: AUTO',
      '    reason: looks like it covers every policy gate',
      '',
    ].join('\n'),
    'utf8',
  );
  const result = runStateChecks({ dir });
  const found = byCode(result, 'policy-rule-overruled');
  assert.equal(found.length, 1, JSON.stringify(codes(result)));
  assert.equal(found[0].severity, 'warning');
  assert.match(found[0].message, /hooks\/policy-gate\.mjs/);
  assert.equal(result.ok, false);
});

test('a knowledge directory that cannot be listed is an error, not zero files', { skip: rootUser }, () => {
  const root = repo();
  const dir = scaffold(root);
  chmodSync(join(dir, 'knowledge'), 0o000);
  try {
    const result = runStateChecks({ dir });
    const found = byCode(result, 'knowledge-unreadable');
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, 'error');
    assert.match(found[0].message, /EACCES/);
  } finally {
    chmodSync(join(dir, 'knowledge'), 0o755);
  }
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
    state: true,
    hooks: false,
    // Not a literal: the default is derived from where doctor.mjs sits, so
    // pinning an absolute path here would pin this machine rather than the
    // contract.
    pluginRoot: DEFAULT_PLUGIN_ROOT,
  });
  assert.equal(parseArgs(['--state', '--stale-hours', '0']).staleHours, 0);
  assert.equal(parseArgs(['--state', '--now', '2026-01-01T00:00:00.000Z']).now, '2026-01-01T00:00:00.000Z');
});

test('a mode is required, and either one satisfies it', () => {
  // The point of requiring a mode is that a bare `doctor.mjs` never silently
  // acquires a meaning. Adding --hooks must not have weakened that.
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--json']));
  assert.equal(parseArgs(['--hooks']).hooks, true);
  assert.equal(parseArgs(['--hooks']).state, false);
  const both = parseArgs(['--state', '--hooks']);
  assert.equal(both.state, true);
  assert.equal(both.hooks, true);
});

test('no finding code is defined by BOTH severity tables', () => {
  // Doctor and hooks-check keep separate tables and are never merged. A code
  // living in both would resolve to whichever table its renderer happened to
  // consult, which is the silent divergence this repo removes everywhere
  // else. Cheaper to forbid the collision than to define a winner.
  const collisions = Object.keys(HOOK_SEVERITY_BY_CODE).filter((code) => code in SEVERITY_BY_CODE);
  assert.deepEqual(collisions, []);
});

test('every hook finding code carries a severity, including the built ones', () => {
  for (const code of Object.keys(HOOK_SEVERITY_BY_CODE)) {
    assert.ok(SEVERITIES.includes(hookSeverityFor(code)), `${code} has a severity doctor can render`);
  }
  assert.throws(() => hookSeverityFor('no-such-code'), /has no severity/);
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

// --- hostile journals reaching the operator's report -------------------------

/**
 * Reviewer item #6, and the one he called the most valuable thing in his own
 * review: doctor had never been fuzzed. It is the same SHAPE as the blocker he
 * found in `project.warnings()` — an operator-facing channel whose content
 * comes from a journal — so it got a measurement rather than an argument.
 *
 * The measurement found it leaking: 137 of 400 hostile trees put invisible
 * codepoints in `renderText`, 118 in `renderJson`. The cause was not doctor's
 * own sanitizer but the MESSAGES it renders, built in journal.mjs with a raw
 * `ev` interpolated into them. Fixed at the source; guarded here.
 */
const HOSTILE_CP = [0x202e, 0x200b, 0x2066, 0xfeff, 0x00ad, 0x0600, 0xe0041, 0xe0100, 0x13430, 0x001b];
const invisibleIn = (text) =>
  [...text].filter((c) => {
    const n = c.codePointAt(0);
    if (n === 0x0a || n === 0x09) return false;
    return /^[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}]$/u.test(c);
  });

test('a hostile journal cannot put invisible characters in the doctor report', () => {
  const poison = (i) => String.fromCodePoint(HOSTILE_CP[i % HOSTILE_CP.length]);
  const root = repo();
  const dir = scaffold(root);
  const events = [];
  for (let i = 0; i < HOSTILE_CP.length; i++) {
    events.push({
      ts: `2026-07-26T10:00:0${i % 10}.000Z`,
      // an `ev` outside the closed set is what validateEvent quotes back
      ev: i % 2 === 0 ? `weird${poison(i)}type` : 'spawn',
      init: i % 3 === 0 ? `other${poison(i)}` : 'demo',
      actor: `actor${poison(i)}`,
      data: { agent: `agent${poison(i)}`, role: `role${poison(i)}`, ticket: `T${poison(i)}` },
    });
  }
  writeJournal(journalPathFor(dir), events);

  const result = runStateChecks({ dir, now: '2026-07-27T10:00:00.000Z' });
  for (const [channel, text] of [
    ['renderText', renderText(result)],
    ['renderJson', renderJson(result)],
  ]) {
    assert.deepEqual(
      invisibleIn(text).map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`),
      [],
      `invisible codepoint reached doctor's ${channel}`,
    );
  }
  // The findings must still SAY something — a report that is clean because it
  // is empty would pass the assertion above and protect nobody.
  assert.ok(result.findings.length > 0, 'premise: this journal produces findings');
});

// --- an absent MISTAKES.md: opt-out, or never offered? -------------------

/**
 * The same runner doctor builds for itself. Imported rather than stubbed: the
 * behaviour under test is precisely what git answers, and a fake that returns
 * what the test expects would prove only that the test agrees with itself.
 */
const gitRunnerFor = (dir) => gitRunner(dir);

/** A real git repo with one commit, so `git log` can answer about a path. */
function gitRepo({ withMistakes = false, thenDelete = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-mistakes-'));
  const git = (cmd) => execSync(`git ${cmd}`, { cwd: dir, stdio: 'ignore' });
  git('init -q');
  git('config user.email t@example.com');
  git('config user.name Test');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  if (withMistakes) writeFileSync(join(dir, 'MISTAKES.md'), '# Mistakes\n');
  git('add -A');
  git('commit -q -m first');
  if (thenDelete) {
    rmSync(join(dir, 'MISTAKES.md'));
    git('add -A');
    git('commit -q -m "delete the ledger"');
  }
  return dir;
}

test('a MISTAKES.md that was DELETED stays silent — that is the opt-out', () => {
  // MUTANT: report absence without asking git. The file's absence is the
  // documented way to decline the ledger, and a tool that nags about a file
  // you deliberately removed is a tool you switch off — which would cost the
  // gates it sits next to, not just this check.
  const dir = gitRepo({ withMistakes: true, thenDelete: true });
  const { findings, checked } = mistakesFindings(dir, gitRunnerFor(dir));
  assert.deepEqual(findings, []);
  assert.match(checked, /IS the opt-out/);
});

test('a MISTAKES.md git has NEVER seen is an offer, at info', () => {
  // The other half of the same absence: an install made before the ledger
  // existed never declined anything, because nobody ever offered.
  const dir = gitRepo({ withMistakes: false });
  const { findings } = mistakesFindings(dir, gitRunnerFor(dir));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'mistakes-file-missing');
  assert.equal(severityFor(findings[0].code), 'info', 'nothing is broken — an offer, not a defect');
  assert.match(findings[0].fix, /--ensure-policy/, 'the remedy has to be runnable');
  assert.doesNotMatch(findings[0].fix, /MISTAKES\.md['"]?\s*$/, 'and it names no protected path');
});

test('where git cannot answer, absence says NOTHING rather than guessing', () => {
  // MUTANT: treat an empty `git log` as "never existed". `run` returns '' both
  // when git says nothing and when there is no git at all, and those need
  // opposite conclusions — guessing here nags precisely the operator who
  // already opted out.
  const bare = mkdtempSync(join(tmpdir(), 'tyran-nogit-'));
  assert.deepEqual(mistakesFindings(bare, gitRunnerFor(bare)).findings, []);
  assert.match(mistakesFindings(bare, gitRunnerFor(bare)).checked, /no git here/);
  // and with no runner at all — the pre-existing signature — it is silent too
  assert.deepEqual(mistakesFindings(bare).findings, []);
});
