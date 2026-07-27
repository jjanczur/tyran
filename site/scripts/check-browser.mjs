/**
 * Browser pass over the built site: navigation, console, links, the enforced
 * dark theme, search, and every custom component's rendered markup.
 *
 * Prerequisite: a preview server on port 4399.
 *   npm run build && npm run preview -- --port 4399 &
 *   npm run check:browser
 *
 * Not wired into the Pages workflow on purpose: it needs a running server and
 * a browser, and putting a flaky dependency on the DEPLOY path would mean a
 * transient failure blocks publishing docs. It is a local gate, and the
 * non-flaky half of what it proves (the base prefix) IS in CI as
 * `check-base-prefix.mjs`.
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:4399/tyran';
const SLUGS = [
  '',
  'getting-started',
  'architecture',
  'configuration',
  'agents',
  'self-improvement',
  'hooks',
  'evidence-gate',
  'policy-gate',
  'journal',
  'projections',
  'doctor',
  'faq',
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
const verdicts = await page.locator('.verdict').count();
const limits = await page.locator('.limit').count();
const measured = await page.locator('.measured').count();

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
console.log(`<Verdict> on evidence-gate : ${verdicts}`);
console.log(`<Limit>   on evidence-gate : ${limits}`);
console.log(`<Measured> on evidence-gate: ${measured}`);
console.log(`mermaid svg on hooks       : ${mermaidOnHooks}`);
console.log(`theme (stored pref=light)  : ${themeAfter}`);
console.log(`theme pickers rendered     : ${themePickers}`);
console.log(`search dialog opens        : ${searchOpened}`);

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
  searchOpened;

console.log(ok ? '\nBROWSER PASS: OK' : '\nBROWSER PASS: FAILED');
process.exit(ok ? 0 : 1);
