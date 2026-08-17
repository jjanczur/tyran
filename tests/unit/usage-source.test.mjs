/**
 * platform-usage — the fallback that makes overnight mode able to fire at all.
 *
 * The property under test is not "it parses JSON". It is that a STALE reading
 * is used exactly where it is sound and discarded exactly where it is not:
 * usage inside a window only goes up, so an old reading bounds the present
 * from below — but only while that same window is still running.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readPlatformUsage, windowFrom } from '../../scripts/usage-source.mjs';

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
  const got = readPlatformUsage({
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
  const got = readPlatformUsage({
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
  const got = readPlatformUsage({
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
  const got = readPlatformUsage({
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
    assert.equal(readPlatformUsage({ readFile, nowMs: NOW }), null, String(readFile).slice(0, 60));
  }
});

test('nothing but the two usage windows is read out of that file', () => {
  // It also holds the account uuid, the email address and the organization
  // id. A telemetry fallback is not a reason to move identity around.
  const got = readPlatformUsage({
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
