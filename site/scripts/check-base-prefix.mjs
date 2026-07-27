#!/usr/bin/env node
/**
 * Assert that every root-absolute link and asset in the build carries the
 * site's base prefix.
 *
 * This exists because of the specific way a GitHub Pages project site fails.
 * The site is served from `https://jjanczur.github.io/tyran/`, so every
 * root-absolute URL must begin `/tyran`. Drop `base` from `astro.config.mjs`
 * and the build still succeeds, the dev server still works, `astro preview`
 * still works — and every stylesheet, script and link 404s in production only.
 * There is no local symptom, which is exactly the shape of defect this project
 * says must be measured rather than assumed.
 *
 * Exit: 0 all prefixed - 1 at least one is not - 2 usage/IO error.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(SITE_ROOT, 'dist');
const BASE = '/tyran';

if (!existsSync(DIST)) {
  process.stderr.write(`check-base-prefix: no build at ${DIST} - run \`npm run build\` first\n`);
  process.exit(2);
}

function htmlFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) htmlFiles(p, acc);
    else if (p.endsWith('.html')) acc.push(p);
  }
  return acc;
}

const files = htmlFiles(DIST);
if (files.length === 0) {
  process.stderr.write('check-base-prefix: the build produced no HTML at all\n');
  process.exit(2);
}

let total = 0;
const offenders = [];

for (const file of files) {
  const html = readFileSync(file, 'utf8');
  // Root-absolute only. Protocol-relative (`//host`) is external and
  // deliberately out of scope; page-relative links carry no prefix by
  // construction and resolve against the current URL, which already has one.
  for (const match of html.matchAll(/(?:href|src)="(\/[^/"][^"]*|\/)"/g)) {
    const url = match[1];
    total++;
    if (url !== BASE && !url.startsWith(`${BASE}/`)) {
      offenders.push({ file: file.slice(DIST.length + 1), url });
    }
  }
}

process.stdout.write(
  `check-base-prefix: ${files.length} html files, ${total} root-absolute URLs, ` +
    `${total - offenders.length} carry "${BASE}"\n`,
);

if (offenders.length > 0) {
  process.stderr.write(`check-base-prefix: ${offenders.length} URL(s) MISSING the base prefix:\n`);
  for (const o of offenders.slice(0, 25)) {
    process.stderr.write(`  ${o.file}: ${o.url}\n`);
  }
  if (offenders.length > 25) {
    process.stderr.write(`  ... and ${offenders.length - 25} more\n`);
  }
  process.exit(1);
}

process.stdout.write('check-base-prefix: OK\n');
