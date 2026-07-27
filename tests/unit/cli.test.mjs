/**
 * cli — the `tyran` npm package's bin/tyran.mjs dispatcher.
 *
 * This file tests the DISPATCHER, not the scripts it delegates to (those
 * have their own suites). Four properties matter here, in order of how
 * badly a silent regression would hurt:
 *
 *  1. the exit code contract: `npx tyran <cmd>` in CI must go red exactly
 *     when `node scripts/<cmd>.mjs` would, numerically, not just "nonzero";
 *  2. args reach the target script byte-for-byte — no shell re-parsing,
 *     because spaces or quotes silently truncated in argv is a bug users
 *     only discover from a confusing downstream error;
 *  3. `tyran` / `tyran --help` lists every registered subcommand with a
 *     description and exits 0, and an unknown subcommand exits 2 rather
 *     than being swallowed into a default;
 *  4. the CLI still resolves scripts/ when invoked through a SYMLINK from
 *     an unrelated working directory — exactly how npm installs `bin`
 *     entries into node_modules/.bin/. See the isMainModule comment in
 *     scripts/desc-budget.mjs and the matching comment in bin/tyran.mjs:
 *     comparing raw paths across a symlink is the one class of bug in this
 *     file that fails SILENTLY (exit 0, nothing ran) rather than loudly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../../bin/tyran.mjs';

const CLI = fileURLToPath(new URL('../../bin/tyran.mjs', import.meta.url));
const SCRIPTS_DIR = fileURLToPath(new URL('../../scripts/', import.meta.url));

function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

function runDirect(scriptFile, args, opts = {}) {
  const r = spawnSync(process.execPath, [join(SCRIPTS_DIR, scriptFile), ...args], { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// --- help ------------------------------------------------------------

test('bare `tyran` (no args) prints help and exits 0', () => {
  const result = runCli([]);
  assert.equal(result.status, 0);
  for (const name of Object.keys(COMMANDS)) {
    assert.match(result.stdout, new RegExp(`\\b${name}\\b`), `help is missing command '${name}'`);
  }
});

test('`tyran --help` lists every subcommand with its one-line description and exits 0', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  for (const [name, [, description]] of Object.entries(COMMANDS)) {
    assert.match(result.stdout, new RegExp(`\\b${name}\\b`), `help is missing command '${name}'`);
    assert.ok(result.stdout.includes(description), `help is missing the description for '${name}'`);
  }
});

test('`tyran -h` behaves the same as --help', () => {
  const result = runCli(['-h']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: tyran <command>/);
});

test('help states plainly that this package does not install the plugin', () => {
  const result = runCli([]);
  assert.match(result.stdout, /does NOT install the Claude Code plugin/);
  assert.match(result.stdout, /plugin marketplace add jjanczur\/tyran/);
});

// --- unknown subcommand ------------------------------------------------

test('an unknown subcommand exits 2 and names the known commands, never a silent default', () => {
  const result = runCli(['not-a-real-command']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command 'not-a-real-command'/);
  for (const name of Object.keys(COMMANDS)) {
    assert.match(result.stderr, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

// --- exit code propagation ---------------------------------------------

test('exit code propagates NUMERICALLY: a subcommand that fails direct fails the CLI the same way', () => {
  // `journal.mjs` with no args prints usage and exits 2 — deterministic, no
  // filesystem setup required. Confirmed independently below so this test
  // does not silently pass if the underlying script's contract ever changes.
  const direct = runDirect('journal.mjs', []);
  assert.notEqual(direct.status, 0, 'fixture assumption broke: journal.mjs with no args must fail');

  const dispatched = runCli(['journal']);
  assert.equal(dispatched.status, direct.status, 'CLI exit code must match the delegated script exit code exactly');
});

test('exit code propagates for a SECOND, independently-failing subcommand (schema)', () => {
  const direct = runDirect('schema.mjs', []);
  assert.notEqual(direct.status, 0, 'fixture assumption broke: schema.mjs with no args must fail');

  const dispatched = runCli(['schema']);
  assert.equal(dispatched.status, direct.status);
});

test('exit code propagates 0 on success (doctor --state against an empty, valid dir)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-cli-doctor-'));
  mkdirSync(join(dir, '.tyran'));
  const direct = runDirect('doctor.mjs', ['--state', '--dir', join(dir, '.tyran')]);
  const dispatched = runCli(['doctor', '--state', '--dir', join(dir, '.tyran')]);
  assert.equal(dispatched.status, direct.status);
});

// --- argument forwarding -------------------------------------------------

test('arguments reach the delegated script untouched, spaces and quote-like characters included', () => {
  // schema.mjs echoes an unrecognised `kind` back verbatim in its error,
  // which makes it a faithful witness to what argv actually carried. A
  // string-joined "shell" forward would split this at the spaces; an
  // array-based spawn (what bin/tyran.mjs uses) cannot.
  const needle = 'weird "kind" with spaces and — an em dash';
  const direct = runDirect('schema.mjs', ['validate', needle, 'somefile.yaml']);
  const dispatched = runCli(['schema', 'validate', needle, 'somefile.yaml']);
  assert.equal(dispatched.status, direct.status);
  assert.equal(dispatched.stdout, direct.stdout);
  assert.ok(dispatched.stdout.includes(needle), 'the argument did not survive the trip through the dispatcher intact');
});

test('stdout and stderr from the delegated script are identical to calling it directly', () => {
  const direct = runDirect('doctor.mjs', []);
  const dispatched = runCli(['doctor']);
  assert.equal(dispatched.stdout, direct.stdout);
  assert.equal(dispatched.stderr, direct.stderr);
});

// --- symlink resolution ---------------------------------------------------

test('the CLI still works invoked through a SYMLINK, from a working directory outside the repo', () => {
  // This is exactly how npm installs `bin` entries: a symlink under
  // node_modules/.bin/ pointing at the package's real bin/tyran.mjs. A path
  // comparison or a scripts/ resolution that isn't realpath'd on both sides
  // silently finds nothing next to the symlink (see the module doc comment
  // in bin/tyran.mjs) instead of failing loudly.
  const linkDir = mkdtempSync(join(tmpdir(), 'tyran-cli-linkdir-'));
  const link = join(linkDir, 'tyran');
  symlinkSync(CLI, link);

  const cwd = mkdtempSync(join(tmpdir(), 'tyran-cli-cwd-'));

  const help = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8', cwd });
  assert.equal(help.status, 0);
  for (const name of Object.keys(COMMANDS)) {
    assert.match(help.stdout, new RegExp(`\\b${name}\\b`));
  }

  // Exercises scriptsDir() resolution for real: if it resolved relative to
  // the symlink's own directory instead of the real bin/ directory, this
  // would report "does not exist in this install" (exit 2) instead of
  // delegating successfully.
  const doctor = spawnSync(process.execPath, [link, 'doctor'], { encoding: 'utf8', cwd });
  const direct = runDirect('doctor.mjs', []);
  assert.equal(doctor.status, direct.status, 'symlinked invocation must resolve scripts/ and propagate the same exit code');
  assert.ok(!doctor.stderr.includes('does not exist in this install'), doctor.stderr);
});
