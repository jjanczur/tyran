/**
 * Tests for the shared command-line contract.
 *
 * These exist because of a measurement, not a hunch. Every command
 * `bin/tyran.mjs` dispatches was run against a repo where setup had just
 * finished:
 *
 *   --help answered as help ............ 0 of 14
 *   silently IGNORED an unknown flag ... 4 of 14
 *
 * The four were tiers, scan-repo, stop-check and desc-budget: they parse by
 * looking up the flags they know, so a flag they do not know is never seen.
 * `tiers --rol reviewer` exited 0 and printed the entire routing table.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { handleArgs, unknownFlags, wantsHelp } from '../../scripts/cli-args.mjs';

const CLI = fileURLToPath(new URL('../../bin/tyran.mjs', import.meta.url));

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('a flag nobody declared is reported, not skipped', () => {
  // MUTANT: return [] unconditionally. That is the pre-fix behaviour of four
  // scripts, and it is invisible from inside them: nothing throws, nothing
  // prints, the command simply answers a question it was not asked.
  assert.deepEqual(unknownFlags(['--rol', 'reviewer'], ['role']), ['--rol']);
  assert.deepEqual(unknownFlags(['--role', 'reviewer'], ['role']), []);
  // `known` may be written with or without the dashes; both spellings appear
  // across the call sites and neither is worth a second convention.
  assert.deepEqual(unknownFlags(['--role', 'x'], ['--role']), []);
});

test('--flag=value is the same flag as --flag', () => {
  // MUTANT: compare the whole token. `--dir=/tmp` would then be an unknown
  // flag named `--dir=/tmp`, which refuses a spelling every other CLI accepts.
  assert.deepEqual(unknownFlags(['--dir=/tmp'], ['dir']), []);
  assert.deepEqual(unknownFlags(['--dr=/tmp'], ['dir']), ['--dr']);
});

test('everything after a bare -- is a positional, not a flag', () => {
  // MUTANT: keep scanning past `--`. A path that legitimately begins with two
  // dashes would then be refused as a flag.
  assert.deepEqual(unknownFlags(['--dir', '/a', '--', '--not-a-flag'], ['dir']), []);
});

test('positionals and negative numbers are never mistaken for flags', () => {
  assert.deepEqual(unknownFlags(['build', '-3', 'x.js'], []), []);
  assert.equal(wantsHelp(['--dir', '.tyran']), false);
  for (const spelling of ['--help', '-h', 'help']) {
    assert.equal(wantsHelp(['x', spelling]), true, `${spelling} must ask for help`);
  }
});

test('handleArgs answers help on stdout and exit 0, and refuses on stderr and exit 2', () => {
  // MUTANT: print help to stderr, or exit non-zero for it. `--help` is a
  // question that was answered — a shell pipeline and a CI step both read that
  // exit code, and 2 there means the command failed.
  const out = [];
  const err = [];
  const codes = [];
  const io = { print: (m) => out.push(m), fail: (m) => err.push(m), exit: (c) => codes.push(c) };

  assert.equal(handleArgs(['--help'], { name: 't', usage: 'usage: t', known: ['dir'] }, io), false);
  assert.deepEqual(out, ['usage: t']);
  assert.deepEqual(codes, [0]);
  assert.deepEqual(err, [], 'help is not an error');

  assert.equal(handleArgs(['--nope'], { name: 't', usage: 'usage: t', known: ['dir'] }, io), false);
  assert.equal(codes[1], 2);
  assert.match(err[0], /^t: unknown flag --nope$/);
  assert.equal(err[1], 'usage: t', 'a refusal shows what WOULD have worked');

  // The ordinary path returns true and touches nothing.
  assert.equal(handleArgs(['--dir', '.tyran'], { name: 't', usage: 'usage: t', known: ['dir'] }, io), true);
  assert.equal(codes.length, 2, 'a valid command line must not exit');
});

test('the four commands that used to swallow a typo now refuse it', () => {
  // MUTANT: drop the handleArgs call from any of them. Measured before the
  // fix, all four of these exited 0 and did their normal work.
  for (const args of [
    ['tiers', '--rol', 'reviewer'],
    ['scan-repo', '--dir', '.', '--bogus'],
    ['stop-check', '--bogus'],
    ['desc-budget', '--bogus'],
  ]) {
    const r = run(args);
    assert.equal(r.code, 2, `${args[0]} accepted an unknown flag`);
    assert.match(r.stderr, /unknown flag/, `${args[0]} did not say what was wrong`);
  }
});

test('--help is answered by every command that takes flags rather than subcommands', () => {
  // MUTANT: remove any one wantsHelp guard. Before this, `--help` was answered
  // as help by NONE of them: five refused it as an unknown flag and four ran
  // their normal work with it silently ignored, which is the worse half —
  // `stop-check --help` performed a check and reported a verdict.
  for (const command of [
    'doctor', 'board', 'cost', 'answer', 'migrate', 'tiers', 'scan-repo', 'stop-check', 'desc-budget',
    // Subcommand-style. These reached their usage text through the
    // unknown-VERB path and exited 2, so `--help` was reported as a
    // mistake rather than answered. `journal` is not here yet: its usage
    // string is still built inside the error handler (NOTES-REQUESTS).
    'schema', 'knowledge', 'mistakes',
  ]) {
    const r = run([command, '--help']);
    assert.equal(r.code, 0, `${command} --help exited ${r.code}`);
    assert.match(r.stdout, /usage:/, `${command} --help printed no usage`);
  }
});
