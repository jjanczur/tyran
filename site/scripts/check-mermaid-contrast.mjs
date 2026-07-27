/**
 * Measure mermaid legibility in BOTH Starlight themes.
 *
 * Not a screenshot eyeball: it reads the COMPUTED colour of the diagram's text
 * and outlines against the computed page background and reports a WCAG
 * contrast ratio. A diagram whose subgraph title is alpha-0 (which is what
 * mermaid emitted before the CSS layer existed) scores 1.00 here and cannot be
 * mistaken for a pass.
 *
 * Prerequisite: a preview server on port 4399.
 *   npm run build && npm run preview -- --port 4399 &
 *   npm run check:contrast
 */
import { chromium } from 'playwright';

const PAGES = [
  ['architecture', 'http://localhost:4399/tyran/architecture/'],
  ['hooks', 'http://localhost:4399/tyran/hooks/'],
  ['journal', 'http://localhost:4399/tyran/journal/'],
];

const parse = (c) => {
  const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
};
const lum = ({ r, g, b }) => {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (fg, bg) => {
  // Composite fg over bg using fg's alpha: an alpha-0 colour becomes the
  // background and scores exactly 1.00, which is the point.
  const c = {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  };
  const [a, b] = [lum(c), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};

const browser = await chromium.launch();
const page = await browser.newPage();
let worst = Infinity;
const rows = [];

for (const theme of ['dark', 'light']) {
  for (const [name, url] of PAGES) {
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    const probes = await page.evaluate(() => {
      const svg = document.querySelector('svg[id^="mermaid-"]');
      if (!svg) return null;
      const bg = getComputedStyle(document.body).backgroundColor;
      const pick = (sel, prop) => {
        const el = svg.querySelector(sel);
        if (!el) return null;
        return getComputedStyle(el)[prop];
      };
      return {
        bg,
        nodeLabel: pick('.nodeLabel', 'color') ?? pick('.label span', 'color'),
        clusterLabel:
          pick('.cluster-label span', 'color') ?? pick('.cluster-label p', 'color'),
        edgeLabel: pick('.edgeLabel p', 'color') ?? pick('.edgeLabel span', 'color'),
        nodeStroke: pick('.node rect, .node path', 'stroke'),
        edgeStroke: pick('.flowchart-link, .edgePath .path', 'stroke'),
      };
    });
    if (!probes) {
      rows.push([theme, name, 'NO MERMAID SVG', '', '']);
      worst = 0;
      continue;
    }
    const bg = parse(probes.bg);
    for (const key of ['nodeLabel', 'clusterLabel', 'edgeLabel', 'nodeStroke', 'edgeStroke']) {
      const v = probes[key];
      if (!v) continue;
      const fg = parse(v);
      if (!fg || !bg) continue;
      const r = ratio(fg, bg);
      worst = Math.min(worst, r);
      rows.push([theme, name, key, v, r.toFixed(2)]);
    }
  }
}

await browser.close();

const w = [7, 13, 14, 30, 6];
const line = (c) => c.map((x, i) => String(x).padEnd(w[i])).join(' ');
console.log(line(['theme', 'page', 'element', 'computed', 'ratio']));
console.log(w.map((n) => '-'.repeat(n)).join(' '));
for (const r of rows) console.log(line(r));

// 3.0:1 is the WCAG AA floor for large text and for non-text graphical objects
// (SC 1.4.11), which is what diagram strokes and 16px+ labels are.
const FLOOR = 3.0;
console.log(`\nWORST CONTRAST: ${worst.toFixed(2)}:1  (floor ${FLOOR}:1)`);
console.log(worst >= FLOOR ? 'PASS' : 'FAIL');
process.exit(worst >= FLOOR ? 0 : 1);
