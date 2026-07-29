/**
 * scan-repo — the deterministic half of setup.
 *
 * The failure this file guards against is not "detection is imperfect". It is
 * detection that is CONFIDENTLY WRONG: a guessed validation command, or an
 * autonomy class inferred upward. Both are believed once and then never
 * re-examined, which is what makes them expensive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanRepo,
  renderConfig,
  detectAutonomy,
  detectValidation,
  detectPackageManager,
  detectLanguages,
  LOCKFILES,
  VALIDATION_SCRIPTS,
  watchModeProblem,
  BootstrapError,
  POLICY_PATH,
  ensureAutonomyPolicy,
  policyTemplatePath,
  underTyranDir,
} from '../../scripts/scan-repo.mjs';
import { parse } from '../../scripts/yaml-lite.mjs';
import { validateConfig, validatePolicy } from '../../scripts/schema.mjs';

function repo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-scan-'));
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

/** A fake git, so the tests do not depend on a real repository's history. */
const fakeGit = (map) => (args) => map[args.join(' ')] ?? '';

// --- package manager -------------------------------------------------------

test('a lockfile identifies the package manager with high confidence', () => {
  for (const [file, manager] of Object.entries(LOCKFILES)) {
    const d = repo({ [file]: '' });
    const got = detectPackageManager(d);
    assert.equal(got.value, manager, file);
    assert.ok(got.confidence > 0.9);
    assert.equal(got.needs_confirmation, false);
  }
});

test('package.json with no lockfile assumes npm but FLAGS the assumption', () => {
  const got = detectPackageManager(repo({ 'package.json': '{}' }));
  assert.equal(got.value, 'npm');
  assert.equal(got.needs_confirmation, true, 'an assumption must be visible as one');
});

test('a lockfile git does NOT track loses to one it does', () => {
  // Measured on a real install: pnpm-lock.yaml on disk but gitignored, with
  // package-lock.json the tracked one the deploy builds from. Choosing by disk
  // order made every validation command wrong — `pnpm lint` in a repo with no
  // pnpm. Presence is not evidence; being committed is.
  const d = repo({ 'pnpm-lock.yaml': '', 'package-lock.json': '{}' });
  const git = fakeGit({ 'ls-files': 'package.json\npackage-lock.json\nsrc/a.ts\n' });
  const got = detectPackageManager(d, git);
  assert.equal(got.value, 'npm');
  assert.match(got.source, /pnpm-lock\.yaml/, 'the rejected lockfile is named, not silently skipped');
  assert.equal(got.needs_confirmation, false);
});

test('no git answer means no conclusion — presence still decides', () => {
  // The distinction that keeps the rule honest. An empty `ls-files` is "git
  // could not tell us" (no repo, nothing committed), not "this file is
  // ignored". Reading it as the latter would flag every fresh clone.
  const d = repo({ 'pnpm-lock.yaml': '' });
  const got = detectPackageManager(d, fakeGit({}));
  assert.equal(got.value, 'pnpm');
  assert.equal(got.needs_confirmation, false);
  assert.ok(got.confidence > 0.9);
});

test('lockfiles on disk and none of them committed is a FLAGGED guess', () => {
  const d = repo({ 'pnpm-lock.yaml': '' });
  const got = detectPackageManager(d, fakeGit({ 'ls-files': 'package.json\nsrc/a.ts\n' }));
  assert.equal(got.value, 'pnpm');
  assert.equal(got.needs_confirmation, true, 'a manager nothing in git supports is not a fact');
  assert.ok(got.confidence < 0.5);
});

test('a repo with neither returns null rather than inventing a manager', () => {
  assert.equal(detectPackageManager(repo()), null);
});

// --- validation ------------------------------------------------------------

test('validation commands come from the scripts the repo actually declares', () => {
  // `test: 'vitest run'`, not `'vitest'`. The bare form was filler here and the
  // watcher rule now drops it — correctly, which is why this fixture had to
  // change rather than the rule. A test whose scenery trips a real guard tells
  // you nothing about the thing it was written to check.
  const pkg = { scripts: { lint: 'eslint .', typecheck: 'tsc', test: 'vitest run', deploy: 'nope' } };
  const got = detectValidation(repo(), pkg, 'pnpm');
  assert.deepEqual(got.value, ['pnpm lint', 'pnpm typecheck', 'pnpm test']);
  assert.equal(got.needs_confirmation, false);
});

test('`build` is deliberately not treated as a validation command', () => {
  assert.ok(!VALIDATION_SCRIPTS.includes('build'), 'build is slow and typecheck already covers most of it');
  const got = detectValidation(repo(), { scripts: { build: 'next build' } }, 'npm');
  assert.deepEqual(got.value, [], 'a repo with only a build script has no validation to report');
});

// --- the watcher rule ------------------------------------------------------
//
// A validation command that watches does not FAIL the agent that runs it. It
// hangs it — no output, no timeout, a session that has simply stopped. Setup
// wrote `pnpm test` into a real repo whose test script was bare `vitest`, and
// every agent handed that gate would have waited forever.

test('a bare `vitest` test script is rerouted to the run-once variant', () => {
  const pkg = { scripts: { test: 'vitest', 'test:run': 'vitest run', lint: 'eslint .' } };
  const got = detectValidation(repo(), pkg, 'npm');
  assert.deepEqual(got.value, ['npm run lint', 'npm run test:run']);
  assert.match(got.source, /watch mode/);
  assert.equal(got.needs_confirmation, false, 'a clean alternate is an answer, not a question');
});

test('a watcher with no run-once variant is LEFT OUT and flagged, never written', () => {
  const pkg = { scripts: { test: 'vitest', lint: 'eslint .' } };
  const got = detectValidation(repo(), pkg, 'npm');
  assert.deepEqual(got.value, ['npm run lint'], 'the hanging command must not reach the config');
  assert.equal(got.needs_confirmation, true);
  assert.match(got.source, /left out/);
});

test('watchModeProblem is narrow — a false positive drops a real test command', () => {
  // Runs once, and must be left alone.
  for (const clean of ['vitest run', 'vitest run --coverage', 'jest', 'jest --ci', 'node --test', 'vitest --run', 'pytest']) {
    assert.equal(watchModeProblem(clean), null, clean);
  }
  // Never exits.
  for (const watcher of ['vitest', 'vitest --coverage', 'jest --watch', 'jest --watchAll', 'nodemon test.js']) {
    assert.notEqual(watchModeProblem(watcher), null, watcher);
  }
});

test('nothing recognisable yields an EMPTY list, flagged — never a guess', () => {
  // A guessed command fails for a reason unrelated to the change, and the
  // operator learns the gate is noise. Empty and honest beats plausible.
  const got = detectValidation(repo(), null, 'npm');
  assert.deepEqual(got.value, []);
  assert.equal(got.needs_confirmation, true);
  assert.ok(got.confidence < 0.5);
});

test('a Makefile is read when there is no package.json', () => {
  const d = repo({ Makefile: 'lint:\n\techo hi\ntest:\n\techo hi\n' });
  const got = detectValidation(d, null, undefined);
  assert.deepEqual(got.value, ['make lint', 'make test']);
});

// --- autonomy --------------------------------------------------------------

test('a PR-driven main infers P1 and says why, with the counts in the reason', () => {
  const git = fakeGit({
    'rev-parse --abbrev-ref HEAD': 'main\n',
    'log --first-parent -50 --pretty=%p|%s': ['a b|Merge pull request #1', 'c d|Merge pull request #2', 'e|direct'].join('\n'),
  });
  const got = detectAutonomy(repo(), git);
  assert.equal(got.value, 'P1');
  assert.match(got.source, /2 of the last 3/);
  assert.equal(got.needs_confirmation, false);
});

test('direct pushes plus a staging branch and CI infer P2 — but ASK', () => {
  const d = repo({ '.github/workflows/ci.yml': 'name: CI\n' });
  const git = fakeGit({
    'rev-parse --abbrev-ref HEAD': 'main\n',
    'log --first-parent -50 --pretty=%p|%s': ['a|one', 'b|two', 'c|three'].join('\n'),
    'branch -a --format=%(refname:short)': 'main\norigin/staging\n',
  });
  const got = detectAutonomy(d, git);
  assert.equal(got.value, 'P2');
  assert.equal(got.needs_confirmation, true, 'raising above the safest class is never silent');
});

test('P3 is NEVER inferred, whatever the repository looks like', () => {
  // No arrangement of files is evidence that a human meant to let an agent
  // deploy to production. This is the single most important line in the file.
  const d = repo({ '.github/workflows/ci.yml': 'name: CI\n' });
  const shapes = [
    { 'rev-parse --abbrev-ref HEAD': 'main\n', 'log --first-parent -50 --pretty=%p|%s': 'a|direct\nb|direct', 'branch -a --format=%(refname:short)': 'main\nstaging\ndevelop\nproduction\n' },
    { 'rev-parse --abbrev-ref HEAD': 'main\n', 'log --first-parent -50 --pretty=%p|%s': 'a b|Merge pull request #1' },
    { 'rev-parse --abbrev-ref HEAD': 'trunk\n', 'log --first-parent -50 --pretty=%p|%s': 'x|chore: deploy to prod' },
  ];
  for (const shape of shapes) {
    assert.notEqual(detectAutonomy(d, fakeGit(shape)).value, 'P3');
  }
});

test('no git history at all falls back to the safest class and asks', () => {
  const got = detectAutonomy(repo(), fakeGit({}));
  assert.equal(got.value, 'P1');
  assert.equal(got.needs_confirmation, true);
});

// --- languages -------------------------------------------------------------

test('languages are ranked by how much of the repo they are', () => {
  const git = fakeGit({ 'ls-files': ['a.ts', 'b.ts', 'c.ts', 'd.py', 'readme.md'].join('\n') });
  assert.deepEqual(detectLanguages(repo(), git), ['TypeScript', 'Python']);
});

test('a repo git cannot list yields no languages rather than an error', () => {
  assert.deepEqual(detectLanguages(repo(), fakeGit({})), []);
});

// --- the whole scan --------------------------------------------------------

test('the emitted config passes the repo schema and round-trips through the parser', () => {
  // The emitter and the parser are the same pair that a stray apostrophe
  // already broke once, in CI. Round-tripping is the only check that catches
  // a quoting bug before an operator does.
  const d = repo({ 'package.json': JSON.stringify({ scripts: { lint: 'x', test: "it's fine" } }), 'package-lock.json': '{}' });
  const { config } = scanRepo(d, { run: fakeGit({ 'rev-parse --abbrev-ref HEAD': 'main\n', 'log --first-parent -50 --pretty=%p|%s': 'a b|Merge pull request #1' }) });
  const text = renderConfig(config);
  assert.deepEqual(validateConfig(parse(text)), [], 'the config we write must validate against our own schema');
});

test('a source string containing an apostrophe survives the round trip', () => {
  const config = {
    profile: 'balanced',
    autonomy: { value: 'P1', source: "the repo's history says so", confidence: 0.9, needs_confirmation: false },
    tiers: { cheap: 'haiku', work: 'sonnet', deep: 'opus', top: 'fable' },
    validation: [],
    shared_zones: [],
  };
  const back = parse(renderConfig(config));
  assert.equal(back.autonomy.source, "the repo's history says so");
  assert.deepEqual(validateConfig(back), []);
});

test('every question raised names the field AND the fact behind it', () => {
  // "Confirm the autonomy class" with no reason is an interrogation. The
  // operator has to be able to answer without opening the repo.
  const { questions } = scanRepo(repo(), { run: fakeGit({}) });
  assert.ok(questions.length > 0);
  for (const q of questions) {
    assert.ok(q.field?.length > 0);
    assert.ok(q.asked?.length > 10, `question about ${q.field} carries no evidence`);
  }
});

test('--write produces a file that validates', () => {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'package-lock.json': '{}' });
  const target = join(d, '.tyran', 'config.yaml');
  const { config } = scanRepo(d, { run: fakeGit({ 'rev-parse --abbrev-ref HEAD': 'main\n' }) });
  mkdirSync(join(d, '.tyran'), { recursive: true });
  writeFileSync(target, renderConfig(config));
  assert.deepEqual(validateConfig(parse(readFileSync(target, 'utf8'))), []);
});

// --- bootstrapping the policy ----------------------------------------------
//
// The state these tests are about is not "a file is missing". It is a
// repository that REFUSES EVERY WRITE: the policy gate is silent without a
// `.tyran/` directory and fails closed with one, so a setup that creates the
// directory and not the policy locks the session out of the repair. It shipped
// that way and cost a real operator a hand-run `mkdir` and `cp`.

const SCRIPT = fileURLToPath(new URL('../../scripts/scan-repo.mjs', import.meta.url));

/**
 * Run the CLI the way setup does, over BOTH streams. scan-repo reports what it
 * wrote on stderr and its scan on stdout, so a helper that reads only stdout
 * asserts against an empty string and passes over a silent bootstrap.
 */
function cli(args, cwd) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const policyOf = (d) => join(d, ...POLICY_PATH.split('/'));

test('writing .tyran/config.yaml also installs the autonomy policy', () => {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'package-lock.json': '{}' });
  const { code } = cli(['--dir', d, '--write', join(d, '.tyran', 'config.yaml')], d);

  assert.equal(code, 0);
  assert.ok(existsSync(join(d, '.tyran', 'config.yaml')), 'config was written');
  assert.ok(existsSync(policyOf(d)), 'the gate has a policy to read');
  assert.deepEqual(validatePolicy(parse(readFileSync(policyOf(d), 'utf8'))), []);
});

test('the installed policy is the shipped template, byte for byte', () => {
  // Not "a policy" — THE strictest one Tyran ships. A bootstrap that writes
  // something of its own devising is a bootstrap that can write a weaker
  // boundary than the one a reader of the template expects.
  const d = repo();
  ensureAutonomyPolicy(d);
  assert.equal(readFileSync(policyOf(d), 'utf8'), readFileSync(policyTemplatePath(), 'utf8'));
});

test('an existing policy is never overwritten, whatever it says', () => {
  // This is the KERNEL boundary, and it is the one property that separates
  // bootstrap from self-authorization. A policy a human tightened by hand must
  // survive every later run of setup.
  const d = repo();
  mkdirSync(join(d, '.tyran', 'policies'), { recursive: true });
  const mine = 'default: KERNEL\nrules: []\n';
  writeFileSync(policyOf(d), mine);

  assert.equal(ensureAutonomyPolicy(d).status, 'present');
  cli(['--dir', d, '--write', join(d, '.tyran', 'config.yaml')], d);
  cli(['--dir', d, '--ensure-policy'], d);

  assert.equal(readFileSync(policyOf(d), 'utf8'), mine, 'the human-authored policy is untouched');
});

test('--ensure-policy repairs a .tyran/ that predates the bootstrap', () => {
  // The already-broken repositories: `.tyran/` on disk from an older setup,
  // every write refused, and the operator needing a command that does not
  // itself name the protected path.
  const d = repo();
  mkdirSync(join(d, '.tyran'), { recursive: true });
  writeFileSync(join(d, '.tyran', 'config.yaml'), 'autonomy: P1\n');

  const { code, out } = cli(['--dir', d, '--ensure-policy'], d);
  assert.equal(code, 0);
  assert.match(out, /created/);
  assert.deepEqual(validatePolicy(parse(readFileSync(policyOf(d), 'utf8'))), []);
  assert.equal(readFileSync(join(d, '.tyran', 'config.yaml'), 'utf8'), 'autonomy: P1\n', 'config untouched');
});

test('a --write outside .tyran/ seeds nothing', () => {
  // The gate arms on the DIRECTORY. Writing a config somewhere else does not
  // arm it, so nothing needs to be installed, and setup must not scatter
  // policy files into repositories that never adopted Tyran.
  const d = repo({ 'package.json': '{}' });
  cli(['--dir', d, '--write', join(d, 'elsewhere.yaml')], d);
  assert.ok(existsSync(join(d, 'elsewhere.yaml')));
  assert.equal(existsSync(join(d, '.tyran')), false);
});

test('underTyranDir sees the directory, not one filename', () => {
  const d = '/repo';
  assert.equal(underTyranDir('/repo/.tyran/config.yaml', d), true);
  assert.equal(underTyranDir('/repo/.tyran/knowledge/x.yaml', d), true);
  assert.equal(underTyranDir('/repo/.tyran', d), true);
  assert.equal(underTyranDir('/repo/config.yaml', d), false);
  assert.equal(underTyranDir('/elsewhere/.tyran/config.yaml', d), false);
});

test('a template that does not validate refuses instead of installing', () => {
  const d = repo();
  const bad = join(repo(), 'autonomy.yaml');
  writeFileSync(bad, 'default: WHATEVER\nrules: []\n');
  assert.throws(() => ensureAutonomyPolicy(d, { templatePath: bad }), BootstrapError);
  assert.equal(existsSync(join(d, '.tyran')), false, 'nothing half-installed');
});

test('a failed install leaves no .tyran/ behind', () => {
  // The error path reintroducing the bug is the shape worth pinning: an
  // aborted bootstrap that leaves the directory on disk produces exactly the
  // repository-refuses-everything state, and the operator has no idea why.
  const d = repo();
  const readOnly = join(d, '.tyran');
  mkdirSync(readOnly, { recursive: true });
  chmodSync(readOnly, 0o500);
  try {
    assert.throws(() => ensureAutonomyPolicy(d), BootstrapError);
  } finally {
    chmodSync(readOnly, 0o700);
  }
  assert.equal(existsSync(policyOf(d)), false);
});

test('the CLI exits 2, loudly, when the policy cannot be installed', () => {
  const d = repo({ 'package.json': '{}' });
  mkdirSync(join(d, '.tyran'), { recursive: true });
  chmodSync(join(d, '.tyran'), 0o500);
  try {
    const { code, out } = cli(['--dir', d, '--write', join(d, '.tyran', 'config.yaml')], d);
    assert.equal(code, 2);
    assert.match(out, /scan-repo:/);
    assert.equal(existsSync(join(d, '.tyran', 'config.yaml')), false, 'no config without a boundary to govern it');
  } finally {
    chmodSync(join(d, '.tyran'), 0o700);
  }
});
