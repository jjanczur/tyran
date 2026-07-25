import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify, YamlLiteError } from '../../scripts/yaml-lite.mjs';

test('parses scalars with correct types', () => {
  const doc = parse(`
name: tyran
count: 42
ratio: 0.75
negative: -3
enabled: true
disabled: no
missing: null
tilde: ~
empty: ''
quoted: "value: with colon"
`);
  assert.deepEqual(doc, {
    name: 'tyran',
    count: 42,
    ratio: 0.75,
    negative: -3,
    enabled: true,
    disabled: false,
    missing: null,
    tilde: null,
    empty: '',
    quoted: 'value: with colon',
  });
});

test('parses nested mappings', () => {
  const doc = parse('tiers:\n  top: fable\n  work: opus\n  nested:\n    deep: yes\n');
  assert.deepEqual(doc, { tiers: { top: 'fable', work: 'opus', nested: { deep: true } } });
});

test('parses block sequences of scalars', () => {
  const doc = parse('validation:\n  - npm run lint\n  - npm test\n');
  assert.deepEqual(doc, { validation: ['npm run lint', 'npm test'] });
});

test('parses block sequences of mappings', () => {
  const doc = parse(`rules:
  - path: .tyran/knowledge/**
    class: AUTO
    reason: learned facts
  - path: hooks/**
    class: KERNEL
    reason: enforcement
`);
  assert.deepEqual(doc, {
    rules: [
      { path: '.tyran/knowledge/**', class: 'AUTO', reason: 'learned facts' },
      { path: 'hooks/**', class: 'KERNEL', reason: 'enforcement' },
    ],
  });
});

test('parses inline flow sequences and empty ones', () => {
  assert.deepEqual(parse('a: [1, 2, 3]\nb: []\nc: [x, "y z"]\n'), {
    a: [1, 2, 3],
    b: [],
    c: ['x', 'y z'],
  });
});

test('strips comments but not # inside quotes', () => {
  const doc = parse('# leading comment\nkey: value # trailing\nhash: "a # b"\n');
  assert.deepEqual(doc, { key: 'value', hash: 'a # b' });
});

test('ignores document start marker and blank lines', () => {
  assert.deepEqual(parse('---\n\nkey: v\n\n'), { key: 'v' });
});

test('rejects unsupported YAML loudly', () => {
  assert.throws(() => parse('a: &anchor v\n'), YamlLiteError);
  assert.throws(() => parse('a: *alias\n'), YamlLiteError);
  assert.throws(() => parse('a: !!str 5\n'), YamlLiteError);
  assert.throws(() => parse('a: |\n  block\n'), YamlLiteError);
  assert.throws(() => parse('a: {inline: map}\n'), YamlLiteError);
  assert.throws(() => parse('a:\n\tb: 1\n'), /tabs/);
  assert.throws(() => parse('a: 1\na: 2\n'), /duplicate key/);
  assert.throws(() => parse('a: 1\n   b: 2\n'), YamlLiteError);
  assert.throws(() => parse('just a string\n'), /expected "key: value"/);
});

test('error messages carry line numbers', () => {
  try {
    parse('ok: 1\nbad: |\n  x\n');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof YamlLiteError);
    assert.equal(err.line, 2);
    assert.match(err.message, /line 2/);
  }
});

test('empty document parses to an empty object', () => {
  assert.deepEqual(parse(''), {});
  assert.deepEqual(parse('# only a comment\n'), {});
});

test('stringify → parse roundtrip preserves data', () => {
  const original = {
    profile: 'balanced',
    autonomy: 'P1',
    tiers: { top: 'fable', work: 'opus', cheap: 'haiku' },
    validation: ['npm run lint', 'npm test'],
    shared_zones: [],
    nested: { list: [{ path: 'a/**', class: 'AUTO' }] },
    tricky: 'yes',
    numberish: '42',
  };
  const roundtripped = parse(stringify(original));
  assert.deepEqual(roundtripped, original);
});

test('stringify quotes values that would otherwise change type', () => {
  const out = stringify({ a: 'true', b: '42', c: 'null', d: '', e: 'plain' });
  assert.match(out, /a: 'true'/);
  assert.match(out, /b: '42'/);
  assert.match(out, /c: 'null'/);
  assert.match(out, /d: ''/);
  assert.match(out, /e: plain/);
});
