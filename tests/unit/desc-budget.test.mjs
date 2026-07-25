import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFrontmatterDescription, collectSkillDescriptions } from '../../scripts/desc-budget.mjs';

function fixture(skills) {
  const root = mkdtempSync(join(tmpdir(), 'tyran-descbudget-'));
  for (const [name, content] of Object.entries(skills)) {
    mkdirSync(join(root, 'skills', name), { recursive: true });
    writeFileSync(join(root, 'skills', name, 'SKILL.md'), content);
  }
  return root;
}

test('parses a plain single-line description', () => {
  const md = '---\ndescription: Does a thing well.\n---\nBody';
  assert.equal(parseFrontmatterDescription(md), 'Does a thing well.');
});

test('parses a quoted description', () => {
  const md = '---\ndescription: "Quoted: with punctuation."\n---\n';
  assert.equal(parseFrontmatterDescription(md), 'Quoted: with punctuation.');
});

test('parses a folded multi-line description', () => {
  const md = '---\ndescription: >\n  line one\n  line two\nname: x\n---\n';
  assert.equal(parseFrontmatterDescription(md), 'line one line two');
});

test('returns null when frontmatter or description is absent', () => {
  assert.equal(parseFrontmatterDescription('# no frontmatter'), null);
  assert.equal(parseFrontmatterDescription('---\nname: x\n---\n'), null);
});

test('collects and sorts descriptions across skills, flags missing', () => {
  const root = fixture({
    longest: '---\ndescription: ' + 'a'.repeat(50) + '\n---\n',
    short: '---\ndescription: hi\n---\n',
    broken: '---\nname: broken\n---\n',
  });
  const rows = collectSkillDescriptions(root);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].skill, 'longest');
  assert.equal(rows[0].length, 50);
  assert.equal(rows.find((r) => r.skill === 'broken').missing, true);
});

test('returns empty list when skills/ does not exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'tyran-noskills-'));
  assert.deepEqual(collectSkillDescriptions(root), []);
});
