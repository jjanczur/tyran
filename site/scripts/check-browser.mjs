/**
 * Browser pass over the built site: navigation, console, links, theme toggle,
 * search, and the presence of every custom component's rendered markup.
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
  const hrefs = await page.$$eval('.sl-markdown-content a[href], nav a[href]', (as) =>
    as.map((a) => a.href),
  );
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

// --- theme toggle ----------------------------------------------------------
await page.goto(`${BASE}/architecture/`, { waitUntil: 'load' });
const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
// Starlight renders the theme select twice (desktop header + mobile menu).
// Toggle to `dark`: headless Chromium reports a light colour scheme, so
// selecting `light` would "pass" without the toggle doing anything at all.
const select = page.locator('starlight-theme-select select').first();
await select.selectOption('dark');
await page.waitForTimeout(150);
const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);

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
console.log(`theme toggle               : ${themeBefore} -> ${themeAfter}`);
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
  themeBefore !== themeAfter &&
  themeAfter === 'dark' &&
  searchOpened;

console.log(ok ? '\nBROWSER PASS: OK' : '\nBROWSER PASS: FAILED');
process.exit(ok ? 0 : 1);
