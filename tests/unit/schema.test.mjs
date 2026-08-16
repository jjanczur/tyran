import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validateConfig,
  limitsOf,
  pricingOf,
  validateKnowledge,
  knowledgeWarnings,
  KNOWLEDGE_ENTRY_MAX_CHARS,
  validatePolicy,
  validateFile,
  classifyPath,
  normalizePath,
  MANDATORY_KERNEL_PATHS,
  PROFILES,
  AUTONOMY_CLASSES,
  ARTIFACT_CLASSES,
} from '../../scripts/schema.mjs';
import { parse } from '../../scripts/yaml-lite.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/schema.mjs', import.meta.url));
const TEMPLATES = fileURLToPath(new URL('../../templates/', import.meta.url));

const minimalConfig = () => ({
  profile: 'balanced',
  autonomy: 'P1',
  tiers: { cheap: 'haiku', work: 'sonnet', deep: 'opus', top: 'fable' },
});

// --- config ------------------------------------------------------------

test('accepts a minimal valid config', () => {
  assert.deepEqual(validateConfig(minimalConfig()), []);
});

test('requires profile, autonomy and every tier', () => {
  const errors = validateConfig({});
  assert.ok(errors.some((e) => e.startsWith('profile:')));
  assert.ok(errors.some((e) => e.startsWith('autonomy:')));
  assert.ok(errors.some((e) => e.startsWith('tiers:')));
  const partial = validateConfig({ ...minimalConfig(), tiers: { top: 'fable' } });
  for (const tier of ['cheap', 'work', 'deep']) {
    assert.ok(partial.some((e) => e.includes(`tiers.${tier}`)), `missing tier ${tier} must be reported`);
  }
  // A config carrying only the three PRE-`deep` tiers is a real shape: it is
  // what every repo configured before the tier was added still has on disk.
  // It must fail loudly rather than resolve `deep` to undefined at spawn.
  const legacy = validateConfig({ ...minimalConfig(), tiers: { top: 'fable', work: 'opus', cheap: 'haiku' } });
  assert.ok(legacy.some((e) => e.includes('tiers.deep')));
});

test('rejects unknown enum values and unknown keys', () => {
  assert.ok(validateConfig({ ...minimalConfig(), profile: 'turbo' }).some((e) => e.includes(PROFILES.join(' | '))));
  assert.ok(validateConfig({ ...minimalConfig(), autonomy: 'P9' }).some((e) => e.includes(AUTONOMY_CLASSES.join(' | '))));
  assert.ok(validateConfig({ ...minimalConfig(), surprise: 1 }).some((e) => e.includes('unknown top-level key')));
  assert.ok(validateConfig({ ...minimalConfig(), tiers: { ...minimalConfig().tiers, extra: 'x' } }).some((e) => e.includes('unknown tier')));
});

test('accepts provenanced values and enforces their metadata', () => {
  const ok = validateConfig({
    ...minimalConfig(),
    autonomy: { value: 'P1', source: 'git log: no direct pushes to main', confidence: 0.9, needs_confirmation: true },
  });
  assert.deepEqual(ok, []);

  const missingSource = validateConfig({
    ...minimalConfig(),
    autonomy: { value: 'P1', confidence: 0.9 },
  });
  assert.ok(missingSource.some((e) => e.includes('autonomy.source')));

  const badConfidence = validateConfig({
    ...minimalConfig(),
    autonomy: { value: 'P1', source: 'x', confidence: 1.5 },
  });
  assert.ok(badConfidence.some((e) => e.includes('confidence')));

  const strayKey = validateConfig({
    ...minimalConfig(),
    autonomy: { value: 'P1', source: 'x', confidence: 0.5, guess: true },
  });
  assert.ok(strayKey.some((e) => e.includes('unknown key in a provenanced value')));
});

test('validates optional validation/shared_zones/budget shapes', () => {
  assert.deepEqual(validateConfig({ ...minimalConfig(), validation: ['npm test'], shared_zones: ['messages/*.json'], budget: { usd_per_initiative: 5 } }), []);
  assert.ok(validateConfig({ ...minimalConfig(), validation: ['', 'ok'] }).some((e) => e.includes('validation[0]')));
  assert.ok(validateConfig({ ...minimalConfig(), shared_zones: 'not-a-list' }).some((e) => e.includes('shared_zones')));
  assert.ok(validateConfig({ ...minimalConfig(), budget: { usd: 0 } }).some((e) => e.includes('positive number')));
});

// --- limits ------------------------------------------------------------
//
// limitsOf feeds the usage gate directly, so a number the schema rejects must
// resolve to the DEFAULT, never be enforced verbatim: `pause_at_percent: 0.97`
// applied as-written is a permanent false pause on the first tool call of
// every session.

test('limitsOf treats an out-of-range number as absent — the default applies', () => {
  assert.equal(limitsOf({ limits: { mode: 'pause', pause_at_percent: 0.97 } }).pause_at_percent, 97);
  assert.equal(limitsOf({ limits: { mode: 'pause', weekly_pause_at_percent: 0.97 } }).weekly_pause_at_percent, 97);
  assert.equal(limitsOf({ limits: { mode: 'pause', resume_margin_minutes: -600 } }).resume_margin_minutes, 5);
  assert.equal(limitsOf({ limits: { mode: 'pause', wait_max_hours: -1 } }).wait_max_hours, 5);
  assert.equal(limitsOf({ limits: { mode: 'pause', wait_max_hours: 25 } }).wait_max_hours, 5);
  assert.equal(limitsOf({ limits: { mode: 'pause', wait_max_hours: 0 } }).wait_max_hours, 5, 'the lower bound is exclusive');
});

test('limitsOf treats a non-finite number as absent', () => {
  // NaN and the infinities pass `typeof === 'number'`; enforced verbatim, NaN
  // poisons every threshold comparison.
  const got = limitsOf({ limits: { mode: 'pause', pause_at_percent: NaN, weekly_pause_at_percent: NaN, wait_max_hours: Infinity, resume_margin_minutes: -Infinity } });
  assert.equal(got.pause_at_percent, 97);
  assert.equal(got.weekly_pause_at_percent, 97);
  assert.equal(got.wait_max_hours, 5);
  assert.equal(got.resume_margin_minutes, 5);
});

test('limitsOf accepts boundary and in-range values verbatim', () => {
  const bounds = limitsOf({ limits: { mode: 'pause', pause_at_percent: 50, weekly_pause_at_percent: 100, wait_max_hours: 24, resume_margin_minutes: 240 } });
  assert.equal(bounds.pause_at_percent, 50);
  assert.equal(bounds.weekly_pause_at_percent, 100);
  assert.equal(bounds.wait_max_hours, 24);
  assert.equal(bounds.resume_margin_minutes, 240);

  const inRange = limitsOf({ limits: { mode: 'warn', pause_at_percent: 85, weekly_pause_at_percent: 92, wait_max_hours: 3.5, resume_margin_minutes: 30, long_wait: 'resume' } });
  assert.equal(inRange.mode, 'warn');
  assert.equal(inRange.pause_at_percent, 85);
  assert.equal(inRange.weekly_pause_at_percent, 92);
  assert.equal(inRange.wait_max_hours, 3.5);
  assert.equal(inRange.resume_margin_minutes, 30);
  assert.equal(inRange.long_wait, 'resume');
});

// --- knowledge ---------------------------------------------------------

const knowledgeEntry = (over = {}) => ({
  id: 'K-1',
  kind: 'gotcha',
  text: 'Full test suite, not just touched files — a regression slipped in sideways.',
  confidence: 0.8,
  provenance: [{ source: 'initiative:rate-limiting', reference: 'journal:report#12' }],
  ...over,
});

test('accepts a valid knowledge entry', () => {
  assert.deepEqual(validateKnowledge({ entries: [knowledgeEntry()] }), []);
});

test('requires id, kind, text, confidence and provenance', () => {
  const errors = validateKnowledge({ entries: [{}] });
  for (const field of ['id', 'kind', 'text', 'confidence', 'provenance']) {
    assert.ok(errors.some((e) => e.includes(`entries[0].${field}`)), `missing check for ${field}`);
  }
});

test('rejects duplicate ids and unknown kinds', () => {
  const dup = validateKnowledge({ entries: [knowledgeEntry(), knowledgeEntry()] });
  assert.ok(dup.some((e) => e.includes('duplicate id')));
  assert.ok(validateKnowledge({ entries: [knowledgeEntry({ kind: 'vibes' })] }).some((e) => e.includes('kind')));
});

test('validates usage counters and optional fields', () => {
  assert.deepEqual(validateKnowledge({ entries: [knowledgeEntry({ used: 3, helpful: 2, outdated_reports: 0, applies_to: ['src/**'], supersedes: 'K-0' })] }), []);
  assert.ok(validateKnowledge({ entries: [knowledgeEntry({ used: -1 })] }).some((e) => e.includes('used')));
  assert.ok(validateKnowledge({ entries: [knowledgeEntry({ applies_to: 'src/**' })] }).some((e) => e.includes('applies_to')));
});

test('requires entries to be a list', () => {
  assert.ok(validateKnowledge({}).some((e) => e.includes('entries')));
});

test('knowledgeWarnings flags an oversized entry without touching the error contract', () => {
  const atLimit = knowledgeEntry({ text: 'x'.repeat(KNOWLEDGE_ENTRY_MAX_CHARS) });
  const over = knowledgeEntry({ id: 'K-2', text: 'y'.repeat(KNOWLEDGE_ENTRY_MAX_CHARS + 1) });
  const doc = { entries: [atLimit, over] };
  // errors unchanged — an oversized entry still VALIDATES
  assert.deepEqual(validateKnowledge(doc), []);
  const warnings = knowledgeWarnings(doc);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^K-2: /);
  assert.match(warnings[0], new RegExp(String(KNOWLEDGE_ENTRY_MAX_CHARS + 1)));
  // exactly at the limit is silent
  assert.deepEqual(knowledgeWarnings({ entries: [atLimit] }), []);
});

test('knowledgeWarnings measures codepoints, not UTF-16 units, and survives junk', () => {
  // 4000 astral codepoints are 8000 UTF-16 units — still exactly at the limit.
  const astral = knowledgeEntry({ text: '𝐀'.repeat(KNOWLEDGE_ENTRY_MAX_CHARS) });
  assert.deepEqual(knowledgeWarnings({ entries: [astral] }), []);
  // malformed docs yield no warnings rather than a throw
  assert.deepEqual(knowledgeWarnings(null), []);
  assert.deepEqual(knowledgeWarnings({ entries: [null, { text: 42 }, 'nope'] }), []);
});

// --- policy ------------------------------------------------------------

const kernelRules = [
  { path: 'hooks/**', class: 'KERNEL', reason: 'enforcement' },
  { path: '.tyran/policies/**', class: 'KERNEL', reason: 'the boundary must protect itself' },
];
const policyDoc = (rules) => ({ default: 'GATED', rules: [...rules, ...kernelRules] });

test('accepts a policy that classifies the mandatory kernel paths', () => {
  assert.deepEqual(
    validatePolicy(policyDoc([{ path: '.tyran/knowledge/**', class: 'AUTO', reason: 'learned facts' }])),
    [],
  );
});

test('self-protection: mandatory kernel paths must exist AND be KERNEL', () => {
  // Review finding E2S2-R6: "at least one KERNEL rule anywhere" protected
  // nothing — a policy could KERNEL-classify a changelog and hand its own
  // enforcement to AUTO.
  const missing = validatePolicy({ default: 'GATED', rules: [{ path: 'docs/fluff.md', class: 'KERNEL', reason: 'nobody cares' }] });
  for (const required of MANDATORY_KERNEL_PATHS) {
    assert.ok(missing.some((e) => e.includes(required)), `no finding for missing ${required}`);
  }
  const downgraded = validatePolicy({
    default: 'GATED',
    rules: [
      { path: 'hooks/**', class: 'AUTO', reason: 'let me disable my own gates' },
      { path: '.tyran/policies/**', class: 'KERNEL', reason: 'r' },
    ],
  });
  assert.ok(downgraded.some((e) => e.includes('must be KERNEL')));
});

test('requires an explicit default class for unmatched paths', () => {
  const noDefault = validatePolicy({ rules: kernelRules });
  assert.ok(noDefault.some((e) => e.startsWith('default:')));
  assert.ok(validatePolicy({ default: 'MAYBE', rules: kernelRules }).some((e) => e.includes(ARTIFACT_CLASSES.join(' | '))));
});

test('rejects unknown classes, duplicate paths, missing reasons and unknown keys', () => {
  assert.ok(validatePolicy(policyDoc([{ path: 'a', class: 'MAYBE', reason: 'r' }])).some((e) => e.includes(ARTIFACT_CLASSES.join(' | '))));
  assert.ok(validatePolicy(policyDoc([{ path: 'a', class: 'AUTO', reason: 'r' }, { path: 'a', class: 'GATED', reason: 'r' }])).some((e) => e.includes('duplicate rule')));
  assert.ok(validatePolicy(policyDoc([{ path: 'a', class: 'AUTO' }])).some((e) => e.includes('reason')));
  assert.ok(validatePolicy({ ...policyDoc([]), stray: 1 }).some((e) => e.includes('unknown top-level key')));
});

test('classifyPath: most specific wins, ties go stricter, default is the fallback', () => {
  const policy = policyDoc([
    { path: '**', class: 'AUTO', reason: 'broad' },
    { path: '.tyran/knowledge/**', class: 'AUTO', reason: 'facts' },
  ]);
  assert.equal(classifyPath(policy, '.tyran/knowledge/repo.yaml'), 'AUTO');
  assert.equal(classifyPath(policy, 'hooks/scripts/evidence-gate.mjs'), 'KERNEL');
  assert.equal(classifyPath(policy, '.tyran/policies/autonomy.yaml'), 'KERNEL');
  assert.equal(classifyPath(policy, 'src/index.ts'), 'AUTO'); // matched by '**'
  assert.equal(classifyPath({ default: 'GATED', rules: [] }, 'anything.txt'), 'GATED');
  assert.equal(classifyPath({ rules: [] }, 'anything.txt'), 'GATED'); // safe fallback
});

test('classifyPath: protected paths survive path-form and casing tricks', () => {
  // Review E2S2-R9b: a hook receives whatever form the tool used.
  const policy = { default: 'AUTO', rules: [
    { path: 'hooks/**', class: 'KERNEL', reason: 'gates' },
    { path: '.tyran/policies/**', class: 'KERNEL', reason: 'self' },
  ] };
  for (const form of ['hooks/x.mjs', './hooks/x.mjs', 'hooks/./a/../x.mjs', 'HOOKS/x.mjs', 'hooks\\\\x.mjs']) {
    assert.equal(classifyPath(policy, form), 'KERNEL', `${form} must stay KERNEL`);
  }
  // Paths escaping the repo are never autonomous.
  assert.equal(classifyPath(policy, '../outside.mjs'), 'KERNEL');
  assert.equal(classifyPath(policy, '/etc/passwd'), 'KERNEL');
  assert.equal(normalizePath('./a/../b'), 'b');
  assert.equal(normalizePath('../up'), null);
});

test('validatePolicy rejects a more specific rule that downgrades a kernel path', () => {
  // The exact counterexample from review E2S2-R9: literal kernel rules
  // present, but out-ranked by a more specific AUTO rule.
  const evil = { default: 'GATED', rules: [
    { path: 'hooks/**', class: 'KERNEL', reason: 'gates' },
    { path: '.tyran/policies/**', class: 'KERNEL', reason: 'self' },
    { path: 'hooks/policy-gate.mjs', class: 'AUTO', reason: 'let retro tune its own gate' },
    { path: '.tyran/policies/autonomy.yaml', class: 'AUTO', reason: 'let retro edit the boundary' },
  ] };
  const errors = validatePolicy(evil);
  assert.ok(errors.some((e) => e.includes('hooks/policy-gate.mjs') && e.includes('may only be tightened')));
  assert.ok(errors.some((e) => e.includes('.tyran/policies/autonomy.yaml')));
});

test('classifyPath: single * does not span separators', () => {
  const policy = { default: 'GATED', rules: [{ path: '.tyran/*.yaml', class: 'AUTO', reason: 'r' }] };
  assert.equal(classifyPath(policy, '.tyran/config.yaml'), 'AUTO');
  assert.equal(classifyPath(policy, '.tyran/nested/config.yaml'), 'GATED');
});

// --- file-level + shipped templates ------------------------------------

test('validateFile reports YAML errors with line numbers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-schema-'));
  const file = join(dir, 'config.yaml');
  writeFileSync(file, 'profile: balanced\nbad: |\n  block\n');
  const { ok, errors } = validateFile('config', file);
  assert.equal(ok, false);
  assert.ok(errors[0].startsWith('YAML: line 2'));
});

test('validateFile handles missing files and unknown kinds', () => {
  assert.ok(validateFile('config', '/nope/none.yaml').errors[0].includes('file not found'));
  assert.ok(validateFile('bogus', '/tmp').errors[0].includes('unknown kind'));
});

test('shipped templates are valid against their own schemas', () => {
  for (const [kind, file] of [
    ['config', join(TEMPLATES, 'config.yaml')],
    ['knowledge', join(TEMPLATES, 'knowledge.yaml')],
    ['policy', join(TEMPLATES, 'policies/autonomy.yaml')],
  ]) {
    const { ok, errors } = validateFile(kind, file);
    assert.deepEqual(errors, [], `${file} should be valid`);
    assert.equal(ok, true);
  }
});

test('the shipped policy template classifies the kernel paths it must', () => {
  const doc = parse(readFileSync(join(TEMPLATES, 'policies/autonomy.yaml'), 'utf8'));
  for (const required of MANDATORY_KERNEL_PATHS) {
    const rule = doc.rules.find((r) => r.path === required);
    assert.ok(rule, `template must classify ${required}`);
    assert.equal(rule.class, 'KERNEL');
  }
  assert.equal(doc.default, 'GATED');
});

test('the shipped template puts .tyran/config.yaml in AUTO, and says what that costs', () => {
  // Deliberate, and the reason it is pinned here is that flipping it back is a
  // one-word edit nobody would notice in review. It was GATED, and GATED meant
  // an agent that discovered `pnpm test` was bare `vitest` — watch mode, never
  // exits, hangs every agent it is handed to — could not repair the file that
  // said so. It handed the operator a heredoc instead, during setup.
  //
  // The cost is real and is not hidden: `autonomy:` lives in this file, so an
  // agent can raise its own deployment class. The template has to SAY so, or
  // the trade is one the user made without being told.
  const text = readFileSync(join(TEMPLATES, 'policies/autonomy.yaml'), 'utf8');
  const doc = parse(text);
  const rule = doc.rules.find((r) => r.path === '.tyran/config.yaml');
  assert.ok(rule, 'the template must classify the config explicitly, not leave it to `default:`');
  assert.equal(rule.class, 'AUTO');
  // Matched against the comment prose with its `#` markers and line wrapping
  // removed. Asserting on the raw text would pin the line breaks rather than
  // the sentence, and go red the first time someone rewraps a paragraph.
  const prose = text.replace(/^\s*#\s?/gm, '').replace(/\s+/g, ' ');
  assert.match(prose, /raise its own deployment class/, 'the give-up is stated in the file the user reads');
  assert.match(prose, /Set this rule back to GATED/, 'and so is the way back');
});

// --- CLI ---------------------------------------------------------------

test('CLI exits 0 for valid files and 1 with findings for invalid ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-schema-cli-'));
  const good = join(dir, 'good.yaml');
  writeFileSync(good, 'profile: eco\nautonomy: P1\ntiers:\n  cheap: haiku\n  work: sonnet\n  deep: opus\n  top: fable\n');
  const out = execFileSync(process.execPath, [SCRIPT, 'validate', 'config', good], { encoding: 'utf8' });
  assert.match(out, /^ok /m);

  const bad = join(dir, 'bad.yaml');
  writeFileSync(bad, 'profile: turbo\n');
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, 'validate', 'config', bad], { stdio: 'pipe' }), /Command failed|status 1/);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, 'validate'], { stdio: 'pipe' }), /Command failed|status 2/);
});

test('protected paths cannot be outranked by any glob spelling (E2S2-R10)', () => {
  const evil = { default: 'GATED', rules: [
    { path: 'hooks/**', class: 'KERNEL', reason: 'gates' },
    { path: '.tyran/policies/**', class: 'KERNEL', reason: 'self' },
    { path: '**/policy-gate.mjs', class: 'AUTO', reason: 'every gate file, anywhere' },
  ] };
  assert.equal(classifyPath(evil, 'hooks/policy-gate.mjs'), 'KERNEL');
  assert.ok(validatePolicy(evil).some((e) => e.includes('**/policy-gate.mjs')));
  // Even a policy that never mentions hooks cannot make them autonomous.
  assert.equal(classifyPath({ default: 'AUTO', rules: [{ path: '**', class: 'AUTO', reason: 'all' }] }, 'hooks/x.mjs'), 'KERNEL');
});

test('CLI: invoked through a symlinked path, validation still runs (ADR-19 debt)', () => {
  // The self-run guard compared resolve(argv[1]) — which keeps symlinks — with
  // import.meta.url, which Node has already canonicalized. Reaching the script
  // through a link therefore made main() never run: no output, no findings,
  // and EXIT 0 over a file that does not validate. This script is a CI step,
  // so a silent no-op reads as "the templates are valid" when nothing looked
  // at them. Not exotic either: /tmp and /var are symlinks on macOS and plugin
  // installs reach scripts/ through a link routinely.
  const base = mkdtempSync(join(tmpdir(), 'tyran-schema-symlink-'));
  const realScripts = join(base, 'real-scripts');
  mkdirSync(realScripts);
  writeFileSync(join(realScripts, 'schema.mjs'), readFileSync(SCRIPT));
  // Both siblings travel with it: yaml-lite, and the shared invisibility rule
  // that schema and yaml-lite now both import (ADR-21). A copy missing one
  // fails at module resolution and would report this guard as broken.
  for (const name of ['yaml-lite.mjs', 'invisible.mjs']) {
    writeFileSync(
      join(realScripts, name),
      readFileSync(fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url))),
    );
  }
  const linked = join(base, 'linked-scripts');
  symlinkSync(realScripts, linked);

  const bad = join(base, 'bad.yaml');
  writeFileSync(bad, 'profile: turbo\n');
  const r = spawnSync(process.execPath, [join(linked, 'schema.mjs'), 'validate', 'config', bad], {
    encoding: 'utf8',
  });
  assert.notEqual(r.stdout, '', 'the CLI produced no output at all through the symlink');
  assert.match(r.stdout, /^FAIL /m, 'the invalid file was not reported through the symlink');
  assert.equal(r.status, 1, 'an invalid file exited 0 through the symlink');
});

test('the self-run guard survives an argv[1] that cannot be canonicalized', () => {
  // The guard canonicalizes argv[1] with realpathSync, which THROWS when the
  // path cannot be followed. Without the fallback that throw escapes module
  // scope and importing schema.mjs fails outright — taking down every consumer,
  // including the hook that classifies paths.
  const base = mkdtempSync(join(tmpdir(), 'tyran-schema-argv-'));
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

test('CLI: a validation message cannot carry invisible characters to the terminal', () => {
  // A `.tyran/` tree can come from a template someone else wrote, and this
  // message quotes values read out of it. Same channel as project.warnings()
  // and the journal CLI, and it was open for the same reason: nobody swept it.
  const dir = mkdtempSync(join(tmpdir(), 'tyran-schema-invisible-'));
  const file = join(dir, 'config.yaml');
  const RLO = String.fromCodePoint(0x202e);
  const TAG = String.fromCodePoint(0xe0041);
  // A poisoned KEY, not a poisoned value: the messages that quote journal- or
  // file-derived text back are the "unknown key" ones. Aimed at a value first,
  // where nothing is quoted, this test passed over an unescaped sink — the
  // mutant that removed the escaping SURVIVED it. Found by mutation, not by
  // reading (ADR-20).
  writeFileSync(file, `profile: eco\n"bad${RLO}${TAG}key": 1\n`, 'utf8');
  const r = spawnSync(process.execPath, [SCRIPT, 'validate', 'config', file], { encoding: 'utf8' });
  const bad = [...(r.stdout + r.stderr)].filter((c) => {
    const n = c.codePointAt(0);
    if (n === 0x0a || n === 0x09) return false;
    return /^[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}]$/u.test(c);
  });
  assert.deepEqual(bad.map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`), []);
  assert.match(r.stdout, /FAIL/, 'premise: this file must fail validation');
  assert.match(r.stdout, /bad<U\+202E><U\+E0041>key: unknown top-level key/, 'the key must be SHOWN escaped');
});

test('CLI: a poisoned FILE NAME cannot reach the terminal either', () => {
  // The second half of the same guarantee, and it had no killed mutant.
  //
  // The test above aims at a poisoned KEY inside the file. This module quotes
  // the FILE NAME two lines away from it, on both the `ok` and the `FAIL`
  // branch — and a systematic single-site mutation run found both of those
  // sites SURVIVING at 342/0. That is the round-4 lesson arriving a second
  // time: the sink was real, the code was already correct, and the test simply
  // pointed at one of the two halves. A guarantee is only as tested as its
  // least-covered branch.
  //
  // The vector is not hypothetical: a file name is attacker-controlled exactly
  // like the skill directory name that desc-budget prints, and `schema.mjs
  // validate` is run over paths a repo supplies.
  const dir = mkdtempSync(join(tmpdir(), 'tyran-schema-name-'));
  const RLO = String.fromCodePoint(0x202e);
  const TAG = String.fromCodePoint(0xe0041);
  const invisibleIn = (text) =>
    [...text].filter((c) => {
      const n = c.codePointAt(0);
      if (n === 0x0a || n === 0x09) return false;
      return /^[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}]$/u.test(c);
    });

  // BOTH branches: a valid file takes the `ok` path, an invalid one the `FAIL`
  // path, and each prints the name through a separate call site.
  const valid = join(dir, `good${RLO}${TAG}.yaml`);
  writeFileSync(valid, readFileSync(join(TEMPLATES, 'config.yaml')));
  const invalid = join(dir, `bad${RLO}${TAG}.yaml`);
  writeFileSync(invalid, 'profile: turbo\n', 'utf8');

  for (const [label, file, expectMatch] of [
    ['ok branch', valid, /ok\s+.*good<U\+202E><U\+E0041>\.yaml/],
    ['FAIL branch', invalid, /FAIL\s+.*bad<U\+202E><U\+E0041>\.yaml/],
  ]) {
    const r = spawnSync(process.execPath, [SCRIPT, 'validate', 'config', file], { encoding: 'utf8' });
    assert.deepEqual(
      invisibleIn(r.stdout + r.stderr).map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`),
      [],
      `an invisible codepoint from the FILE NAME reached the terminal on the ${label}`,
    );
    assert.match(r.stdout, expectMatch, `the name must be SHOWN escaped on the ${label}`);
  }
});

// --- pricing -----------------------------------------------------------
//
// The rate card an operator types from a vendor's price list. Never
// scanner-inferred, so it follows `limits:` in shape: its own top-level
// block, no provenance wrapper.

test('pricing accepts a full rate card and rejects every partial shape', () => {
  const full = {
    ...minimalConfig(),
    pricing: {
      rate_card: 'list-2026-08',
      models: { 'model-a': { input: 15, cache_write: 18.75, cache_read: 1.5, output: 75 } },
    },
  };
  assert.deepEqual(validateConfig(full), []);

  // MUTANT: make the four rate keys optional. A table carrying three of them
  // prices the fourth at zero, silently — and cache reads alone were measured
  // at roughly three quarters of a real session's cost.
  const missing = JSON.parse(JSON.stringify(full));
  delete missing.pricing.models['model-a'].cache_read;
  assert.deepEqual(validateConfig(missing), ['pricing.models.model-a.cache_read: required']);

  for (const [bad, expected] of [
    [{ input: 15, cache_write: 1, cache_read: 1, output: -1 }, 'pricing.models.model-a.output: must be a non-negative number (price per million tokens)'],
    [{ input: 'free', cache_write: 1, cache_read: 1, output: 1 }, 'pricing.models.model-a.input: must be a non-negative number (price per million tokens)'],
  ]) {
    const doc = JSON.parse(JSON.stringify(full));
    doc.pricing.models['model-a'] = bad;
    assert.ok(validateConfig(doc).includes(expected), JSON.stringify(bad));
  }

  const unknown = JSON.parse(JSON.stringify(full));
  unknown.pricing.models['model-a'].reasoning = 1;
  assert.ok(validateConfig(unknown).some((e) => e.startsWith('pricing.models.model-a.reasoning: unknown rate')));

  const stray = JSON.parse(JSON.stringify(full));
  stray.pricing.currency = 'USD';
  assert.deepEqual(validateConfig(stray), ['pricing.currency: unknown key']);

  const unlabelled = JSON.parse(JSON.stringify(full));
  unlabelled.pricing.rate_card = '';
  assert.deepEqual(validateConfig(unlabelled), ['pricing.rate_card: must be a non-empty label']);
});

// --- spend ---------------------------------------------------------------
//
// Where cost.mjs should look for a repo's transcripts when the derived-slug /
// cwd-probe fallback lands on the wrong session. Operator-written, never
// scanner-inferred, exactly like `pricing:` above.

test('spend.transcript_dirs accepts a list of non-empty strings and rejects every other shape', () => {
  const full = { ...minimalConfig(), spend: { transcript_dirs: ['/abs/path', '~/.claude/projects/x-y'] } };
  assert.deepEqual(validateConfig(full), []);

  // MUTANT: accept a bare string instead of requiring a list — a single dir
  // typed without brackets would silently scan its own characters as paths.
  const notList = { ...minimalConfig(), spend: { transcript_dirs: '/abs/path' } };
  assert.deepEqual(validateConfig(notList), ['spend.transcript_dirs: must be a list of directory paths']);

  const emptyEntry = { ...minimalConfig(), spend: { transcript_dirs: ['/abs/path', ''] } };
  assert.deepEqual(validateConfig(emptyEntry), ['spend.transcript_dirs[1]: must be a non-empty path']);

  const notMapping = { ...minimalConfig(), spend: 'nope' };
  assert.deepEqual(validateConfig(notMapping), ['spend: must be a mapping']);

  const stray = { ...minimalConfig(), spend: { transcript_dirs: [], currency: 'USD' } };
  assert.deepEqual(validateConfig(stray), ['spend.currency: unknown key']);
});

test('pricingOf drops a model the validator would reject rather than half-pricing it', () => {
  const doc = {
    pricing: {
      rate_card: 'card',
      models: {
        good: { input: 1, cache_write: 2, cache_read: 3, output: 4 },
        partial: { input: 1, cache_write: 2 },
      },
    },
  };
  const resolved = pricingOf(doc);
  assert.equal(resolved.rate_card, 'card');
  // MUTANT: keep `partial` and default its missing rates to 0 — the report
  // then shows a confident amount that is short by two of the four things a
  // request is billed for.
  assert.deepEqual(Object.keys(resolved.models), ['good']);
  assert.equal(pricingOf({}).rate_card, null);
  assert.deepEqual(Object.keys(pricingOf({}).models), []);
});
