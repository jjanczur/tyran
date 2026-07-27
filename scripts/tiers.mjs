#!/usr/bin/env node
/**
 * tiers — resolve a ROLE to a MODEL, in one place.
 *
 * The point of this file is that no other file in the plugin contains a model
 * name. Skills, agents and policies are written in role names; `.tyran/
 * config.yaml` maps four capability tiers to model aliases; this script is
 * the only thing that joins them. A model deprecation is then a one-line edit
 * in one file rather than a sweep through every prompt in the repo — and a
 * sweep through prompts is exactly the kind of change that gets 90% done.
 *
 * The default routing puts everyday work on `work` and reserves `deep` and
 * `top` for calls where being wrong is both expensive and hard to notice. A
 * cost mode that routes everything to the strongest model is not a cost mode;
 * a cost mode that routes a security review to the cheapest one is worse.
 *
 * CLI:
 *   node tiers.mjs [--config <path>] [--profile P] [--role R] [--risk L]
 *   node tiers.mjs --role reviewer --risk high     # -> one model alias
 *   node tiers.mjs                                 # -> the whole map, JSON
 * Exit: 0 resolved · 2 usage/IO/config error
 */
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './yaml-lite.mjs';
import { validateConfig, PROFILES, TIER_KEYS } from './schema.mjs';
import { escapeInvisible } from './invisible.mjs';

/** Capability tiers, cheapest first. Index order is the escalation ladder. */
export const TIER_ORDER = TIER_KEYS;

export const RISK_LEVELS = Object.freeze(['low', 'normal', 'high']);

/**
 * Role -> tier, per cost profile.
 *
 * Read the table as a claim about where model strength CHANGES an outcome.
 * A scout reports what a file says; a stronger model does not make the file
 * say something else. A security reviewer decides whether a hole is real,
 * and a miss there survives every downstream check, because everything
 * downstream trusts it.
 */
export const ROLE_TIERS = Object.freeze({
  scout: { eco: 'cheap', balanced: 'cheap', full: 'work' },
  implementer: { eco: 'work', balanced: 'work', full: 'deep' },
  reviewer: { eco: 'work', balanced: 'work', full: 'deep' },
  'security-review': { eco: 'top', balanced: 'top', full: 'top' },
  arbitration: { eco: 'top', balanced: 'top', full: 'top' },
  acceptance: { eco: 'deep', balanced: 'top', full: 'top' },
  retro: { eco: 'work', balanced: 'work', full: 'deep' },
  bookkeeping: { eco: 'cheap', balanced: 'cheap', full: 'cheap' },
});

/**
 * Roles that may never be routed BELOW this tier, whatever the profile or the
 * risk argument says.
 *
 * Without the floor, `--profile eco --risk low` is a one-flag downgrade of the
 * two judgements the whole design leans on. The floor is applied last, after
 * the risk shift, so it cannot be shifted out of.
 */
export const ROLE_FLOOR = Object.freeze({
  'security-review': 'top',
  arbitration: 'top',
});

export const ROLES = Object.freeze(Object.keys(ROLE_TIERS));

/** Resolve role + profile + risk to a tier KEY (no model names involved). */
export function resolveTier(role, profile, risk = 'normal') {
  if (!Object.hasOwn(ROLE_TIERS, role)) {
    throw new Error(`unknown role "${escapeInvisible(role)}" (known: ${ROLES.join(', ')})`);
  }
  if (!PROFILES.includes(profile)) {
    throw new Error(`unknown profile "${escapeInvisible(profile)}" (known: ${PROFILES.join(', ')})`);
  }
  if (!RISK_LEVELS.includes(risk)) {
    throw new Error(`unknown risk "${escapeInvisible(risk)}" (known: ${RISK_LEVELS.join(', ')})`);
  }

  const base = ROLE_TIERS[role][profile];
  const shift = risk === 'high' ? 1 : risk === 'low' ? -1 : 0;
  const shifted = TIER_ORDER[clamp(TIER_ORDER.indexOf(base) + shift, 0, TIER_ORDER.length - 1)];

  const floor = ROLE_FLOOR[role];
  if (floor && TIER_ORDER.indexOf(shifted) < TIER_ORDER.indexOf(floor)) return floor;
  return shifted;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Resolve to the model alias the config maps that tier to.
 *
 * Throws rather than returning undefined on a missing alias. A spawn with
 * `model: undefined` silently runs on the session default, which is the
 * failure this file exists to prevent: the routing appears to work and is
 * not applied.
 */
export function resolveModel(config, role, profile, risk = 'normal') {
  const tier = resolveTier(role, profile, risk);
  const alias = config?.tiers?.[tier];
  if (typeof alias !== 'string' || alias.length === 0) {
    throw new Error(`config has no model alias for tier "${tier}" — fix tiers in .tyran/config.yaml`);
  }
  return { tier, model: alias };
}

/** The whole routing map for one profile — what the conductor reads once. */
export function resolveAll(config, profile, risk = 'normal') {
  const out = {};
  for (const role of ROLES) out[role] = resolveModel(config, role, profile, risk);
  return out;
}

/**
 * Load a config document, falling back to the plugin's shipped template.
 *
 * The fallback is LOUD on purpose. A repo that has not run setup yet still
 * gets working routing, but the operator is told which file the numbers came
 * from — a silent fallback would let a repo believe it had adopted a policy
 * it never wrote.
 */
export function loadConfig(configPath, pluginRoot, warn = () => {}) {
  let path = configPath;
  if (!existsSync(path)) {
    const fallback = join(pluginRoot, 'templates', 'config.yaml');
    if (!existsSync(fallback)) throw new Error(`no config at ${escapeInvisible(path)} and no shipped template`);
    warn(`tiers: ${escapeInvisible(path)} not found — falling back to the shipped template ${escapeInvisible(fallback)}`);
    path = fallback;
  }
  const doc = parse(readFileSync(path, 'utf8'));
  const errors = validateConfig(doc);
  if (errors.length > 0) {
    throw new Error(`invalid config at ${escapeInvisible(path)}:\n  ${errors.join('\n  ')}`);
  }
  return { doc, path };
}

/** `profile` may carry provenance (`{value, source, ...}`) — unwrap either shape. */
export function readProfile(doc) {
  const raw = doc?.profile;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.value : raw;
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };

  const pluginRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
  const configPath = resolve(flag('config', join(process.cwd(), '.tyran', 'config.yaml')));

  let doc;
  let path;
  try {
    ({ doc, path } = loadConfig(configPath, pluginRoot, (m) => console.error(m)));
  } catch (error) {
    console.error(`tiers: ${error.message}`);
    process.exit(2);
  }

  const profile = flag('profile', readProfile(doc));
  const risk = flag('risk', 'normal');
  const role = flag('role', null);

  try {
    if (role === null) {
      console.log(JSON.stringify({ config: path, profile, risk, roles: resolveAll(doc, profile, risk) }, null, 2));
    } else {
      const { tier, model } = resolveModel(doc, role, profile, risk);
      console.error(`tiers: ${role} @ ${profile}/${risk} -> ${tier}`);
      console.log(model);
    }
  } catch (error) {
    console.error(`tiers: ${error.message}`);
    process.exit(2);
  }
}

/**
 * BOTH sides must be symlink-resolved. `import.meta.url` already names the
 * real file; `process.argv[1]` is whatever the caller typed. Comparing them
 * raw turns every invocation through a symlinked path into a silent no-op
 * under exit 0 — and `/tmp` and `/var` are symlinks on macOS, so plugin
 * installs reach `scripts/` through one as the ordinary case. This bug was
 * found in desc-budget.mjs; the fix belongs everywhere the pattern is used.
 */
function canonicalPath(path) {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  return canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(moduleUrl));
}

if (isMainModule(import.meta.url)) main();
