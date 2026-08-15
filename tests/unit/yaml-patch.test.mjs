import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from '../../scripts/yaml-lite.mjs';
import { patch, sameValue, YamlPatchError } from '../../scripts/yaml-patch.mjs';

/** A config indented four spaces, which yaml-lite and validateConfig both accept. */
const FOUR_SPACE = [
  'tiers:',
  '    cheap: haiku # scout',
  '    work: sonnet',
  'limits:',
  "    mode: 'off'",
  '    keep_awake: false',
  'rules:',
  '    - path: a/**',
  '      class: AUTO',
  '    - path: b/**',
  '      class: GATED',
  'validation:',
  '    - npm test',
  '',
].join('\n');

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

test('the indent step is read from the file, not assumed to be two', () => {
  // `yaml-lite.parseBlock` recurses with `next.indent` — whatever the next
  // line happens to be indented by — so a four-space config is as legal as a
  // two-space one and `validateConfig` accepts it. MUTANT: go back to
  // `parentIndent + 2`. Every nested key here then reports "is not in this
  // file", while a UI reading the PARSED document renders all of them as
  // present and editable, so the operator gets a false error under a live
  // control telling them to add a key that is already there.
  const cases = [
    [['tiers', 'cheap'], 'newmodel'],
    [['limits', 'mode'], 'pause'],
    [['limits', 'keep_awake'], true],
    [['rules', 1, 'class'], 'KERNEL'],
    [['rules', 0, 'path'], 'z/**'],
  ];
  for (const [path, value] of cases) {
    const after = patch(FOUR_SPACE, path, value);
    const walk = (doc, p) => p.reduce((node, key) => node[key], doc);
    assert.deepEqual(walk(parse(after), path), value, `${path.join('.')} did not take`);
    const changed = FOUR_SPACE.split('\n').filter((l, i) => l !== after.split('\n')[i]);
    assert.equal(changed.length, 1, `${path.join('.')} changed ${changed.length} lines`);
  }
  // The comment on a four-space line survives too.
  assert.match(patch(FOUR_SPACE, ['tiers', 'cheap'], 'x'), /^ {4}cheap: x # scout$/m);
});

test('a list is rewritten at the indent its own items already use', () => {
  const after = patch(FOUR_SPACE, ['validation'], ['npm run build', 'npm test']);
  assert.deepEqual(parse(after).validation, ['npm run build', 'npm test']);
  assert.match(after, /^ {4}- npm run build$/m);
});

test('an eight-space document works the same way', () => {
  const wide = 'limits:\n        mode: pause\n        keep_awake: false\n';
  assert.equal(parse(patch(wide, ['limits', 'keep_awake'], true)).limits.keep_awake, true);
  assert.match(patch(wide, ['limits', 'mode'], 'warn'), /^ {8}mode: warn$/m);
});

test('a CRLF file keeps its line endings', () => {
  // MUTANT: drop `line.eol`. The data is right and every diff of the file
  // shows one line whose ending no longer matches the other eighty-nine.
  const crlf = 'profile: balanced\r\nlimits:\r\n  mode: pause\r\n';
  const after = patch(crlf, ['limits', 'mode'], 'warn');
  assert.equal(after, 'profile: balanced\r\nlimits:\r\n  mode: warn\r\n');
  assert.equal(parse(after).limits.mode, 'warn');
});

test('a value the subset cannot spell is a refusal, not a crash', () => {
  // `formatScalar` throws YamlLiteError, which is ordinary rejected input —
  // somebody pasted a model name with a newline in it. Letting it escape made
  // the caller classify it as a server fault: HTTP 500, plus a line in the
  // terminal the docs designate as the audit trail. MUTANT: re-throw anything
  // that is not already a YamlPatchError.
  for (const bad of ['a\nb', `a${String.fromCodePoint(0x202e)}b`, `a${String.fromCodePoint(0x200b)}b`]) {
    assert.throws(() => patch(FOUR_SPACE, ['tiers', 'cheap'], bad), YamlPatchError);
  }
  assert.throws(() => patch(FOUR_SPACE, ['validation'], ['ok', 'bad\nvalue']), YamlPatchError);
});

test('sameValue is the proof, and it is strict about every way two documents differ', () => {
  // The guarantee at the end of `patch()` rests on this comparison, and no
  // input is known to reach it — every wrong case is refused earlier by the
  // locator, the comment guard or formatScalar (2772 fuzzed triples, zero
  // firings). So it is tested directly: a comparison that has quietly become
  // permissive is the one way the proof stops being one.
  assert.ok(sameValue({ a: 1, b: 'x' }, { a: 1, b: 'x' }));
  assert.ok(sameValue([1, [2, 3]], [1, [2, 3]]));
  assert.ok(sameValue(null, null));
  assert.ok(!sameValue({ a: 1 }, { a: 1, b: 2 }), 'an extra key is a difference');
  assert.ok(!sameValue({ a: 1, b: 2 }, { a: 1 }), 'a missing key is a difference');
  assert.ok(!sameValue({ a: { b: 1 } }, { a: { b: 2 } }), 'a nested change is a difference');
  assert.ok(!sameValue([1, 2], [1, 2, 3]), 'a longer list is a difference');
  assert.ok(!sameValue([1, 2], [2, 1]), 'order is a difference');
  assert.ok(!sameValue(1, '1'), 'a type change is a difference — the whole point of the quoting rules');
  assert.ok(!sameValue(false, 'false'));
  assert.ok(!sameValue(null, undefined));
  assert.ok(!sameValue({ a: 1 }, [1]));
});

test('refuses a value this subset cannot spell back', () => {
  // yaml-lite.formatScalar throws on a newline and on invisible codepoints;
  // the patcher lets that through rather than writing a file that reads back
  // as different data. The bidi override is BUILT here, never typed: a raw
  // one in a tracked file is what ADR-19 and the write guard exist to stop.
  //
  // Named error class, not a bare `assert.throws`: an unqualified throws()
  // passes on ANY exception, including the wrong class, which is exactly how
  // a rejected value came to be reported as a server fault.
  const bidi = `a${String.fromCodePoint(0x202e)}b`;
  assert.throws(() => patch(template('config.yaml'), ['profile'], 'a\nb'), YamlPatchError);
  assert.throws(() => patch(template('config.yaml'), ['profile'], bidi), YamlPatchError);
});
