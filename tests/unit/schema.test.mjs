import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validateConfig,
  validateKnowledge,
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
  tiers: { top: 'fable', work: 'opus', cheap: 'haiku' },
});

// --- config ------------------------------------------------------------

test('accepts a minimal valid config', () => {
  assert.deepEqual(validateConfig(minimalConfig()), []);
});

test('requires profile, autonomy and all three tiers', () => {
  const errors = validateConfig({});
  assert.ok(errors.some((e) => e.startsWith('profile:')));
  assert.ok(errors.some((e) => e.startsWith('autonomy:')));
  assert.ok(errors.some((e) => e.startsWith('tiers:')));
  const partial = validateConfig({ ...minimalConfig(), tiers: { top: 'fable' } });
  assert.ok(partial.some((e) => e.includes('tiers.work')));
  assert.ok(partial.some((e) => e.includes('tiers.cheap')));
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

// --- CLI ---------------------------------------------------------------

test('CLI exits 0 for valid files and 1 with findings for invalid ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-schema-cli-'));
  const good = join(dir, 'good.yaml');
  writeFileSync(good, 'profile: eco\nautonomy: P1\ntiers:\n  top: fable\n  work: opus\n  cheap: haiku\n');
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
