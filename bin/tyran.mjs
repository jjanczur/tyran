#!/usr/bin/env node
/**
 * tyran — command-line entry point for the `@jjanczur/tyran` npm package.
 *
 * The registry name is scoped (`@jjanczur/tyran`) but the command stays
 * `tyran` — that is `bin`'s key, not the package name, and npx resolves a
 * scoped package's sole bin entry regardless of scope (same pattern as
 * `@angular/cli` giving you `ng`). The bare name `tyran` is not available:
 * it carries an npm unpublish tombstone from 2021-03-30, and npm's abuse
 * policy blocks republishing an unpublished name permanently, for anyone.
 *
 * This is a thin dispatcher, not a reimplementation. Every subcommand below
 * is delegated VERBATIM (same argv, same exit code) to a script that already
 * ships in this repo under `scripts/` and that the Claude Code plugin's own
 * hooks and skills already call directly. `npm i @jjanczur/tyran` does NOT
 * install the plugin — it only makes these scripts reachable from a shell or
 * a CI job that has no Claude Code session. To install the plugin itself,
 * run `/plugin marketplace add jjanczur/tyran` inside Claude Code (that name
 * is the Claude Code marketplace/plugin identity, unrelated to the npm
 * registry and not affected by any of the above).
 *
 * Path resolution note (read before touching this file): npm installs `bin`
 * entries as a SYMLINK into `node_modules/.bin/`. `scripts/desc-budget.mjs`
 * hit the silent-no-op version of this exact bug first — see its
 * `isMainModule` comment: comparing a symlink path against a real path made
 * a whole script's entry guard evaluate false forever, quietly, under exit
 * 0. The same class of bug applies here to locating `scripts/`: resolving it
 * relative to this file's own path without realpath-ing BOTH the symlink
 * (`process.argv[1]` / the caller's path) and this module's own real
 * location would land on a `scripts/` directory that does not exist next to
 * the symlink target in `node_modules/.bin/`. Both sides are realpath'd
 * below for that reason, mirroring `isMainModule` in desc-budget.mjs.
 *
 * Exit code contract: whatever the delegated script exits with, THIS process
 * exits with the same code, numerically. A dispatcher that always exits 0
 * turns `npx @jjanczur/tyran doctor` in CI into decoration instead of a
 * gate — that is the one property this file must never regress.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Subcommand -> [script filename under scripts/, one-line description].
 * The description is shown verbatim in `tyran --help`; keep it a single,
 * honest sentence that matches the target script's own doc comment.
 */
export const COMMANDS = {
  doctor: [
    'doctor.mjs',
    'Consistency check for a Tyran state directory (.tyran/): drift, stale leases, journal damage, bad config.',
  ],
  'scan-repo': [
    'scan-repo.mjs',
    'Deterministic repo scan for /tyran:setup — establishes what it can, marks what needs confirmation, never guesses.',
  ],
  tiers: [
    'tiers.mjs',
    'Resolve a Tyran role to a model alias via .tyran/config.yaml, the one place model names are allowed to live.',
  ],
  journal: [
    'journal.mjs',
    "Append to, query, and validate a Tyran initiative's append-only journal.",
  ],
  schema: [
    'schema.mjs',
    'Validate .tyran/ config, knowledge, and policy files against their schemas.',
  ],
  knowledge: [
    'knowledge.mjs',
    'Select the knowledge entries that apply to a set of paths and print a paste-ready brief for a handoff.',
  ],
  mistakes: [
    'mistakes.mjs',
    "Append to the repository's MISTAKES.md, count recurring signatures, and promote a recurring one into CLAUDE.md.",
  ],
  overnight: [
    'overnight.mjs',
    'Schedule and run the usage-limit resume watcher: wait for the window reset, then resume the paused session.',
  ],
  statusline: [
    'statusline.mjs',
    'Statusline helper that tees platform rate-limit telemetry into .tyran/state/usage.json for the usage gate.',
  ],
  board: [
    'board.mjs',
    'Render the cross-initiative kanban board — BOARD.md, board.json and the board.html dashboard — from the journals under .tyran/state/.',
  ],
  answer: [
    'answer.mjs',
    'Write the sheet of questions waiting on you, then fold your answers back into the journal.',
  ],
  'stop-check': [
    'stop-check.mjs',
    'Check the .tyran/STOP operator brake that halts a running initiative before its next spawn or merge.',
  ],
  'scan-control-chars': [
    'scan-control-chars.mjs',
    'Refuse raw control and bidi characters in tracked files (the ADR-19 gate).',
  ],
  'desc-budget': [
    'desc-budget.mjs',
    "Sum every skill's description length and fail CI when the total exceeds the context budget.",
  ],
};

/** Absolute, symlink-resolved path; falls back to the merely absolute path
 * when realpath cannot follow it (target unreadable, deleted mid-run). */
function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** scripts/ lives one level up from bin/, in THIS package's real (not
 * symlinked) install location — see the module doc comment above. */
function scriptsDir() {
  const self = realOrSelf(fileURLToPath(import.meta.url));
  return join(dirname(self), '..', 'scripts');
}

function printHelp() {
  const lines = [
    'tyran — command-line scripts for the Tyran task conductor',
    '',
    'This package does NOT install the Claude Code plugin. To install the',
    'plugin, run `/plugin marketplace add jjanczur/tyran` inside Claude Code.',
    '',
    'Usage: tyran <command> [args...]',
    '',
    'Commands:',
  ];
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  for (const [name, [, description]] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(width)}  ${description}`);
  }
  console.log(lines.join('\n'));
}

export function run(argv) {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }

  const entry = COMMANDS[command];
  if (!entry) {
    console.error(`tyran: unknown command '${command}'`);
    console.error(`Known commands: ${Object.keys(COMMANDS).join(', ')}`);
    return 2;
  }

  const [scriptFile] = entry;
  const scriptPath = join(scriptsDir(), scriptFile);
  if (!existsSync(scriptPath)) {
    console.error(`tyran: '${command}' is wired to ${scriptPath}, which does not exist in this install`);
    return 2;
  }

  // No `shell: true`: argv is handed to the child as an array, so nothing in
  // `rest` is re-parsed or re-escaped — it reaches the target script exactly
  // as it reached this process.
  const result = spawnSync(process.execPath, [scriptPath, ...rest], { stdio: 'inherit' });

  if (result.error) {
    console.error(`tyran: failed to run '${command}': ${result.error.message}`);
    return 2;
  }
  if (result.signal) {
    console.error(`tyran: '${command}' terminated by signal ${result.signal}`);
    return 1;
  }
  return result.status ?? 0;
}

/**
 * True when this module is the program's entry point, not merely imported
 * (tests import COMMANDS/run without wanting a live process). Both sides
 * MUST be canonicalized — see the module doc comment and desc-budget.mjs's
 * isMainModule, which this mirrors: comparing raw `process.argv[1]` against
 * a raw `import.meta.url` breaks the moment either path crosses a symlink.
 */
function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  return realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(moduleUrl));
}

if (isMainModule(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
