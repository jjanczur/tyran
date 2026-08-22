/**
 * usage-marker — the pause document, and who is allowed to write one.
 *
 * `.tyran/state/paused-until.json` says a run stopped at the subscription wall
 * and when it may start again. Everything downstream reads it: the scheduler
 * arms the resume from `resume_at`, the board's run panel renders it,
 * `session-start` reports it, doctor ages it, and the gate itself self-heals
 * an expired one.
 *
 * IT HAS TWO WRITERS, and that is the fact this module exists for.
 *
 *   - `hooks/scripts/usage-gate.mjs`, when a session is still alive to be
 *     refused. It sees the wall on the next tool call and prints the wind-down.
 *   - `overnight.mjs watch-limit`, when NOTHING is alive. After a five-hour
 *     wall the conductor cannot call the model either, so it cannot write its
 *     own checkpoint, cannot run the wind-down, and cannot arm a resume. That
 *     is the state a real overnight run was found in: walled at 19:25, and
 *     still walled at 20:30 because the reset at 20:00 was nobody's job.
 *
 * WHY THE SHAPE IS SPELLED HERE AND NOT IMPORTED FROM THE GATE. `hooks/**` is
 * KERNEL: it is edited by a human, by hand, outside an agent session, because
 * it is the mechanism every other boundary rests on. A `scripts/` module that
 * imported it would invert the dependency — the hooks import scripts, never
 * the reverse — and would drag the whole gate stack into a background watcher
 * and into the board server.
 *
 * So the document is built here, and `tests/unit/usage-marker.test.mjs` pins
 * this function EQUAL to the gate's `markerOf` across a matrix of inputs. That
 * is ADR-21 satisfied by a mechanical check rather than by single-sourcing,
 * which the KERNEL boundary forbids from inside a session. When the gate is
 * next edited by hand, the body of its `markerOf` should be replaced by a call
 * to this one; the equality test is what makes that a safe edit rather than a
 * hopeful one, and it fails loudly the moment the two drift.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MARKER_RELPATH = join('.tyran', 'state', 'paused-until.json');

export const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * The pause document. Pure: every input is an argument, so two writers with
 * the same reading produce the same file.
 *
 * `tripped` is `{window, used_percentage, resets_at, lower_bound}` — the shape
 * `trippedWindow` returns, whichever telemetry channel produced it.
 */
export function pauseMarker(tripped, limits, nowMs, sessionId, init) {
  // `!== null`, not a truthiness or an `undefined` guard, because the gate's
  // `markerOf` spells it exactly this way and the two are pinned equal. The
  // shape that reaches either — `trippedWindow`'s output — always spells
  // "unknown" as null, so the difference is unreachable rather than tolerated.
  // A caller passing `undefined` would produce `new Date(NaN)` and throw; the
  // equality test records that as a latent both writers share, to be fixed on
  // the same day the KERNEL half can be edited by hand.
  const resetsMs = tripped.resets_at !== null ? tripped.resets_at * 1000 : null;
  // No resets_at from the platform: the window is known-exhausted but the
  // reset time is unknown. A null resume_at would be a marker nothing can
  // self-heal — a permanent false pause — so bound it at wait_max_hours from
  // now instead: the pause still protects the remainder, and the marker
  // expires on its own even if every watcher dies.
  const resumeAtMs =
    resetsMs !== null ? resetsMs + limits.resume_margin_minutes * 60 * 1000 : nowMs + limits.wait_max_hours * 3600 * 1000;
  const waitMs = resumeAtMs - nowMs;
  const longWait = waitMs > limits.wait_max_hours * 3600 * 1000;
  return {
    paused_at: new Date(nowMs).toISOString(),
    window: tripped.window,
    used_percentage: tripped.used_percentage,
    resets_at: tripped.resets_at,
    resume_at: new Date(resumeAtMs).toISOString(),
    long_wait: longWait,
    // What the scheduler should DO about a long wait — copied from config at
    // pause time so the decision is auditable next to its inputs.
    long_wait_policy: limits.long_wait,
    session_id: typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) ? sessionId : null,
    init: init ?? null,
    // WHICH channel said so, and whether the figure was a lower bound. The
    // scheduler must not treat a bound as a measurement when deciding to
    // RESUME: "at least 97%" is a reason to stop and never a reason to start.
    source: tripped.lower_bound === true ? 'claude.json' : 'sidecar',
    lower_bound: tripped.lower_bound === true,
  };
}

/**
 * The same document, with the channel named honestly.
 *
 * The gate's `source` field is derived from `lower_bound` alone, which had
 * only two channels to distinguish. A wall read out of a transcript is not a
 * bound and not the sidecar, and a marker that claims otherwise sends whoever
 * debugs the next stall to the wrong file. Callers that KNOW the channel say
 * so; the two-value derivation stays exactly as it was for callers that do not.
 */
export function pauseMarkerFrom(tripped, limits, nowMs, sessionId, init, source = null) {
  const marker = pauseMarker(tripped, limits, nowMs, sessionId, init);
  return source === null ? marker : { ...marker, source };
}

/** Atomic create-or-replace: temp in the same directory, then rename. */
export function writePauseMarker(repoRoot, marker) {
  const dir = join(repoRoot, '.tyran', 'state');
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.paused-${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(marker, null, 2) + '\n');
  renameSync(temp, join(repoRoot, MARKER_RELPATH));
}
