#!/usr/bin/env node
/**
 * The clickable sandbox board published with the docs.
 *
 * A screenshot cannot be clicked and a GIF cannot be paused, so the docs ship
 * the REAL page — rendered by the same `scripts/board.mjs` an operator runs,
 * from two hand-written journals under `site/sandbox/`. Nothing here reaches
 * into the plugin to change how it renders: whatever ships, ships here.
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
 * 2. **It must not pretend to be live.** The 30-second meta refresh is
 *    stripped (it would also snap a reader back to the first tab mid-click)
 *    and a banner says what the page is. Spend is not served here at all,
 *    and the page says so in its own words rather than showing an error.
 *
 * Output: site/public/sandbox/index.html — copied into the built site by
 * Astro, so it must be generated BEFORE `astro build`.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAll, BOARD_HTML_FILE } from '../../scripts/board.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SANDBOX_SRC = join(HERE, '..', 'sandbox');
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
  const refresh = '<meta http-equiv="refresh" content="30">\n';
  if (!html.includes(refresh)) throw new Error('the refresh tag moved — the sandbox would publish a self-reloading page');
  html = html.replace(refresh, '');

  const anchor = '<main id="app"></main>';
  if (!html.includes(anchor)) throw new Error('the app mount point moved — the banner has nowhere to go');
  html = html.replace(
    anchor,
    '<div class="sandbox-note">This is a <b>sample board</b> from the Tyran docs, not a live one — ' +
      'two invented initiatives, rendered by the same code your own board runs. ' +
      'Click the tabs, filter the lanes, select a card. ' +
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
  const t = payload.totals;
  console.log(
    `sandbox: ${t.initiatives} initiative(s), ${t.tickets} ticket(s), ${t.agents} agent(s), ` +
      `${payload.asks.length} open question(s) -> ${join(OUT_DIR, 'index.html')}`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
