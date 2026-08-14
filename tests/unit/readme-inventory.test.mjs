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
import { collectSkillDescriptions, DEFAULT_BUDGET } from '../../scripts/desc-budget.mjs';

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
  // Anchored on the first CELL of a table row, not on a link target. The rows
  // used to link to `skills/<name>/SKILL.md` and the guard read the href;
  // those links were removed on purpose — the README now sends a reader to the
  // published page instead of to a raw prompt file — and a guard anchored on
  // a link is a guard that goes quiet the moment the link does.
  const rows = [...README.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
  const listed = [...new Set(rows)].sort();

  assert.deepEqual(
    listed,
    skills,
    'the README skill table and skills/ disagree. Whichever moved, the other has to follow — ' +
      'a front page that lists seven of eight skills is worse than one that lists none.',
  );
  assert.equal(rows.length, skills.length, 'a skill is listed twice in the README table');
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

// The `Skills · agents it ships | 14 · 4` row was a THIRD spelling of a number
// the table below it and the sentence under that already carry, and the guard
// that pinned it was a third guard on the same fact. It was removed with the
// row, on the instruction the guard itself carried, and deliberately not
// replaced: the two that remain — the table names above, the prose words below
// — cover the same claim between them. Three spellings of one answer is the
// defect this repo calls ADR-21, and a test can hold one in place as easily as
// prose can.

/**
 * The same count, spelled as a WORD.
 *
 * The test above anchors on digits, which is the whole reason this one is
 * needed: the README and the two skills pages say "fourteen skills and four
 * agents" in prose, and a digit-anchored guard is blind to every one of them.
 * The count went from eight to fourteen in a single change and those sentences
 * were the last thing anyone thought of — which is the definition of a claim
 * that decays quietly.
 *
 * `roster.ts` solved this properly for the landing badge by counting the
 * filesystem at build time. Prose cannot do that, so it gets a guard instead.
 */
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen', 'twenty'];

const PROSE_PAGES = ['README.md', 'docs/skills.md', 'docs/agents.md', 'site/src/content/docs/skills.mdx', 'site/src/content/docs/agents.mdx'];

/**
 * Two shapes, not every occurrence of a number next to a noun.
 *
 * A blanket `<word> (skills|agents)` match was written first and immediately
 * flagged three sentences that are not inventory claims at all: a narrative
 * "merged two agents that overlapped", a comparison "three times as many
 * skills", and — the instructive one — the footnote's "the ceiling was 4000
 * for the first eight skills", which is a HISTORICAL statement that must stay
 * eight forever. A guard that forces those to track the current count would
 * be corrupting correct prose to satisfy itself.
 *
 * So it matches only the two forms that are claims about what ships today:
 * the paired "N skills and M agents", and the definite "the N skills".
 */
const PAIR = new RegExp(`\\b(${WORDS.join('|')})\\s+skills\\s+and\\s+(${WORDS.join('|')})\\s+agents\\b`, 'gi');
const DEFINITE = new RegExp(`\\bthe\\s+(${WORDS.join('|')})\\s+(skills|agents)\\b`, 'gi');

test('no page spells out a skill or agent count that has gone stale', () => {
  const expected = { skills: WORDS[skills.length], agents: WORDS[agents.length] };
  assert.ok(expected.skills && expected.agents, "the roster outgrew this test's number words — extend WORDS");

  let checked = 0;
  const check = (page, phrase, word, noun) => {
    checked++;
    assert.equal(
      word.toLowerCase(),
      expected[noun],
      `${page} says "${phrase.trim()}" but ${noun}/ has ${noun === 'skills' ? skills.length : agents.length}`,
    );
  };

  for (const page of PROSE_PAGES) {
    const path = join(ROOT, page);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');

    for (const [phrase, s, a] of text.matchAll(PAIR)) {
      check(page, phrase, s, 'skills');
      check(page, phrase, a, 'agents');
    }
    for (const [phrase, word, noun] of text.matchAll(DEFINITE)) {
      check(page, phrase, word, noun.toLowerCase());
    }
  }

  // Guards the guard: a rewrite that drops the phrasing entirely would make
  // every assertion above vacuous, and this test would keep passing green.
  assert.ok(checked > 0, 'no page states a spelled-out count any more — did the phrasing change?');
});

test('the README states the real description budget, and the real total', () => {
  // The footnote quotes both numbers as evidence for the "small curated core"
  // row. A quoted measurement with nothing watching it is the exact failure
  // this file was created for — and this one moved twice in one change.
  const total = collectSkillDescriptions(ROOT).reduce((sum, r) => sum + r.length, 0);
  const quoted = /\((\d[\d,]*) of (\d[\d,]*) characters/.exec(README);
  assert.ok(quoted, 'the footnote no longer quotes the budget — if that was deliberate, delete this test in the same change');

  const num = (s) => Number(s.replace(/,/g, ''));
  assert.equal(num(quoted[1]), total, `README quotes ${quoted[1]} characters of descriptions, desc-budget measures ${total}`);
  assert.equal(num(quoted[2]), DEFAULT_BUDGET, `README quotes a budget of ${quoted[2]}, the script enforces ${DEFAULT_BUDGET}`);
});
