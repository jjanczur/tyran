/**
 * pricing — the shipped rate card.
 *
 * The risk this file guards is not "a rate is slightly off". It is a rate that
 * is CONFIDENTLY WRONG: a model id that silently fails to normalise and drops
 * its spend into `unpriced`, or a cache multiplier that under-reports the
 * largest line on the page. Both read as a working dashboard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CACHE_MULTIPLIERS,
  LIST_PRICES,
  PLAN_LABELS,
  RATE_CARD_ID,
  SUBSCRIPTION_USD,
  defaultRateCard,
  normalizeModel,
  periodStart,
  planOfTier,
  ratesFor,
} from '../../scripts/pricing.mjs';

/**
 * The published table, transcribed by hand from the pricing page and kept
 * INDEPENDENT of the multiplier arithmetic the module uses. If both sides were
 * derived the same way this test could only prove the code agrees with itself.
 * Columns: base input · 5m write · 1h write · cache hit · output.
 */
const PUBLISHED = Object.freeze({
  'claude-fable-5': [10, 12.5, 20, 1, 50],
  'claude-mythos-5': [10, 12.5, 20, 1, 50],
  'claude-opus-5': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-8': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-7': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-6': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-5': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-1': [15, 18.75, 30, 1.5, 75],
  'claude-opus-4': [15, 18.75, 30, 1.5, 75],
  'claude-sonnet-5': [2, 2.5, 4, 0.2, 10],
  'claude-sonnet-4-6': [3, 3.75, 6, 0.3, 15],
  'claude-sonnet-4-5': [3, 3.75, 6, 0.3, 15],
  'claude-sonnet-4': [3, 3.75, 6, 0.3, 15],
  'claude-haiku-4-5': [1, 1.25, 2, 0.1, 5],
  'claude-haiku-3-5': [0.8, 1, 1.6, 0.08, 4],
});

test('every derived rate equals the published table, to the cent', () => {
  for (const [id, [input, write5m, write1h, read, output]] of Object.entries(PUBLISHED)) {
    const rates = ratesFor(id);
    assert.ok(rates !== null, `${id} must be priced`);
    assert.equal(rates.input, input, `${id} input`);
    assert.equal(rates.cache_write, write5m, `${id} 5m cache write`);
    assert.equal(rates.cache_write_1h, write1h, `${id} 1h cache write`);
    assert.equal(rates.cache_read, read, `${id} cache read`);
    assert.equal(rates.output, output, `${id} output`);
  }
});

test('the table covers every model the page publishes, and invents none', () => {
  // MUTANT: add a model that is not published. A rate nobody can check is
  // indistinguishable from a typo once it is in a total.
  const published = new Set(Object.keys(PUBLISHED).map((id) => normalizeModel(id)));
  assert.deepEqual(new Set(Object.keys(LIST_PRICES)), published);
});

test('a derived rate is never a float artefact', () => {
  // `3 * 0.1` is 0.30000000000000004 in binary floating point. The error could
  // not move an amount, but the rate is PRINTED — and a price that renders as
  // 0.30000000000000004 reads as a bug in the money.
  for (const id of Object.keys(PUBLISHED)) {
    for (const [key, rate] of Object.entries(ratesFor(id))) {
      const decimals = String(rate).includes('.') ? String(rate).split('.')[1].length : 0;
      assert.ok(decimals <= 4, `${id}.${key} = ${rate} has ${decimals} decimals`);
    }
  }
});

test('the multipliers are the published ones, not tuned constants', () => {
  assert.equal(CACHE_MULTIPLIERS.cache_write, 1.25);
  assert.equal(CACHE_MULTIPLIERS.cache_write_1h, 2);
  assert.equal(CACHE_MULTIPLIERS.cache_read, 0.1);
});

test('every model id seen in live transcripts normalises to a real rate', () => {
  // Measured spellings, from 1.8 B tokens of this project's own transcripts.
  // A spelling that fails to normalise does not error — it silently lands in
  // `unpriced`, so the dashboard looks fine and the total is short.
  const seen = {
    'claude-opus-5': 'opus-5',
    'claude-opus-5[1m]': 'opus-5',
    'claude-opus-4-8': 'opus-4-8',
    'claude-fable-5': 'fable-5',
    'claude-sonnet-5': 'sonnet-5',
    'claude-haiku-4-5-20251001': 'haiku-4-5',
    opus: 'opus-5',
    sonnet: 'sonnet-5',
  };
  for (const [id, expected] of Object.entries(seen)) {
    assert.equal(normalizeModel(id), expected, id);
    assert.ok(ratesFor(id) !== null, `${id} must resolve to a rate`);
  }
});

test('the 1M context variant is priced at the standard rate, not guessed at', () => {
  // "Claude 4.6 and later models include the full 1M token context window at
  // standard pricing." So the variant carries no rate information and is
  // normalised away. MUTANT: treat `[1m]` as unknown and Opus spend vanishes
  // into `unpriced` for every long-context session.
  assert.deepEqual(ratesFor('claude-opus-5[1m]'), ratesFor('claude-opus-5'));
});

test('a non-model never resolves to a price', () => {
  // `<synthetic>` appears in live transcripts with zero tokens. Pricing it
  // would invent a row; the empty string and junk must not resolve either.
  for (const id of ['<synthetic>', '', '   ', 'gpt-4', 'claude-nonesuch-9', null, undefined, 42]) {
    assert.equal(normalizeModel(id), null, String(id));
    assert.equal(ratesFor(id), null, String(id));
  }
});

test('defaultRateCard prices only what it was asked about', () => {
  const card = defaultRateCard(['claude-opus-5', '<synthetic>', 'made-up']);
  assert.deepEqual(Object.keys(card), ['claude-opus-5']);
  // Keyed by the id the LEDGER saw, not by the normalised name — the two
  // differ for dated and bracketed spellings, and a table keyed the other way
  // would price nothing at all.
  const dated = defaultRateCard(['claude-haiku-4-5-20251001']);
  assert.deepEqual(Object.keys(dated), ['claude-haiku-4-5-20251001']);
});

test('the rate card has an id, so a stale amount can be identified as stale', () => {
  assert.ok(typeof RATE_CARD_ID === 'string' && RATE_CARD_ID.length > 0);
});

// --- the subscription ------------------------------------------------------

test('the plan is read from the tier string Claude Code actually stores', () => {
  // Measured live: `default_claude_max_20x`.
  assert.equal(planOfTier('default_claude_max_20x'), 'max_20x');
  assert.equal(planOfTier('default_claude_max_5x'), 'max_5x');
  assert.equal(planOfTier('claude_pro'), 'pro');
  // MUTANT: match 5x before 20x with a loose pattern — `max_20x` contains no
  // `max_5x`, but a sloppy `/5x/` would match nothing here while `/max.*x/`
  // would match both. The 5x/20x confusion is a 2x error in the comparison.
  assert.notEqual(planOfTier('default_claude_max_20x'), 'max_5x');
});

test('an unknown, absent or reshaped tier yields null, never a default plan', () => {
  // A guessed plan produces a confident wrong comparison — "you saved 6x" when
  // the operator is on a plan costing five times what was assumed.
  for (const tier of [null, undefined, '', '   ', 'enterprise', 'team_seat', 42, {}]) {
    assert.equal(planOfTier(tier), null, String(tier));
  }
});

test('every plan has both a price and a human label', () => {
  assert.deepEqual(Object.keys(SUBSCRIPTION_USD).sort(), Object.keys(PLAN_LABELS).sort());
  assert.deepEqual(SUBSCRIPTION_USD, { pro: 20, max_5x: 100, max_20x: 200 });
});

// --- the subscription period ------------------------------------------------

test('the period starts on the most recent anniversary at or before today', () => {
  const created = '2026-08-11T04:14:54.939Z';
  // Measured account: created on the 11th, so mid-August is the 11th.
  assert.equal(periodStart(created, '2026-08-17T12:00:00Z'), '2026-08-11');
  // On the anniversary itself the new period has begun.
  assert.equal(periodStart(created, '2026-09-11T00:00:01Z'), '2026-09-11');
  // The day before, the previous period is still running.
  assert.equal(periodStart(created, '2026-09-10T23:59:59Z'), '2026-08-11');
  assert.equal(periodStart(created, '2026-12-31T00:00:00Z'), '2026-12-11');
});

test('a month too short for the anniversary clamps to its last day', () => {
  // MUTANT: let the date roll over. A subscription created on the 31st has no
  // 31st in February; naive maths yields March 3rd, which is in the FUTURE
  // and produces a period that has not started. Billing clamps; so does this.
  const created = '2026-01-31T00:00:00.000Z';
  assert.equal(periodStart(created, '2026-02-28T12:00:00Z'), '2026-02-28');
  // On March 30th the March anniversary (clamped to the 31st) has NOT
  // arrived, so the running period is still February's.
  assert.equal(periodStart(created, '2026-03-30T12:00:00Z'), '2026-02-28');
  assert.equal(periodStart(created, '2026-03-31T12:00:00Z'), '2026-03-31');
  // A leap February takes the 29th.
  assert.equal(periodStart('2024-01-31T00:00:00.000Z', '2024-02-29T12:00:00Z'), '2024-02-29');
});

test('the first period starts when the subscription did, not before it', () => {
  // MUTANT: return the anniversary unconditionally. Two days after signing up
  // on the 20th, the "period" would start on the 20th of a month that ended
  // before the account existed, and the window would sweep in spend from
  // before there was anything to compare against.
  const created = '2026-08-20T10:00:00.000Z';
  assert.equal(periodStart(created, '2026-08-22T10:00:00Z'), '2026-08-20');
  // A `now` before the subscription existed has no period at all.
  assert.equal(periodStart(created, '2026-08-01T10:00:00Z'), null);
});

test('an unparseable date yields null rather than a wrong window', () => {
  assert.equal(periodStart('not a date', '2026-08-17T00:00:00Z'), null);
  assert.equal(periodStart('2026-08-11T00:00:00Z', 'not a date'), null);
  assert.equal(periodStart(null, '2026-08-17T00:00:00Z'), null);
});
