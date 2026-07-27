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
 * The table is a STARTING POINT, not a prediction of every task. The
 * conductor may override the tier or the effort for one subtask when it can
 * see that the default does not fit — that is the intended use, not an
 * escape. The one thing an override cannot do is go below a role floor, and
 * when a floor corrects an override the CLI says so out loud rather than
 * quietly handing back something other than what was asked for.
 *
 * CLI:
 *   node tiers.mjs [--config <path>] [--profile P] [--role R] [--risk L]
 *                  [--tier T] [--effort E] [--field model|tier|effort|json]
 *   node tiers.mjs --role reviewer --risk high            # -> a model alias
 *   node tiers.mjs --role implementer --effort high       # same model, think harder
 *   node tiers.mjs --role reviewer --field json           # -> {tier, model, effort}
 *   node tiers.mjs                                        # -> the whole map, JSON
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

/** Reasoning effort, cheapest first. Same ladder semantics as the tiers. */
export const EFFORT_ORDER = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Default effort for a tier.
 *
 * Effort and model are separate dials on purpose. Most of the time raising
 * one without the other is the right move: a mechanical sweep on a strong
 * model still does not need deep reasoning, and a subtle diagnosis on the
 * middle model often does. Collapsing them into a single "power" setting is
 * what makes cost modes blunt enough to be ignored.
 */
export const EFFORT_BY_TIER = Object.freeze({
  cheap: 'low',
  work: 'medium',
  deep: 'high',
  top: 'xhigh',
});

/**
 * Roles whose effort may never drop below this, whatever the tier says.
 *
 * The reasoning here is the same as the tier floor and it is worth stating
 * twice: a security review that misses a hole is not corrected downstream,
 * because everything downstream trusts it.
 */
export const ROLE_EFFORT_FLOOR = Object.freeze({
  'security-review': 'max',
  arbitration: 'high',
});

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

function validateInputs(role, profile, risk) {
  if (!Object.hasOwn(ROLE_TIERS, role)) {
    throw new Error(`unknown role "${escapeInvisible(role)}" (known: ${ROLES.join(', ')})`);
  }
  if (!PROFILES.includes(profile)) {
    throw new Error(`unknown profile "${escapeInvisible(profile)}" (known: ${PROFILES.join(', ')})`);
  }
  if (!RISK_LEVELS.includes(risk)) {
    throw new Error(`unknown risk "${escapeInvisible(risk)}" (known: ${RISK_LEVELS.join(', ')})`);
  }
}

/**
 * Resolve role + profile + risk to a tier KEY (no model names involved).
 *
 * `override.tier` is the conductor deciding, in the moment, that this
 * particular subtask needs something the table did not anticipate. That is a
 * legitimate and expected move — the table is a starting point, not a
 * prediction of every task. What the override may NOT do is go below a role
 * floor, which is applied last, after both the risk shift and the override.
 */
export function resolveTier(role, profile, risk = 'normal', override = {}) {
  validateInputs(role, profile, risk);

  let tier;
  if (override.tier !== undefined && override.tier !== null) {
    if (!TIER_ORDER.includes(override.tier)) {
      throw new Error(`unknown tier override "${escapeInvisible(override.tier)}" (known: ${TIER_ORDER.join(', ')})`);
    }
    tier = override.tier;
  } else {
    const base = ROLE_TIERS[role][profile];
    const shift = risk === 'high' ? 1 : risk === 'low' ? -1 : 0;
    tier = TIER_ORDER[clamp(TIER_ORDER.indexOf(base) + shift, 0, TIER_ORDER.length - 1)];
  }

  return raiseTo(TIER_ORDER, tier, ROLE_FLOOR[role]);
}

/**
 * Resolve reasoning effort the same way, on its own ladder.
 *
 * Effort follows the tier by default and is separately overridable, because
 * "this needs more thinking" and "this needs a stronger model" are different
 * judgements and the conductor routinely has one without the other.
 */
export function resolveEffort(role, profile, risk = 'normal', override = {}) {
  validateInputs(role, profile, risk);

  let effort;
  if (override.effort !== undefined && override.effort !== null) {
    if (!EFFORT_ORDER.includes(override.effort)) {
      throw new Error(
        `unknown effort override "${escapeInvisible(override.effort)}" (known: ${EFFORT_ORDER.join(', ')})`,
      );
    }
    effort = override.effort;
  } else {
    const tier = resolveTier(role, profile, risk, override);
    const base = EFFORT_BY_TIER[tier];
    // The risk shift applies to effort even when the tier was pinned by an
    // override: "same model, think harder" is the single most common thing
    // the conductor actually wants.
    const shift = risk === 'high' ? 1 : risk === 'low' ? -1 : 0;
    effort = EFFORT_ORDER[clamp(EFFORT_ORDER.indexOf(base) + shift, 0, EFFORT_ORDER.length - 1)];
  }

  return raiseTo(EFFORT_ORDER, effort, ROLE_EFFORT_FLOOR[role]);
}

/** Raise `value` to `floor` when a floor exists and sits above it. */
function raiseTo(ladder, value, floor) {
  if (floor && ladder.indexOf(value) < ladder.indexOf(floor)) return floor;
  return value;
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
export function resolveModel(config, role, profile, risk = 'normal', override = {}) {
  const tier = resolveTier(role, profile, risk, override);
  const effort = resolveEffort(role, profile, risk, override);
  const alias = config?.tiers?.[tier];
  if (typeof alias !== 'string' || alias.length === 0) {
    throw new Error(`config has no model alias for tier "${tier}" — fix tiers in .tyran/config.yaml`);
  }
  const floored =
    (ROLE_FLOOR[role] !== undefined && override.tier !== undefined && override.tier !== ROLE_FLOOR[role]) ||
    (ROLE_EFFORT_FLOOR[role] !== undefined && override.effort !== undefined && override.effort !== effort);
  return { tier, model: alias, effort, floored };
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
  const field = flag('field', 'model');
  const override = { tier: flag('tier', undefined), effort: flag('effort', undefined) };

  try {
    if (role === null) {
      console.log(JSON.stringify({ config: path, profile, risk, roles: resolveAll(doc, profile, risk) }, null, 2));
      return;
    }
    const resolved = resolveModel(doc, role, profile, risk, override);
    const asked = override.tier ?? override.effort;
    // A floor that silently corrected an explicit override would teach the
    // conductor that its overrides work when they did not. Say it.
    if (resolved.floored) {
      console.error(
        `tiers: override "${escapeInvisible(String(asked))}" RAISED to ${resolved.tier}/${resolved.effort} — ` +
          `"${escapeInvisible(role)}" has a floor that cannot be lowered`,
      );
    }
    console.error(`tiers: ${role} @ ${profile}/${risk} -> ${resolved.tier} · effort ${resolved.effort}`);
    if (field === 'json') console.log(JSON.stringify(resolved));
    else if (Object.hasOwn(resolved, field)) console.log(resolved[field]);
    else {
      console.error(`tiers: unknown --field "${escapeInvisible(field)}" (known: model, tier, effort, json)`);
      process.exit(2);
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
