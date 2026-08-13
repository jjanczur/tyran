/**
 * Tests for the usage gate (PreToolUse).
 *
 * Two properties carry the design and both are pinned here: every unknown
 * FAILS OPEN (no telemetry, stale telemetry, malformed config, absent
 * config, supervised operator — none of these may ever produce a false
 * pause), and once the threshold is crossed the wind-down allowlist is a
 * CLOSED set — reads, state writes, the four wind-down scripts, and five git
 * subcommands, nothing else, judged per shell segment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEADLINE_MS,
  MARKER_RELPATH,
  SIDECAR_RELPATH,
  SIDECAR_FRESH_MS,
  allowedDuringWindDown,
  buildRefusal,
  decide,
  markerOf,
  readMarker,
  readSidecar,
  trippedWindow,
} from '../../hooks/scripts/usage-gate.mjs';
import { PASS } from '../../hooks/scripts/hook-io.mjs';
import { limitsOf } from '../../scripts/schema.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'hooks', 'scripts', 'usage-gate.mjs');
const HOOKS_JSON = join(REPO_ROOT, 'hooks', 'hooks.json');

// A fixed clock: 2026-08-13T12:00:00Z. Every timestamp below derives from it.
const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const EPOCH_S = (ms) => Math.floor(ms / 1000);

const LIMITS_PAUSE = limitsOf({ limits: { mode: 'pause' } });

function repo({ config = "limits:\n  mode: 'pause'\n", sidecar = null, marker = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-usage-gate-'));
  mkdirSync(join(dir, '.tyran', 'state'), { recursive: true });
  if (config !== null) {
    writeFileSync(
      join(dir, '.tyran', 'config.yaml'),
      `profile: balanced\nautonomy: P1\ntiers:\n  cheap: a\n  work: b\n  deep: c\n  top: d\n${config}`,
    );
  }
  if (sidecar !== null) writeFileSync(join(dir, SIDECAR_RELPATH), JSON.stringify(sidecar));
  if (marker !== null) writeFileSync(join(dir, MARKER_RELPATH), JSON.stringify(marker));
  return dir;
}

/** A sidecar written `ageMs` before NOW. */
function sidecar({ five = 10, seven = 10, ageMs = 1000, resetInMs = 60 * 60 * 1000 } = {}) {
  return {
    written_at: new Date(NOW - ageMs).toISOString(),
    session_id: 'f9271c9c-e951-47be-af1f-a5742c6df046',
    five_hour: { used_percentage: five, resets_at: EPOCH_S(NOW + resetInMs) },
    seven_day: { used_percentage: seven, resets_at: EPOCH_S(NOW + 60 * 60 * 60 * 1000) },
  };
}

const MAIN_SUPERVISED = { permission_mode: 'default', tool_name: 'Task', tool_input: {} };
const MAIN_AUTONOMOUS = { permission_mode: 'acceptEdits', tool_name: 'Task', tool_input: {}, session_id: 'f9271c9c-e951-47be-af1f-a5742c6df046' };
const SUBAGENT = { agent_id: 'a1b2c3d4', agent_type: 'implementer', tool_name: 'Task', tool_input: {} };

function verdict(dir, input, over = {}) {
  return decide({ cwd: dir, ...input }, { now: () => NOW, locate: () => ({ file: null, init: 'demo' }), ...over });
}

// ------------------------------------------------------------- fails open

test('no .tyran directory: silent pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-usage-none-'));
  assert.equal(decide({ cwd: dir }, { now: () => NOW }), PASS);
});

test('feature off, config absent, and config malformed all pass', () => {
  for (const config of [null, "limits:\n  mode: 'off'\n", 'limits: [broken\n']) {
    const dir = repo({ config, sidecar: sidecar({ five: 99.9 }) });
    assert.equal(verdict(dir, MAIN_AUTONOMOUS), PASS, `config=${JSON.stringify(config)}`);
  }
});

test('no telemetry and STALE telemetry pass — unknown is open, never a false pause', () => {
  assert.equal(verdict(repo(), MAIN_AUTONOMOUS), PASS);
  const stale = repo({ sidecar: sidecar({ five: 99.9, ageMs: SIDECAR_FRESH_MS + 1000 }) });
  assert.equal(verdict(stale, MAIN_AUTONOMOUS), PASS);
});

test('below both thresholds passes; warn mode passes even over threshold', () => {
  assert.equal(verdict(repo({ sidecar: sidecar({ five: 96.9, seven: 90 }) }), MAIN_AUTONOMOUS), PASS);
  const warn = repo({ config: "limits:\n  mode: warn\n", sidecar: sidecar({ five: 99.9 }) });
  assert.equal(verdict(warn, MAIN_AUTONOMOUS), PASS);
});

test('a SUPERVISED operator is never bound, and no marker is written for them', () => {
  const dir = repo({ sidecar: sidecar({ five: 99.9 }) });
  assert.equal(verdict(dir, MAIN_SUPERVISED), PASS);
  assert.equal(existsSync(join(dir, MARKER_RELPATH)), false, 'a marker appeared for a supervised operator');
});

// -------------------------------------------------- threshold and marker

test('an autonomous main loop over the five-hour threshold is denied with the checklist', () => {
  const dir = repo({ sidecar: sidecar({ five: 97.5, resetInMs: 90 * 60 * 1000 }) });
  const v = verdict(dir, MAIN_AUTONOMOUS);
  assert.equal(v.decision, 'deny');
  assert.match(v.reason, /five-hour window/);
  assert.match(v.reason, /Wind down IN THIS ORDER/);
  assert.match(v.reason, /usage-limit-pause/);
  assert.match(v.reason, /overnight\.mjs" schedule/);
  assert.match(v.reason, /f9271c9c-e951-47be-af1f-a5742c6df046/);
  const marker = JSON.parse(readFileSync(join(dir, MARKER_RELPATH), 'utf8'));
  assert.equal(marker.window, 'five_hour');
  assert.equal(marker.long_wait, false, '90 minutes is inside wait_max_hours');
  assert.equal(marker.session_id, 'f9271c9c-e951-47be-af1f-a5742c6df046');
  // resume_at = resets_at + the 5-minute default margin
  assert.equal(Date.parse(marker.resume_at), NOW + 90 * 60 * 1000 + 5 * 60 * 1000);
});

test('the weekly window beyond wait_max_hours is a LONG pause: hold + notify, days named', () => {
  const weekly = {
    written_at: new Date(NOW - 1000).toISOString(),
    seven_day: { used_percentage: 99.2, resets_at: EPOCH_S(NOW + 57 * 60 * 60 * 1000) },
  };
  const dir = repo({ sidecar: weekly });
  const v = verdict(dir, SUBAGENT);
  assert.equal(v.decision, 'deny');
  assert.match(v.reason, /SEVEN-DAY window/);
  assert.match(v.reason, /LONG pause/);
  assert.match(v.reason, /HOLD/);
  assert.match(v.reason, /EVIDENCE: none-required/, 'the subagent variant carries the hatch');
  const marker = JSON.parse(readFileSync(join(dir, MARKER_RELPATH), 'utf8'));
  assert.equal(marker.window, 'seven_day');
  assert.equal(marker.long_wait, true);
  assert.equal(marker.long_wait_policy, 'hold');
});

test('when both windows trip, the weekly one governs — its reset is the binding constraint', () => {
  const tripped = trippedWindow(sidecar({ five: 99, seven: 98 }), LIMITS_PAUSE);
  assert.equal(tripped.window, 'seven_day');
});

test('an ACTIVE marker binds without telemetry — a pause cannot out-wait the sidecar', () => {
  const marker = markerOf(
    { window: 'five_hour', used_percentage: 98, resets_at: EPOCH_S(NOW + 3600 * 1000) },
    LIMITS_PAUSE,
    NOW,
    'f9271c9c-e951-47be-af1f-a5742c6df046',
    'demo',
  );
  const dir = repo({ sidecar: null, marker });
  const v = verdict(dir, MAIN_AUTONOMOUS);
  assert.equal(v.decision, 'deny');
});

test('an EXPIRED marker self-heals: unlinked, and work proceeds', () => {
  const expired = { paused_at: new Date(NOW - 7200e3).toISOString(), window: 'five_hour', resume_at: new Date(NOW - 3600e3).toISOString() };
  const dir = repo({ sidecar: sidecar({ five: 10 }), marker: expired });
  assert.equal(verdict(dir, MAIN_AUTONOMOUS), PASS);
  assert.equal(existsSync(join(dir, MARKER_RELPATH)), false, 'the expired marker survived');
});

test('a marker plus a supervised operator: the human works, the marker stays', () => {
  const marker = markerOf(
    { window: 'seven_day', used_percentage: 99, resets_at: EPOCH_S(NOW + 48 * 3600e3) },
    LIMITS_PAUSE,
    NOW,
    null,
    null,
  );
  const dir = repo({ marker });
  assert.equal(verdict(dir, MAIN_SUPERVISED), PASS);
  assert.equal(existsSync(join(dir, MARKER_RELPATH)), true);
});

test('a garbage marker is treated as absent, not as a verdict', () => {
  const dir = repo({ sidecar: sidecar({ five: 10 }) });
  writeFileSync(join(dir, MARKER_RELPATH), '{not json');
  assert.equal(verdict(dir, MAIN_AUTONOMOUS), PASS);
});

// ------------------------------------------------------------- allowlist

test('reads pass during wind-down; spawns, fetches and MCP tools do not', () => {
  const root = '/repo';
  for (const tool of ['Read', 'Grep', 'Glob', 'NotebookRead', 'TaskOutput']) {
    assert.equal(allowedDuringWindDown(tool, {}, root), true, tool);
  }
  for (const tool of ['Task', 'Agent', 'WebFetch', 'WebSearch', 'mcp__x__y', undefined]) {
    assert.equal(allowedDuringWindDown(tool, {}, root), false, String(tool));
  }
});

test('writes are allowed under .tyran/state/ only, wherever the path spelling starts', () => {
  const root = '/repo';
  assert.equal(allowedDuringWindDown('Write', { file_path: '.tyran/state/demo/NOTES.md' }, root), true);
  assert.equal(allowedDuringWindDown('Edit', { file_path: '/repo/.tyran/state/demo/STATE.md' }, root), true);
  assert.equal(allowedDuringWindDown('Write', { file_path: 'src/app.ts' }, root), false);
  assert.equal(allowedDuringWindDown('Write', { file_path: '/repo/.tyran/config.yaml' }, root), false);
  assert.equal(allowedDuringWindDown('Write', { file_path: '.tyran/state/../../secrets.txt' }, root), false);
  assert.equal(allowedDuringWindDown('Write', {}, root), false);
});

test('Bash allowlist: wind-down scripts and five git subcommands, judged per segment', () => {
  const root = '/repo';
  const ok = [
    'node /abs/path/scripts/journal.mjs append j checkpoint demo --actor conductor',
    'node /abs/path/scripts/project.mjs j --out-dir d',
    'node scripts/overnight.mjs schedule',
    'node scripts/stop-check.mjs',
    'git status',
    'git add .tyran/state/demo/STATE.md && git commit -m "pause"',
    'git diff --stat',
  ];
  for (const cmd of ok) assert.equal(allowedDuringWindDown('Bash', { command: cmd }, root), true, cmd);
  const denied = [
    'git push',
    'git add x && git push',
    'node scripts/scan-repo.mjs --dir .',
    'node .tyran/state/evil.mjs',
    'echo hello',
    'npm test',
    'git add $(rm -rf /)',
    '',
    // Declared floor: the shared lexer splits on { and }, so a ${VAR}
    // spelling can never be read literally — the refusal hands out absolute
    // paths instead, and this row pins that the unreadable form stays denied
    // rather than becoming an accidental hole.
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/journal.mjs" append j checkpoint demo',
  ];
  for (const cmd of denied) assert.equal(allowedDuringWindDown('Bash', { command: cmd }, root), false, cmd || '(empty)');
});

test('the checklist the refusal prints passes the allowlist that printed it', () => {
  const marker = markerOf(
    { window: 'five_hour', used_percentage: 98, resets_at: EPOCH_S(NOW + 3600e3) },
    LIMITS_PAUSE,
    NOW,
    null,
    'demo',
  );
  const dir = repo({ marker });
  const journal = join(dir, '.tyran', 'state', 'demo', 'journal.jsonl');
  // Self-consistency: extract the step-1 command shape from the refusal and
  // run it through the allowlist. A checklist the gate itself refuses is a
  // refusal with no reachable way forward.
  const text = buildRefusal(marker, { subagent: false, waitMaxHours: 5 });
  const step1 = text.split('\n').find((l) => l.trim().startsWith('1.'));
  assert.ok(step1, 'the checklist has a step 1');
  const command = step1.trim().replace(/^1\.\s*/, '').replace('<journal>', journal).replace('<init>', 'demo');
  const allowed = verdict(dir, { ...MAIN_AUTONOMOUS, tool_name: 'Bash', tool_input: { command } });
  assert.equal(allowed, PASS, command);
});

// ------------------------------------------------------------------ wire

test('on the wire: a denial is hookSpecificOutput.permissionDecision deny', () => {
  // The child process reads the REAL clock, so this fixture must be fresh
  // against it — the NOW-anchored fixtures above would be hours stale.
  const liveNow = Date.now();
  const dir = repo({
    sidecar: {
      written_at: new Date(liveNow).toISOString(),
      five_hour: { used_percentage: 99, resets_at: EPOCH_S(liveNow + 3600e3) },
    },
  });
  const input = JSON.stringify({
    hook_event_name: 'PreToolUse',
    cwd: dir,
    permission_mode: 'acceptEdits',
    session_id: 'f9271c9c-e951-47be-af1f-a5742c6df046',
    tool_name: 'Task',
    tool_input: {},
  });
  const raw = execFileSync(process.execPath, [SCRIPT], { input, encoding: 'utf8' });
  const parsed = JSON.parse(raw);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /usage-gate/);
});

test('on the wire: a pass is SILENCE (empty output), and exit 0', () => {
  const dir = repo(); // no telemetry
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: dir, permission_mode: 'acceptEdits', tool_name: 'Task', tool_input: {} });
  const raw = execFileSync(process.execPath, [SCRIPT], { input, encoding: 'utf8' });
  assert.equal(raw.trim() === '' || raw.trim() === '{}', true, `unexpected output: ${raw}`);
});

// ---------------------------------------------------------- registration

test('hooks.json registers the gate: node-prefixed, catch-all matcher, sane timeout', () => {
  const doc = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  const groups = doc.hooks.PreToolUse;
  const entry = groups
    .flatMap((g) => g.hooks.map((h) => ({ matcher: g.matcher, ...h })))
    .find((h) => h.command.includes('usage-gate.mjs'));
  assert.ok(entry, 'usage-gate is not registered under PreToolUse');
  // node-prefixed on purpose: the policy gate (correctly) refuses agent-run
  // chmod on hook paths, so the script ships without an exec bit and the
  // platform dispatches it through node instead.
  assert.match(entry.command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/scripts\/usage-gate\.mjs"$/);
  assert.equal(entry.matcher, '.+|^$');
  assert.equal(typeof entry.timeout, 'number');
  assert.ok(DEADLINE_MS < entry.timeout * 1000, 'the gate deadline must sit below the platform timeout');
});

// ------------------------------------------------------- refusal content

test('the refusal never leaks free sidecar strings — only numbers and the validated id', () => {
  const marker = {
    paused_at: new Date(NOW).toISOString(),
    window: 'five_hour',
    used_percentage: 97.7,
    resets_at: EPOCH_S(NOW + 3600e3),
    resume_at: new Date(NOW + 3600e3).toISOString(),
    long_wait: false,
    long_wait_policy: 'hold',
    session_id: null,
    init: null,
  };
  const text = buildRefusal(marker, { subagent: false, waitMaxHours: 5 });
  assert.match(text, /97\.7/);
  assert.match(text, /<session-id>/, 'a missing session id renders as a placeholder, not undefined');
  assert.doesNotMatch(text, /undefined/);
});

test('readSidecar and readMarker tolerate hostile shapes', () => {
  const dir = repo();
  writeFileSync(join(dir, SIDECAR_RELPATH), JSON.stringify({ written_at: 42, five_hour: 'lots' }));
  assert.equal(readSidecar(dir, NOW), null);
  writeFileSync(join(dir, MARKER_RELPATH), JSON.stringify([1, 2, 3]));
  assert.equal(readMarker(dir, NOW), null);
});
