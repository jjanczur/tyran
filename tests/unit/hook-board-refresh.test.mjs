/**
 * Tests for the board-refresh probe.
 *
 * A probe's one guarantee is that it cannot hurt anything: every failure is
 * silence and exit 0, and a corrupt journal never clobbers good files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEADLINE_MS, refresh } from '../../hooks/scripts/board-refresh.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'hooks', 'scripts', 'board-refresh.mjs');
const HOOKS_JSON = join(REPO_ROOT, 'hooks', 'hooks.json');
const FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'journal-demo.jsonl');

function repo(journal = readFileSync(FIXTURE, 'utf8')) {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-board-refresh-'));
  mkdirSync(join(dir, '.tyran', 'state', 'demo'), { recursive: true });
  writeFileSync(join(dir, '.tyran', 'state', 'demo', 'journal.jsonl'), journal);
  return dir;
}

test('a healthy journal gets its four projections and the cross board rendered', async () => {
  const dir = repo();
  await refresh({ cwd: dir });
  for (const name of ['STATE.md', 'PROGRESS.md', 'BOARD.md', 'board.json']) {
    assert.ok(existsSync(join(dir, '.tyran', 'state', 'demo', name)), `per-initiative ${name}`);
  }
  for (const name of ['BOARD.md', 'board.json', 'board.html']) {
    assert.ok(existsSync(join(dir, '.tyran', 'state', name)), `cross ${name}`);
  }
});

test('a corrupt journal is silence — and existing good files are not clobbered', async () => {
  const dir = repo();
  await refresh({ cwd: dir }); // healthy render first
  const goodBoard = readFileSync(join(dir, '.tyran', 'state', 'demo', 'BOARD.md'), 'utf8');
  writeFileSync(join(dir, '.tyran', 'state', 'demo', 'journal.jsonl'), '{ corrupt\nnot json\n');
  await refresh({ cwd: dir });
  const after = readFileSync(join(dir, '.tyran', 'state', 'demo', 'BOARD.md'), 'utf8');
  // A journal with zero readable events and damage is refused by projectFile;
  // the probe swallows that per initiative and the good bytes stay.
  assert.equal(after, goodBoard);
});

test('not a Tyran repo: nothing written, nothing thrown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-board-refresh-none-'));
  await refresh({ cwd: dir });
  assert.equal(existsSync(join(dir, '.tyran')), false);
});

test('on the wire: exit 0 and no refusal, even on garbage stdin', () => {
  const raw = execFileSync(process.execPath, [SCRIPT], { input: 'not json', encoding: 'utf8' });
  assert.equal(raw.trim() === '' || raw.trim() === '{}', true, raw);
});

test('hooks.json registers the probe node-dispatched under SubagentStop with a sane timeout', () => {
  const doc = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  const entry = doc.hooks.SubagentStop.flatMap((g) => g.hooks.map((h) => ({ matcher: g.matcher, ...h }))).find((h) =>
    h.command.includes('board-refresh.mjs'),
  );
  assert.ok(entry, 'board-refresh is not registered');
  assert.match(entry.command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/scripts\/board-refresh\.mjs"$/);
  assert.ok(DEADLINE_MS < entry.timeout * 1000);
});
