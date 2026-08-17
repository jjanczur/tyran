/**
 * Tests for the legacy-layout migration.
 *
 * The properties that matter are the three this script promises not to break:
 * nothing is overwritten, nothing is deleted that was not already empty, and
 * every item is counted and named on every run. A migration that gets those
 * wrong destroys an append-only history, which is the one kind of damage this
 * repository cannot undo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEGACY_DIR, STATE_DIR, applyMigration, planMigration, renderPlan } from '../../scripts/migrate.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/migrate.mjs', import.meta.url));

/** A `.tyran` with the given legacy and current initiative directories. */
function tyran({ legacy = {}, state = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-migrate-'));
  for (const [where, entries] of [[LEGACY_DIR, legacy], [STATE_DIR, state]]) {
    for (const [name, files] of Object.entries(entries)) {
      mkdirSync(join(dir, where, name), { recursive: true });
      for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, where, name, file), body);
    }
  }
  return dir;
}

function run(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('a dry run moves NOTHING and says what it would do', () => {
  // MUTANT: make the default apply. This script moves an append-only history;
  // "what would happen" must be reachable without risking it happening.
  const dir = tyran({ legacy: { alpha: { 'PLAN.md': 'p' } } });
  const r = run(['--dir', dir]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /would move\s+alpha/);
  assert.match(r.stdout, /re-run with --apply/);
  assert.ok(existsSync(join(dir, LEGACY_DIR, 'alpha', 'PLAN.md')), 'the dry run must not have moved it');
  assert.ok(!existsSync(join(dir, STATE_DIR, 'alpha')), 'and must not have created the destination');
});

test('--apply moves each initiative and removes the emptied legacy directory', () => {
  const dir = tyran({ legacy: { alpha: { 'PLAN.md': 'a' }, beta: { 'NOTES.md': 'b' } } });
  const r = run(['--dir', dir, '--apply']);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(join(dir, STATE_DIR, 'alpha', 'PLAN.md'), 'utf8'), 'a');
  assert.equal(readFileSync(join(dir, STATE_DIR, 'beta', 'NOTES.md'), 'utf8'), 'b');
  assert.ok(!existsSync(join(dir, LEGACY_DIR)), 'an emptied legacy directory is removed');
  assert.match(r.stdout, /2 moved, 0 skipped/);
});

test('a name that already exists under state/ is a CONFLICT, never a merge', () => {
  // MUTANT: rename over the destination, or merge the two directories. Both
  // sides here are somebody's authored history; picking one is a decision the
  // operator makes, and doing it silently destroys the evidence for it.
  const dir = tyran({
    legacy: { alpha: { 'PLAN.md': 'legacy version' } },
    state: { alpha: { 'PLAN.md': 'current version' } },
  });
  const r = run(['--dir', dir, '--apply']);
  assert.equal(r.code, 1, 'a skipped conflict must not exit 0');
  assert.match(r.stdout, /SKIP\s+alpha/);
  assert.equal(readFileSync(join(dir, STATE_DIR, 'alpha', 'PLAN.md'), 'utf8'), 'current version', 'destination untouched');
  assert.equal(readFileSync(join(dir, LEGACY_DIR, 'alpha', 'PLAN.md'), 'utf8'), 'legacy version', 'source untouched');
  assert.ok(existsSync(join(dir, LEGACY_DIR)), 'a legacy dir that still holds something is never removed');
});

test('a conflict does not stop the initiatives that CAN move', () => {
  // Partial progress beats all-or-nothing here: the operator fixes one name by
  // hand and re-runs, rather than being blocked on the whole set by one clash.
  const dir = tyran({ legacy: { alpha: { 'a.md': '1' }, beta: { 'b.md': '2' } }, state: { alpha: { 'a.md': 'keep' } } });
  const r = run(['--dir', dir, '--apply']);
  assert.equal(r.code, 1);
  assert.ok(existsSync(join(dir, STATE_DIR, 'beta', 'b.md')), 'beta had no conflict and must have moved');
  assert.equal(readFileSync(join(dir, STATE_DIR, 'alpha', 'a.md'), 'utf8'), 'keep');
  assert.match(r.stdout, /1 moved, 1 skipped/);
});

test('running it twice is a no-op the second time', () => {
  // MUTANT: anything that is not idempotent. This is the property that makes
  // it safe to re-run after fixing a conflict by hand.
  const dir = tyran({ legacy: { alpha: { 'PLAN.md': 'a' } } });
  assert.equal(run(['--dir', dir, '--apply']).code, 0);
  const second = run(['--dir', dir, '--apply']);
  assert.equal(second.code, 0);
  assert.match(second.stdout, /nothing to migrate/);
  assert.equal(readFileSync(join(dir, STATE_DIR, 'alpha', 'PLAN.md'), 'utf8'), 'a');
});

test('a repo with no legacy directory says so rather than saying nothing', () => {
  // ADR-19 correction 1: a clean run is a REPORT, not silence. "It did nothing
  // because there is nothing to do" and "it did nothing" must not look alike.
  const dir = tyran({ state: { alpha: { 'PLAN.md': 'a' } } });
  const r = run(['--dir', dir]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /nothing to migrate/);
});

test('the preview and the move are the same computation', () => {
  // MUTANT: compute the plan differently in the two paths. A preview produced
  // by different code from the thing it previews is a preview of nothing.
  const dir = tyran({ legacy: { alpha: { 'a.md': '1' }, beta: { 'b.md': '2' } }, state: { alpha: {} } });
  const plan = planMigration(dir);
  assert.deepEqual(plan.moves.map((m) => m.name), ['beta']);
  assert.deepEqual(plan.conflicts.map((c) => c.name), ['alpha']);
  const applied = applyMigration(plan);
  assert.deepEqual(applied.done.map((m) => m.name), ['beta']);
  assert.equal(applied.removed, false, 'alpha is still there, so the directory stays');
  assert.match(renderPlan(plan, { applied: true }), /1 moved, 1 skipped/);
});

test('an unknown flag is a usage error, not a silent full run', () => {
  const dir = tyran({ legacy: { alpha: { 'a.md': '1' } } });
  const r = run(['--dir', dir, '--force']);
  assert.equal(r.code, 2);
  assert.ok(existsSync(join(dir, LEGACY_DIR, 'alpha')), 'a rejected invocation moves nothing');
});
