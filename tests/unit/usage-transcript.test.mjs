/**
 * usage-transcript — the account wall, read back out of the session transcript.
 *
 * The property under test is not "it finds the string quotaLimits". It is the
 * pair of judgements that make acting on that record safe:
 *
 *   - a rejection whose window has since RESET is history, not a reason to
 *     pause; and
 *   - a rejection that a later real answer contradicts is history too, even
 *     though its `resetsAt` is still ahead.
 *
 * The second one is measured rather than imagined: a `seven_day` rejection on
 * this machine carried a reset five days out and was followed by 565
 * successful assistant messages in the same transcript. A detector without
 * that rule would have paused a working session for five days.
 *
 * The record shapes below are copied from real transcripts, not invented.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CANDIDATE_MAX_AGE_MS,
  MAX_FILES,
  MAX_SESSIONS,
  answeredAt,
  candidates,
  projectSlug,
  readTail,
  readTranscriptRejection,
  rejectionOf,
  scanTail,
  transcriptDirOf,
} from '../../scripts/usage-transcript.mjs';

const NOW = Date.parse('2026-08-21T19:26:00.000Z');
const RESET_5H = Math.floor(Date.parse('2026-08-21T20:00:00.000Z') / 1000);
const RESET_7D = Math.floor(Date.parse('2026-08-28T04:00:00.000Z') / 1000);

/** The wall record, verbatim in shape from `~/.claude/projects/**`. */
const rejection = (window, resetsAt, timestamp) =>
  JSON.stringify({
    type: 'assistant',
    timestamp,
    message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 10pm" }] },
    requestId: 'req_abc',
    quotaLimits: {
      status: 'rejected',
      resetsAt,
      unifiedRateLimitFallbackAvailable: false,
      rateLimitType: window,
      overageStatus: 'rejected',
      overageDisabledReason: 'org_level_disabled',
      isUsingOverage: false,
    },
    isApiErrorMessage: true,
  });

/** A real answer: the one thing that retires a pending rejection. */
const answer = (timestamp, model = 'claude-opus-5') =>
  JSON.stringify({ type: 'assistant', timestamp, message: { model, usage: { input_tokens: 4 }, content: [] } });

const noise = (timestamp) => JSON.stringify({ type: 'user', timestamp, message: { content: 'go on' } });

function fixture(files) {
  const home = mkdtempSync(join(tmpdir(), 'tyran-usage-'));
  const dir = join(home, '.claude', 'projects', projectSlug('/repo'));
  for (const [relative, lines] of Object.entries(files)) {
    const path = join(dir, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, lines.join('\n') + '\n');
  }
  return { home, dir, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// ------------------------------------------------------------- one record

test('the real wall record parses to a window and an exact reset', () => {
  const got = rejectionOf(rejection('five_hour', RESET_5H, '2026-08-21T19:24:59.801Z'), NOW);
  assert.deepEqual(got, { window: 'five_hour', resets_at: RESET_5H, at: '2026-08-21T19:24:59.801Z' });
});

test('a rejection whose window has already reset is history, not a pause', () => {
  // MUTANT: drop the reset comparison. Every past wall in a transcript becomes
  // a live one, and the gate refuses on a window that refilled hours ago.
  const line = rejection('five_hour', RESET_5H, '2026-08-21T19:24:59.801Z');
  assert.equal(rejectionOf(line, RESET_5H * 1000 + 1), null);
  assert.notEqual(rejectionOf(line, RESET_5H * 1000 - 1), null, 'still in force one millisecond before');
});

test('only the two windows the gate has a threshold for are read', () => {
  // The platform may add one. An unknown window has no configured percentage
  // to compare against, so it is not a reading — and it must not throw.
  assert.equal(rejectionOf(rejection('per_minute', RESET_5H, '2026-08-21T19:24:59.801Z'), NOW), null);
});

test('a rejection with no timestamp cannot be placed on the timeline, so it is dropped', () => {
  // It is weighed by ORDERING against the last real answer. Keeping an
  // unorderable record would mean pausing on something that cannot be shown
  // to be current — the failure direction that halts a working session.
  const line = JSON.stringify({ type: 'assistant', quotaLimits: { status: 'rejected', resetsAt: RESET_5H, rateLimitType: 'five_hour' } });
  assert.equal(rejectionOf(line, NOW), null);
});

test('a status other than rejected is not a wall', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-21T19:24:59.801Z',
    quotaLimits: { status: 'allowed', resetsAt: RESET_5H, rateLimitType: 'five_hour' },
  });
  assert.equal(rejectionOf(line, NOW), null);
});

test('every malformed line is null, never a throw', () => {
  // This runs inside a PreToolUse hook on every tool call.
  for (const line of ['', 'not json', '{', '{"quotaLimits":', JSON.stringify({ quotaLimits: null }), JSON.stringify({ quotaLimits: 'rejected' })]) {
    assert.equal(rejectionOf(line, NOW), null, line.slice(0, 20));
  }
});

// ------------------------------------------------------- what counts as an answer

test('a named model answered; everything the platform writes itself did not', () => {
  // MUTANT: accept `<synthetic>`. The wall notice is itself an `assistant`
  // record, so the rejection would clear itself on the line that raised it and
  // this module would never report anything at all.
  assert.equal(answeredAt(answer('2026-08-21T20:30:54.126Z')), '2026-08-21T20:30:54.126Z');
  assert.equal(answeredAt(rejection('five_hour', RESET_5H, '2026-08-21T19:24:59.801Z')), null);
  assert.equal(answeredAt(JSON.stringify({ type: 'assistant', timestamp: 'x', message: { model: '<synthetic>' } })), null);
  assert.equal(answeredAt(noise('2026-08-21T19:30:00.000Z')), null);
});

// ------------------------------------------------------------------ one file

test('both windows are kept, because the weekly one is the binding constraint', () => {
  // Reporting only the newest record would hide a weekly wall behind a
  // five-hour one, and `trippedWindow` would wait out a refill that changes
  // nothing.
  const { rejections } = scanTail(
    [
      rejection('seven_day', RESET_7D, '2026-08-21T18:00:00.000Z'),
      rejection('five_hour', RESET_5H, '2026-08-21T19:24:59.801Z'),
    ].join('\n'),
    NOW,
  );
  assert.equal(rejections.seven_day.resets_at, RESET_7D);
  assert.equal(rejections.five_hour.resets_at, RESET_5H);
});

test('the last real answer is carried out, not applied in place', () => {
  // Applying it here would be wrong across files: the wall lands in a
  // subagent's transcript while the parent session keeps answering in another.
  const got = scanTail([rejection('five_hour', RESET_5H, '2026-08-21T19:24:59.801Z'), answer('2026-08-21T20:30:54.126Z')].join('\n'), NOW);
  assert.equal(got.answered_at, '2026-08-21T20:30:54.126Z');
  assert.equal(got.rejections.five_hour.at, '2026-08-21T19:24:59.801Z');
});

// -------------------------------------------------------------- the tail read

test('a tail read drops the fragment it starts in the middle of', () => {
  // MUTANT: keep it. A fragment that happens to parse is a reading this
  // module INVENTS, which is how a spend reader on this codebase once billed
  // 777 777 tokens to a model that never existed.
  const { home, dir, cleanup } = fixture({ 'session-a.jsonl': [noise('t1'), noise('t2'), noise('t3')] });
  try {
    const whole = readTail(join(dir, 'session-a.jsonl'), 1024 * 1024);
    assert.equal(whole.split('\n').filter(Boolean).length, 3, 'a read that covers the file keeps every line');
    const tail = readTail(join(dir, 'session-a.jsonl'), 40);
    assert.ok(!tail.includes('t1'), 'the straddled first record is gone');
    for (const line of tail.split('\n').filter(Boolean)) JSON.parse(line);
  } finally {
    cleanup();
    assert.ok(home);
  }
});

test('an unreadable transcript is an empty read, never a throw', () => {
  assert.equal(readTail(join(tmpdir(), 'tyran-does-not-exist', 'nope.jsonl')), '');
});

// ------------------------------------------------------- the whole judgement

test('a wall with nothing after it is reported, with the reset the scheduler needs', () => {
  const { home, cleanup } = fixture({
    'session-a.jsonl': [answer('2026-08-21T19:20:00.000Z'), rejection('five_hour', RESET_5H, '2026-08-21T19:24:59.801Z')],
  });
  try {
    const got = readTranscriptRejection({ repoRoot: '/repo', home, nowMs: NOW });
    assert.equal(got.source, 'transcript');
    assert.equal(got.lower_bound, false);
    assert.equal(got.five_hour.used_percentage, 100);
    assert.equal(got.five_hour.resets_at, RESET_5H);
    assert.equal(got.session_id, 'session-a', 'the session that hit the wall is the one to resume');
  } finally {
    cleanup();
  }
});

test('a later real answer retires the wall, even with the reset still ahead', () => {
  // THE MEASURED CASE. A weekly rejection carried a reset five days out and
  // was followed by 565 successful assistant messages. Acting on `resetsAt`
  // alone would have held a working machine until the following Friday.
  //
  // MUTANT: drop the clearing rule. This test is the difference between a
  // pause that saves the night and one that burns it.
  const { home, cleanup } = fixture({
    'session-a.jsonl': [rejection('seven_day', RESET_7D, '2026-08-22T14:26:39.592Z'), answer('2026-08-22T17:07:15.000Z')],
  });
  try {
    assert.equal(readTranscriptRejection({ repoRoot: '/repo', home, nowMs: Date.parse('2026-08-22T19:00:00.000Z') }), null);
  } finally {
    cleanup();
  }
});

test('the wall in a SUBAGENT is found — the seam no hook can see', () => {
  // The limit surfaces inside a subagent's API call, where no PreToolUse hook
  // runs. Its transcript is the only place that record exists.
  const { home, cleanup } = fixture({
    'session-a.jsonl': [answer('2026-08-21T19:20:00.000Z')],
    'session-a/subagents/agent-1.jsonl': [rejection('five_hour', RESET_5H, '2026-08-21T19:24:59.801Z')],
  });
  try {
    const got = readTranscriptRejection({ repoRoot: '/repo', home, nowMs: NOW });
    assert.equal(got.five_hour.resets_at, RESET_5H);
    assert.equal(got.session_id, 'session-a');
  } finally {
    cleanup();
  }
});

test('a parent still answering clears a wall its own agent recorded', () => {
  // ONE timeline across files. Read the agent's transcript alone and the
  // verdict is "walled"; read the parent's alone and it is "fine". Only the
  // reconciliation gets it right, and the direction that matters is this one:
  // the account is demonstrably serving requests.
  const { home, cleanup } = fixture({
    'session-a.jsonl': [answer('2026-08-21T19:40:00.000Z')],
    'session-a/subagents/agent-1.jsonl': [rejection('five_hour', RESET_5H, '2026-08-21T19:24:59.801Z')],
  });
  try {
    assert.equal(readTranscriptRejection({ repoRoot: '/repo', home, nowMs: NOW }), null);
  } finally {
    cleanup();
  }
});

test('with both windows walled, the weekly one names the session to resume', () => {
  const { home, cleanup } = fixture({
    'session-a.jsonl': [rejection('five_hour', RESET_5H, '2026-08-21T19:24:00.000Z'), rejection('seven_day', RESET_7D, '2026-08-21T19:25:00.000Z')],
  });
  try {
    const got = readTranscriptRejection({ repoRoot: '/repo', home, nowMs: NOW });
    assert.equal(got.five_hour.resets_at, RESET_5H);
    assert.equal(got.seven_day.resets_at, RESET_7D);
    assert.equal(got.rejected_at, '2026-08-21T19:25:00.000Z');
  } finally {
    cleanup();
  }
});

test('a repo with no transcripts at all is null, not an error', () => {
  const { home, cleanup } = fixture({ 'session-a.jsonl': [noise('t')] });
  try {
    assert.equal(readTranscriptRejection({ repoRoot: '/somewhere/else', home, nowMs: NOW }), null);
    assert.equal(readTranscriptRejection({ repoRoot: '/repo', home, nowMs: NOW }), null);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------- budget

test('the scan is bounded: stale files are skipped and the count is capped', () => {
  // This runs on every tool call against a directory that holds 88 session
  // transcripts on a real machine. Measured with these bounds: 12 files, 34 ms
  // against the gate's 8-second budget. Without the cap it is an outage.
  const files = {};
  for (let i = 0; i < 40; i += 1) {
    const session = `session-${String(i).padStart(2, '0')}`;
    files[`${session}.jsonl`] = [noise('t')];
    for (let a = 0; a < 6; a += 1) files[`${session}/subagents/agent-${a}.jsonl`] = [noise('t')];
  }
  const { home, dir, cleanup } = fixture(files);
  try {
    // Two bounds, and the test has to see BOTH or a regression in either hides
    // behind the other: 4 sessions × (itself + 6 agents) is 28 candidates
    // before the file cap, which is what MAX_FILES then cuts to 12.
    assert.equal(candidates(dir, { nowMs: Date.now() }).length, MAX_FILES, 'the file cap binds once agents are counted');
    assert.equal(
      candidates(dir, { nowMs: Date.now(), io: { readdir: (d) => (String(d).includes('subagents') ? [] : Object.keys(files).filter((f) => !f.includes('/'))) } }).length,
      MAX_SESSIONS,
      'with no agents anywhere, the session rank is what cuts',
    );
    const ancient = Date.now() + CANDIDATE_MAX_AGE_MS + 60_000;
    assert.equal(candidates(dir, { nowMs: ancient }).length, 0, 'nothing older than a weekly window can hold a live wall');
    assert.ok(home);
  } finally {
    cleanup();
  }
});

test('the platform directory name is one rule, and cost.mjs shares it', () => {
  // Two spellings of a platform convention is ADR-21 in the place it is
  // hardest to notice: nothing fails while they agree.
  assert.equal(projectSlug('/Users/x/vscode/stockbuddy'), '-Users-x-vscode-stockbuddy');
  const { home, dir, cleanup } = fixture({ 'session-a.jsonl': [noise('t')] });
  try {
    assert.equal(transcriptDirOf('/repo', { home }), dir);
    assert.equal(transcriptDirOf('/repo/not-here', { home }), null);
    assert.equal(transcriptDirOf('', { home }), null);
  } finally {
    cleanup();
  }
});
