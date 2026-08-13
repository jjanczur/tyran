/**
 * Tests for the statusline sidecar writer.
 *
 * The property that matters most: this writer is a FILTER. Only finite
 * numbers and a shape-validated session id may reach the sidecar — the
 * usage gate quotes sidecar values into refusal text, so a free string
 * here would be a free string in front of a conductor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SIDECAR_RELPATH, repoRootOf, sidecarOf, statusLineOf, writeSidecar } from '../../scripts/statusline.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/statusline.mjs', import.meta.url));
const NOW_ISO = '2026-08-13T12:00:00.000Z';

function tyranRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-statusline-'));
  mkdirSync(join(dir, '.tyran'), { recursive: true });
  return dir;
}

const payload = (over = {}) => ({
  session_id: 'f9271c9c-e951-47be-af1f-a5742c6df046',
  workspace: { project_dir: '/nowhere' },
  rate_limits: {
    five_hour: { used_percentage: 82.4, resets_at: 1770000000 },
    seven_day: { used_percentage: 41.0, resets_at: 1770400000 },
  },
  ...over,
});

function run(input, args = [], cwd = undefined) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8', cwd });
}

// --------------------------------------------------------------- filtering

test('the sidecar carries numbers and the validated session id — nothing else', () => {
  const doc = sidecarOf(payload({ evil: 'x'.repeat(10), model: { display_name: 'hostile' } }), NOW_ISO);
  assert.deepEqual(Object.keys(doc).sort(), ['five_hour', 'seven_day', 'session_id', 'written_at'].sort());
  assert.deepEqual(doc.five_hour, { used_percentage: 82.4, resets_at: 1770000000 });
  assert.equal(doc.written_at, NOW_ISO);
});

test('a malformed session id is dropped, never copied', () => {
  for (const bad of ['short', 'has spaces here', 'x'.repeat(200), 42, null, 'a;rm -rf /aaaaaa']) {
    const doc = sidecarOf(payload({ session_id: bad }), NOW_ISO);
    assert.equal('session_id' in doc, false, JSON.stringify(bad));
  }
});

test('non-finite and non-numeric usage values are dropped; a payload with no limits is null', () => {
  const doc = sidecarOf(
    payload({ rate_limits: { five_hour: { used_percentage: 'lots', resets_at: Infinity }, seven_day: { used_percentage: 41 } } }),
    NOW_ISO,
  );
  assert.equal(doc.five_hour, undefined);
  assert.deepEqual(doc.seven_day, { used_percentage: 41 });
  assert.equal(sidecarOf({ no: 'limits' }, NOW_ISO), null);
  assert.equal(sidecarOf(null, NOW_ISO), null);
});

// ------------------------------------------------------------------ writes

test('writes atomically into an existing .tyran, and never creates one', () => {
  const repo = tyranRepo();
  assert.equal(writeSidecar(repo, sidecarOf(payload(), NOW_ISO)), true);
  const written = JSON.parse(readFileSync(join(repo, SIDECAR_RELPATH), 'utf8'));
  assert.equal(written.five_hour.used_percentage, 82.4);

  const bare = mkdtempSync(join(tmpdir(), 'tyran-statusline-bare-'));
  assert.equal(writeSidecar(bare, sidecarOf(payload(), NOW_ISO)), false);
  assert.equal(existsSync(join(bare, '.tyran')), false, 'a statusline must not adopt a repo');
});

test('repoRootOf prefers the payload workspace, falls back to cwd', () => {
  const repo = tyranRepo();
  assert.equal(repoRootOf(payload({ workspace: { project_dir: repo } })), repo);
  assert.equal(repoRootOf(payload({ workspace: { project_dir: '/does-not-exist-anywhere' } }), '/fallback'), '/fallback');
});

// --------------------------------------------------------------------- CLI

test('end to end: fresh sidecar written, one status line printed', () => {
  const repo = tyranRepo();
  const out = run(JSON.stringify(payload({ workspace: { project_dir: repo } })));
  assert.match(out, /5h 82%/);
  assert.match(out, /7d 41%/);
  assert.ok(existsSync(join(repo, SIDECAR_RELPATH)));
});

test('--sidecar-only writes the file and prints NOTHING', () => {
  const repo = tyranRepo();
  const out = run(JSON.stringify(payload({ workspace: { project_dir: repo } })), ['--sidecar-only']);
  assert.equal(out, '');
  assert.ok(existsSync(join(repo, SIDECAR_RELPATH)));
});

test('malformed stdin and limitless payloads exit 0 in silence — a statusline must not break the UI', () => {
  assert.equal(run('not json at all'), '');
  assert.equal(run(JSON.stringify({ hello: 1 })), '');
});

test('a hostile invisible-bearing payload never reaches the sidecar bytes', () => {
  const repo = tyranRepo();
  const zwsp = String.fromCodePoint(0x200b);
  run(JSON.stringify(payload({ workspace: { project_dir: repo }, evil: `a${zwsp}b` })));
  const raw = readFileSync(join(repo, SIDECAR_RELPATH), 'utf8');
  assert.ok(!raw.includes(zwsp), 'raw invisible codepoint reached the sidecar');
  assert.ok(!raw.includes('evil'), 'an unknown payload key reached the sidecar');
});
