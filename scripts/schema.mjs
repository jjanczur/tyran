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
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, YamlLiteError } from './yaml-lite.mjs';
import { escapeInvisible } from './invisible.mjs';

export const PROFILES = Object.freeze(['eco', 'balanced', 'full']);
export const AUTONOMY_CLASSES = Object.freeze(['P1', 'P2', 'P3']);
/**
 * Capability tiers, cheapest first. Four rather than three because "expensive"
 * is not one thing: `deep` buys harder reasoning for root-cause work, `top`
 * is reserved for the calls where being wrong is expensive AND hard to notice
 * (security review, arbitration, acceptance). Collapsing them into one tier
 * means every escalation pays the top price, which is how a cost mode stops
 * being used at all.
 */
export const TIER_KEYS = Object.freeze(['cheap', 'work', 'deep', 'top']);
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

  const known = ['profile', 'autonomy', 'tiers', 'validation', 'shared_zones', 'budget', 'main_writable_paths', 'limits', 'pricing', 'spend', 'board'];
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

  if (!('tiers' in doc)) errors.push(`tiers: required (${TIER_KEYS.join(', ')})`);
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

  // Out-of-repo paths the MAIN thread may write, on top of the built-in memory
  // store, plans dir and scratchpad. A `~` is expanded to the home directory;
  // globs are the same `*`/`**` the policy uses. Never widens what a SUBAGENT
  // may do — the gate enforces the actor split, this only lists paths.
  if ('main_writable_paths' in doc) {
    if (!Array.isArray(doc.main_writable_paths)) {
      errors.push('main_writable_paths: must be a list of path globs');
    } else {
      doc.main_writable_paths.forEach((p, i) => {
        if (!isNonEmptyString(p)) errors.push(`main_writable_paths[${i}]: must be a non-empty path glob`);
      });
    }
  }

  // Overnight mode: usage-limit pause/resume. Optional; absent = feature off.
  // Operator-written policy, never scanner-inferred — no provenance wrapper.
  if ('limits' in doc) {
    if (!isPlainObject(doc.limits)) errors.push('limits: must be a mapping');
    else {
      const limits = doc.limits;
      if (!LIMITS_MODES.includes(limits.mode)) {
        errors.push(`limits.mode: required, one of ${LIMITS_MODES.join(' | ')}`);
      }
      // Floor of 50 catches the classic footgun: 0.97 (a fraction pasted where
      // a percent belongs) would otherwise pause on the first tool call of
      // every session.
      for (const key of ['pause_at_percent', 'weekly_pause_at_percent']) {
        if (key in limits && (typeof limits[key] !== 'number' || limits[key] < 50 || limits[key] > 100)) {
          errors.push(`limits.${key}: must be a number in [50, 100]`);
        }
      }
      if ('wait_max_hours' in limits && (typeof limits.wait_max_hours !== 'number' || limits.wait_max_hours <= 0 || limits.wait_max_hours > 24)) {
        errors.push('limits.wait_max_hours: must be a number in (0, 24]');
      }
      if ('long_wait' in limits && !LIMITS_LONG_WAIT.includes(limits.long_wait)) {
        errors.push(`limits.long_wait: must be one of ${LIMITS_LONG_WAIT.join(' | ')}`);
      }
      if ('resume_margin_minutes' in limits && (typeof limits.resume_margin_minutes !== 'number' || limits.resume_margin_minutes <= 0 || limits.resume_margin_minutes > 240)) {
        errors.push('limits.resume_margin_minutes: must be a number in (0, 240]');
      }
      // Boolean only, and rejected rather than coerced: this knob spawns a
      // process that changes the operator's machine, so a value nobody can
      // read as a switch must be a complaint, not a guess.
      if ('keep_awake' in limits && typeof limits.keep_awake !== 'boolean') {
        errors.push('limits.keep_awake: must be true or false');
      }
      const knownLimits = ['mode', 'pause_at_percent', 'weekly_pause_at_percent', 'wait_max_hours', 'long_wait', 'resume_margin_minutes', 'keep_awake'];
      for (const key of Object.keys(limits)) {
        if (!knownLimits.includes(key)) errors.push(`limits.${key}: unknown key`);
      }
    }
  }

  // What a model costs per million tokens. Operator-written from a vendor's
  // price list — never scanner-inferred, so no provenance wrapper, exactly
  // like `limits:`. Absent means the cost report shows tokens and no money,
  // which is the honest default: Tyran does not know what anyone pays.
  if ('pricing' in doc) {
    if (!isPlainObject(doc.pricing)) errors.push('pricing: must be a mapping');
    else {
      const pricing = doc.pricing;
      // The rate card's NAME travels with every amount it produces. Two people
      // quoting different cards produce different money from one set of
      // tokens, and a figure that cannot say which card it came from is not a
      // measurement.
      if ('rate_card' in pricing && !isNonEmptyString(pricing.rate_card)) {
        errors.push('pricing.rate_card: must be a non-empty label');
      }
      if ('models' in pricing) {
        if (!isPlainObject(pricing.models)) errors.push('pricing.models: must be a mapping of model id to rates');
        else {
          for (const [model, rates] of Object.entries(pricing.models)) {
            if (!isPlainObject(rates)) {
              errors.push(`pricing.models.${model}: must be a mapping of rate name to price per million tokens`);
              continue;
            }
            for (const key of Object.keys(rates)) {
              if (!PRICING_RATE_KEYS.includes(key)) {
                errors.push(`pricing.models.${model}.${key}: unknown rate, one of ${PRICING_RATE_KEYS.join(' | ')}`);
              }
            }
            for (const key of PRICING_RATE_KEYS) {
              // `cache_write_1h` is the one OPTIONAL rate: cards written
              // before the 1-hour price existed carry four keys, and failing
              // them on upgrade would unprice a working ledger. Absent, it
              // falls back to the 5-minute rate in `pricingOf`.
              if (!(key in rates)) {
                if (PRICING_REQUIRED_RATE_KEYS.includes(key)) errors.push(`pricing.models.${model}.${key}: required`);
              } else if (typeof rates[key] !== 'number' || !Number.isFinite(rates[key]) || rates[key] < 0) {
                errors.push(`pricing.models.${model}.${key}: must be a non-negative number (price per million tokens)`);
              }
            }
          }
        }
      }
      const knownPricing = ['rate_card', 'models'];
      for (const key of Object.keys(pricing)) {
        if (!knownPricing.includes(key)) errors.push(`pricing.${key}: unknown key`);
      }
    }
  }

  // Where cost.mjs should look for THIS repo's transcripts, when the
  // derived-slug / cwd-probe fallback lands on the wrong session — a
  // conductor that ran from a working directory other than the repo it
  // operates on. Operator-written, never scanner-inferred, exactly like
  // `pricing:` and `limits:` above, and optional for the same reason: absence
  // means the existing fallback resolution applies, unchanged.
  if ('spend' in doc) {
    if (!isPlainObject(doc.spend)) errors.push('spend: must be a mapping');
    else {
      const spend = doc.spend;
      if ('transcript_dirs' in spend) {
        if (!Array.isArray(spend.transcript_dirs)) {
          errors.push('spend.transcript_dirs: must be a list of directory paths');
        } else {
          spend.transcript_dirs.forEach((d, i) => {
            if (!isNonEmptyString(d)) errors.push(`spend.transcript_dirs[${i}]: must be a non-empty path`);
          });
        }
      }
      const knownSpend = ['transcript_dirs'];
      for (const key of Object.keys(spend)) {
        if (!knownSpend.includes(key)) errors.push(`spend.${key}: unknown key`);
      }
    }
  }

  // The dashboard's own switches. Absent means the DEFAULTS below apply, and
  // those defaults are ON — the board is where everything Tyran does becomes
  // legible, and an install that leaves it off is an install where none of it
  // is. This block exists to turn it DOWN, which is why every key is optional.
  if ('board' in doc) {
    if (!isPlainObject(doc.board)) errors.push('board: must be a mapping');
    else {
      const board = doc.board;
      for (const key of ['autostart', 'write', 'open']) {
        if (key in board && typeof board[key] !== 'boolean') {
          errors.push(`board.${key}: must be true or false (quote 'off'/'on' if you meant a string — bare ones are YAML booleans)`);
        }
      }
      if ('port' in board) {
        const port = board.port;
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          errors.push('board.port: must be an integer in (0, 65535]');
        }
      }
      const knownBoard = ['autostart', 'port', 'write', 'open'];
      for (const key of Object.keys(board)) {
        if (!knownBoard.includes(key)) errors.push(`board.${key}: unknown key`);
      }
    }
  }

  return errors;
}

/**
 * The board's settings, with the defaults applied.
 *
 * ONE function, because three callers need this answer — the session-start
 * hook that autostarts, the setup skill's command, and doctor — and three
 * copies of "default the port to 4173" is ADR-21 with a port number in it.
 *
 * `autostart` and `write` default TRUE. The board was previously reached only
 * by a human typing a blocking command, which meant that on any install where
 * nobody typed it, every projection Tyran writes existed and nothing read
 * them. Defaulting off would preserve exactly that.
 */
export const BOARD_DEFAULTS = Object.freeze({ autostart: true, port: 4173, write: true, open: false });

export function boardSettings(doc) {
  const board = isPlainObject(doc) && isPlainObject(doc.board) ? doc.board : {};
  return {
    autostart: typeof board.autostart === 'boolean' ? board.autostart : BOARD_DEFAULTS.autostart,
    port: Number.isInteger(board.port) && board.port > 0 && board.port <= 65535 ? board.port : BOARD_DEFAULTS.port,
    write: typeof board.write === 'boolean' ? board.write : BOARD_DEFAULTS.write,
    open: typeof board.open === 'boolean' ? board.open : BOARD_DEFAULTS.open,
  };
}

export const LIMITS_MODES = Object.freeze(['off', 'warn', 'pause']);
export const LIMITS_LONG_WAIT = Object.freeze(['hold', 'resume']);

/**
 * The limits block with defaults applied — the ONE place the defaults AND the
 * accepted ranges live. `doc` is a parsed config (or null); an absent or
 * invalid block is `off`. A value outside validateConfig's range is treated
 * as absent (the default applies): the gate must never ENFORCE a value the
 * schema rejects — `pause_at_percent: 0.97` enforced verbatim is a permanent
 * false pause, the exact footgun the validator's floor of 50 exists to catch.
 */
export function limitsOf(doc) {
  const limits = isPlainObject(doc) && isPlainObject(doc.limits) ? doc.limits : {};
  const mode = LIMITS_MODES.includes(limits.mode) ? limits.mode : 'off';
  const inRange = (value, min, max, { minExclusive = false } = {}) =>
    typeof value === 'number' && Number.isFinite(value) && (minExclusive ? value > min : value >= min) && value <= max;
  return {
    mode,
    pause_at_percent: inRange(limits.pause_at_percent, 50, 100) ? limits.pause_at_percent : 97,
    weekly_pause_at_percent:
      inRange(limits.weekly_pause_at_percent, 50, 100) ? limits.weekly_pause_at_percent : 97,
    wait_max_hours: inRange(limits.wait_max_hours, 0, 24, { minExclusive: true }) ? limits.wait_max_hours : 5,
    long_wait: LIMITS_LONG_WAIT.includes(limits.long_wait) ? limits.long_wait : 'hold',
    resume_margin_minutes:
      inRange(limits.resume_margin_minutes, 0, 240, { minExclusive: true }) ? limits.resume_margin_minutes : 5,
    // Opt-in, strictly: anything that is not the boolean true is off. Nothing
    // on any machine changes until an operator writes `keep_awake: true`.
    keep_awake: limits.keep_awake === true,
  };
}

/**
 * The four things a request is billed for. All four are REQUIRED on any model
 * an operator prices: a table carrying three of them would price the fourth at
 * zero, silently, and cache reads alone were measured at three quarters of a
 * real session's cost. A partial rate card is a wrong number, not a partial
 * one.
 */
/**
 * The rate keys an amount is computed from. `cache_write` is the 5-MINUTE
 * write and `cache_write_1h` the 1-hour one; they are DISJOINT counters, never
 * a total and a subset, because `costOf` multiplies every key by its rate and
 * sums — so an overlapping pair would silently bill the same tokens twice.
 */
export const PRICING_RATE_KEYS = Object.freeze(['input', 'cache_write', 'cache_write_1h', 'cache_read', 'output']);

/**
 * Rate keys a hand-written config MUST supply. `cache_write_1h` is absent from
 * this list on purpose: configs predating the 1-hour rate carry four keys, and
 * failing them would turn a Tyran upgrade into a silently unpriced ledger. A
 * config without it prices 1-hour writes at the 5-minute rate, which is the
 * best reading of "they only told us one cache-write number" — and it is
 * wrong in the direction of UNDER-reporting, so it is stated in the docs
 * rather than left to be inferred from a smaller bill.
 */
export const PRICING_REQUIRED_RATE_KEYS = Object.freeze(['input', 'cache_write', 'cache_read', 'output']);

/**
 * The pricing block, normalized — the ONE place the shape lives. Returns
 * `{ rate_card, models }` where `models` is a null-prototype table keyed by
 * the model id the platform reports, and `rate_card` is the label that must
 * travel with every amount derived from it (null when unlabelled).
 *
 * A model missing from the table gets NO entry here rather than a zero: the
 * caller must be able to tell "priced at nothing" from "not priced", because
 * the first is a number and the second is a gap that belongs on screen.
 * Rates that fail validateConfig's shape are dropped for the same reason the
 * usage gate drops out-of-range limits — enforcing a value the schema rejects
 * is how a bad config becomes a confident wrong answer.
 */
export function pricingOf(doc) {
  const pricing = isPlainObject(doc) && isPlainObject(doc.pricing) ? doc.pricing : {};
  const models = Object.create(null);
  if (isPlainObject(pricing.models)) {
    for (const [model, rates] of Object.entries(pricing.models)) {
      if (!isPlainObject(rates)) continue;
      const rate = (key) =>
        typeof rates[key] === 'number' && Number.isFinite(rates[key]) && rates[key] >= 0 ? rates[key] : null;
      const usable = PRICING_REQUIRED_RATE_KEYS.every((key) => rate(key) !== null);
      if (!usable) continue;
      const row = Object.create(null);
      for (const key of PRICING_REQUIRED_RATE_KEYS) row[key] = rates[key];
      // The one optional rate. Falling back to the 5-minute write keeps a
      // four-key config priced instead of dropping it into `unpriced`.
      row.cache_write_1h = rate('cache_write_1h') ?? row.cache_write;
      models[model] = row;
    }
  }
  return {
    rate_card: isNonEmptyString(pricing.rate_card) ? pricing.rate_card : null,
    models,
  };
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
 * The size above which a knowledge entry stops being a brief-able fact and
 * starts being a document. `knowledge.mjs brief` selects entries into a
 * character budget; one 10 KB entry crowds out eight useful ones, visibly.
 */
export const KNOWLEDGE_ENTRY_MAX_CHARS = 4000;

/**
 * Advisory findings on a knowledge file that already validates. A separate
 * export rather than more `validateKnowledge` errors on purpose: a warning
 * must never flip `ok` for the existing consumers (validateFile, doctor, CI
 * template validation), or every install with one wordy entry goes red.
 */
export function knowledgeWarnings(doc) {
  if (!isPlainObject(doc) || !Array.isArray(doc.entries)) return [];
  const warnings = [];
  doc.entries.forEach((entry, i) => {
    if (!isPlainObject(entry) || typeof entry.text !== 'string') return;
    const size = Array.from(entry.text).length;
    if (size > KNOWLEDGE_ENTRY_MAX_CHARS) {
      const id = isNonEmptyString(entry.id) ? entry.id : `entries[${i}]`;
      warnings.push(
        `${id}: text is ${size} characters (max ${KNOWLEDGE_ENTRY_MAX_CHARS} before it crowds a brief) — ` +
          'split it, or move the bulk into a doc and keep the pointer here',
      );
    }
  });
  return warnings;
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

/**
 * Minimal glob: `**` spans separators, `*` does not.
 *
 * Exported so a caller can ask WHICH glob matched, which `classifyPath` cannot
 * answer: it applies `MANDATORY_KERNEL_PATHS` unconditionally and returns a
 * class, so probing it with a one-rule policy reports the first protected glob
 * for every protected path. The policy gate needs the real answer to name the
 * right authority in a refusal, and the only alternative was a fourth spelling
 * of glob matching in a repository that already counted three spellings of one
 * rule (ADR-21).
 */
export function globMatches(glob, filePath) {
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
      console.log(`ok    ${escapeInvisible(file)}`);
    } else {
      failed = true;
      console.log(`FAIL  ${escapeInvisible(file)}`);
      // Validation messages quote values read out of a YAML file, and a
      // .tyran/ tree can come from a template someone else wrote. Same channel
      // as project.warnings() and the journal CLI, closed the same way.
      for (const e of errors) console.log(`      - ${escapeInvisible(String(e))}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

/**
 * Absolute, symlink-resolved path; falls back to the merely absolute form when
 * realpath cannot follow argv[1] (the script directory was renamed after
 * launch, a parent component is unreadable, or a launcher rewrote argv[1] to a
 * logical name). Without the fallback the guard would throw out of module
 * scope and kill the tool at startup — a different bug, not a fix.
 */
function canonicalPath(path) {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * True when this module is the program's entry point.
 *
 * BOTH sides must be canonicalized. `import.meta.url` already names the real
 * file — Node resolves module specifiers through symlinks — while
 * `process.argv[1]` is whatever the caller typed. Comparing them raw turned
 * every invocation through a symlinked path into a SILENT no-op under exit 0:
 * `main()` never ran, no file was validated, and CI read that as "valid".
 * `/tmp` and `/var` are symlinks on macOS and plugin installs reach `scripts/`
 * through one, so this is the ordinary case rather than an exotic one.
 */
function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  return canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(moduleUrl));
}

if (isMainModule(import.meta.url)) main();
