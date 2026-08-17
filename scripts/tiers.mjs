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
import { APPROVING_RE } from './project.mjs';
import { readJournal } from './journal.mjs';
import { handleArgs } from './cli-args.mjs';

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
  // Authoring a prompt is the one output nothing downstream checks: a skill
  // that reads plausibly passes review, and a weak one misroutes every run
  // that obeys it, quietly, for as long as it ships. Thinking harder is the
  // cheapest correction available and it is paid once per skill, not per run.
  authoring: 'max',
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
  // Writing a PROMPT — a skill, an agent, the conductor's own instructions.
  //
  // Separated from `retro` because retro does two unlike things with one
  // agent: reading a ledger and folding counters, which the middle model does
  // fine, and authoring the text that every future session will obey. Routing
  // the whole of retro at `top` would spend the tier on bookkeeping; routing
  // the authoring at `work` is the failure this row exists to prevent.
  //
  // `top` at EVERY profile, with a floor under it, on the same argument
  // `security-review` already makes and a stronger version of it: a bad
  // security verdict costs one merge, while a bad prompt misroutes every run
  // that reads it, for as long as it ships. It is also the one output nothing
  // downstream checks — a skill that reads plausibly passes review, and the
  // cost surfaces later as work done slightly wrong, everywhere, quietly.
  authoring: { eco: 'top', balanced: 'top', full: 'top' },
  bookkeeping: { eco: 'cheap', balanced: 'cheap', full: 'cheap' },
  // Mechanical validation: run the named commands, report counts and exit
  // codes, compare against a baseline. Cheap at EVERY profile because model
  // strength does not change what `node --test` prints — the same claim the
  // scout row makes about reading files. There is deliberately no floor and
  // no escalation: a red suite is the verifier SUCCEEDING, so `--journal
  // --ticket` attempt-counting must never be pointed at this role.
  verifier: { eco: 'cheap', balanced: 'cheap', full: 'cheap' },
  // ADVISORY. The conductor is the operator's own session, and no plugin can
  // change a running session's model — so this row records the choice in the
  // one file where model names may live and the CLI says out loud, on stderr,
  // that it cannot enforce it. A row that silently did nothing would be worse
  // than no row: it would read as configuration.
  conductor: { eco: 'deep', balanced: 'top', full: 'top' },
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
  // So `--profile eco --risk low` cannot quietly write the next skill on the
  // cheap tier. Every other floor here protects a judgement made once; this
  // one protects a judgement every later session inherits.
  authoring: 'top',
  // One weak coordinator spends a whole team's budget on the wrong plan, and
  // the floor is what `--profile eco --risk low` cannot shift out of.
  conductor: 'deep',
});

export const ROLES = Object.freeze(Object.keys(ROLE_TIERS));

/**
 * The tier a fallback or an escalation may never pass.
 *
 * `top` is the most expensive thing Tyran can spend, and an automatic climb to
 * it is a decision about money made while nobody is watching. Roles whose
 * FLOOR is already `top` still resolve there — this bounds what escalation
 * ADDS, not what the table asks for.
 */
export const ESCALATION_CEILING = 'deep';

/** How many steps repeated failure may add, however many attempts there were. */
export const MAX_ESCALATION_STEPS = 2;

/**
 * What the journal says about a ticket that is being re-tried.
 *
 * Both facts live in the ledger rather than in the conductor's memory, which
 * iron rule 7 already names the least reliable store in the system: a session
 * that compacts, or a second conductor picking the work up, otherwise re-spawns
 * at the tier that has already failed twice and on the model that has already
 * run out.
 *
 *  - `attempts` counts reviews that did NOT approve. The regex is the board's
 *    own, imported, because "did this attempt fail" must not have two answers.
 *  - `unavailable` collects models an `error` event named as out of capacity.
 *    The convention is `{class: 'model-unavailable', model: '<alias>'}` and it
 *    is a convention on purpose: the failure surfaces inside a subagent's API
 *    call, where no hook can see it, so SOMETHING has to write it down before
 *    routing can act on it.
 */
export function ticketHistory(events, ticket) {
  const id = String(ticket);
  let attempts = 0;
  const unavailable = [];
  for (const e of events) {
    if (e?.ev === 'review' && String(e.data?.ticket) === id && !APPROVING_RE.test(String(e.data?.verdict ?? ''))) {
      attempts += 1;
    }
    if (e?.ev === 'error' && e.data?.class === 'model-unavailable' && typeof e.data?.model === 'string') {
      // NOT scoped to the ticket: a model that ran out is out for everything.
      if (!unavailable.includes(e.data.model)) unavailable.push(e.data.model);
    }
  }
  return { attempts, unavailable };
}

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
  const aliasFor = (key) => {
    const alias = config?.tiers?.[key];
    if (typeof alias !== 'string' || alias.length === 0) {
      throw new Error(`config has no model alias for tier "${key}" — fix tiers in .tyran/config.yaml`);
    }
    return alias;
  };
  const floored =
    (ROLE_FLOOR[role] !== undefined && override.tier !== undefined && override.tier !== ROLE_FLOOR[role]) ||
    (ROLE_EFFORT_FLOOR[role] !== undefined && override.effort !== undefined && override.effort !== effort);

  const unavailable = normalizeUnavailable(override.unavailable);
  // Escalation first, fallback second, and the order matters: a re-try should
  // ask for a stronger model, and only then discover whether that model is
  // available. Doing it the other way round would fall back from a tier the
  // run was never going to use.
  const attempts = Number.isInteger(override.attempts) && override.attempts > 0 ? override.attempts : 0;
  const climbed = attempts === 0 ? tier : escalateTier(tier, attempts);
  const resolved = {
    tier: climbed,
    model: aliasFor(climbed),
    effort,
    floored,
    fell_from: null,
    escalated_from: climbed === tier ? null : tier,
    attempts,
  };
  if (unavailable.length === 0 || !unavailable.includes(resolved.model)) return resolved;

  const substitute = fallbackTier(config, role, resolved.tier, unavailable);
  return {
    ...resolved,
    tier: substitute,
    model: aliasFor(substitute),
    // Effort follows the ORIGINAL tier, not the substitute. The judgement
    // "this task needs deep reasoning" did not change because a model ran out
    // of capacity, and dropping both dials at once turns a substitution into a
    // second, unasked-for downgrade.
    fell_from: resolved.tier,
  };
}

/**
 * One step up per failed attempt, capped twice over: by MAX_ESCALATION_STEPS,
 * and by the ceiling. A ticket that has failed four times does not need the
 * most expensive model in the table — it needs a human, and the board's
 * changes-requested lane is where that is already visible.
 */
function escalateTier(from, attempts) {
  const ceiling = Math.min(TIER_ORDER.indexOf(ESCALATION_CEILING), TIER_ORDER.length - 1);
  const start = TIER_ORDER.indexOf(from);
  // Never lower a role that already resolves above the ceiling.
  if (start >= ceiling) return from;
  return TIER_ORDER[Math.min(start + Math.min(attempts, MAX_ESCALATION_STEPS), ceiling)];
}

function normalizeUnavailable(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v) => typeof v === 'string' && v.length > 0);
}

/**
 * The next tier DOWN whose model is still available.
 *
 * Down, never up, and that is the answer to the question this feature was
 * blocked on. A fallback that climbed would spend more than the routing table
 * promised, silently, at the exact moment nobody is watching — and the whole
 * point of the table is that what a run costs is legible before it runs. Down
 * is also the direction the observed incident needed: the strongest tier hit
 * its limit while the tier below it had capacity, and the work died rather
 * than finishing on the model one step cheaper.
 *
 * The trade is stated rather than hidden: falling produces a WEAKER answer.
 * That is why it stops at the role floor instead of walking to the bottom —
 * a security review that ran on the cheapest model is not a security review,
 * and the floors already say which roles those are.
 */
export function fallbackTier(config, role, from, unavailable) {
  const floorIndex = ROLE_FLOOR[role] === undefined ? 0 : TIER_ORDER.indexOf(ROLE_FLOOR[role]);
  for (let i = TIER_ORDER.indexOf(from) - 1; i >= floorIndex; i -= 1) {
    const alias = config?.tiers?.[TIER_ORDER[i]];
    if (typeof alias === 'string' && alias.length > 0 && !unavailable.includes(alias)) return TIER_ORDER[i];
  }
  // Exhausting the ladder is NOT a substitution problem. Every model this role
  // is allowed to use is unavailable, which means waiting, not routing — and
  // the thing that already knows how to wait is overnight mode.
  const reachable = TIER_ORDER.slice(floorIndex, TIER_ORDER.indexOf(from) + 1);
  throw new Error(
    `every tier "${escapeInvisible(role)}" may use is unavailable (${reachable.join(' -> ')}), so there is ` +
      'nothing to fall back to. This is a pause, not a substitution: see docs/overnight.md.' +
      (ROLE_FLOOR[role] === undefined ? '' : ` The floor for this role is "${ROLE_FLOOR[role]}" and is not lowered by a fallback.`),
  );
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

/**
 * Every flag `main` reads. It is a LIST rather than a comment because the
 * parser below cannot derive it: `flag()` looks up the names it wants, so a
 * name it does not want is not rejected, it is unseen. `--rol reviewer` used
 * to print the entire routing table and exit 0 — a different answer to a
 * different question, with nothing said about the typo — while `--role
 * revieweer` one character later was refused by name. The value was checked
 * and the flag was not.
 */
export const TIERS_FLAGS = Object.freeze([
  'config', 'profile', 'risk', 'role', 'field', 'tier', 'effort', 'unavailable', 'journal', 'ticket',
]);

export const TIERS_USAGE =
  'usage: tiers.mjs [--config <config.yaml>] [--profile <p>] [--risk <normal|high>]\n' +
  '                 [--role <role>] [--field <model|effort|tier>] [--tier <t>] [--effort <e>]\n' +
  '                 [--unavailable <model>]... [--journal <path> --ticket <T-n>]\n' +
  'With no --role, prints the whole resolved routing table as JSON.';

function main() {
  const args = process.argv.slice(2);
  if (!handleArgs(args, { name: 'tiers', usage: TIERS_USAGE, known: TIERS_FLAGS })) return;
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
  // Repeatable: an overnight run can exhaust more than one tier.
  const unavailable = args.reduce((acc, arg, i) => (arg === '--unavailable' && args[i + 1] ? [...acc, args[i + 1]] : acc), []);
  // The ledger, not the conductor's memory. `--journal <path> --ticket T-n`
  // counts the failed attempts on that ticket and picks up any model an error
  // event has recorded as out of capacity, so a re-spawn after a compaction
  // routes the same way a re-spawn before it would have.
  const journalPath = flag('journal', null);
  const ticket = flag('ticket', null);
  let history = { attempts: 0, unavailable: [] };
  if (journalPath !== null && ticket !== null) {
    try {
      history = ticketHistory(readJournal(resolve(journalPath)).events, ticket);
    } catch (error) {
      // Routing must not depend on a readable journal: a missing or damaged
      // one means no history, which is the same answer as a first attempt.
      console.error(`tiers: could not read ${escapeInvisible(journalPath)} (${error.message}) — routing without history`);
    }
  }
  const override = {
    tier: flag('tier', undefined),
    effort: flag('effort', undefined),
    unavailable: [...unavailable, ...history.unavailable],
    attempts: history.attempts,
  };

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
    // STDERR, like every other note here: stdout is the resolved value and the
    // skill parses it.
    if (role === 'conductor') {
      console.error(
        'tiers: `conductor` is ADVISORY. The conductor is your own session and no plugin can ' +
          'change its model mid-flight — this is the tier your config says it should be running.',
      );
    }
    // A substitution that said nothing would be the routing table quietly
    // meaning something else than it says.
    if (resolved.escalated_from) {
      // The tier the CLIMB reached, which is what a fallback then fell FROM.
      // Reporting `resolved.tier` here narrated "work -> work" whenever both
      // happened, which is the one case where a reader most needs the two
      // steps told apart.
      const climbedTo = resolved.fell_from ?? resolved.tier;
      console.error(
        `tiers: ESCALATED ${resolved.escalated_from} -> ${climbedTo} after ${resolved.attempts} failed attempt(s) ` +
          `on ${escapeInvisible(String(ticket))} (ceiling ${ESCALATION_CEILING}).`,
      );
    }
    if (resolved.fell_from !== null) {
      console.error(
        `tiers: FELL BACK ${resolved.fell_from} -> ${resolved.tier} because the ${resolved.fell_from} model is ` +
          'unavailable. This is a WEAKER model than the routing table asked for; effort is unchanged.',
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
