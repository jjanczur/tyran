/**
 * usage-marker — the pause document has two writers, and they must agree.
 *
 * `hooks/scripts/usage-gate.mjs` writes it when a session is alive to be
 * refused; `overnight.mjs watch-limit` writes it when nothing is alive, which
 * is the case a five-hour wall actually produces. `hooks/**` is KERNEL and
 * cannot be edited from inside a session, so the shape could not be
 * single-sourced — it is pinned EQUAL here instead.
 *
 * This file is the ADR-21 check for that pair. If it fails, the two writers
 * have drifted and the symptom downstream is not an error: it is a scheduler
 * reading a field the other writer stopped emitting, and a pause that never
 * resumes. Fix the drift; do not relax the assertion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { markerOf } from '../../hooks/scripts/usage-gate.mjs';
import { pauseMarker, pauseMarkerFrom, SESSION_ID_RE } from '../../scripts/usage-marker.mjs';
import { SAFE_SESSION_ID_RE } from '../../scripts/usage-transcript.mjs';

const NOW = Date.parse('2026-08-21T19:26:00.000Z');
const RESET = Math.floor(Date.parse('2026-08-21T20:00:00.000Z') / 1000);

const limits = (over = {}) => ({ resume_margin_minutes: 5, wait_max_hours: 5, long_wait: 'hold', ...over });

test('the two writers produce the SAME document, field for field', () => {
  // The matrix covers every branch the function has: a known reset and an
  // unknown one, a bound reading and an exact one, a long wait and a short
  // one, a usable session id and a missing one, both windows, both long-wait
  // policies.
  const tripped = [
    { window: 'five_hour', used_percentage: 100, resets_at: RESET, lower_bound: false },
    { window: 'five_hour', used_percentage: 97.5, resets_at: RESET, lower_bound: true },
    { window: 'seven_day', used_percentage: 100, resets_at: Math.floor(Date.parse('2026-08-28T04:00:00.000Z') / 1000), lower_bound: false },
    { window: 'seven_day', used_percentage: 99, resets_at: null, lower_bound: true },
  ];
  const sessions = ['session-abcdefgh', 'no', null, undefined, 'has spaces in it', 'a'.repeat(200)];
  const configs = [limits(), limits({ long_wait: 'resume' }), limits({ resume_margin_minutes: 30, wait_max_hours: 2 })];

  let compared = 0;
  for (const t of tripped) {
    for (const session of sessions) {
      for (const config of configs) {
        for (const init of ['demo', null, undefined]) {
          assert.deepEqual(
            pauseMarker(t, config, NOW, session, init),
            markerOf(t, config, NOW, session, init),
            `drift at ${JSON.stringify({ t, session, config, init })}`,
          );
          compared += 1;
        }
      }
    }
  }
  assert.ok(compared >= 200, `the matrix must stay wide: compared ${compared}`);
});

test('BOTH writers throw on resets_at: undefined — a shared latent, not a divergence', () => {
  // Found by this matrix. `resets_at !== null` lets `undefined` through, and
  // `undefined * 1000` is NaN, and `new Date(NaN).toISOString()` throws — in
  // the gate's case inside a PreToolUse hook.
  //
  // It is UNREACHABLE: `trippedWindow` is the only producer of this shape and
  // it spells unknown as null. It is recorded here rather than guarded in one
  // writer, because a guard on one side is a silent behavioural difference and
  // this file exists to have none. Fix both on the day `hooks/**` is next
  // edited by hand, and delete this test with the second half of the fix.
  const bad = { window: 'five_hour', used_percentage: 98, resets_at: undefined, lower_bound: false };
  assert.throws(() => markerOf(bad, limits(), NOW, null, null), RangeError);
  assert.throws(() => pauseMarker(bad, limits(), NOW, null, null), RangeError);
});

test('the key ORDER matches too, because the file is compared by eye', () => {
  // `deepEqual` does not see order, and the two markers land in the same file
  // on the same machine on different days. A reordered document reads as a
  // rewritten one to anybody diffing a stall.
  const t = { window: 'five_hour', used_percentage: 100, resets_at: RESET, lower_bound: false };
  assert.deepEqual(Object.keys(pauseMarker(t, limits(), NOW, 'session-abcdefgh', 'demo')), Object.keys(markerOf(t, limits(), NOW, 'session-abcdefgh', 'demo')));
});

test('a wall read from a transcript names its own channel', () => {
  // The gate derives `source` from `lower_bound`, which had only two channels
  // to tell apart. A transcript rejection is neither a bound nor the sidecar,
  // and a marker that claims `sidecar` sends the next person debugging a
  // stall to a file that was never written.
  const t = { window: 'five_hour', used_percentage: 100, resets_at: RESET, lower_bound: false };
  assert.equal(pauseMarker(t, limits(), NOW, 'session-abcdefgh', 'demo').source, 'sidecar');
  assert.equal(pauseMarkerFrom(t, limits(), NOW, 'session-abcdefgh', 'demo', 'transcript').source, 'transcript');
  assert.equal(pauseMarkerFrom(t, limits(), NOW, 'session-abcdefgh', 'demo').source, 'sidecar', 'no claim means the old derivation');
});

test('an unusable session id becomes null rather than an argument', () => {
  // It reaches `claude --resume <id>` as an argv element.
  for (const bad of ['', 'short', 'has spaces', 'a'.repeat(129), null, 42]) {
    assert.equal(pauseMarker({ window: 'five_hour', used_percentage: 100, resets_at: RESET }, limits(), NOW, bad, null).session_id, null, String(bad));
  }
  assert.ok(SESSION_ID_RE.test('0e9ec333-2c45-411d-b221-b4b92a7190a8'));
});

test('the shared pattern admits a leading dash, so a filename never reaches it', () => {
  // MEASURED WHILE WRITING THIS FILE, and stated rather than quietly worked
  // around: `[A-Za-z0-9_-]{8,128}` matches `--dangerous`, so an id of that
  // shape would be handed to `claude --resume` as a FLAG. It has never
  // mattered, because the gate's id comes from the platform's hook payload.
  //
  // It would matter for `watch-limit`, whose id comes from a FILENAME in a
  // directory it walks. `usage-transcript.mjs` therefore refuses a leading
  // dash before the id is ever offered to a marker. This test is the record
  // of why that stricter pattern exists, and it fails if the loose one is
  // ever tightened — at which point the strict one can go.
  assert.ok(SESSION_ID_RE.test('--dangerous'), 'the shared pattern is the loose one');
  assert.ok(!SAFE_SESSION_ID_RE.test('--dangerous'));
  assert.ok(SAFE_SESSION_ID_RE.test('0e9ec333-2c45-411d-b221-b4b92a7190a8'), 'a real session id still passes');
  assert.ok(SAFE_SESSION_ID_RE.test('agent-ac1ada197df0a347a'));
});

test('an unknown reset time still expires on its own', () => {
  // MUTANT: leave resume_at null. Nothing self-heals it, the gate refuses
  // forever, and the repository is bricked until somebody deletes a file they
  // do not know exists.
  const got = pauseMarker({ window: 'five_hour', used_percentage: 100, resets_at: null }, limits(), NOW, null, null);
  assert.equal(got.resume_at, new Date(NOW + 5 * 3600 * 1000).toISOString());
  assert.equal(got.long_wait, false, 'bounded AT wait_max is not beyond it');
});
