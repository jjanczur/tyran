/**
 * The shipped roster, checked for the two things that fail QUIETLY.
 *
 * 1. Malformed frontmatter. The platform's own validator says it out loud:
 *    an agent whose YAML fails to parse "loads with empty metadata (all
 *    frontmatter fields silently dropped)". No error at runtime, no warning —
 *    the reviewer would simply arrive holding every tool it was supposed not
 *    to have. This happened once here, caused by a colon inside an unquoted
 *    scalar, and CI caught it only because `claude plugin validate` runs.
 *    These tests catch it without needing the CLI.
 *
 * 2. A model name leaking into a prompt file. The whole cost design rests on
 *    model names living in exactly ONE file. Nothing enforces that except
 *    this test, and the day it stops being true is the day a deprecation
 *    turns from a one-line edit into a hunt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AGENTS_DIR = join(ROOT, 'agents');
const SKILLS_DIR = join(ROOT, 'skills');

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

/** Minimal frontmatter reader: the delimited block, parsed as `key: value`. */
function frontmatter(markdown) {
  const lines = markdown.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return null;
  const out = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!m) return { __malformed: line };
    out[m[1]] = m[2];
  }
  return out;
}

/**
 * A plain YAML scalar may not contain ": " — that is the exact shape that
 * made the platform drop a whole frontmatter block. Quoted values are fine.
 */
function hasBareColon(value) {
  const trimmed = value.trim();
  if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) return false;
  return /:\s/.test(trimmed);
}

const agentFiles = existsSync(AGENTS_DIR) ? readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')) : [];

test('the roster is not empty — the README claims four agents ship', () => {
  assert.deepEqual(agentFiles.sort(), ['implementer.md', 'retro.md', 'reviewer.md', 'scout.md']);
});

test('every agent has frontmatter that parses, with a name and a description', () => {
  for (const file of agentFiles) {
    const fm = frontmatter(readFileSync(join(AGENTS_DIR, file), 'utf8'));
    assert.ok(fm !== null, `${file}: no frontmatter block at all`);
    assert.ok(!fm.__malformed, `${file}: unparseable frontmatter line: ${fm.__malformed}`);
    assert.ok(fm.name?.length > 0, `${file}: missing name`);
    assert.ok(fm.description?.length > 0, `${file}: missing description`);
    assert.equal(fm.name, file.replace(/\.md$/, ''), `${file}: name must match the filename`);
  }
});

test('no frontmatter value contains a bare colon — the shape that silently voids the block', () => {
  // The shipped shim is included: it is copied verbatim into a user's repo by
  // /tyran:setup, so a malformed block there breaks THEIR /tyran, silently,
  // in a file they did not write.
  const targets = [
    ...agentFiles.map((f) => ['agents/' + f, join(AGENTS_DIR, f)]),
    ...readdirSync(SKILLS_DIR)
      .filter((d) => existsSync(join(SKILLS_DIR, d, 'SKILL.md')))
      .map((d) => ['skills/' + d, join(SKILLS_DIR, d, 'SKILL.md')]),
    ['templates/project-command', join(ROOT, 'templates', 'project-command', 'SKILL.md')],
  ];
  for (const [label, path] of targets) {
    const fm = frontmatter(readFileSync(path, 'utf8'));
    for (const [key, value] of Object.entries(fm ?? {})) {
      if (key === '__malformed') continue;
      assert.ok(!hasBareColon(value), `${label}: "${key}" contains ": " unquoted — the platform drops the whole block`);
    }
  }
});

test('the reviewer is granted no editing tools', () => {
  // A reviewer that can fix what it found ends up approving its own patch.
  // Not airtight — Bash can write — but the grant must not quietly widen.
  const fm = frontmatter(readFileSync(join(AGENTS_DIR, 'reviewer.md'), 'utf8'));
  assert.ok(fm.tools, 'reviewer must declare an explicit tool list, not inherit everything');
  const granted = fm.tools.split(',').map((t) => t.trim());
  for (const tool of EDIT_TOOLS) {
    assert.ok(!granted.includes(tool), `reviewer must not be granted ${tool}`);
  }
  assert.ok(granted.includes('Bash'), 'reviewer needs Bash to run its own verification');
});

test('the scout is granted no editing tools either', () => {
  const fm = frontmatter(readFileSync(join(AGENTS_DIR, 'scout.md'), 'utf8'));
  assert.ok(fm.tools, 'scout must declare an explicit tool list');
  const granted = fm.tools.split(',').map((t) => t.trim());
  for (const tool of EDIT_TOOLS) {
    assert.ok(!granted.includes(tool), `scout must not be granted ${tool}`);
  }
});

test('no model name appears in any agent or skill file — routing has ONE source', () => {
  // Aliases and full ids. If routing policy leaks into a prompt, changing a
  // model stops being a one-line edit and nothing else would notice.
  const forbidden = [/\bhaiku\b/i, /\bsonnet\b/i, /\bopus\b/i, /\bfable\b/i, /claude-[a-z]+-\d/i];
  const targets = [
    ...agentFiles.map((f) => ['agents/' + f, join(AGENTS_DIR, f)]),
    ...readdirSync(SKILLS_DIR)
      .filter((d) => existsSync(join(SKILLS_DIR, d, 'SKILL.md')))
      .map((d) => ['skills/' + d, join(SKILLS_DIR, d, 'SKILL.md')]),
  ];
  for (const [label, path] of targets) {
    const text = readFileSync(path, 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${label}: contains a model name — it belongs only in .tyran/config.yaml`);
    }
  }
});

test('every agent tells its reader which language to answer in', () => {
  // The repo is English; Tyran answers in the operator's language. An agent
  // that omits this replies in English to a Polish operator, which reads as
  // the tool ignoring them.
  for (const file of agentFiles) {
    const text = readFileSync(join(AGENTS_DIR, file), 'utf8');
    assert.match(text, /language the conductor writes to you in/, `${file}: no language rule`);
  }
});
