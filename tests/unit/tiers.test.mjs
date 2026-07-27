/**
 * tiers — the single place a role becomes a model.
 *
 * The tests that matter here are not "does the table say what the table
 * says". They are the two ways this file can fail SILENTLY:
 *   - a missing alias resolving to `undefined`, which spawns on the session
 *     default and looks exactly like working routing;
 *   - a cheap profile or a low risk argument quietly demoting the two
 *     judgements everything downstream trusts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROLES,
  ROLE_TIERS,
  ROLE_FLOOR,
  ROLE_EFFORT_FLOOR,
  TIER_ORDER,
  EFFORT_ORDER,
  EFFORT_BY_TIER,
  resolveTier,
  resolveEffort,
  resolveModel,
  resolveAll,
  loadConfig,
  readProfile,
} from '../../scripts/tiers.mjs';
import { PROFILES } from '../../scripts/schema.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/tiers.mjs', import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const CONFIG = 'profile: balanced\nautonomy: P1\ntiers:\n  cheap: haiku\n  work: sonnet\n  deep: opus\n  top: fable\n';

function repoWithConfig(text = CONFIG) {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-tiers-'));
  mkdirSync(join(dir, '.tyran'));
  writeFileSync(join(dir, '.tyran', 'config.yaml'), text);
  return dir;
}

test('every role resolves to a real tier in every profile', () => {
  for (const role of ROLES) {
    for (const profile of PROFILES) {
      assert.ok(TIER_ORDER.includes(resolveTier(role, profile)), `${role}/${profile}`);
    }
  }
});

test('the default profile puts ordinary work on `work`, not on the expensive tiers', () => {
  // The whole point of the cost design. If this flips, every initiative pays
  // the top price for mechanical edits and the profile stops being used.
  assert.equal(resolveTier('implementer', 'balanced'), 'work');
  assert.equal(resolveTier('reviewer', 'balanced'), 'work');
  assert.equal(resolveTier('scout', 'balanced'), 'cheap');
});

test('security review and arbitration cannot be demoted by profile or by risk', () => {
  for (const role of Object.keys(ROLE_FLOOR)) {
    for (const profile of PROFILES) {
      for (const risk of ['low', 'normal', 'high']) {
        assert.equal(resolveTier(role, profile, risk), ROLE_FLOOR[role], `${role}/${profile}/${risk}`);
      }
    }
  }
  // And the floor is not merely the table agreeing with itself: a role whose
  // table entry sits BELOW its floor still resolves to the floor.
  assert.equal(TIER_ORDER.indexOf(ROLE_FLOOR['security-review']), TIER_ORDER.length - 1);
});

test('risk shifts by exactly one tier and clamps at both ends', () => {
  assert.equal(resolveTier('reviewer', 'balanced', 'high'), 'deep');
  assert.equal(resolveTier('reviewer', 'balanced', 'low'), 'cheap');
  // bookkeeping is already at the bottom; `low` must not fall off the ladder
  assert.equal(resolveTier('bookkeeping', 'eco', 'low'), 'cheap');
  // acceptance in `full` is already at the top; `high` must not overflow
  assert.equal(resolveTier('acceptance', 'full', 'high'), 'top');
});

test('an unknown role, profile or risk throws instead of picking something', () => {
  assert.throws(() => resolveTier('architect', 'balanced'), /unknown role/);
  assert.throws(() => resolveTier('reviewer', 'turbo'), /unknown profile/);
  assert.throws(() => resolveTier('reviewer', 'balanced', 'extreme'), /unknown risk/);
});

test('a missing alias THROWS rather than resolving to undefined', () => {
  // This is the silent failure the module exists to prevent: `model:
  // undefined` at spawn runs on the session default and is indistinguishable
  // from routing that worked.
  const noDeep = { tiers: { cheap: 'haiku', work: 'sonnet', top: 'fable' } };
  assert.throws(() => resolveModel(noDeep, 'implementer', 'full'), /no model alias for tier "deep"/);
  const empty = { tiers: { cheap: '', work: 's', deep: 'o', top: 'f' } };
  assert.throws(() => resolveModel(empty, 'scout', 'balanced'), /no model alias for tier "cheap"/);
  assert.throws(() => resolveModel(undefined, 'scout', 'balanced'), /no model alias/);
});

test('resolveAll covers every role and reports tier, model and effort', () => {
  const doc = { tiers: { cheap: 'haiku', work: 'sonnet', deep: 'opus', top: 'fable' } };
  const all = resolveAll(doc, 'balanced');
  assert.deepEqual(Object.keys(all).sort(), [...ROLES].sort());
  assert.deepEqual(all.scout, { tier: 'cheap', model: 'haiku', effort: 'low', floored: false });
  assert.deepEqual(all['security-review'], { tier: 'top', model: 'fable', effort: 'max', floored: false });
  assert.deepEqual(all.implementer, { tier: 'work', model: 'sonnet', effort: 'medium', floored: false });
});

// --- dynamic overrides: the conductor adjusting a single subtask -----------

test('the conductor can raise or lower the tier for one subtask', () => {
  assert.equal(resolveTier('implementer', 'balanced'), 'work');
  assert.equal(resolveTier('implementer', 'balanced', 'normal', { tier: 'deep' }), 'deep');
  assert.equal(resolveTier('implementer', 'balanced', 'normal', { tier: 'cheap' }), 'cheap');
});

test('effort is a SEPARATE dial — same model, think harder', () => {
  // The most common real adjustment: the task is not bigger, it is subtler.
  const doc = { tiers: { cheap: 'haiku', work: 'sonnet', deep: 'opus', top: 'fable' } };
  const base = resolveModel(doc, 'implementer', 'balanced');
  const harder = resolveModel(doc, 'implementer', 'balanced', 'normal', { effort: 'xhigh' });
  assert.equal(harder.model, base.model, 'raising effort must not silently change the model');
  assert.equal(harder.effort, 'xhigh');
  assert.equal(base.effort, 'medium');
});

test('a pinned tier still lets risk raise the effort', () => {
  // "Use the cheap model, but think hard about it" has to be expressible or
  // the conductor will reach for the expensive model to buy the reasoning.
  assert.equal(resolveEffort('implementer', 'balanced', 'high', { tier: 'cheap' }), 'medium');
  assert.equal(resolveEffort('implementer', 'balanced', 'normal', { tier: 'cheap' }), 'low');
});

test('an override CANNOT go below a role floor, on either ladder', () => {
  // The floor is applied last, after both the risk shift and the override.
  assert.equal(resolveTier('security-review', 'eco', 'low', { tier: 'cheap' }), 'top');
  assert.equal(resolveEffort('security-review', 'eco', 'low', { effort: 'low' }), 'max');
  assert.equal(resolveEffort('arbitration', 'eco', 'low', { effort: 'low' }), 'high');
});

test('a corrected override is REPORTED, not silently swallowed', () => {
  // A floor that quietly fixed the request would teach the conductor that its
  // overrides take effect when they did not.
  const doc = { tiers: { cheap: 'haiku', work: 'sonnet', deep: 'opus', top: 'fable' } };
  const r = resolveModel(doc, 'security-review', 'balanced', 'normal', { tier: 'cheap' });
  assert.equal(r.tier, 'top');
  assert.equal(r.floored, true);
  assert.equal(resolveModel(doc, 'implementer', 'balanced', 'normal', { tier: 'deep' }).floored, false);
});

test('an unknown tier or effort override throws rather than being ignored', () => {
  // Silently ignoring a typo is the worst outcome: the conductor believes it
  // escalated and nothing changed.
  assert.throws(() => resolveTier('implementer', 'balanced', 'normal', { tier: 'ultra' }), /unknown tier override/);
  assert.throws(() => resolveEffort('implementer', 'balanced', 'normal', { effort: 'lots' }), /unknown effort override/);
});

test('every tier has a default effort, and every role floor is on the ladder', () => {
  for (const tier of TIER_ORDER) assert.ok(EFFORT_ORDER.includes(EFFORT_BY_TIER[tier]), `no effort for ${tier}`);
  for (const [role, floor] of Object.entries(ROLE_EFFORT_FLOOR)) {
    assert.ok(ROLES.includes(role), `${role} is not a role`);
    assert.ok(EFFORT_ORDER.includes(floor), `${floor} is not an effort level`);
  }
});

test('CLI --field selects what lands on stdout', () => {
  const dir = repoWithConfig();
  const at = (args) =>
    execFileSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(at(['--role', 'implementer', '--field', 'effort']), 'medium');
  assert.equal(at(['--role', 'implementer', '--field', 'tier']), 'work');
  assert.equal(at(['--role', 'implementer', '--effort', 'max', '--field', 'effort']), 'max');
  assert.deepEqual(JSON.parse(at(['--role', 'scout', '--field', 'json'])), {
    tier: 'cheap',
    model: 'haiku',
    effort: 'low',
    floored: false,
  });
});

test('CLI announces on stderr when a floor overrode what was asked for', () => {
  const dir = repoWithConfig();
  const r = execFileSync(process.execPath, [SCRIPT, '--role', 'security-review', '--tier', 'cheap'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(r.trim(), 'fable');
});

test('no model name appears anywhere in the routing table itself', () => {
  // The single-source rule, asserted rather than trusted. If a model alias
  // leaks into ROLE_TIERS, a deprecation stops being a one-line change and
  // this test is the only thing that would notice.
  const tiersUsed = new Set(Object.values(ROLE_TIERS).flatMap((row) => Object.values(row)));
  for (const tier of tiersUsed) assert.ok(TIER_ORDER.includes(tier), `"${tier}" is not a tier key`);
});

test('loadConfig falls back to the shipped template but says so out loud', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-tiers-empty-'));
  const warnings = [];
  const { doc, path } = loadConfig(join(dir, '.tyran', 'config.yaml'), PLUGIN_ROOT, (m) => warnings.push(m));
  assert.equal(warnings.length, 1, 'a silent fallback would let a repo believe it adopted a policy it never wrote');
  assert.match(warnings[0], /falling back/);
  assert.match(path, /templates[/\\]config\.yaml$/);
  assert.equal(readProfile(doc), 'balanced');
});

test('an invalid config throws instead of resolving from a broken document', () => {
  const dir = repoWithConfig('profile: turbo\nautonomy: P1\ntiers:\n  cheap: haiku\n  work: sonnet\n  deep: opus\n  top: fable\n');
  assert.throws(() => loadConfig(join(dir, '.tyran', 'config.yaml'), PLUGIN_ROOT), /invalid config/);
});

test('readProfile unwraps a provenanced value', () => {
  assert.equal(readProfile({ profile: 'eco' }), 'eco');
  assert.equal(readProfile({ profile: { value: 'full', source: 'inferred', confidence: 0.8 } }), 'full');
});

test('CLI prints one model alias on stdout so a spawn can interpolate it', () => {
  const dir = repoWithConfig();
  const out = execFileSync(process.execPath, [SCRIPT, '--role', 'reviewer', '--risk', 'high'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(out.trim(), 'opus', 'stdout must be the alias alone — the tier explanation belongs on stderr');
});

test('CLI without --role prints the whole map as JSON', () => {
  const dir = repoWithConfig();
  const out = execFileSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const parsed = JSON.parse(out);
  assert.equal(parsed.profile, 'balanced');
  assert.equal(parsed.roles.implementer.model, 'sonnet');
});

test('CLI exits 2 on an unknown role rather than falling back to a default', () => {
  const dir = repoWithConfig();
  try {
    execFileSync(process.execPath, [SCRIPT, '--role', 'nope'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    assert.fail('an unknown role must not exit 0');
  } catch (error) {
    assert.equal(error.status, 2);
    assert.match(String(error.stderr), /unknown role/);
  }
});

test('the shipped template resolves for every role — CI would otherwise ship a broken default', () => {
  const { doc } = loadConfig(join(PLUGIN_ROOT, 'templates', 'config.yaml'), PLUGIN_ROOT);
  for (const profile of PROFILES) {
    const all = resolveAll(doc, profile);
    for (const role of ROLES) assert.ok(all[role].model.length > 0, `${role}/${profile}`);
  }
});
