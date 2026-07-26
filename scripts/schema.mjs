#!/usr/bin/env node
/**
 * schema — validators for Tyran's repo data layer (`.tyran/`).
 *
 * Three file families, one rule each (see docs/configuration.md):
 *   config.yaml       — how Tyran behaves in THIS repo
 *   knowledge/*.yaml  — facts Tyran learned about THIS repo
 *   policies/*.yaml   — what Tyran may do without asking
 *
 * Every inferred config field carries provenance so a human can audit where
 * a value came from and how sure the scanner was.
 *
 * CLI:  node schema.mjs validate <kind> <file...>     kind: config|knowledge|policy
 * Exit: 0 valid · 1 findings · 2 usage/IO error
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, YamlLiteError } from './yaml-lite.mjs';

export const PROFILES = Object.freeze(['eco', 'balanced', 'full']);
export const AUTONOMY_CLASSES = Object.freeze(['P1', 'P2', 'P3']);
export const TIER_KEYS = Object.freeze(['top', 'work', 'cheap']);
export const ARTIFACT_CLASSES = Object.freeze(['AUTO', 'GATED', 'KERNEL']);
export const KNOWLEDGE_KINDS = Object.freeze(['fact', 'convention', 'gotcha', 'command', 'decision']);

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * A provenance-carrying value: either a bare scalar (author-written) or
 * `{value, source, confidence, needs_confirmation}` (scanner-inferred).
 */
function checkProvenanced(node, path, errors, { valueCheck, valueHint }) {
  if (isPlainObject(node) && 'value' in node) {
    if (!valueCheck(node.value)) errors.push(`${path}.value: ${valueHint}`);
    if (!isNonEmptyString(node.source)) {
      errors.push(`${path}.source: required for inferred values (file or command that proved it)`);
    }
    if (typeof node.confidence !== 'number' || node.confidence < 0 || node.confidence > 1) {
      errors.push(`${path}.confidence: must be a number in [0, 1]`);
    }
    if ('needs_confirmation' in node && typeof node.needs_confirmation !== 'boolean') {
      errors.push(`${path}.needs_confirmation: must be a boolean`);
    }
    for (const key of Object.keys(node)) {
      if (!['value', 'source', 'confidence', 'needs_confirmation'].includes(key)) {
        errors.push(`${path}.${key}: unknown key in a provenanced value`);
      }
    }
    return node.value;
  }
  if (!valueCheck(node)) errors.push(`${path}: ${valueHint}`);
  return node;
}

/** Validate `.tyran/config.yaml`. */
export function validateConfig(doc) {
  const errors = [];
  if (!isPlainObject(doc)) return ['config must be a mapping'];

  const known = ['profile', 'autonomy', 'tiers', 'validation', 'shared_zones', 'budget'];
  for (const key of Object.keys(doc)) {
    if (!known.includes(key)) errors.push(`${key}: unknown top-level key`);
  }

  if (!('profile' in doc)) errors.push('profile: required (eco | balanced | full)');
  else {
    checkProvenanced(doc.profile, 'profile', errors, {
      valueCheck: (v) => PROFILES.includes(v),
      valueHint: `must be one of ${PROFILES.join(' | ')}`,
    });
  }

  if (!('autonomy' in doc)) errors.push('autonomy: required (P1 | P2 | P3)');
  else {
    checkProvenanced(doc.autonomy, 'autonomy', errors, {
      valueCheck: (v) => AUTONOMY_CLASSES.includes(v),
      valueHint: `must be one of ${AUTONOMY_CLASSES.join(' | ')}`,
    });
  }

  if (!('tiers' in doc)) errors.push('tiers: required (top, work, cheap)');
  else if (!isPlainObject(doc.tiers)) errors.push('tiers: must be a mapping');
  else {
    for (const key of TIER_KEYS) {
      if (!(key in doc.tiers)) errors.push(`tiers.${key}: required`);
      else if (!isNonEmptyString(doc.tiers[key])) errors.push(`tiers.${key}: must be a model alias string`);
    }
    for (const key of Object.keys(doc.tiers)) {
      if (!TIER_KEYS.includes(key)) errors.push(`tiers.${key}: unknown tier (allowed: ${TIER_KEYS.join(', ')})`);
    }
  }

  if ('validation' in doc) {
    const list = checkProvenanced(doc.validation, 'validation', errors, {
      valueCheck: (v) => Array.isArray(v),
      valueHint: 'must be a list of shell commands',
    });
    if (Array.isArray(list)) {
      list.forEach((cmd, i) => {
        if (!isNonEmptyString(cmd)) errors.push(`validation[${i}]: must be a non-empty command string`);
      });
    }
  }

  if ('shared_zones' in doc) {
    if (!Array.isArray(doc.shared_zones)) errors.push('shared_zones: must be a list of path globs');
    else {
      doc.shared_zones.forEach((z, i) => {
        if (!isNonEmptyString(z)) errors.push(`shared_zones[${i}]: must be a non-empty path glob`);
      });
    }
  }

  if ('budget' in doc) {
    if (!isPlainObject(doc.budget)) errors.push('budget: must be a mapping');
    else {
      for (const [k, v] of Object.entries(doc.budget)) {
        if (typeof v !== 'number' || v <= 0) errors.push(`budget.${k}: must be a positive number`);
      }
    }
  }

  return errors;
}

/**
 * Validate a knowledge file: `entries:` list of learned facts.
 * Schema adapted from the best pattern found in the wild (metaswarm):
 * provenance + confidence + usage counters, so entries that stop earning
 * their keep can be degraded or retired by a later retrospective.
 */
export function validateKnowledge(doc) {
  const errors = [];
  if (!isPlainObject(doc)) return ['knowledge file must be a mapping with an "entries" list'];
  if (!Array.isArray(doc.entries)) return ['entries: required, must be a list'];

  const seen = new Set();
  doc.entries.forEach((entry, i) => {
    const at = `entries[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${at}: must be a mapping`);
      return;
    }
    if (!isNonEmptyString(entry.id)) errors.push(`${at}.id: required, non-empty string`);
    else if (seen.has(entry.id)) errors.push(`${at}.id: duplicate id "${entry.id}"`);
    else seen.add(entry.id);

    if (!KNOWLEDGE_KINDS.includes(entry.kind)) {
      errors.push(`${at}.kind: must be one of ${KNOWLEDGE_KINDS.join(' | ')}`);
    }
    if (!isNonEmptyString(entry.text)) errors.push(`${at}.text: required, non-empty string`);
    if (typeof entry.confidence !== 'number' || entry.confidence < 0 || entry.confidence > 1) {
      errors.push(`${at}.confidence: must be a number in [0, 1]`);
    }
    if (!Array.isArray(entry.provenance) || entry.provenance.length === 0) {
      errors.push(`${at}.provenance: required, at least one {source, reference} entry`);
    } else {
      entry.provenance.forEach((p, j) => {
        if (!isPlainObject(p) || !isNonEmptyString(p.source)) {
          errors.push(`${at}.provenance[${j}].source: required (where this was learned)`);
        } else if (!isNonEmptyString(p.reference)) {
          errors.push(`${at}.provenance[${j}].reference: required (which run/file/commit proved it)`);
        }
      });
    }
    for (const counter of ['used', 'helpful', 'outdated_reports']) {
      if (counter in entry && (!Number.isInteger(entry[counter]) || entry[counter] < 0)) {
        errors.push(`${at}.${counter}: must be a non-negative integer`);
      }
    }
    if ('applies_to' in entry && !Array.isArray(entry.applies_to)) {
      errors.push(`${at}.applies_to: must be a list of path globs`);
    }
    if ('supersedes' in entry && !isNonEmptyString(entry.supersedes)) {
      errors.push(`${at}.supersedes: must be an entry id`);
    }
  });
  return errors;
}

/**
 * Paths that MUST be classified KERNEL. A policy that downgrades any of
 * these would let the self-improvement loop disable its own enforcement,
 * so the validator rejects it — the boundary cannot be edited away, only
 * tightened (review E2S2-R6).
 */
export const MANDATORY_KERNEL_PATHS = Object.freeze(['hooks/**', '.tyran/policies/**']);

/**
 * Validate `policies/autonomy.yaml`: which paths the retro agent may write
 * autonomously (AUTO), which need approval (GATED), which are untouchable
 * (KERNEL). Enforced later by a PreToolUse hook — this validator makes sure
 * the file itself can never be ambiguous:
 *  - the mandatory KERNEL paths are present and classified KERNEL;
 *  - a `default` class exists, so an unmatched path has a defined answer;
 *  - precedence is explicit (most specific rule wins — longest path glob).
 */
export function validatePolicy(doc) {
  const errors = [];
  if (!isPlainObject(doc)) return ['policy must be a mapping'];
  if (!Array.isArray(doc.rules)) return ['rules: required, must be a list'];

  if (!('default' in doc)) {
    errors.push("default: required — the class applied to paths no rule matches (use 'GATED' when unsure)");
  } else if (!ARTIFACT_CLASSES.includes(doc.default)) {
    errors.push(`default: must be one of ${ARTIFACT_CLASSES.join(' | ')}`);
  }
  for (const key of Object.keys(doc)) {
    if (!['rules', 'default'].includes(key)) errors.push(`${key}: unknown top-level key`);
  }

  const seenPaths = new Set();
  const classByPath = new Map();
  doc.rules.forEach((rule, i) => {
    const at = `rules[${i}]`;
    if (!isPlainObject(rule)) {
      errors.push(`${at}: must be a mapping`);
      return;
    }
    if (!isNonEmptyString(rule.path)) errors.push(`${at}.path: required path glob`);
    else if (seenPaths.has(rule.path)) errors.push(`${at}.path: duplicate rule for "${rule.path}"`);
    else {
      seenPaths.add(rule.path);
      classByPath.set(rule.path, rule.class);
    }

    if (!ARTIFACT_CLASSES.includes(rule.class)) {
      errors.push(`${at}.class: must be one of ${ARTIFACT_CLASSES.join(' | ')}`);
    }
    if (!isNonEmptyString(rule.reason)) {
      errors.push(`${at}.reason: required — every boundary must say why it exists`);
    }
  });

  for (const required of MANDATORY_KERNEL_PATHS) {
    if (!classByPath.has(required)) {
      errors.push(`rules: a rule for "${required}" is required and must be class KERNEL`);
    } else if (classByPath.get(required) !== 'KERNEL') {
      errors.push(
        `rules: "${required}" is classified ${classByPath.get(required)} — it must be KERNEL ` +
          '(a system that can disable its own gates has none)',
      );
    }
  }

  // Presence of the literal rule is not enough: a MORE SPECIFIC non-KERNEL
  // rule would out-rank it under classifyPath's precedence and hand the
  // enforcement mechanism to AUTO with a green CI (review E2S2-R9).
  // Validate the EFFECT, not the spelling.
  for (const rule of doc.rules) {
    if (!isPlainObject(rule) || !isNonEmptyString(rule.path) || rule.class === 'KERNEL') continue;
    for (const required of MANDATORY_KERNEL_PATHS) {
      // Intersection, not string containment: a rule matching ANY concrete
      // path under the protected glob is a downgrade attempt, however it is
      // spelled (review E2S2-R10).
      // Intersect in both directions: concretize the rule INTO the protected
      // namespace (`**/x.mjs` → `hooks/x.mjs`) and probe the protected glob
      // against the rule. Either hit means the rule can claim a kernel file.
      const base = required.replace(/\/?\*\*$/, '');
      const intoNamespace = [rule.path.replace(/\*\*/g, base), rule.path.replace(/\*\*/g, `${base}/a`)];
      if (
        globMatches(required, concretize(rule.path)) ||
        intoNamespace.some((candidate) => globMatches(required, candidate.replace(/\*/g, 'x'))) ||
        probesFor(required).some((probe) => globMatches(rule.path, probe))
      ) {
        errors.push(
          `rules: "${rule.path}" (class ${rule.class}) falls under the protected path "${required}" — ` +
            'kernel paths may only be tightened, never downgraded by a more specific rule',
        );
      }
    }
  }

  // Belt and braces: probe the resolver itself, so any future change to
  // precedence that reopens this hole fails here.
  if (errors.length === 0) {
    for (const probe of MANDATORY_KERNEL_PATHS.flatMap(probesFor)) {
      if (classifyPath(doc, probe) !== 'KERNEL') {
        errors.push(`rules: "${probe}" resolves to ${classifyPath(doc, probe)}, but protected paths must resolve to KERNEL`);
      }
    }
  }
  return errors;
}

/** Concrete sample paths under a protected glob, at several depths. */
function probesFor(protectedGlob) {
  const base = protectedGlob.replace(/\/?\*\*$/, '');
  return [`${base}/probe.mjs`, `${base}/a/probe.mjs`, `${base}/a/b/probe.yaml`, `${base}/autonomy.yaml`];
}

/** Replace wildcards with concrete segments so a glob can be tested for containment. */
function concretize(glob) {
  return glob.replace(/\*\*/g, '__any__/__any__').replace(/(?<!_)\*(?!_)/g, '__any__').replace(/__any__/g, 'x');
}

/**
 * Resolve which class applies to a path. Precedence: the most specific
 * matching rule wins, measured by glob length; ties go to the stricter
 * class. Unmatched paths fall back to `default`. Exported so the future
 * PreToolUse hook and `doctor` share exactly one implementation.
 */
export function classifyPath(policy, filePath) {
  const strictness = { AUTO: 0, GATED: 1, KERNEL: 2 };
  const normalized = normalizePath(filePath);
  if (normalized === null) return 'KERNEL'; // outside the repo → never autonomous
  // Protected paths win unconditionally, BEFORE any rule is consulted: no
  // glob spelling (`**/policy-gate.mjs`, casing, nesting) can outrank them
  // (review E2S2-R10). validatePolicy still reports such rules as findings.
  for (const protectedGlob of MANDATORY_KERNEL_PATHS) {
    if (globMatches(protectedGlob, normalized)) return 'KERNEL';
  }
  let best = null;
  for (const rule of policy.rules ?? []) {
    if (!isNonEmptyString(rule.path) || !globMatches(rule.path, normalized)) continue;
    if (
      best === null ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && strictness[rule.class] > strictness[best.class])
    ) {
      best = rule;
    }
  }
  return best ? best.class : (policy.default ?? 'GATED');
}

/**
 * Normalize to a repo-relative POSIX path before matching. A hook receives
 * whatever form the tool used (`./hooks/x`, an absolute path, Windows
 * separators); without this, the same file could resolve to two different
 * classes and the gate would fail open (review E2S2-R9b).
 * Returns null when the path escapes the repo root.
 */
export function normalizePath(filePath, repoRoot = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()) {
  let p = String(filePath).replace(/\\/g, '/');
  const root = String(repoRoot).replace(/\\/g, '/').replace(/\/+$/, '');
  if (p.startsWith(root + '/')) p = p.slice(root.length + 1);
  else if (p.startsWith('/') || /^[A-Za-z]:\//.test(p)) return null; // absolute, outside the repo
  const segments = [];
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/** Minimal glob: `**` spans separators, `*` does not. */
function globMatches(glob, filePath) {
  const pattern = glob
    .split('**')
    .map((part) => part.split('*').map(escapeRegExp).join('[^/]*'))
    .join('.*');
  // Case-insensitive on purpose: on case-insensitive filesystems (macOS,
  // Windows) `HOOKS/x` and `hooks/x` are the same file, and a security
  // classifier must fail closed rather than let casing pick a weaker class.
  return new RegExp(`^${pattern}$`, 'i').test(filePath);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const VALIDATORS = { config: validateConfig, knowledge: validateKnowledge, policy: validatePolicy };

/** Parse + validate a file. Returns {ok, errors}. */
export function validateFile(kind, file) {
  const validator = VALIDATORS[kind];
  if (!validator) return { ok: false, errors: [`unknown kind "${kind}" (config | knowledge | policy)`] };
  if (!existsSync(file)) return { ok: false, errors: [`file not found: ${file}`] };
  let doc;
  try {
    doc = parse(readFileSync(file, 'utf8'));
  } catch (err) {
    // Any parse failure is a finding, never a crash — pathological input
    // (e.g. deep nesting → RangeError) must not escape as a stack trace
    // (review E2S2-R8).
    if (err instanceof YamlLiteError) return { ok: false, errors: [`YAML: ${err.message}`] };
    return { ok: false, errors: [`YAML: unparseable (${err.name}: ${err.message})`] };
  }
  const errors = validator(doc);
  return { ok: errors.length === 0, errors, doc };
}

// ---------------------------------------------------------------- CLI

function main() {
  const [cmd, kind, ...files] = process.argv.slice(2);
  if (cmd !== 'validate' || !kind || files.length === 0) {
    console.error('usage: schema.mjs validate <config|knowledge|policy> <file...>');
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    const { ok, errors } = validateFile(kind, file);
    if (ok) {
      console.log(`ok    ${file}`);
    } else {
      failed = true;
      console.log(`FAIL  ${file}`);
      for (const e of errors) console.log(`      - ${e}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
