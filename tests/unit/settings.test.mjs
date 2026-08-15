import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTONOMY_CLASSES, LIMITS_MODES, PROFILES, TIER_KEYS, validateConfig, validatePolicy } from '../../scripts/schema.mjs';
import { parse } from '../../scripts/yaml-lite.mjs';
import { renderConfig, scanRepo } from '../../scripts/scan-repo.mjs';
import { GROUPS, SettingsError, allSettings, applyPolicyClass, applySetting, readSettings } from '../../scripts/settings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A .tyran directory seeded from the shipped templates. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-settings-'));
  const tyran = join(dir, '.tyran');
  mkdirSync(join(tyran, 'policies'), { recursive: true });
  writeFileSync(join(tyran, 'config.yaml'), readFileSync(join(ROOT, 'templates', 'config.yaml'), 'utf8'));
  writeFileSync(join(tyran, 'policies', 'autonomy.yaml'), readFileSync(join(ROOT, 'templates', 'policies', 'autonomy.yaml'), 'utf8'));
  return { dir, tyran, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** applySetting returns the text; the server writes it. Do both here. */
function write(tyran, applied) {
  writeFileSync(applied.file, applied.text);
  return applied;
}

test('reads every knob out of the shipped template with its value', () => {
  const f = fixture();
  try {
    const s = readSettings(f.tyran);
    const flat = s.groups.flatMap((g) => g.settings);
    assert.equal(flat.length, allSettings().length);
    assert.ok(flat.every((x) => x.present === true), 'the template sets every knob the catalogue offers');
    const byId = new Map(flat.map((x) => [x.id, x.value]));
    assert.equal(byId.get('profile'), 'balanced');
    assert.equal(byId.get('autonomy'), 'P1');
    assert.equal(byId.get('limits.mode'), 'off');
    assert.equal(byId.get('limits.keep_awake'), false);
    assert.deepEqual(byId.get('shared_zones'), []);
  } finally {
    f.cleanup();
  }
});

test('the choices offered are the ones the validator accepts', () => {
  // ADR-21: a second list of legal values here would drift from the one that
  // enforces it, and the page would offer a choice the file rejects.
  // MUTANT: hard-code ['eco','balanced'] in the catalogue.
  const byId = new Map(allSettings().map((s) => [s.id, s]));
  assert.deepEqual(byId.get('profile').choices.map((c) => c.value), [...PROFILES]);
  assert.deepEqual(byId.get('autonomy').choices.map((c) => c.value), [...AUTONOMY_CLASSES]);
  assert.deepEqual(byId.get('limits.mode').choices.map((c) => c.value), [...LIMITS_MODES]);
  for (const key of TIER_KEYS) assert.ok(byId.has(`tiers.${key}`), `tiers.${key} is editable`);
});

test('every knob carries prose, because a control nobody understands is not a setting', () => {
  // MUTANT: ship a setting with no help string. The page renders a bare
  // dropdown and the operator is back to reading the YAML to find out what it
  // does, which is the problem this whole screen exists to solve.
  for (const setting of allSettings()) {
    assert.ok(setting.help && setting.help.length > 30, `${setting.id} needs a real explanation`);
    assert.ok(setting.label, `${setting.id} needs a label`);
    if ((setting.kind ?? 'choice') === 'choice') {
      for (const choice of setting.choices) {
        assert.ok(choice.describe && choice.describe.length > 15, `${setting.id}=${choice.value} needs a description`);
      }
    }
  }
  for (const group of GROUPS) assert.ok(group.blurb && group.title, `${group.id} needs a title and a blurb`);
});

test('a freshly scanned config exposes every knob this screen offers', () => {
  // The two spellings of one document: `templates/config.yaml` is what the
  // docs show, `renderConfig(scanRepo(...))` is what an operator actually
  // gets, and they had drifted — no `limits:` key at all, so the entire
  // Overnight group rendered as seven lines of dead text on every fresh
  // install, and doctor's limit-telemetry-missing could never fire either.
  // MUTANT: drop the `limits` block from scanRepo's config.
  const dir = mkdtempSync(join(tmpdir(), 'tyran-scan-'));
  try {
    const tyran = join(dir, '.tyran');
    mkdirSync(tyran, { recursive: true });
    writeFileSync(join(tyran, 'config.yaml'), renderConfig(scanRepo(dir).config));
    assert.deepEqual(validateConfig(parse(readFileSync(join(tyran, 'config.yaml'), 'utf8'))), []);
    const missing = readSettings(tyran).groups
      .flatMap((g) => g.settings)
      .filter((s) => s.present !== true)
      .map((s) => s.id);
    assert.deepEqual(missing, [], 'every catalogued setting must resolve in a scanned config');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a write lands as one line and the file stays valid', () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.tyran, 'config.yaml'), 'utf8');
    write(f.tyran, applySetting(f.tyran, 'limits.mode', 'pause'));
    const after = readFileSync(join(f.tyran, 'config.yaml'), 'utf8');
    assert.equal(before.split('\n').filter((l, i) => l !== after.split('\n')[i]).length, 1);
    assert.deepEqual(validateConfig(parse(after)), []);
    assert.equal(parse(after).limits.mode, 'pause');
  } finally {
    f.cleanup();
  }
});

test('rejects a value the validator would reject, and writes nothing', () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.tyran, 'config.yaml'), 'utf8');
    assert.throws(() => applySetting(f.tyran, 'profile', 'turbo'), SettingsError);
    // 0.97 where 97 belongs: the classic fraction-for-percent footgun, which
    // would otherwise pause on the first tool call of every session.
    assert.throws(() => applySetting(f.tyran, 'limits.pause_at_percent', 0.97), SettingsError);
    assert.throws(() => applySetting(f.tyran, 'limits.keep_awake', 'yes'), SettingsError);
    assert.throws(() => applySetting(f.tyran, 'tiers.work', '   '), SettingsError);
    assert.throws(() => applySetting(f.tyran, 'nonesuch', 1), SettingsError);
    assert.equal(readFileSync(join(f.tyran, 'config.yaml'), 'utf8'), before, 'a refused write changes nothing');
  } finally {
    f.cleanup();
  }
});

test('the kernel paths cannot be lowered through this screen', () => {
  // The boundary has to protect itself through the write route too, or the
  // route IS the way around the gate. MUTANT: delete the ruleLocked check —
  // and note that validatePolicy still catches it, which is the point of
  // having both.
  const f = fixture();
  try {
    for (const glob of ['hooks/**', '.tyran/policies/**']) {
      assert.throws(() => applyPolicyClass(f.tyran, glob, 'AUTO'), (err) => {
        assert.ok(err instanceof SettingsError);
        assert.match(err.message, /KERNEL/);
        return true;
      });
    }
    const s = readSettings(f.tyran);
    const locked = s.policy.rules.filter((r) => r.locked).map((r) => r.path);
    assert.deepEqual(locked.sort(), ['.tyran/policies/**', 'hooks/**']);
  } finally {
    f.cleanup();
  }
});

test('a rule that would claim a kernel path is refused by the validator itself', () => {
  // The lock list is an exact-path check; this is the case it does not cover
  // and validatePolicy does — a DIFFERENT, more specific glob reaching into
  // the protected namespace. MUTANT: skip the validatePolicy call after the
  // patch and this write lands.
  const f = fixture();
  try {
    const file = join(f.tyran, 'policies', 'autonomy.yaml');
    const text = readFileSync(file, 'utf8').replace(
      '  - path: .tyran/knowledge/**',
      '  - path: hooks/scripts/**\n    class: KERNEL\n    reason: placeholder\n\n  - path: .tyran/knowledge/**',
    );
    writeFileSync(file, text);
    assert.throws(() => applyPolicyClass(f.tyran, 'hooks/scripts/**', 'AUTO'), (err) => {
      assert.ok(err instanceof SettingsError);
      assert.match(err.message, /invalid|KERNEL/);
      return true;
    });
    assert.equal(readFileSync(file, 'utf8'), text, 'nothing was written');
  } finally {
    f.cleanup();
  }
});

test('a rule is addressed by its glob, so a moved file cannot misdirect the write', () => {
  // MUTANT: address rules by the index the page was rendered with. Reorder
  // the file between read and write and the class lands on a neighbour.
  const f = fixture();
  try {
    const file = join(f.tyran, 'policies', 'autonomy.yaml');
    const original = parse(readFileSync(file, 'utf8'));
    const target = '.claude/agents/**';
    const wasAt = original.rules.findIndex((r) => r.path === target);
    // Move the target rule by inserting one ahead of it.
    writeFileSync(file, readFileSync(file, 'utf8').replace(
      '  - path: .tyran/knowledge/**',
      '  - path: docs/**\n    class: AUTO\n    reason: inserted to shift every later index\n\n  - path: .tyran/knowledge/**',
    ));
    write(f.tyran, applyPolicyClass(f.tyran, target, 'AUTO', 'AUTO'));
    const after = parse(readFileSync(file, 'utf8'));
    assert.equal(after.rules.find((r) => r.path === target).class, 'AUTO');
    assert.equal(after.rules[wasAt].path, '.tyran/config.yaml', 'the old index now holds a different rule');
    assert.equal(after.rules[wasAt].class, 'AUTO', 'and it was not the one that changed');
    assert.deepEqual(validatePolicy(after), []);
  } finally {
    f.cleanup();
  }
});

test('the policy default is editable and is addressed by null', () => {
  const f = fixture();
  try {
    write(f.tyran, applyPolicyClass(f.tyran, null, 'AUTO', 'AUTO'));
    assert.equal(parse(readFileSync(join(f.tyran, 'policies', 'autonomy.yaml'), 'utf8')).default, 'AUTO');
  } finally {
    f.cleanup();
  }
});

test('a provenanced value is written into .value, not over the wrapper', () => {
  // setup writes `profile: {value, source, confidence}` when it inferred the
  // answer. MUTANT: always patch the bare path — the wrapper is replaced by a
  // scalar and the provenance an operator uses to audit the value is gone.
  const f = fixture();
  try {
    const file = join(f.tyran, 'config.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace(
      'profile: balanced',
      "profile:\n  value: balanced\n  source: 'git log: inferred'\n  confidence: 0.9",
    ));
    write(f.tyran, applySetting(f.tyran, 'profile', 'eco'));
    const doc = parse(readFileSync(file, 'utf8'));
    assert.deepEqual(doc.profile, { value: 'eco', source: 'git log: inferred', confidence: 0.9 });
    assert.deepEqual(validateConfig(doc), []);
    assert.equal(readSettings(f.tyran).groups[0].settings[0].value, 'eco', 'and it reads back through the wrapper');
  } finally {
    f.cleanup();
  }
});

test('a config that does not parse is reported, not thrown', () => {
  // This screen is exactly where an operator wants to be when the file is
  // broken. MUTANT: let the YamlLiteError escape — the whole tab 500s and the
  // one thing that could have named the broken file shows nothing.
  const f = fixture();
  try {
    writeFileSync(join(f.tyran, 'config.yaml'), 'profile: >-\n  balanced\n');
    const s = readSettings(f.tyran);
    assert.equal(s.files.config.present, true);
    assert.match(s.files.config.error, /block scalar/);
    assert.ok(s.groups.flatMap((g) => g.settings).every((x) => x.present === false));
    assert.throws(() => applySetting(f.tyran, 'profile', 'eco'), SettingsError);
  } finally {
    f.cleanup();
  }
});

test('a missing key is offered as absent rather than as an empty control', () => {
  const f = fixture();
  try {
    const file = join(f.tyran, 'config.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^ {2}keep_awake:.*$/m, ''));
    const setting = readSettings(f.tyran).groups.flatMap((g) => g.settings).find((x) => x.id === 'limits.keep_awake');
    assert.equal(setting.present, false);
    assert.throws(() => applySetting(f.tyran, 'limits.keep_awake', true), /is not in/);
  } finally {
    f.cleanup();
  }
});

test('a missing file says so instead of creating one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-settings-empty-'));
  try {
    mkdirSync(join(dir, '.tyran'), { recursive: true });
    const s = readSettings(join(dir, '.tyran'));
    assert.equal(s.files.config.present, false);
    assert.equal(s.policy.rules.length, 0);
    assert.throws(() => applySetting(join(dir, '.tyran'), 'profile', 'eco'), /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loosening a boundary needs a second, deliberate confirmation', () => {
  // The hole this closes: MANDATORY_KERNEL_PATHS covers `hooks/**` and
  // `.tyran/policies/**` and nothing else, so `.claude/settings.json` ("anything
  // that can edit it can switch every gate off") and `.tyran/STOP` ("a loop
  // that can clear its own stop signal has none") were one click from AUTO.
  // MUTANT: delete the requireConfirm call in applyPolicyClass.
  const f = fixture();
  try {
    for (const glob of ['.claude/settings.json', '.claude/settings.local.json', '.tyran/STOP']) {
      assert.throws(() => applyPolicyClass(f.tyran, glob, 'AUTO'), (err) => {
        assert.ok(err instanceof SettingsError);
        assert.equal(err.widens, true);
        assert.equal(err.confirm_with, 'AUTO');
        // The rule's own reason is the warning: whoever put the boundary
        // there wrote a better one than this module could compose.
        assert.match(err.message, /This rule exists because:/);
        return true;
      });
    }
    // Same for the default, and for raising the deployment class.
    assert.throws(() => applyPolicyClass(f.tyran, null, 'AUTO'), (err) => err.widens === true);
    assert.throws(() => applySetting(f.tyran, 'autonomy', 'P3'), (err) => {
      assert.equal(err.widens, true);
      assert.match(err.message, /merges to the default branch/);
      return true;
    });
  } finally {
    f.cleanup();
  }
});

test('the confirmation must name the change, so a truthy flag does not satisfy it', () => {
  // MUTANT: accept any non-null `confirm`. A caller that sends
  // `{confirm: true}` alongside whatever value it liked would then widen
  // anything, which is not a confirmation, it is a formality.
  const f = fixture();
  try {
    assert.throws(() => applyPolicyClass(f.tyran, '.tyran/STOP', 'AUTO', 'yes'), (err) => err.widens === true);
    assert.throws(() => applyPolicyClass(f.tyran, '.tyran/STOP', 'AUTO', 'GATED'), (err) => err.widens === true);
    const ok = write(f.tyran, applyPolicyClass(f.tyran, '.tyran/STOP', 'AUTO', 'AUTO'));
    assert.equal(ok.after, 'AUTO');
    assert.deepEqual(validatePolicy(parse(readFileSync(join(f.tyran, 'policies', 'autonomy.yaml'), 'utf8'))), []);
  } finally {
    f.cleanup();
  }
});

test('tightening applies on one click, because friction there teaches the wrong lesson', () => {
  // MUTANT: make requireConfirm symmetric. Every step toward a stricter
  // boundary then costs an extra confirmation, which is how you train an
  // operator to stop tightening things.
  const f = fixture();
  try {
    write(f.tyran, applyPolicyClass(f.tyran, '.tyran/config.yaml', 'GATED'));
    write(f.tyran, applyPolicyClass(f.tyran, '.claude/agents/**', 'KERNEL'));
    write(f.tyran, applySetting(f.tyran, 'autonomy', 'P1'));
    const doc = parse(readFileSync(join(f.tyran, 'policies', 'autonomy.yaml'), 'utf8'));
    assert.equal(doc.rules.find((r) => r.path === '.tyran/config.yaml').class, 'GATED');
    assert.equal(doc.rules.find((r) => r.path === '.claude/agents/**').class, 'KERNEL');
  } finally {
    f.cleanup();
  }
});

test('P2 is a widening of P1 and P1 is a tightening of P2', () => {
  const f = fixture();
  try {
    assert.throws(() => applySetting(f.tyran, 'autonomy', 'P2'), (err) => err.widens === true);
    write(f.tyran, applySetting(f.tyran, 'autonomy', 'P2', 'P2'));
    write(f.tyran, applySetting(f.tyran, 'autonomy', 'P1'));
    assert.equal(parse(readFileSync(join(f.tyran, 'config.yaml'), 'utf8')).autonomy, 'P1');
  } finally {
    f.cleanup();
  }
});

test('an ordinary setting is not dragged into the confirmation flow', () => {
  // The guard is for boundaries, not for every control. MUTANT: apply
  // requireConfirm to every setting — the whole screen becomes two clicks.
  const f = fixture();
  try {
    write(f.tyran, applySetting(f.tyran, 'profile', 'eco'));
    write(f.tyran, applySetting(f.tyran, 'limits.mode', 'pause'));
    write(f.tyran, applySetting(f.tyran, 'limits.keep_awake', true));
    assert.equal(parse(readFileSync(join(f.tyran, 'config.yaml'), 'utf8')).profile, 'eco');
  } finally {
    f.cleanup();
  }
});

test('list edits keep the comments around them', () => {
  const f = fixture();
  try {
    write(f.tyran, applySetting(f.tyran, 'validation', ['npm test', '', '  npm run build  ']));
    const text = readFileSync(join(f.tyran, 'config.yaml'), 'utf8');
    assert.deepEqual(parse(text).validation, ['npm test', 'npm run build'], 'blanks dropped, entries trimmed');
    assert.ok(text.includes('# Repo validation commands, run before anything is called done.'));
  } finally {
    f.cleanup();
  }
});

test('a config with no limits: block is editable, not fatal', () => {
  // `limits:` is OPTIONAL in a valid config — every install set up before it
  // existed has none — and resolvePath returned null for an absent parent,
  // which readAt then tried to iterate. The whole Settings tab died with
  // "path is not iterable" and every write became an HTTP 500.
  // MUTANT: return null from resolvePath again.
  const f = fixture();
  try {
    const file = join(f.tyran, 'config.yaml');
    writeFileSync(file, [
      'profile: balanced', 'autonomy: P1',
      'tiers:', '  cheap: haiku', '  work: sonnet', '  deep: opus', '  top: fable',
      'validation:', '  - npm test', 'shared_zones: []', '',
    ].join('\n'));
    assert.deepEqual(validateConfig(parse(readFileSync(file, 'utf8'))), [], 'the fixture must be a VALID config');

    const s = readSettings(f.tyran);
    const overnight = s.groups.find((g) => g.id === 'overnight');
    assert.ok(overnight.settings.every((x) => x.present === false), 'absent, and rendered as absent');
    assert.ok(s.groups.flatMap((g) => g.settings).some((x) => x.present === true), 'the rest still reads');

    // And the two writes behave: the absent one refuses by NAME, the present
    // one still lands.
    assert.throws(() => applySetting(f.tyran, 'limits.mode', 'pause'), SettingsError);
    write(f.tyran, applySetting(f.tyran, 'profile', 'eco'));
    assert.equal(parse(readFileSync(file, 'utf8')).profile, 'eco');
  } finally {
    f.cleanup();
  }
});

test('an apply hands back the text it read, so a caller can compare and swap', () => {
  // MUTANT: drop before_text. The board then writes a whole-file replacement
  // over whatever arrived in the meantime, and both writers report success.
  const f = fixture();
  try {
    const applied = applySetting(f.tyran, 'profile', 'eco');
    assert.equal(applied.before_text, readFileSync(join(f.tyran, 'config.yaml'), 'utf8'));
    assert.notEqual(applied.text, applied.before_text);
  } finally {
    f.cleanup();
  }
});
