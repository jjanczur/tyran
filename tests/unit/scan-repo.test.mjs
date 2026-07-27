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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanRepo,
  renderConfig,
  detectAutonomy,
  detectValidation,
  detectPackageManager,
  detectLanguages,
  LOCKFILES,
  VALIDATION_SCRIPTS,
} from '../../scripts/scan-repo.mjs';
import { parse } from '../../scripts/yaml-lite.mjs';
import { validateConfig } from '../../scripts/schema.mjs';

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

test('a repo with neither returns null rather than inventing a manager', () => {
  assert.equal(detectPackageManager(repo()), null);
});

// --- validation ------------------------------------------------------------

test('validation commands come from the scripts the repo actually declares', () => {
  const pkg = { scripts: { lint: 'eslint .', typecheck: 'tsc', test: 'vitest', deploy: 'nope' } };
  const got = detectValidation(repo(), pkg, 'pnpm');
  assert.deepEqual(got.value, ['pnpm lint', 'pnpm typecheck', 'pnpm test']);
  assert.equal(got.needs_confirmation, false);
});

test('`build` is deliberately not treated as a validation command', () => {
  assert.ok(!VALIDATION_SCRIPTS.includes('build'), 'build is slow and typecheck already covers most of it');
  const got = detectValidation(repo(), { scripts: { build: 'next build' } }, 'npm');
  assert.deepEqual(got.value, [], 'a repo with only a build script has no validation to report');
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
