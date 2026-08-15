import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from '../../scripts/yaml-lite.mjs';
import { patch, YamlPatchError } from '../../scripts/yaml-patch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const template = (name) => readFileSync(join(ROOT, 'templates', name), 'utf8');

test('changes one value and leaves every other byte alone', () => {
  // The whole reason this module exists rather than a stringify round-trip.
  // MUTANT: rebuild the file with yaml-lite.stringify — the value is still
  // right and all 60 comment lines are gone.
  const before = template('config.yaml');
  const after = patch(before, ['profile'], 'eco');
  const changed = before.split('\n').map((line, i) => [line, after.split('\n')[i]]).filter(([a, b]) => a !== b);
  assert.equal(changed.length, 1, 'exactly one line may differ');
  assert.deepEqual(changed[0], ['profile: balanced', 'profile: eco']);
});

test('keeps the trailing comment on the line it edits', () => {
  // MUTANT: build the replacement line from indent + key + value only. The
  // parse still succeeds and the operator loses the note explaining the key.
  const after = patch(template('config.yaml'), ['limits', 'mode'], 'pause');
  const line = after.split('\n').find((l) => l.trim().startsWith('mode:'));
  assert.match(line, /^ {2}mode: pause # quoted/);
});

test('quotes a value that would read back as a different type', () => {
  // Bare `off` is the YAML boolean false. Writing it unquoted turns
  // limits.mode from the string "off" into `false` and the overnight gate
  // silently changes meaning. MUTANT: emit String(value), not formatScalar.
  const after = patch(patch(template('config.yaml'), ['limits', 'mode'], 'pause'), ['limits', 'mode'], 'off');
  assert.match(after, /^ {2}mode: 'off'/m);
  assert.equal(parse(after).limits.mode, 'off');
});

test('writes a boolean as a boolean, not as a string', () => {
  const after = patch(template('config.yaml'), ['limits', 'keep_awake'], true);
  assert.equal(parse(after).limits.keep_awake, true);
  assert.match(after, /^ {2}keep_awake: true/m);
});

test('reaches a key inside a block sequence item', () => {
  // The first key of an item shares the dash line and the rest are indented
  // two further. MUTANT: drop the indent advance after a numeric segment and
  // every rules[n].class becomes unreachable.
  const before = template(join('policies', 'autonomy.yaml'));
  const index = parse(before).rules.findIndex((r) => r.path === '.tyran/config.yaml');
  const after = patch(before, ['rules', index, 'class'], 'GATED');
  assert.equal(parse(after).rules[index].class, 'GATED');
  assert.equal(parse(after).rules[index].path, '.tyran/config.yaml', 'the neighbouring key is untouched');
  const changed = before.split('\n').filter((line, i) => line !== after.split('\n')[i]);
  assert.equal(changed.length, 1);
});

test('reaches the key that shares the dash line', () => {
  const before = template(join('policies', 'autonomy.yaml'));
  const after = patch(before, ['rules', 0, 'path'], '.tyran/knowledge/scoped/**');
  assert.equal(parse(after).rules[0].path, '.tyran/knowledge/scoped/**');
  assert.match(after, /^ {2}- path: \.tyran\/knowledge\/scoped\/\*\*$/m);
});

test('replaces a list without swallowing the next section', () => {
  // blockEnd must stop at the last CONTENT line. MUTANT: return the index of
  // the next line at or below the parent indent, and the blank line plus the
  // comment introducing `shared_zones` are counted as part of `validation`
  // and deleted.
  const before = template('config.yaml');
  const after = patch(before, ['validation'], ['npm test']);
  assert.deepEqual(parse(after).validation, ['npm test']);
  assert.ok(
    after.includes('# Files multiple agents may touch: append-only, serialized by the conductor.'),
    'the comment heading the next section survived',
  );
  assert.deepEqual(parse(after).shared_zones, []);
});

test('an empty list collapses to the inline spelling', () => {
  const after = patch(template('config.yaml'), ['validation'], []);
  assert.match(after, /^validation: \[\]$/m);
  assert.deepEqual(parse(after).validation, []);
});

test('an inline empty list expands into a block', () => {
  const after = patch(template('config.yaml'), ['shared_zones'], ['src/registry.ts', 'src/index.ts']);
  assert.deepEqual(parse(after).shared_zones, ['src/registry.ts', 'src/index.ts']);
});

test('refuses to replace a list that has a comment among its items', () => {
  // Rewriting the block rewrites its lines, so this comment would vanish.
  // MUTANT: delete the refusal loop — the patch succeeds and eats the note.
  const text = 'validation:\n  # the slow one first\n  - npm test\n';
  assert.throws(() => patch(text, ['validation'], ['npm run lint']), (err) => {
    assert.ok(err instanceof YamlPatchError);
    assert.match(err.message, /line 2 .*comment/);
    return true;
  });
});

test('refuses a key that is not already in the file', () => {
  // Adding a key means choosing where it goes and what comment explains it.
  assert.throws(() => patch(template('config.yaml'), ['pricing', 'rate_card'], 'list-2026-08'), YamlPatchError);
  assert.throws(() => patch(template('config.yaml'), ['nope'], 1), YamlPatchError);
});

test('refuses a file that does not parse rather than guessing', () => {
  assert.throws(() => patch('profile: >-\n  balanced\n', ['profile'], 'eco'), (err) => {
    assert.ok(err instanceof YamlPatchError);
    assert.match(err.message, /does not parse/);
    return true;
  });
});

test('the round-trip proof is what makes the text edit safe', () => {
  // Two keys with the same name at different depths: the locator must pick
  // the nested one. MUTANT: search the whole file for the last path segment
  // instead of walking the path — the wrong `mode` is rewritten, and THIS
  // assertion notices, because the proof compares the whole document.
  const text = 'mode: outer\nlimits:\n  mode: inner\n';
  const after = patch(text, ['limits', 'mode'], 'changed');
  assert.deepEqual(parse(after), { mode: 'outer', limits: { mode: 'changed' } });
});

test('a repeated patch is idempotent', () => {
  const once = patch(template('config.yaml'), ['profile'], 'eco');
  assert.equal(patch(once, ['profile'], 'eco'), once);
});

test('refuses a value this subset cannot spell back', () => {
  // yaml-lite.formatScalar throws on a newline and on invisible codepoints;
  // the patcher lets that through rather than writing a file that reads back
  // as different data. The bidi override is BUILT here, never typed: a raw
  // one in a tracked file is what ADR-19 and the write guard exist to stop.
  const bidi = `a${String.fromCodePoint(0x202e)}b`;
  assert.throws(() => patch(template('config.yaml'), ['profile'], 'a\nb'));
  assert.throws(() => patch(template('config.yaml'), ['profile'], bidi));
});
