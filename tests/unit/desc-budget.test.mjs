import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseFrontmatterDescription,
  collectSkillDescriptions,
  DEFAULT_BUDGET,
} from '../../scripts/desc-budget.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/desc-budget.mjs', import.meta.url));
const CI = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url));

function fixture(skills) {
  const root = mkdtempSync(join(tmpdir(), 'tyran-descbudget-'));
  for (const [name, content] of Object.entries(skills)) {
    mkdirSync(join(root, 'skills', name), { recursive: true });
    writeFileSync(join(root, 'skills', name, 'SKILL.md'), content);
  }
  return root;
}

test('the budget is pinned, so raising it has to be deliberate', () => {
  // The same guard `hook-session-start.test.mjs` puts on DEADLINE_MS. The
  // budget is the number behind the README's "small curated core, enforced in
  // CI" claim, and a ceiling that drifts upward whenever it is inconvenient
  // measures nothing. It was 4000 for the first eight skills and moved once,
  // to 5000, as a recorded owner decision — see CHANGELOG.
  assert.equal(DEFAULT_BUDGET, 5000, 'pinned so a change has to be deliberate');
});

test('CI enforces the budget from the script, never from a second copy', () => {
  // The number used to be typed here AND in the workflow as `--budget 4000`.
  // Raising one left the other enforcing the old value: CI would fail quoting
  // a ceiling that existed nowhere in the repo. This is `prompt-tuning` rule 7
  // ("every hand-copy of a constant is a future lie") applied to the guard
  // that exists to stop exactly this class of decay.
  const ci = readFileSync(CI, 'utf8');
  const invocation = /node scripts\/desc-budget\.mjs[^\n]*/.exec(ci);
  assert.ok(invocation, 'CI no longer runs desc-budget at all');
  assert.doesNotMatch(
    invocation[0],
    /--budget/,
    'CI passes its own --budget, so the ceiling now lives in two places and they can disagree',
  );
});

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

test('CLI: invoked through a symlinked path, the budget is still enforced (ADR-19 debt)', () => {
  // Same silent no-op that bit journal.mjs, project.mjs and the scanner: the
  // self-run guard compared resolve(argv[1]) — which keeps symlinks — with
  // import.meta.url, which Node has already canonicalized. Through a link,
  // main() never ran: no table, no total, and EXIT 0 over a repo that is over
  // budget. This is a CI step, so exit 0 reads as "within budget" when nothing
  // was summed. /tmp and /var are symlinks on macOS, so this is the ordinary
  // case, not the exotic one.
  const base = mkdtempSync(join(tmpdir(), 'tyran-descbudget-symlink-'));
  const real = join(base, 'real-root');
  mkdirSync(join(real, 'scripts'), { recursive: true });
  writeFileSync(join(real, 'scripts', 'desc-budget.mjs'), readFileSync(SCRIPT));
  // desc-budget prints skill DIRECTORY NAMES, which are attacker-controlled
  // the moment a repo installs a third-party skill, so it now escapes them
  // through the shared rule — and the sibling has to travel with the copy.
  writeFileSync(
    join(real, 'scripts', 'invisible.mjs'),
    readFileSync(new URL('../../scripts/invisible.mjs', import.meta.url)),
  );
  // Second sibling, for the same reason: desc-budget refuses an unknown flag
  // through the shared command-line rule rather than ignoring it.
  writeFileSync(
    join(real, 'scripts', 'cli-args.mjs'),
    readFileSync(new URL('../../scripts/cli-args.mjs', import.meta.url)),
  );
  mkdirSync(join(real, 'skills', 'huge'), { recursive: true });
  writeFileSync(join(real, 'skills', 'huge', 'SKILL.md'), '---\ndescription: ' + 'a'.repeat(80) + '\n---\n');
  const linked = join(base, 'linked-root');
  symlinkSync(real, linked);

  const r = spawnSync(process.execPath, [join(linked, 'scripts', 'desc-budget.mjs'), '--budget', '10'], {
    encoding: 'utf8',
  });
  assert.notEqual(r.stdout, '', 'the CLI produced no output at all through the symlink');
  assert.match(r.stdout, /TOTAL \(budget: 10\)/, 'nothing was summed through the symlink');
  assert.equal(r.status, 1, 'an over-budget tree exited 0 through the symlink');
  assert.match(r.stderr, /exceeds budget/);
});

test('the self-run guard survives an argv[1] that cannot be canonicalized', () => {
  // realpathSync THROWS on a path it cannot follow. Without the fallback the
  // throw escapes module scope and importing desc-budget.mjs fails outright,
  // which is a worse failure than the one being fixed.
  const base = mkdtempSync(join(tmpdir(), 'tyran-descbudget-argv-'));
  const harness = join(base, 'harness.mjs');
  writeFileSync(
    harness,
    "process.argv[1] = '/nonexistent-dir-" +
      "e30/entry.mjs';\n" +
      `await import(${JSON.stringify(SCRIPT)});\n` +
      "console.log('SURVIVED');\n",
  );
  const r = spawnSync(process.execPath, [harness], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'SURVIVED');
});

test('a skill directory name cannot carry invisible characters into CI output', () => {
  // This runs in CI and prints skill DIRECTORY NAMES. The moment a repo
  // installs a third-party skill, that name is attacker-controlled — and CI
  // output is read by whoever is debugging the build. Reviewer's measurement
  // put this in the same class as the doctor and warnings leaks.
  const root = mkdtempSync(join(tmpdir(), 'tyran-descbudget-invisible-'));
  const name = `evil${String.fromCodePoint(0x202e)}${String.fromCodePoint(0xe0041)}skill`;
  mkdirSync(join(root, 'skills', name), { recursive: true });
  writeFileSync(
    join(root, 'skills', name, 'SKILL.md'),
    '---\nname: evil\ndescription: short\n---\n',
    'utf8',
  );
  const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
  const bad = [...(r.stdout + r.stderr)].filter((c) => {
    const n = c.codePointAt(0);
    if (n === 0x0a || n === 0x09) return false;
    return /^[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}]$/u.test(c);
  });
  assert.deepEqual(bad.map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`), []);
  assert.match(r.stdout, /<U\+202E>/, 'the name must be SHOWN escaped, not silently dropped');
});
