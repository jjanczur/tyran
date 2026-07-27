/**
 * The README's inventory of what ships, checked against what ships.
 *
 * The README now lists all eight skills by name and states `8 · 4` as a cell
 * in the comparison table. Both are true today. Both are exactly the shape of
 * claim this repository keeps catching after the fact: a value that was
 * measured once, written into prose, and then left alone while the thing it
 * describes moved. Three earlier ones — the doc test counts, the quoted
 * refusal text, the pinned release link — each got a guard only after an
 * audit found the drift.
 *
 * A ninth skill, or a deleted agent, must fail here on the day it lands. The
 * README is the first thing anyone reads, and it is the last thing anyone
 * remembers to update.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

const SKILLS_DIR = join(ROOT, 'skills');
const AGENTS_DIR = join(ROOT, 'agents');

/**
 * A skill is a directory CONTAINING `SKILL.md`.
 *
 * Not "a directory": Claude Code loads a skill by reading that file, so a
 * folder without one is invisible to the platform. Counting it would inflate
 * the number in the one table whose header promises the numbers were measured.
 */
const skills = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(SKILLS_DIR, e.name, 'SKILL.md')))
  .map((e) => e.name)
  .sort();

const agents = readdirSync(AGENTS_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''))
  .sort();

test('every skill that ships is listed in the README, and nothing else is', () => {
  // Anchored on the link target rather than the label: a row could spell the
  // name in prose and link somewhere else entirely, and the link is what a
  // reader actually follows.
  const linked = [...README.matchAll(/\]\(skills\/([a-z0-9-]+)\/SKILL\.md\)/g)].map((m) => m[1]);
  const listed = [...new Set(linked)].sort();

  assert.deepEqual(
    listed,
    skills,
    'the README skill table and skills/ disagree. Whichever moved, the other has to follow — ' +
      'a front page that lists seven of eight skills is worse than one that lists none.',
  );
});

test('every agent that ships is named in the README', () => {
  for (const name of agents) {
    assert.match(
      README,
      new RegExp(`tyran:${name}\\b`),
      `agents/${name}.md ships but the README never names it`,
    );
  }
});

test('the comparison table states the real number of skills and agents', () => {
  // The cell is `8 · 4` in a row of five such cells, so the match is anchored
  // on the row label rather than on the digits — searching the file for `8`
  // would find a footnote, a year, or a viewport width.
  const row = /Skills\s*(?:&middot;|·)\s*agents it ships[^\n]*\n?/.exec(README);
  assert.ok(row, 'the inventory row is gone from the comparison table — if that was deliberate, delete this test in the same change');

  const cells = row[0].split('|').map((c) => c.trim());
  const tyran = cells.find((c) => /^\**\d+\s*(?:&middot;|·)\s*\d+/.test(c));
  assert.ok(tyran, `no count cell found in: ${row[0].trim()}`);

  const [, s, a] = /(\d+)\s*(?:&middot;|·)\s*(\d+)/.exec(tyran);
  assert.equal(Number(s), skills.length, `README says ${s} skills, skills/ has ${skills.length}`);
  assert.equal(Number(a), agents.length, `README says ${a} agents, agents/ has ${agents.length}`);
});
