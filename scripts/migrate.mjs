#!/usr/bin/env node
/**
 * migrate — the repairs doctor can only ever REPORT.
 *
 * Every other finding doctor raises comes with a remedy the operator can run.
 * `state-legacy-initiatives-dir` came with a sentence instead: "relocate the
 * contents by hand, one initiative directory at a time". That is not a remedy,
 * it is an instruction to do a careful thing carefully, and the installs that
 * carry the finding are by definition the ones nobody has touched since 0.1.8.
 *
 * ## Why this is a separate script and not part of setup
 *
 * Moving an initiative's authored history is not a step that may happen as a
 * side effect of something else. `scan-repo.mjs` seeds files that do not exist
 * yet; this MOVES files that do, and the difference is the whole of the
 * argument. So it is explicit, never automatic, never invoked by a hook, and
 * it does nothing at all until asked twice — once by running it, once with
 * `--apply`.
 *
 * ## The three rules it does not break
 *
 *  1. **Nothing is ever overwritten.** A destination that already exists is a
 *     CONFLICT: reported, skipped, and left exactly as it was, on both sides.
 *     Merging two directories that share a name is a decision only the
 *     operator can make, and making it silently would destroy the evidence
 *     needed to make it correctly.
 *  2. **Nothing is ever deleted.** The legacy directory is removed only when
 *     it is empty, and only because it then holds nothing to lose. Anything
 *     skipped keeps its home.
 *  3. **Everything is counted and named** (ADR-19 correction 1), including on
 *     a clean run. "Moved 4, skipped 0" and silence are different reports, and
 *     only one of them is evidence.
 *
 * Usage:
 *   node scripts/migrate.mjs [--dir <.tyran>]            # say what WOULD move
 *   node scripts/migrate.mjs [--dir <.tyran>] --apply    # move it
 *
 * Exit: 0 nothing to do or done · 1 conflicts were skipped · 2 usage or I/O.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { escapeInvisible } from './invisible.mjs';

/** The pre-0.1.9 home of the initiative directories. */
export const LEGACY_DIR = 'initiatives';
/** Where they live now. */
export const STATE_DIR = 'state';

const show = (value) => escapeInvisible(String(value));

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What moving this `.tyran` would do, without doing any of it.
 *
 * Pure apart from reading the directory listing, so the dry run and the real
 * run are the SAME computation — a preview produced by different code from the
 * thing it previews is a preview of nothing.
 *
 * Returns `{ moves, conflicts, legacy, present }`, where a move is
 * `{ name, from, to }` and a conflict additionally carries `why`.
 */
export function planMigration(dir) {
  const root = resolve(dir);
  const legacy = join(root, LEGACY_DIR);
  const state = join(root, STATE_DIR);
  if (!isDirectory(legacy)) return { moves: [], conflicts: [], legacy, state, present: false };

  const moves = [];
  const conflicts = [];
  // Sorted, so two runs on one tree report in the same order and a diff of two
  // reports is about the tree rather than about readdir's mood.
  for (const name of readdirSync(legacy).sort()) {
    const from = join(legacy, name);
    const to = join(state, name);
    if (existsSync(to)) {
      conflicts.push({
        name,
        from,
        to,
        why: isDirectory(to)
          ? 'an initiative of this name already lives under state/ — merging them is a decision only you can make'
          : 'a FILE of this name already exists under state/',
      });
      continue;
    }
    moves.push({ name, from, to });
  }
  return { moves, conflicts, legacy, state, present: true };
}

/**
 * Carry out a plan. Idempotent: a second run finds nothing left to move and
 * reports exactly that, which is what makes it safe to re-run after fixing a
 * conflict by hand.
 */
export function applyMigration(plan) {
  const done = [];
  for (const move of plan.moves) {
    mkdirSync(plan.state, { recursive: true });
    // `renameSync` and not a copy: a copy leaves two copies of an append-only
    // journal on disk, and the next writer picks whichever path it was given.
    // Same filesystem is the normal case; EXDEV is reported, not worked around
    // silently, because a cross-device move here means `.tyran/` is stitched
    // together from two mounts and the operator needs to know that.
    renameSync(move.from, move.to);
    done.push(move);
  }
  // Only when empty, and only after the moves: this removes a directory that
  // by construction now holds nothing.
  let removed = false;
  if (plan.present && readdirSync(plan.legacy).length === 0) {
    rmdirSync(plan.legacy);
    removed = true;
  }
  return { done, removed };
}

export function renderPlan(plan, { applied = false, removed = false } = {}) {
  const lines = [];
  if (!plan.present) {
    lines.push(`migrate: no ${LEGACY_DIR}/ under ${show(plan.legacy.replace(/\/[^/]+$/, ''))} — nothing to migrate`);
    return lines.join('\n');
  }
  const verb = applied ? 'moved' : 'would move';
  for (const m of plan.moves) lines.push(`  ${verb}  ${show(m.name)}  ${show(m.from)} -> ${show(m.to)}`);
  for (const c of plan.conflicts) lines.push(`  SKIP   ${show(c.name)}  ${show(c.why)}`);
  lines.push(
    `migrate: ${plan.moves.length} ${applied ? 'moved' : 'to move'}, ${plan.conflicts.length} skipped` +
      (removed ? `, ${LEGACY_DIR}/ removed (it was empty)` : ''),
  );
  if (!applied && plan.moves.length > 0) lines.push('migrate: re-run with --apply to move them');
  if (plan.conflicts.length > 0) {
    lines.push(
      'migrate: a skipped initiative is left untouched on BOTH sides. Merge it by hand, then re-run — ' +
        'this script never overwrites and never deletes.',
    );
  }
  return lines.join('\n');
}

function usage(message) {
  if (message) console.error(`migrate: ${message}`);
  console.error('usage: node scripts/migrate.mjs [--dir <.tyran>] [--apply]');
  process.exit(2);
}

function main(argv) {
  const args = argv.slice(2);
  for (const arg of args) {
    if (!['--dir', '--apply'].includes(arg) && arg.startsWith('--')) usage(`unknown flag ${arg}`);
  }
  const i = args.indexOf('--dir');
  if (i !== -1 && args[i + 1] === undefined) usage('--dir needs a path');
  const dir = i === -1 ? '.tyran' : args[i + 1];
  const apply = args.includes('--apply');

  let plan;
  try {
    plan = planMigration(dir);
  } catch (error) {
    console.error(`migrate: could not read ${show(dir)}: ${error.message}`);
    process.exit(2);
  }
  if (!apply) {
    console.log(renderPlan(plan));
    process.exit(0);
  }
  let result;
  try {
    result = applyMigration(plan);
  } catch (error) {
    console.error(`migrate: ${error.message}`);
    console.error('migrate: nothing after the failure was attempted; re-running is safe.');
    process.exit(2);
  }
  console.log(renderPlan(plan, { applied: true, removed: result.removed }));
  // A conflict is the one outcome that still needs a human, so it is the one
  // that must not exit 0 — an automated caller has to be able to tell "done"
  // from "done except for the part that mattered".
  process.exit(plan.conflicts.length > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
