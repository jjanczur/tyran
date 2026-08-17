#!/usr/bin/env node
/**
 * stop-check — the operator's brake on a running initiative.
 *
 * Create `.tyran/STOP` (any content; the first line is read back as the
 * reason) and the conductor halts before its next spawn or merge. Delete it
 * and work resumes. The value is that it needs no session: an operator who
 * sees an overnight run going wrong at 3am can stop it from a phone with a
 * one-line commit, and does not have to kill a process and lose the state
 * that would explain what happened.
 *
 * The idea is borrowed from pro-workflow's file kill-switch; the code and the
 * semantics here are our own.
 *
 * WHAT THIS IS NOT: a lock. `.tyran/STOP` is classified KERNEL in the shipped
 * policy, so the write guard refuses an agent that tries to delete it through
 * a writing tool — but the policy gate's own documented limits apply, and a
 * shell command that removes the directory without naming the file is one of
 * them. It stops a loop that is misbehaving. It does not stop one that is
 * trying to escape.
 *
 * CLI:
 *   node stop-check.mjs [--dir <repo>]   # exit 0 clear · 1 stopped · 2 error
 */
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeInvisible } from './invisible.mjs';
import { handleArgs } from './cli-args.mjs';

export const STOP_PATH = join('.tyran', 'STOP');

/** How much of the file is read back. A reason is a sentence, not a payload. */
const REASON_BYTES = 2000;

/**
 * Returns `{stopped, reason, path}`.
 *
 * An unreadable STOP file counts as STOPPED, not as absent. Every other
 * reading in this codebase fails open because a broken gate must not block
 * ordinary work; this one fails CLOSED, because the file's only purpose is
 * to say "do not continue" and the operator who created it is not around to
 * be asked. A brake that releases itself when it is damaged is not a brake.
 */
export function checkStop(repoDir) {
  return checkStopAt(join(repoDir, STOP_PATH));
}

/**
 * The same answer, for a caller that already knows where the file is.
 *
 * The board is given a `--dir` that need not be spelled `.tyran`, so it cannot
 * reconstruct the path by joining a repo root to a constant. A second
 * existsSync-and-read there would be a second spelling of the fail-CLOSED rule
 * below, which is exactly the rule that must not have two spellings.
 */
export function checkStopAt(path) {
  if (!existsSync(path)) return { stopped: false, reason: null, path };
  try {
    if (statSync(path).isDirectory()) {
      return { stopped: true, reason: '(STOP exists but is a directory)', path };
    }
    const first = readFileSync(path, 'utf8').slice(0, REASON_BYTES).split('\n')[0].trim();
    return { stopped: true, reason: first.length > 0 ? first : '(no reason given)', path };
  } catch (error) {
    return { stopped: true, reason: `(STOP exists but could not be read: ${error.code ?? 'unknown'})`, path };
  }
}

export const STOP_CHECK_USAGE =
  'usage: stop-check.mjs [--dir <repo-root>]\n' +
  'Exit: 0 clear · 1 stopped by .tyran/STOP · 2 usage';

function main() {
  const args = process.argv.slice(2);
  if (!handleArgs(args, { name: 'stop-check', usage: STOP_CHECK_USAGE, known: ['dir'] })) return;
  const di = args.indexOf('--dir');
  const dir = resolve(di === -1 ? process.cwd() : (args[di + 1] ?? process.cwd()));

  const { stopped, reason, path } = checkStop(dir);
  if (!stopped) {
    console.log(`stop-check: clear (no ${STOP_PATH})`);
    process.exit(0);
  }
  // The reason is operator-authored text on its way into a terminal that a
  // half-awake reader is scanning; escape it like any other untrusted string.
  console.error(`stop-check: STOPPED by ${escapeInvisible(path)}`);
  console.error(`  reason: ${escapeInvisible(reason)}`);
  process.exit(1);
}

function canonicalPath(path) {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  return canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(moduleUrl));
}

if (isMainModule(import.meta.url)) main();
