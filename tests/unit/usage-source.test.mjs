/**
 * platform-usage — the fallback that makes overnight mode able to fire at all.
 *
 * The property under test is not "it parses JSON". It is that a STALE reading
 * is used exactly where it is sound and discarded exactly where it is not:
 * usage inside a window only goes up, so an old reading bounds the present
 * from below — but only while that same window is still running.
 *
 * `readConfigUsage`, not `readPlatformUsage`: the latter is the two channels
 * LAYERED, and reaching for it here would read this machine's real transcripts
 * whenever a case expects null — a test that passes because the operator has
 * not hit a limit lately. The layering has its own tests at the bottom, with
 * the second channel injected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readConfigUsage, readPlatformUsage, windowFrom } from '../../scripts/usage-source.mjs';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const iso = (msFromNow) => new Date(NOW + msFromNow).toISOString();

/** A reader returning one fixed body, so nothing touches a real home dir. */
const reading = (doc) => () => JSON.stringify(doc);

const config = (utilization) => ({ oauthAccount: {}, cachedUsageUtilization: { fetchedAtMs: NOW - 83 * 60_000, utilization } });

test('a reading inside its own window is used, however old it is', () => {
  // THE WHOLE POINT. The platform refreshes this cache on its own schedule —
  // measured 83 minutes old during continuous heavy use. Under the gate's
  // ten-minute freshness rule it would be discarded every time and this
  // fallback would fix nothing. It is sound because usage only rises: a
  // reading of 32% taken inside the running window means "at least 32% now".
  const got = readConfigUsage({
    readFile: reading(config({
      five_hour: { utilization: 32, resets_at: iso(90 * 60_000) },
      seven_day: { utilization: 68, resets_at: iso(4 * 86_400_000) },
    })),
    nowMs: NOW,
  });
  assert.equal(got.five_hour.used_percentage, 32);
  assert.equal(got.seven_day.used_percentage, 68);
  assert.equal(got.lower_bound, true, 'the gate must know this is a bound, not a measurement');
  assert.equal(got.source, 'claude.json');
});

test('a reading whose window has already reset is DISCARDED', () => {
  // The check that makes everything above safe. A reading of 95% taken before
  // a reset says nothing about the fresh window after it; acting on it would
  // pause a session that has its full allowance back.
  //
  // MUTANT: drop the reset check and keep the value. An operator who worked
  // hard yesterday is paused this morning for a window that no longer exists.
  const got = readConfigUsage({
    readFile: reading(config({
      five_hour: { utilization: 95, resets_at: iso(-60_000) },
      seven_day: { utilization: 20, resets_at: iso(86_400_000) },
    })),
    nowMs: NOW,
  });
  assert.equal(got.five_hour, undefined, 'the rolled window must not appear');
  assert.equal(got.seven_day.used_percentage, 20, 'the window still running is unaffected');
});

test('every window rolled means no usable reading at all', () => {
  const got = readConfigUsage({
    readFile: reading(config({
      five_hour: { utilization: 95, resets_at: iso(-60_000) },
      seven_day: { utilization: 99, resets_at: iso(-86_400_000) },
    })),
    nowMs: NOW,
  });
  assert.equal(got, null);
});

test('the platform shape is converted to the sidecar shape, not passed through', () => {
  // `cachedUsageUtilization` reports `utilization` (0-100) and an ISO string;
  // the gate reads `used_percentage` and epoch SECONDS. A pass-through would
  // leave every window unreadable and fail open forever — the exact silent
  // shape of the bug this file exists to fix.
  const window = windowFrom({ utilization: 41, resets_at: '2026-08-17T15:30:00.000Z' }, NOW);
  assert.deepEqual(window, {
    used_percentage: 41,
    resets_at: Math.floor(Date.parse('2026-08-17T15:30:00.000Z') / 1000),
  });
  assert.equal(typeof window.resets_at, 'number');
});

test('written_at is NOW, because the bound is a claim about now', () => {
  // MUTANT: stamp the platform's own `fetchedAtMs`. The gate would then apply
  // its ten-minute freshness rule to an 83-minute-old timestamp, discard the
  // document, and reintroduce exactly the bug this fixes.
  const got = readConfigUsage({
    readFile: reading(config({ five_hour: { utilization: 5, resets_at: iso(3600_000) } })),
    nowMs: NOW,
  });
  assert.equal(got.written_at, new Date(NOW).toISOString());
});

test('anything unreadable, absent or misshapen is null, never a throw', () => {
  // This runs inside a PreToolUse hook on every tool call. A throw here stops
  // the repository's work over telemetry that was only being consulted.
  const cases = [
    () => { throw new Error('ENOENT'); },
    () => 'not json at all',
    () => JSON.stringify(null),
    () => JSON.stringify([1, 2, 3]),
    () => JSON.stringify({}),
    () => JSON.stringify({ cachedUsageUtilization: {} }),
    () => JSON.stringify({ cachedUsageUtilization: { utilization: 'lots' } }),
    () => JSON.stringify(config({ five_hour: { utilization: 'high', resets_at: iso(3600_000) } })),
    () => JSON.stringify(config({ five_hour: { utilization: 50, resets_at: 'never' } })),
    () => JSON.stringify(config({ five_hour: { utilization: -1, resets_at: iso(3600_000) } })),
    () => 'x'.repeat(5 * 1024 * 1024),
  ];
  for (const readFile of cases) {
    assert.equal(readConfigUsage({ readFile, nowMs: NOW }), null, String(readFile).slice(0, 60));
  }
});

test('nothing but the two usage windows is read out of that file', () => {
  // It also holds the account uuid, the email address and the organization
  // id. A telemetry fallback is not a reason to move identity around.
  const got = readConfigUsage({
    readFile: reading({
      oauthAccount: { emailAddress: 'someone@example.com', accountUuid: 'secret-uuid', organizationUuid: 'org' },
      cachedUsageUtilization: { utilization: { five_hour: { utilization: 7, resets_at: iso(3600_000) } } },
    }),
    nowMs: NOW,
  });
  const serialised = JSON.stringify(got);
  assert.ok(!serialised.includes('example.com'));
  assert.ok(!serialised.includes('secret-uuid'));
  assert.deepEqual(Object.keys(got).sort(), ['five_hour', 'lower_bound', 'source', 'written_at']);
});

// ------------------------------------------------- the two channels, layered

/** The transcript channel's document: a closed window with an exact reset. */
const wall = (window, resetsMs) => ({
  written_at: new Date(NOW).toISOString(),
  lower_bound: false,
  source: 'transcript',
  session_id: 's'.repeat(12),
  [window]: { used_percentage: 100, resets_at: Math.floor(resetsMs / 1000) },
});

test('the percentage channel wins: it is the only one that can fire EARLY', () => {
  // The ordering IS the design. A percentage below the threshold is a live
  // statement that the window is open; a rejection read out of a transcript is
  // a statement about the past. Consulting the transcript first would let a
  // stale wall outrank a fresh "you have room", and pause a working session.
  //
  // MUTANT: swap the order. The five-hour reading of 12% below is ignored and
  // the run is held until tomorrow morning for a window it never filled.
  const got = readPlatformUsage({
    readFile: reading(config({ five_hour: { utilization: 12, resets_at: iso(3600_000) } })),
    nowMs: NOW,
    readTranscript: () => wall('five_hour', NOW + 3600_000),
  });
  assert.equal(got.source, 'claude.json');
  assert.equal(got.five_hour.used_percentage, 12);
});

test('with no percentage anywhere, the wall in the transcript is the reading', () => {
  // Claude Code 2.1.197, measured: `cachedUsageUtilization` is not a key of
  // that file and the statusline payload carries no `rate_limits`. Without
  // this fallthrough a repo configured to pause has nothing to pause on.
  const got = readPlatformUsage({
    readFile: () => JSON.stringify({ oauthAccount: {} }),
    nowMs: NOW,
    readTranscript: () => wall('seven_day', NOW + 4 * 86_400_000),
  });
  assert.equal(got.source, 'transcript');
  assert.equal(got.seven_day.used_percentage, 100);
});

test('a wall is NOT a lower bound, so the scheduler may resume on it', () => {
  // `markerOf` reads exactly this field to decide whether the figure is good
  // enough to START on. "At least 97%" never is; a window that closed at a
  // known second is, and the resume time comes straight out of it.
  const got = readPlatformUsage({
    readFile: () => 'not json',
    nowMs: NOW,
    readTranscript: () => wall('five_hour', NOW + 1800_000),
  });
  assert.equal(got.lower_bound, false);
});

test('a transcript reader that throws leaves the gate open, never broken', () => {
  // Same contract as the config channel above: this runs inside a PreToolUse
  // hook on every tool call, and a throw stops the repository's work over
  // telemetry it was only consulting.
  assert.equal(
    readPlatformUsage({
      readFile: () => 'not json',
      nowMs: NOW,
      readTranscript: () => {
        throw new Error('unreadable transcript');
      },
    }),
    null,
  );
});
