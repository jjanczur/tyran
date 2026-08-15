#!/usr/bin/env node
/**
 * The clickable sandbox board published with the docs.
 *
 * A screenshot cannot be clicked and a GIF cannot be paused, so the docs ship
 * the REAL page — rendered by the same `scripts/board.mjs` an operator runs,
 * from the hand-written journals under `site/sandbox/`. Nothing here reaches
 * into the plugin to change how it renders: whatever ships, ships here.
 *
 * The journals describe TYRAN'S OWN BUILD — the lanes, overnight mode, the
 * Settings tab — because the page is trying to answer two questions at once
 * ("what does this dashboard do" and "what is it like to work this way"), and
 * invented initiatives about someone else's payment system answered only the
 * first. Every finding, error and open question in them is one that actually
 * happened while the thing was built.
 *
 * Two things a static copy has to solve.
 *
 * 1. **Ages.** The strip is aged in the reader's browser against event
 *    timestamps, so a frozen page would say "3000 hours since last signal"
 *    within a few months and read as a graveyard. Every timestamp is
 *    therefore SHIFTED at build time so the newest event lands a few minutes
 *    before the build. The journals keep their real spacing — an agent that
 *    was quiet for 40 minutes still is.
 *
 * 2. **It must not pretend to be live.** The 30-second refresh marker is
 *    stripped, which is all it takes: the page arms its reload timer only if
 *    that marker is present, so a stripped marker means no timer and no
 *    reader snapped back to the first tab mid-click. A banner says what the
 *    page is.
 *
 * Spend ships beside it as a plain `cost.json`, which is exactly the relative
 * path the client already fetches — so the sandbox exercises the same code a
 * served board does rather than a special case. Without it the tab was the
 * one place a reader met an error message instead of a feature.
 *
 * Output: site/public/sandbox/index.html — copied into the built site by
 * Astro, so it must be generated BEFORE `astro build`.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAll, BOARD_HTML_FILE } from '../../scripts/board.mjs';
import { costJson, rollup } from '../../scripts/cost.mjs';
import { readSettings } from '../../scripts/settings.mjs';

/**
 * Spend for the sandbox, built through the REAL rollup.
 *
 * Not a hand-written JSON blob. `rollup()` is the function the board server
 * calls, so the sandbox's Spend tab is laid out by the same code and cannot
 * drift from the schema the page reads — a fabricated payload would go stale
 * the first time a field moved, silently, on the page whose only job is to
 * show what the product looks like.
 *
 * The inputs are invented and say so: the tab is the one place a reader would
 * otherwise see an error instead of a feature, and money on this page is
 * nobody's real money. The rate card is deliberately a made-up label with
 * round numbers, because Tyran does not know what anyone pays and the page
 * should not imply that it does.
 */
const SANDBOX_PRICING = {
  rate_card: 'sample-rates (invented)',
  models: {
    'sample-large': { input: 15, cache_write: 18.75, cache_read: 1.5, output: 75 },
    'sample-small': { input: 1, cache_write: 1.25, cache_read: 0.1, output: 5 },
  },
};

/** One transcript's worth of usage: cache reads dominate, as they do in life. */
const usage = (requests, input, cacheWrite, cacheRead, output) => ({
  requests, input, cache_write: cacheWrite, cache_read: cacheRead, output,
});

const SANDBOX_SOURCES = [
  ['conductor', null, null, 'sample-large', usage(214, 41_000, 96_000, 2_310_000, 38_000)],
  ['agent', 'implementer', 'T-1', 'sample-large', usage(48, 12_000, 31_000, 486_000, 21_000)],
  ['agent', 'reviewer', 'T-1', 'sample-large', usage(31, 9_000, 14_000, 302_000, 8_400)],
  ['agent', 'implementer', 'T-2', 'sample-large', usage(57, 15_500, 28_000, 611_000, 24_800)],
  ['agent', 'implementer', 'T-3', 'sample-small', usage(22, 7_200, 9_100, 188_000, 6_300)],
  ['agent', 'scout', 'T-5', 'sample-small', usage(13, 4_100, 5_200, 96_000, 2_900)],
  ['agent', 'implementer', null, 'sample-small', usage(19, 6_400, 7_800, 141_000, 5_100)],
].map(([kind, agentType, ticket, model, counters], i) => ({
  path: `sandbox/transcript-${i}.jsonl`,
  kind,
  mtime_ms: 0,
  size: 0,
  agent_type: agentType,
  ticket,
  last_ts: null,
  malformed: 0,
  skipped_lines: 0,
  by_model: { [model]: counters },
}));

function sandboxCostJson() {
  const report = rollup(SANDBOX_SOURCES, SANDBOX_PRICING, {});
  report.transcripts_found = true;
  report.session = null;
  report.sources = SANDBOX_SOURCES;
  return costJson(report);
}

/**
 * Settings for the sandbox, read out of the SHIPPED TEMPLATES.
 *
 * Same argument as spend: run the real reader over the real files, so the tab
 * a reader clicks is laid out by the code their own board runs and shows the
 * defaults they will actually get. `writable` is false because a static page
 * has no server behind it — every control renders disabled, and the banner
 * says which flag turns them on, which is exactly the true answer here.
 *
 * The absolute paths `readSettings` reports are replaced with the ones an
 * operator would see: the build machine's temp directory is not a fact about
 * anyone else's repository, and it has no business in a published file.
 */
function sandboxSettingsJson(templatesDir) {
  const work = mkdtempSync(join(tmpdir(), 'tyran-sandbox-settings-'));
  try {
    const tyran = join(work, '.tyran');
    mkdirSync(join(tyran, 'policies'), { recursive: true });
    writeFileSync(join(tyran, 'config.yaml'), readFileSync(join(templatesDir, 'config.yaml'), 'utf8'));
    writeFileSync(join(tyran, 'policies', 'autonomy.yaml'), readFileSync(join(templatesDir, 'policies', 'autonomy.yaml'), 'utf8'));
    const payload = readSettings(tyran);
    payload.files.config.path = join('.tyran', 'config.yaml');
    payload.files.policy.path = join('.tyran', 'policies', 'autonomy.yaml');
    payload.writable = false;
    return JSON.stringify(payload, null, 2) + '\n';
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SANDBOX_SRC = join(HERE, '..', 'sandbox');
const TEMPLATES = join(HERE, '..', '..', 'templates');
const OUT_DIR = join(HERE, '..', 'public', 'sandbox');

/** Newest event lands here, in minutes before the build. */
const FRESHNESS_MINUTES = 6;

/** Every `ts` moved by one constant, so relative spacing is preserved. */
function shiftJournal(text, deltaMs) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const event = JSON.parse(line);
      event.ts = new Date(Date.parse(event.ts) + deltaMs).toISOString();
      return JSON.stringify(event);
    })
    .join('\n') + '\n';
}

function newestTs(files) {
  let max = null;
  for (const text of files.values()) {
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const ts = Date.parse(JSON.parse(line).ts);
      if (max === null || ts > max) max = ts;
    }
  }
  if (max === null) throw new Error('no events in site/sandbox — nothing to render');
  return max;
}

const sources = new Map();
for (const name of readdirSync(SANDBOX_SRC).sort()) {
  if (!name.endsWith('.jsonl')) continue;
  sources.set(name.replace(/\.jsonl$/, ''), readFileSync(join(SANDBOX_SRC, name), 'utf8'));
}

const delta = Date.now() - FRESHNESS_MINUTES * 60_000 - newestTs(sources);
const work = mkdtempSync(join(tmpdir(), 'tyran-sandbox-'));
try {
  for (const [name, text] of sources) {
    const dir = join(work, 'state', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'journal.jsonl'), shiftJournal(text, delta));
  }

  const { files, payload } = renderAll(work);
  let html = files[BOARD_HTML_FILE];

  // Both replacements are asserted rather than assumed: a silent no-op here
  // would publish a page that reloads itself every 30 seconds and claims to
  // be someone's live board.
  const refresh = '<meta name="tyran-refresh" content="30">\n';
  if (!html.includes(refresh)) throw new Error('the refresh tag moved — the sandbox would publish a self-reloading page');
  html = html.replace(refresh, '');

  const anchor = '<main id="app"></main>';
  if (!html.includes(anchor)) throw new Error('the app mount point moved — the banner has nowhere to go');
  // The counts are READ from the payload, never typed. This banner said "two
  // invented initiatives" for one release after a third was added — the one
  // sentence on the page whose whole job is to say what the page is.
  const counts = payload.totals;
  html = html.replace(
    anchor,
    '<div class="sandbox-note">This is a <b>sample board</b> from the Tyran docs, not a live one. ' +
      `Its ${counts.initiatives} initiatives are the ones that built the board you are looking at — the lanes, ` +
      'overnight mode, and the Settings tab — written as journals and rendered by the same code your own ' +
      `board runs. ${counts.agents} agents running, ${payload.asks.length} questions waiting on the operator, ` +
      `${counts.merged} of ${counts.tickets} tickets merged. Click the tabs, filter the lanes, select a card. ` +
      '<a href="../board/">How the board works</a> · ' +
      '<a href="../getting-started/">Install Tyran</a></div>\n' + anchor,
  );
  html = html.replace(
    '</head>',
    '<style>.sandbox-note{max-width:72rem;margin:1rem auto 0;padding:.6rem .9rem;border:1px solid #5d4c22;' +
      'background:#221c11;color:#cfae63;border-radius:.5rem;font:400 .85rem/1.5 ui-sans-serif,system-ui,sans-serif}' +
      '.sandbox-note a{color:#cfae63}</style>\n</head>',
  );

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'index.html'), html);
  // Served as a plain file next to the page, which is exactly the relative
  // path the client already fetches — so the sandbox exercises the same code
  // path a real board does, rather than a special case for the demo.
  writeFileSync(join(OUT_DIR, 'cost.json'), sandboxCostJson());
  writeFileSync(join(OUT_DIR, 'settings.json'), sandboxSettingsJson(TEMPLATES));
  const t = payload.totals;
  console.log(
    `sandbox: ${t.initiatives} initiative(s), ${t.tickets} ticket(s), ${t.agents} agent(s), ` +
      `${payload.asks.length} open question(s) -> ${join(OUT_DIR, 'index.html')}`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
