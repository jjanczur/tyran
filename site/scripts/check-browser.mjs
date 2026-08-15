/**
 * Browser pass over the built site: navigation, console, links, the enforced
 * dark theme, search, and every custom component's rendered markup.
 *
 * Prerequisite: a preview server on port 4399. Astro 7's `preview` daemonizes
 * itself and returns, so there is no `&` and no job to kill — stop it by name
 * or it outlives the shell that started it.
 *   npm run build
 *   npx astro preview --port 4399
 *   npm run check:browser
 *   npx astro preview stop
 *
 * Not wired into the Pages workflow on purpose: it needs a running server and
 * a browser, and putting a flaky dependency on the DEPLOY path would mean a
 * transient failure blocks publishing docs. It is a local gate, and the
 * non-flaky half of what it proves (the base prefix) IS in CI as
 * `check-base-prefix.mjs`.
 */
import { readdirSync } from 'node:fs';
import { chromium } from 'playwright';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = 'http://localhost:4399/tyran';

// Read from the content directory rather than a list kept here. The list was
// hand-maintained and fell three pages behind — `board`, `overnight` and
// `cost`, which is to say the three newest pages, the ones most likely to
// carry a relative link nobody has clicked. A check whose coverage silently
// shrinks as the thing it checks grows is worse than no check, because it
// still prints OK.
const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'content', 'docs');
const SLUGS = [
  // The landing page is `src/pages/index.astro` — not part of the docs
  // collection, so it is named here and everything else is discovered.
  '',
  ...readdirSync(DOCS_DIR)
    .filter((f) => /\.mdx?$/.test(f))
    .map((f) => f.replace(/\.mdx?$/, ''))
    .sort(),
];

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const consoleErrors = [];
const pageErrors = [];
const badResponses = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`${page.url()} :: ${m.text()}`);
});
page.on('pageerror', (e) => pageErrors.push(`${page.url()} :: ${e.message}`));
page.on('response', (r) => {
  if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
});

let checkedLinks = 0;
const brokenLinks = [];
const seen = new Map();

for (const slug of SLUGS) {
  const url = `${BASE}/${slug}${slug ? '/' : ''}`;
  const resp = await page.goto(url, { waitUntil: 'load' });
  const status = resp?.status() ?? 0;
  const h1 = await page.locator('h1').first().textContent();
  console.log(`${String(status).padEnd(4)} ${url.padEnd(52)} h1="${(h1 ?? '').trim()}"`);
  if (status !== 200) brokenLinks.push(`${status} ${url}`);

  // Every in-page link must resolve. This is where a route-relative
  // `../hooks/` would show up wrong if the base were mishandled.
  //
  // `a[href]`, not a list of containers. The previous selector named
  // Starlight's own two regions, which was exactly right while every page was
  // a Starlight page — and went blind the moment a standalone landing was
  // added outside that chrome, checking 13 of its 24 links and reporting
  // success. A gate scoped to the markup it was written against silently
  // narrows as the site grows, and reports the narrowed number as a pass.
  const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
  for (const href of new Set(hrefs)) {
    if (!href.startsWith('http://localhost:4399')) continue;
    const target = href.split('#')[0];
    if (seen.has(target)) continue;
    const r = await ctx.request.get(target);
    seen.set(target, r.status());
    checkedLinks++;
    if (r.status() !== 200) brokenLinks.push(`${r.status()} ${target}  (linked from ${url})`);
  }
}

// --- component markup actually rendered -----------------------------------
await page.goto(`${BASE}/evidence-gate/`, { waitUntil: 'load' });
const limits = await page.locator('.limit').count();
const measured = await page.locator('.measured').count();

// `<Verdict>` used to sit in every page's status banner, so ANY page proved it
// rendered. The banner is gone and the badge is an EXCEPTION marker now: it
// appears only where something is genuinely not built. `architecture` is where
// that is true (the unregistered `TaskCompleted` row), so this has to look
// there — left on `evidence-gate` it counted zero on a correct site, and the
// separate navigation is what the first attempt at this fix got wrong by
// putting it before the two counts above.
await page.goto(`${BASE}/architecture/`, { waitUntil: 'load' });
const verdicts = await page.locator('.verdict').count();

await page.goto(`${BASE}/hooks/`, { waitUntil: 'load' });
const mermaidOnHooks = await page.locator('svg[id^="mermaid-"]').count();

// --- theme is dark, and there is no way to leave it -------------------------
// This check used to drive the theme select. The site is now dark by decision,
// so the select is GONE — and the old check would fail on a working site while
// passing on a broken one that quietly restored the picker. What replaces it
// asserts the two halves of "enforced": no control renders, and the theme is
// dark even for a visitor whose browser and stored preference both say light.
//
// `starlight-theme=light` is deliberately planted in storage first: a returning
// visitor from before this change carries exactly that key, and a light-themed
// page for them is the regression this line exists to catch.
await page.goto(`${BASE}/architecture/`, { waitUntil: 'load' });
await page.evaluate(() => localStorage.setItem('starlight-theme', 'light'));
await page.reload({ waitUntil: 'load' });
const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
const themePickers = await page.locator('starlight-theme-select, [data-theme-toggle]').count();

// --- search ----------------------------------------------------------------
const searchBtn = page.locator('button[data-open-modal]');
const searchCount = await searchBtn.count();
let searchOpened = false;
if (searchCount > 0) {
  await searchBtn.first().click();
  await page.waitForTimeout(600);
  searchOpened = (await page.locator('dialog[open]').count()) > 0;
}

// --- the footer signature ---------------------------------------------------
//
// LAST, and on the landing page, which is the only page carrying this footer.
//
// The ordering is not cosmetic. This block first sat above the search check
// and broke it: the search assertion runs against whatever page is currently
// loaded, and the landing deliberately renders OUTSIDE Starlight's chrome, so
// it has no search button at all. The suite went red on a working site — the
// same "a check scoped to the markup it was written against" trap this file
// already carries a comment about, walked into from the other direction.
//
// What it proves, neither of which anything else here can see:
//
// 1. The two author links. The crawl above skips every non-localhost href on
//    purpose, so external links are invisible to it — and a wrong external URL
//    never 404s, which is exactly the failure `landing-urls.test.mjs` exists
//    for.
// 2. That the LinkedIn glyph is actually VISIBLE. `Icon.astro` renders marks
//    with `fill="none"` because the rest of that set is stroked; the LinkedIn
//    mark is a solid shape, and without the FILLED branch it renders a 14px
//    square of nothing. Page builds, link works, icon invisible, and no other
//    test would notice. So it is measured rather than eyeballed.
//
//    Both halves are load-bearing, which was verified by breaking it on
//    purpose: with `FILLED` emptied, the computed fill went to `none` and the
//    bounding box STAYED 14x14. An element can be laid out at full size and
//    paint nothing at all, so the box check alone would have passed the exact
//    regression this exists to catch.
await page.goto(`${BASE}/`, { waitUntil: 'load' });

const footerLinks = await page.$$eval('.l-footer__made a[href]', (as) => as.map((a) => a.href));
const expectedAuthorLinks = ['https://janczura.com/', 'https://www.linkedin.com/in/jacekjanczura/'];
const authorLinksOk = expectedAuthorLinks.every((want) =>
  footerLinks.some((href) => href === want || href === want.replace(/\/$/, '')),
);

const li = page.locator('.l-footer__li svg');
const liBox = await li.first().boundingBox().catch(() => null);
const liFill = await li.first().evaluate((el) => getComputedStyle(el).fill).catch(() => 'missing');
const liLabel = await page.locator('.l-footer__li').first().getAttribute('aria-label');
const liVisible = Boolean(liBox && liBox.width > 0 && liBox.height > 0);
const liFilled = liFill !== 'none' && liFill !== 'missing';

await browser.close();

console.log('\n--- results ---');
console.log(`internal links checked : ${checkedLinks}`);
console.log(`broken links           : ${brokenLinks.length}`);
brokenLinks.slice(0, 20).forEach((b) => console.log('   ' + b));
console.log(`HTTP >=400 responses   : ${badResponses.length}`);
badResponses.slice(0, 10).forEach((b) => console.log('   ' + b));
console.log(`console errors         : ${consoleErrors.length}`);
consoleErrors.slice(0, 10).forEach((b) => console.log('   ' + b));
console.log(`uncaught page errors   : ${pageErrors.length}`);
pageErrors.slice(0, 10).forEach((b) => console.log('   ' + b));
console.log(`<Verdict> on architecture  : ${verdicts}`);
console.log(`<Limit>   on evidence-gate : ${limits}`);
console.log(`<Measured> on evidence-gate: ${measured}`);
console.log(`mermaid svg on hooks       : ${mermaidOnHooks}`);
console.log(`theme (stored pref=light)  : ${themeAfter}`);
console.log(`theme pickers rendered     : ${themePickers}`);
console.log(`search dialog opens        : ${searchOpened}`);
console.log(`footer author links        : ${authorLinksOk ? 'both present' : footerLinks.join(' , ') || 'NONE'}`);
console.log(`linkedin glyph box         : ${liBox ? `${Math.round(liBox.width)}x${Math.round(liBox.height)}` : 'NOT RENDERED'}`);
console.log(`linkedin glyph fill        : ${liFill}`);
console.log(`linkedin link aria-label   : ${liLabel ?? 'MISSING'}`);

const ok =
  brokenLinks.length === 0 &&
  badResponses.length === 0 &&
  consoleErrors.length === 0 &&
  pageErrors.length === 0 &&
  verdicts > 0 &&
  limits > 0 &&
  measured > 0 &&
  mermaidOnHooks === 1 &&
  themeAfter === 'dark' &&
  themePickers === 0 &&
  searchOpened &&
  authorLinksOk &&
  liVisible &&
  liFilled &&
  Boolean(liLabel);

console.log(ok ? '\nBROWSER PASS: OK' : '\nBROWSER PASS: FAILED');
process.exit(ok ? 0 : 1);
