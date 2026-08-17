/**
 * pricing — the shipped list-price rate card, and what the subscription costs.
 *
 * Before this file, `pricing:` was hand-authored or absent, and absent was the
 * normal case: a fresh install reported every figure as an em dash, and the
 * whole Spend tab answered "how many tokens" but never "how much". Asking a
 * non-engineer to transcribe fourteen models × four rates into YAML was never
 * going to happen, so the numbers ship.
 *
 * TWO PROPERTIES MAKE THIS SMALL ENOUGH TO KEEP HONEST:
 *
 * 1. **Cache rates are fixed multiples of base input**, published as such:
 *    a 5-minute write is 1.25x, a 1-hour write is 2x, a read is 0.1x. Every
 *    row of the published table satisfies this exactly — checked in the tests,
 *    not assumed — so only `input` and `output` are written down here. Four
 *    numbers per model would be four chances to mistype one.
 * 2. **The 1M context window is standard-priced.** "Claude 4.6 and later
 *    models include the full 1M token context window at standard pricing",
 *    so `claude-opus-5[1m]` is the same rate as `claude-opus-5` and the
 *    context variant can be normalised away rather than modelled.
 *
 * WHAT THIS DELIBERATELY DOES NOT MODEL, because guessing would be worse than
 * an honest gap, and each of these makes the real bill HIGHER than reported:
 *
 * - **Fast mode** (Opus 5 / 4.8) is $10 in / $50 out, double standard. It is
 *   not visible in a transcript, so a fast-mode session is under-reported.
 * - **US-pinned inference** (`inference_geo: "us"`) is a 1.1x multiplier on
 *   every category, also not in a transcript.
 * - **Server-side tool charges** — web search is $10 per 1,000 searches on
 *   top of tokens. The ledger counts tokens, so those are missing.
 * - **The Batch API's 50% discount**, which Claude Code does not use.
 *
 * Every one of those is a modifier on a session shape Claude Code does not
 * normally produce, and naming them here is cheaper than a reader discovering
 * their bill is larger than the board's number and concluding the board lies.
 *
 * Prices change. `RATE_CARD_ID` travels with every amount the ledger prints,
 * so a stale figure is identifiable rather than merely wrong, and an operator
 * who wants different numbers still writes `pricing:` — a config block always
 * wins over these defaults.
 */

/** Published multipliers on the base input rate. Not a guess — the pricing
 *  page states them as the definition of the cache columns. */
export const CACHE_MULTIPLIERS = Object.freeze({
  cache_write: 1.25, // a 5-minute cache write
  cache_write_1h: 2, // a 1-hour cache write
  cache_read: 0.1, // a cache hit or refresh
});

/**
 * The label that travels with every priced amount. Bump it when the numbers
 * below change, so a cached `state/cost.json` from an older card is visibly
 * older rather than silently different.
 */
export const RATE_CARD_ID = 'list-2026-08';

/**
 * Base input and output, $ per million tokens, keyed by NORMALISED model.
 * Retired models are kept: a ledger reads historical transcripts, and dropping
 * a rate would silently move old spend into the unpriced column.
 */
export const LIST_PRICES = Object.freeze({
  'fable-5': { input: 10, output: 50 },
  'mythos-5': { input: 10, output: 50 },
  'opus-5': { input: 5, output: 25 },
  'opus-4-8': { input: 5, output: 25 },
  'opus-4-7': { input: 5, output: 25 },
  'opus-4-6': { input: 5, output: 25 },
  'opus-4-5': { input: 5, output: 25 },
  'opus-4-1': { input: 15, output: 75 },
  'opus-4': { input: 15, output: 75 },
  'sonnet-5': { input: 2, output: 10 },
  'sonnet-4-6': { input: 3, output: 15 },
  'sonnet-4-5': { input: 3, output: 15 },
  'sonnet-4': { input: 3, output: 15 },
  'haiku-4-5': { input: 1, output: 5 },
  'haiku-3-5': { input: 0.8, output: 4 },
});

/**
 * What a bare family name resolves to. The CLI accepts `opus` and resolves it
 * to the current generation; a transcript can carry either spelling, and in
 * measured data the bare form is rare but not zero (12 of 4840 requests).
 * Pricing it as the current generation is what the CLI actually did.
 */
const BARE_ALIASES = Object.freeze({
  opus: 'opus-5',
  sonnet: 'sonnet-5',
  haiku: 'haiku-4-5',
  fable: 'fable-5',
  mythos: 'mythos-5',
});

/**
 * A transcript's `message.model` reduced to a rate-card key.
 *
 * Real values seen in live transcripts, all of which must land somewhere:
 * `claude-opus-5`, `claude-opus-5[1m]`, `claude-opus-4-8`, `claude-fable-5`,
 * `claude-sonnet-5`, `claude-haiku-4-5-20251001`, `opus`, `sonnet`,
 * `<synthetic>`. The last is not a model and must NOT resolve — a synthetic
 * record carries no tokens and pricing it would invent spend.
 */
export function normalizeModel(id) {
  if (typeof id !== 'string') return null;
  let key = id.trim().toLowerCase();
  if (key === '' || key.startsWith('<')) return null;
  // `[1m]` and friends are context-window variants, and long context is
  // standard-priced, so the variant carries no rate information.
  key = key.replace(/\[[^\]]*\]$/, '');
  key = key.replace(/^claude-/, '');
  // A trailing release date (`-20251001`) identifies a snapshot, not a price.
  key = key.replace(/-\d{8}$/, '');
  key = key.replace(/-v\d+$/, '');
  if (Object.prototype.hasOwnProperty.call(BARE_ALIASES, key)) return BARE_ALIASES[key];
  return Object.prototype.hasOwnProperty.call(LIST_PRICES, key) ? key : null;
}

/**
 * The five rates for one model id, or null when it is not a model we price.
 * Null is not zero — the ledger's `unpriced` list depends on that distinction.
 */
export function ratesFor(id) {
  const key = normalizeModel(id);
  if (key === null) return null;
  const { input, output } = LIST_PRICES[key];
  return {
    input,
    cache_write: scaled(input, CACHE_MULTIPLIERS.cache_write),
    cache_write_1h: scaled(input, CACHE_MULTIPLIERS.cache_write_1h),
    cache_read: scaled(input, CACHE_MULTIPLIERS.cache_read),
    output,
  };
}

/**
 * One rate times its multiplier, rounded to the precision the published table
 * actually uses.
 *
 * Binary floating point makes `3 * 0.1` into `0.30000000000000004`, and while
 * the error is ~1e-17 of a dollar and could never move an amount, the number
 * is also PRINTED — in the rate card the board shows and in any config this
 * seeds. A rate that renders as `0.30000000000000004` reads as a bug in the
 * money, which costs more trust than the digits are worth. Six decimal places
 * is exact for every value in the table (the longest is 18.75).
 */
function scaled(base, multiplier) {
  return Math.round(base * multiplier * 1e6) / 1e6;
}

/**
 * A rate table for exactly the model ids observed, so the ledger prices the
 * spellings it actually saw rather than the ones we happened to anticipate.
 * Unknown ids are simply absent, which is what puts them in `unpriced`.
 */
export function defaultRateCard(modelIds) {
  const table = Object.create(null);
  for (const id of modelIds) {
    const rates = ratesFor(id);
    if (rates !== null) table[id] = rates;
  }
  return table;
}

// ------------------------------------------------------------ subscription

/**
 * List price per month, in USD, for the plans Claude Code reports.
 *
 * This is what makes "what would this have cost on the API" mean something:
 * on its own the API-equivalent figure is a number with nothing to compare it
 * to, and a subscriber's real marginal cost per token is zero.
 */
export const SUBSCRIPTION_USD = Object.freeze({
  pro: 20,
  max_5x: 100,
  max_20x: 200,
});

/** How each plan should be named to a human. */
export const PLAN_LABELS = Object.freeze({
  pro: 'Pro',
  max_5x: 'Max 5x',
  max_20x: 'Max 20x',
});

/**
 * The plan, from the tier string Claude Code stores.
 *
 * Measured shape: `oauthAccount.organizationRateLimitTier` reads
 * `default_claude_max_20x`. Matching is deliberately loose about the prefix
 * and strict about the multiplier, because the prefix is the platform's
 * business and the multiplier is the part that changes the price.
 */
/**
 * The start of the subscription period containing `now`, given the day the
 * subscription was created — `YYYY-MM-DD`, or null when it cannot be derived.
 *
 * A plan is billed monthly on its anniversary, so "what have I spent this
 * period" means "since the most recent anniversary at or before today". That
 * is the only window whose comparison against the monthly price needs no
 * arithmetic from the reader.
 *
 * SHORT MONTHS ARE THE WHOLE DIFFICULTY. A subscription created on the 31st
 * has no 31st in February, and naive date maths rolls that into March 3rd —
 * which lands in the FUTURE and produces a period that has not begun. Every
 * overflowing day clamps to the last day of its month instead, which is what
 * billing does. Tested at every boundary, because this is wrong once a year
 * and silently.
 */
export function periodStart(createdAt, now) {
  // Strings only. `new Date(null)` is epoch zero, not an invalid date, so a
  // null subscription date would otherwise produce a confident 1970
  // anniversary and a window sweeping in everything ever recorded.
  if (typeof createdAt !== 'string' || typeof now !== 'string') return null;
  const created = new Date(createdAt);
  const at = new Date(now);
  if (!Number.isFinite(created.getTime()) || !Number.isFinite(at.getTime())) return null;
  if (at < created) return null;

  const anniversary = created.getUTCDate();
  // Candidate: the anniversary within the current month. If that is still in
  // the future, the period began in the previous month.
  let year = at.getUTCFullYear();
  let month = at.getUTCMonth();
  if (clampedDay(year, month, anniversary) > at.getUTCDate()) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  const day = clampedDay(year, month, anniversary);
  const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Never earlier than the subscription itself: the first period starts the
  // day it was created, not on an anniversary that predates it.
  const createdDay = createdAt.slice(0, 10);
  return iso < createdDay ? createdDay : iso;
}

/** `day`, or the last day of that month when the month is too short for it. */
function clampedDay(year, month, day) {
  const lastOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.min(day, lastOfMonth);
}

export function planOfTier(tier) {
  if (typeof tier !== 'string') return null;
  const key = tier.trim().toLowerCase();
  if (key === '') return null;
  if (/max[_-]?20x/.test(key)) return 'max_20x';
  if (/max[_-]?5x/.test(key)) return 'max_5x';
  if (/\bpro\b|_pro$|^pro_/.test(key)) return 'pro';
  return null;
}
