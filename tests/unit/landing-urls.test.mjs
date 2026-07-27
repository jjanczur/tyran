/**
 * Links on the landing page that go stale without breaking.
 *
 * The landing shipped pointing at `releases/tag/v0.1.0`. That link is correct
 * on the day it is written and wrong from the next release onward — and it
 * never 404s, so no broken-link check anywhere reports it. Every visitor is
 * quietly sent to an old version.
 *
 * This is the same shape as the stale test counts in the docs and the refusal
 * text copied onto the page: a value that was true once, with nothing
 * watching it. The repo now has three guards of this kind, which is the point
 * — "it was right when I wrote it" is not a property a reader can rely on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LANDING = fileURLToPath(new URL('../../site/src/components/landing/', import.meta.url));
const URLS = join(LANDING, 'urls.ts');

test('the landing links to the LATEST release, not to a pinned tag', () => {
  assert.ok(existsSync(URLS), `${URLS} is gone — if the landing was removed deliberately, delete this test in the same change`);
  const source = readFileSync(URLS, 'utf8');

  // The ASSIGNMENT, not the whole file. Scanning the file caught this test's
  // own documentation, which quotes the anti-pattern in order to explain it —
  // a guard that fires on prose describing the defect is a guard nobody keeps.
  const assignment = /export const RELEASE\s*=\s*([^;\n]+)/.exec(source);
  assert.ok(assignment, 'RELEASE is not exported from urls.ts');
  assert.match(assignment[1], /releases\/latest/, 'RELEASE must resolve to the latest release');
  assert.doesNotMatch(
    assignment[1],
    /releases\/tag\//,
    'a pinned release tag never 404s, so nothing else in this repo would ever report it as wrong',
  );
});

test('no landing component hard-codes a version number into a URL', () => {
  // The constant is only useful if the components go through it. A component
  // that builds its own GitHub URL bypasses the guard above entirely.
  for (const file of readdirSync(LANDING).filter((f) => f.endsWith('.astro'))) {
    const text = readFileSync(join(LANDING, file), 'utf8');
    assert.doesNotMatch(text, /releases\/tag\//, `${file} builds its own release URL instead of using RELEASE`);
  }
});
